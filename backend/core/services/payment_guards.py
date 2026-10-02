"""The questions Finance's Pay button must answer before money leaves.

Kept out of the endpoint so the pay dialog can ask them *before* the click
(`GET /claims/{id}/pay-check`) and the endpoint can enforce them *again* under
the row lock: the dialog is the courtesy, the endpoint is the guard.

Nothing here writes. Everything is phrased for Finance, who is allowed to know
a payment exists on the ledger (it is their ledger) but is not told about a
contested payment-history match or who set a warning aside
(`core.visibility`): the answers say "already on the ledger", never "flagged".
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any

from django.db.models import Sum

from core.models import Claim, ClaimStatus, PaidLedger, PriorPayment
from core.services import claim_standing
from core.services.normalize import normalize_doi, normalize_title
from core.services.record_dates import MONTH_KEYS, erp_row

MAX_KEY = 128


def clean_key(raw: str | None) -> str | None:
    """A client's idempotency key, or None when it sent none."""
    key = (raw or "").strip()
    return key[:MAX_KEY] if key else None


def _month_name(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        return date(int(iso[:4]), int(iso[5:7]), 1).strftime("%B %Y")
    except (ValueError, IndexError):
        return None


def _sheet_month(raw_json: str | None) -> str | None:
    """"YYYY-MM" from the workbook's own month column, when the row has one.
    The import stamped every other row with its own month, which is no answer."""
    row = erp_row(raw_json) or {}
    for k in MONTH_KEYS:
        m = re.match(r"(\d{4})-(\d{2})", str(row.get(k) or ""))
        if m:
            return f"{m.group(1)}-{m.group(2)}"
    return None


def current_cycle(claim: Claim) -> int:
    """1 for a claim never paid; one more after each void."""
    return 1 + claim.ledger_rows.filter(kind=PaidLedger.Kind.REVERSAL).count()


def live_payment(claim: Claim) -> PaidLedger | None:
    """The claim's current payment row: this cycle's PAYMENT, if it has one."""
    return (claim.ledger_rows.filter(kind=PaidLedger.Kind.PAYMENT, cycle=current_cycle(claim))
            .order_by("created_at").first())


def attach_row(row: PaidLedger, claim: Claim) -> list[str]:
    """Point an unattached ledger row at `claim` and give it the right kind.

    A payment that arrives with no claim is the claim's payment, unless the
    claim already has one in this cycle: then it is a second row for the same
    money and is recorded as a correction, never as a second payment (which
    the database would refuse). Returns the fields to save.
    """
    row.claim = claim
    row.cycle = current_cycle(claim)
    has_payment = claim.ledger_rows.filter(kind=PaidLedger.Kind.PAYMENT, cycle=row.cycle).exists()
    row.kind = PaidLedger.Kind.ADJUSTMENT if has_payment or (row.amount or 0) < 0 else PaidLedger.Kind.PAYMENT
    return ["claim", "kind", "cycle"]


def net_on_ledger(claim: Claim) -> float:
    return float(claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0)


def already_paid_answer(claim: Claim) -> dict[str, Any] | None:
    """This very claim already has money out on the ledger."""
    row = live_payment(claim)
    if row is None and net_on_ledger(claim) <= 0.005:
        return None
    row = row or claim.ledger_rows.filter(amount__gt=0).order_by("-created_at").first()
    month = row.payout_month.isoformat()[:7] if row and row.payout_month else None
    on = _month_name(month)
    return {
        "code": "already_paid",
        "message": "Already paid" + (f" in {on}" if on else "")
                   + ". A claim is paid once, so nothing was paid again.",
        "paid_on": row.created_at.date().isoformat() if row else None,
        "paid_month": month,
        "amount": float(row.amount) if row else None,
        "voucher": row.voucher_number if row else None,
    }


def earlier_payment(claim: Claim) -> dict[str, Any] | None:
    """The same person, the same paper, paid before and not by this claim.

    Looks at the person's other paid claims, then at the old workbook's
    payments. Matched on DOI, or on a long exact title; never on a fuzzy one,
    because a wrong "already paid" stops a person being paid what they are owed.
    A co-author's payment for the same paper is not a match: the scheme pays
    each author their own share.
    """
    d = normalize_doi(claim.doi)
    key = normalize_title(claim.paper_title)
    if not claim_standing.key_ok(key):
        key = ""
    cond = claim_standing._match_q(d, claim.eid, key)
    if not cond:
        return None
    other = (Claim.objects.filter(cond, owner_id=claim.owner_id, status=ClaimStatus.PAID)
             .exclude(pk=claim.pk).order_by("-paid_at", "-payout_month").first())
    if other is not None:
        month = other.payout_month.isoformat()[:7] if other.payout_month else None
        return {
            "code": "paid_before",
            "message": f"This paper was already paid to {claim.owner.name}"
                       + (f" in {_month_name(month)}" if month else "")
                       + f" on {other.ticket_number or 'another claim'}. It is on the ledger, so it is not paid again.",
            "paid_month": month, "amount": other.remuneration, "reference": other.ticket_number,
        }
    staff = (claim.owner.staff_id or "").strip()
    if not staff:
        return None
    # A claim imported from the workbook has its own payment-history row
    # (claim_ref is its ticket number); that row is this claim, not an earlier one.
    prior = PriorPayment.objects.filter(employee_id__iexact=staff)
    if claim.ticket_number:
        prior = prior.exclude(claim_ref=claim.ticket_number)
    hit = None
    if d:
        hit = prior.filter(doi__iexact=d).first()
    if hit is None and key:
        hit = prior.filter(normalized_title=key).first()
    if hit is None:
        return None
    month = _sheet_month(hit.raw_json)
    return {
        "code": "paid_before",
        "message": f"This paper is already on the payment ledger for {claim.owner.name}"
                   + (f", paid in {_month_name(month)}" if month else "")
                   + ". It is not paid again.",
        "paid_month": month, "amount": hit.amount_paid, "reference": hit.claim_ref,
    }


def history_match_is_settled(claim: Claim) -> bool:
    """Somebody decided this earlier payment is not the same money, and a
    second person agreed. Only then may the claim be paid despite it."""
    return bool(
        claim.duplicate_warning and claim.override_duplicate
        and claim.second_approved_by_id and claim.second_approved_by_id != claim.cleared_by_id
    )
