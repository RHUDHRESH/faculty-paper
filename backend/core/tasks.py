"""Background tasks, run by the django-q2 cluster (see Q_CLUSTER in settings).

Everything here used to run either inline in an HTTP request (the ERP import,
bulk verification) or in a bare daemon thread (monthly batches), where a
gunicorn restart stranded work with no retry and no visible failure.
"""
from __future__ import annotations

import logging
from datetime import timedelta

from django.core.management import call_command
from django.utils import timezone

logger = logging.getLogger(__name__)

#: A RUNNING batch whose heartbeat is older than this was killed mid-run.
STALE_BATCH_AFTER = timedelta(minutes=5)


def run_monthly_batch(batch_id: str) -> str:
    from core.services.monthly_processor import process_batch

    process_batch(batch_id)
    return batch_id


def run_erp_import(
    saved_path: str,
    options: dict,
    actor_id: str | None = None,
    sync_users: bool = True,
) -> dict:
    """The ERP workbook import, off the request thread.

    The upload endpoint saves the workbook under MEDIA_ROOT/imports and
    enqueues this; poll /api/admin/jobs/{task_id} for the outcome. The saved
    file is removed on success and kept on failure so the import can be
    retried without re-uploading 40 MB.
    """
    import io
    import json
    import os

    from core.models import (
        AuditLog,
        Claim,
        ClaimStatus,
        FacultyMaster,
        PaidLedger,
        PriorPayment,
        ScimagoJournal,
        SnipSource,
        User,
    )

    call_command("import_erp_excel", saved_path, **options)
    synced = None
    if sync_users:
        out = io.StringIO()
        call_command("sync_faculty_users", stdout=out)
        synced = out.getvalue()[-500:]
    stats = {
        "faculty_master": FacultyMaster.objects.count(),
        "claims": Claim.objects.count(),
        "claims_paid": Claim.objects.filter(status=ClaimStatus.PAID).count(),
        "prior_payments": PriorPayment.objects.count(),
        "paid_ledger": PaidLedger.objects.count(),
        "scimago": ScimagoJournal.objects.count(),
        "snip": SnipSource.objects.count(),
        "users": User.objects.count(),
    }
    actor = User.objects.filter(pk=actor_id).first() if actor_id else None
    AuditLog.objects.create(
        actor=actor,
        action="ERP_XLSX_IMPORT",
        entity="Workbook",
        detail_json=json.dumps({"path": saved_path, "stats": stats, "options": options}),
    )
    try:
        os.unlink(saved_path)
    except OSError:
        pass
    return {"ok": True, "stats": stats, "sync_tail": synced}


def run_bulk_verify(claim_ids: list[str], actor_id: str | None = None) -> dict:
    """Scopus verification over a list of claims — each call is 2–4 external
    requests, so a list of any size has no business inside one HTTP request."""
    from core.api import _verify_claim
    from core.api.common import OWN_PAPER
    from core.models import Claim, ClaimAction, User
    from core.services import rbac

    actor = User.objects.filter(pk=actor_id).first() if actor_id else None
    done: list[str] = []
    failed: list[dict[str, str]] = []
    for cid in claim_ids:
        claim = Claim.objects.filter(pk=cid).first()
        if claim is None:
            failed.append({"id": cid, "reason": "Not found"})
            continue
        if actor is not None and rbac.is_own_claim(actor, claim):
            # The single verify refuses an officer's own paper; so does this.
            failed.append({"id": cid, "reason": OWN_PAPER})
            continue
        try:
            _verify_claim(claim)
            if actor:
                ClaimAction.objects.create(
                    claim=claim,
                    actor=actor,
                    from_status=claim.status,
                    to_status=claim.status,
                    action="VERIFY",
                )
            done.append(cid)
        except Exception as e:  # keep going: one bad claim must not sink the rest
            logger.exception("bulk_verify_failed id=%s", cid)
            failed.append({"id": cid, "reason": str(e)[:200]})
    return {"verified": done, "failed": failed}


def run_claim_file_check(claim_id: str, force: bool = True) -> dict:
    """Read a claim's PDFs and compare them with the claim.

    Queued when a paper is filed and when a reviewer asks for it: a 10 MB
    publisher PDF takes seconds to parse, which a filing request should not
    wait on. See core.services.content_check.
    """
    from core.services.content_check import check_claim_files

    checks, raised = check_claim_files(claim_id, force=force)
    return {"claim": claim_id, "checked": len(checks), "flags_raised": raised}


