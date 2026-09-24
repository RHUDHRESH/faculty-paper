"""the queue profile-correction requests land in.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.schemas import ChangePasswordIn
from core.api.common import require_user
from core.api.auth import REQUESTABLE, SUPER_ADMIN_DECIDES, may_set_field

import json
from typing import Any, Optional
from django.contrib.auth import update_session_auth_hash
from django.db import transaction
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Notification, ProfileChangeRequest, Role, User
from core.services import rbac

# ---------- the queue those requests land in ----------


def _as_text(value: Any) -> str:
    """A field's value as the queue compares it. A quota of 0 is not blank."""
    return "" if value is None else str(value)


def _apply_request(req: ProfileChangeRequest, actor: User) -> Any:
    """Write an approved request onto the account; return what it said before.

    Profile corrections are a plain write. A request about the post runs the
    account editor's own checks, because a queue that could appoint a second
    head of department, or let a super admin approve their own role, would be
    the account editor with its guards taken off.
    """
    from core.api.admin import (
        _appoint_head,
        _check_assignable_role,
        _check_privileged_assignment,
    )

    u = req.user
    field, value = req.field, req.proposed_value
    before = getattr(u, field, None)
    fields = [field]

    if field == "role":
        if u.pk == actor.pk:
            raise HttpError(400, "You cannot change your own role — ask another super admin.")
        _check_assignable_role(value)
        _check_privileged_assignment(actor, value)
        u.role = value
        if value == Role.HOD:
            # 409 names the head already in post. Replacing them is a
            # deliberate act in the account editor, not a side effect of
            # approving somebody else's request.
            _appoint_head(u, replace=False, actor=actor)
    elif field == "faculty_type":
        u.faculty_type = value
        if value != "RESEARCH":
            # A quota on a regular post is a number that never applies.
            u.research_quota = None
            u.research_quota_note = None
            fields += ["research_quota", "research_quota_note"]
    elif field == "research_quota":
        if u.faculty_type != "RESEARCH":
            raise HttpError(
                400,
                "A research quota only applies to research faculty. Approve the "
                "faculty type first, or decline this.",
            )
        u.research_quota = int(value)
    else:
        setattr(u, field, value)
        if field == "department" and u.role == Role.HOD:
            # A head moving department is a head arriving in that one.
            _appoint_head(u, replace=False, actor=actor)

    u.save(update_fields=[*fields, "updated_at"])
    return before


def _request_dict(r) -> dict[str, Any]:
    return {
        "id": r.id,
        "field": r.field,
        "label": REQUESTABLE.get(r.field, r.field),
        "current_value": r.current_value or "",
        "proposed_value": r.proposed_value,
        # The record may have moved since the request was made, and an
        # approver overwriting something different from what was asked about
        # should be told so rather than left to compare two screens.
        "value_now": _as_text(getattr(r.user, r.field, None)),
        "note": r.note or "",
        "status": r.status,
        "identity": r.field in SUPER_ADMIN_DECIDES,
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
    if req.field in SUPER_ADMIN_DECIDES and not may_set_field(actor.role, req.field):
        raise HttpError(
            403,
            f"Only a super admin can change {REQUESTABLE[req.field].lower()}. "
            "You can decline it, or leave it for one.",
        )

    note = (payload.note or "").strip()
    if not payload.approve and len(note) < 5:
        raise HttpError(400, "Say why it is being declined — the person is told.")

    with transaction.atomic():
        if payload.approve:
            # Refused inside the transaction, so a head-of-department clash
            # leaves both the account and the request exactly as they were.
            before = _apply_request(req, actor)
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
    label = REQUESTABLE.get(req.field, req.field)
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
    '_apply_request',
    '_as_text',
    '_request_dict',
    'change_password',
    'decide_profile_request',
    'my_profile_requests',
    'profile_requests',
]
