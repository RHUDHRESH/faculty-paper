"""Saved reports, who may open them, files, schedules and feed links.

The engine (`report_engine`) answers one definition for one person. This is
everything around it that has an owner and a lifetime:

- **Sharing.** A saved report is private, shared with some roles, or shared
  with everyone who signs in. Sharing never shares rows: whoever opens it runs
  it as themselves, so a head of department who opens a report an office user
  built gets their own department and no money, or a sentence saying why not.
- **Files.** One function writes the Excel, PDF or CSV for the studio's
  export, the email and (as CSV) the feed, through the shared exporters, so
  every cell is formula-safe.
- **Schedules.** A weekly or monthly django-q job renders the report *as each
  recipient* and emails it. With email off the schedule is kept and says so.
- **Feeds.** A link holding a random token, of which only the SHA-256 is
  stored, returns the report as CSV run as its owner, for Excel's "From Web"
  and Google Sheets' IMPORTDATA. A new link replaces the old one; deleting it
  revokes it.
"""
from __future__ import annotations

import hashlib
import json
import io
import logging
import secrets
from datetime import datetime, time, timedelta
from typing import Any, Optional
from zoneinfo import ZoneInfo

from django.conf import settings
from django.core.mail import EmailMessage, get_connection
from django.db.models import Q
from django.utils import timezone
from django.utils.text import slugify

from core.models import AuditLog, ReportSchedule, Role, SavedReport, User
from core.services import exporters, rbac, report_engine
from core.services.cell_safe import csv_writer

logger = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
SCHEDULE_FUNC = "core.tasks.send_report_schedule"
MAX_RECIPIENTS = 50
FEED_PATH = "/api/reports/feed/{token}.csv"
EMAIL_OFF = (
    "Emails are not switched on for this server, so this schedule is saved but nothing will be sent "
    "until they are."
)


# --------------------------------------------------------------- sharing ----


def visible_reports(user) -> list[SavedReport]:
    """Mine, and the ones shared with me, newest first."""
    rows = SavedReport.objects.filter(
        Q(owner=user) | Q(visibility=SavedReport.Visibility.EVERYONE) | Q(visibility=SavedReport.Visibility.ROLE)
    ).select_related("owner")
    return [r for r in rows if can_see(user, r)]


def can_see(user, report: SavedReport) -> bool:
    if report.owner_id == user.pk or user.role == Role.SUPER_ADMIN:
        return True
    if report.visibility == SavedReport.Visibility.EVERYONE:
        return True
    return report.visibility == SavedReport.Visibility.ROLE and user.role in (report.roles or [])


def can_edit(user, report: SavedReport) -> bool:
    return report.owner_id == user.pk or user.role == Role.SUPER_ADMIN


def clean_roles(visibility: str, roles: Optional[list[str]]) -> list[str]:
    """The roles a report is shared with, checked; empty unless shared by role."""
    if visibility not in SavedReport.Visibility.values:
        raise report_engine.ReportError(f"Visibility must be one of: {', '.join(SavedReport.Visibility.values)}.")
    if visibility != SavedReport.Visibility.ROLE:
        return []
    wanted = list(dict.fromkeys(roles or []))
    unknown = [r for r in wanted if r not in Role.values]
    if unknown:
        raise report_engine.ReportError(f"{unknown[0]!r} is not a role. Use one of: {', '.join(Role.values)}.")
    if not wanted:
        raise report_engine.ReportError("Choose at least one role to share this report with.")
    return wanted


