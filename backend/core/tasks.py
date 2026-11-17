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
    from core.models import BatchStatus, MonthlyBatch
    from core.services.monthly_processor import process_batch

    process_batch(batch_id)
    batch = MonthlyBatch.objects.select_related("created_by").filter(pk=batch_id).first()
    if batch is not None and batch.status == BatchStatus.DONE:
        tell_import_result(batch.created_by, f"Batch finished: {batch.name}",
                           "Every row has been checked.", f"/batches/{batch.id}")
    elif batch is not None and batch.status == BatchStatus.FAILED:
        tell_import_result(batch.created_by, f"Batch failed: {batch.name}",
                           (batch.error_message or "It stopped part-way.")[:240], f"/batches/{batch.id}")
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

    actor = User.objects.filter(pk=actor_id).first() if actor_id else None
    try:
        call_command("import_erp_excel", saved_path, **options)
    except Exception as exc:
        # The person who uploaded it is waiting on the answer; they poll a job
        # page, and a failure there is easy to miss. The file is kept.
        tell_import_result(
            actor, "The ERP import did not finish",
            f"{exc.__class__.__name__}: {str(exc)[:200]}. The file is kept, so it can be run again.", "/imports",
        )
        raise
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
    tell_import_result(
        actor, "The ERP import is done",
        f"{stats['claims']} claims ({stats['claims_paid']} paid), {stats['paid_ledger']} ledger rows, "
        f"{stats['users']} accounts.", "/imports",
    )
    return {"ok": True, "stats": stats, "sync_tail": synced}


def tell_import_result(actor, title: str, body: str, href: str) -> None:
    """Tell whoever started an import or a batch how it ended. Never raises:
    the import has already run, and an alert that cannot be written is not a
    reason to call it failed."""
    if actor is None:
        return
    try:
        from core.services.notify import notify

        notify(actor, "import_result", title, body, href)
    except Exception:  # noqa: BLE001
        logger.exception("import_result_notice_failed user=%s", getattr(actor, "pk", None))


def run_bulk_verify(claim_ids: list[str], actor_id: str | None = None) -> dict:
    """Scopus verification over a list of claims — each call is 2–4 external
    requests, so a list of any size has no business inside one HTTP request."""
    from core.models import User
    from core.services import user_keys

    actor = User.objects.filter(pk=actor_id).first() if actor_id else None
    done: list[str] = []
    failed: list[dict[str, str]] = []
    # The person who asked for the check spends their own Scopus key, if they brought one.
    with user_keys.acting_as(actor):
        _verify_each(claim_ids, actor, done, failed)
    return {"verified": done, "failed": failed}


def _verify_each(claim_ids, actor, done, failed) -> None:
    from core.api import _verify_claim
    from core.api.common import OWN_PAPER
    from core.models import Claim, ClaimAction
    from core.services import rbac

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


def run_data_fill(actor_id: str | None = None, source: str = "", keys: list[str] | None = None) -> dict:
    """Every safe data fill (core.services.data_fill), as one job: queued after
    a faculty-list or settled-claims import is applied, and once after deploy."""
    from core.models import SystemSetting, User
    from core.services import data_fill

    actor = User.objects.filter(pk=actor_id).first() if actor_id else None
    out = data_fill.run_safe_fills(actor, source, keys)
    if source.startswith("deploy:"):
        SystemSetting.objects.update_or_create(
            key=data_fill.DEPLOY_KEY, defaults={"value": {"run_id": source[7:], "state": "done", "summary": out}}
        )
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


def run_safeguard_check() -> dict:
    """Daily: sweep what has been paid for repeats, then recompute every money
    safeguard from the rows (core.services.safeguards) and keep the report for
    the Safeguards page and the readiness checklist."""
    import io

    from django.core.management import call_command

    from core.services import safeguards

    try:
        call_command("find_duplicate_payments", stdout=io.StringIO())
    except Exception:  # noqa: BLE001 -- the sweep failing must not stop the check
        logger.exception("find_duplicate_payments failed in the daily safeguard check")
    report = safeguards.run_and_store()
    return {"ok": True, "problems": report["problems"], "seconds": report["seconds"]}


def run_stored_backup(kind: str = "auto") -> dict:
    """Weekly, and on demand from the data-health page: a full backup kept in
    the database's own file store (the newest four)."""
    from core.services import backup

    return backup.store_weekly(kind)


def run_offsite_backup(kind: str = "daily") -> dict:
    """Daily: a full backup copied to the object store (R2), the newest 14 kept.
    Does nothing until S3_BUCKET_NAME is set."""
    from core.services import backup

    return backup.store_offsite(kind)


def sync_google_calendars(user_ids: list[str] | None = None) -> dict:
    """Daily (schedule "google-calendar-sync-daily"), and after a calendar edit:
    bring each connected person's Google calendar in line with their page here.
    `user_ids` limits it to the people an edit touched; nothing means everyone."""
    from core.services import google_calendar

    return google_calendar.sync_all(user_ids)


def send_report_schedule(schedule_id: str) -> dict:
    """A scheduled studio report (schedule "report-schedule-<id>"): rendered as
    each recipient and emailed (core.services.report_studio.deliver)."""
    from core.services import report_studio

    return report_studio.deliver(schedule_id)
