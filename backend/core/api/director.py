"""the director: authorising what the principal approved.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import (
    OWN_PAPER,
    _apply_calc,
    _desk_people,
    _high_value_threshold,
    _needs_second_approval,
    _notify_admins,
    _notify_finance,
    _refuse_own_claim,
    api,
    logger,
    session_auth,
)
from core.api.schemas import ActionIn, ManualVerifyIn, OverrideStatusIn
from core.api.deps import claim_to_dict
from core.api.common import require_user
from core.api.journals import (
    PrincipalBulkIn,
    _guard_recomputed_amount,
    _may_approve_as_principal,
    _require_own_desk,
    _reverify_or_recalc,
    _transition,
    _withdraw_approvals,
    clear_claim,
)

import json
import re
import time
from datetime import date, timedelta
from typing import Optional
from django.db import transaction
from django.db.models import Min, Q, Sum, When
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, Notification, PAYABLE_STATUSES, PaidLedger, Role, User
from core import visibility
from core.services import flags as flag_service
from core.services import rbac
from core.services.verify import apply_verify_to_claim, verify_publication

# ---------- the director: authorising what the principal approved ----------


def _may_approve_as_director(role: str) -> bool:
    """The Director, and a super admin who has to stand in for one."""
    return rbac.can_approve_as_director(role)


@api.post("/claims/{claim_id}/director-approve", auth=session_auth)
def director_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Authorise a Principal-approved claim, which is what lets finance pay it.

    The Principal agrees the spend is correct on its own terms. The Director
    authorises it against the institution's position -- the budget it comes out
    of, and everything else authorised the same month. Two separate decisions
    taken by two separate people, which is the whole reason this step exists
    rather than being folded into the one before it.
    """
    user = require_user(request)
    if not _may_approve_as_director(user.role):
        raise HttpError(403, "Forbidden")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        if claim.status != ClaimStatus.PRINCIPAL_APPROVED:
            raise HttpError(
                400,
                "Only a ticket the Principal has approved can be authorised"
                f" -- this one is {claim.status}",
            )
        # The amount on the screen is the amount being authorised. Recomputing
        # here means an authorisation cannot be given for one figure and the
        # payment made at another.
        _apply_calc(claim)
        _guard_recomputed_amount(claim, payload.expected_amount)

        claim.director_approved_by = user
        claim.director_approved_at = timezone.now()
        # A third pair of eyes satisfies the second-signature rule if the
        # Principal has not already -- but only where this really is somebody
        # other than whoever cleared it.
        if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
            claim.second_approved_by = user
            claim.second_approved_at = timezone.now()
        _transition(
            claim, user, ClaimStatus.DIRECTOR_APPROVED, "DIRECTOR_APPROVE", payload.note
        )
        amount = claim.remuneration or 0

    _notify_finance(
        claim,
        f"Authorised for payment \u00b7 {claim.ticket_number}",
        f"\u20b9{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
    )
    return claim_to_dict(claim)


