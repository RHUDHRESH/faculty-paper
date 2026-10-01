"""The Admin hub's live counts: what needs attention behind each card.

GET /admin/hub -> {"counts": {"/requests": {"count": 3, "tone": "caution",
"note": "..."}, ...}}

The cards themselves (their words, sections and who sees them) live in the
front end's nav catalogue, next to the routes they open. Only the numbers come
from here, keyed by route, and only for the pages the reader may open: the job
queue is the super admin's alone, so it is absent for everybody else rather
than zero.

Each figure comes from the source the page behind it reads (profile requests,
author matches, duplicate findings, faults, the data-health report, backups,
the job queue), so a card can never disagree with its page.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from django.http import HttpRequest
from django.utils import timezone
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, DuplicateFinding, FormulaConfig, ProfileChangeRequest, Role, User
from core.services import rbac


def _entry(count: int | None, tone: str | None = None, note: str | None = None) -> dict[str, Any]:
    return {"count": count, "tone": tone, "note": note}


def hub_counts(role: str) -> dict[str, dict[str, Any]]:
    from core.api.operations import _faults_now
    from core.services import author_review, backup, integrity

    out: dict[str, dict[str, Any]] = {}

    pending = ProfileChangeRequest.objects.filter(status=ProfileChangeRequest.State.PENDING).count()
    out["/requests"] = _entry(pending, "caution" if pending else None)

    out["/people"] = _entry(None, None, f"{User.objects.filter(active=True).count():,} active accounts")

    try:
        matches = int(author_review.unmatched_groups(status="open", limit=1)["total"])
    except Exception:  # a broken matcher must not take the hub down
        matches = 0
    out["/people/matches"] = _entry(matches, "caution" if matches else None)

    dup = DuplicateFinding.objects.filter(status=DuplicateFinding.Status.OPEN).count()
    out["/duplicates"] = _entry(dup, "caution" if dup else None)

    faults = _faults_now()
    total = sum(f["count"] for g in faults["groups"] for f in g["faults"] if f["severity"] in ("critical", "warning"))
    urgent = int(faults.get("urgent") or 0)
    out["/faults"] = _entry(total, "critical" if urgent else ("caution" if total else None),
                            f"{urgent:,} of them urgent" if urgent else None)

    now = timezone.now()
    day = AuditLog.objects.filter(created_at__gte=now - timedelta(days=1)).count()
    out["/audit"] = _entry(None, None, f"{day:,} changes in the last day")

    active = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    out["/policy"] = (
        _entry(None, None, f"In force: {active.name}") if active
        else _entry(1, "critical", "No policy version is in force")
    )

    if role == Role.SUPER_ADMIN:
        from django_q.models import Task

        failed = Task.objects.filter(success=False, started__gte=now - timedelta(days=7)).count()
        out["/jobs"] = _entry(failed, "caution" if failed else None,
                              f"{failed} failed this week" if failed else None)

        report = integrity.last_report()
        stored = backup.stored()
        backup_note = (
            "No backup is stored" if not stored
            else "Newest backup " + timezone.localtime(datetime.fromisoformat(stored[0]["created_at"])).strftime("%d %b")
        )
        if report is None:
            out["/data/health"] = _entry(1, "caution", "Never checked. " + backup_note)
        else:
            errors = int(report.get("problems", {}).get("error", 0))
            bad = errors or (0 if stored else 1)
            out["/data/health"] = _entry(bad, "critical" if bad else None, backup_note)
    return out


@api.get("/admin/hub", auth=session_auth)
def admin_hub(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "The admin pages are for the office.")
    return {"counts": hub_counts(user.role), "checked_at": timezone.now().isoformat()}


__all__ = ["admin_hub", "hub_counts"]
