from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import uuid as uuid_lib
from datetime import date, datetime
from pathlib import Path
from typing import Any, Optional

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import Count, Q, Sum
from django.http import HttpRequest, HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import NinjaAPI, Schema, UploadedFile, File, Form
from ninja.errors import HttpError
from ninja.security import SessionAuth

logger = logging.getLogger("core.api")

from core.models import (
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAction,
    ClaimAttachment,
    ClaimReason,
    ClaimStatus,
    PAYABLE_STATUSES,
    FacultyMaster,
    FormulaConfig,
    MonthlyBatch,
    MonthlyRow,
    Notification,
    PaidLedger,
    PriorImport,
    PriorPayment,
    Role,
    ScimagoJournal,
    SnipSource,
    User,
)
from core.services import rbac
from core.services.monthly_processor import start_batch_async
from core.services.normalize import normalize_doi, normalize_issn, normalize_title
from core.services.remuneration import (
    CATEGORY_LABELS,
    DEFAULT_AUTHOR_POINTS,
    DEFAULT_PUB_TYPE_MULTIPLIERS,
    MAX_ELIGIBLE_AUTHORS,
    calculate_remuneration,
    formula_from_model,
    snapshot_formula,
)
from core.services.notify_email import send_optional_email
from core.services.scimago import lookup_scimago
from core.services.scimago_sync import (
    SCIMAGO_RANK_URL,
    ScimagoSyncError,
    import_csv_text,
    sync_year,
)
from core.services.scopus import (
    ScopusError,
    extract_author_id,
    lookup_paper_by_doi,
    lookup_serial_by_issn,
    search_by_title,
    search_candidates,
)
from core.services.tickets import assign_ticket_number
from core.services.uploads import ACCEPTED_LABEL, sniff
from core.services.verify import apply_verify_to_claim, check_already_paid, verify_publication

api = NinjaAPI(
    title="Faculty Remuneration",
    version="1.0.0",
    # Swagger and the OpenAPI schema publish the whole endpoint surface, so they
    # stay off outside development.
    docs_url="/docs" if settings.DEBUG else None,
    openapi_url="/openapi.json" if settings.DEBUG else None,
)
session_auth = SessionAuth()


def _csv_safe(value: Any) -> Any:
    """Neutralise spreadsheet formula injection in exported free text.

    Paper titles and faculty names are user-supplied and land straight in a file
    someone opens in Excel, where a leading = + - or @ is executed as a formula.
    """
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def _csv_row(values: list[Any]) -> list[Any]:
    return [_csv_safe(v) for v in values]


def _require_admin_ops(user: User) -> None:
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")


def _worker_status() -> dict[str, Any]:
    """Is the background job worker alive, and is anything stuck behind it?

    qcluster shares this container with gunicorn. If it dies, the web service
    keeps answering and the revision stays 'healthy' while queued imports and
    monthly batches quietly stop running — including the schedule that is
    supposed to recover interrupted work, since it runs on the cluster that
    died. This is the one place that becomes visible.
    """
    try:
        from django_q.models import OrmQ, Schedule, Success

        queued = OrmQ.objects.count()
        last_success = Success.objects.order_by("-stopped").values_list("stopped", flat=True).first()
        next_run = (
            Schedule.objects.filter(name="recover-stale-batches")
            .values_list("next_run", flat=True)
            .first()
        )
        now = timezone.now()
        # The recovery schedule runs every 5 minutes, so a next_run that has
        # been in the past for a while means nobody is draining the queue.
        overdue_by = (now - next_run).total_seconds() if next_run and next_run < now else 0
        return {
            "queued": queued,
            "schedule_overdue_seconds": int(overdue_by),
            "alive": overdue_by < 900,
            "last_success": last_success.isoformat() if last_success else None,
        }
    except Exception as e:  # never let the health probe itself fall over
        return {"alive": None, "error": str(e)[:120]}


@api.get("/health", auth=None)
def health(request: HttpRequest):
    db_ok = False
    try:
        from django.db import connection

        with connection.cursor() as c:
            c.execute("SELECT 1")
            c.fetchone()
        db_ok = True
    except Exception:
        db_ok = False
    # Uploads written to a container filesystem do not survive a deploy. That
    # failure is invisible — the ticket still lists its attachments — so the
    # health check is the one place it can be noticed before someone looks for
    # a proof that is no longer there.
    bucket = getattr(settings, "GS_BUCKET_NAME", "")
    if bucket:
        media_backend = f"gs://{bucket}"
        media_is_ephemeral = False
    else:
        media_backend = str(Path(settings.MEDIA_ROOT).resolve())
        media_is_ephemeral = not settings.DEBUG
    # The job worker shares this container. If it dies, gunicorn keeps serving
    # and the revision looks perfectly healthy while queued work — ERP imports,
    # monthly batches — silently stops running. Nothing else would notice.
    worker = _worker_status()
    payload = {
        "ok": db_ok,
        "db": db_ok,
        "service": "faculty-paper-api",
        "git": (os.getenv("GIT_COMMIT") or os.getenv("K_REVISION") or "")[:24] or None,
        "media_backend": media_backend,
        "media_persistent": not media_is_ephemeral,
        "worker": worker,
        "time": timezone.now().isoformat(),
    }
    if media_is_ephemeral:
        payload["warnings"] = [
            "Uploads are on the container filesystem and will be lost on the "
            "next deploy. Set GS_BUCKET_NAME to a Google Cloud Storage bucket."
        ]
        logger.warning("media_storage_ephemeral backend=%s", media_backend)
    if not db_ok:
        raise HttpError(503, "database unavailable")
    return payload


def _verification_issues(result: dict[str, Any], claim: Claim) -> list[str]:
    """Faculty-facing plain issues — no vendor jargon."""
    issues: list[str] = []
    scopus = result.get("scopus") or {}
    if not scopus.get("indexed"):
        issues.append("Paper could not be auto-confirmed in the publication index")
    elif scopus.get("linked") is False and (claim.scopus_author_id or claim.scopus_author_url):
        issues.append("Paper found, but could not confirm it is linked to your author profile")
    paid = result.get("paid") or {}
    if paid.get("warning"):
        issues.append("Payment history may already include this paper")
    if not claim.quartile:
        issues.append("Journal ranking (quartile) is missing — pick Q1–Q4 or send with a note")
    return issues


def _notify_admins(claim: Claim, title: str, body: str) -> None:
    """A submitted ticket waits on admin clearing, so admins are who hear about it."""
    for u in User.objects.filter(
        role__in=rbac.ADMIN_ROLES, active=True
    ):
        Notification.objects.create(
            user=u,
            title=title,
            body=body,
            # /admin is the overview, which ignores ?claim — the clearing queue
            # is the page that actually opens the ticket.
            href=f"/admin/clearing?claim={claim.id}",
            claim_id=claim.id,
        )
        send_optional_email(u.email, title, body)


def _notify_finance(claim: Claim, title: str, body: str) -> None:
    for u in User.objects.filter(role=Role.FINANCE, active=True):
        Notification.objects.create(
            user=u,
            title=title,
            body=body,
            href=f"/finance?claim={claim.id}",
            claim_id=claim.id,
        )


# ---------- schemas ----------


class LoginIn(Schema):
    email: str
    password: str


class UserOut(Schema):
    id: str
    email: str
    name: str
    role: str
    department: Optional[str] = None
    employee_id: Optional[str] = None
    staff_id: Optional[str] = None
    biometric_id: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None
    must_change_password: bool = False
    active: bool = True
    portal: Optional[str] = None


class AttachmentIn(Schema):
    kind: str
    url: str
    filename: Optional[str] = None
    size_bytes: int = 0
    # SEC_REFERENCE only: which citation this file proves.
    ref_number: Optional[str] = None
    ref_title: Optional[str] = None


class ClaimIn(Schema):
    owner_id: Optional[str] = None
    doi: Optional[str] = None
    issn: Optional[str] = None
    journal_title: Optional[str] = None
    paper_title: Optional[str] = None
    publication_year: Optional[int] = None
    publication_date: Optional[str] = None
    publication_type: Optional[str] = None
    indexing_level: Optional[str] = None
    indexing_ref: Optional[str] = None
    au_annexure_ref: Optional[str] = None
    ugc_care_ref: Optional[str] = None
    yukthi_id: Optional[str] = None
    self_reported_quartile: Optional[str] = None
    impact_factor: Optional[str] = None
    proof_url: Optional[str] = None
    sec_refs: Optional[str] = None
    sec_proof_url: Optional[str] = None
    reference_articles: Optional[str] = None
    claim_reason: Optional[str] = None
    # Handled by _bind_identity_from_user, not _FACULTY_WRITABLE
    scopus_author_url: Optional[str] = None
    designation: Optional[str] = None
    attachments: Optional[list[AttachmentIn]] = None
    is_student_publication: bool = False
    # Not defaulted true: a confirmation the claimant has to make themselves.
    affiliation_ok: bool = False
    payout_month: Optional[str] = None
    subject_category: Optional[str] = None
    subjects_json: Optional[str] = None
    snip: Optional[float] = None
    self_reported_snip: Optional[float] = None
    snip_year: Optional[int] = None
    quartile: Optional[str] = None
    manual_quartile_reason: Optional[str] = None
    total_authors: int = 1
    author_position: int = 1
    authors_json: Optional[str] = None
    year_mismatch: bool = False
    year_mismatch_override: bool = False
    year_mismatch_reason: Optional[str] = None
    eid: Optional[str] = None
    scopus_url: Optional[str] = None
    cover_date: Optional[str] = None
    aggregation_type: Optional[str] = None
    engineering_class: Optional[str] = None
    contest_forward: bool = False
    contest_note: Optional[str] = None
    submit: bool = False


# Fields faculty may set — verification / money / identity are server-owned.
# The money-determining columns (snip, quartile, engineering_class,
# aggregation_type) and the Scopus identity columns (eid, scopus_url,
# cover_date, subjects) are deliberately absent: they only ever come from
# verification or an admin's audited manual entry. Faculty declarations go to
# the self_reported_* columns instead.
_FACULTY_WRITABLE = {
    "doi",
    "issn",
    "journal_title",
    "paper_title",
    "publication_year",
    "publication_date",
    "publication_type",
    "indexing_level",
    "indexing_ref",
    "au_annexure_ref",
    "ugc_care_ref",
    "yukthi_id",
    "self_reported_quartile",
    "self_reported_snip",
    "impact_factor",
    "proof_url",
    "sec_refs",
    "sec_proof_url",
    "reference_articles",
    "claim_reason",
    "is_student_publication",
    "affiliation_ok",
    "payout_month",
    "manual_quartile_reason",
    "total_authors",
    "author_position",
    "authors_json",
    "year_mismatch",
    "year_mismatch_override",
    "year_mismatch_reason",
    # Descriptive only — it names the journal's subject area and feeds no part
    # of the payout. It was accepted by the schema but dropped here, so the
    # form saved a value that could never come back and the detail view showed
    # a permanent "—".
    "subject_category",
}

# Legacy form keys that used to write the verified columns directly. They are
# accepted for wizard compatibility but land in self_reported_*.
_SELF_REPORT_ALIASES = {"snip": "self_reported_snip", "quartile": "self_reported_quartile"}


def _apply_faculty_payload(claim: Claim, payload: ClaimIn) -> None:
    data = payload.dict(exclude={"submit", "contest_forward", "contest_note", "owner_id"}, exclude_unset=True)
    for k, v in data.items():
        k = _SELF_REPORT_ALIASES.get(k, k)
        if k not in _FACULTY_WRITABLE:
            continue
        if k == "payout_month":
            claim.payout_month = _parse_payout_month(v)
        elif k == "total_authors":
            # Not clamped to the eligibility ceiling: a paper really can have
            # more than nine authors, and the calculation says so plainly
            # instead of the form quietly rewriting the author list.
            claim.total_authors = max(1, min(int(v or 1), 200))
        elif k == "author_position":
            claim.author_position = max(1, min(int(v or 1), 200))
        elif k == "self_reported_snip" and v is not None:
            claim.self_reported_snip = float(v)
        elif k == "claim_reason":
            claim.claim_reason = v if v in ClaimReason.values else ClaimReason.INCENTIVE
        elif hasattr(claim, k):
            setattr(claim, k, v)
    # The ERP sheets read one combined indexing_ref column, so keep it derived
    # from the two registers rather than asking for the same numbers twice.
    parts = [
        f"{label} {value.strip()}"
        for label, value in (
            ("AU Annexure", claim.au_annexure_ref or ""),
            ("UGC Care", claim.ugc_care_ref or ""),
        )
        if value.strip()
    ]
    if parts:
        claim.indexing_ref = "; ".join(parts)[:255]

    # Count-only filings carry no money: force SNIP to 0 so the formula pays nothing,
    # regardless of what the client sent.
    if claim.claim_reason == ClaimReason.COUNT_ONLY:
        claim.is_student_publication = True
        claim.snip = 0.0
        claim.self_reported_snip = 0.0
    claim.normalized_title = normalize_title(claim.paper_title)[:512]
    # Never trust client override flags. (scimago_verified no longer needs a
    # reset here: quartile itself is not faculty-writable, and wiping the flag
    # on an attachments-only PATCH used to orphan a verified quartile.)
    claim.override_duplicate = False
    claim.override_reason = None


# Evidence caps. A claim can legitimately cite many SEC-affiliated references,
# and the published article sometimes arrives split across files or with
# supplementary material — so these are abuse ceilings, not editorial limits.
ATTACHMENT_LIMITS = {
    AttachmentKind.PUBLISHED_PAPER: 10,
    AttachmentKind.SEC_REFERENCE: 50,
}

#: An attachment URL may only be one this server minted in upload_claim_file:
#: MEDIA_URL + "claims/" + uuid4().hex + a sniffed extension. A startswith check
#: on MEDIA_URL is not enough — "/media/../../../etc/passwd" satisfies it, and
#: the client decides this string, which then ends up in an href and an iframe.
_ATTACHMENT_NAME = re.compile(r"^claims/[0-9a-f]{32}\.[a-z0-9]{2,5}$")