def serialise(report: SavedReport, user, *, schedule: Optional[ReportSchedule] = None) -> dict[str, Any]:
    try:
        report_engine.plan(user, report.definition)
        problem = None
    except report_engine.ReportError as exc:
        problem = exc.message
    return {
        "id": report.id,
        "name": report.name,
        "description": report.description,
        "definition": report.definition,
        "visibility": report.visibility,
        "roles": list(report.roles or []),
        "owner_id": report.owner_id,
        "owner_name": report.owner.name,
        "mine": report.owner_id == user.pk,
        "can_edit": can_edit(user, report),
        "runnable": problem is None,
        "problem": problem,
        "has_feed": bool(report.feed_token_hash) and report.owner_id == user.pk,
        "schedule": serialise_schedule(schedule) if schedule is not None else None,
        "created_at": report.created_at.isoformat(),
        "updated_at": report.updated_at.isoformat(),
    }


# ----------------------------------------------------------------- files ----


def render_file(user, definition: Any, fmt: str, title: str, *, generated_by: str = "") -> tuple[bytes, str, str, dict]:
    """(bytes, filename, content type, result) for `definition` run as `user`.

    The filters are written above the table in Excel and PDF, so a file read
    next month still says what it was asked.
    """
    if fmt not in report_engine.FORMATS:
        raise report_engine.ReportError(f"Format must be one of: {', '.join(report_engine.FORMATS)}.")
    plan = report_engine.plan(user, definition)
    result = report_engine.execute(plan)
    headings, rows, kinds = report_engine.table_for_file(result, plan)
    header = report_engine.describe_filters(plan)
    if result["truncated"]:
        header.append(f"Showing the first {len(result['rows']):,} of {result['total_rows']:,} rows.")
    else:
        header.append(f"{result['total_rows']:,} row{'s' if result['total_rows'] != 1 else ''}.")
    from core.services import institution

    college = institution.get("college_name") or "Research office"
    now = timezone.localtime()
    generated = f"{college} · generated {now:%d %b %Y, %H:%M}" + (f" for {generated_by}" if generated_by else "")
    body = exporters.render_table(
        title, "", headings, rows, fmt, kinds=kinds, generated_line=generated, header_lines=header,
    )
    stem = slugify(title)[:50].strip("-") or "report"
    return body, f"{stem}-{timezone.localdate():%Y%m%d}.{fmt}", exporters.CONTENT_TYPES[fmt], result


def csv_for_feed(result: dict[str, Any]) -> bytes:
    """The result as CSV text: headings, then rows, every string formula-safe."""
    buf = io.StringIO()
    writer = csv_writer(buf)
    writer.writerow([c["label"] for c in result["columns"]])
    keys = [c["key"] for c in result["columns"]]
    types = [c["type"] for c in result["columns"]]
    for row in result["rows"]:
        writer.writerow([
            ("Yes" if row[k] else "No") if (t == "bool" and row[k] is not None) else ("" if row[k] is None else row[k])
            for k, t in zip(keys, types)
        ])
    return buf.getvalue().encode("utf-8")


# ----------------------------------------------------------------- feeds ----


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def make_feed(report: SavedReport) -> str:
    """A new feed link for `report`; the old one stops working. The token is returned once."""
    from core.services.notify import app_url

    token = secrets.token_urlsafe(32)
    report.feed_token_hash = _hash(token)
    report.feed_created_at = timezone.now()
    report.feed_last_read_at = None
    report.save(update_fields=["feed_token_hash", "feed_created_at", "feed_last_read_at", "updated_at"])
    return app_url(FEED_PATH.format(token=token))


def revoke_feed(report: SavedReport) -> None:
    report.feed_token_hash = None
    report.feed_created_at = None
    report.feed_last_read_at = None
    report.save(update_fields=["feed_token_hash", "feed_created_at", "feed_last_read_at", "updated_at"])


def report_for_feed(token: str) -> Optional[SavedReport]:
    if not token or len(token) > 200:
        return None
    return SavedReport.objects.select_related("owner").filter(feed_token_hash=_hash(token)).first()


def token_bucket(token: str) -> str:
    """A rate-limit bucket for one token that does not itself hold the token."""
    return "feed:" + _hash(token)[:24]


# ------------------------------------------------------------- schedules ----


