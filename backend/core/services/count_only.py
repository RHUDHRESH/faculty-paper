"""A reviewer decides that a paper is counted for the college and not paid.

Faculty can file a paper as "count only" themselves. This is the other way in:
the research cell, the Principal or the Director looks at a claim that was filed
for the incentive and decides it is to be counted only: a student publication,
a paper that does not cite SEC-affiliated articles, or some other reason.

Nothing new is invented for the claim afterwards. It keeps its status and goes
on down the same chain a faculty-filed count-only claim goes down, priced at
nothing by the calculator, with the college's own note on it
(`claim_fixes.NO_PAYMENT_NOTE`). The previous reason is kept in the audit row so
a super admin can put it back before any money has moved.
"""
from __future__ import annotations

import json
from typing import Any

from django.db import transaction
from django.shortcuts import get_object_or_404
from ninja.errors import HttpError

from core.models import AuditLog, Claim, ClaimAction, ClaimReason, ClaimStatus, PaidLedger, Role, User
from core.services import rbac
from core.services.claim_fixes import NO_PAYMENT_NOTE

STUDENT = "student_publication"
NO_SEC = "no_sec_citation"
OTHER = "other"
REASONS = (STUDENT, NO_SEC, OTHER)

REASON_WORDS = {
    STUDENT: "Student publication",
    NO_SEC: "Does not cite SEC-affiliated articles",
}
#: What an "other" note may run to: the whole note on the claim is 255 characters.
MAX_NOTE = 200

ACCEPT_AUDIT = "CLAIM_COUNT_ONLY"
UNDO_AUDIT = "CLAIM_COUNT_ONLY_UNDO"


def may_accept(role: str, status: str | None) -> bool:
    """Whether `role` may turn a claim at `status` into count-only.

    The people who decide at that step: the research cell's roles where it is
    waiting to be cleared, the Principal where it is cleared, the Director where
    the Principal has approved it. A super admin stands in at all three.
    """
    if status == ClaimStatus.SUBMITTED:
        return rbac.can_clear_claims(role)
    if status == ClaimStatus.CLEARED:
        return rbac.can_act_at_desk(role, rbac.PRINCIPAL_DESK)
    if status == ClaimStatus.PRINCIPAL_APPROVED:
        return rbac.can_approve_as_director(role)
    return False


def may_ever_accept(role: str) -> bool:
    """Whether `role` decides a claim at any step: the research cell's roles, the Principal, the Director, a super admin."""
    return any(
        may_accept(role, s)
        for s in (ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED)
    )


def reason_text(reason: str, note: str | None) -> str:
    if reason == OTHER:
        return (note or "").strip()
    return REASON_WORDS[reason]


def reason_on(claim: Claim | Any) -> str | None:
    """The reason the college counted this paper only, in words, or None.

    Read from the claim's own note, so a list costs no query. A claim the
    faculty member filed as count-only has no such note and gives no reason.
    """
    note = (getattr(claim, "status_note", None) or "").strip()
    if getattr(claim, "claim_reason", None) != ClaimReason.COUNT_ONLY or not note.startswith(NO_PAYMENT_NOTE):
        return None
    return note[len(NO_PAYMENT_NOTE):].strip().rstrip(".").strip() or None


def _refuse_if_money_moved(claim: Claim) -> None:
    if claim.status == ClaimStatus.PAID:
        raise HttpError(409, "This claim is already paid, so it cannot be changed to count only.")
    rows = PaidLedger.objects.filter(claim=claim)
    if rows.filter(bank_export__isnull=False).exists():
        raise HttpError(409, "This claim is already in a bank file, so it cannot be changed to count only.")
    if rows.exists():
        raise HttpError(409, "A payment has already been recorded for this claim, so it cannot be changed to count only.")