def _is_own_media_url(url: str) -> bool:
    prefix = settings.MEDIA_URL
    if not url.startswith(prefix):
        return False
    return bool(_ATTACHMENT_NAME.match(url[len(prefix):]))


def _validated_attachments(payload: ClaimIn) -> list[dict[str, Any]] | None:
    """Check the attachment set before anything is written.

    Returns None when the client omitted the key entirely, meaning "leave the
    existing set alone". Validation is split from persistence so a cap violation
    cannot surface after the claim has already been ticketed and notified.
    """
    if payload.attachments is None:
        return None
    limits = ATTACHMENT_LIMITS
    kept: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    seen_urls: set[str] = set()
    for a in payload.attachments:
        if a.kind not in AttachmentKind.values:
            continue
        url = (a.url or "").strip()
        if not _is_own_media_url(url):
            continue
        # Uploading many files at once makes a repeated URL easy; the same PDF
        # listed twice would read to an approver as two separate references.
        if url in seen_urls:
            continue
        seen_urls.add(url)
        counts[a.kind] = counts.get(a.kind, 0) + 1
        if counts[a.kind] > limits[a.kind]:
            raise HttpError(400, f"At most {limits[a.kind]} file(s) allowed for {a.kind}")
        is_reference = a.kind == AttachmentKind.SEC_REFERENCE
        kept.append(
            {
                "kind": a.kind,
                "url": url,
                "filename": (a.filename or "")[:255] or None,
                "size_bytes": max(0, int(a.size_bytes or 0)),
                # Only a cited reference carries a citation identity.
                "ref_number": ((a.ref_number or "").strip()[:32] or None) if is_reference else None,
                "ref_title": ((a.ref_title or "").strip() or None) if is_reference else None,
            }
        )
    return kept


def _persist_attachments(claim: Claim, kept: list[dict[str, Any]] | None, actor: User) -> None:
    """Replace the claim's attachment set. The claim row must already exist."""
    if kept is None:
        return
    claim.attachments.all().delete()
    if kept:
        ClaimAttachment.objects.bulk_create(
            [ClaimAttachment(claim=claim, uploaded_by=actor, **k) for k in kept]
        )
    # Keep the legacy single-URL columns in step for older screens and exports
    paper = next((k for k in kept if k["kind"] == AttachmentKind.PUBLISHED_PAPER), None)
    refs = [k for k in kept if k["kind"] == AttachmentKind.SEC_REFERENCE]
    claim.proof_url = paper["url"] if paper else None
    claim.sec_proof_url = refs[0]["url"] if refs else None
    # sec_refs and reference_articles are what the ERP sheets and every existing
    # export read. Where the attachments carry citation data they are derived
    # from it, so the two can no longer disagree. Uploads that carry none — the
    # ERP importer, older clients — keep whatever the caller set.
    updates = {"proof_url": claim.proof_url, "sec_proof_url": claim.sec_proof_url}
    numbers = [k["ref_number"] for k in refs if k.get("ref_number")]
    titles = [k["ref_title"] for k in refs if k.get("ref_title")]
    if numbers:
        claim.sec_refs = ", ".join(numbers)
        updates["sec_refs"] = claim.sec_refs
    if titles:
        claim.reference_articles = "\n".join(titles)
        updates["reference_articles"] = claim.reference_articles
    Claim.objects.filter(pk=claim.pk).update(**updates)


def _bind_identity_from_user(claim: Claim, user: User, payload: ClaimIn | None = None) -> None:
    # Payment identity and department stay server-owned: a wrong biometric ID pays the
    # wrong person, and department decides which HoD approves the ticket.
    claim.staff_id = user.staff_id
    claim.biometric_id = user.biometric_id

    changed: list[str] = []

    # The Scopus author link is per-submission on the form; fall back to the profile.
    link = ((payload.scopus_author_url if payload else None) or "").strip() or user.scopus_author_url
    claim.scopus_author_url = link
    claim.scopus_author_id = extract_author_id(link or "") or user.scopus_author_id
    if link and link != user.scopus_author_url:
        user.scopus_author_url = link
        user.scopus_author_id = claim.scopus_author_id
        changed += ["scopus_author_url", "scopus_author_id"]

    designation = ((payload.designation if payload else None) or "").strip()
    claim.designation = designation or user.designation
    if designation and designation != user.designation:
        user.designation = designation
        changed.append("designation")

    if changed:
        user.save(update_fields=[*changed, "updated_at"])


class ActionIn(Schema):
    note: Optional[str] = None
    voucher_number: Optional[str] = None
    #: The amount the actor saw when they confirmed. Money moves only when the
    #: recomputed amount still matches it.
    expected_amount: Optional[float] = None
    #: Super-admin escape hatch for a Scopus outage. Same ACL as /recalculate.
    skip_external: bool = False


class RecalcIn(Schema):
    #: Super-admin escape hatch for a Scopus outage: recompute from the stored
    #: verified values without calling out. Audited.
    skip_external: bool = False


class OverrideStatusIn(Schema):
    to_status: str
    note: str


class ManualVerifyIn(Schema):
    snip: Optional[float] = None
    quartile: Optional[str] = None
    engineering_class: Optional[str] = None
    #: Where the values came from — a citation the auditor can follow.
    note: str


class CalcIn(Schema):
    snip: Optional[float] = None
    quartile: Optional[str] = None
    total_authors: int = 1
    author_position: int = 1
    publication_type: Optional[str] = None
    is_student_publication: bool = False
    # Both decide the category and whether the quartile incentive applies, so
    # the preview needs them or it quietly estimates a different category.
    indexing_level: Optional[str] = None
    engineering_class: Optional[str] = None
    sec_reference_count: Optional[int] = None


class ResetPasswordByEmailIn(Schema):
    email: str
    password: str


class ScopusLookupIn(Schema):
    doi: Optional[str] = None
    title: Optional[str] = None
    issn: Optional[str] = None


class CandidateSearchIn(Schema):
    """Free-text "find my article" search — several matches, the user picks one."""

    title: Optional[str] = None
    doi: Optional[str] = None
    author_id: Optional[str] = None
    scopus_author_url: Optional[str] = None
    # Admin filing on behalf: whose already-filed claims to check against.
    owner_id: Optional[str] = None
    limit: int = 10


class ScimagoLookupIn(Schema):
    issn: Optional[str] = None
    title: Optional[str] = None
    year: Optional[int] = None
    subject: Optional[str] = None


class PriorCheckIn(Schema):
    doi: Optional[str] = None
    title: Optional[str] = None
    issn: Optional[str] = None
    staff_id: Optional[str] = None
    exclude_claim_id: Optional[str] = None


class VerifyIn(Schema):
    title: str
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None
    issn: Optional[str] = None
    staff_id: Optional[str] = None
    exclude_claim_id: Optional[str] = None


class UserCreateIn(Schema):
    email: str
    name: str
    password: str
    role: str = Role.FACULTY
    department: Optional[str] = None
    employee_id: Optional[str] = None
    staff_id: Optional[str] = None
    biometric_id: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None
    must_change_password: bool = True


class UserUpdateIn(Schema):
    role: Optional[str] = None
    department: Optional[str] = None
    active: Optional[bool] = None
    name: Optional[str] = None
    staff_id: Optional[str] = None
    biometric_id: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None


class ResetPasswordIn(Schema):
    password: str


class ChangePasswordIn(Schema):
    current_password: str
    new_password: str


class BatchProcessIn(Schema):
    claim_ids: list[str]


class FormulaIn(Schema):
    snip_multiplier: float
    qf_q1: float
    qf_q2: float
    qf_q3: float
    qf_q4: float
    qf_no_snip: float = 0
    qf_snip_only: float = 0
    qf_others: float = 4000
    author_point_json: str
    notes: Optional[str] = None
    name: Optional[str] = "Policy"
    snip_cap: float = 30
    publication_type_multipliers_json: Optional[str] = None
    student_remuneration_zero: bool = True
    qf_only_for_no_snip: bool = True
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    high_value_threshold: float = 100000
    # Category II-IV rates and the two eligibility limits. They were absent
    # from both the GET payload and the create() below, so every "save as new
    # version" quietly reset them to the model defaults — including the author
    # ceiling and the SEC-reference minimum, which decide whether a claim pays
    # anything at all.
    fixed_journal_no_snip: float = 5000
    fixed_other_no_snip: float = 4000
    fixed_web_of_science: float = 5000
    max_authors: int = 9
    min_sec_references: int = 2


class MonthlyCreateIn(Schema):
    name: str
    rows: list[dict[str, Any]]


# Endpoints a user must still reach while they are being forced to set a password.
_PASSWORD_CHANGE_EXEMPT = {"/api/auth/change-password", "/api/auth/me"}


def require_user(request: HttpRequest) -> User:
    if not request.user.is_authenticated:
        raise HttpError(401, "Unauthorized")
    user: User = request.user  # type: ignore
    if not user.active:
        raise HttpError(403, "Inactive")
    # must_change_password used to be advertised in the profile payload and
    # enforced only by the frontend, so an API client could ignore it entirely.
    if user.must_change_password and request.path not in _PASSWORD_CHANGE_EXEMPT:
        raise HttpError(403, "Set a new password before continuing")
    return user


def _user_dict(u: User) -> dict[str, Any]:
    return {
        "id": u.id,
        "email": u.email,
        "name": u.name,
        "role": u.role,
        "department": u.department,
        "employee_id": u.employee_id,
        "staff_id": u.staff_id,
        "biometric_id": u.biometric_id,
        "designation": u.designation,
        "scopus_author_url": u.scopus_author_url,
        "scopus_author_id": u.scopus_author_id,
        "must_change_password": u.must_change_password,
        "active": u.active,
        "portal": rbac.portal_for_role(u.role),
    }


