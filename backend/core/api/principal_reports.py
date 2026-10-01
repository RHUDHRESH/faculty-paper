"""The lists behind the Principal's figures.

GET /reports/papers      -> the college's papers, filtered (year, department, quartile, q)
GET /reports/department  -> one department in a year
"""
from __future__ import annotations

from typing import Optional

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from ninja.errors import HttpError

from core.api.common import api, rate_limit, require_user, session_auth
from core.services import institution, principal_reports, rbac


def _gate(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    return user


@api.get("/reports/papers", auth=session_auth)
def report_papers(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    quartile: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 25,
    offset: int = 0,
):
    _gate(request)
    return principal_reports.papers_list(
        year=year, department=(department or "").strip() or None, quartile=(quartile or "").strip() or None,
        q=q, limit=max(1, min(limit, 100)), offset=max(0, offset),
    )


@api.get("/reports/papers/export", auth=session_auth)
def report_papers_export(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    quartile: Optional[str] = None,
    q: Optional[str] = None,
):
    """The list the Principal is looking at, as an Excel sheet."""
    _gate(request)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    data = principal_reports.papers_list(
        year=year, department=(department or "").strip() or None, quartile=(quartile or "").strip() or None,
        q=q, limit=20000, offset=0,
    )
    college = institution.get("college_name") or "Research office"
    bits = [str(year) if year else "all years", department or "every department"]
    if quartile:
        bits.append({"top": "Q1 or Q2 journals", "none": "no quartile recorded"}.get(quartile.lower(), quartile.upper()))
    if q:
        bits.append(f"matching \"{q}\"")
    body = principal_reports.papers_xlsx(college, ", ".join(bits), data["results"])
    resp = HttpResponse(body, content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    resp["Content-Disposition"] = f'attachment; filename="papers-{year or "all"}.xlsx"'
    return resp


@api.get("/reports/accreditation", auth=session_auth)
def report_accreditation(request: HttpRequest, year: Optional[int] = None):
    """Where the college stands for NAAC 3.3.1 and NIRF, five years to `year`."""
    _gate(request)
    if year is not None and not 2000 <= year <= 2100:
        raise HttpError(400, "Year out of range")
    from core.services.aggregate_cache import shared as cached

    return cached("reports-accreditation", {"y": year}, lambda: principal_reports.accreditation_summary(year))


@api.get("/reports/department", auth=session_auth)
def report_department(request: HttpRequest, name: str, year: Optional[int] = None):
    _gate(request)
    if year is not None and not 2000 <= year <= 2100:
        raise HttpError(400, "Year out of range")
    out = principal_reports.department_detail(name, year)
    if out is None:
        raise HttpError(404, "No such department")
    return out


__all__ = ["report_papers", "report_papers_export", "report_accreditation", "report_department"]
