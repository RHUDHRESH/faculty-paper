"""The super admin's one health answer: what needs attention, and why.

GET /admin/attention -> {"checked_at", "items": [...], "ok": [...]}

Each item names the job it belongs to (people, data, money, running), how
urgent it is, a sentence of why it matters, and where to fix it. Everything
here is read from sources that already exist (faults, data health, backups,
author matches, profile requests, duplicates, the live policy), so the Home
callout and the pages behind it cannot disagree.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from django.http import HttpRequest
from django.utils import timezone
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import DuplicateFinding, FormulaConfig, ProfileChangeRequest, Role

#: A backup older than this is reported; the scheduled one runs daily.
BACKUP_STALE_DAYS = 2
#: A data-health report older than this is reported as not recent.
HEALTH_STALE_DAYS = 7

_ORDER = {"critical": 0, "warning": 1, "info": 2}


def _age_days(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        at = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if timezone.is_naive(at):
        at = timezone.make_aware(at)
    return (timezone.now() - at).total_seconds() / 86400


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def attention_items() -> dict[str, Any]:
    from core.api.operations import _faults_now
    from core.services import author_review, backup, integrity

    items: list[dict[str, Any]] = []
    ok: list[str] = []

    def add(key, job, severity, title, why, to, count=None):
        items.append({
            "key": key, "job": job, "severity": severity, "title": title,
            "why": why, "to": to, "count": count,
        })

    # ---- keep money right ----
    if not FormulaConfig.objects.filter(active=True).exists():
        add("no_policy", "money", "critical", "No active policy version",
            "Every claim is priced from built-in defaults. Publish a version so the rates are on record.",
            "/policy")
    else:
        ok.append("A policy version is active")
    dup = DuplicateFinding.objects.filter(status=DuplicateFinding.Status.OPEN).count()
    if dup:
        add("duplicates", "money", "warning", _plural(dup, "possible duplicate payment"),
            "One person may have been paid twice for the same paper. Confirm or dismiss each one.",
            "/duplicates", dup)
    else:
        ok.append("No unreviewed duplicate payments")

    # ---- faults (data gaps, stalled work, money that does not add up) ----
    faults = _faults_now()
    for g in faults["groups"]:
        for f in g["faults"]:
            if f["count"] and f["severity"] in ("critical", "warning"):
                add(f"fault_{f['key']}", "running" if g["key"] != "data" else "people",
                    f["severity"], f"{f['title']}: {f['count']:,}", f["detail"],
                    "/faults")
    if not faults["urgent"]:
        ok.append("No urgent faults")

    # ---- keep data right ----
    report = integrity.last_report()
    if report is None:
        add("health_never", "data", "warning", "The data-health check has never run",
            "Nobody has checked for broken links, duplicate IDs or missing files. Run it once.",
            "/data/health")
    else:
        errors = int(report.get("problems", {}).get("error", 0))
        age = _age_days(report.get("ran_at"))
        if errors:
            add("health_errors", "data", "critical", _plural(errors, "data-health error"),
                "The last check found records that are broken, not just untidy. Each has a fix or a list.",
                "/data/health", errors)
        if age is not None and age > HEALTH_STALE_DAYS:
            add("health_stale", "data", "info", f"Data health last checked {int(age)} days ago",
                "An older report can miss problems added since. Run it again.", "/data/health")
        if not errors and (age is None or age <= HEALTH_STALE_DAYS):
            ok.append("Data health checked recently, no errors")
    try:
        matches = int(author_review.unmatched_groups(status="open", limit=1)["total"])
    except Exception:  # a broken matcher must not take the health page down
        matches = 0
    if matches:
        add("author_matches", "data", "warning", _plural(matches, "unmatched college author name"),
            "Papers under these names are not credited to anyone until each name is matched to a person.",
            "/people/matches", matches)
    else:
        ok.append("Every college author name is matched")

    # ---- keep people right ----
    pending = ProfileChangeRequest.objects.filter(status=ProfileChangeRequest.State.PENDING).count()
    if pending:
        add("requests", "people", "warning", _plural(pending, "profile correction") + " waiting",
            "Staff IDs, names and Scopus links a person cannot change themselves. They wait on you.",
            "/requests", pending)
    else:
        ok.append("No profile corrections waiting")

    # ---- keep it running ----
    stored = backup.stored()
    newest = _age_days(stored[0]["created_at"]) if stored else None
    if not stored:
        add("backup_none", "running", "critical", "No backup is stored",
            "If the database is lost there is nothing to restore from. Take one now.", "/data/health")
    elif newest is not None and newest > BACKUP_STALE_DAYS:
        add("backup_stale", "running", "warning", f"Newest backup is {int(newest)} days old",
            "The daily backup has not run. Everything since then would be lost in a restore.",
            "/data/health")
    else:
        ok.append("A backup was taken in the last two days")

    items.sort(key=lambda x: _ORDER.get(x["severity"], 3))
    return {"checked_at": timezone.now().isoformat(), "items": items, "ok": ok}


@api.get("/admin/attention", auth=session_auth)
def admin_attention(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin sees the system's health")
    return attention_items()