def _parse_payout_month(val: str | None) -> date | None:
    if not val or not str(val).strip():
        return None
    s = str(val).strip()
    try:
        if len(s) == 7:
            return datetime.strptime(f"{s}-01", "%Y-%m-%d").date()
        return datetime.strptime(s[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def _format_payout_month(d: date | None) -> str | None:
    if not d:
        return None
    return d.strftime("%Y-%m")


def claim_to_dict(c: Claim) -> dict[str, Any]:
    return {
        "id": c.id,
        "owner_id": c.owner_id,
        "owner_name": c.owner.name,
        "owner_email": c.owner.email,
        "owner_department": c.owner.department,
        "status": c.status,
        "status_note": c.status_note,
        "ticket_number": c.ticket_number,
        "contest_forward": c.contest_forward,
        "contest_note": c.contest_note,
        "verification_ok": c.verification_ok,
        "verification_snapshot_json": c.verification_snapshot_json,
        "doi": c.doi,
        "issn": c.issn,
        "journal_title": c.journal_title,
        "paper_title": c.paper_title,
        "publication_year": c.publication_year,
        "publication_date": c.publication_date,
        "publication_type": c.publication_type,
        "indexing_level": c.indexing_level,
        "indexing_ref": c.indexing_ref,
        "au_annexure_ref": c.au_annexure_ref,
        "ugc_care_ref": c.ugc_care_ref,
        "yukthi_id": c.yukthi_id,
        "self_reported_quartile": c.self_reported_quartile,
        "impact_factor": c.impact_factor,
        "staff_id": c.staff_id,
        "biometric_id": c.biometric_id,
        "designation": c.designation,
        "scopus_author_url": c.scopus_author_url,
        "scopus_author_id": c.scopus_author_id,
        "proof_url": c.proof_url,
        "sec_refs": c.sec_refs,
        "sec_proof_url": c.sec_proof_url,
        "reference_articles": c.reference_articles,
        "claim_reason": c.claim_reason,
        "attachments": [
            {
                "id": a.id,
                "kind": a.kind,
                "url": a.url,
                "filename": a.filename,
                "size_bytes": a.size_bytes,
                "ref_number": a.ref_number,
                "ref_title": a.ref_title,
            }
            for a in c.attachments.all()
        ]
        if c.pk
        else [],
        "indexing_status": c.indexing_status,
        "linkage_status": c.linkage_status,
        "is_student_publication": c.is_student_publication,
        "affiliation_ok": c.affiliation_ok,
        "payout_month": _format_payout_month(c.payout_month),
        "subject_category": c.subject_category,
        "subjects_json": c.subjects_json,
        "snip": c.snip,
        "snip_year": c.snip_year,
        "snip_source": c.snip_source,
        "self_reported_snip": c.self_reported_snip,
        "quartile": c.quartile,
        "quartile_source": c.quartile_source,
        "manual_verified_by_name": c.manual_verified_by.name if c.manual_verified_by else None,
        "manual_verification_note": c.manual_verification_note,
        # A draft's amount may be computed from the claimant's own declarations;
        # anything past submission is verified-values only.
        "remuneration_is_estimate": c.status == ClaimStatus.DRAFT
        and (c.snip is None or not c.quartile),
        "scimago_verified": c.scimago_verified,
        "scimago_sjr": c.scimago_sjr,
        "scimago_categories_json": c.scimago_categories_json,
        "scimago_dataset_year": c.scimago_dataset_year,
        "manual_quartile_reason": c.manual_quartile_reason,
        "total_authors": c.total_authors,
        "author_position": c.author_position,
        "authors_json": c.authors_json,
        "qf_amount": c.qf_amount,
        "base_amount": c.base_amount,
        "author_point": c.author_point,
        "remuneration": c.remuneration,
        "calc_error": c.calc_error,
        "remuneration_category": c.remuneration_category,
        "remuneration_note": c.remuneration_note,
        "duplicate_warning": c.duplicate_warning,
        "duplicate_matches_json": c.duplicate_matches_json,
        "override_duplicate": c.override_duplicate,
        "override_reason": c.override_reason,
        "year_mismatch": c.year_mismatch,
        "year_mismatch_override": c.year_mismatch_override,
        "year_mismatch_reason": c.year_mismatch_reason,
        "voucher_number": c.voucher_number,
        "cleared_by_name": c.cleared_by.name if c.cleared_by_id else None,
        "second_approved_by_name": c.second_approved_by.name if c.second_approved_by_id else None,
        "second_approved_at": c.second_approved_at.isoformat() if c.second_approved_at else None,
        "needs_second_approval": _needs_second_approval(
            c, _high_value_threshold(fresh=False)
        ),
        "eid": c.eid,
        "scopus_url": c.scopus_url,
        "cover_date": c.cover_date,
        "aggregation_type": c.aggregation_type,
        "engineering_class": c.engineering_class,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        "submitted_at": c.submitted_at.isoformat() if c.submitted_at else None,
        "paid_at": c.paid_at.isoformat() if c.paid_at else None,
    }


# ---------- auth ----------


@api.get("/auth/csrf")
def csrf(request: HttpRequest):
    return {"csrfToken": get_token(request)}


#: Failed sign-ins per (email, source IP) before the account is briefly locked.
_LOGIN_MAX_FAILURES = 10
_LOGIN_LOCKOUT_SECONDS = 15 * 60
#: After this many misses the error starts telling the person how to recover.
_LOGIN_HINT_AFTER = 3


def _login_unlock_epoch(email: str) -> str:
    from django.core.cache import cache

    return str(cache.get(f"login-unlock:{email}", "0"))


def clear_login_lockout(email: str) -> None:
    """Unlock an account immediately — used by the admin password resets.

    Rotating the epoch orphans every failure counter for the email without
    needing to know which IPs the failures came from.
    """
    from django.core.cache import cache

    cache.set(
        f"login-unlock:{email.strip().lower()}",
        uuid_lib.uuid4().hex,
        _LOGIN_LOCKOUT_SECONDS * 2,
    )


def _login_throttle_key(request: HttpRequest, email: str) -> str:
    ip = request.META.get("HTTP_X_FORWARDED_FOR", "").split(",")[0].strip() or request.META.get(
        "REMOTE_ADDR", ""
    )
    return f"login-fail:{_login_unlock_epoch(email)}:{email}:{ip}"


@api.post("/auth/login")
def auth_login(request: HttpRequest, payload: LoginIn):
    import time as _time

    from django.core.cache import cache

    email = payload.email.strip().lower()
    key = _login_throttle_key(request, email)
    state = cache.get(key) or {"n": 0, "ts": 0.0}
    now = _time.time()
    if state["n"] >= _LOGIN_MAX_FAILURES:
        remaining = int(max(0.0, state["ts"] + _LOGIN_LOCKOUT_SECONDS - now))
        if remaining > 0:
            minutes = max(1, -(-remaining // 60))
            logger.warning("login_throttled email=%s remaining=%ss", email, remaining)
            raise HttpError(
                429,
                f"Too many failed sign-ins — locked for about {minutes} more "
                f"minute{'s' if minutes != 1 else ''}. The research cell can reset "
                "your password to unlock it immediately.",
            )
        state = {"n": 0, "ts": 0.0}
    user = authenticate(request, username=email, password=payload.password)
    if not user:
        state = {"n": state["n"] + 1, "ts": now}
        cache.set(key, state, _LOGIN_LOCKOUT_SECONDS)
        if state["n"] >= _LOGIN_MAX_FAILURES:
            logger.warning("login_failed_lockout email=%s", email)
        if state["n"] >= _LOGIN_HINT_AFTER:
            raise HttpError(
                401,
                "Invalid credentials. Forgotten your password? "
                "The research cell can reset it for you.",
            )
        raise HttpError(401, "Invalid credentials")
    if not getattr(user, "active", True):
        raise HttpError(403, "Inactive account")
    cache.delete(key)
    login(request, user)
    return _user_dict(user)


@api.post("/auth/logout", auth=session_auth)
def auth_logout(request: HttpRequest):
    logout(request)
    return {"ok": True}


@api.get("/auth/me", auth=session_auth)
def auth_me(request: HttpRequest):
    u = require_user(request)
    return _user_dict(u)


class ProfileUpdateIn(Schema):
    """Deliberately excludes staff_id, biometric_id, and department.

    Those three decide who gets paid and which department the ticket sits in, and
    _bind_identity_from_user copies them onto every claim as server-owned values.
    Letting the claimant edit them on their own profile would make that guard
    meaningless. They are changed by an admin, via PATCH /admin/users/{id}.
    """

    name: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None


@api.patch("/auth/profile", auth=session_auth)
def update_profile(request: HttpRequest, payload: ProfileUpdateIn):
    u = require_user(request)
    data = payload.dict(exclude_unset=True)
    changed = {k: v for k, v in data.items() if getattr(u, k, None) != v}
    for k, v in data.items():
        setattr(u, k, v)
    u.save()
    if changed:
        AuditLog.objects.create(
            actor=u,
            action="PROFILE_UPDATE",
            entity="User",
            entity_id=u.id,
            detail_json=json.dumps({"fields": sorted(changed)}),
        )
    return _user_dict(u)


@api.post("/auth/change-password", auth=session_auth)
def change_password(request: HttpRequest, payload: ChangePasswordIn):
    u = require_user(request)
    if not u.check_password(payload.current_password):
        raise HttpError(400, "Current password incorrect")
    if len(payload.new_password) < 8:
        raise HttpError(400, "New password must be at least 8 characters")
    u.set_password(payload.new_password)
    u.must_change_password = False
    u.save(update_fields=["password", "must_change_password", "updated_at"])
    # Changing the password rotates the session auth hash, which would log the
    # user out on their very next request. Keep the current session valid.
    update_session_auth_hash(request, u)
    AuditLog.objects.create(
        actor=u, action="PASSWORD_CHANGE", entity="User", entity_id=u.id
    )
    return {"ok": True}


# ---------- lookups ----------


@api.post("/lookup/scopus", auth=session_auth)
def lookup_scopus(request: HttpRequest, payload: ScopusLookupIn):
    require_user(request)
    try:
        paper = None
        if payload.doi:
            paper = lookup_paper_by_doi(payload.doi)
        elif payload.title:
            paper, _ = search_by_title(payload.title)
        else:
            return {"ok": False, "code": "bad_payload", "message": "DOI or title required", "paper": None, "serial": None}
        if not paper:
            return {"ok": False, "code": "not_found", "message": "No Scopus match", "paper": None, "serial": None}
        serial = None
        issn = paper.get("issn") or payload.issn
        if issn:
            serial = lookup_serial_by_issn(issn)
        return {"ok": True, "code": "ok", "message": None, "paper": paper, "serial": serial}
    except ScopusError as e:
        raise HttpError(502, f"{e.code}: {e}")


@api.post("/lookup/candidates", auth=session_auth)
def lookup_candidates(request: HttpRequest, payload: CandidateSearchIn):
    """Search Scopus and hand back the matches for the claimant to choose from.

    Linkage is resolved in one extra query (AU-ID AND TITLE) rather than one per
    row: the claim rules require the article to sit on the author's own Scopus
    profile, so which candidates are already linked is the deciding detail.
    """
    user = require_user(request)
    title = (payload.title or "").strip()
    doi = normalize_doi(payload.doi) if payload.doi else None
    # Fall back to the caller's own profile so "show me my papers" needs no
    # arguments at all — the Scopus ID is already on the account.
    author_id = (
        (payload.author_id or "").strip()
        or extract_author_id(payload.scopus_author_url or "")
        or (user.scopus_author_id or "").strip()
        or extract_author_id(user.scopus_author_url or "")
        or ""
    )
    # Author-only is the "show me everything on my profile" mode.
    by_author_only = not title and not doi and bool(author_id)
    if not title and not doi and not author_id:
        return {
            "ok": False,
            "code": "bad_payload",
            "message": "Enter a title or DOI, or set your Scopus author link, to search",
            "author_id": None,
            "candidates": [],
        }

    limit = max(1, min(payload.limit or 10, 25))
    try:
        if by_author_only:
            # Newest first — a claim is nearly always for a recent paper.
            found = search_candidates(author_id=author_id, limit=limit, sort="-coverDate")
            linked_eids = {str(c.get("eid")) for c in found if c.get("eid")}
        else:
            found = search_candidates(title=title or None, doi=doi, limit=limit)
            linked_eids = set()
            if author_id and found:
                linked = search_candidates(
                    title=title or None, doi=doi, author_id=author_id, limit=limit
                )
                linked_eids = {str(c.get("eid")) for c in linked if c.get("eid")}
    except ScopusError as e:
        raise HttpError(502, f"{e.code}: {e}")

    # Rule 2 of the submission conditions is one claim per article, and the
    # claimant cannot see their own filed tickets from here — so say it on the row.
    dois = [d for d in (c.get("doi") for c in found) if d]
    eids = [e for e in (c.get("eid") for c in found) if e]
    claimed_q = Q()
    if dois:
        claimed_q |= Q(doi__in=dois)
    if eids:
        claimed_q |= Q(eid__in=eids)
    claimed_dois: set[str] = set()
    claimed_eids: set[str] = set()
    if claimed_q:
        # Only an admin proxy may ask about someone else's claims; for anyone
        # else owner_id is ignored rather than trusted.
        owner = user.id
        if payload.owner_id and rbac.can_clear_claims(user.role):
            owner = payload.owner_id
        for c in Claim.objects.filter(claimed_q, owner_id=owner).exclude(
            status=ClaimStatus.REJECTED
        ).only("doi", "eid"):
            if c.doi:
                claimed_dois.add(c.doi)
            if c.eid:
                claimed_eids.add(c.eid)

    candidates = [
        {
            "title": c.get("title"),
            "doi": c.get("doi"),
            "issn": c.get("issn"),
            "eid": c.get("eid"),
            "journal_title": c.get("journal_title"),
            "publication_year": c.get("publication_year"),
            "cover_date": c.get("cover_date"),
            "aggregation_type": c.get("aggregation_type"),
            "author_count": c.get("author_count"),
            "scopus_url": c.get("scopus_url"),
            # None (not False) when we have no author ID to check against, so the
            # UI can say "unknown" instead of wrongly claiming "not linked".
            "linked_to_author": (str(c.get("eid")) in linked_eids) if author_id else None,
            "already_claimed": bool(
                (c.get("doi") and c["doi"] in claimed_dois)
                or (c.get("eid") and c["eid"] in claimed_eids)
            ),
        }
        for c in found
    ]
    return {
        "ok": bool(candidates),
        "code": "ok" if candidates else "not_found",
        "message": None
        if candidates
        else (
            "No papers found on that Scopus author profile"
            if by_author_only
            else "No Scopus record matched that search"
        ),
        "author_id": author_id,
        "by_author": by_author_only,
        "candidates": candidates,
    }


def _empty_enrich(*, code: str, message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "code": code,
        "message": message,
        "paper": None,
        "serial": None,
        "scimago": None,
        "matched_title": None,
        "doi": None,
        "issn": None,
        "eid": None,
        "journal": None,
        "cover_date": None,
        "publication_year": None,
        "aggregation_type": None,
        "author_count": None,
        "snip": None,
        "snip_year": None,
        "quartile": None,
        "subject_category": None,
        "scimago_found": False,
    }


def _pack_enrich(paper: dict[str, Any] | None, serial: dict[str, Any] | None, scimago: dict[str, Any] | None) -> dict[str, Any]:
    paper = paper or {}
    serial = serial or {}
    scimago = scimago or {}
    found_scimago = bool(scimago.get("found"))
    return {
        "ok": True,
        "code": "ok",
        "message": None,
        "paper": paper or None,
        "serial": serial or None,
        "scimago": scimago or None,
        "matched_title": paper.get("title"),
        "doi": paper.get("doi"),
        "issn": paper.get("issn") or serial.get("issn") or scimago.get("issn"),
        "eid": paper.get("eid"),
        "journal": paper.get("journal_title") or serial.get("journal_title") or scimago.get("title"),
        "cover_date": paper.get("cover_date"),
        "publication_year": paper.get("publication_year"),
        "aggregation_type": paper.get("aggregation_type"),
        "author_count": paper.get("author_count"),
        "snip": serial.get("snip"),
        "snip_year": serial.get("snip_year"),
        "quartile": scimago.get("matched_quartile") if found_scimago else None,
        "subject_category": scimago.get("matched_category") if found_scimago else None,
        "scimago_found": found_scimago,
    }


@api.post("/lookup/enrich", auth=session_auth)
def lookup_enrich(request: HttpRequest, payload: ScopusLookupIn):
    """One-shot: Scopus paper + SNIP + Scimago quartile for the claim form.

    DOI or title finds the article. ISSN alone still fills journal, SNIP, and quartile.
    """
    require_user(request)
    issn = normalize_issn(payload.issn) if payload.issn else None
    if not payload.doi and not payload.title and not issn:
        return _empty_enrich(code="bad_payload", message="Provide DOI, title, or ISSN")
    try:
        paper = lookup_paper_by_doi(payload.doi) if payload.doi else None
        if not paper and payload.title:
            paper, _ = search_by_title(payload.title)
        issn = (paper.get("issn") if paper else None) or issn
        serial = lookup_serial_by_issn(issn) if issn else None
        scimago = lookup_scimago(
            issn=issn,
            title=(paper.get("journal_title") if paper else None) or payload.title,
            subject=None,
        )
        if not paper and not serial and not (scimago and scimago.get("found")):
            return _empty_enrich(code="not_found", message="Not found in Scopus")
        return _pack_enrich(paper, serial, scimago)
    except ScopusError as e:
        raise HttpError(502, f"{e.code}: {e}")


@api.post("/lookup/scimago", auth=session_auth)
def lookup_scimago_api(request: HttpRequest, payload: ScimagoLookupIn):
    require_user(request)
    result = lookup_scimago(
        issn=payload.issn, title=payload.title, year=payload.year, subject=payload.subject
    )
    if result is None:
        from core.services.scimago import scimago_official_search_url

        return {
            "found": False,
            "matched_quartile": None,
            "official_url": scimago_official_search_url(issn=payload.issn, title=payload.title),
            "message": "No match in imported Scimago dump — import CSV or set quartile manually",
        }
    return result


@api.post("/lookup/verify", auth=session_auth)
def lookup_verify(request: HttpRequest, payload: VerifyIn):
    require_user(request)
    if not (payload.title or "").strip():
        raise HttpError(400, "Title is required")
    return verify_publication(
        title=payload.title.strip(),
        scopus_author_url=payload.scopus_author_url,
        scopus_author_id=payload.scopus_author_id,
        issn=payload.issn,
        staff_id=payload.staff_id,
        exclude_claim_id=payload.exclude_claim_id,
    )


def _zero_payout_note(payload: CalcIn, result, cfg) -> str | None:
    """Why a valid calculation still came out at nothing.

    "Base Amount: Rs. 0.00" with no error next to it reads as a broken formula.
    Every zero here is a policy outcome, so name which one it was.
    """
    if result.error or result.remuneration is None or result.remuneration > 0:
        return None
    if payload.is_student_publication:
        return (
            "Count-only submissions carry no incentive — the ticket still runs through "
            "approval so the publication is counted."
        )
    q = (payload.quartile or "").strip()
    snip = payload.snip
    if q == "NO_SNIP":
        return "The quartile is set to NO_SNIP, whose quartile factor is zero in the active policy."
    if not snip:
        qf = result.qf or 0
        if qf == 0:
            return (
                f"SNIP is {snip if snip is not None else 'empty'} and the quartile factor for "
                f"{q or 'this quartile'} is ₹0 in the active policy, so SNIP × "
                f"{(cfg.snip_multiplier if cfg else 55000):g} + QF comes to zero."
            )
        return "SNIP is zero, so the amount is the quartile factor alone."
    return "The active policy produces no payable amount for this combination."


@api.post("/calculate", auth=session_auth)
def calculate(request: HttpRequest, payload: CalcIn):
    require_user(request)
    cfg_obj = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = formula_from_model(cfg_obj) if cfg_obj else None
    result = calculate_remuneration(
        payload.snip,
        payload.quartile,
        payload.total_authors,
        payload.author_position,
        cfg,
        is_student_publication=payload.is_student_publication,
        publication_type=payload.publication_type,
        indexing_level=payload.indexing_level,
        engineering_class=payload.engineering_class,
        sec_reference_count=payload.sec_reference_count,
    )
    return {
        "base": result.base,
        "point": result.point,
        "remuneration": result.remuneration,
        "qf": result.qf,
        "error": result.error,
        # The engine now explains itself; _zero_payout_note stays as a fallback
        # for combinations it has nothing to say about.
        "note": result.note or _zero_payout_note(payload, result, cfg),
        "category": result.category,
        "category_label": CATEGORY_LABELS.get(result.category or "", None),
        "policy": snapshot_formula(cfg) if cfg else None,
    }


@api.post("/prior/check", auth=session_auth)
def prior_check(request: HttpRequest, payload: PriorCheckIn):
    require_user(request)
    result = check_already_paid(
        title=payload.title,
        doi=payload.doi,
        staff_id=payload.staff_id,
        exclude_claim_id=payload.exclude_claim_id,
    )
    return result


MAX_UPLOAD_BYTES = 10 * 1024 * 1024


@api.post("/claims/upload", auth=session_auth)
def upload_claim_file(request: HttpRequest, file: UploadedFile = File(...)):
    """Store one evidence file, identified by its own bytes.

    The old check was `name.endswith(".pdf")`, which accepted anything renamed
    and rejected the scans and photos people actually hold. Sniffing decides
    both whether we take the file and what extension it is stored under, so
    what comes back out is what went in.
    """
    user = require_user(request)
    if not rbac.can_issue_claims(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read()
    if not content:
        raise HttpError(400, "That file is empty")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HttpError(400, "File too large (max 10MB)")

    kind = sniff(content)
    if kind is None:
        raise HttpError(
            400,
            f"That file is not a {ACCEPTED_LABEL}. "
            "Renaming a file does not change its type — export or scan it instead.",
        )

    # Through the storage API, not open(): the same code then writes to the
    # local disk in development and to Google Cloud Storage in production,
    # where the container filesystem does not survive a deploy.
    fname = f"{uuid_lib.uuid4().hex}.{kind.extension}"
    default_storage.save(f"claims/{fname}", ContentFile(content))
    return {
        "url": f"{settings.MEDIA_URL}claims/{fname}",
        # The claimant's own name, shown in the UI; the stored name is a uuid.
        "filename": (file.name or f"document.{kind.extension}")[:255],
        "size_bytes": len(content),
        "content_type": kind.content_type,
        "kind_label": kind.label,
    }


@api.get("/meta/departments", auth=session_auth)
def list_departments(request: HttpRequest):
    """Departments actually present in the faculty master — keeps the picker honest."""
    require_user(request)
    names = set()
    for source in (
        FacultyMaster.objects.values_list("department", flat=True),
        User.objects.filter(role=Role.FACULTY).values_list("department", flat=True),
    ):
        for d in source:
            if d and d.strip():
                names.add(d.strip())
    return sorted(names)


# ---------- claims ----------


def _claims_queryset(user: User):
    """Claims this user may see.

    A draft is unsubmitted, half-typed work that its author has not shown to
    anyone yet, so nobody else sees it — not an admin, not the Principal. The
    oversight portals list whole pipelines, which is exactly the view that would
    otherwise expose them.
    """
    qs = (
        Claim.objects.select_related(
            "owner", "manual_verified_by", "cleared_by", "second_approved_by"
        )
        .prefetch_related("attachments")
        .all()
    )
    if rbac.can_view_college_wide(user.role):
        return qs.filter(~Q(status=ClaimStatus.DRAFT) | Q(owner=user))
    return qs.filter(owner=user)


def _apply_calc(claim: Claim, *, allow_self_reported: bool = False) -> None:
    """Recompute the money columns.

    `allow_self_reported` lets a draft show an estimate from the claimant's own
    SNIP/quartile declarations. Every path that moves money — submit, verify,
    clear, pay — computes from the server-verified columns only.
    """
    cfg_obj = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = formula_from_model(cfg_obj) if cfg_obj else None
    # publication_type carries the full set; aggregation_type is the ERP's single
    # value and would hide a second type from the category rules.
    pub_type = claim.publication_type or claim.aggregation_type
    # Only citations the claimant actually evidenced count towards the minimum.
    sec_refs = (
        claim.attachments.filter(kind=AttachmentKind.SEC_REFERENCE)
        .exclude(ref_number__isnull=True)
        .exclude(ref_number="")
        .count()
        if claim.pk
        else None
    )
    snip = claim.snip
    quartile = claim.quartile
    if allow_self_reported:
        if snip is None:
            snip = claim.self_reported_snip
        if not quartile:
            quartile = claim.self_reported_quartile
    result = calculate_remuneration(
        snip,
        quartile,
        claim.total_authors,
        claim.author_position,
        cfg,
        is_student_publication=claim.is_student_publication,
        publication_type=pub_type,
        indexing_level=claim.indexing_level,
        engineering_class=claim.engineering_class,
        sec_reference_count=sec_refs,
    )
    claim.base_amount = result.base
    claim.author_point = result.point
    claim.remuneration = result.remuneration
    claim.qf_amount = result.qf
    claim.calc_error = result.error
    claim.remuneration_category = result.category
    claim.remuneration_note = result.note
    if cfg_obj and cfg:
        claim.formula_config = cfg_obj
        claim.formula_snapshot_json = json.dumps(snapshot_formula(cfg))
    elif cfg:
        claim.formula_snapshot_json = json.dumps(snapshot_formula(cfg))


_CLAIM_SORTS = {
    "recent": "-updated_at",
    "amount": "-remuneration",
    "title": "paper_title",
}


@api.get("/claims", auth=session_auth)
def list_claims(
    request: HttpRequest,
    status: Optional[str] = None,
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
):
    """Paginated. The old shape silently truncated at 200 rows — beyond that,
    tickets simply did not exist as far as the UI was concerned."""
    user = require_user(request)
    qs = _claims_queryset(user)
    if status:
        qs = qs.filter(status=status)
    qs = qs.order_by(_CLAIM_SORTS.get(sort, "-updated_at"))
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in qs[offset : offset + limit]],
    }


@api.get("/claims/{claim_id}", auth=session_auth)
def get_claim(request: HttpRequest, claim_id: str):
    user = require_user(request)
    claim = get_object_or_404(_claims_queryset(user), pk=claim_id)
    actions = [
        {
            "id": a.id,
            "action": a.action,
            "from_status": a.from_status,
            "to_status": a.to_status,
            "note": a.note,
            "actor_name": a.actor.name,
            "created_at": a.created_at.isoformat(),
        }
        for a in claim.actions.select_related("actor").order_by("created_at")
    ]
    data = claim_to_dict(claim)
    data["actions"] = actions
    return data


@api.post("/claims", auth=session_auth)
def create_claim(request: HttpRequest, payload: ClaimIn):
    user = require_user(request)
    owner = user
    admin_proxy = False

    if payload.owner_id:
        if not rbac.can_clear_claims(user.role):
            raise HttpError(403, "Only admin can submit on behalf of faculty")
        owner = get_object_or_404(User, pk=payload.owner_id, role=Role.FACULTY, active=True)
        admin_proxy = True
    elif not rbac.can_issue_claims(user.role):
        raise HttpError(403, "Only faculty can create tickets")
    elif rbac.can_clear_claims(user.role) and not payload.owner_id:
        raise HttpError(400, "Select a faculty member to submit on their behalf")

    # Validate before any write, so a rejected attachment set cannot leave a
    # half-created claim behind.
    attachments = _validated_attachments(payload)

    claim = Claim(owner=owner)
    _apply_faculty_payload(claim, payload)
    _bind_identity_from_user(claim, owner, payload)

    paid_check = check_already_paid(
        title=claim.paper_title,
        doi=claim.doi,
        staff_id=claim.staff_id,
        exclude_claim_id=None,
    )
    claim.duplicate_warning = bool(paid_check.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid_check.get("matches") or [])

    _apply_calc(claim, allow_self_reported=True)
    # Persist the claim and its files first: the submission gate reads the stored
    # attachments, so syncing afterwards made an attachments-only payload fail.
    claim.save()
    _persist_attachments(claim, attachments, user)

    if payload.submit:
        _submit_claim(claim, user, contest=bool(payload.contest_forward), contest_note=payload.contest_note)
    else:
        ClaimAction.objects.create(
            claim=claim,
            actor=user,
            from_status=None,
            to_status=claim.status,
            action="ADMIN_CREATE" if admin_proxy else "CREATE_DRAFT",
            note=f"submitted_by={user.email}" if admin_proxy else None,
        )
    return claim_to_dict(claim)


_ANNEXURE_LEVELS = {"AU Annexure", "UGC Care"}


def _check_mandatory_fields(claim: Claim) -> None:
    """Rules the claim form itself imposes, independent of Scopus verification."""
    missing: list[str] = []
    if not (claim.journal_title or "").strip():
        missing.append("Journal name")
    if not (claim.issn or "").strip():
        missing.append("ISSN")
    if not (claim.publication_date or "").strip():
        missing.append("Date of publication")
    if not (claim.indexing_level or "").strip():
        missing.append("Journal indexing level")
    if not (claim.yukthi_id or "").strip():
        missing.append("Yukthi ID")
    if not (claim.scopus_author_url or "").strip():
        missing.append("Author Scopus link")
    if not (claim.sec_refs or "").strip():
        missing.append("Reference numbers with SEC affiliation")
    if missing:
        raise HttpError(400, "Complete these before submitting: " + ", ".join(missing))

    # A journal is often listed in several places at once — Scopus and UGC Care,
    # say — so indexing_level holds a comma-separated set, and any annexure
    # among them needs its reference number.
    selected = [p.strip() for p in (claim.indexing_level or "").split(",") if p.strip()]
    # Two separate registers, so two separate numbers — one shared box could
    # only ever carry one of them.
    for level, value in (
        ("AU Annexure", claim.au_annexure_ref),
        ("UGC Care", claim.ugc_care_ref),
    ):
        if level in selected and not (value or "").strip():
            raise HttpError(
                400, f"{level} requires its reference number (enter NA if none)"
            )

    if not claim.affiliation_ok:
        raise HttpError(400, "The article must be affiliated to Saveetha Engineering College")

    if claim.author_position > claim.total_authors:
        raise HttpError(400, "Author position cannot exceed the total number of authors")

    kinds = set(claim.attachments.values_list("kind", flat=True)) if claim.pk else set()
    has_paper = AttachmentKind.PUBLISHED_PAPER in kinds or bool((claim.proof_url or "").strip())
    has_refs = AttachmentKind.SEC_REFERENCE in kinds or bool((claim.sec_proof_url or "").strip())
    if not has_paper:
        raise HttpError(400, "Upload the full-length published paper (PDF)")
    if not has_refs:
        raise HttpError(400, "Upload at least one cited reference with SEC affiliation (PDF)")


def _submit_claim(claim: Claim, user: User, *, contest: bool, contest_note: str | None) -> None:
    if not (claim.paper_title or "").strip():
        raise HttpError(400, "Paper title is required")
    _check_mandatory_fields(claim)

    result = verify_publication(
        title=claim.paper_title or "",
        scopus_author_url=claim.scopus_author_url,
        scopus_author_id=claim.scopus_author_id,
        issn=claim.issn,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id if claim.pk else None,
    )
    apply_verify_to_claim(claim, result)
    _apply_calc(claim)

    # Faculty-provided ranking is enough — no vendor checklist for the user
    if claim.quartile and not claim.scimago_verified:
        if not (claim.manual_quartile_reason or "").strip():
            claim.manual_quartile_reason = "Faculty-provided journal details"

    # A missing quartile is already one of the contestable verification issues, so
    # it falls through to the "Could not auto-confirm" response below. Raising a
    # separate message here produced wording the client could not recognise, and
    # the user was told to send a note by an error that offered no way to do so.
    issues = _verification_issues(result, claim)
    if claim.duplicate_warning and not claim.override_duplicate and not contest:
        issues.append("Payment history may already include this paper")

    snapshot = {
        "issues": issues,
        "scopus": result.get("scopus"),
        "scimago": result.get("scimago"),
        "paid": result.get("paid"),
        "snip": result.get("snip"),
    }
    claim.verification_snapshot_json = json.dumps(snapshot)
    claim.verification_ok = len(issues) == 0
    claim.contest_forward = bool(contest) and len(issues) > 0

    if issues and not contest:
        raise HttpError(
            400,
            "Could not auto-confirm: "
            + "; ".join(issues)
            + ". Edit details, or send with a short note.",
        )

    if contest and issues:
        if not contest_note or len(contest_note.strip()) < 10:
            raise HttpError(400, "Add a short note (10+ characters) to send anyway")
        claim.contest_note = contest_note.strip()
        if claim.duplicate_warning:
            claim.override_duplicate = True
            claim.override_reason = claim.override_reason or contest_note.strip()

    # assign_ticket_number retries on collision; next_ticket_number alone races,
    # because the row lock is released before the claim is written. Two people
    # submitting in the same instant got an IntegrityError and a lost claim.
    assign_ticket_number(claim)

    claim.status = ClaimStatus.SUBMITTED
    claim.submitted_at = timezone.now()
    claim.save()
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=ClaimStatus.DRAFT,
        to_status=ClaimStatus.SUBMITTED,
        action="CONTEST_FORWARD" if claim.contest_forward else "SUBMIT",
        note=claim.contest_note,
    )
    headline = f"{'Needs review: ' if claim.contest_forward else ''}{claim.paper_title}"
    _notify_admins(claim, f"To clear · {claim.ticket_number}", headline)


@api.patch("/claims/{claim_id}", auth=session_auth)
def patch_claim(request: HttpRequest, claim_id: str, payload: ClaimIn):
    user = require_user(request)
    claim = get_object_or_404(Claim, pk=claim_id, owner=user)
    if claim.status not in (ClaimStatus.DRAFT, ClaimStatus.REJECTED):
        raise HttpError(400, "Only draft/rejected claims can be edited")
    attachments = _validated_attachments(payload)
    _apply_faculty_payload(claim, payload)
    _bind_identity_from_user(claim, user, payload)
    paid_check = check_already_paid(
        title=claim.paper_title,
        doi=claim.doi,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id,
    )
    claim.duplicate_warning = bool(paid_check.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid_check.get("matches") or [])
    _apply_calc(claim, allow_self_reported=True)
    # Files land before the submission gate reads them.
    claim.save()
    _persist_attachments(claim, attachments, user)
    if payload.submit:
        from_status = claim.status
        claim.status = ClaimStatus.DRAFT
        _submit_claim(
            claim,
            user,
            contest=bool(payload.contest_forward),
            contest_note=payload.contest_note,
        )
        if from_status == ClaimStatus.REJECTED:
            ClaimAction.objects.create(
                claim=claim,
                actor=user,
                from_status=from_status,
                to_status=ClaimStatus.SUBMITTED,
                action="RESUBMIT",
                note=payload.contest_note,
            )
    return claim_to_dict(claim)


def _faculty_status_copy(to_status: str, note: str | None = None) -> tuple[str, str]:
    """Short faculty-facing notification title/body — no internal process detail."""
    if to_status == ClaimStatus.CLEARED:
        return (
            "Cleared — with Finance",
            "Your ticket has been cleared and is with Finance for payment.",
        )
    if to_status == ClaimStatus.HOD_APPROVED:
        return ("Approved by HoD", "Your ticket was approved by HoD and is with the Principal.")
    if to_status == ClaimStatus.PRINCIPAL_APPROVED:
        return (
            "Approved — payment ordered",
            "Your ticket is approved. Finance has been ordered to process the payment.",
        )
    if to_status == ClaimStatus.PAID:
        return (
            "Payment processed",
            "Your remuneration has been processed by Finance.",
        )
    if to_status == ClaimStatus.REJECTED:
        return (
            "Needs changes",
            note or "Your ticket was sent back. Edit the details and submit again.",
        )
    return (f"Ticket update", note or f"Status is now {to_status}")


def _transition(claim: Claim, user: User, to_status: str, action: str, note: str | None = None):
    from_status = claim.status
    claim.status = to_status
    if to_status == ClaimStatus.PAID:
        claim.paid_at = timezone.now()
    claim.save()
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=from_status,
        to_status=to_status,
        action=action,
        note=note,
    )
    AuditLog.objects.create(
        actor=user,
        action=action,
        entity="Claim",
        entity_id=claim.id,
        detail_json=json.dumps(
            {
                "from": from_status,
                "to": to_status,
                "ticket": claim.ticket_number,
                "note": note,
            }
        ),
    )
    logger.info(
        "claim_transition ticket=%s action=%s from=%s to=%s actor=%s",
        claim.ticket_number,
        action,
        from_status,
        to_status,
        user.email,
    )
    title, body = _faculty_status_copy(to_status, note)
    Notification.objects.create(
        user=claim.owner,
        title=f"{claim.ticket_number or 'Ticket'} · {title}",
        body=body,
        href=f"/faculty?claim={claim.id}",
        claim_id=claim.id,
    )
    send_optional_email(
        claim.owner.email,
        f"{claim.ticket_number or 'Ticket'} · {title}",
        body,
    )


#: Display-path cache for the second-approval threshold, so serializing a
#: 200-row list does not query the policy 200 times. Money guards always read
#: fresh; put_formula invalidates.
_THRESHOLD_CACHE: dict[str, float] = {}


def _invalidate_threshold_cache() -> None:
    _THRESHOLD_CACHE.clear()


def _high_value_threshold(*, fresh: bool = True) -> float:
    if not fresh and "value" in _THRESHOLD_CACHE:
        return _THRESHOLD_CACHE["value"]
    cfg = (
        FormulaConfig.objects.filter(active=True)
        .order_by("-updated_at")
        .only("high_value_threshold")
        .first()
    )
    value = float(cfg.high_value_threshold) if cfg else 100000.0
    _THRESHOLD_CACHE["value"] = value
    return value


def _needs_second_approval(claim: Claim, threshold: float | None = None) -> bool:
    """High-value live-chain claims need a second, distinct pair of eyes."""
    if claim.status != ClaimStatus.CLEARED:
        return False
    if (claim.remuneration or 0) < (threshold if threshold is not None else _high_value_threshold()):
        return False
    return not (claim.second_approved_by_id and claim.second_approved_by_id != claim.cleared_by_id)


def _guard_recomputed_amount(claim: Claim, expected: float | None) -> None:
    """Recompute the money columns from the stored verified values and refuse
    to move money unless the actor confirmed exactly this amount.

    The recomputation mutates the claim; callers run inside the same
    transaction that performs the transition, so a refused action rolls the
    recalculation back too.
    """
    _apply_calc(claim)
    amount = round(claim.remuneration or 0, 2)
    if expected is None or abs(amount - round(float(expected), 2)) > 0.01:
        raise HttpError(
            409,
            f"The recomputed amount is ₹{amount:,.2f}. Review it and confirm again — "
            "money only moves at a confirmed amount.",
        )


def _reverify_or_recalc(claim: Claim, user, *, skip_external: bool) -> None:
    """Refresh verified values from Scopus, or recompute from stored ones.

    Mutates the claim in place and does not save — callers that move money
    do so in the same transaction so a later 409 rolls the refresh back.
    Scopus down raises 502 and leaves the claim untouched.
    """
    if skip_external:
        if user.role != Role.SUPER_ADMIN:
            raise HttpError(403, "Only a super admin may skip external verification")
        previous = claim.remuneration
        _apply_calc(claim)
        AuditLog.objects.create(
            actor=user,
            action="CLAIM_RECALC_SKIP_EXTERNAL",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps({"previous": previous, "recomputed": claim.remuneration}),
        )
        return
    result = verify_publication(
        title=claim.paper_title or "",
        scopus_author_url=claim.scopus_author_url,
        scopus_author_id=claim.scopus_author_id,
        issn=claim.issn,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id,
    )
    if not result.get("ok"):
        raise HttpError(
            502,
            "Scopus could not be reached, so the values were not refreshed. "
            "Try again shortly; a super admin can recalculate from stored values.",
        )
    apply_verify_to_claim(claim, result)
    _apply_calc(claim)


@api.post("/claims/{claim_id}/recalculate", auth=session_auth)
def recalculate_claim(request: HttpRequest, claim_id: str, payload: Optional[RecalcIn] = None):
    """Re-verify against Scopus/Scimago and recompute the amount.

    The clearing and pay UIs call this first, show the fresh amount, and then
    confirm with `expected_amount`. clear / mark-paid re-verify again so a
    stale tab or a raw API call cannot pay yesterday's number.
    """
    user = require_user(request)
    if not (rbac.can_clear_claims(user.role) or rbac.can_approve_as_finance(user.role)):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    if claim.status == ClaimStatus.PAID:
        raise HttpError(400, "Claim is already paid — re-verifying would change a settled amount")
    previous = claim.remuneration
    _reverify_or_recalc(claim, user, skip_external=bool(payload and payload.skip_external))
    claim.save()
    changed = round(previous or 0, 2) != round(claim.remuneration or 0, 2)
    return {
        "remuneration": claim.remuneration,
        "previous": previous,
        "changed": changed,
        "base_amount": claim.base_amount,
        "qf_amount": claim.qf_amount,
        "remuneration_category": claim.remuneration_category,
        "remuneration_note": claim.remuneration_note,
        "calc_error": claim.calc_error,
    }


@api.post("/claims/{claim_id}/clear", auth=session_auth)
def clear_claim(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Admin clearing — the one approval between submission and payment.

    Re-verifies against Scopus inside the same transaction, then clears only
    if the approver confirmed exactly the fresh amount. A Scopus outage
    returns 502 and leaves the ticket submitted; a super admin may pass
    skip_external to recompute from stored values instead.
    """
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.SUBMITTED:
            raise HttpError(400, "Only a submitted ticket can be cleared")
        _reverify_or_recalc(claim, user, skip_external=bool(payload.skip_external))
        _guard_recomputed_amount(claim, payload.expected_amount)
        claim.cleared_by = user
        _transition(claim, user, ClaimStatus.CLEARED, "CLEAR", payload.note)
        amount = claim.remuneration or 0
    _notify_finance(
        claim,
        f"Cleared for payment · {claim.ticket_number}",
        f"₹{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
    )
    return claim_to_dict(claim)


class BulkClearIn(Schema):
    claim_ids: list[str]
    note: Optional[str] = None


# Under /admin, not /claims: "/claims/bulk-clear" is swallowed by the
# "/claims/{claim_id}" route registered above it and answers 405.
@api.post("/admin/bulk-clear", auth=session_auth)
def bulk_clear(request: HttpRequest, payload: BulkClearIn):
    """Clear a batch of submitted tickets.

    The queue is routinely dozens of straightforward tickets; opening each one
    to press the same button is the bulk of the clearing effort. Each ticket is
    still transitioned individually so one bad row cannot take the batch down,
    and every one gets its own action and audit entry.

    Bulk does not re-hit Scopus (200 rows would time out). It recomputes from
    stored verified values and skips any row whose amount drifted.
    """
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    ids = list(dict.fromkeys(payload.claim_ids or []))[:200]
    if not ids:
        raise HttpError(400, "Select at least one ticket")

    cleared: list[str] = []
    skipped: list[dict[str, str]] = []
    for claim_id in ids:
        try:
            with transaction.atomic():
                claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
                if claim is None:
                    skipped.append({"id": claim_id, "reason": "Not found"})
                    continue
                if claim.status != ClaimStatus.SUBMITTED:
                    skipped.append(
                        {"id": claim_id, "reason": f"Status is {claim.status}, not SUBMITTED"}
                    )
                    continue
                # Same guard as a single clear, with the stored amount standing
                # in for the confirmation: a row whose recomputed amount drifted
                # from what the screen showed is skipped, never silently cleared
                # at a different figure.
                shown = claim.remuneration
                _apply_calc(claim)
                if round(shown or 0, 2) != round(claim.remuneration or 0, 2):
                    skipped.append(
                        {
                            "id": claim_id,
                            "reason": (
                                f"{claim.ticket_number or claim_id}: amount changed on recalculation "
                                f"(₹{(shown or 0):,.0f} → ₹{(claim.remuneration or 0):,.0f}) — open it to review"
                            ),
                        }
                    )
                    # Roll this row back so the recalculated figures are not
                    # half-committed outside a clear.
                    transaction.set_rollback(True)
                    continue
                claim.cleared_by = user
                _transition(claim, user, ClaimStatus.CLEARED, "CLEAR", payload.note)
                amount = claim.remuneration or 0
            _notify_finance(
                claim,
                f"Cleared for payment · {claim.ticket_number}",
                f"₹{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
            )
            cleared.append(claim_id)
        except Exception as e:  # one bad ticket must not sink the batch
            logger.exception("bulk_clear_failed id=%s", claim_id)
            skipped.append({"id": claim_id, "reason": str(e)[:120]})
    return {"cleared": len(cleared), "skipped": skipped}


# Retired chain. Kept so an old client gets an explanation rather than a 404.
_RETIRED_STEP = (
    "That approval step no longer exists. A submitted ticket is cleared by the "
    "admin, then paid by Finance."
)


@api.post("/claims/{claim_id}/hod-approve", auth=session_auth)
def hod_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """The HoD role was removed from the system entirely."""
    require_user(request)
    raise HttpError(400, _RETIRED_STEP)


@api.post("/claims/{claim_id}/principal-approve", auth=session_auth)
def principal_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    require_user(request)
    raise HttpError(400, _RETIRED_STEP)


@api.post("/claims/{claim_id}/approve", auth=session_auth)
def admin_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Legacy generic approve — now means "clear"."""
    return clear_claim(request, claim_id, payload)


@api.post("/claims/{claim_id}/research-approve", auth=session_auth)
def research_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    return clear_claim(request, claim_id, payload)


@api.post("/claims/{claim_id}/finance-approve", auth=session_auth)
def finance_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """No separate finance approve hop — a cleared ticket is marked paid."""
    raise HttpError(400, "Finance marks a cleared ticket paid directly")


def _mark_one_paid(
    claim_id: str,
    user: User,
    *,
    voucher_number: str | None,
    note: str | None,
    expected_amount: float | None,
    skip_external: bool = False,
    reverify: bool = True,
) -> Claim:
    """One payment, atomically, with every guard. Raises HttpError on refusal.

    `reverify=False` is for bulk mark-paid: that path recomputes from stored
    values only so a 200-row payout month does not make 200 Scopus calls.
    """
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status not in PAYABLE_STATUSES:
            raise HttpError(400, "Invalid status — the ticket must be cleared first")
        # Net of the ledger, not mere existence: a voided payment leaves a
        # reversing row behind, and the claim must be payable again.
        net_paid = claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
        if net_paid > 0:
            raise HttpError(400, "Already processed")
        if claim.status == ClaimStatus.CLEARED:
            # Live chain: re-verify (unless bulk) then require the confirmed
            # amount. Legacy ERP-imported statuses are paid at their imported
            # figures — they have no verified columns to recompute from.
            if _needs_second_approval(claim):
                raise HttpError(
                    400,
                    "High-value claim — a second approver (different from the person "
                    "who cleared it) must approve before payment",
                )
            if reverify:
                _reverify_or_recalc(claim, user, skip_external=skip_external)
            _guard_recomputed_amount(claim, expected_amount)
        if voucher_number:
            claim.voucher_number = voucher_number[:64]
        _transition(claim, user, ClaimStatus.PAID, "MARK_PAID", note)
        payout = claim.payout_month
        if not payout:
            today = timezone.now().date()
            payout = date(today.year, today.month, 1)
            claim.payout_month = payout
            claim.save(update_fields=["payout_month"])
        PaidLedger.objects.create(
            claim=claim,
            payout_month=payout,
            department=claim.owner.department,
            faculty_name=claim.owner.name,
            staff_id=claim.staff_id or claim.owner.staff_id,
            biometric_id=claim.biometric_id or claim.owner.biometric_id,
            paper_title=claim.paper_title,
            journal_title=claim.journal_title,
            amount=claim.remuneration or 0,
            voucher_number=claim.voucher_number or voucher_number,
        )
    return claim


@api.post("/claims/{claim_id}/mark-paid", auth=session_auth)
def mark_paid(request: HttpRequest, claim_id: str, payload: ActionIn):
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    claim = _mark_one_paid(
        claim_id,
        user,
        voucher_number=payload.voucher_number,
        note=payload.note,
        expected_amount=payload.expected_amount,
        skip_external=bool(payload.skip_external),
    )
    return claim_to_dict(claim)


class BulkMarkPaidItem(Schema):
    claim_id: str
    voucher_number: Optional[str] = None
    expected_amount: Optional[float] = None


class BulkMarkPaidIn(Schema):
    items: list[BulkMarkPaidItem]
    note: Optional[str] = None


@api.post("/admin/bulk-mark-paid", auth=session_auth)
def bulk_mark_paid(request: HttpRequest, payload: BulkMarkPaidIn):
    """Pay a reviewed batch in one action.

    A 200-claim payout month used to be 200 separate confirm dialogs. Every
    row still goes through the full single-payment guards individually — an
    amount that drifted, a missing second approval, or an already-paid row is
    skipped with its reason, never silently paid.

    Bulk does not re-hit Scopus (that would time out). It recomputes from
    stored verified values and skips any row whose amount drifted.
    """
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    items = (payload.items or [])[:200]
    if not items:
        raise HttpError(400, "Select at least one payment")
    seen: set[str] = set()
    paid: list[str] = []
    skipped: list[dict[str, str]] = []
    for item in items:
        if item.claim_id in seen:
            continue
        seen.add(item.claim_id)
        try:
            claim = _mark_one_paid(
                item.claim_id,
                user,
                voucher_number=item.voucher_number,
                note=payload.note,
                expected_amount=item.expected_amount,
                reverify=False,
            )
            paid.append(claim.id)
        except HttpError as e:
            skipped.append({"id": item.claim_id, "reason": str(e)[:160]})
        except Exception as e:  # one bad row must not sink the batch
            logger.exception("bulk_mark_paid_failed id=%s", item.claim_id)
            skipped.append({"id": item.claim_id, "reason": str(e)[:160]})
    return {"paid": len(paid), "paid_ids": paid, "skipped": skipped}


@api.post("/claims/{claim_id}/second-approve", auth=session_auth)
def second_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Second signature on a high-value cleared claim.

    Must come from someone other than the person who cleared it — the whole
    point is a second pair of eyes on large amounts.
    """
    user = require_user(request)
    if not (rbac.can_clear_claims(user.role) or user.role == Role.PRINCIPAL):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.CLEARED:
            raise HttpError(400, "Only a cleared ticket can be second-approved")
        threshold = _high_value_threshold()
        if (claim.remuneration or 0) < threshold:
            raise HttpError(
                400, f"Below the second-approval threshold (₹{threshold:,.0f}) — no second signature needed"
            )
        if claim.cleared_by_id == user.id:
            raise HttpError(400, "The second approver must be a different person from the one who cleared it")
        if claim.second_approved_by_id:
            raise HttpError(400, "Already second-approved")
        claim.second_approved_by = user
        claim.second_approved_at = timezone.now()
        claim.save(update_fields=["second_approved_by", "second_approved_at"])
        ClaimAction.objects.create(
            claim=claim,
            actor=user,
            from_status=claim.status,
            to_status=claim.status,
            action="SECOND_APPROVE",
            note=payload.note,
        )
        AuditLog.objects.create(
            actor=user,
            action="CLAIM_SECOND_APPROVE",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps(
                {"ticket": claim.ticket_number, "amount": claim.remuneration, "note": payload.note}
            ),
        )
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/void-payment", auth=session_auth)
def void_payment(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Reverse a payment made in error.

    The ledger is append-only: voiding writes a negative reversing row rather
    than deleting anything, and the claim returns to CLEARED so it can be
    corrected and paid again.
    """
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    note = (payload.note or "").strip()
    if len(note) < 10:
        raise HttpError(400, "Add a reason (10+ characters) — it goes to the audit trail and the ledger")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.PAID:
            raise HttpError(400, "Only a paid ticket can be voided")
        # Not "net > 0": a claim can legitimately be paid at zero — count-only
        # filings, and claims that fall short of the SEC-reference minimum, are
        # recorded as PAID carrying nothing. Refusing those left them stuck in
        # PAID with no way back. Voiding twice is already impossible because
        # this transition moves the ticket out of PAID.
        net_paid = claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
        if not claim.ledger_rows.exists():
            raise HttpError(400, "No payment on record to void")
        today = timezone.now().date()
        PaidLedger.objects.create(
            claim=claim,
            payout_month=claim.payout_month or date(today.year, today.month, 1),
            department=claim.owner.department,
            faculty_name=claim.owner.name,
            staff_id=claim.staff_id or claim.owner.staff_id,
            biometric_id=claim.biometric_id or claim.owner.biometric_id,
            paper_title=claim.paper_title,
            journal_title=claim.journal_title,
            amount=-net_paid,
            voucher_number=f"{(claim.voucher_number or 'VOID')[:59]}-VOID",
            raw_json=json.dumps({"voided_by": user.email, "reason": note}),
        )
        claim.paid_at = None
        claim.save(update_fields=["paid_at"])
        _transition(claim, user, ClaimStatus.CLEARED, "VOID_PAYMENT", note)
    return claim_to_dict(claim)


@api.post("/admin/claims/{claim_id}/override-status", auth=session_auth)
def override_status(request: HttpRequest, claim_id: str, payload: OverrideStatusIn):
    """Audited super-admin rescue for stranded statuses.

    ERP imports arrive in legacy states like HOD_APPROVED that nothing in the
    live chain can act on — they could not be cleared, paid, or even rejected.
    """
    user = require_user(request)
    # Every other admin power accepts RESEARCH_CELL too — that role was folded
    # into SUPER_ADMIN and unmigrated accounts still carry it, including the
    # research cell's own login. Demanding the exact role here locked the
    # people who run the clearing queue out of the one tool that unsticks it.
    if user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "Forbidden")
    allowed = (ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.REJECTED)
    if payload.to_status not in allowed:
        raise HttpError(400, "Status can only be overridden to SUBMITTED, CLEARED, or REJECTED")
    note = (payload.note or "").strip()
    if len(note) < 10:
        raise HttpError(400, "Add a reason (10+ characters) explaining the override")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status == ClaimStatus.PAID:
            raise HttpError(400, "A paid ticket cannot be overridden — void the payment first")
        if claim.status == payload.to_status:
            raise HttpError(400, f"The ticket is already {payload.to_status}")
        _transition(claim, user, payload.to_status, "STATUS_OVERRIDE", note)
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/withdraw", auth=session_auth)
def withdraw_claim(request: HttpRequest, claim_id: str, payload: ActionIn):
    """The claimant pulls a submitted ticket back to draft to fix it."""
    user = require_user(request)
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id, owner=user)
        if claim.status != ClaimStatus.SUBMITTED:
            raise HttpError(400, "Only a submitted ticket can be withdrawn")
        _transition(claim, user, ClaimStatus.DRAFT, "WITHDRAW", payload.note)
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/reject", auth=session_auth)
def reject_claim(request: HttpRequest, claim_id: str, payload: ActionIn):
    user = require_user(request)
    if not rbac.can_reject_claims(user.role):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim.objects.all(), pk=claim_id)
    if claim.status not in (ClaimStatus.SUBMITTED, *PAYABLE_STATUSES):
        raise HttpError(400, "Invalid status for reject")
    # The faculty member has to write 10 characters to contest a failed check;
    # sending their claim back without saying why was the cheaper action. The
    # reason is also what the rejection notification shows them.
    note = (payload.note or "").strip()
    if len(note) < 10:
        raise HttpError(
            400, "Add a reason (10+ characters) so the faculty member knows what to fix"
        )
    claim.status_note = note[:255]
    claim.save(update_fields=["status_note"])
    _transition(claim, user, ClaimStatus.REJECTED, "REJECT", note)
    return claim_to_dict(claim)


