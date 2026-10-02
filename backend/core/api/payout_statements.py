"""Monthly payout statements: the month the Director signs and Finance reconciles.

Readable by whoever may read the ledger (`rbac.can_view_reports`). Every
figure comes from `core.services.payout_statement`, which reads the ledger.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Optional

from django.conf import settings
from django.db import transaction
from django.http import HttpRequest, HttpResponse
from ninja.errors import HttpError

from core.api.common import PayRefusal, api, rate_limit, require_user, session_auth
from core.models import AuditLog, BankExport, PaidLedger, Role
from core.services import payout_statement as ps
from core.services import rbac

_MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_FY = re.compile(r"^\d{4}-\d{2}$")


def _reader(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    return user


def _month(month: str) -> str:
    if not _MONTH.match(month or ""):
        raise HttpError(400, "Month is YYYY-MM, for example 2026-08.")
    return month


@api.get("/payouts/months", auth=session_auth)
def payout_statement_months(request: HttpRequest):
    _reader(request)
    return {"months": ps.months()}


@api.get("/payouts/statement", auth=session_auth)
def payout_statement(request: HttpRequest, month: str):
    _reader(request)
    return ps.statement(_month(month))


@api.get("/payouts/statement.pdf", auth=session_auth)
def payout_statement_pdf(request: HttpRequest, month: str):
    user = _reader(request)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    st = ps.statement(_month(month))
    resp = HttpResponse(ps.pdf(st, prepared_by=user.name), content_type="application/pdf")
    resp["Content-Disposition"] = f'attachment; filename="payout-statement-{month}.pdf"'
    return resp


def _export_dict(e: BankExport) -> dict:
    return {
        "id": e.id, "month": e.month, "created_at": e.created_at.isoformat(),
        "by": e.created_by.name if e.created_by_id else None, "count": e.row_count,
        "total": round(e.total_amount, 2), "scope": e.scope, "reason": e.reason,
    }


@api.get("/payouts/bank-exports", auth=session_auth)
def bank_exports(request: HttpRequest, month: str):
    """What has already gone to the bank for a month, and what has not.

    The statement screen reads this before it offers the file, so the person
    about to download it is told "already generated on 3 May" first.
    """
    user = _reader(request)
    if user.role not in (Role.FINANCE, Role.SUPER_ADMIN):
        raise HttpError(403, "The bank-upload file is for Finance.")
    month = _month(month)
    lines = ps.bank_lines(ps.statement(month))
    ids = [r["ledger_id"] for r in lines if r["ledger_id"]]
    sent = set(PaidLedger.objects.filter(id__in=ids, bank_export__isnull=False).values_list("id", flat=True))
    fresh = [r for r in lines if r["ledger_id"] and r["ledger_id"] not in sent]
    return {
        "month": month,
        "exports": [_export_dict(e) for e in BankExport.objects.filter(month=month).select_related("created_by")],
        "new_count": len(fresh),
        "new_total": round(sum(r["amount"] for r in fresh), 2),
        "all_count": len(lines),
        "all_total": round(sum(r["amount"] for r in lines), 2),
    }


@api.get("/payouts/statement.csv", auth=session_auth)
def payout_statement_csv(request: HttpRequest, month: str, scope: str = "", reason: str = ""):
    """The bank-upload file, generated once and remembered.

    The bank pays what it is sent, so a second file for the same month is how
    a month gets paid twice. The first download records itself against the
    ledger rows it carried. After that the file is refused until the person
    says what they want: `scope=new` (only payments not yet sent) or
    `scope=all` with a reason (the whole month again, on the record).
    """
    # The bank-upload file carries every payee's account-ready line: Finance
    # and the super admin only, not every reader of the statement.
    user = _reader(request)
    if user.role not in (Role.FINANCE, Role.SUPER_ADMIN):
        raise HttpError(403, "The bank-upload file is for Finance.")
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    month = _month(month)
    if scope not in ("", "new", "all"):
        raise HttpError(400, "Scope is new or all.")
    st = ps.statement(month)
    lines = ps.bank_lines(st)
    ids = [r["ledger_id"] for r in lines if r["ledger_id"]]
    with transaction.atomic():
        # Locking the month's rows makes two people pressing Download together
        # take turns: the second finds the first's rows already marked.
        locked = set(PaidLedger.objects.select_for_update().filter(id__in=ids).values_list("id", flat=True))
        sent = set(PaidLedger.objects.filter(id__in=locked, bank_export__isnull=False).values_list("id", flat=True))
        prior = list(BankExport.objects.filter(month=month).select_related("created_by").order_by("-created_at"))
        fresh = [r for r in lines if r["ledger_id"] and r["ledger_id"] not in sent]
        if prior and not scope:
            last = prior[0]
            raise PayRefusal(
                409,
                f"The bank file for {ps.label_of(month)} was already generated on "
                f"{last.created_at.strftime('%d %b %Y')}"
                f"{' by ' + last.created_by.name if last.created_by_id else ''} ({last.row_count} payments). "
                f"{len(fresh)} payment{'s' if len(fresh) != 1 else ''} since then. "
                "Download only the new ones, or the whole month again with a reason.",
                code="already_exported", exported_at=last.created_at.isoformat(), new_count=len(fresh),
                all_count=len(lines),
            )
        if scope == "all" and prior and len((reason or "").strip()) < 10:
            raise HttpError(400, "Say why the whole month is going to the bank again (10+ characters). It is recorded.")
        if scope == "new":
            if not fresh:
                raise HttpError(400, "Every payment of this month has already gone to the bank.")
            chosen = fresh
        else:
            chosen = lines
        body = ps.bank_csv(st, chosen)
        export = BankExport.objects.create(
            month=month, created_by=user, row_count=len(chosen),
            total_amount=round(sum(r["amount"] for r in chosen), 2),
            sha256=hashlib.sha256(body).hexdigest(), scope="all" if scope in ("", "all") else "new",
            reason=(reason or "").strip() or None,
        )
        PaidLedger.objects.filter(id__in=[r["ledger_id"] for r in chosen if r["ledger_id"]]).update(bank_export=export)
        AuditLog.objects.create(
            actor=user, action="BANK_EXPORT", entity="BankExport", entity_id=export.id,
            detail_json=json.dumps({
                "month": month, "rows": export.row_count, "total": export.total_amount, "scope": export.scope,
                "repeat": bool(prior), "reason": export.reason, "sha256": export.sha256,
            }),
        )
    resp = HttpResponse(body, content_type="text/csv; charset=utf-8")
    suffix = "" if not prior else f"-{export.scope}-{export.created_at.strftime('%H%M')}"
    resp["Content-Disposition"] = f'attachment; filename="bank-upload-{month}{suffix}.csv"'
    return resp


@api.get("/payouts/financial-year", auth=session_auth)
def payout_financial_year(request: HttpRequest, financial_year: Optional[str] = None):
    _reader(request)
    if financial_year and not _FY.match(financial_year):
        raise HttpError(400, "Financial year is written 2026-27.")
    return ps.financial_year(financial_year)


__all__ = [
    "payout_statement_months", "payout_statement", "payout_statement_pdf",
    "payout_statement_csv", "payout_financial_year",
]
