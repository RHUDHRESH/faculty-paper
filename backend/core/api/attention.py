"""The super admin's one health answer: what needs attention, and why.

GET /admin/attention -> {"checked_at", "items": [...], "ok": [...]}
GET /admin/readiness -> the readiness checklist, each check with its fix page
GET /admin/data-fixes -> old-ERP claims that need a person to fix them

Each attention item names the job it belongs to (people, data, money,
running), how urgent it is, a sentence of why it matters, where to fix it, what
the button there is called (`action`) and, where it counts things, the real
number (`count`, never capped). Everything here is read from sources that
already exist (faults, data health, backups, author matches, profile requests,
duplicates, the live policy, the readiness checks), so the Home list and the
pages behind it cannot disagree.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from django.http import HttpRequest
from django.utils import timezone
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import DuplicateFinding, FormulaConfig, ProfileChangeRequest, Role
from core.services import claim_fixes, data_fixes, legacy, rbac, readiness

#: A backup older than this is reported; the scheduled one runs daily.
BACKUP_STALE_DAYS = readiness.BACKUP_MAX_DAYS
#: A data-health report older than this is reported as not recent.
HEALTH_STALE_DAYS = 7

_ORDER = {"critical": 0, "warning": 1, "info": 2}

#: For a fault that has a better home than the faults page: (title, why, to, action).
#: The faults page names each in its own words; here the sentence says who is
#: waiting and the button goes to the page where the admin can move it.
_FAULT_VIEW: dict[str, tuple[str, str, str, str]] = {
    "stale_submitted": (
        "Claims waiting to be cleared for over 14 days",
        "Nobody at the research office has touched them since they were filed. Each claimant is waiting.",
        "/clearing", "Open claims",
    ),
    "stale_cleared": (
        "Claims waiting for the Principal for over 14 days",
        "The research office cleared them, and the Principal has not approved them yet.",
        "/track?stage=checked", "See on Track",
    ),
    "no_quartile": (
        "Claims in review with no quartile",
        "The quartile is worth up to ₹50,000 of the amount and has to be set before a claim is cleared.",
        "/clearing", "Open claims",
    ),
}


#: What a fault counts, so the number carries its unit on screen.
_FAULT_UNIT = {
    "no_scopus": "people", "no_biometric": "people", "no_department": "people",
    "former_staff": "people", "stale_submitted": "claims", "stale_cleared": "claims",
    "legacy_status": "claims", "old_drafts": "drafts", "unverified": "claims",
    "no_quartile": "claims", "no_snip": "claims", "duplicate_override": "claims",
    "paid_zero": "claims", "self_cleared": "claims", "no_ledger": "claims", "voided": "claims",
}


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
    from core.services import author_review, integrity

    items: list[dict[str, Any]] = []
    ok: list[str] = []

    def add(key, job, severity, title, why, to, count=None, action="Open", unit=None, legacy=0):
        items.append({
            "key": key, "job": job, "severity": severity, "title": title,
            "why": why, "to": to, "count": count, "action": action, "unit": unit,
            "legacy": legacy,
        })

    # ---- keep money right ----
    if not FormulaConfig.objects.filter(active=True).exists():
        add("no_policy", "money", "critical", "No active policy version",
            "Every claim is priced from built-in defaults. Publish a version so the rates are on record.",
            "/policy", action="Publish a policy")
    else:
        ok.append("A policy version is active")
    # Only findings with a payment made through this app are today's work; the
    # old-ERP ones are counted apart (`legacy`) and still listed on the page.
    dup, dup_old = legacy.open_duplicates_split()
    if dup:
        add("duplicates", "money", "warning", "Possible duplicate payments" if dup != 1 else "A possible duplicate payment",
            "One person may have been paid twice for the same paper. Confirm or dismiss each one.",
            "/duplicates", dup, "Review them", "payments", legacy=dup_old)
    else:
        ok.append("No unreviewed duplicate payments"
                  + (f" ({dup_old:,} from before this system)" if dup_old else ""))

    # ---- faults (data gaps, stalled work, money that does not add up) ----
    faults = _faults_now()
    for g in faults["groups"]:
        for f in g["faults"]:
            if f["actionable"] and f["severity"] in ("critical", "warning"):
                view = _FAULT_VIEW.get(f["key"])
                title, why, to, action = view or (f["title"], f["detail"], "/faults", "Open faults")
                add(f"fault_{f['key']}", "running" if g["key"] != "data" else "people",
                    f["severity"], title, why, to, f["actionable"], action, _FAULT_UNIT.get(f["key"], "records"),
                    legacy=f["legacy"])
    if not faults["urgent_actionable"]:
        ok.append("No urgent faults")

    # ---- keep data right ----
    report = integrity.last_report()
    if report is None:
        add("health_never", "data", "warning", "The data-health check has never run",
            "Nobody has checked for broken links, duplicate IDs or missing files. Run it once.",
            "/data/health", action="Run the check")
    else:
        errors = int(report.get("problems", {}).get("error", 0))
        age = _age_days(report.get("ran_at"))
        if errors:
            add("health_errors", "data", "critical", "Data-health errors" if errors != 1 else "A data-health error",
                "The last check found records that are broken, not just untidy. Each has a fix or a list.",
                "/data/health", errors, "Open data health", "errors")
        if age is not None and age > HEALTH_STALE_DAYS:
            add("health_stale", "data", "info", f"Data health last checked {int(age)} days ago",
                "An older report can miss problems added since. Run it again.", "/data/health",
                action="Run the check")
        if not errors and (age is None or age <= HEALTH_STALE_DAYS):
            ok.append("Data health checked recently, no errors")
    try:
        found = author_review.unmatched_groups(status="open", limit=1)
        matches, likely = int(found["total"]), int(found["counts"].get("open_suggested", 0))
    except Exception:  # a broken matcher must not take the health page down
        matches = likely = 0
    if matches:
        add("author_matches", "data", "warning", "College author names nobody has matched",
            f"Papers under these names are not credited to anyone. {likely:,} "
            f"{'has' if likely == 1 else 'have'} a likely match on the roster; the rest match nobody "
            "and can be set aside in one step.",
            "/people/matches", matches, "Match names", "names")
    else:
        ok.append("Every college author name is matched")
    fixes = data_fixes.total()
    if fixes:
        add("data_fixes", "data", "warning", "Old ERP claims with a missing amount, title or quartile",
            "These came in from the old ERP with a hole in them. Each needs a person to fill it.",
            "/data/fixes", fixes, "Fix them", "claims")
    else:
        ok.append("No old ERP claims need fixing")

    # ---- keep people right ----
    pending = ProfileChangeRequest.objects.filter(status=ProfileChangeRequest.State.PENDING).count()
    if pending:
        add("requests", "people", "warning", "Profile corrections waiting",
            "Staff IDs, names and Scopus links a person cannot change themselves. They wait on you.",
            "/requests", pending, "Decide them", "requests")
    else:
        ok.append("No profile corrections waiting")

    # ---- keep it running: the readiness checks that are not already above ----
    checks = readiness.checks()
    for c in checks:
        if c["key"] in ("policy",):
            continue  # said above, with its own words
        if c["key"] == "backup":
            if c["ok"]:
                ok.append("A backup was taken in the last two days")
            else:
                stored_none = c["detail"].startswith("No backup")
                add("backup_none" if stored_none else "backup_stale", "running",
                    "critical" if stored_none else "warning",
                    "No backup is stored" if stored_none else c["detail"].replace("The newest", "Newest").rstrip("."),
                    "If the database is lost there is nothing to restore from. Take one now." if stored_none
                    else "The daily backup has not run. Everything since then would be lost in a restore.",
                    c["to"], action=c["fix"])
            continue
        if c["ok"]:
            if c["key"].startswith("desk_"):
                continue
            ok.append(c["label"][0].lower() + c["label"][1:])
            continue
        add(f"ready_{c['key']}", "running", c["severity"], c["label"].replace(" has someone", " has nobody")
            if c["key"].startswith("desk_") else _not_ready_title(c["key"]),
            c["detail"], c["to"], action=c["fix"])
    if all(c["ok"] for c in checks if c["key"].startswith("desk_")):
        ok.append("Every desk has a person")

    items.sort(key=lambda x: _ORDER.get(x["severity"], 3))
    return {"checked_at": timezone.now().isoformat(), "items": items, "ok": ok}


def _not_ready_title(key: str) -> str:
    return {
        "email": "Email is not set up",
        "worker": "The background worker looks stopped",
        "scopus": "The Scopus key is not set",
    }.get(key, key)


def _require_super(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin sees the system's health")
    return user


@api.get("/admin/attention", auth=session_auth)
def admin_attention(request: HttpRequest):
    _require_super(request)
    return attention_items()


@api.get("/admin/readiness", auth=session_auth)
def admin_readiness(request: HttpRequest):
    """Six yes/no checks that the system can do its job, each with its fix page."""
    _require_super(request)
    return readiness.summary()


@api.get("/admin/data-fixes", auth=session_auth)
def admin_data_fixes(
    request: HttpRequest,
    kind: Optional[str] = None,
    stage: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """Claims imported from the old ERP that need a person: the counts per kind,
    and the rows (one per claim, with every problem it has). The office may read
    it; a fix form is the fix page's job.

    `stage` (review or paid) narrows to claims still in review or already paid.
    Each row carries, besides what Home and Track read, what the fix page needs:
    the amount now, the ledger, a payment already in the ledger that names the
    paper, and what the policy would pay (see `core.services.claim_fixes`)."""
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "The data-fix queue is for the office.")
    if kind and kind not in {k for k, _l, _w in data_fixes.KINDS}:
        raise HttpError(400, "Unknown kind of fix.")
    if stage and stage not in ("review", "paid"):
        raise HttpError(400, "stage must be review or paid")
    limit = max(1, min(int(limit), 200))
    return {
        "queues": data_fixes.counts(),
        "claims_needing_a_fix": data_fixes.total(),
        **claim_fixes.queue(kind or None, stage or None, limit=limit, offset=max(0, int(offset))),
    }