def _verify_claim(claim: Claim) -> Claim:
    # Re-verifying rewrites quartile, SNIP, and remuneration. Doing that after
    # payment silently diverges the claim from its PaidLedger row.
    if claim.status == ClaimStatus.PAID:
        raise HttpError(400, "Claim is already paid — re-verifying would change a settled amount")
    result = verify_publication(
        title=claim.paper_title or "",
        scopus_author_url=claim.scopus_author_url,
        scopus_author_id=claim.scopus_author_id,
        issn=claim.issn,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id,
    )
    apply_verify_to_claim(claim, result)
    _apply_calc(claim)
    claim.save()
    return claim


@api.post("/claims/{claim_id}/verify", auth=session_auth)
def verify_claim_endpoint(request: HttpRequest, claim_id: str):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    if not (claim.paper_title or "").strip():
        raise HttpError(400, "Claim has no paper title")
    claim = _verify_claim(claim)
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=claim.status,
        to_status=claim.status,
        action="VERIFY",
    )
    return claim_to_dict(claim)


@api.post("/admin/claims/{claim_id}/set-verified", auth=session_auth)
def set_verified_values(request: HttpRequest, claim_id: str, payload: ManualVerifyIn):
    """The manual-verification lane.

    When Scopus/Scimago cannot confirm a paper, an admin enters the verified
    SNIP/quartile here — with a source note — instead of the payout ever being
    computed from the claimant's own declaration. MANUAL values survive
    re-verification.
    """
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    if claim.status == ClaimStatus.PAID:
        raise HttpError(400, "Claim is already paid — a settled amount cannot be changed")
    note = (payload.note or "").strip()
    if len(note) < 10:
        raise HttpError(400, "Provide a source note (at least 10 characters) citing where the values come from")
    if payload.snip is not None and payload.snip < 0:
        raise HttpError(400, "SNIP cannot be negative")
    if payload.quartile is not None and payload.quartile not in ("Q1", "Q2", "Q3", "Q4", ""):
        raise HttpError(400, "Quartile must be one of Q1–Q4")

    before = {
        "snip": claim.snip,
        "snip_source": claim.snip_source,
        "quartile": claim.quartile,
        "quartile_source": claim.quartile_source,
        "engineering_class": claim.engineering_class,
        "remuneration": claim.remuneration,
    }
    if payload.snip is not None:
        claim.snip = float(payload.snip)
        claim.snip_source = "MANUAL"
    if payload.quartile:
        claim.quartile = payload.quartile
        claim.quartile_source = "MANUAL"
    if payload.engineering_class:
        claim.engineering_class = payload.engineering_class
    claim.manual_verified_by = user
    claim.manual_verified_at = timezone.now()
    claim.manual_verification_note = note
    _apply_calc(claim)
    claim.save()
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=claim.status,
        to_status=claim.status,
        action="MANUAL_VERIFY",
        note=note,
    )
    AuditLog.objects.create(
        actor=user,
        action="CLAIM_MANUAL_VERIFY",
        entity="Claim",
        entity_id=claim.id,
        detail_json=json.dumps(
            {
                "before": before,
                "after": {
                    "snip": claim.snip,
                    "snip_source": claim.snip_source,
                    "quartile": claim.quartile,
                    "quartile_source": claim.quartile_source,
                    "engineering_class": claim.engineering_class,
                    "remuneration": claim.remuneration,
                },
                "note": note,
            }
        ),
    )
    return claim_to_dict(claim)