@api.get("/director/queue", auth=session_auth)
def director_queue(
    request: HttpRequest,
    q: Optional[str] = None,
    department: Optional[str] = None,
    quartile: Optional[str] = None,
    min_amount: Optional[float] = None,
    max_amount: Optional[float] = None,
    waiting_over: Optional[int] = None,
    sort: str = "waiting",
    limit: int = 50,
    offset: int = 0,
):
    """Everything the Principal has approved and the Director has not authorised.

    Shaped exactly like the principal queue, deliberately: the two roles do the
    same kind of work one step apart, and a second queue that sorted or totalled
    differently would have the two disagreeing about the same money.

    The totals are over the whole filtered set, not the page -- a decision about
    a month's spend cannot be taken from the fifty rows that fit on screen.
    """
    user = require_user(request)
    if not _may_approve_as_director(user.role):
        raise HttpError(403, "Forbidden")

    qs = (
        Claim.objects.filter(status=ClaimStatus.PRINCIPAL_APPROVED)
        # Never the Director's own paper (`rbac.is_own_claim`).
        .exclude(owner=user)
        .select_related("owner", "cleared_by", "principal_approved_by", "override_by")
        .prefetch_related("attachments")
    )
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(journal_title__icontains=term)
        )
    if department:
        qs = qs.filter(owner__department__iexact=department)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if min_amount is not None:
        qs = qs.filter(remuneration__gte=min_amount)
    if max_amount is not None:
        qs = qs.filter(remuneration__lte=max_amount)
    if waiting_over:
        qs = qs.filter(
            principal_approved_at__lte=timezone.now() - timedelta(days=int(waiting_over))
        )

    sorts = {
        "waiting": "principal_approved_at",   # longest wait first
        "recent": "-principal_approved_at",
        "amount": "-remuneration",
        "amount_asc": "remuneration",
        "department": "owner__department",
        "title": "paper_title",
    }
    qs = qs.order_by(sorts.get(sort, "principal_approved_at"))

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    agg = qs.aggregate(amount=Sum("remuneration"), oldest=Min("principal_approved_at"))
    oldest = agg["oldest"]

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in qs[offset : offset + limit]],
        # Over everything the filter matched, not the page.
        "totals": {
            "count": total,
            "amount": round(agg["amount"] or 0, 2),
            "longest_wait_days": (timezone.now() - oldest).days if oldest else None,
        },
        "departments": sorted(
            d
            for d in Claim.objects.filter(status=ClaimStatus.PRINCIPAL_APPROVED)
            .values_list("owner__department", flat=True)
            .distinct()
            if d
        ),
    }


@api.post("/director/bulk-approve", auth=session_auth)
def director_bulk_approve(request: HttpRequest, payload: PrincipalBulkIn):
    """Authorise a batch, one row at a time, skipping what does not qualify.

    A batch that fails as a unit is a batch nobody dares run: one stale row out
    of two hundred and the Director is back to clicking through them singly.
    """
    user = require_user(request)
    if not _may_approve_as_director(user.role):
        raise HttpError(403, "Forbidden")
    ids = list(dict.fromkeys(payload.claim_ids or []))[:500]
    if not ids:
        raise HttpError(400, "Nothing selected")

    approved = 0
    total = 0.0
    skipped: list[dict[str, str]] = []
    for claim_id in ids:
        with transaction.atomic():
            claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
            if claim is None:
                skipped.append({"id": claim_id, "reason": "Not found"})
                continue
            if rbac.is_own_claim(user, claim):
                skipped.append({
                    "id": claim_id,
                    "reason": f"{claim.ticket_number or claim_id}: {OWN_PAPER}",
                })
                continue
            if claim.status != ClaimStatus.PRINCIPAL_APPROVED:
                skipped.append({
                    "id": claim_id,
                    "reason": f"{claim.ticket_number or claim_id}: status is {claim.status}",
                })
                continue
            shown = claim.remuneration
            _apply_calc(claim)
            if round(shown or 0, 2) != round(claim.remuneration or 0, 2):
                skipped.append({
                    "id": claim_id,
                    "reason": (
                        f"{claim.ticket_number or claim_id}: amount changed on "
                        f"recalculation (\u20b9{(shown or 0):,.0f} \u2192 \u20b9{(claim.remuneration or 0):,.0f})"
                        " -- open it to review"
                    ),
                })
                transaction.set_rollback(True)
                continue
            claim.director_approved_by = user
            claim.director_approved_at = timezone.now()
            if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
                claim.second_approved_by = user
                claim.second_approved_at = timezone.now()
            _transition(
                claim, user, ClaimStatus.DIRECTOR_APPROVED, "DIRECTOR_APPROVE", payload.note
            )
            approved += 1
            total += claim.remuneration or 0
        _notify_finance(
            claim,
            f"Authorised for payment \u00b7 {claim.ticket_number}",
            f"\u20b9{(claim.remuneration or 0):,.0f} for {claim.owner.name}: {claim.paper_title}",
        )
    return {"approved": approved, "total": round(total, 2), "skipped": skipped}


