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

from core.services.cell_safe import csv_writer
from datetime import date

from django.db.models import Q
import csv
import io
from typing import Optional

from django.http import HttpRequest, HttpResponse

from core.api.common import _csv_row, api, require_user, session_auth
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
        # Case-insensitive only while nobody else's staff id matches that way
        # (the ERP types them inconsistently); otherwise exact, so "sec123"
        # never reads the payments of "SEC123".
        from core.models import User

        shared = User.objects.filter(staff_id__iexact=staff_id).exclude(pk=user.pk).exists()
        match = Q(staff_id=staff_id) if shared else Q(staff_id__iexact=staff_id)
        mine |= Q(claim__isnull=True) & match
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


def _fy_start_year(d: date) -> int:
    """Indian financial year (1 April to 31 March), named by its starting year."""
    return d.year if d.month >= 4 else d.year - 1


def _fy_label(fy: int) -> str:
    return f"{fy}-{str(fy + 1)[-2:]}"


@api.get("/me/payments/statement", auth=session_auth)
def my_payment_statement(request: HttpRequest, fy: Optional[int] = None, format: str = "json"):
    """Your incentive payments for one financial year (April to March), for tax filing.

    Without `fy`, rows cover all years. Every year you were paid in is listed
    with its total either way. `format=csv` returns a spreadsheet download.
    """
    user = require_user(request)
    rows = list(ledger_for(user).filter(amount__gt=0).order_by("payout_month", "id"))
    years: dict[int, float] = {}
    for r in rows:
        k = _fy_start_year(r.payout_month)
        years[k] = round(years.get(k, 0) + (r.amount or 0), 2)
    if fy is not None:
        rows = [r for r in rows if _fy_start_year(r.payout_month) == fy]
    out_rows = [
        {
            "payout_month": _format_payout_month(r.payout_month),
            "financial_year": _fy_label(_fy_start_year(r.payout_month)),
            "paper_title": r.paper_title,
            "journal_title": r.journal_title,
            "amount": r.amount,
            "voucher_number": r.voucher_number,
            "claim_id": r.claim_id,
        }
        for r in rows
    ]
    total = round(sum(r.amount or 0 for r in rows), 2)
    label = _fy_label(fy) if fy is not None else None
    if format == "csv":
        buf = io.StringIO()
        w = csv_writer(buf)
        w.writerow(["Name", user.name or ""])
        w.writerow(["Staff ID", user.staff_id or ""])
        w.writerow(["Financial year", label or "All years"])
        w.writerow([])
        w.writerow(["Month paid", "Financial year", "Paper", "Journal", "Voucher", "Amount (INR)"])
        for src, r in zip(rows, out_rows):
            w.writerow(_csv_row([
                src.payout_month.strftime("%b %Y") if src.payout_month else "", r["financial_year"],
                r["paper_title"] or "", r["journal_title"] or "", r["voucher_number"] or "",
                f"{r['amount'] or 0:.2f}"]))
        w.writerow([])
        w.writerow(["Total", "", "", "", "", f"{total:.2f}"])
        # BOM: Excel then reads the file as UTF-8 and keeps names and titles intact.
        resp = HttpResponse(("﻿" + buf.getvalue()).encode("utf-8"), content_type="text/csv; charset=utf-8")
        resp["Content-Disposition"] = f'attachment; filename="payment-statement-{label or "all-years"}.csv"'
        return resp
    return {
        "name": user.name,
        "staff_id": user.staff_id,
        "fy": fy,
        "fy_label": label,
        "years": [{"fy": k, "label": _fy_label(k), "total": v} for k, v in sorted(years.items(), reverse=True)],
        "total": total,
        "count": len(out_rows),
        "rows": out_rows,
    }


__all__ = ["my_payments", "my_payment_statement", "ledger_for", "academic_year_start"]