def recover_stale_batches() -> list[str]:
    """Re-enqueue RUNNING batches whose heartbeat went stale.

    Scheduled every 5 minutes (data migration 0014). process_batch skips rows
    that are already resolved, so a resume is idempotent.
    """
    from django.db.models import Q
    from django_q.tasks import async_task

    from core.models import BatchStatus, MonthlyBatch

    cutoff = timezone.now() - STALE_BATCH_AFTER
    stale = MonthlyBatch.objects.filter(status=BatchStatus.RUNNING).filter(
        Q(heartbeat_at__lt=cutoff) | Q(heartbeat_at__isnull=True, started_at__lt=cutoff)
    )
    recovered = []
    for batch in stale:
        logger.warning("recovering stale batch id=%s name=%s", batch.id, batch.name)
        async_task("core.tasks.run_monthly_batch", batch.id)
        recovered.append(batch.id)
    return recovered


def award_badges_and_milestones() -> dict:
    """Hourly (migration 0047): every badge earned and not yet written, and
    every department target that has crossed 50, 75 or 100 per cent. Safe to
    run any number of times -- see core.services.achievements."""
    from core.services.achievements import run_all

    return run_all()


def check_citations() -> dict:
    """Daily (schedule "citation-check", migration 0051): citation counts for
    claimed DOIs from OpenAlex, and alerts to owners whose count rose."""
    from core.services.citations import check_citations as run

    return run()


def harvest_publications(since: int | None = None, limit: int | None = None, expand: bool = True) -> dict:
    """Queued by POST /api/admin/publications/harvest: the OpenAlex harvest,
    record linking, author matching and metrics (core.services.publications)."""
    from core.models import AuditLog
    from core.services.publications import run_harvest

    import json

    summary = run_harvest(since=since, limit=limit, expand=expand)
    AuditLog.objects.create(action="PUBLICATION_HARVEST_DONE", entity="Publication",
                            detail_json=json.dumps(summary, default=str))
    return summary


def sync_scopus_authors(limit: int | None = None) -> dict:
    """Queued by POST /api/admin/publications/scopus-sync: each member's
    Scopus papers (AU-ID search) into the publication record, then a re-match.
    Resumable: stops at the quota, oldest-synced people first next time."""
    import json

    from core.models import AuditLog
    from core.services import publications
    from core.services.scopus_sync import sync_scopus_authors as run

    summary = run(limit=limit)
    summary.pop("per_user", None)
    summary["match"] = {k: v for k, v in publications.match_authors().items() if k != "ambiguous"}
    publications.refresh_metrics()
    AuditLog.objects.create(action="SCOPUS_SYNC_DONE", entity="Publication",
                            detail_json=json.dumps(summary, default=str))
    return summary


def refresh_publication_citations() -> dict:
    """Weekly (schedule "publication-citations", migration 0052): citation
    counts for every harvested paper, then everybody's h-index again."""
    from core.services.publications import refresh_citations

    return refresh_citations()


def rematch_authors(actor_id: str | None = None) -> dict:
    """Queued by POST /api/admin/author-matches/rerun: link records, match
    authors (applying the office's aliases) and refresh metrics."""
    import json

    from core.models import AuditLog
    from core.services import publications

    linked = publications.link_records()
    out = publications.match_authors()
    out["ambiguous"] = len(out.pop("ambiguous"))
    out["linked"] = linked
    out["people_with_metrics"] = publications.refresh_metrics()
    AuditLog.objects.create(actor_id=actor_id, action="AUTHOR_MATCH_DONE", entity="Publication",
                            detail_json=json.dumps(out, default=str))
    return out


def send_weekly_digest() -> dict:
    """Monday 8am IST (schedule "weekly-digest"): the weekly summary."""
    from core.services.digest import send_weekly_digest as run

    return run()


def flush_held_emails() -> dict:
    """Hourly (schedule "email-batch"): one email carrying what the hourly limit held back."""
    from core.services.notify import flush_held_emails as run

    return run()


def send_nudges() -> dict:
    """Daily (schedule "daily-nudges"): filing-deadline and quota nudges."""
    from core.services.nudges import send_nudges as run

    return run()


def run_restore(saved_path: str, actor_id: str | None = None) -> dict:
    """Load an export into this (fresh) installation, or carry on with one.

    Queued by POST /api/admin/restore. Streamed and resumable
    (core/services/restore.py): the place reached is saved after every batch,
    and a job that nears the time limit queues itself again. The file is
    removed on success and kept on failure so it can be continued.
    """
    from core.services import restore

    return restore.execute(saved_path, actor_id)

def run_scout(run_id: str) -> str:
    from core.services.scout import execute

    return execute(run_id)


def run_integrity_audit() -> dict:
    """Nightly: the data-health audit, kept for GET /api/admin/data-health."""
    from core.services import integrity

    report = integrity.run_and_store()
    return {"ok": True, "problems": report["problems"], "seconds": report["seconds"]}


def run_stored_backup(kind: str = "auto") -> dict:
    """Weekly, and on demand from the data-health page: a full backup kept in
    the database's own file store (the newest four)."""
    from core.services import backup

    return backup.store_weekly(kind)
