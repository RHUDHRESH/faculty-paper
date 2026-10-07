"""Is the system ready to do its job? Six read-only yes/no checks.

Shown as a checklist on the Admin page and folded into Home's "needs
attention" list. Every check is answered from something that already exists (the
user table, the policy table, the stored backups, the mail settings, the job
queue's own history, the Scopus key), and every failing check names the page
where it is fixed. Nothing here writes.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from django.conf import settings
from django.db.models import Max
from django.utils import timezone

from core.models import FormulaConfig, Role, StoredFile, User

#: A backup older than this is reported; the scheduled one runs weekly and
#: the data-health page can take one on demand.
BACKUP_MAX_DAYS = 2
#: The job queue runs something every few minutes; silence for this long
#: means nobody is working the queue.
WORKER_SILENT_MINUTES = 30

#: (key, what the desk is called, roles that can hold it). The clearing desk is
#: held by the super admin, the coordinator or the old research cell role;
#: the other three each have one role.
DESKS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("clearing", "Research office", (Role.SUPER_ADMIN, Role.RESEARCH_COORDINATOR, Role.RESEARCH_CELL)),
    ("principal", "Principal", (Role.PRINCIPAL,)),
    ("director", "Director", (Role.DIRECTOR,)),
    ("finance", "Finance", (Role.FINANCE,)),
)

_ROLE_FOR_LINK = {"clearing": Role.RESEARCH_COORDINATOR, "principal": Role.PRINCIPAL,
                  "director": Role.DIRECTOR, "finance": Role.FINANCE}


def _check(key: str, label: str, ok: bool, detail: str, to: str, fix: str, severity: str = "warning") -> dict[str, Any]:
    return {"key": key, "label": label, "ok": ok, "detail": detail, "to": to, "fix": fix, "severity": severity}


def _age_days(when) -> float | None:
    return None if when is None else (timezone.now() - when).total_seconds() / 86400


def _desk_checks() -> list[dict[str, Any]]:
    out = []
    for key, name, roles in DESKS:
        people = list(User.objects.filter(active=True, role__in=roles).order_by("name").values_list("name", flat=True)[:3])
        n = User.objects.filter(active=True, role__in=roles).count()
        link = f"/people?role={_ROLE_FOR_LINK[key]}"
        if n:
            shown = ", ".join(people) + (f" and {n - len(people)} more" if n > len(people) else "")
            out.append(_check(f"desk_{key}", f"{name} desk has someone", True, shown, link, "See who"))
        else:
            out.append(_check(
                f"desk_{key}", f"{name} desk has someone", False,
                f"Nobody holds the {name} role. Claims reaching this step wait, "
                "and only a super admin can stand in.",
                link, f"Give the {name} role to someone",
            ))
    return out


def _policy_check() -> dict[str, Any]:
    active = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    if active:
        return _check("policy", "A policy is in force", True, f"{active.name} is in force.", "/policy", "See the policy")
    return _check("policy", "A policy is in force", False,
                  "Claims are priced from built-in rates. Publish a policy version.",
                  "/policy", "Publish a policy", "critical")


def _backup_check() -> dict[str, Any]:
    from core.services.backup import BACKUP_PREFIX

    newest = (
        StoredFile.objects.filter(name__startswith=BACKUP_PREFIX)
        .order_by("-created_at").values_list("created_at", flat=True).first()
    )
    if newest is None:
        return _check("backup", "A backup was taken in the last 2 days", False,
                      "No backup is stored. Take one now.", "/data/health", "Take a backup", "critical")
    age = _age_days(newest) or 0
    if age > BACKUP_MAX_DAYS:
        return _check("backup", "A backup was taken in the last 2 days", False,
                      f"The newest backup is {int(age)} days old.", "/data/health", "Take a backup")
    when = timezone.localtime(newest).strftime("%d %b")
    return _check("backup", "A backup was taken in the last 2 days", True, f"Newest backup {when}.",
                  "/data/health", "See backups")


def _safeguards_check() -> dict[str, Any]:
    """Did the money safeguards hold on the last daily check, and did it run?"""
    from core.services import safeguards

    label = "The money safeguards held on the last check"
    report = safeguards.last_report()
    if report is None:
        return _check("safeguards", label, False,
                      "The daily check has not run yet. Run it now to see whether any payment was doubled.",
                      "/safeguards", "Run the check")
    ran = report.get("ran_at")
    age = None
    if ran:
        from datetime import datetime

        try:
            age = _age_days(datetime.fromisoformat(ran))
        except ValueError:
            age = None
    errors = report["problems"]["error"]
    if errors:
        return _check("safeguards", label, False,
                      f"{errors} {'check' if errors == 1 else 'checks'} found a problem with payments or claims.",
                      "/safeguards", "See what failed", "critical")
    if age is not None and age > 2:
        return _check("safeguards", label, False, f"The daily check last ran {int(age)} days ago.",
                      "/safeguards", "Run the check")
    return _check("safeguards", label, True, "Every money check passed.", "/safeguards", "See the checks")


def _email_check() -> dict[str, Any]:
    from core.services.notify import smtp_status

    status = smtp_status()
    return _check(
        "email", "Email is set up", bool(status["configured"]),
        status["line"], "/settings/notifications", "Open email settings", "info",
    )


def _worker_check() -> dict[str, Any]:
    from django_q.models import Task

    if getattr(settings, "Q_CLUSTER", {}).get("sync"):
        return _check("worker", "The background worker is running", True,
                      "Jobs run inside the web server.", "/jobs", "See jobs")
    last = Task.objects.aggregate(t=Max("stopped"))["t"]
    if last is None:
        return _check("worker", "The background worker is running", False,
                      "No job has ever finished. The worker may not be running.", "/jobs", "See jobs")
    minutes = (timezone.now() - last).total_seconds() / 60
    if minutes > WORKER_SILENT_MINUTES:
        ago = f"{int(minutes)} minutes" if minutes < 120 else f"{int(minutes // 60)} hours"
        return _check("worker", "The background worker is running", False,
                      f"The last job finished {ago} ago. The worker looks stopped.", "/jobs", "See jobs")
    return _check("worker", "The background worker is running", True,
                  f"A job finished {max(1, int(minutes))} minutes ago.", "/jobs", "See jobs")


def _scopus_check() -> dict[str, Any]:
    ok = bool(getattr(settings, "SCOPUS_API_KEY", "") or "")
    return _check(
        "scopus", "The Scopus key is set", ok,
        "Scopus lookups and the monthly run can use it." if ok
        else "Without a Scopus key the monthly run cannot fetch quartiles or SNIP. Set SCOPUS_API_KEY on the server.",
        "/reference", "Open reference data",
    )


def checks() -> list[dict[str, Any]]:
    """Every check, desks first, then the system's own."""
    return [
        *_desk_checks(),
        _policy_check(),
        _backup_check(),
        _safeguards_check(),
        _email_check(),
        _worker_check(),
        _scopus_check(),
    ]


def summary() -> dict[str, Any]:
    items = checks()
    return {
        "checked_at": timezone.now().isoformat(),
        "ok": sum(1 for i in items if i["ok"]),
        "total": len(items),
        "items": items,
    }