# ---------- dashboard ----------


@api.get("/dashboard", auth=session_auth)
def dashboard(request: HttpRequest):
    user = require_user(request)
    qs = _claims_queryset(user)
    counts = {row["status"]: row["n"] for row in qs.values("status").annotate(n=Count("id"))}
    by_status = {s: counts.get(s, 0) for s in ClaimStatus.values}
    recent = [claim_to_dict(c) for c in qs.order_by("-updated_at")[:10]]
    total_paid = (
        qs.filter(status=ClaimStatus.PAID).aggregate(total=Sum("remuneration"))["total"] or 0
    )
    return {"by_status": by_status, "recent": recent, "total_paid": total_paid}


def _reports_queryset(user: User, year: Optional[int], department: Optional[str]):
    qs = _claims_queryset(user).exclude(status=ClaimStatus.DRAFT)
    if year:
        qs = qs.filter(publication_year=year)
    if department:
        qs = qs.filter(owner__department__iexact=department)
    return qs


@api.get("/reports", auth=session_auth)
def reports(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
):
    """Institutional publication and payout figures.

    The scheme counts every publication but pays only some of them, so the two
    numbers are reported side by side — a department's output and its spend are
    different questions and were previously answerable only by exporting the
    ledger and pivoting it by hand.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    qs = _reports_queryset(user, year, department)
    paid = qs.filter(status=ClaimStatus.PAID)
    payable = qs.filter(status__in=PAYABLE_STATUSES)

    def rows(field: str, source=qs, label_blank: str = "Not recorded"):
        out = []
        for r in (
            source.values(field)
            .annotate(count=Count("id"), amount=Sum("remuneration"))
            .order_by("-count")
        ):
            out.append(
                {
                    "key": r[field] or label_blank,
                    "count": r["count"],
                    "amount": round(r["amount"] or 0, 2),
                }
            )
        return out

    # A publication counts institutionally even when it carries no money.
    count_only = qs.filter(
        Q(claim_reason=ClaimReason.COUNT_ONLY) | Q(is_student_publication=True)
    ).count()

    by_month = []
    for r in (
        paid.exclude(payout_month__isnull=True)
        .values("payout_month")
        .annotate(count=Count("id"), amount=Sum("remuneration"))
        .order_by("payout_month")
    ):
        by_month.append(
            {
                "key": r["payout_month"].strftime("%Y-%m"),
                "count": r["count"],
                "amount": round(r["amount"] or 0, 2),
            }
        )

    return {
        "filters": {"year": year, "department": department},
        "totals": {
            "publications": qs.count(),
            "count_only": count_only,
            "paid_claims": paid.count(),
            "paid_amount": round(paid.aggregate(s=Sum("remuneration"))["s"] or 0, 2),
            "awaiting_payment": payable.count(),
            "committed_amount": round(payable.aggregate(s=Sum("remuneration"))["s"] or 0, 2),
        },
        "by_department": rows("owner__department", label_blank="No department"),
        "by_quartile": rows("quartile", label_blank="No quartile"),
        "by_category": [
            {**r, "label": CATEGORY_LABELS.get(str(r["key"]), str(r["key"]))}
            for r in rows("remuneration_category", label_blank="Not calculated")
        ],
        "by_engineering": rows("engineering_class", label_blank="Unclassified"),
        "by_status": rows("status"),
        "by_month": by_month,
        "years": sorted(
            {
                y
                for y in _claims_queryset(user)
                .exclude(publication_year__isnull=True)
                .values_list("publication_year", flat=True)
                .distinct()
            },
            reverse=True,
        ),
    }


def _search_queryset(user: User, **f):
    """Every filter the query screen offers, applied to what the user may see."""
    qs = _claims_queryset(user).exclude(status=ClaimStatus.DRAFT).select_related("owner")
    if f.get("q"):
        term = f["q"].strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(doi__icontains=term)
            | Q(issn__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(owner__email__icontains=term)
            | Q(staff_id__icontains=term)
        )
    if f.get("department"):
        qs = qs.filter(owner__department__iexact=f["department"])
    if f.get("status"):
        qs = qs.filter(status=f["status"])
    if f.get("quartile"):
        qs = qs.filter(quartile__iexact=f["quartile"])
    if f.get("category"):
        qs = qs.filter(remuneration_category=f["category"])
    if f.get("engineering_class"):
        qs = qs.filter(engineering_class__iexact=f["engineering_class"])
    if f.get("indexing"):
        qs = qs.filter(indexing_level__icontains=f["indexing"])
    if f.get("year"):
        qs = qs.filter(publication_year=f["year"])
    if f.get("year_from"):
        qs = qs.filter(publication_year__gte=f["year_from"])
    if f.get("year_to"):
        qs = qs.filter(publication_year__lte=f["year_to"])
    if f.get("min_amount") is not None:
        qs = qs.filter(remuneration__gte=f["min_amount"])
    return qs


_SEARCH_SORTS = {
    "recent": "-updated_at",
    "amount": "-remuneration",
    "year": "-publication_year",
    "faculty": "owner__name",
    "department": "owner__department",
}


# Under /reports, not /claims: "/claims/search" is swallowed by the
# "/claims/{claim_id}" route registered above it and 404s.
@api.get("/reports/search", auth=session_auth)
def search_claims(
    request: HttpRequest,
    q: Optional[str] = None,
    department: Optional[str] = None,
    status: Optional[str] = None,
    quartile: Optional[str] = None,
    category: Optional[str] = None,
    engineering_class: Optional[str] = None,
    indexing: Optional[str] = None,
    year: Optional[int] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    min_amount: Optional[float] = None,
    sort: str = "recent",
    limit: int = 100,
    offset: int = 0,
):
    """Query every publication the user may see, across the whole college.

    The oversight portals could list and eyeball a pipeline but not ask it
    anything — "which Q1 Engineering papers in ECE went unpaid last year" meant
    exporting the ledger. This answers that directly, and reports the total and
    sum for the matched set rather than only the page.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    qs = _search_queryset(
        user,
        q=q, department=department, status=status, quartile=quartile,
        category=category, engineering_class=engineering_class,
        indexing=indexing, year=year, year_from=year_from, year_to=year_to,
        min_amount=min_amount,
    )
    total = qs.count()
    total_amount = qs.aggregate(s=Sum("remuneration"))["s"] or 0
    order = _SEARCH_SORTS.get(sort, "-updated_at")
    limit = max(1, min(limit, 500))
    rows = qs.order_by(order, "-id")[offset : offset + limit]
    return {
        "total": total,
        "total_amount": round(total_amount, 2),
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in rows],
    }


