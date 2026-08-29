"""super-admin powers.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.deps import IMPERSONATOR_KEY, _user_dict, impersonator_of, require_user

import json
from typing import Any
from django.contrib.auth import login
from django.db import transaction
from django.db.models import Sum
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, PaidLedger, Role, User

# ---------- super-admin powers ----------


class ClaimEditIn(Schema):
    fields: dict[str, Any]
    reason: str


@api.post("/admin/claims/{claim_id}/edit", auth=session_auth)
def admin_edit_claim(request: HttpRequest, claim_id: str, payload: ClaimEditIn):
    """Edit any field on any claim, with a reason, recorded before and after.

    This exists because imported data is wrong in ways the normal screens cannot
    reach. It is deliberately not a quiet update: the reason is required, the
    before/after of every changed field goes to the audit log, and changing a
    settled amount also writes the balancing ledger row, so the claim and the
    ledger cannot drift apart -- which is the drift that made the reported
    totals wrong in the first place.
    """
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may edit a claim directly")
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Give a reason (at least 10 characters) — it is kept with the change")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        editable = {f.name for f in Claim._meta.get_fields() if hasattr(f, "attname")}
        editable -= {"id", "owner", "created_at", "updated_at"}

        before, after = {}, {}
        for key, value in (payload.fields or {}).items():
            if key not in editable:
                raise HttpError(400, f"{key} is not a field on a claim")
            old = getattr(claim, key, None)
            if old == value:
                continue
            before[key], after[key] = old, value
            setattr(claim, key, value)

        if not after:
            return {"ok": True, "changed": {}, "note": "nothing differed"}

        money_changed = "remuneration" in after and claim.status == ClaimStatus.PAID
        claim.save()

        if money_changed:
            # The ledger is append-only, so the correction is a new row rather
            # than an edit: the history keeps what was paid and what it became.
            paid_so_far = (
                claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
            )
            delta = (claim.remuneration or 0) - paid_so_far
            if abs(delta) > 0.01:
                PaidLedger.objects.create(
                    claim=claim,
                    payout_month=claim.payout_month or timezone.now().date().replace(day=1),
                    department=claim.owner.department,
                    faculty_name=claim.owner.name,
                    staff_id=claim.staff_id,
                    biometric_id=claim.biometric_id,
                    paper_title=claim.paper_title,
                    journal_title=claim.journal_title,
                    amount=delta,
                    voucher_number=f"{claim.voucher_number or claim.ticket_number}-ADJ",
                )

        ClaimAction.objects.create(
            claim=claim, actor=actor, action="ADMIN_EDIT", note=reason[:500]
        )
        AuditLog.objects.create(
            actor=actor,
            action="CLAIM_ADMIN_EDIT",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps(
                {
                    "reason": reason,
                    "before": {k: str(v) for k, v in before.items()},
                    "after": {k: str(v) for k, v in after.items()},
                    "ledger_adjusted": money_changed,
                }
            )[:20000],
        )
    return {"ok": True, "changed": {k: str(v) for k, v in after.items()},
            "ledger_adjusted": money_changed}


class ReassignIn(Schema):
    owner_email: str
    reason: str


@api.post("/admin/claims/{claim_id}/reassign", auth=session_auth)
def admin_reassign_claim(request: HttpRequest, claim_id: str, payload: ReassignIn):
    """Move a claim to the faculty member it actually belongs to.

    The import attributes by staff id, biometric id, then name; where all three
    miss, the payment lands on a holding record for someone who has left. This
    is how it gets put right.
    """
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may reassign a claim")
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Give a reason (at least 10 characters)")

    new_owner = User.objects.filter(email__iexact=payload.owner_email.strip()).first()
    if not new_owner:
        raise HttpError(404, "No account with that email")
    if new_owner.role != Role.FACULTY:
        raise HttpError(400, "Claims belong to faculty accounts")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        previous = claim.owner
        if previous.id == new_owner.id:
            return {"ok": True, "note": "already owned by that account"}
        claim.owner = new_owner
        # The identity columns travel with the claim, or the ledger would keep
        # paying the person it was moved away from.
        claim.staff_id = new_owner.staff_id or claim.staff_id
        claim.biometric_id = new_owner.biometric_id or claim.biometric_id
        claim.save()
        claim.ledger_rows.update(
            faculty_name=new_owner.name,
            staff_id=new_owner.staff_id,
            biometric_id=new_owner.biometric_id,
            department=new_owner.department,
        )
        ClaimAction.objects.create(
            claim=claim, actor=actor, action="REASSIGN",
            note=f"{previous.email} → {new_owner.email}: {reason}"[:500],
        )
        AuditLog.objects.create(
            actor=actor, action="CLAIM_REASSIGN", entity="Claim", entity_id=claim.id,
            detail_json=json.dumps({
                "from": previous.email, "to": new_owner.email, "reason": reason,
            }),
        )
    return {"ok": True, "owner": _user_dict(new_owner)}


@api.post("/admin/impersonate/{user_id}", auth=session_auth)
def admin_impersonate(request: HttpRequest, user_id: str):
    """View the app as another user. Read-only, and recorded.

    Every write is refused for the duration (see require_user), so this answers
    "what does this person actually see?" without being a way to act as them.
    """
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may view as another user")
    if request.session.get(IMPERSONATOR_KEY):
        raise HttpError(400, "Already viewing as somebody else — stop first")

    target = get_object_or_404(User, pk=user_id)
    if target.id == actor.id:
        raise HttpError(400, "That is already you")
    if target.role == Role.SUPER_ADMIN:
        raise HttpError(403, "Cannot view as another super admin")

    AuditLog.objects.create(
        actor=actor, action="IMPERSONATE_START", entity="User", entity_id=target.id,
        detail_json=json.dumps({"target": target.email}),
    )
    real_id = actor.id
    login(request, target, backend="django.contrib.auth.backends.ModelBackend")
    request.session[IMPERSONATOR_KEY] = real_id
    return {"ok": True, "viewing_as": _user_dict(target), "read_only": True}


# Not /admin/impersonate/stop: that is swallowed by the {user_id} route
# registered above it, which answers "Only a super admin may view as another
# user" for a user called "stop".
@api.post("/admin/stop-impersonating", auth=session_auth)
def admin_stop_impersonating(request: HttpRequest):
    real = impersonator_of(request)
    if not real:
        raise HttpError(400, "Not viewing as anybody")
    viewed = request.user
    AuditLog.objects.create(
        actor=real, action="IMPERSONATE_STOP", entity="User", entity_id=viewed.id,
        detail_json=json.dumps({"target": getattr(viewed, "email", "")}),
    )
    del request.session[IMPERSONATOR_KEY]
    login(request, real, backend="django.contrib.auth.backends.ModelBackend")
    return {"ok": True, "user": _user_dict(real)}




__all__ = [
    'ClaimEditIn',
    'ReassignIn',
    'admin_edit_claim',
    'admin_impersonate',
    'admin_reassign_claim',
    'admin_stop_impersonating',
]
