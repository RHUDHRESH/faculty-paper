"""finance ledger and monthly batches.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _csv_row, _parse_payout_month, _require_admin_ops, api, rate_limit, session_auth
from core.api.schemas import MonthlyCreateIn
from core.api.deps import _format_payout_month
from core.api.common import require_user

import csv
import io
from typing import Any, Optional
from django.db.models import F, Sum
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import File, Form, UploadedFile
from django.conf import settings
from ninja.errors import HttpError
from core.models import MonthlyBatch, MonthlyRow, PaidLedger
from core.services import rbac
from core.services.monthly_processor import start_batch_async

# ---------- finance ledger ----------


def _ledger_queryset(month: str | None, department: str | None):
    qs = PaidLedger.objects.select_related("claim").order_by("-payout_month", "department", "faculty_name")
    if month:
        parsed = _parse_payout_month(month)
        if parsed:
            qs = qs.filter(payout_month=parsed)
    if department:
        qs = qs.filter(department__iexact=department)
    return qs


def _ledger_row_dict(row: PaidLedger) -> dict[str, Any]:
    return {
        "id": row.id,
        "claim_id": row.claim_id,
        "payout_month": _format_payout_month(row.payout_month),
        "department": row.department,
        "faculty_name": row.faculty_name,
        "staff_id": row.staff_id,
        "biometric_id": row.biometric_id,
        "paper_title": row.paper_title,
        "journal_title": row.journal_title,
        "amount": row.amount,
        "voucher_number": row.voucher_number,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@api.get("/admin/ledger", auth=session_auth)
def admin_ledger(
    request: HttpRequest,
    month: Optional[str] = None,
    department: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = _ledger_queryset(month, department)
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    total = qs.count()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        # The sum of everything the filter matches, not of the page. The screen
        # showed one page's worth beside an Export button that wrote all of
        # them, so the page and the file disagreed about the same filter.
        "total_amount": qs.aggregate(s=Sum("amount"))["s"] or 0,
        "results": [_ledger_row_dict(r) for r in qs[offset : offset + limit]],
    }


@api.get("/admin/ledger/export", auth=session_auth)
def admin_ledger_export(request: HttpRequest, month: Optional[str] = None, department: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    qs = _ledger_queryset(month, department)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "payout_month",
            "department",
            "faculty_name",
            "staff_id",
            "biometric_id",
            "paper_title",
            "journal_title",
            "amount",
            "voucher_number",
            "claim_id",
        ]
    )
    for r in qs:
        w.writerow(
            _csv_row(
                [
                    _format_payout_month(r.payout_month),
                    r.department,
                    r.faculty_name,
                    r.staff_id,
                    r.biometric_id,
                    r.paper_title,
                    r.journal_title,
                    r.amount,
                    r.voucher_number,
                    r.claim_id,
                ]
            )
        )
    resp = HttpResponse(buf.getvalue(), content_type="text/csv")
    suffix = month or "all"
    resp["Content-Disposition"] = f'attachment; filename="ledger-{suffix}.csv"'
    return resp


# ---------- monthly ----------


@api.get("/monthly", auth=session_auth)
def list_batches(request: HttpRequest):
    user = require_user(request)
    _require_admin_ops(user)
    batches = MonthlyBatch.objects.select_related("created_by").order_by("-created_at")[:50]
    return [
        {
            "id": b.id,
            "name": b.name,
            "status": b.status,
            "created_by": b.created_by.email,
            "row_count": b.rows.count(),
            "created_at": b.created_at.isoformat(),
            "error_message": b.error_message,
        }
        for b in batches
    ]


@api.post("/monthly", auth=session_auth)
def create_batch(request: HttpRequest, payload: MonthlyCreateIn):
    user = require_user(request)
    _require_admin_ops(user)
    batch = MonthlyBatch.objects.create(name=payload.name, created_by=user)
    for i, r in enumerate(payload.rows, start=1):
        MonthlyRow.objects.create(
            batch=batch,
            row_number=i,
            author_id_raw=r.get("author_id_raw") or r.get("authorId") or r.get("author_id"),
            paper_title=r.get("paper_title") or r.get("title"),
            index_status=r.get("index_status"),
        )
    return {"id": batch.id, "name": batch.name, "row_count": batch.rows.count()}


@api.post("/monthly/upload", auth=session_auth)
def upload_batch(request: HttpRequest, name: str = Form(...), file: UploadedFile = File(...)):
    user = require_user(request)
    _require_admin_ops(user)
    content = file.read().decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(content))
    batch = MonthlyBatch.objects.create(name=name, created_by=user)
    for i, r in enumerate(reader, start=1):
        MonthlyRow.objects.create(
            batch=batch,
            row_number=i,
            author_id_raw=r.get("author_id") or r.get("authorId") or r.get("Author ID") or r.get("F"),
            paper_title=r.get("title") or r.get("paper_title") or r.get("Title") or r.get("G"),
        )
    return {"id": batch.id, "row_count": batch.rows.count()}


@api.get("/monthly/{batch_id}", auth=session_auth)
def get_batch(request: HttpRequest, batch_id: str):
    user = require_user(request)
    _require_admin_ops(user)
    batch = get_object_or_404(MonthlyBatch, pk=batch_id)
    rows = [
        {
            "id": r.id,
            "row_number": r.row_number,
            "author_id_raw": r.author_id_raw,
            "paper_title": r.paper_title,
            "index_status": r.index_status,
            "linkage": r.linkage,
            "matched_title": r.matched_title,
            "journal": r.journal,
            "aggregation_type": r.aggregation_type,
            "issn": r.issn,
            "cover_date": r.cover_date,
            "eid": r.eid,
            "doi": r.doi,
            "scopus_url": r.scopus_url,
            "sjr_quartile": r.sjr_quartile,
            "subjects": r.subjects,
            "snip": r.snip,
            "engineering_class": r.engineering_class,
        }
        for r in batch.rows.all()
    ]
    return {
        "id": batch.id,
        "name": batch.name,
        "status": batch.status,
        "error_message": batch.error_message,
        "rows": rows,
    }


@api.post("/monthly/{batch_id}/start", auth=session_auth)
def start_batch(request: HttpRequest, batch_id: str):
    user = require_user(request)
    _require_admin_ops(user)
    batch = get_object_or_404(MonthlyBatch, pk=batch_id)
    if batch.status == "RUNNING":
        # A live batch heartbeats every row. No heartbeat for a while means the
        # worker died mid-run — allow a restart instead of stranding it forever.
        from core.tasks import STALE_BATCH_AFTER

        last_beat = batch.heartbeat_at or batch.started_at
        if last_beat and timezone.now() - last_beat < STALE_BATCH_AFTER:
            raise HttpError(400, "Already running")
    job_id = start_batch_async(batch.id)
    return {
        "ok": True,
        "status": "RUNNING",
        "job_id": job_id if isinstance(job_id, (str, int)) else None,
    }


@api.get("/monthly/{batch_id}/export", auth=session_auth)
def export_batch(request: HttpRequest, batch_id: str):
    user = require_user(request)
    _require_admin_ops(user)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    batch = get_object_or_404(MonthlyBatch, pk=batch_id)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(
        [
            "row",
            "author_id",
            "title",
            "index_status",
            "linkage",
            "matched_title",
            "journal",
            "type",
            "issn",
            "cover_date",
            "eid",
            "doi",
            "scopus_url",
            "sjr_quartile",
            "subjects",
            "snip",
            "engineering_class",
        ]
    )
    for r in batch.rows.all():
        w.writerow(
            _csv_row(
                [
                    r.row_number,
                    r.author_id_raw,
                    r.paper_title,
                    r.index_status,
                    r.linkage,
                    r.matched_title,
                    r.journal,
                    r.aggregation_type,
                    r.issn,
                    r.cover_date,
                    r.eid,
                    r.doi,
                    r.scopus_url,
                    r.sjr_quartile,
                    r.subjects,
                    r.snip,
                    r.engineering_class,
                ]
            )
        )
    resp = HttpResponse(buf.getvalue(), content_type="text/csv")
    resp["Content-Disposition"] = f'attachment; filename="monthly-{batch.id}.csv"'
    return resp


__all__ = [
    '_ledger_queryset',
    '_ledger_row_dict',
    'admin_ledger',
    'admin_ledger_export',
    'create_batch',
    'export_batch',
    'get_batch',
    'list_batches',
    'start_batch',
    'upload_batch',
]