def email_enabled() -> bool:
    from core.services.notify import email_enabled as enabled

    return enabled()


def next_run(frequency: str, day: int, hour: int, now: Optional[datetime] = None) -> datetime:
    """The next time (India time) that weekday or day of month comes round at `hour`."""
    now = (now or timezone.now()).astimezone(IST)
    at = datetime.combine(now.date(), time(hour, 0), tzinfo=IST)
    if frequency == ReportSchedule.Frequency.WEEKLY:
        at += timedelta(days=(day - at.weekday()) % 7)
        while at <= now:
            at += timedelta(days=7)
        return at
    year, month = now.year, now.month
    while True:
        candidate = datetime.combine(now.date().replace(year=year, month=month, day=day), time(hour, 0), tzinfo=IST)
        if candidate > now:
            return candidate
        month += 1
        if month > 12:
            year, month = year + 1, 1


def check_schedule(frequency: Any, day: Any, hour: Any, fmt: Any) -> None:
    if frequency not in ReportSchedule.Frequency.values:
        raise report_engine.ReportError("Frequency must be 'weekly' or 'monthly'.")
    if isinstance(day, bool) or not isinstance(day, int):
        raise report_engine.ReportError("Day must be a whole number.")
    if frequency == ReportSchedule.Frequency.WEEKLY and not 0 <= day <= 6:
        raise report_engine.ReportError("For a weekly report, day is 0 for Monday to 6 for Sunday.")
    if frequency == ReportSchedule.Frequency.MONTHLY and not 1 <= day <= 28:
        raise report_engine.ReportError("For a monthly report, day is 1 to 28, so every month has it.")
    if isinstance(hour, bool) or not isinstance(hour, int) or not 0 <= hour <= 23:
        raise report_engine.ReportError("Hour is a whole number from 0 to 23, in India time.")
    if fmt not in report_engine.FORMATS:
        raise report_engine.ReportError(f"Format must be one of: {', '.join(report_engine.FORMATS)}.")


def check_recipients(creator, ids: Any) -> list[User]:
    if not isinstance(ids, list) or not ids:
        raise report_engine.ReportError("Choose at least one person to send it to.")
    wanted = list(dict.fromkeys(str(i) for i in ids))
    if len(wanted) > MAX_RECIPIENTS:
        raise report_engine.ReportError(f"A schedule can have at most {MAX_RECIPIENTS} recipients.")
    people = list(User.objects.filter(pk__in=wanted, active=True))
    missing = set(wanted) - {p.pk for p in people}
    if missing:
        raise report_engine.ReportError("One of the people you chose is not an active user.")
    if not rbac.can_view_reports(creator.role) and any(p.pk != creator.pk for p in people):
        raise report_engine.ReportError("You can schedule a report to yourself. The research office can send it to others.", 403)
    return people


def save_schedule(report: SavedReport, creator, *, frequency: str, day: int, hour: int, fmt: str,
                  recipients: list[User]) -> ReportSchedule:
    """Make or replace `creator`'s schedule on `report`, and its django-q job."""
    from django_q.models import Schedule

    row, _created = ReportSchedule.objects.update_or_create(
        report=report, created_by=creator,
        defaults={"frequency": frequency, "day": day, "hour": hour, "format": fmt},
    )
    row.recipients.set(recipients)
    name = f"report-schedule-{row.pk}"
    when = next_run(frequency, day, hour)
    kind = Schedule.WEEKLY if frequency == ReportSchedule.Frequency.WEEKLY else Schedule.MONTHLY
    Schedule.objects.update_or_create(
        name=name,
        defaults={"func": SCHEDULE_FUNC, "args": repr(row.pk), "schedule_type": kind, "repeats": -1, "next_run": when},
    )
    row.schedule_name = name
    row.save(update_fields=["schedule_name"])
    return row