def accept(claim_id: str, user: User, reason: str, note: str | None) -> Claim:
    """Turn a claim into count-only, in one transaction. Raises HttpError."""
    from core.api.common import _apply_calc, _refuse_own_claim
    from core.api.journals import _notify_claimant

    if not may_ever_accept(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        _refuse_if_money_moved(claim)
        if not may_accept(user.role, claim.status):
            if claim.status in (ClaimStatus.CLEARED, ClaimStatus.SUBMITTED, ClaimStatus.PRINCIPAL_APPROVED):
                raise HttpError(403, "This claim is at a step that is not yours.")
            if claim.status == ClaimStatus.DIRECTOR_APPROVED:
                raise HttpError(409, "This claim is already authorised, so it cannot be changed to count only.")
            raise HttpError(400, "Only a claim that is waiting to be checked, approved or authorised can be changed to count only.")
        if claim.claim_reason == ClaimReason.COUNT_ONLY:
            raise HttpError(409, "This claim is already count only.")

        if reason not in REASONS:
            raise HttpError(400, "Choose a reason: student publication, does not cite SEC-affiliated articles, or other.")
        note = (note or "").strip()
        if reason == OTHER and not note:
            raise HttpError(400, "Write the reason when you choose Other.")
        if len(note) > MAX_NOTE:
            raise HttpError(400, f"Keep the reason to {MAX_NOTE} characters or fewer.")
        if reason != OTHER:
            note = ""

        words = reason_text(reason, note)
        before = {
            "claim_reason": claim.claim_reason,
            "is_student_publication": claim.is_student_publication,
            "status_note": claim.status_note,
            "remuneration": claim.remuneration,
        }
        claim.claim_reason = ClaimReason.COUNT_ONLY
        # Only a student publication carries the flag (reports count those). The
        # calculator prices count-only claims at nothing on the reason itself.
        # Which reason it was also lives in the note and the audit row.
        claim.is_student_publication = reason == STUDENT
        _apply_calc(claim)
        if claim.remuneration not in (0, 0.0):
            raise HttpError(
                409,
                "The active policy still prices count-only papers, so nothing was changed. "
                "Ask Finance to check the policy.",
            )
        claim.status_note = f"{NO_PAYMENT_NOTE} {words}."[:255]
        claim.save()
        ClaimAction.objects.create(
            claim=claim, actor=user, from_status=claim.status, to_status=claim.status,
            action="COUNT_ONLY", note=words,
        )
        AuditLog.objects.create(
            actor=user, action=ACCEPT_AUDIT, entity="Claim", entity_id=claim.id,
            detail_json=json.dumps({
                "ticket": claim.ticket_number, "status": claim.status, "reason": reason, "note": note or None,
                "before": before,
                "after": {
                    "claim_reason": claim.claim_reason,
                    "is_student_publication": claim.is_student_publication,
                    "status_note": claim.status_note,
                    "remuneration": claim.remuneration,
                },
            }),
        )

    _notify_claimant(
        claim,
        "Counted for the college",
        f"Your paper is counted for the college. No incentive is paid. Reason: {words}.",
    )
    return claim


def undo(claim_id: str, user: User) -> Claim:
    """Put back what the last accept replaced. Super admin only, before payment."""
    from core.api.common import _apply_calc, _refuse_own_claim
    from core.api.journals import _notify_claimant

    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can undo count only.")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        _refuse_if_money_moved(claim)
        last = (
            AuditLog.objects.filter(entity="Claim", entity_id=claim.id, action__in=(ACCEPT_AUDIT, UNDO_AUDIT))
            .order_by("-created_at", "-id").first()
        )
        if claim.claim_reason != ClaimReason.COUNT_ONLY or last is None or last.action != ACCEPT_AUDIT:
            raise HttpError(409, "A reviewer did not change this claim to count only, so there is nothing to undo.")
        was = (json.loads(last.detail_json or "{}")).get("before") or {}
        claim.claim_reason = was.get("claim_reason") or ClaimReason.INCENTIVE
        claim.is_student_publication = bool(was.get("is_student_publication"))
        claim.status_note = was.get("status_note")
        now_amount = claim.remuneration
        _apply_calc(claim)
        claim.save()
        ClaimAction.objects.create(
            claim=claim, actor=user, from_status=claim.status, to_status=claim.status,
            action="COUNT_ONLY_UNDO", note=None,
        )
        AuditLog.objects.create(
            actor=user, action=UNDO_AUDIT, entity="Claim", entity_id=claim.id,
            detail_json=json.dumps({
                "ticket": claim.ticket_number, "status": claim.status,
                "before": {"claim_reason": ClaimReason.COUNT_ONLY, "remuneration": now_amount},
                "after": {"claim_reason": claim.claim_reason, "remuneration": claim.remuneration},
            }),
        )
    _notify_claimant(
        claim,
        "Back to an incentive claim",
        "The count-only decision on your paper was undone. It is being checked for the incentive again.",
    )
    return claim
