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
    from core.models import Claim, ClaimAction, User

    actor = User.objects.filter(pk=actor_id).first() if actor_id else None
    done: list[str] = []
    failed: list[dict[str, str]] = []
    for cid in claim_ids:
        claim = Claim.objects.filter(pk=cid).first()
        if claim is None:
            failed.append({"id": cid, "reason": "Not found"})
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
