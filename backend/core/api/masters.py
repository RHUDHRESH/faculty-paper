"""process queue, SNIP and faculty master.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.schemas import BatchProcessIn
from core.api.deps import claim_to_dict
from core.api.common import require_user

import csv
import io
import json
import uuid as uuid_lib
from pathlib import Path
from typing import Optional
from django.conf import settings
from django.db.models import Q
from django.http import HttpRequest
from ninja import File, Form, UploadedFile
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimStatus, FacultyMaster, PaidLedger, PriorPayment, Role, ScimagoJournal, SnipSource, User
from core.services import rbac

# ---------- process queue ----------


@api.get("/admin/process", auth=session_auth)
def admin_process_queue(request: HttpRequest, status: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    qs = Claim.objects.select_related("owner").prefetch_related("attachments").order_by("-updated_at")
    if status:
        qs = qs.filter(status=status)
    else:
        qs = qs.filter(status__in=(ClaimStatus.SUBMITTED, ClaimStatus.DRAFT))
    qs = qs.filter(
        Q(indexing_status__isnull=True)
        | Q(indexing_status="")
        | ~Q(indexing_status="Indexed")
    )
    return [claim_to_dict(c) for c in qs[:200]]


@api.post("/admin/process/batch", auth=session_auth)
def admin_process_batch(request: HttpRequest, payload: BatchProcessIn):
    """Queue Scopus verification for a list of claims.

    Each claim costs 2–4 external calls; a list of any size has no business
    inside one HTTP request. Poll /api/admin/jobs/{job_id}.
    """
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    from django_q.tasks import async_task

    ids = list(dict.fromkeys(payload.claim_ids or []))[:500]
    if not ids:
        raise HttpError(400, "Select at least one claim")
    job_id = async_task("core.tasks.run_bulk_verify", ids, user.id)
    return {"queued": True, "job_id": job_id, "count": len(ids)}


# ---------- SNIP / faculty master ----------


@api.get("/admin/snip/stats", auth=session_auth)
def snip_stats(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    count = SnipSource.objects.count()
    years = list(SnipSource.objects.values_list("year", flat=True).distinct().order_by("-year"))
    return {"count": count, "years": years}


@api.post("/admin/snip/import", auth=session_auth)
def snip_import(request: HttpRequest, file: UploadedFile = File(...), year: int = Form(2025)):
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read().decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(content))
    n = 0
    for row in reader:
        title = row.get("Title") or row.get("title") or ""
        print_issn = row.get("Print ISSN") or row.get("Print_ISSN") or row.get("print_issn")
        e_issn = row.get("E-ISSN") or row.get("E_ISSN") or row.get("e_issn")
        snip_raw = row.get("SNIP") or row.get("snip")
        sjr_raw = row.get("SJR") or row.get("sjr")
        source_id = row.get("Source ID") or row.get("source_id")
        try:
            snip = float(str(snip_raw).replace(",", "")) if snip_raw else None
        except ValueError:
            snip = None
        try:
            sjr = float(str(sjr_raw).replace(",", "")) if sjr_raw else None
        except ValueError:
            sjr = None
        if not title:
            continue
        # Column is CharField(32); the "TITLE:" fallback must fit inside it.
        issn_key = (
            (print_issn or e_issn or f"TITLE:{title[:24]}").split(",")[0].strip()
        )[:32]
        snip_defaults = {
            "title": title[:512],
            "e_issn": e_issn,
            "snip": snip,
            "sjr": sjr,
            "source_id": source_id,
            "raw_json": json.dumps(row)[:50000],
        }
        # No unique constraint on (print_issn, year), so update_or_create would
        # raise MultipleObjectsReturned on already-duplicated data.
        existing = SnipSource.objects.filter(print_issn=issn_key, year=year).first()
        if existing is None:
            SnipSource.objects.create(print_issn=issn_key, year=year, **snip_defaults)
        else:
            for k, v in snip_defaults.items():
                setattr(existing, k, v)
            existing.save()
        n += 1
    AuditLog.objects.create(
        actor=user, action="SNIP_IMPORT", entity="SnipSource", detail_json=json.dumps({"n": n, "year": year})
    )
    return {"imported": n}


@api.get("/admin/faculty-master", auth=session_auth)
def faculty_master_list(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    return [
        {
            "id": f.id,
            "department": f.department,
            "biometric_id": f.biometric_id,
            "staff_id": f.staff_id,
            "scopus_author_id": f.scopus_author_id,
            "name": f.name,
            "designation": f.designation,
            "email": f.email,
            "phone": f.phone,
        }
        for f in FacultyMaster.objects.order_by("department", "name")
    ]


@api.get("/admin/faculty-options", auth=session_auth)
def faculty_options(request: HttpRequest, q: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    # Filter in the database: this endpoint fires on every keystroke of the
    # admin faculty picker, and loading both full tables into Python made each
    # keystroke cost the whole master list.
    limit = 30 if q else 200
    masters_qs = FacultyMaster.objects.order_by("department", "name")
    users_qs = User.objects.filter(role=Role.FACULTY, active=True)
    if q:
        match = (
            Q(name__icontains=q)
            | Q(staff_id__icontains=q)
            | Q(email__icontains=q)
            | Q(department__icontains=q)
        )
        masters_qs = masters_qs.filter(match)
        users_qs = users_qs.filter(match)
    masters = list(masters_qs[:limit])
    staff_ids = [f.staff_id for f in masters if f.staff_id]
    emails = {e for f in masters if f.email for e in (f.email, f.email.lower())}
    linked_qs = User.objects.filter(role=Role.FACULTY, active=True).filter(
        Q(staff_id__in=staff_ids) | Q(email__in=list(emails))
    )
    users_by_staff = {u.staff_id: u for u in linked_qs if u.staff_id}
    users_by_email = {u.email.lower(): u for u in linked_qs if u.email}
    results = []
    seen = set()
    for f in masters:
        linked = users_by_staff.get(f.staff_id) or (users_by_email.get((f.email or "").lower()) if f.email else None)
        key = linked.id if linked else f"master:{f.id}"
        if key in seen:
            continue
        seen.add(key)
        results.append(
            {
                "owner_id": linked.id if linked else None,
                "master_id": f.id,
                "name": f.name,
                "email": f.email or (linked.email if linked else None),
                "department": f.department or (linked.department if linked else None),
                "staff_id": f.staff_id,
                "biometric_id": f.biometric_id or (linked.biometric_id if linked else None),
                "designation": f.designation or (linked.designation if linked else None),
                "scopus_author_url": linked.scopus_author_url if linked else None,
                "scopus_author_id": f.scopus_author_id or (linked.scopus_author_id if linked else None),
                "has_user_account": linked is not None,
            }
        )
    for u in users_qs.order_by("name")[:limit]:
        if u.id in seen:
            continue
        seen.add(u.id)
        results.append(
            {
                "owner_id": u.id,
                "master_id": None,
                "name": u.name,
                "email": u.email,
                "department": u.department,
                "staff_id": u.staff_id,
                "biometric_id": u.biometric_id,
                "designation": u.designation,
                "scopus_author_url": u.scopus_author_url,
                "scopus_author_id": u.scopus_author_id,
                "has_user_account": True,
            }
        )
    return results


@api.post("/admin/faculty-master/import", auth=session_auth)
def faculty_master_import(request: HttpRequest, file: UploadedFile = File(...)):
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read().decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(content))
    n = 0
    for row in reader:
        staff_id = row.get("staff_id") or row.get("Staff ID") or row.get("Staff_ID")
        name = row.get("name") or row.get("Name") or row.get("Faculty Name")
        if not staff_id or not name:
            continue
        FacultyMaster.objects.update_or_create(
            staff_id=str(staff_id).strip(),
            defaults={
                "department": row.get("department") or row.get("Department"),
                "biometric_id": row.get("biometric_id") or row.get("Biometric ID"),
                "scopus_author_id": row.get("scopus_author_id") or row.get("Scopus Author ID"),
                "name": name[:255],
                "designation": row.get("designation") or row.get("Designation"),
                "email": row.get("email") or row.get("Email"),
                "phone": row.get("phone") or row.get("Phone"),
                "raw_json": json.dumps(row)[:50000],
            },
        )
        n += 1
    AuditLog.objects.create(
        actor=user, action="FACULTY_MASTER_IMPORT", entity="FacultyMaster", detail_json=json.dumps({"n": n})
    )
    return {"imported": n}


@api.get("/admin/erp-stats", auth=session_auth)
def erp_stats(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    return {
        "faculty_master": FacultyMaster.objects.count(),
        "claims": Claim.objects.count(),
        "claims_paid": Claim.objects.filter(status=ClaimStatus.PAID).count(),
        "prior_payments": PriorPayment.objects.count(),
        "paid_ledger": PaidLedger.objects.count(),
        "scimago": ScimagoJournal.objects.count(),
        "snip": SnipSource.objects.count(),
        "users": User.objects.count(),
    }


@api.post("/admin/erp-import", auth=session_auth)
def erp_import_xlsx(
    request: HttpRequest,
    file: UploadedFile = File(...),
    skip_sjr: bool = Form(True),
    skip_snip: bool = Form(True),
    skip_faculty: bool = Form(False),
    skip_accounts: bool = Form(False),
    skip_claims: bool = Form(False),
    claims_only: bool = Form(False),
    sync_users: bool = Form(True),
    year: int = Form(2025),
):
    """Upload Publication_Processing_ERP *.xlsx and queue import_erp_excel.

    The 754-line workbook import used to run inline in this request against the
    gunicorn timeout; it now runs on the job queue. Poll /api/admin/jobs/{job_id}.
    """
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    name = (file.name or "").lower()
    if not name.endswith((".xlsx", ".xlsm")):
        raise HttpError(400, "Upload an .xlsx ERP workbook")

    from django_q.tasks import async_task

    raw = file.read()
    if len(raw) > 40 * 1024 * 1024:
        raise HttpError(400, "File too large (max 40MB)")

    imports_dir = Path(settings.MEDIA_ROOT) / "imports"
    imports_dir.mkdir(parents=True, exist_ok=True)
    saved = imports_dir / f"{uuid_lib.uuid4().hex}.xlsx"
    saved.write_bytes(raw)

    options = {
        "year": year,
        "skip_sjr": skip_sjr,
        "skip_snip": skip_snip,
        "skip_faculty": skip_faculty,
        "skip_accounts": skip_accounts,
        "skip_claims": skip_claims,
        "claims_only": claims_only,
    }
    job_id = async_task("core.tasks.run_erp_import", str(saved), options, user.id, bool(sync_users))
    AuditLog.objects.create(
        actor=user,
        action="ERP_XLSX_IMPORT_QUEUED",
        entity="Workbook",
        detail_json=json.dumps({"filename": file.name, "job_id": job_id, "options": options}),
    )
    return {"ok": True, "queued": True, "job_id": job_id}


@api.get("/admin/jobs/{job_id}", auth=session_auth)
def job_status(request: HttpRequest, job_id: str):
    """Status of a queued background job (ERP import, bulk verify)."""
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    from django_q.models import OrmQ, Task as QTask

    t = QTask.objects.filter(id=job_id).first()
    if t is not None:
        return {
            "status": "done" if t.success else "failed",
            "success": t.success,
            "result": t.result if isinstance(t.result, (dict, list, str, int, float, bool, type(None))) else str(t.result),
            "started": t.started.isoformat() if t.started else None,
            "stopped": t.stopped.isoformat() if t.stopped else None,
        }
    for q in OrmQ.objects.all()[:100]:
        try:
            if q.task_id() == job_id:
                return {"status": "queued"}
        except Exception:
            continue
    return {"status": "running_or_unknown"}




__all__ = [
    'admin_process_batch',
    'admin_process_queue',
    'erp_import_xlsx',
    'erp_stats',
    'faculty_master_import',
    'faculty_master_list',
    'faculty_options',
    'job_status',
    'snip_import',
    'snip_stats',
]
