"""Does the ledger agree with the paid claims?

Three ways it can not, each a list an admin can work through:

* ``no_ledger``  a claim marked paid with no ledger row at all;
* ``mismatch``   a paid claim whose ledger rows add up to something other than
                 the amount the claim says it was paid;
* ``no_claim``   a ledger row that belongs to no claim. Most of these are the
                 payment history the old workbook carried, paid before this
                 system existed, and are correct as they are. A few are the
                 payment behind a claim that was imported without its amount,
                 and linking the two settles both.

The ledger is append-only. Fixing a gap adds a row or links an existing one;
nothing is edited or deleted, and every fix is written to the audit log.
"""
from __future__ import annotations

import json
from typing import Any

from django.db import transaction
from django.db.models import Count, F, Q, Sum
from django.utils import timezone

from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, PaidLedger
from core.services.normalize import normalize_title

MIN_REASON = 10


class LedgerError(ValueError):
    """A fix that cannot be applied; the message is written for the admin."""


def paid_without_row():
    return Claim.objects.filter(status=ClaimStatus.PAID, ledger_rows__isnull=True)


def paid_with_wrong_total():
    """Paid claims that have ledger rows which do not add up to the claim's amount."""
    return (
        Claim.objects.filter(status=ClaimStatus.PAID, ledger_rows__isnull=False)
        .annotate(ledger_total=Sum("ledger_rows__amount"))
        .filter(remuneration__isnull=False)
        .exclude(remuneration=0)
        .exclude(ledger_total__gte=F("remuneration") - 0.01, ledger_total__lte=F("remuneration") + 0.01)
    )


def rows_without_claim():
    return PaidLedger.objects.filter(claim__isnull=True)


def counts() -> dict[str, int]:
    return {
        "no_ledger": paid_without_row().count(),
        "mismatch": paid_with_wrong_total().count(),
        "no_claim": rows_without_claim().count(),
    }


def _claim_row(c: Claim, total: float | None = None) -> dict[str, Any]:
    paid = float(c.remuneration or 0)
    have = float(total if total is not None else sum(r.amount or 0 for r in c.ledger_rows.all()))
    return {
        "id": c.id,
        "ticket_number": c.ticket_number,
        "imported": bool(c.ticket_number and c.ticket_number.startswith("ERP-")),
        "title": c.paper_title,
        "owner": {"user_id": c.owner_id, "name": c.owner.name or c.owner.email},
        "month_paid": c.payout_month.isoformat() if c.payout_month else None,
        "claim_amount": c.remuneration,
        "ledger_total": have,
        "missing": round(paid - have, 2),
    }


