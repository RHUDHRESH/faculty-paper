"""Background jobs: what ran, what failed, and a retry where one is safe.

GET  /admin/jobs              -> {"queued": [...], "jobs": [...], "failed_count"}
POST /admin/jobs/{id}/retry   -> {"ok": True, "job_id": new id}

Read straight from django-q2's own tables (Task for finished runs, OrmQ for
the queue), so this page and the queue cannot disagree. Only jobs whose
re-run is harmless -- harvests, the Scopus sync, a backup, author
re-matching, citation refresh, badges -- offer a retry. An import or a
restore is never retried from here: the uploaded file may be gone, and a
second run of a restore replaces the database again.
"""
from __future__ import annotations

import json
from typing import Any

from django.http import HttpRequest
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Role

#: func path -> (plain name, safe to retry)
JOB_KINDS: dict[str, tuple[str, bool]] = {
    "core.tasks.harvest_publications": ("Publication harvest (OpenAlex)", True),
    "core.tasks.sync_scopus_authors": ("Scopus author sync", True),
    "core.tasks.run_stored_backup": ("Backup", True),
    "core.tasks.rematch_authors": ("Author re-matching", True),
    "core.tasks.refresh_publication_citations": ("Citation refresh", True),
    "core.tasks.award_badges_and_milestones": ("Badges and milestones", True),
    "core.tasks.check_citations": ("Citation check", True),
    "core.tasks.run_integrity_audit": ("Data health check", True),
    "core.tasks.recover_stale_batches": ("Stalled monthly runs recovery", True),
    "core.tasks.run_erp_import": ("ERP workbook import", False),
    "core.tasks.run_restore": ("Restore from backup", False),
    "core.tasks.run_bulk_verify": ("Bulk verification", False),
    "core.tasks.run_monthly_batch": ("Monthly Scopus run", False),
    "core.tasks.run_claim_file_check": ("Paper file check", False),
    "core.tasks.run_scout": ("Research scout", False),
    "core.tasks.send_weekly_digest": ("Weekly digest email", False),
    "core.tasks.send_nudges": ("Reminder emails", False),
}


def _kind(func: str | None) -> tuple[str, bool]:
    f = func or ""
    if f in JOB_KINDS:
        return JOB_KINDS[f]
    return (f.rsplit(".", 1)[-1].replace("_", " ").capitalize() or "Job", False)


def _result_text(result: Any, success: bool) -> str:
    if result is None:
        return "Finished" if success else "Failed without a message"
    if isinstance(result, dict):
        parts = [f"{k.replace('_', ' ')}: {v}" for k, v in list(result.items())[:6]
                 if isinstance(v, (str, int, float)) and not isinstance(v, bool)][:4]
        return "; ".join(parts) or ("Finished" if success else "Failed")
    text = str(result).strip()
    if not success:
        # A traceback: its last line is the one that says what went wrong.
        lines = [l for l in text.splitlines() if l.strip()]
        text = lines[-1] if lines else text
    return text[:300]


def _require_super(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only the super admin sees the job queue.")
    return user


@api.get("/admin/jobs", auth=session_auth)
def list_jobs(request: HttpRequest, failed: bool = False, limit: int = 50):
    """Recent background jobs, newest first; `failed=true` for failures only."""
    from django_q.models import OrmQ, Task as QTask

    _require_super(request)
    limit = max(1, min(int(limit), 200))
    qs = QTask.objects.all().order_by("-started")
    if failed:
        qs = qs.filter(success=False)
    jobs = []
    for t in qs[:limit]:
        name, safe = _kind(t.func)
        duration = None
        if t.started and t.stopped:
            duration = round((t.stopped - t.started).total_seconds(), 1)
        jobs.append({
            "id": t.id,
            "func": t.func,
            "name": name,
            "started": t.started.isoformat() if t.started else None,
            "stopped": t.stopped.isoformat() if t.stopped else None,
            "duration_s": duration,
            "success": bool(t.success),
            "result": _result_text(t.result, bool(t.success)),
            "attempts": getattr(t, "attempt_count", None),
            "retry_safe": safe,
        })
    queued = []
    for q in OrmQ.objects.all().order_by("lock", "id")[:50]:
        try:
            func = q.func()
            queued.append({"id": q.task_id(), "func": func, "name": _kind(func)[0],
                           "locked": q.lock.isoformat() if q.lock else None})
        except Exception:
            continue
    return {
        "queued": queued,
        "jobs": jobs,
        "failed_count": QTask.objects.filter(success=False).count(),
        "total": QTask.objects.count(),
    }


@api.post("/admin/jobs/{job_id}/retry", auth=session_auth)
def retry_job(request: HttpRequest, job_id: str):
    """Run a finished job again with the same arguments, if that is harmless."""
    from django_q.models import Task as QTask
    from django_q.tasks import async_task

    user = _require_super(request)
    t = QTask.objects.filter(id=job_id).first()
    if t is None:
        raise HttpError(404, "No finished job with that id.")
    name, safe = _kind(t.func)
    if not safe:
        raise HttpError(400, f"{name} is not retried from here; run it again from its own page.")
    new_id = async_task(t.func, *(t.args or ()), **(t.kwargs or {}))
    AuditLog.objects.create(
        actor=user, action="JOB_RETRY", entity="Job", entity_id=str(new_id),
        detail_json=json.dumps({"job": t.func, "retry_of": t.id}),
    )
    return {"ok": True, "job_id": new_id, "name": name}


__all__ = ["list_jobs", "retry_job"]
