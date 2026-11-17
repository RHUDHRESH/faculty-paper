"""The Report studio: build, run, save, share, schedule, export and ask for reports.

    GET    /reports/datasets                what can be reported on, and which fields, for this reader
    POST   /reports/run                     a definition -> columns, rows, totals, a chart hint
    POST   /reports/export                  the same, as an Excel, PDF or CSV file
    GET    /reports/templates               ready-made definitions this reader can run
    POST   /reports/ai                      a question in words -> a definition, never data
    GET    /reports/saved                   mine, and the ones shared with me
    POST   /reports/saved                   keep a definition
    GET    /reports/saved/{id}              one
    PUT    /reports/saved/{id}              change it (its owner, or a super admin)
    DELETE /reports/saved/{id}
    POST   /reports/saved/{id}/run          run it as the person asking, not as its owner
    POST   /reports/saved/{id}/duplicate    a private copy for the person asking
    GET    /reports/schedules               my schedules
    GET    /reports/saved/{id}/schedule     my schedule on one report
    POST   /reports/saved/{id}/schedule     email it weekly or monthly, to each recipient as themselves
    DELETE /reports/saved/{id}/schedule
    POST   /reports/saved/{id}/feed         a link for Excel's "From Web" and Google Sheets' IMPORTDATA
    DELETE /reports/saved/{id}/feed         revoke it
    GET    /reports/feed/{token}.csv        the link's reader: public, rate limited

Every route that gives rows runs `report_engine.plan` first, which checks each
name and operator against the dataset's whitelist for the person asking: a
faculty member's rows are their own, a head of department's are their
department's and carry no money, and the office sees the college.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, rate_limit, rate_limit_for, require_user, session_auth
from core.models import AuditLog, ReportSchedule, Role, SavedReport
from core.services import report_ai, report_datasets, report_engine, report_studio, report_templates

RUN_HOURLY = 300
FEED_TOKEN_HOURLY = 60
#: Many people's Google Sheets are fetched from the same few Google addresses,
#: so this bounds only what is plainly abuse. The token's own cap is the real one.
FEED_ADDRESS_HOURLY = 3000
MAX_NAME = 120
MAX_TITLE = 120


class ReportIn(Schema):
    dataset: str
    columns: list[str] = []
    filters: list[dict[str, Any]] = []
    group_by: list[str] = []
    date_bucket: Optional[str] = None
    aggregates: list[dict[str, Any]] = []
    pivot: Optional[dict[str, Any]] = None
    sort: list[dict[str, Any]] = []
    limit: Optional[int] = None
    top_n: Optional[int] = None


class ReportExportIn(ReportIn):
    format: str
    title: Optional[str] = None


class SavedReportIn(Schema):
    name: str
    description: str = ""
    definition: dict[str, Any]
    visibility: str = "private"
    roles: Optional[list[str]] = None


class SavedReportPatch(Schema):
    name: Optional[str] = None
    description: Optional[str] = None
    definition: Optional[dict[str, Any]] = None
    visibility: Optional[str] = None
    roles: Optional[list[str]] = None


class ReportScheduleIn(Schema):
    frequency: str
    day: int
    hour: int = 8
    format: str = "xlsx"
    recipients: list[str]


class ReportAskIn(Schema):
    question: str


def _definition(payload: ReportIn) -> dict[str, Any]:
    return {k: v for k, v in payload.dict().items() if k not in ("format", "title")}


def _refuse(exc: report_engine.ReportError) -> HttpError:
    return HttpError(exc.status, exc.message)


def _audit(user, action: str, report: Optional[SavedReport] = None, **detail: Any) -> None:
    AuditLog.objects.create(
        actor=user, action=action, entity="SavedReport" if report else "Report",
        entity_id=report.pk if report else None, detail_json=json.dumps(detail, default=str),
    )


def _saved_or_404(user, report_id: str) -> SavedReport:
    report = get_object_or_404(SavedReport.objects.select_related("owner"), pk=report_id)
    if not report_studio.can_see(user, report):
        raise HttpError(404, "No such report.")
    return report


def _editable(user, report_id: str) -> SavedReport:
    report = _saved_or_404(user, report_id)
    if not report_studio.can_edit(user, report):
        raise HttpError(403, "Only the person who made this report can change it.")
    return report


def _name(value: Any) -> str:
    text = (value or "").strip() if isinstance(value, str) else ""
    if not 1 <= len(text) <= MAX_NAME:
        raise HttpError(400, f"Give the report a name of 1 to {MAX_NAME} characters.")
    return text


# ------------------------------------------------------------- datasets ----


@api.get("/reports/datasets", auth=session_auth)
def report_datasets_list(request: HttpRequest):
    user = require_user(request)
    viewer = report_datasets.viewer_for(user)
    return [d.describe(viewer) for d in report_datasets.offered(viewer)]


# ------------------------------------------------------------------ run ----


@api.post("/reports/run", auth=session_auth)
def report_run(request: HttpRequest, payload: ReportIn):
    user = require_user(request)
    rate_limit(request, "report_run", RUN_HOURLY, "hour", what="reports")
    try:
        return report_engine.run(user, _definition(payload))
    except report_engine.ReportError as exc:
        raise _refuse(exc) from None


@api.post("/reports/export", auth=session_auth)
def report_export(request: HttpRequest, payload: ReportExportIn):
    user = require_user(request)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    definition = _definition(payload)
    if definition.get("limit") is None:
        definition["limit"] = report_engine.MAX_LIMIT  # a file is for all of it, up to the most
    title = (payload.title or "").strip()
    if len(title) > MAX_TITLE:
        raise HttpError(400, f"The title must be at most {MAX_TITLE} characters.")
    if not title:
        dataset = report_datasets.DATASETS.get(payload.dataset)
        title = dataset.label if dataset else "Report"
    try:
        body, filename, content_type, result = report_studio.render_file(
            user, definition, payload.format, title, generated_by=user.name or user.email,
        )
    except report_engine.ReportError as exc:
        raise _refuse(exc) from None
    _audit(user, "DATA_EXPORT", title=title, format=payload.format, rows=len(result["rows"]), dataset=payload.dataset)
    res = HttpResponse(body, content_type=content_type)
    res["Content-Disposition"] = f'attachment; filename="{filename}"'
    return res


# ------------------------------------------------------------ templates ----


@api.get("/reports/templates", auth=session_auth)
def report_templates_list(request: HttpRequest):
    return report_templates.for_user(require_user(request))


# ------------------------------------------------------------------- ai ----


@api.post("/reports/ai", auth=session_auth)
def report_ai_ask(request: HttpRequest, payload: ReportAskIn):
    user = require_user(request)
    rate_limit(request, "report_ai", 120, "hour", what="questions")
    try:
        out = report_ai.ask(user, payload.question)
    except report_ai.Refused as exc:
        raise HttpError(exc.status, exc.message) from None
    AuditLog.objects.create(
        actor=user, action="REPORT_AI_ASK", entity="Report", entity_id=None,
        detail_json=report_ai.audit_detail(payload.question),
    )
    return out


# ---------------------------------------------------------- saved reports --


@api.get("/reports/saved", auth=session_auth)
def saved_list(request: HttpRequest):
    user = require_user(request)
    mine = {s.report_id: s for s in ReportSchedule.objects.filter(created_by=user).select_related("report")}
    return [report_studio.serialise(r, user, schedule=mine.get(r.pk)) for r in report_studio.visible_reports(user)]


@api.post("/reports/saved", auth=session_auth)
def saved_create(request: HttpRequest, payload: SavedReportIn):
    user = require_user(request)
    name = _name(payload.name)
    try:
        checked = report_engine.plan(user, payload.definition)
        roles = report_studio.clean_roles(payload.visibility, payload.roles)
    except report_engine.ReportError as exc:
        raise _refuse(exc) from None
    report = SavedReport.objects.create(
        owner=user, name=name, description=(payload.description or "").strip()[:2000],
        definition=checked.definition, visibility=payload.visibility, roles=roles,
    )
    _audit(user, "REPORT_SAVED", report, name=name, visibility=report.visibility)
    return report_studio.serialise(report, user)


@api.get("/reports/saved/{report_id}", auth=session_auth)
def saved_get(request: HttpRequest, report_id: str):
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    mine = ReportSchedule.objects.filter(report=report, created_by=user).first()
    return report_studio.serialise(report, user, schedule=mine)


@api.put("/reports/saved/{report_id}", auth=session_auth)
def saved_update(request: HttpRequest, report_id: str, payload: SavedReportPatch):
    user = require_user(request)
    report = _editable(user, report_id)
    try:
        if payload.name is not None:
            report.name = _name(payload.name)
        if payload.description is not None:
            report.description = payload.description.strip()[:2000]
        if payload.definition is not None:
            report.definition = report_engine.plan(user, payload.definition).definition
        visibility = payload.visibility if payload.visibility is not None else report.visibility
        roles = payload.roles if payload.roles is not None else report.roles
        report.roles = report_studio.clean_roles(visibility, roles)
        report.visibility = visibility
    except report_engine.ReportError as exc:
        raise _refuse(exc) from None
    report.save()
    _audit(user, "REPORT_CHANGED", report, name=report.name, visibility=report.visibility)
    return report_studio.serialise(report, user)


@api.delete("/reports/saved/{report_id}", auth=session_auth)
def saved_delete(request: HttpRequest, report_id: str):
    user = require_user(request)
    report = _editable(user, report_id)
    report_studio.drop_schedules_of(report)
    name = report.name
    _audit(user, "REPORT_DELETED", report, name=name)
    report.delete()
    return {"ok": True}


@api.post("/reports/saved/{report_id}/run", auth=session_auth)
def saved_run(request: HttpRequest, report_id: str):
    """Run it as the person asking: their rows, their money rule, not the owner's."""
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    rate_limit(request, "report_run", RUN_HOURLY, "hour", what="reports")
    try:
        return report_engine.run(user, report.definition)
    except report_engine.ReportError as exc:
        raise _refuse(exc) from None


