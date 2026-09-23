"""What the college has paid you, from the ledger.

Claims only carry money for what this app processed; everything paid before
it (2024 onward, imported from the accounts workbook) lives in the ledger
with a staff id and no claim. Summing claims alone told a faculty member with
twenty historic payments that they had received nothing, so the home page
reads its money from here.

A row is yours when its claim is yours, or when it has no claim and carries
your staff id. Biometric ids are not matched: they were typed by hand in the
workbook, and a wrong one would show somebody else's payment as yours.
"""
from __future__ import annotations

from datetime import date

from django.db.models import Q
from django.http import HttpRequest

from core.api.common import api, require_user, session_auth
from core.api.deps import _format_payout_month
from core.models import PaidLedger


def academic_year_start(today: date | None = None) -> date:
    """1 June: the college's academic year, as the faculty home counts it."""
    today = today or date.today()
    return date(today.year if today.month >= 6 else today.year - 1, 6, 1)


def ledger_for(user) -> "PaidLedger.objects":
    mine = Q(claim__owner=user)
    staff_id = (user.staff_id or "").strip()
    if staff_id:
        mine |= Q(claim__isnull=True, staff_id__iexact=staff_id)
    return PaidLedger.objects.filter(mine).select_related("claim")


@api.get("/me/payments", auth=session_auth)
def my_payments(request: HttpRequest):
    user = require_user(request)
    rows = list(ledger_for(user).filter(amount__gt=0).order_by("-payout_month", "-id"))
    since = academic_year_start()
    return {
        "total": round(sum(r.amount or 0 for r in rows), 2),
        "this_year": round(sum(r.amount or 0 for r in rows if r.payout_month >= since), 2),
        "since": since.isoformat(),
        "count": len(rows),
        "latest_month": _format_payout_month(rows[0].payout_month) if rows else None,
        "rows": [
            {
                "id": r.id,
                "claim_id": r.claim_id,
                "payout_month": _format_payout_month(r.payout_month),
                "paper_title": r.paper_title,
                "journal_title": r.journal_title,
                "amount": r.amount,
                "voucher_number": r.voucher_number,
            }
            for r in rows
        ],
    }


__all__ = ["my_payments", "ledger_for", "academic_year_start"]
