"""The year brief: the Principal's one page for the governing council.

GET /reports/brief            -> the figures and the headline sentence
GET /reports/brief/export     -> fmt=pdf (A4, college header) or fmt=xlsx
"""
from __future__ import annotations

from typing import Optional

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from ninja.errors import HttpError

from core.api.common import api, rate_limit, require_user, session_auth
from core.services import institution, principal_brief, rbac
from core.services.aggregate_cache import cached


def _gate(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    return user


def _year(year: Optional[int]) -> Optional[int]:
    if year is not None and not 2000 <= year <= 2100:
        raise HttpError(400, "Year out of range")
    return year


@api.get("/reports/brief", auth=session_auth)
def report_brief(request: HttpRequest, year: Optional[int] = None):
    _gate(request)
    y = _year(year)
    return cached("reports-brief", {"year": y}, lambda: principal_brief.brief(y))


@api.get("/reports/brief/export", auth=session_auth)
def report_brief_export(request: HttpRequest, year: Optional[int] = None, fmt: str = "pdf"):
    _gate(request)
    if fmt not in ("pdf", "xlsx"):
        raise HttpError(400, "fmt must be pdf or xlsx")
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    b = principal_brief.brief(_year(year))
    college = institution.get("college_name") or "Research office"
    if fmt == "pdf":
        body, ctype = principal_brief.pdf(b, college), "application/pdf"
    else:
        body = principal_brief.xlsx(b, college)
        ctype = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    resp = HttpResponse(body, content_type=ctype)
    resp["Content-Disposition"] = f'attachment; filename="research-brief-{b["year"]}.{fmt}"'
    return resp


__all__ = ["report_brief", "report_brief_export"]
