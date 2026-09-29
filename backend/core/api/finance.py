"""finance ledger and monthly batches.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.services.cell_safe import csv_writer
from core.api.common import _csv_row, _parse_payout_month, _require_admin_ops, api, rate_limit, session_auth
from core.api.schemas import MonthlyCreateIn
from core.api.deps import _format_payout_month
from core.api.common import require_user

import csv
import io
import re
from typing import Any, Optional
from django.db.models import Case, Count, F, Q, Sum, When
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import File, Form, UploadedFile
from django.conf import settings
from ninja.errors import HttpError
from core.models import DuplicateFinding, MonthlyBatch, MonthlyRow, PaidLedger, User
from core.services.record_dates import ledger_month_recorded
from core.social import photo_url
from core.services import rbac
from core import visibility
from core.services.monthly_processor import start_batch_async
from core.services.remuneration import Category

# ---------- finance ledger ----------


#: Which scheme a payment was made under. The ledger holds both, and the
#: final-year project scheme is budgeted apart from faculty remuneration.
SCHEME_FYP = "FYP"
SCHEME_FACULTY = "FACULTY"


#: Spellings the ERP sheet used for one department, beyond case and spaces.
_DEPT_SAME = {"S&H-CHEMISTRY": "S&H-CHY", "S&H-PHYSICS": "S&H-PHY", "E&I": "EIE"}


def ledger_department(name: str | None) -> str | None:
    """One name per department: "S&H - Maths", "AI & ML" and "Civil" were
    rolled up apart from "S&H-MATHS", "AI&ML" and "CIVIL" on the real ledger."""
    if not name or not name.strip() or name.strip().lower() == "not found":
        return None
    key = re.sub(r"\s+", "", name).upper()
    return _DEPT_SAME.get(key, key)


def _ledger_queryset(
    month: str | None, department: str | None, scheme: str | None = None, q: str | None = None
):
    # Newest first, but the ERP's ₹0 quota rows (stamped with the import
    # month, no voucher) last: on the real ledger they filled page one.
    qs = PaidLedger.objects.select_related("claim").order_by(
        Case(When(amount=0, then=1), default=0), "-payout_month", "department", "faculty_name"
    )
    for word in (q or "").split()[:6]:
        # Every word must match somewhere: a name, a staff id, a voucher.
        qs = qs.filter(
            Q(faculty_name__icontains=word)
            | Q(staff_id__icontains=word)
            | Q(biometric_id__icontains=word)
            | Q(paper_title__icontains=word)
            | Q(journal_title__icontains=word)
            | Q(voucher_number__icontains=word)
            | Q(department__icontains=word)
        )
    if month:
        parsed = _parse_payout_month(month)
        if parsed:
            qs = qs.filter(payout_month=parsed)
    if department:
        want = ledger_department(department)
        spellings = [
            d for d in PaidLedger.objects.values_list("department", flat=True).distinct()
            if d and ledger_department(d) == want
        ]
        qs = qs.filter(department__in=spellings) if spellings else qs.filter(department__iexact=department)
    fyp = Q(claim__remuneration_category=Category.STUDENT_PROJECT)
    if (scheme or "").upper() == SCHEME_FYP:
        qs = qs.filter(fyp)
    elif (scheme or "").upper() == SCHEME_FACULTY:
        qs = qs.exclude(fyp)
    return qs


def _scheme_of(row: PaidLedger) -> str:
    """Read off the claim the payment was for. A row with no claim is
    imported history from before the final-year scheme existed here."""
    if row.claim_id and row.claim.remuneration_category == Category.STUDENT_PROJECT:
        return SCHEME_FYP
    return SCHEME_FACULTY


def _title_key(title: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())[:200]


def _duplicate_keys() -> set[str]:
    """Titles on the same-person duplicates list nobody has dismissed. They
    are reviewed on /duplicates; the ledger only marks the rows."""
    return {
        _title_key(t)
        for t in DuplicateFinding.objects.filter(kind="SAME_PERSON")
        .exclude(status="DISMISSED")
        .values_list("paper_title", flat=True)
        if t
    }


def _ledger_markers(row: PaidLedger, dup_keys: set[str]) -> list[str]:
    out: list[str] = []
    if (row.amount or 0) < 0:
        out.append("REVERSAL")
    if not ledger_month_recorded(row.raw_json):
        out.append("MONTH_NOT_RECORDED")
    if dup_keys and _title_key(row.paper_title) in dup_keys:
        out.append("DUPLICATE")
    return out


def _ledger_row_dict(
    row: PaidLedger,
    dup_keys: set[str] | None = None,
    photos: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    return {
        "photo_url": (photos or {}).get((row.staff_id or "").strip()),
        "markers": _ledger_markers(row, dup_keys or set()),
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
        "scheme": _scheme_of(row),
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


@api.get("/admin/ledger", auth=session_auth)
def admin_ledger(
    request: HttpRequest,
    month: Optional[str] = None,
    department: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    scheme: Optional[str] = None,
    q: Optional[str] = None,
):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = _ledger_queryset(month, department, scheme, q)
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    total = qs.count()
    page = list(qs[offset : offset + limit])
    staff_ids = {(r.staff_id or "").strip() for r in page} - {""}
    photos = {
        u.staff_id: photo_url(u)
        for u in User.objects.filter(staff_id__in=staff_ids).only("staff_id", "photo")
    }
    # A duplicate finding is a flag, and the Director and Finance are never
    # shown flags (core.visibility): no marker, no count of open findings.
    blind = visibility.is_contest_blind(user.role)
    dup_keys = set() if blind else _duplicate_keys()
    # The month chart ignores the month filter, so choosing a month lights
    # its bar instead of collapsing the chart to a single bar.
    # A row whose month is only the import's default is not charted in that
    # month; it is counted apart, so the bar is not inflated by a guess.
    months: dict[Any, list[float]] = {}
    no_month = [0.0, 0]
    for pm, raw, amt in (
        _ledger_queryset(None, department, scheme, q).order_by().values_list("payout_month", "raw_json", "amount")
    ):
        if ledger_month_recorded(raw):
            m = months.setdefault(pm, [0.0, 0])
            m[0] += amt or 0
            m[1] += 1
        else:
            no_month[0] += amt or 0
            no_month[1] += 1
    by_month = [{"payout_month": k, "s": v[0], "n": v[1]} for k, v in sorted(months.items())]
    merged: dict[Any, dict[str, Any]] = {}
    for d in qs.order_by().values("department").annotate(s=Sum("amount"), n=Count("id")):
        m = merged.setdefault(ledger_department(d["department"]), {"department": None, "s": 0.0, "n": 0, "top": 0})
        m["s"] += d["s"] or 0
        m["n"] += d["n"]
        # Shown under its most-used spelling ("CSE - IoT", not the key).
        if ledger_department(d["department"]) and d["n"] > m["top"]:
            m["department"], m["top"] = d["department"], d["n"]
    by_dept = sorted(merged.values(), key=lambda d: -d["s"])
    return {
        "by_month": [
            {"month": _format_payout_month(m["payout_month"]), "amount": round(m["s"] or 0, 2), "count": m["n"]}
            for m in by_month
        ],
        "no_month": {"amount": round(no_month[0], 2), "count": no_month[1]},
        "by_department": [
            {"department": d["department"] or None, "amount": round(d["s"] or 0, 2), "count": d["n"]}
            for d in by_dept
        ],
        # Payments and people the way Reports, the statement and the bank file
        # count them: a ₹0 quota row is settled but pays nobody, and a void's
        # reversing row cancels the payment it reverses. `total` stays the row
        # count, because it pages the table.
        "payments": qs.filter(amount__gt=0).count() - qs.filter(amount__lt=0).count(),
        "people": qs.exclude(staff_id__isnull=True).exclude(staff_id="").values("staff_id")
        .annotate(net=Sum("amount")).filter(net__gt=0).count(),
        "duplicates_open": 0 if blind else DuplicateFinding.objects.filter(kind="SAME_PERSON", status="OPEN").count(),
        "total": total,
        "limit": limit,
        "offset": offset,
        # The sum of everything the filter matches, not of the page. The screen
        # showed one page's worth beside an Export button that wrote all of
        # them, so the page and the file disagreed about the same filter.
        "total_amount": round(qs.aggregate(s=Sum("amount"))["s"] or 0, 2),
        "results": [_ledger_row_dict(r, dup_keys, photos) for r in page],
    }


@api.get("/admin/ledger/export", auth=session_auth)
def admin_ledger_export(
    request: HttpRequest,
    month: Optional[str] = None,
    department: Optional[str] = None,
    scheme: Optional[str] = None,
    q: Optional[str] = None,
):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    qs = _ledger_queryset(month, department, scheme, q)
    buf = io.StringIO()
    w = csv_writer(buf)
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
            # Last, so a sheet built on the column positions before it still
            # reads the same columns.
            "scheme",
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
                    _scheme_of(r),
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
            "created_by": b.created_by.name or b.created_by.email,
            "by": {"user_id": b.created_by_id, "name": b.created_by.name or b.created_by.email},
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
    w = csv_writer(buf)
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
    'SCHEME_FACULTY',
    'SCHEME_FYP',
    '_ledger_queryset',
    '_ledger_row_dict',
    '_scheme_of',
    'admin_ledger',
    'admin_ledger_export',
    'create_batch',
    'export_batch',
    'get_batch',
    'list_batches',
    'start_batch',
    'upload_batch',
]