@api.post("/claims/{claim_id}/director-reject", auth=session_auth)
def director_reject(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Send an approved ticket back to the Principal with a reason.

    Super admin only. The chain past the Principal is forward-only: the
    Director authorises, and a question about a Principal-approved paper is
    raised with the Principal rather than by bouncing the paper. A super admin
    keeps this as the rescue for an approval given against the wrong facts.

    Back one step, not all the way: what is being queried is the approval, so
    it returns to the person who gave it.
    """
    user = require_user(request)
    if user.role == Role.DIRECTOR:
        raise HttpError(
            403,
            "The Director authorises and does not send papers back. Raise the "
            "question with the Principal, or ask a super admin to return it.",
        )
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Forbidden")
    note = (payload.note or "").strip()
    if len(note) < 5:
        raise HttpError(400, "Say why it is going back")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        if claim.status != ClaimStatus.PRINCIPAL_APPROVED:
            raise HttpError(
                400, "Only a Principal-approved ticket can be sent back from here"
            )
        claim.status_note = note
        # The approval is withdrawn along with the status. Leaving the name and
        # the timestamp on a ticket that is no longer approved is how a later
        # reader concludes it was signed off twice.
        claim.principal_approved_by = None
        claim.principal_approved_at = None
        claim.save(update_fields=["principal_approved_by", "principal_approved_at"])
        _transition(claim, user, ClaimStatus.CLEARED, "DIRECTOR_SEND_BACK", note)

    for u in _desk_people(claim, (Role.PRINCIPAL, Role.SUPER_ADMIN)):
        Notification.objects.create(
            user=u,
            title=f"Returned to the Principal's desk \u00b7 {claim.ticket_number}",
            body=note[:300],
            href=f"/approvals?claim={claim.id}",
            claim_id=claim.id,
        )
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/principal-reject", auth=session_auth)
def principal_reject(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Return a cleared ticket one step, to the research supervisor's desk.

    Back to the cell rather than to the claimant: what the principal is
    querying is the checking, and a claimant told "sent back" with no reason
    they can act on simply resubmits the same thing.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")
    note = (payload.note or "").strip()
    if len(note) < 5:
        raise HttpError(400, "Say why it is going back")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        if claim.status != ClaimStatus.CLEARED:
            raise HttpError(400, "Only a cleared ticket can be sent back from here")
        claim.status_note = note
        # The clearing goes with the status, as the Director's send-back takes
        # the Principal's approval with it: the desk will clear it again.
        claim.cleared_by = None
        claim.cleared_at = None
        _transition(claim, user, ClaimStatus.SUBMITTED, "PRINCIPAL_SEND_BACK", note)

    _notify_admins(
        claim,
        f"Sent back by the principal · {claim.ticket_number}",
        note[:300],
    )
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/return-one-step", auth=session_auth)
def return_one_step(request: HttpRequest, claim_id: str, payload: ActionIn):
    """The Principal's one-step return, under the name the chain gives it."""
    return principal_reject(request, claim_id, payload)


@api.post("/claims/{claim_id}/approve", auth=session_auth)
def admin_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Legacy generic approve — now means "clear"."""
    return clear_claim(request, claim_id, payload)


@api.post("/claims/{claim_id}/research-approve", auth=session_auth)
def research_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    return clear_claim(request, claim_id, payload)


@api.post("/claims/{claim_id}/finance-approve", auth=session_auth)
def finance_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """No separate finance approve hop — a cleared ticket is marked paid."""
    raise HttpError(400, "Finance marks a cleared ticket paid directly")


def _mark_one_paid(
    claim_id: str,
    user: User,
    *,
    voucher_number: str | None,
    note: str | None,
    expected_amount: float | None,
    skip_external: bool = False,
    reverify: bool = False,
) -> Claim:
    """One payment, atomically, with every guard. Raises HttpError on refusal.

    Recomputes from the stored verified columns and never calls Scopus. External
    re-verification belongs at clearing, which is the step that decides whether
    the figures are trustworthy; repeating it here made Finance a hostage to
    Scopus. A single payment used to re-verify and answer 502 during an outage,
    and `skip_external` is super-admin only, so a Finance user had no way
    through at all — while bulk mark-paid, which never called out, worked fine.
    """
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        # Before every other guard, so a batch says why this row was skipped
        # in the words that matter: nobody pays their own paper.
        _refuse_own_claim(user, claim)
        # Payable means the Director authorised it on this system. Three
        # things are deliberately not payable:
        #
        # - a merely cleared ticket, which the office has checked but nobody
        #   has agreed to spend money on;
        # - a Principal-approved ticket, which has been agreed but not yet
        #   authorised — the step this chain gained most recently;
        # - a row carrying an approval status from the old ERP import, which
        #   has no verification, no recomputed amount and nobody's signature
        #   behind it. Those are told apart by director_approved_at, which
        #   only a live authorisation sets.
        authorised_here = bool(claim.director_approved_at)
        if not (claim.status == ClaimStatus.DIRECTOR_APPROVED and authorised_here):
            if claim.status == ClaimStatus.CLEARED:
                raise HttpError(
                    400,
                    "Cleared, but not yet approved by the Principal — payment "
                    "needs that approval, and then the Director's authorisation.",
                )
            if claim.status == ClaimStatus.PRINCIPAL_APPROVED:
                raise HttpError(
                    400,
                    "Approved by the Principal but not yet authorised by the "
                    "Director. Finance pays what the Director authorises.",
                )
            if claim.status in PAYABLE_STATUSES:
                raise HttpError(
                    400,
                    "This ticket is on a retired approval status from the old ERP. "
                    "A super admin must move it to Cleared before it can be paid, "
                    "so the amount is verified rather than taken from the import.",
                )
            raise HttpError(
                400,
                "Invalid status — the ticket must be authorised by the Director first",
            )
        # Net of the ledger, not mere existence: a voided payment leaves a
        # reversing row behind, and the claim must be payable again.
        net_paid = claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
        if net_paid > 0:
            raise HttpError(400, "Already processed")
        if claim.status == ClaimStatus.DIRECTOR_APPROVED:
            # Recompute FIRST, then decide whether it needs a second signature.
            #
            # The other order was the bug: the threshold was tested against the
            # stored figure and the amount was recomputed immediately after, so
            # a claim sitting just under the threshold that recomputed just
            # over it was paid at the higher amount with nobody's second
            # signature on it. The guard has to see the number that is about to
            # be paid, not the one that happened to be on the row.
            if reverify:
                _reverify_or_recalc(claim, user, skip_external=skip_external)
            else:
                _apply_calc(claim)
            # The amount guard goes first of the two. If the figure moved, the
            # actor confirmed a number that is not the one about to be paid,
            # and every question after that is about the wrong amount --
            # including whether it needs a second signature.
            _guard_recomputed_amount(claim, expected_amount)
            if _needs_second_approval(claim):
                if visibility.is_contest_blind(user.role):
                    # Finance is not told about a contested payment-history
                    # match (core.visibility), so the refusal says what is
                    # missing without saying why it is required.
                    raise HttpError(
                        400,
                        "A second approver, different from the person who "
                        "cleared it, must approve before this is paid.",
                    )
                if claim.duplicate_warning and claim.override_duplicate:
                    who = claim.override_by.name if claim.override_by else "somebody"
                    raise HttpError(
                        400,
                        f"The payment-history warning on this ticket was set aside by "
                        f"{who}. A second approver, different from the person who "
                        "cleared it, must confirm before it is paid.",
                    )
                raise HttpError(
                    400,
                    "High-value claim — a second approver (different from the person "
                    "who cleared it) must approve before payment",
                )
        # Vouchers are no longer typed in: finance had a free-text box that could
        # be left blank or reused, and the number carried no meaning. Imported
        # history keeps whatever it came with.
        if voucher_number:
            claim.voucher_number = str(voucher_number)[:64]
        _transition(claim, user, ClaimStatus.PAID, "MARK_PAID", note)
        # Paid, not held: a flag never stops a payment. The super admin is
        # told that one went out with a question still open.
        flag_service.announce_paid_with_open_flags(claim)
        payout = claim.payout_month
        if not payout:
            today = timezone.now().date()
            payout = date(today.year, today.month, 1)
            claim.payout_month = payout
            claim.save(update_fields=["payout_month"])
        PaidLedger.objects.create(
            claim=claim,
            payout_month=payout,
            department=claim.owner.department,
            faculty_name=claim.owner.name,
            staff_id=claim.staff_id or claim.owner.staff_id,
            biometric_id=claim.biometric_id or claim.owner.biometric_id,
            paper_title=claim.paper_title,
            journal_title=claim.journal_title,
            amount=claim.remuneration or 0,
            voucher_number=claim.voucher_number or voucher_number,
        )
    return claim


@api.post("/claims/{claim_id}/mark-paid", auth=session_auth)
def mark_paid(request: HttpRequest, claim_id: str, payload: ActionIn):
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    claim = _mark_one_paid(
        claim_id,
        user,
        voucher_number=payload.voucher_number,
        note=payload.note,
        expected_amount=payload.expected_amount,
        skip_external=bool(payload.skip_external),
    )
    return claim_to_dict(claim)


class BulkMarkPaidItem(Schema):
    claim_id: str
    voucher_number: Optional[str] = None
    expected_amount: Optional[float] = None


class BulkMarkPaidIn(Schema):
    items: list[BulkMarkPaidItem]
    note: Optional[str] = None


@api.post("/admin/bulk-mark-paid", auth=session_auth)
def bulk_mark_paid(request: HttpRequest, payload: BulkMarkPaidIn):
    """Pay a reviewed batch in one action.

    A 200-claim payout month used to be 200 separate confirm dialogs. Every
    row still goes through the full single-payment guards individually — an
    amount that drifted, a missing second approval, or an already-paid row is
    skipped with its reason, never silently paid.

    Bulk does not re-hit Scopus (that would time out). It recomputes from
    stored verified values and skips any row whose amount drifted.
    """
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    items = (payload.items or [])[:200]
    if not items:
        raise HttpError(400, "Select at least one payment")
    seen: set[str] = set()
    paid: list[str] = []
    skipped: list[dict[str, str]] = []
    for item in items:
        if item.claim_id in seen:
            continue
        seen.add(item.claim_id)
        try:
            claim = _mark_one_paid(
                item.claim_id,
                user,
                voucher_number=item.voucher_number,
                note=payload.note,
                expected_amount=item.expected_amount,
                reverify=False,
            )
            paid.append(claim.id)
        except HttpError as e:
            skipped.append({"id": item.claim_id, "reason": str(e)[:160]})
        except Exception as e:  # one bad row must not sink the batch
            logger.exception("bulk_mark_paid_failed id=%s", item.claim_id)
            skipped.append({"id": item.claim_id, "reason": str(e)[:160]})
    return {"paid": len(paid), "paid_ids": paid, "skipped": skipped}


@api.post("/claims/{claim_id}/second-approve", auth=session_auth)
def second_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Second signature on a high-value cleared claim.

    Must come from someone other than the person who cleared it — the whole
    point is a second pair of eyes on large amounts.
    """
    user = require_user(request)
    # Admin only. The Principal oversees and reports; giving that account a
    # money action was the one thing stopping it from being purely read-only.
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        # Either side of the principal's approval: the second signature is
        # about a large amount, not about which desk the ticket is sitting on.
        if claim.status not in (
            ClaimStatus.CLEARED,
            ClaimStatus.PRINCIPAL_APPROVED,
            ClaimStatus.DIRECTOR_APPROVED,
        ):
            raise HttpError(
                400,
                "Only a cleared, principal-approved or director-authorised "
                "ticket can be second-approved",
            )
        threshold = _high_value_threshold()
        if (claim.remuneration or 0) < threshold:
            raise HttpError(
                400, f"Below the second-approval threshold (₹{threshold:,.0f}) — no second signature needed"
            )
        if claim.cleared_by_id == user.id:
            raise HttpError(400, "The second approver must be a different person from the one who cleared it")
        if claim.second_approved_by_id:
            raise HttpError(400, "Already second-approved")
        claim.second_approved_by = user
        claim.second_approved_at = timezone.now()
        claim.save(update_fields=["second_approved_by", "second_approved_at"])
        ClaimAction.objects.create(
            claim=claim,
            actor=user,
            from_status=claim.status,
            to_status=claim.status,
            action="SECOND_APPROVE",
            note=payload.note,
        )
        AuditLog.objects.create(
            actor=user,
            action="CLAIM_SECOND_APPROVE",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps(
                {"ticket": claim.ticket_number, "amount": claim.remuneration, "note": payload.note}
            ),
        )
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/void-payment", auth=session_auth)
def void_payment(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Reverse a payment made in error.

    The ledger is append-only: voiding writes a negative reversing row rather
    than deleting anything, and the claim returns to CLEARED so it can be
    corrected and paid again.

    Super admin only. Finance pays and does nothing else: undoing a payment
    sends the paper backwards, and backwards is not Finance's direction.
    """
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(
            403,
            "Only a super admin can void a payment. Finance pays; a payment "
            "made in error is reversed by a super admin.",
        )
    note = (payload.note or "").strip()
    if len(note) < 10:
        raise HttpError(400, "Add a reason (10+ characters) — it goes to the audit trail and the ledger")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        if claim.status != ClaimStatus.PAID:
            raise HttpError(400, "Only a paid ticket can be voided")
        # Not "net > 0": a claim can legitimately be paid at zero — count-only
        # filings, and claims that fall short of the SEC-reference minimum, are
        # recorded as PAID carrying nothing. Refusing those left them stuck in
        # PAID with no way back. Voiding twice is already impossible because
        # this transition moves the ticket out of PAID.
        net_paid = claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
        if not claim.ledger_rows.exists():
            raise HttpError(400, "No payment on record to void")
        today = timezone.now().date()
        PaidLedger.objects.create(
            claim=claim,
            payout_month=claim.payout_month or date(today.year, today.month, 1),
            department=claim.owner.department,
            faculty_name=claim.owner.name,
            staff_id=claim.staff_id or claim.owner.staff_id,
            biometric_id=claim.biometric_id or claim.owner.biometric_id,
            paper_title=claim.paper_title,
            journal_title=claim.journal_title,
            amount=-net_paid,
            voucher_number=f"{(claim.voucher_number or 'VOID')[:59]}-VOID",
            raw_json=json.dumps({"voided_by": user.email, "reason": note}),
        )
        claim.paid_at = None
        claim.save(update_fields=["paid_at"])
        _transition(claim, user, ClaimStatus.CLEARED, "VOID_PAYMENT", note)
    return claim_to_dict(claim)


@api.post("/admin/claims/{claim_id}/override-status", auth=session_auth)
def override_status(request: HttpRequest, claim_id: str, payload: OverrideStatusIn):
    """Audited super-admin rescue for stranded statuses.

    ERP imports arrive in legacy states like HOD_APPROVED that nothing in the
    live chain can act on — they could not be cleared, paid, or even rejected.
    """
    user = require_user(request)
    # Every other admin power accepts RESEARCH_CELL too — that role was folded
    # into SUPER_ADMIN and unmigrated accounts still carry it, including the
    # research cell's own login. Demanding the exact role here locked the
    # people who run the clearing queue out of the one tool that unsticks it.
    if user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "Forbidden")
    allowed = (ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.REJECTED)
    if payload.to_status not in allowed:
        raise HttpError(400, "Status can only be overridden to SUBMITTED, CLEARED, or REJECTED")
    note = (payload.note or "").strip()
    if len(note) < 10:
        raise HttpError(400, "Add a reason (10+ characters) explaining the override")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        if claim.status == ClaimStatus.PAID:
            raise HttpError(400, "A paid ticket cannot be overridden — void the payment first")
        if claim.status == payload.to_status:
            raise HttpError(400, f"The ticket is already {payload.to_status}")
        _transition(claim, user, payload.to_status, "STATUS_OVERRIDE", note)
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/withdraw", auth=session_auth)
def withdraw_claim(request: HttpRequest, claim_id: str, payload: ActionIn):
    """The claimant pulls a submitted ticket back to draft to fix it."""
    user = require_user(request)
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id, owner=user)
        if claim.status != ClaimStatus.SUBMITTED:
            raise HttpError(400, "Only a submitted ticket can be withdrawn")
        _transition(claim, user, ClaimStatus.DRAFT, "WITHDRAW", payload.note)
    return claim_to_dict(claim)


def _send_to_faculty(request: HttpRequest, claim_id: str, payload: ActionIn, *, outright: bool):
    """Return a paper to its claimant, or reject it outright, from a review desk.

    Both land on REJECTED; `rejected_outright` is what tells them apart. The
    research supervisor's desk does this to a submitted paper, the Principal's
    desk to a cleared one, and a super admin at either -- or, as the rescue
    role, to a paper past both desks that has not been paid.
    """
    user = require_user(request)
    if not rbac.can_reject_claims(user.role):
        raise HttpError(
            403,
            "Only the research supervisor's desk and the Principal's desk send a "
            "paper back. The Director and Finance only move a paper forward.",
        )
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        _refuse_own_claim(user, claim)
        if claim.status not in (ClaimStatus.SUBMITTED, *PAYABLE_STATUSES):
            raise HttpError(400, "Invalid status for reject")
        _require_own_desk(user, claim)
        # The faculty member has to write 10 characters to contest a failed
        # check; sending their claim back without saying why was the cheaper
        # action. The reason is also what the notification shows them.
        note = (payload.note or "").strip()
        if len(note) < 10:
            raise HttpError(
                400, "Add a reason (10+ characters) so the faculty member knows what to fix"
            )
        claim.status_note = note[:255]
        claim.rejected_outright = outright
        _withdraw_approvals(claim)
        _transition(
            claim, user, ClaimStatus.REJECTED,
            "REJECT_OUTRIGHT" if outright else "REJECT", note,
        )
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/reject", auth=session_auth)
def reject_claim(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Return to the faculty to fix and refile. The ticket number is kept."""
    return _send_to_faculty(request, claim_id, payload, outright=False)


@api.post("/claims/{claim_id}/return-to-faculty", auth=session_auth)
def return_to_faculty(request: HttpRequest, claim_id: str, payload: ActionIn):
    """The same as /reject, under a name that cannot be mistaken for the final one."""
    return _send_to_faculty(request, claim_id, payload, outright=False)


@api.post("/claims/{claim_id}/reject-outright", auth=session_auth)
def reject_outright(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Not accepted: the claimant cannot edit or refile it."""
    return _send_to_faculty(request, claim_id, payload, outright=True)


def _verify_claim(claim: Claim) -> Claim:
    # Re-verifying rewrites quartile, SNIP, and remuneration. Doing that after
    # payment silently diverges the claim from its PaidLedger row.
    if claim.status == ClaimStatus.PAID:
        raise HttpError(400, "Claim is already paid — re-verifying would change a settled amount")
    result = verify_publication(
        title=claim.paper_title or "",
        scopus_author_url=claim.scopus_author_url,
        scopus_author_id=claim.scopus_author_id,
        issn=claim.issn,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id,
    )
    apply_verify_to_claim(claim, result)
    _apply_calc(claim)
    claim.save()
    return claim


@api.post("/claims/{claim_id}/verify", auth=session_auth)
def verify_claim_endpoint(request: HttpRequest, claim_id: str):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    _refuse_own_claim(user, claim)
    if not (claim.paper_title or "").strip():
        raise HttpError(400, "Claim has no paper title")
    claim = _verify_claim(claim)
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=claim.status,
        to_status=claim.status,
        action="VERIFY",
    )
    return claim_to_dict(claim)


@api.post("/admin/claims/{claim_id}/set-verified", auth=session_auth)
def set_verified_values(request: HttpRequest, claim_id: str, payload: ManualVerifyIn):
    """The manual-verification lane.

    When Scopus/Scimago cannot confirm a paper, an admin enters the verified
    SNIP/quartile here — with a source note — instead of the payout ever being
    computed from the claimant's own declaration. MANUAL values survive
    re-verification.
    """
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    _refuse_own_claim(user, claim)
    if claim.status == ClaimStatus.PAID:
        raise HttpError(400, "Claim is already paid — a settled amount cannot be changed")
    note = (payload.note or "").strip()
    if len(note) < 10:
        raise HttpError(400, "Provide a source note (at least 10 characters) citing where the values come from")
    if payload.snip is not None and payload.snip < 0:
        raise HttpError(400, "SNIP cannot be negative")
    if payload.quartile is not None and payload.quartile not in ("Q1", "Q2", "Q3", "Q4", ""):
        raise HttpError(400, "Quartile must be one of Q1–Q4")

    before = {
        "snip": claim.snip,
        "snip_source": claim.snip_source,
        "quartile": claim.quartile,
        "quartile_source": claim.quartile_source,
        "engineering_class": claim.engineering_class,
        "remuneration": claim.remuneration,
    }
    if payload.snip is not None:
        claim.snip = float(payload.snip)
        claim.snip_source = "MANUAL"
    if payload.quartile:
        claim.quartile = payload.quartile
        claim.quartile_source = "MANUAL"
    if payload.engineering_class:
        claim.engineering_class = payload.engineering_class
    claim.manual_verified_by = user
    claim.manual_verified_at = timezone.now()
    claim.manual_verification_note = note
    _apply_calc(claim)
    claim.save()
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=claim.status,
        to_status=claim.status,
        action="MANUAL_VERIFY",
        note=note,
    )
    AuditLog.objects.create(
        actor=user,
        action="CLAIM_MANUAL_VERIFY",
        entity="Claim",
        entity_id=claim.id,
        detail_json=json.dumps(
            {
                "before": before,
                "after": {
                    "snip": claim.snip,
                    "snip_source": claim.snip_source,
                    "quartile": claim.quartile,
                    "quartile_source": claim.quartile_source,
                    "engineering_class": claim.engineering_class,
                    "remuneration": claim.remuneration,
                },
                "note": note,
            }
        ),
    )
    return claim_to_dict(claim)




__all__ = [
    'BulkMarkPaidIn',
    'BulkMarkPaidItem',
    '_mark_one_paid',
    '_may_approve_as_director',
    '_send_to_faculty',
    '_verify_claim',
    'admin_approve',
    'bulk_mark_paid',
    'director_approve',
    'director_bulk_approve',
    'director_queue',
    'director_reject',
    'finance_approve',
    'mark_paid',
    'override_status',
    'principal_reject',
    'reject_claim',
    'reject_outright',
    'research_approve',
    'return_one_step',
    'return_to_faculty',
    'second_approve',
    'set_verified_values',
    'verify_claim_endpoint',
    'void_payment',
    'withdraw_claim',
]