@api.post("/reports/saved/{report_id}/duplicate", auth=session_auth)
def saved_duplicate(request: HttpRequest, report_id: str):
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    copy = SavedReport.objects.create(
        owner=user, name=f"{report.name} (copy)"[:MAX_NAME], description=report.description,
        definition=report.definition, visibility=SavedReport.Visibility.PRIVATE, roles=[],
    )
    _audit(user, "REPORT_SAVED", copy, name=copy.name, copied_from=report.pk)
    return report_studio.serialise(copy, user)


# -------------------------------------------------------------- schedules --


@api.get("/reports/schedules", auth=session_auth)
def schedules_mine(request: HttpRequest):
    user = require_user(request)
    rows = ReportSchedule.objects.filter(created_by=user).select_related("report")
    return [report_studio.serialise_schedule(s) for s in rows if report_studio.can_see(user, s.report)]


@api.get("/reports/saved/{report_id}/schedule", auth=session_auth)
def schedule_get(request: HttpRequest, report_id: str):
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    row = ReportSchedule.objects.filter(report=report, created_by=user).select_related("report").first()
    return {"schedule": report_studio.serialise_schedule(row) if row else None,
            "email_enabled": report_studio.email_enabled()}


@api.post("/reports/saved/{report_id}/schedule", auth=session_auth)
def schedule_set(request: HttpRequest, report_id: str, payload: ReportScheduleIn):
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    try:
        report_studio.check_schedule(payload.frequency, payload.day, payload.hour, payload.format)
        people = report_studio.check_recipients(user, payload.recipients)
        report_engine.plan(user, report.definition)  # one that cannot run would only fail on every send
    except report_engine.ReportError as exc:
        raise _refuse(exc) from None
    row = report_studio.save_schedule(
        report, user, frequency=payload.frequency, day=payload.day, hour=payload.hour,
        fmt=payload.format, recipients=people,
    )
    _audit(user, "REPORT_SCHEDULED", report, frequency=row.frequency, recipients=len(people), format=row.format)
    on = report_studio.email_enabled()
    return {
        "schedule": report_studio.serialise_schedule(row),
        "email_enabled": on,
        "message": ("Scheduled. Each person gets the report as they see it." if on else report_studio.EMAIL_OFF),
    }


