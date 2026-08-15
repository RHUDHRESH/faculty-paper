from __future__ import annotations

import json
import logging
import time
from datetime import datetime

from django.db import transaction
from django.utils import timezone

from core.models import BatchStatus, MonthlyBatch, MonthlyRow
from core.services import scopus
from core.services.scimago import engineering_class, lookup_scimago, sjr_quartile_label
from core.services.scopus import ScopusError, extract_author_id

logger = logging.getLogger(__name__)

SLEEP_AFTER_TITLE = 1.5
SLEEP_BEFORE_LINK = 0.5
SLEEP_BETWEEN_ROWS = 1.0
SLEEP_ON_ERROR = 5.0


def process_batch(batch_id: str) -> None:
    try:
        batch = MonthlyBatch.objects.get(pk=batch_id)
    except MonthlyBatch.DoesNotExist:
        return

    batch.status = BatchStatus.RUNNING
    batch.started_at = batch.started_at or timezone.now()
    batch.heartbeat_at = timezone.now()
    batch.error_message = None
    batch.save(update_fields=["status", "started_at", "heartbeat_at", "error_message", "updated_at"])

    try:
        rows = list(batch.rows.order_by("row_number"))
        for row in rows:
            # Resumable: a restart re-enqueues the batch and rows that already
            # resolved are skipped, so only the interrupted tail is re-fetched.
            if row.index_status and row.index_status != "Checking...":
                continue
            _process_row(row)
            batch.heartbeat_at = timezone.now()
            batch.save(update_fields=["heartbeat_at", "updated_at"])
            time.sleep(SLEEP_BETWEEN_ROWS)
        batch.status = BatchStatus.DONE
        batch.finished_at = timezone.now()
        batch.save(update_fields=["status", "finished_at", "updated_at"])
    except Exception as e:
        logger.exception("Batch %s failed", batch_id)
        batch.status = BatchStatus.FAILED
        batch.error_message = str(e)
        batch.finished_at = timezone.now()
        batch.save(update_fields=["status", "error_message", "finished_at", "updated_at"])


def start_batch_async(batch_id: str) -> None:
    """Enqueue on the django-q2 cluster.

    This used to be a bare daemon thread inside a gunicorn worker: a deploy or
    an idle spin-down killed it silently and the batch sat in RUNNING forever.
    The queue survives restarts, and recover_stale_batches re-enqueues any
    batch whose heartbeat went quiet.
    """
    from django_q.tasks import async_task

    async_task("core.tasks.run_monthly_batch", batch_id)


def _process_row(row: MonthlyRow) -> None:
    title = (row.paper_title or "").strip()
    if not title or row.index_status == "Indexed":
        return

    author_raw = row.author_id_raw
    if not author_raw or not str(author_raw).strip():
        row.index_status = "Error: Missing Author ID in Col F"
        row.save(update_fields=["index_status", "updated_at"])
        return

    author_id = extract_author_id(str(author_raw))
    if not author_id or not author_id.strip():
        row.index_status = "Error: Unresolvable Author ID string"
        row.save(update_fields=["index_status", "updated_at"])
        return

    row.index_status = "Checking..."
    row.save(update_fields=["index_status", "updated_at"])

    try:
        paper, raw = scopus.search_by_title(title)
        time.sleep(SLEEP_AFTER_TITLE)

        if paper is None:
            row.index_status = "Not yet indexed"
            row.linkage = "Not yet indexed"
            row.matched_title = "-"
            row.journal = "-"
            row.aggregation_type = "-"
            row.issn = "-"
            row.cover_date = "-"
            row.eid = "-"
            row.doi = "-"
            row.scopus_url = "-"
            row.sjr_quartile = "Not Found"
            row.subjects = "N/A"
            row.snip = "N/A"
            row.engineering_class = "Pending"
            row.raw_json = json.dumps(raw)[:200000]
            row.save()
            return

        row.index_status = "Indexed"
        time.sleep(SLEEP_BEFORE_LINK)
        linked, link_raw = scopus.check_author_linkage(author_id, title)
        row.linkage = "Linked" if linked else "Not Linked"

        row.matched_title = paper.get("title") or ""
        row.journal = paper.get("journal_title") or "N/A"
        row.aggregation_type = paper.get("aggregation_type") or "N/A"
        row.issn = paper.get("issn") or "N/A"
        row.cover_date = paper.get("cover_date") or "N/A"
        row.eid = paper.get("eid") or "N/A"
        row.doi = paper.get("doi") or "N/A"
        row.scopus_url = paper.get("scopus_url") or "N/A"

        # SNIP via serial API
        snip_val = "N/A"
        subjects = "N/A"
        quartile = "Not Found"
        if row.issn and row.issn != "N/A":
            try:
                serial = scopus.lookup_serial_by_issn(row.issn)
                if serial and serial.get("snip") is not None:
                    snip_val = str(serial["snip"])
            except ScopusError:
                pass
            scimago = lookup_scimago(issn=row.issn)
            if scimago:
                quartile = sjr_quartile_label(scimago)
                cats = scimago.get("categories") or []
                subjects = "; ".join(
                    f"{c.get('category')} ({c.get('quartile')})" if c.get("quartile") else c.get("category", "")
                    for c in cats
                ) or "N/A"

        row.sjr_quartile = quartile
        row.subjects = subjects
        row.snip = snip_val
        row.engineering_class = engineering_class(row.aggregation_type, subjects)
        row.raw_json = json.dumps({"paper": paper.get("raw"), "link": link_raw})[:200000]
        row.save()

    except ScopusError as e:
        row.index_status = f"Error: {e}"
        row.save(update_fields=["index_status", "updated_at"])
        time.sleep(SLEEP_ON_ERROR)
    except Exception as e:
        row.index_status = f"Error: {e}"
        row.save(update_fields=["index_status", "updated_at"])
        time.sleep(SLEEP_ON_ERROR)
