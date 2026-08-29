"""the queue profile-correction requests land in.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.schemas import ChangePasswordIn
from core.api.deps import require_user
from core.api.auth import CORRECTABLE, IDENTITY_FIELDS

import json
from typing import Any, Optional
from django.contrib.auth import update_session_auth_hash
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Notification, ProfileChangeRequest, Role, User
from core.services import rbac

# ---------- the queue those requests land in ----------


def _request_dict(r) -> dict[str, Any]:
    return {
        "id": r.id,
        "field": r.field,
        "label": CORRECTABLE.get(r.field, r.field),
        "current_value": r.current_value or "",
        "proposed_value": r.proposed_value,
        # The record may have moved since the request was made, and an
        # approver overwriting something different from what was asked about
        # should be told so rather than left to compare two screens.
        "value_now": str(getattr(r.user, r.field, "") or ""),
        "note": r.note or "",
        "status": r.status,
        "identity": r.field in IDENTITY_FIELDS,
        "requested_by": {
            "id": r.user_id,
            "name": r.user.name or r.user.email,
            "email": r.user.email,
            "department": r.user.department or "",
            "staff_id": r.user.staff_id or "",
        },
        "decided_by": r.decided_by.name if r.decided_by_id else None,
        "decided_at": r.decided_at.isoformat() if r.decided_at else None,
        "decision_note": r.decision_note or "",
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@api.get("/admin/profile-requests", auth=session_auth)
def profile_requests(request: HttpRequest, status: str = "PENDING", limit: int = 100):
    """Profile corrections waiting on somebody."""
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    qs = ProfileChangeRequest.objects.select_related("user", "decided_by")
    if status and status != "ALL":
        qs = qs.filter(status=status)
    rows = list(qs.order_by("-created_at")[: max(1, min(limit, 500))])
    return {
        "results": [_request_dict(r) for r in rows],
        "pending": ProfileChangeRequest.objects.filter(
            status=ProfileChangeRequest.State.PENDING
        ).count(),
    }


class ProfileDecisionIn(Schema):
    approve: bool
    note: Optional[str] = None


@api.post("/admin/profile-requests/{request_id}", auth=session_auth)
def decide_profile_request(
    request: HttpRequest, request_id: str, payload: ProfileDecisionIn
):
    """Apply a requested profile change, or decline it with a reason.

    Approving writes the value onto the account, which is the whole point --
    the alternative was an admin reading a notification and retyping it into
    another screen, where a typo becomes somebody else's staff id.
    """
    actor = require_user(request)
    if not rbac.can_manage_users(actor.role):
        raise HttpError(403, "Forbidden")

    req = get_object_or_404(
        ProfileChangeRequest.objects.select_related("user"), pk=request_id
    )
    if req.status != ProfileChangeRequest.State.PENDING:
        raise HttpError(
            400,
            f"This was already {req.get_status_display().lower()} "
            f"by {req.decided_by.name if req.decided_by_id else 'somebody'}.",
        )

    # Identity is super-admin only, here as much as everywhere else it is
    # written. The research cell processes the claims these fields decide the
    # outcome of, so it cannot also set them.
    if req.field in IDENTITY_FIELDS and actor.role != Role.SUPER_ADMIN:
        raise HttpError(
            403,
            f"Only a super admin can change {CORRECTABLE[req.field].lower()}. "
            "You can decline it, or leave it for one.",
        )

    note = (payload.note or "").strip()
    if not payload.approve and len(note) < 5:
        raise HttpError(400, "Say why it is being declined — the person is told.")

    if payload.approve:
        before = getattr(req.user, req.field, None)
        setattr(req.user, req.field, req.proposed_value)
        req.user.save(update_fields=[req.field, "updated_at"])
        req.status = ProfileChangeRequest.State.APPROVED
    else:
        before = None
        req.status = ProfileChangeRequest.State.DECLINED

    req.decided_by = actor
    req.decided_at = timezone.now()
    req.decision_note = note or None
    req.save()

    AuditLog.objects.create(
        actor=actor,
        action="PROFILE_CORRECTION_DECIDED",
        entity="User",
        entity_id=req.user_id,
        detail_json=json.dumps({
            "request_id": req.id,
            "field": req.field,
            "approved": payload.approve,
            "from": str(before) if before is not None else None,
            "to": req.proposed_value if payload.approve else None,
            "note": note,
        }),
    )

    # The person who asked finds out. Not being told was half of why the old
    # flow felt like shouting into a cupboard.
    label = CORRECTABLE.get(req.field, req.field)
    Notification.objects.create(
        user=req.user,
        title=(
            f"{label} updated" if payload.approve else f"{label} change declined"
        ),
        body=(
            f"Your {label.lower()} now reads “{req.proposed_value}”."
            if payload.approve
            else f"{note}"
        ),
        href="/faculty/profile",
    )
    return {"ok": True, "request": _request_dict(req)}


@api.get("/auth/profile/corrections", auth=session_auth)
def my_profile_requests(request: HttpRequest):
    """What I have asked for, and what came of it."""
    u = require_user(request)
    rows = ProfileChangeRequest.objects.filter(user=u).order_by("-created_at")[:20]
    return {"results": [_request_dict(r) for r in rows]}


@api.post("/auth/change-password", auth=session_auth)
def change_password(request: HttpRequest, payload: ChangePasswordIn):
    u = require_user(request)
    if not u.check_password(payload.current_password):
        raise HttpError(400, "Current password incorrect")
    if len(payload.new_password) < 8:
        raise HttpError(400, "New password must be at least 8 characters")
    u.set_password(payload.new_password)
    u.must_change_password = False
    u.save(update_fields=["password", "must_change_password", "updated_at"])
    # Changing the password rotates the session auth hash, which would log the
    # user out on their very next request. Keep the current session valid.
    update_session_auth_hash(request, u)
    AuditLog.objects.create(
        actor=u, action="PASSWORD_CHANGE", entity="User", entity_id=u.id
    )
    return {"ok": True}




__all__ = [
    'ProfileDecisionIn',
    '_request_dict',
    'change_password',
    'decide_profile_request',
    'my_profile_requests',
    'profile_requests',
]