def problem_rows(kind: str, q: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    if kind in ("no-ledger", "mismatch"):
        qs = paid_without_row() if kind == "no-ledger" else paid_with_wrong_total()
        qs = qs.select_related("owner").prefetch_related("ledger_rows").order_by("ticket_number")
        total = qs.count()
        return {
            "kind": kind,
            "total": total,
            "rows": [_claim_row(c) for c in qs[offset : offset + limit]],
        }
    if kind == "no-claim":
        qs = rows_without_claim().order_by("-payout_month", "faculty_name", "id")
        if q:
            qs = qs.filter(
                Q(faculty_name__icontains=q)
                | Q(paper_title__icontains=q)
                | Q(voucher_number__icontains=q)
                | Q(staff_id__icontains=q)
            )
        total = qs.count()
        page = list(qs[offset : offset + limit])
        by_title: dict[str, list[Claim]] = {}
        keys = {normalize_title(r.paper_title) for r in page} - {""}
        if keys:
            # The stored normalised title is not filled on every path that
            # creates a claim, so the paid claims are normalised here.
            for c in Claim.objects.filter(status=ClaimStatus.PAID).select_related("owner"):
                k = normalize_title(c.paper_title)
                if k in keys:
                    by_title.setdefault(k, []).append(c)
        rows = []
        for r in page:
            cands = by_title.get(normalize_title(r.paper_title), [])
            rows.append({
                "id": r.id,
                "faculty_name": r.faculty_name,
                "staff_id": r.staff_id,
                "department": r.department,
                "paper_title": r.paper_title,
                "voucher_number": r.voucher_number,
                "month": r.payout_month.isoformat() if r.payout_month else None,
                "amount": r.amount,
                "candidates": [
                    {
                        "id": c.id,
                        "ticket_number": c.ticket_number,
                        "owner": c.owner.name or c.owner.email,
                        "claim_amount": c.remuneration,
                    }
                    for c in cands[:3]
                ],
            })
        return {"kind": kind, "total": total, "rows": rows}
    raise LedgerError("kind must be no-ledger, mismatch or no-claim")


def orphan_index() -> dict[str, list[PaidLedger]]:
    """Ledger rows with no claim, by the normalised title they carry. Built
    once per request: the same index answers every claim in a list."""
    out: dict[str, list[PaidLedger]] = {}
    for r in rows_without_claim().exclude(paper_title__isnull=True).only(
        "id", "paper_title", "amount", "voucher_number", "payout_month", "faculty_name"
    ):
        key = normalize_title(r.paper_title)
        if key:
            out.setdefault(key, []).append(r)
    return out


def matches_for_claim(claim: Claim, index: dict[str, list[PaidLedger]] | None = None) -> list[dict[str, Any]]:
    """Payments in the ledger that name this paper and belong to no claim."""
    key = normalize_title(claim.paper_title)
    if not key:
        return []
    rows = [r for r in (index if index is not None else orphan_index()).get(key, []) if (r.amount or 0) > 0]
    return [
        {
            "id": r.id,
            "amount": r.amount,
            "voucher_number": r.voucher_number,
            "month": r.payout_month.isoformat() if r.payout_month else None,
            "faculty_name": r.faculty_name,
        }
        for r in rows[:5]
    ]


def _reason(reason: str) -> str:
    reason = (reason or "").strip()
    if len(reason) < MIN_REASON:
        raise LedgerError("Say why (at least 10 characters). It is kept with the change.")
    return reason


def link_row(actor, row_id: str, claim_ref: str, reason: str) -> dict[str, Any]:
    """Attach an orphan ledger row to the paid claim it belongs to."""
    reason = _reason(reason)
    from core.api.common import _refuse_own_claim

    with transaction.atomic():
        row = PaidLedger.objects.select_for_update().filter(pk=row_id).first()
        if row is None:
            raise LedgerError("That ledger row no longer exists.")
        if row.claim_id:
            raise LedgerError("That ledger row already belongs to a claim.")
        ref = (claim_ref or "").strip()
        claim = Claim.objects.filter(Q(pk=ref) | Q(ticket_number__iexact=ref)).select_related("owner").first()
        if claim is None:
            raise LedgerError(f"No claim has the number {ref or '(blank)'}.")
        _refuse_own_claim(actor, claim)
        if claim.status != ClaimStatus.PAID:
            raise LedgerError("That claim is not marked paid, so a payment cannot be linked to it.")
        row.claim = claim
        row.save(update_fields=["claim"])
        AuditLog.objects.create(
            actor=actor,
            action="LEDGER_ROW_LINK",
            entity="PaidLedger",
            entity_id=row.id,
            detail_json=json.dumps({
                "reason": reason,
                "before": {"claim": None},
                "after": {"claim": claim.ticket_number or claim.id},
                "amount": row.amount,
            }),
        )
        ClaimAction.objects.create(claim=claim, actor=actor, action="ADMIN_EDIT", note=f"Linked a ledger payment of {row.amount}: {reason}"[:500])
        return {"ok": True, "claim": _claim_row(claim)}


def add_missing(actor, claim_id: str, reason: str) -> dict[str, Any]:
    """Write the ledger row a paid claim is missing (or the difference, when the
    rows it has do not add up), so the ledger agrees with the claim."""
    reason = _reason(reason)
    from core.api.common import _refuse_own_claim

    with transaction.atomic():
        claim = Claim.objects.select_for_update().select_related("owner").filter(pk=claim_id).first()
        if claim is None:
            raise LedgerError("No such claim.")
        _refuse_own_claim(actor, claim)
        if claim.status != ClaimStatus.PAID:
            raise LedgerError("Only a paid claim has a ledger row.")
        if not claim.remuneration or claim.remuneration <= 0:
            raise LedgerError("This claim has no amount yet. Set the amount under Fix imported claims first.")
        have = float(claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0)
        delta = round(float(claim.remuneration) - have, 2)
        if abs(delta) < 0.01:
            raise LedgerError("The ledger already agrees with this claim.")
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
        AuditLog.objects.create(
            actor=actor,
            action="LEDGER_ROW_ADD",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps({
                "reason": reason,
                "before": {"ledger_total": have},
                "after": {"ledger_total": round(have + delta, 2)},
                "row_amount": delta,
            }),
        )
        ClaimAction.objects.create(claim=claim, actor=actor, action="ADMIN_EDIT", note=f"Added a ledger row of {delta}: {reason}"[:500])
        return {"ok": True, "added": delta, "claim": _claim_row(claim, have + delta)}