_EXPORT_HEADERS = [
    "Ticket", "Status", "Faculty", "Department", "Staff ID",
    "Paper title", "Journal", "ISSN", "DOI", "Year",
    "Publication type", "Indexed in", "Quartile", "SNIP",
    "Engineering class", "Authors", "Position", "Author point",
    "Category", "Base amount", "QF amount", "Remuneration",
    "Payout month", "Voucher",
]


def _export_row(c: Claim) -> list:
    return [
        c.ticket_number, c.status, c.owner.name, c.owner.department,
        c.staff_id, c.paper_title, c.journal_title, c.issn, c.doi,
        c.publication_year, c.publication_type, c.indexing_level,
        c.quartile, c.snip, c.engineering_class, c.total_authors,
        c.author_position, c.author_point, c.remuneration_category,
        c.base_amount, c.qf_amount, c.remuneration,
        _format_payout_month(c.payout_month), c.voucher_number,
    ]


@api.get("/reports/export", auth=session_auth)
def reports_export(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    fmt: str = "csv",
):
    """One row per publication — the sheet the R&D office actually files.

    fmt=xlsx returns a real workbook: the office re-imported the CSV into
    Excel by hand every month anyway, mangling ISSNs into dates on the way.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = _reports_queryset(user, year, department).select_related("owner")
    rows = qs.order_by("owner__department", "-publication_year")[:5000]
    stem = f"publications-{year or 'all'}-{(department or 'all').replace(' ', '-')}"

    if fmt == "xlsx":
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "Publications"
        ws.append(_EXPORT_HEADERS)
        for c in rows:
            # openpyxl treats a leading "=" as a formula, so the same
            # injection guard as the CSV path applies.
            ws.append(["" if v is None else v for v in _csv_row(_export_row(c))])
        ws.freeze_panes = "A2"
        out = io.BytesIO()
        wb.save(out)
        res = HttpResponse(
            out.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        res["Content-Disposition"] = f'attachment; filename="{stem}.xlsx"'
        return res

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_csv_row(_EXPORT_HEADERS))
    for c in rows:
        w.writerow(_csv_row(_export_row(c)))
    res = HttpResponse(buf.getvalue(), content_type="text/csv")
    res["Content-Disposition"] = f'attachment; filename="{stem}.csv"'
    return res


# ---------- notifications ----------


@api.get("/notifications", auth=session_auth)
def notifications(request: HttpRequest):
    user = require_user(request)
    items = Notification.objects.filter(user=user).order_by("-created_at")[:50]
    return [
        {
            "id": n.id,
            "title": n.title,
            "body": n.body,
            "href": n.href,
            "read": n.read,
            "created_at": n.created_at.isoformat(),
        }
        for n in items
    ]


@api.get("/notifications/unread-count", auth=session_auth)
def notifications_unread_count(request: HttpRequest):
    """The 45-second poll only needs this number — the full list loads when
    the bell is actually opened."""
    user = require_user(request)
    return {"unread": Notification.objects.filter(user=user, read=False).count()}


@api.post("/notifications/{note_id}/read", auth=session_auth)
def notification_read(request: HttpRequest, note_id: str):
    user = require_user(request)
    note = get_object_or_404(Notification, pk=note_id, user=user)
    if not note.read:
        note.read = True
        note.save(update_fields=["read"])
    return {"ok": True}


@api.post("/notifications/read-all", auth=session_auth)
def notifications_read_all(request: HttpRequest):
    user = require_user(request)
    Notification.objects.filter(user=user, read=False).update(read=True)
    return {"ok": True}


# ---------- admin ----------


@api.get("/admin/users", auth=session_auth)
def admin_users(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    return [
        {
            "id": u.id,
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "department": u.department,
            "employee_id": u.employee_id,
            "staff_id": u.staff_id,
            "biometric_id": u.biometric_id,
            "designation": u.designation,
            "scopus_author_url": u.scopus_author_url,
            "scopus_author_id": u.scopus_author_id,
            "active": u.active,
            "portal": rbac.portal_for_role(u.role),
        }
        for u in User.objects.order_by("email")
    ]


@api.post("/admin/users", auth=session_auth)
def admin_create_user(request: HttpRequest, payload: UserCreateIn):
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    u = User.objects.create_user(
        email=payload.email.strip().lower(),
        password=payload.password,
        name=payload.name,
        role=payload.role,
        department=payload.department,
        employee_id=payload.employee_id,
        staff_id=payload.staff_id,
        biometric_id=payload.biometric_id,
        designation=payload.designation,
        scopus_author_url=payload.scopus_author_url,
        scopus_author_id=payload.scopus_author_id,
        must_change_password=payload.must_change_password,
    )
    AuditLog.objects.create(
        actor=user, action="USER_CREATE", entity="User", entity_id=u.id
    )
    return {"id": u.id, "email": u.email}


@api.patch("/admin/users/{user_id}", auth=session_auth)
def admin_update_user(request: HttpRequest, user_id: str, payload: UserUpdateIn):
    actor = require_user(request)
    if not rbac.can_manage_users(actor.role):
        raise HttpError(403, "Forbidden")
    u = get_object_or_404(User, pk=user_id)
    data = payload.dict(exclude_unset=True)
    # Self-lockout guard: an admin demoting or deactivating their own account
    # can leave the system with nobody able to manage users.
    if u.id == actor.id:
        if "role" in data and data["role"] != actor.role:
            raise HttpError(400, "You cannot change your own role — ask another admin")
        if data.get("active") is False:
            raise HttpError(400, "You cannot deactivate your own account")
    before = {k: getattr(u, k, None) for k in data}
    for k, v in data.items():
        setattr(u, k, v)
    u.save()
    changed = {k: {"from": before[k], "to": data[k]} for k in data if before[k] != data[k]}
    AuditLog.objects.create(
        actor=actor,
        action="USER_UPDATE",
        entity="User",
        entity_id=u.id,
        detail_json=json.dumps(changed) if changed else None,
    )
    return _user_dict(u)


@api.post("/admin/users/{user_id}/reset-password", auth=session_auth)
def admin_reset_password(request: HttpRequest, user_id: str, payload: ResetPasswordIn):
    actor = require_user(request)
    if not rbac.can_manage_users(actor.role):
        raise HttpError(403, "Forbidden")
    u = get_object_or_404(User, pk=user_id)
    u.set_password(payload.password)
    u.must_change_password = True
    u.save()
    # A reset is how a locked-out person recovers — clear the lockout with it.
    clear_login_lockout(u.email)
    AuditLog.objects.create(
        actor=actor, action="USER_RESET_PASSWORD", entity="User", entity_id=u.id
    )
    return {"ok": True}


# Under /admin, not /admin/users: "/admin/users/reset-password" is swallowed
# by the "/admin/users/{user_id}" route registered above it and answers 405.
@api.post("/admin/reset-password", auth=session_auth)
def admin_reset_password_by_email(request: HttpRequest, payload: ResetPasswordByEmailIn):
    actor = require_user(request)
    if not rbac.can_manage_users(actor.role):
        raise HttpError(403, "Forbidden")
    if len(payload.password) < 8:
        raise HttpError(400, "Password must be at least 8 characters")
    u = get_object_or_404(User, email=payload.email.strip().lower())
    u.set_password(payload.password)
    u.must_change_password = True
    u.save()
    # A reset is how a locked-out person recovers — clear the lockout with it.
    clear_login_lockout(u.email)
    AuditLog.objects.create(
        actor=actor, action="USER_RESET_PASSWORD", entity="User", entity_id=u.id
    )
    return {"ok": True}


@api.get("/admin/formula", auth=session_auth)
def get_formula(request: HttpRequest):
    user = require_user(request)
    # Faculty preview their own amount through /api/calculate; the raw policy
    # sheet is an oversight document, not something every login can read.
    if not (rbac.can_view_reports(user.role) or rbac.can_edit_formula(user.role)):
        raise HttpError(403, "Forbidden")
    cfg = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    if not cfg:
        return {
            "name": "Policy v1",
            "version": 1,
            "snip_multiplier": 55000,
            "snip_cap": 30,
            "qf_q1": 50000,
            "qf_q2": 30000,
            "qf_q3": 15000,
            "qf_q4": 5000,
            "qf_no_snip": 0,
            "qf_snip_only": 0,
            "qf_others": 4000,
            "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS),
            "publication_type_multipliers_json": json.dumps(DEFAULT_PUB_TYPE_MULTIPLIERS),
            "student_remuneration_zero": True,
            "qf_only_for_no_snip": True,
            "high_value_threshold": 100000,
        }
    return {
        "id": cfg.id,
        "name": cfg.name,
        "version": cfg.version,
        "effective_from": cfg.effective_from.isoformat() if cfg.effective_from else None,
        "effective_to": cfg.effective_to.isoformat() if cfg.effective_to else None,
        "snip_multiplier": cfg.snip_multiplier,
        "snip_cap": cfg.snip_cap,
        "qf_q1": cfg.qf_q1,
        "qf_q2": cfg.qf_q2,
        "qf_q3": cfg.qf_q3,
        "qf_q4": cfg.qf_q4,
        "qf_no_snip": cfg.qf_no_snip,
        "qf_snip_only": cfg.qf_snip_only,
        "qf_others": cfg.qf_others,
        "author_point_json": cfg.author_point_json,
        "publication_type_multipliers_json": cfg.publication_type_multipliers_json,
        "student_remuneration_zero": cfg.student_remuneration_zero,
        "qf_only_for_no_snip": cfg.qf_only_for_no_snip,
        "high_value_threshold": cfg.high_value_threshold,
        "fixed_journal_no_snip": cfg.fixed_journal_no_snip,
        "fixed_other_no_snip": cfg.fixed_other_no_snip,
        "fixed_web_of_science": cfg.fixed_web_of_science,
        "max_authors": cfg.max_authors,
        "min_sec_references": cfg.min_sec_references,
        "notes": cfg.notes,
    }


@api.put("/admin/formula", auth=session_auth)
def put_formula(request: HttpRequest, payload: FormulaIn):
    user = require_user(request)
    if not rbac.can_edit_formula(user.role):
        raise HttpError(403, "Forbidden")
    # Validate everything before touching any row. Deactivating first meant one bad
    # date left zero active policies, silently falling back to the hard-coded
    # defaults and resetting the version counter on the next successful save.
    eff_from = None
    eff_to = None
    if payload.effective_from:
        try:
            eff_from = date.fromisoformat(payload.effective_from)
        except ValueError:
            raise HttpError(400, "Invalid effective_from")
    if payload.effective_to:
        try:
            eff_to = date.fromisoformat(payload.effective_to)
        except ValueError:
            raise HttpError(400, "Invalid effective_to")
    if eff_from and eff_to and eff_to < eff_from:
        raise HttpError(400, "effective_to cannot be before effective_from")
    # Shape, not just syntax. Valid-but-wrong JSON here (a list, a string, a
    # non-numeric share) produced an active policy that raised inside the
    # calculator, so every submit, clear, payment and preview 500'd — and
    # because saving deactivates the previous version, the editor needed a
    # working calculation to repair itself. There is no way back from that.
    pub_json = payload.publication_type_multipliers_json or json.dumps(DEFAULT_PUB_TYPE_MULTIPLIERS)
    try:
        pub_m = json.loads(pub_json)
    except Exception:
        raise HttpError(400, "Invalid publication_type_multipliers_json")
    if not isinstance(pub_m, dict) or not pub_m:
        raise HttpError(
            400,
            'Publication type multipliers must be an object, e.g. {"Journal": 1, "Conference Proceeding": 1}',
        )
    for key, value in pub_m.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise HttpError(400, f'Publication type multiplier for "{key}" must be a number')

    try:
        points = json.loads(payload.author_point_json)
    except Exception:
        raise HttpError(400, "Invalid author_point_json")
    if not isinstance(points, dict) or not points:
        raise HttpError(
            400,
            'Author points must be an object keyed by author count, e.g. {"1": 1, "2": [0.7, 0.3]}',
        )
    for key, value in points.items():
        if key != "default" and not str(key).isdigit():
            raise HttpError(400, f'Author-point key "{key}" must be an author count, or "default"')
        if isinstance(value, bool):
            raise HttpError(400, f'Author-point rule for "{key}" must be a number or a list')
        if isinstance(value, (int, float)):
            continue
        if isinstance(value, list) and value and all(
            isinstance(v, (int, float)) and not isinstance(v, bool) for v in value
        ):
            continue
        raise HttpError(
            400,
            f'Author-point rule for "{key}" must be a number or a non-empty list of numbers',
        )
    if payload.snip_cap <= 0:
        raise HttpError(400, "snip_cap must be greater than zero")
    for label, amount in (
        ("snip_multiplier", payload.snip_multiplier),
        ("qf_q1", payload.qf_q1),
        ("qf_q2", payload.qf_q2),
        ("qf_q3", payload.qf_q3),
        ("qf_q4", payload.qf_q4),
        ("qf_others", payload.qf_others),
        ("high_value_threshold", payload.high_value_threshold),
    ):
        if amount < 0:
            raise HttpError(400, f"{label} cannot be negative")

    with transaction.atomic():
        prev = FormulaConfig.objects.filter(active=True).order_by("-version").first()
        next_version = (prev.version + 1) if prev else 1
        FormulaConfig.objects.filter(active=True).update(active=False)
        cfg = FormulaConfig.objects.create(
            name=payload.name or f"Policy v{next_version}",
            version=next_version,
            effective_from=eff_from or timezone.now().date(),
            effective_to=eff_to,
            snip_multiplier=payload.snip_multiplier,
            snip_cap=payload.snip_cap,
            qf_q1=payload.qf_q1,
            qf_q2=payload.qf_q2,
            qf_q3=payload.qf_q3,
            qf_q4=payload.qf_q4,
            qf_no_snip=payload.qf_no_snip,
            qf_snip_only=payload.qf_snip_only,
            qf_others=payload.qf_others,
            author_point_json=payload.author_point_json,
            publication_type_multipliers_json=pub_json,
            student_remuneration_zero=payload.student_remuneration_zero,
            qf_only_for_no_snip=payload.qf_only_for_no_snip,
            high_value_threshold=payload.high_value_threshold,
            fixed_journal_no_snip=payload.fixed_journal_no_snip,
            fixed_other_no_snip=payload.fixed_other_no_snip,
            fixed_web_of_science=payload.fixed_web_of_science,
            max_authors=payload.max_authors,
            min_sec_references=payload.min_sec_references,
            notes=payload.notes,
            updated_by=user,
            active=True,
        )
        _invalidate_threshold_cache()
        AuditLog.objects.create(
            actor=user,
            action="FORMULA_UPDATE",
            entity="FormulaConfig",
            entity_id=cfg.id,
            detail_json=json.dumps({"version": cfg.version, "name": cfg.name}),
        )
    return {"id": cfg.id, "version": cfg.version, "name": cfg.name}


@api.get("/admin/audit", auth=session_auth)
def admin_audit(
    request: HttpRequest,
    q: Optional[str] = None,
    action: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """Filterable, paginated audit trail.

    The old shape was the last 100 rows with no filters and no detail — the
    recorded before/after values were stored and never shown anywhere.
    """
    user = require_user(request)
    if not rbac.can_view_audit(user.role):
        raise HttpError(403, "Forbidden")
    qs = AuditLog.objects.select_related("actor").order_by("-created_at")
    if action:
        qs = qs.filter(action__icontains=action)
    if q:
        qs = qs.filter(
            Q(entity_id__icontains=q)
            | Q(entity__icontains=q)
            | Q(actor__email__icontains=q)
            | Q(actor__name__icontains=q)
        )
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    total = qs.count()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [
            {
                "id": l.id,
                "action": l.action,
                "entity": l.entity,
                "entity_id": l.entity_id,
                "actor": l.actor.email if l.actor else None,
                "detail_json": l.detail_json,
                "created_at": l.created_at.isoformat(),
            }
            for l in qs[offset : offset + limit]
        ],
    }


@api.get("/admin/payouts", auth=session_auth)
def admin_payouts(
    request: HttpRequest,
    status: str = "CLEARED",
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = Claim.objects.select_related(
        "owner", "cleared_by", "second_approved_by"
    ).prefetch_related("attachments")
    if status == "PAID":
        qs = qs.filter(status=ClaimStatus.PAID)
        default_order = "-paid_at"
    elif status in ("CLEARED", "PRINCIPAL_APPROVED", "FINANCE_APPROVED"):
        # One payable queue. Tickets approved under the old chain sit in it too,
        # otherwise they would be stranded with nobody able to pay them.
        qs = qs.filter(status__in=PAYABLE_STATUSES)
        default_order = "-updated_at"
    else:
        qs = qs.filter(status=status)
        default_order = "-updated_at"
    qs = qs.order_by(_CLAIM_SORTS.get(sort, default_order))
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in qs[offset : offset + limit]],
    }


@api.get("/admin/scimago/stats", auth=session_auth)
def scimago_stats(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    count = ScimagoJournal.objects.count()
    years = list(ScimagoJournal.objects.values_list("year", flat=True).distinct().order_by("-year"))
    return {"count": count, "years": years}


@api.post("/admin/scimago/import", auth=session_auth)
def scimago_import(request: HttpRequest, file: UploadedFile = File(...), year: int = Form(...)):
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read().decode("utf-8", errors="ignore")
    # Same parser as the automatic download, so an uploaded dump and a fetched
    # one cannot disagree about ISSNs or the SJR decimal separator.
    result = import_csv_text(content, year)
    AuditLog.objects.create(
        actor=user,
        action="SCIMAGO_IMPORT",
        entity="ScimagoJournal",
        detail_json=json.dumps({**result, "filename": file.name or "upload.csv"}),
    )
    return {"imported": result["imported"], "skipped": result["skipped"], "year": year}


class ScimagoSyncIn(Schema):
    year: int


@api.post("/admin/scimago/sync", auth=session_auth)
def scimago_sync(request: HttpRequest, payload: ScimagoSyncIn):
    """Pull the official SCImago rank dump for a year straight from the portal."""
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    year = payload.year
    if year < 1999 or year > date.today().year:
        raise HttpError(400, f"Year must be between 1999 and {date.today().year}")
    try:
        result = sync_year(year)
    except ScimagoSyncError as e:
        raise HttpError(502, str(e))
    AuditLog.objects.create(
        actor=user,
        action="SCIMAGO_SYNC",
        entity="ScimagoJournal",
        detail_json=json.dumps(result),
    )
    return {**result, "source": SCIMAGO_RANK_URL}


@api.post("/admin/prior/import", auth=session_auth)
def prior_import(request: HttpRequest, file: UploadedFile = File(...)):
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read().decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(content))
    n = 0
    # These rows block future claims as duplicates, so a half-finished import is
    # worse than none at all — one transaction, and an audit row like every
    # other importer writes.
    with transaction.atomic():
        batch = PriorImport.objects.create(
            filename=file.name or "upload.csv",
            row_count=0,
            mapping_json="{}",
            imported_by=user,
        )
        for line_no, row in enumerate(reader, start=2):
            title = row.get("paper_title") or row.get("title") or row.get("Paper Title")
            doi = row.get("doi") or row.get("DOI")
            raw_amount = row.get("amount")
            amount = None
            if raw_amount:
                try:
                    amount = float(str(raw_amount).replace(",", "").strip())
                except ValueError:
                    raise HttpError(
                        400, f"Row {line_no}: amount '{raw_amount}' is not a number"
                    )
            PriorPayment.objects.create(
                faculty_name=row.get("faculty_name") or row.get("name"),
                employee_id=row.get("employee_id"),
                paper_title=title,
                normalized_title=normalize_title(title) if title else None,
                doi=normalize_doi(doi) if doi else None,
                issn=row.get("issn"),
                journal_title=row.get("journal"),
                amount_paid=amount,
                raw_json=json.dumps(row),
                import_batch=batch,
            )
            n += 1
        batch.row_count = n
        batch.save()
        AuditLog.objects.create(
            actor=user,
            action="PRIOR_PAYMENT_IMPORT",
            entity="PriorImport",
            entity_id=batch.id,
            detail_json=json.dumps({"n": n, "filename": batch.filename}),
        )
    return {"imported": n, "batch_id": batch.id}


@api.get("/admin/clearing-queue", auth=session_auth)
def admin_clearing_queue(request: HttpRequest, status: Optional[str] = None):
    """Submitted tickets waiting on admin clearing — the only approval step."""
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    qs = Claim.objects.select_related("owner").prefetch_related("attachments")
    if status and status != "ALL":
        qs = qs.filter(status=status)
    else:
        qs = qs.filter(status=ClaimStatus.SUBMITTED)
    # Oldest first: the ticket that has waited longest is the one to clear next.
    return [claim_to_dict(c) for c in qs.order_by("submitted_at", "created_at")[:200]]


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
