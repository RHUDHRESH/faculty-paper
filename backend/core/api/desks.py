"""the two review desks: holding a paper, and resuming it.

A filed paper waits at the research supervisor's desk (SUBMITTED) and then at
the Principal's (CLEARED). Either desk may pause a paper where it is -- a hold
-- without sending it anywhere, so it keeps its place in the chain and in
every status filter. Whoever sits at the desk the paper is at may hold it and
resume it; a super admin sits at both. The Director and Finance hold nothing:
they only move a paper forward.

The claimant is told that the paper is paused and that it has resumed, in
words that name neither the desk nor the person. They are not told the
reason, which is written for the desk and may well name one.
"""

from __future__ import annotations

import json

from django.db import transaction
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import _refuse_own_claim, api, logger, require_user, session_auth
from core.api.deps import claim_to_dict
from core.api.journals import _lift_hold, _notify_claimant, _require_own_desk
from core.models import AuditLog, Claim, ClaimAction, User
from core.services import rbac

# ---------- the two review desks ----------


class HoldIn(Schema):
    reason: str


#: What the claimant reads. Deliberately silent on who and where.
_HOLD_COPY = (
    "On hold",
    "Your paper is paused for the moment. It keeps its place in the review, "
    "and you will be told as soon as it moves again. There is nothing you "
    "need to do.",
)
_RESUME_COPY = (
    "Review resumed",
    "Your paper is under review again.",
)


def _locked_at_own_desk(user: User, claim_id: str) -> Claim:
    """The claim, row-locked, provided `user` sits at the desk it is at.

    Call inside a transaction. 403 for somebody who sits at neither desk, or
    at the other one; 400 when the paper is at no review desk at all.
    """
    if not rbac.sits_at_a_desk(user.role):
        raise HttpError(
            403,
            "Only the research supervisor's desk and the Principal's desk hold "
            "or resume a paper.",
        )
    claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
    _refuse_own_claim(user, claim)
    desk = rbac.desk_for_status(claim.status)
    if desk is None:
        raise HttpError(
            400,
            "Only a paper waiting at the research supervisor's desk (submitted) "
            f"or the Principal's (cleared) can be held — this one is {claim.status}.",
        )
    _require_own_desk(user, claim)
    return claim


def _record(claim: Claim, user: User, action: str, note: str | None) -> None:
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=claim.status,
        to_status=claim.status,
        action=action,
        note=note,
    )
    AuditLog.objects.create(
        actor=user,
        action=f"CLAIM_{action}",
        entity="Claim",
        entity_id=claim.id,
        detail_json=json.dumps(
            {"ticket": claim.ticket_number, "status": claim.status, "note": note}
        ),
    )
    logger.info(
        "claim_%s ticket=%s status=%s actor=%s",
        action.lower(), claim.ticket_number, claim.status, user.email,
    )


@api.post("/claims/{claim_id}/hold", auth=session_auth)
def hold_claim(request: HttpRequest, claim_id: str, payload: HoldIn):
    """Pause a paper at the desk it is at, with a reason, without moving it."""
    user = require_user(request)
    reason = (payload.reason or "").strip()
    with transaction.atomic():
        claim = _locked_at_own_desk(user, claim_id)
        if len(reason) < 10:
            raise HttpError(400, "Say why it is on hold (10+ characters) — the desk reads it later")
        if claim.on_hold:
            raise HttpError(409, f"{claim.ticket_number or 'This ticket'} is already on hold")
        claim.on_hold = True
        claim.hold_reason = reason
        claim.held_by = user
        claim.held_at = timezone.now()
        claim.save(update_fields=["on_hold", "hold_reason", "held_by", "held_at", "updated_at"])
        _record(claim, user, "HOLD", reason)
    _notify_claimant(claim, *_HOLD_COPY)
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/resume", auth=session_auth)
def resume_claim(request: HttpRequest, claim_id: str):
    """Lift a hold. The paper carries on from exactly where it was."""
    user = require_user(request)
    with transaction.atomic():
        claim = _locked_at_own_desk(user, claim_id)
        if not claim.on_hold:
            raise HttpError(409, f"{claim.ticket_number or 'This ticket'} is not on hold")
        _lift_hold(claim)
        claim.save(update_fields=["on_hold", "hold_reason", "held_by", "held_at", "updated_at"])
        _record(claim, user, "RESUME", None)
    _notify_claimant(claim, *_RESUME_COPY)
    return claim_to_dict(claim)


__all__ = [
    'HoldIn',
    '_HOLD_COPY',
    '_RESUME_COPY',
    '_locked_at_own_desk',
    '_record',
    'hold_claim',
    'resume_claim',
]