@api.delete("/reports/saved/{report_id}/schedule", auth=session_auth)
def schedule_delete(request: HttpRequest, report_id: str):
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    row = ReportSchedule.objects.filter(report=report, created_by=user).first()
    if row is None:
        raise HttpError(404, "You have no schedule on this report.")
    report_studio.drop_schedule(row)
    _audit(user, "REPORT_UNSCHEDULED", report)
    return {"ok": True}


# ------------------------------------------------------------------ feeds --


@api.post("/reports/saved/{report_id}/feed", auth=session_auth)
def feed_make(request: HttpRequest, report_id: str):
    """A link that returns this report as CSV, run as its owner. A new link replaces the old one."""
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    if report.owner_id != user.pk:
        raise HttpError(403, "A link shows the report as its owner sees it, so only the owner can make one.")
    try:
        report_engine.plan(user, report.definition)
    except report_engine.ReportError as exc:
        raise _refuse(exc) from None
    url = report_studio.make_feed(report)
    _audit(user, "REPORT_FEED_MADE", report)
    return {"url": url}


@api.delete("/reports/saved/{report_id}/feed", auth=session_auth)
def feed_revoke(request: HttpRequest, report_id: str):
    user = require_user(request)
    report = _saved_or_404(user, report_id)
    if report.owner_id != user.pk and user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only the owner can revoke this link.")
    report_studio.revoke_feed(report)
    _audit(user, "REPORT_FEED_REVOKED", report)
    return {"ok": True}


def _address(request: HttpRequest) -> str:
    from core.api.auth import _client_ip

    return _client_ip(request) or "unknown"


@api.get("/reports/feed/{token}.csv", auth=None)
def feed_read(request: HttpRequest, token: str):
    """The link's reader. No sign-in: the token is the key, so it is capped per token and per address."""
    rate_limit_for(None, f"feed-ip:{_address(request)}", FEED_ADDRESS_HOURLY, "hour", what="downloads")
    rate_limit_for(None, report_studio.token_bucket(token), FEED_TOKEN_HOURLY, "hour", what="downloads")
    report = report_studio.report_for_feed(token)
    if report is None or not report.owner.active:
        raise HttpError(404, "This link does not work any more.")
    try:
        result = report_engine.run(report.owner, report.definition)
    except report_engine.ReportError:
        raise HttpError(404, "This link does not work any more.") from None
    SavedReport.objects.filter(pk=report.pk).update(feed_last_read_at=timezone.now())
    res = HttpResponse(report_studio.csv_for_feed(result), content_type="text/csv; charset=utf-8")
    res["Cache-Control"] = "no-store"
    res["X-Robots-Tag"] = "noindex"
    return res


__all__ = [
    "report_datasets_list", "report_run", "report_export", "report_templates_list", "report_ai_ask",
    "saved_list", "saved_create", "saved_get", "saved_update", "saved_delete", "saved_run", "saved_duplicate",
    "schedules_mine", "schedule_get", "schedule_set", "schedule_delete", "feed_make", "feed_revoke", "feed_read",
]
