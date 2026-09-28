"""Monthly payout statements: the month the Director signs and Finance reconciles.

Readable by whoever may read the ledger (`rbac.can_view_reports`). Every
figure comes from `core.services.payout_statement`, which reads the ledger.
"""
from __future__ import annotations

import re
from typing import Optional

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from ninja.errors import HttpError

from core.api.common import api, rate_limit, require_user, session_auth
from core.models import Role
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


@api.get("/payouts/statement.csv", auth=session_auth)
def payout_statement_csv(request: HttpRequest, month: str):
    # The bank-upload file carries every payee's account-ready line: Finance
    # and the super admin only, not every reader of the statement.
    user = _reader(request)
    if user.role not in (Role.FINANCE, Role.SUPER_ADMIN):
        raise HttpError(403, "The bank-upload file is for Finance.")
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    st = ps.statement(_month(month))
    resp = HttpResponse(ps.bank_csv(st), content_type="text/csv; charset=utf-8")
    resp["Content-Disposition"] = f'attachment; filename="bank-upload-{month}.csv"'
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