def drop_schedule(row: ReportSchedule) -> None:
    from django_q.models import Schedule

    Schedule.objects.filter(name=row.schedule_name or f"report-schedule-{row.pk}").delete()
    row.delete()


def drop_schedules_of(report: SavedReport) -> None:
    for row in list(report.schedules.all()):
        drop_schedule(row)


def serialise_schedule(row: ReportSchedule) -> dict[str, Any]:
    return {
        "id": row.id,
        "report_id": row.report_id,
        "report_name": row.report.name,
        "frequency": row.frequency,
        "day": row.day,
        "hour": row.hour,
        "format": row.format,
        "recipients": [{"id": u.pk, "name": u.name} for u in row.recipients.all()],
        "next_run": next_run(row.frequency, row.day, row.hour).isoformat(),
        "last_sent_at": row.last_sent_at.isoformat() if row.last_sent_at else None,
        "last_result": row.last_result,
        "email_enabled": email_enabled(),
    }


def deliver(schedule_id: str) -> dict[str, Any]:
    """The job body: render the report as each recipient and email them the file.

    A recipient who may no longer see the report (the definition needs a field
    their role lost) is skipped with the reason, not sent a different report.
    """
    row = ReportSchedule.objects.select_related("report", "created_by").filter(pk=schedule_id).first()
    if row is None:
        from django_q.models import Schedule

        Schedule.objects.filter(name=f"report-schedule-{schedule_id}").delete()
        return {"sent": 0, "skipped": 0, "note": "The schedule no longer exists."}
    summary = {"sent": 0, "skipped": 0, "problems": []}
    if not email_enabled():
        row.last_result = "Not sent: emails are off on this server."
        row.save(update_fields=["last_result"])
        return {**summary, "note": row.last_result}

    connection = get_connection()
    try:
        connection.open()
    except Exception:  # noqa: BLE001 - a mail server that is down is reported, not raised
        logger.exception("report_schedule_connection_failed id=%s", row.pk)
        row.last_result = "Not sent: the mail server could not be reached."
        row.save(update_fields=["last_result"])
        return {**summary, "note": row.last_result}
    try:
        for person in row.recipients.filter(active=True).exclude(email=""):
            try:
                body, filename, content_type, result = render_file(
                    person, row.report.definition, row.format, row.report.name, generated_by=person.name,
                )
            except report_engine.ReportError as exc:
                summary["skipped"] += 1
                summary["problems"].append(f"{person.name}: {exc.message}")
                continue
            message = EmailMessage(
                subject=f"{row.report.name}: your scheduled report",
                body=(
                    f"Hello {person.name or person.email},\n\n"
                    f"Your scheduled report \"{row.report.name}\" is attached "
                    f"({result['total_rows']:,} row{'s' if result['total_rows'] != 1 else ''}).\n"
                    "It shows what you are able to see in the app.\n"
                ),
                from_email=getattr(settings, "DEFAULT_FROM_EMAIL", None),
                to=[person.email],
                connection=connection,
            )
            message.attach(filename, body, content_type.split(";")[0])
            try:
                message.send()
                summary["sent"] += 1
            except Exception:  # noqa: BLE001
                logger.exception("report_schedule_send_failed id=%s to=%s", row.pk, person.pk)
                summary["skipped"] += 1
                summary["problems"].append(f"{person.name}: the email could not be sent.")
    finally:
        try:
            connection.close()
        except Exception:  # noqa: BLE001
            pass
    row.last_sent_at = timezone.now()
    row.last_result = f"Sent to {summary['sent']}" + (f", skipped {summary['skipped']}" if summary["skipped"] else "")
    row.save(update_fields=["last_sent_at", "last_result"])
    AuditLog.objects.create(
        actor=row.created_by, action="REPORT_SCHEDULE_SENT", entity="SavedReport", entity_id=row.report_id,
        detail_json=json.dumps({"schedule": row.pk, **summary}),
    )
    return summary
