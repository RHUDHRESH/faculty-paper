from __future__ import annotations

import csv
import io
import json
import logging
import os
import re
import uuid as uuid_lib
from datetime import date, timedelta, datetime
from pathlib import Path
from typing import Any, Optional

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import Case, Count, F, IntegerField, Min, Q, Sum, Value, When
from django.http import HttpRequest, HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import NinjaAPI, Schema, UploadedFile, File, Form
from ninja.errors import HttpError
from ninja.security import SessionAuth

logger = logging.getLogger("core.api")

from core.models import (
    ClaimNote,
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAction,
    ClaimAttachment,
    ClaimReason,
    ClaimStatus,
    PAYABLE_STATUSES,
    Budget,
    DuplicateFinding,
    JournalStanding,
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
from core.services import exporters
from core.services.normalize import normalize_doi, normalize_issn, normalize_title
from core.services.remuneration import (
    CATEGORY_LABELS,
    DEFAULT_AUTHOR_POINTS,
    DEFAULT_PUB_TYPE_MULTIPLIERS,
    MAX_ELIGIBLE_AUTHORS,
    MIN_SEC_REFERENCES,
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
    author_profile_url,
    extract_author_id,
    lookup_paper_by_doi,
    lookup_serial_by_issn,
    search_by_title,
    search_candidates,
)
from core.services.tickets import assign_ticket_number
import re

from core import data_explorer as explorer
from core import hod
from core.services.pdfmeta import content_digest, guess_title
from core.services.reporting_pack import build_pack, pack_workbook
from core.services.retraction import looks_retracted
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

    # A journal the college's own sources no longer recognise.
    for problem in (result.get("standing") or {}).get("issues", []):
        issues.append(problem)

    # Both titles: a publisher renames a withdrawn paper after the claimant
    # filled the form in, so the index is where a retraction shows up first.
    for title in (claim.paper_title, scopus.get("title")):
        phrase = looks_retracted(title)
        if phrase:
            issues.append(
                f"The title says “{phrase}” — this looks like a retracted or "
                "withdrawn paper. Send it with a note if that is wrong"
            )
            break
    return issues


def _notify_admin_users(
    title: str, body: str, href: str, *, super_admin_only: bool = False
) -> None:
    """An admin notification that is not about a particular ticket."""
    roles = (Role.SUPER_ADMIN,) if super_admin_only else rbac.ADMIN_ROLES
    for u in User.objects.filter(role__in=roles, active=True):
        Notification.objects.create(user=u, title=title, body=body, href=href)
        send_optional_email(u.email, title, body)


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


def _notify_principal(claim: Claim, title: str, body: str) -> None:
    """A cleared ticket waits on the principal, so the principal is who hears.

    This used to tell Finance, from when clearing was the last step before
    payment. It has not been since the approval step went in: Finance was
    being told about money it could not release, and the person who actually
    had to act was not told at all.
    """
    for u in User.objects.filter(role=Role.PRINCIPAL, active=True):
        Notification.objects.create(
            user=u,
            title=title,
            body=body,
            href=f"/principal?claim={claim.id}",
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
    #: Returned by /claims/upload; carried back so the file stays identifiable.
    content_hash: Optional[str] = None


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

    # Count-only filings carry no money, but they are still the institution's
    # record of the publication. Blanking SNIP to force a zero payout also threw
    # away a real fact about the journal, so the count kept the paper and lost
    # its metrics. `is_student_publication` is what stops the payment -- the
    # engine returns zero on that alone -- so the declared figures can stay.
    # ...and it has to flip back. Setting the flag on the way in but never
    # clearing it meant a claim switched back to an incentive claim stayed
    # marked as a student publication and went on paying nothing, with nothing
    # on screen to explain why.
    claim.is_student_publication = claim.claim_reason == ClaimReason.COUNT_ONLY
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
                # Carried from the upload so the same file is recognisable on
                # the next claim, not just within this one.
                "content_hash": (a.content_hash or "").strip()[:64] or None,
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
    #: Retired — the policy's QFA table is Q1-Q4 only. The editor no longer
    #: sends it, and a 4,000 default here would have written the retired
    #: incentive straight back into every new policy version.
    qf_others: float = 0
    author_point_json: str
    notes: Optional[str] = None
    name: Optional[str] = "Policy"
    snip_cap: float = 30
    publication_type_multipliers_json: Optional[str] = None
    student_remuneration_zero: bool = True
    qf_only_for_no_snip: bool = True
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    high_value_threshold: float = 0
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
    # Impersonation is for seeing, not for doing. Enforced here rather than on
    # each route, because "we forgot to guard that one endpoint" is exactly how
    # a read-only mode stops being read-only.
    if request.session.get(IMPERSONATOR_KEY) and request.method not in (
        "GET", "HEAD", "OPTIONS",
    ):
        if request.path != "/api/admin/stop-impersonating":
            raise HttpError(
                403,
                "You are viewing as another user. Stop impersonating before making "
                "any change.",
            )
    return user


#: Session key holding the real admin's id while they view as somebody else.
IMPERSONATOR_KEY = "impersonator_id"


def impersonator_of(request: HttpRequest) -> User | None:
    uid = request.session.get(IMPERSONATOR_KEY)
    return User.objects.filter(pk=uid).first() if uid else None


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
        # The roster gives us IDs, not links. Derive the link so the claim form
        # can pre-fill it instead of blocking on a field the person can't know.
        "scopus_author_url": (u.scopus_author_url or "").strip()
        or author_profile_url(u.scopus_author_id),
        "scopus_author_id": u.scopus_author_id,
        "must_change_password": u.must_change_password,
        "active": u.active,
        "portal": rbac.portal_for_role(u.role),
    }


def _me_dict(request: HttpRequest, u: User) -> dict[str, Any]:
    """The signed-in payload, plus who is really driving."""
    data = _user_dict(u)
    real = impersonator_of(request)
    if real:
        data["impersonated_by"] = {"id": real.id, "name": real.name, "email": real.email}
        data["read_only"] = True
    return data


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
        "override_by_name": c.override_by.name if c.override_by_id else None,
        "override_at": c.override_at.isoformat() if c.override_at else None,
        "override_reason": c.override_reason,
        "year_mismatch": c.year_mismatch,
        "year_mismatch_override": c.year_mismatch_override,
        "year_mismatch_reason": c.year_mismatch_reason,
        "voucher_number": c.voucher_number,
        "cleared_by_name": c.cleared_by.name if c.cleared_by_id else None,
        "second_approved_by_name": c.second_approved_by.name if c.second_approved_by_id else None,
        "cleared_at": c.cleared_at.isoformat() if c.cleared_at else None,
        "principal_approved_by_name": (
            c.principal_approved_by.name if c.principal_approved_by_id else None
        ),
        "principal_approved_at": (
            c.principal_approved_at.isoformat() if c.principal_approved_at else None
        ),
        #: Whole days this ticket has sat where it is, for the queue that has
        #: to decide what to look at first.
        "waiting_days": _waiting_days(c),
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
    # Carries the impersonation banner: a viewer must always be able to tell
    # whose session they are looking at.
    return _me_dict(request, u)


class ProfileUpdateIn(Schema):
    """Nothing on a profile is self-service any more.

    staff_id, biometric_id and department were already server-owned: they decide
    who gets paid and where the ticket sits. Name, designation and the Scopus
    link have joined them, because they are equally identity — a Scopus link
    pointed at somebody else's profile is how a claim gets attributed to the
    wrong author. Every field is changed by a super admin via
    PATCH /admin/users/{id}; a claimant raises a correction request instead.
    """

    #: Retained so an existing client gets a clear refusal rather than a 422.
    name: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None


class CorrectionRequestIn(Schema):
    field: str
    proposed: str
    note: Optional[str] = None


@api.patch("/auth/profile", auth=session_auth)
def update_profile(request: HttpRequest, payload: ProfileUpdateIn):
    """Refused for everyone but a super admin.

    Every field on a profile is identity: the name on the payment, the
    designation on the claim, and the Scopus link that decides which author's
    record a paper is checked against. A claimant editing their own is how a
    claim ends up attributed to somebody else.
    """
    u = require_user(request)
    if u.role != Role.SUPER_ADMIN:
        raise HttpError(
            403,
            "Profile details are set by the research cell. Use "
            "“Request a correction” and an admin will action it.",
        )
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


#: What a claimant may ask to have corrected. Anything not here is not a
#: profile field they can even see.
CORRECTABLE = {
    "name": "Full name",
    "department": "Department",
    "designation": "Designation",
    "staff_id": "Staff ID",
    "biometric_id": "Biometric ID",
    "scopus_author_url": "Scopus author link",
    "scopus_author_id": "Scopus author ID",
}


#: Of those, the ones only a super admin may write -- on the profile page and
#: on the admin user editor alike. Department is deliberately absent: it is
#: routing rather than identity, and the research cell moves people between
#: departments as a matter of course.
IDENTITY_FIELDS = frozenset(CORRECTABLE) - {"department"}


@api.post("/auth/profile/correction", auth=session_auth)
def request_profile_correction(request: HttpRequest, payload: CorrectionRequestIn):
    """Ask an admin to change a detail you cannot change yourself.

    Without this, "the research cell owns your profile" means "chase somebody by
    email and hope" — so the details stay wrong and the claim stays blocked.
    """
    u = require_user(request)
    field = (payload.field or "").strip()
    proposed = (payload.proposed or "").strip()
    if field not in CORRECTABLE:
        raise HttpError(400, "That is not a profile detail you can request a change to")
    if not proposed:
        raise HttpError(400, "Say what it should be")

    current = getattr(u, field, None)
    AuditLog.objects.create(
        actor=u,
        action="PROFILE_CORRECTION_REQUEST",
        entity="User",
        entity_id=u.id,
        detail_json=json.dumps({
            "field": field,
            "label": CORRECTABLE[field],
            "current": str(current or ""),
            "proposed": proposed,
            "note": (payload.note or "").strip()[:500],
        }),
    )
    _notify_admin_users(
        f"Profile correction requested · {u.name or u.email}",
        f"{CORRECTABLE[field]}: “{current or 'not set'}” → “{proposed}”",
        f"/admin/users?q={u.email}",
        # Only a super admin can action an identity change, so only a super
        # admin is told about one -- a notification the reader cannot act on
        # trains them to ignore the rest.
        super_admin_only=field in IDENTITY_FIELDS,
    )
    return {"ok": True, "field": field, "label": CORRECTABLE[field], "proposed": proposed}


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

    # The file's own fingerprint, so the same document is recognised however it
    # was renamed. Two references that are really one page scanned twice is the
    # common case; the same paper already used on another claim is the one worth
    # stopping.
    digest = content_digest(content)
    seen = (
        ClaimAttachment.objects.filter(content_hash=digest)
        .select_related("claim", "claim__owner")
        .first()
    )
    duplicate = None
    if seen:
        duplicate = {
            "claim_id": seen.claim_id,
            "ticket_number": seen.claim.ticket_number,
            "filename": seen.filename,
            "uploaded_at": seen.created_at.isoformat(),
            "same_owner": seen.claim.owner_id == user.id,
            "owner_name": seen.claim.owner.name,
        }

    return {
        "url": f"{settings.MEDIA_URL}claims/{fname}",
        # The claimant's own name, shown in the UI; the stored name is a uuid.
        "filename": (file.name or f"document.{kind.extension}")[:255],
        "size_bytes": len(content),
        "content_type": kind.content_type,
        "kind_label": kind.label,
        "content_hash": digest,
        # A suggestion for the title box, never written to the claim on its own:
        # a wrong title picked up silently is worse than an empty field.
        "suggested_title": guess_title(content),
        "duplicate_of": duplicate,
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
            "owner", "manual_verified_by", "cleared_by", "second_approved_by",
            "override_by",
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


def _refuse_hod_money_screens(user: User) -> None:
    """A head of department has their own screens, which carry no money.

    The claim payload carries the remuneration, and while a head owns no
    claims -- they cannot file one -- an open door that returns an empty list
    today returns a paid amount the day somebody gives the account a claim.
    Refused outright, pointing at the screen that answers their question.
    """
    if user.role == Role.HOD:
        raise HttpError(
            403,
            "Heads of department see their department's publications under "
            "Department, which carry no payment details.",
        )


@api.get("/claims", auth=session_auth)
def list_claims(
    request: HttpRequest,
    status: Optional[str] = None,
    q: Optional[str] = None,
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
):
    """Paginated. The old shape silently truncated at 200 rows — beyond that,
    tickets simply did not exist as far as the UI was concerned.

    `q` searches the whole queue rather than the page on screen. Both list
    screens used to filter the fifty rows they had already fetched, so an admin
    on page one searching for a ticket sitting on page three was told there was
    no such ticket.
    """
    user = require_user(request)
    _refuse_hod_money_screens(user)
    qs = _claims_queryset(user)
    if status:
        qs = qs.filter(status=status)
    if q and q.strip():
        term = q.strip()
        qs = qs.filter(
            Q(ticket_number__icontains=term)
            | Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(doi__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(owner__email__icontains=term)
            | Q(owner__department__icontains=term)
        )
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
    _refuse_hod_money_screens(user)
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
        # The quartile the journal held in the year of publication, and whether
        # it was still a recognised journal then.
        publication_year=claim.publication_year,
        publication_date=claim.publication_date,
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
    # _verification_issues already reports the payment-history warning, so
    # adding it here again showed the claimant the same sentence twice.
    if (
        claim.duplicate_warning
        and not claim.override_duplicate
        and not contest
        and not any("Payment history" in i for i in issues)
    ):
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
            # Against a name and a time: the person who releases the money has
            # to be somebody else, and cannot be if nobody recorded who this was.
            claim.override_by = user
            claim.override_at = timezone.now()

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
            "Checked — with the Principal",
            "The research cell has checked your ticket. It is now with the "
            "Principal for approval.",
        )
    if to_status == ClaimStatus.HOD_APPROVED:
        return ("Approved by HoD", "Your ticket was approved by HoD and is with the Principal.")
    if to_status == ClaimStatus.PRINCIPAL_APPROVED:
        return (
            "Approved — with Finance",
            "The Principal has approved your ticket. It is with Finance for payment.",
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
#: fresh; put_formula invalidates. It also expires on its own, because only
#: the process that served the edit sees that invalidation — another instance
#: would otherwise show a stale badge indefinitely.
_THRESHOLD_CACHE: dict[str, Any] = {}
_THRESHOLD_TTL_SECONDS = 30


def _invalidate_threshold_cache() -> None:
    _THRESHOLD_CACHE.clear()


def _waiting_days(claim: Claim) -> int | None:
    """How long the ticket has waited at its current step.

    Measured from when it arrived at this step, not from updated_at, which
    moves for any edit and would reset the clock every time somebody looked
    at it.
    """
    started = None
    if claim.status == ClaimStatus.SUBMITTED:
        started = claim.submitted_at
    elif claim.status == ClaimStatus.CLEARED:
        started = claim.cleared_at
    elif claim.status == ClaimStatus.PRINCIPAL_APPROVED:
        started = claim.principal_approved_at
    if not started:
        return None
    return max(0, (timezone.now() - started).days)


def _high_value_threshold(*, fresh: bool = True) -> float:
    if not fresh and "value" in _THRESHOLD_CACHE:
        import time as _time

        if _time.monotonic() - _THRESHOLD_CACHE.get("at", 0) < _THRESHOLD_TTL_SECONDS:
            return _THRESHOLD_CACHE["value"]
    cfg = (
        FormulaConfig.objects.filter(active=True)
        .order_by("-updated_at")
        .only("high_value_threshold")
        .first()
    )
    # No policy configured means the rule is off, not that every large claim
    # is blocked by an approval nobody can give.
    value = float(cfg.high_value_threshold) if cfg else 0.0
    import time as _time

    _THRESHOLD_CACHE["value"] = value
    _THRESHOLD_CACHE["at"] = _time.monotonic()
    return value


def _needs_second_approval(claim: Claim, threshold: float | None = None) -> bool:
    """High-value live-chain claims need a second, distinct pair of eyes.

    Off unless a positive threshold is set. It takes two admin accounts to
    satisfy — the approver must differ from whoever cleared the ticket — so on
    a single-admin setup an always-on rule simply jammed every large claim
    with nobody able to release it.
    """
    if claim.status not in (ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED):
        return False

    seconded = bool(
        claim.second_approved_by_id and claim.second_approved_by_id != claim.cleared_by_id
    )

    # A duplicate at any amount is a duplicate, so this one ignores the
    # threshold: somebody decided the college has not already paid for this
    # paper, and that decision is worth a second reader however small it is.
    if claim.duplicate_warning and claim.override_duplicate:
        return not seconded

    limit = threshold if threshold is not None else _high_value_threshold()
    if limit <= 0:
        return False
    if (claim.remuneration or 0) < limit:
        return False
    return not seconded


def _guard_self_cleared_override(claim: Claim, actor: User) -> None:
    """The person who set the warning aside cannot also clear the ticket.

    Waving a duplicate away and then clearing it is one person deciding, twice,
    that the college has not already paid for this paper. Two admins is not a
    hardship here: an override is rare, and the alternative is a second
    payment nobody reviewed.
    """
    if not (claim.duplicate_warning and claim.override_duplicate):
        return
    if claim.override_by_id and claim.override_by_id == actor.id:
        raise HttpError(
            400,
            "You set aside the payment-history warning on this ticket, so "
            "somebody else has to clear it.",
        )


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
        _guard_self_cleared_override(claim, user)
        _reverify_or_recalc(claim, user, skip_external=bool(payload.skip_external))
        _guard_recomputed_amount(claim, payload.expected_amount)
        claim.cleared_by = user
        claim.cleared_at = timezone.now()
        _transition(claim, user, ClaimStatus.CLEARED, "CLEAR", payload.note)
        amount = claim.remuneration or 0
    _notify_principal(
        claim,
        f"Cleared — waiting on your approval · {claim.ticket_number}",
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
                # A dismissed duplicate is exactly the row that must not go
                # through in a batch of two hundred without being looked at.
                if (
                    claim.duplicate_warning
                    and claim.override_duplicate
                    and claim.override_by_id == user.id
                ):
                    skipped.append(
                        {
                            "id": claim_id,
                            "reason": (
                                f"{claim.ticket_number or claim_id}: you set aside the "
                                "payment-history warning on this one, so somebody else "
                                "has to clear it"
                            ),
                        }
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
                claim.cleared_at = timezone.now()
                _transition(claim, user, ClaimStatus.CLEARED, "CLEAR", payload.note)
                amount = claim.remuneration or 0
            _notify_principal(
                claim,
                f"Cleared — waiting on your approval · {claim.ticket_number}",
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


def _may_approve_as_principal(role: str) -> bool:
    """The principal, and a super admin who has to stand in for one."""
    return role == Role.PRINCIPAL or role == Role.SUPER_ADMIN


@api.post("/claims/{claim_id}/principal-approve", auth=session_auth)
def principal_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Approve the spend on a cleared ticket, which is what lets finance pay it.

    The research cell checks that a claim is true; this step is somebody
    accountable agreeing to spend the money on it. They were previously the
    same decision, taken by the research cell alone.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.CLEARED:
            raise HttpError(
                400,
                "Only a ticket the research cell has cleared can be approved"
                f" — this one is {claim.status}",
            )
        # The amount on the screen is the amount being approved. Recomputing
        # here means an approval cannot be given for one figure and paid at
        # another.
        _apply_calc(claim)
        _guard_recomputed_amount(claim, payload.expected_amount)

        claim.principal_approved_by = user
        claim.principal_approved_at = timezone.now()
        # The principal is, by definition, a different pair of eyes from the
        # desk that cleared it, so their approval also satisfies the
        # second-signature rule where one is outstanding.
        if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
            claim.second_approved_by = user
            claim.second_approved_at = timezone.now()
        _transition(claim, user, ClaimStatus.PRINCIPAL_APPROVED, "PRINCIPAL_APPROVE", payload.note)
        amount = claim.remuneration or 0

    _notify_finance(
        claim,
        f"Approved for payment · {claim.ticket_number}",
        f"₹{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
    )
    return claim_to_dict(claim)


@api.get("/principal/queue", auth=session_auth)
def principal_queue(
    request: HttpRequest,
    q: Optional[str] = None,
    department: Optional[str] = None,
    quartile: Optional[str] = None,
    min_amount: Optional[float] = None,
    max_amount: Optional[float] = None,
    waiting_over: Optional[int] = None,
    sort: str = "waiting",
    limit: int = 50,
    offset: int = 0,
):
    """Everything cleared and waiting on the principal, sliced.

    The totals are returned for the whole filtered set, not the page: a
    decision about a month's spend cannot be taken from the fifty rows that
    happen to be on screen.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")

    qs = (
        Claim.objects.filter(status=ClaimStatus.CLEARED)
        .select_related("owner", "cleared_by", "override_by")
        .prefetch_related("attachments")
    )
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(journal_title__icontains=term)
        )
    if department:
        qs = qs.filter(owner__department__iexact=department)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if min_amount is not None:
        qs = qs.filter(remuneration__gte=min_amount)
    if max_amount is not None:
        qs = qs.filter(remuneration__lte=max_amount)
    if waiting_over:
        qs = qs.filter(cleared_at__lte=timezone.now() - timedelta(days=int(waiting_over)))

    sorts = {
        "waiting": "cleared_at",          # longest wait first
        "recent": "-cleared_at",
        "amount": "-remuneration",
        "amount_asc": "remuneration",
        "department": "owner__department",
        "title": "paper_title",
    }
    qs = qs.order_by(sorts.get(sort, "cleared_at"))

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    agg = qs.aggregate(amount=Sum("remuneration"), oldest=Min("cleared_at"))
    oldest = agg["oldest"]

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in qs[offset : offset + limit]],
        # Over everything the filter matched, not the page.
        "totals": {
            "count": total,
            "amount": round(agg["amount"] or 0, 2),
            "longest_wait_days": (timezone.now() - oldest).days if oldest else None,
        },
        "departments": sorted(
            d
            for d in Claim.objects.filter(status=ClaimStatus.CLEARED)
            .values_list("owner__department", flat=True)
            .distinct()
            if d
        ),
    }


class PrincipalBulkIn(Schema):
    claim_ids: list[str]
    note: Optional[str] = None


@api.post("/principal/bulk-approve", auth=session_auth)
def principal_bulk_approve(request: HttpRequest, payload: PrincipalBulkIn):
    """Approve a batch, one row at a time, skipping what does not qualify.

    A batch that fails as a unit is a batch nobody dares run: one stale row out
    of two hundred and the principal is back to clicking through them
    individually.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")
    ids = list(dict.fromkeys(payload.claim_ids or []))[:500]
    if not ids:
        raise HttpError(400, "Nothing selected")

    approved = 0
    total = 0.0
    skipped: list[dict[str, str]] = []
    for claim_id in ids:
        with transaction.atomic():
            claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
            if claim is None:
                skipped.append({"id": claim_id, "reason": "Not found"})
                continue
            if claim.status != ClaimStatus.CLEARED:
                skipped.append({
                    "id": claim_id,
                    "reason": f"{claim.ticket_number or claim_id}: status is {claim.status}",
                })
                continue
            shown = claim.remuneration
            _apply_calc(claim)
            if round(shown or 0, 2) != round(claim.remuneration or 0, 2):
                skipped.append({
                    "id": claim_id,
                    "reason": (
                        f"{claim.ticket_number or claim_id}: amount changed on "
                        f"recalculation (₹{(shown or 0):,.0f} → ₹{(claim.remuneration or 0):,.0f})"
                        " — open it to review"
                    ),
                })
                transaction.set_rollback(True)
                continue
            claim.principal_approved_by = user
            claim.principal_approved_at = timezone.now()
            if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
                claim.second_approved_by = user
                claim.second_approved_at = timezone.now()
            _transition(
                claim, user, ClaimStatus.PRINCIPAL_APPROVED, "PRINCIPAL_APPROVE", payload.note
            )
            approved += 1
            total += claim.remuneration or 0
        _notify_finance(
            claim,
            f"Approved for payment · {claim.ticket_number}",
            f"₹{(claim.remuneration or 0):,.0f} for {claim.owner.name}: {claim.paper_title}",
        )
    return {"approved": approved, "total": round(total, 2), "skipped": skipped}


@api.post("/claims/{claim_id}/principal-reject", auth=session_auth)
def principal_reject(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Send a cleared ticket back to the research cell with a reason.

    Back to the cell rather than to the claimant: what the principal is
    querying is the checking, and a claimant told "sent back" with no reason
    they can act on simply resubmits the same thing.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")
    note = (payload.note or "").strip()
    if len(note) < 5:
        raise HttpError(400, "Say why it is going back")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.CLEARED:
            raise HttpError(400, "Only a cleared ticket can be sent back from here")
        claim.status_note = note
        _transition(claim, user, ClaimStatus.SUBMITTED, "PRINCIPAL_SEND_BACK", note)

    _notify_admins(
        claim,
        f"Sent back by the principal · {claim.ticket_number}",
        note[:300],
    )
    return claim_to_dict(claim)


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
    reverify: bool = False,
) -> Claim:
    """One payment, atomically, with every guard. Raises HttpError on refusal.

    Recomputes from the stored verified columns and never calls Scopus. External
    re-verification belongs at clearing, which is the step that decides whether
    the figures are trustworthy; repeating it here made Finance a hostage to
    Scopus. A single payment used to re-verify and answer 502 during an outage,
    and `skip_external` is super-admin only, so a Finance user had no way
    through at all — while bulk mark-paid, which never called out, worked fine.
    """
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        # Payable means the principal approved it on this system. Two things
        # are deliberately not payable:
        #
        # - a merely cleared ticket, which the research cell has checked but
        #   nobody has agreed to spend money on;
        # - a row carrying an approval status from the old ERP import, which
        #   has no verification, no recomputed amount and nobody's signature
        #   behind it. Those are told apart by principal_approved_at, which
        #   only a live approval sets.
        approved_here = bool(claim.principal_approved_at)
        if not (claim.status == ClaimStatus.PRINCIPAL_APPROVED and approved_here):
            if claim.status == ClaimStatus.CLEARED:
                raise HttpError(
                    400,
                    "Cleared, but not yet approved by the principal — payment "
                    "needs that approval first.",
                )
            if claim.status in PAYABLE_STATUSES:
                raise HttpError(
                    400,
                    "This ticket is on a retired approval status from the old ERP. "
                    "A super admin must move it to Cleared before it can be paid, "
                    "so the amount is verified rather than taken from the import.",
                )
            raise HttpError(
                400, "Invalid status — the ticket must be approved by the principal first"
            )
        # Net of the ledger, not mere existence: a voided payment leaves a
        # reversing row behind, and the claim must be payable again.
        net_paid = claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
        if net_paid > 0:
            raise HttpError(400, "Already processed")
        if claim.status == ClaimStatus.PRINCIPAL_APPROVED:
            # Recompute from the stored verified columns, then require the
            # confirmed amount.
            if _needs_second_approval(claim):
                if claim.duplicate_warning and claim.override_duplicate:
                    who = claim.override_by.name if claim.override_by else "somebody"
                    raise HttpError(
                        400,
                        f"The payment-history warning on this ticket was set aside by "
                        f"{who}. A second approver, different from the person who "
                        "cleared it, must confirm before it is paid.",
                    )
                raise HttpError(
                    400,
                    "High-value claim — a second approver (different from the person "
                    "who cleared it) must approve before payment",
                )
            if reverify:
                _reverify_or_recalc(claim, user, skip_external=skip_external)
            else:
                _apply_calc(claim)
            _guard_recomputed_amount(claim, expected_amount)
        # Vouchers are no longer typed in: finance had a free-text box that could
        # be left blank or reused, and the number carried no meaning. Imported
        # history keeps whatever it came with.
        if voucher_number:
            claim.voucher_number = str(voucher_number)[:64]
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
    # Admin only. The Principal oversees and reports; giving that account a
    # money action was the one thing stopping it from being purely read-only.
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        # Either side of the principal's approval: the second signature is
        # about a large amount, not about which desk the ticket is sitting on.
        if claim.status not in (ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED):
            raise HttpError(
                400, "Only a cleared or principal-approved ticket can be second-approved"
            )
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


def _reports_queryset(
    user: User,
    year: Optional[int],
    department: Optional[str],
    month: Optional[str] = None,
):
    qs = _claims_queryset(user).exclude(status=ClaimStatus.DRAFT)
    if year:
        qs = qs.filter(publication_year=year)
    if department:
        qs = qs.filter(owner__department__iexact=department)
    if month:
        # "2026-03": the payout month, which is what the college settles in
        # and what finance reconciles against -- not the publication date.
        try:
            y, m = (int(part) for part in month.split("-", 1))
        except (TypeError, ValueError):
            raise HttpError(400, "Month must look like 2026-03")
        if not 1 <= m <= 12:
            raise HttpError(400, "Month must look like 2026-03")
        qs = qs.filter(payout_month__year=y, payout_month__month=m)
    return qs


def _payout_months(user: User) -> list[str]:
    """Every month the college has actually settled something in, newest first."""
    seen = (
        _claims_queryset(user)
        .exclude(payout_month__isnull=True)
        .dates("payout_month", "month", order="DESC")
    )
    return [d.strftime("%Y-%m") for d in seen]


def _pipeline_stages(qs) -> list[dict[str, Any]]:
    """How much work sits at each stage, and how long it has sat there.

    Deliberately not "average time from submission to payment": the imported
    history carries one timestamp per row, so any duration computed across it
    would be zero and would read as instant processing. Age of what is waiting
    now is a real measurement, and it is the one an admin can act on.
    """
    now = timezone.now()
    stages = [
        ("DRAFT", "Draft", "started, not yet submitted"),
        ("SUBMITTED", "Awaiting clearance", "with the research cell"),
        ("CLEARED", "Awaiting payment", "with finance"),
        ("PAID", "Paid", "settled"),
        ("REJECTED", "Returned", "sent back to the claimant"),
    ]
    out = []
    for status, label, blurb in stages:
        rows_ = list(
            qs.filter(status=status).values_list("updated_at", "remuneration")
        )
        if not rows_ and status not in ("SUBMITTED", "CLEARED"):
            continue
        ages = sorted(
            (now - u).days for u, _ in rows_ if u is not None
        )
        median = ages[len(ages) // 2] if ages else 0
        out.append(
            {
                "key": status,
                "label": label,
                "blurb": blurb,
                "count": len(rows_),
                "amount": round(sum(a or 0 for _, a in rows_), 2),
                "median_age_days": median,
                "oldest_age_days": ages[-1] if ages else 0,
            }
        )
    return out


def _multi_rows(source, field: str) -> list[dict[str, Any]]:
    """Count a comma-separated set field once per member.

    The rows overlap -- one paper in both Scopus and SCIE is counted under
    each -- so the total across the bars exceeds the number of papers. That is
    the honest shape of the question, and the caption says as much.
    """
    buckets: dict[str, dict[str, Any]] = {}
    for value, amount in source.values_list(field, "remuneration"):
        parts = [p.strip() for p in (value or "").split(",") if p.strip()]
        for part in parts or ["Not stated"]:
            slot = buckets.setdefault(part, {"key": part, "count": 0, "amount": 0.0})
            slot["count"] += 1
            # Amount is deliberately not divided between the indexes: each bar
            # answers "money on papers listed here", not a share of a total.
            slot["amount"] += amount or 0
    return sorted(
        (
            {"key": b["key"], "count": b["count"], "amount": round(b["amount"], 2)}
            for b in buckets.values()
        ),
        key=lambda b: -b["count"],
    )


def _people_rows(source) -> list[dict[str, Any]]:
    """One row per person, carrying the id the screen needs to link to them."""
    rows = [
        {
            "key": r["owner__name"] or "Unknown",
            "id": r["owner_id"],
            "department": r["owner__department"],
            "count": r["n"],
            "amount": round(r["total"] or 0, 2),
        }
        for r in source.values("owner_id", "owner__name", "owner__department")
        .annotate(n=Count("id"), total=Sum("remuneration"))
        .order_by("-n")
    ]
    return sorted(rows, key=lambda r: -r["count"])


def _capped(bucket_rows: list[dict[str, Any]], limit: int) -> dict[str, Any]:
    """The top rows, and an honest account of what was left out.

    A silently truncated top-15 reads as "these are all of them", and the
    reader draws a conclusion about a tail they were never shown.
    """
    kept = bucket_rows[:limit]
    rest = bucket_rows[limit:]
    return {
        "rows": kept,
        "hidden": len(rest),
        "hidden_count": sum(r["count"] for r in rest),
        "hidden_amount": round(sum(r["amount"] for r in rest), 2),
    }


def _per_paper(paid_qs) -> dict[str, Any]:
    """What one paid paper is worth -- mean, median, and the range.

    The mean alone is misleading here: the scheme pays a few Q1 papers many
    times what it pays a Q4 one, so the average sits above almost every actual
    payment. The median is the figure that describes a typical claim.
    """
    amounts = sorted(
        a for a in paid_qs.values_list("remuneration", flat=True) if a is not None
    )
    if not amounts:
        return {"count": 0, "mean": 0, "median": 0, "min": 0, "max": 0}
    mid = len(amounts) // 2
    median = (
        amounts[mid] if len(amounts) % 2 else (amounts[mid - 1] + amounts[mid]) / 2
    )
    return {
        "count": len(amounts),
        "mean": round(sum(amounts) / len(amounts), 2),
        "median": round(median, 2),
        "min": round(amounts[0], 2),
        "max": round(amounts[-1], 2),
    }


#: How long something has sat, in words a reader can act on.
AGE_BUCKETS = [
    (0, 7, "Up to a week"),
    (8, 14, "1–2 weeks"),
    (15, 30, "2–4 weeks"),
    (31, 90, "1–3 months"),
    (91, 10_000, "Over 3 months"),
]


def _ageing_rows(qs):
    """The unfinished work, by how long it has been waiting.

    Only what is still in flight: a paid ticket has stopped ageing, and
    including it would bury the eleven that need chasing under three thousand
    that do not.
    """
    live = qs.exclude(status__in=[ClaimStatus.PAID, ClaimStatus.REJECTED, ClaimStatus.DRAFT])
    buckets = {label: {"key": label, "count": 0, "amount": 0.0} for _, _, label in AGE_BUCKETS}
    oldest = None
    # No .only() here: the base queryset select_related's the owner, and
    # deferring it makes Django refuse the join. The live set is under a
    # hundred rows anyway, so there was nothing to save.
    for claim in live:
        days = _waiting_days(claim)
        if days is None:
            continue
        for low, high, label in AGE_BUCKETS:
            if low <= days <= high:
                buckets[label]["count"] += 1
                buckets[label]["amount"] += claim.remuneration or 0
                break
        if oldest is None or days > oldest:
            oldest = days
    # Order is the reader's, not the data's: a bucket with nothing in it is
    # still worth showing, because "nothing over three months" is the answer
    # somebody wanted.
    return [buckets[label] for _, _, label in AGE_BUCKETS], oldest


def _ageing_payload(qs) -> dict[str, Any]:
    rows, oldest = _ageing_rows(qs)
    return {"rows": rows, "oldest_days": oldest, "total": sum(r["count"] for r in rows)}


def _breadth_rows(qs) -> list[dict[str, Any]]:
    """Per year: how many people, and how concentrated.

    Output can rise because more people published or because the same people
    published more, and a total cannot tell those apart. The top-ten share
    says which happened.
    """
    per_year: dict[int, dict[str, Any]] = {}
    for year, owner_id in qs.exclude(publication_year__isnull=True).values_list(
        "publication_year", "owner_id"
    ):
        slot = per_year.setdefault(year, {"count": 0, "people": {}})
        slot["count"] += 1
        slot["people"][owner_id] = slot["people"].get(owner_id, 0) + 1

    out = []
    for year in sorted(per_year):
        slot = per_year[year]
        counts = sorted(slot["people"].values(), reverse=True)
        people = len(counts)
        top_ten = sum(counts[:10])
        out.append(
            {
                "key": str(year),
                "count": slot["count"],
                "people": people,
                "per_person": round(slot["count"] / people, 2) if people else 0,
                "top_ten_share": round(top_ten / slot["count"] * 100) if slot["count"] else 0,
            }
        )
    return out


def _year_on_year_rows(qs) -> list[dict[str, Any]]:
    """Each department against its own previous year.

    Compared on publication year rather than payout month: a department is
    judged on what it published, not on when the college got round to paying
    for it.
    """
    years = sorted(
        {
            y
            for y in qs.exclude(publication_year__isnull=True).values_list(
                "publication_year", flat=True
            )
        }
    )
    if len(years) < 2:
        return []
    this_year, last_year = years[-1], years[-2]

    def counts_for(year: int) -> dict[str, int]:
        return {
            (r["owner__department"] or "No department"): r["n"]
            for r in qs.filter(publication_year=year)
            .values("owner__department")
            .annotate(n=Count("id"))
        }

    now, before = counts_for(this_year), counts_for(last_year)
    rows = []
    for department in sorted(set(now) | set(before)):
        current, previous = now.get(department, 0), before.get(department, 0)
        rows.append(
            {
                "key": department,
                "count": current,
                "previous": previous,
                "change": current - previous,
                # A department that published nothing last year has no
                # percentage change; reporting one would divide by zero and
                # print an infinity where a reader expects a figure.
                "percent": round((current - previous) / previous * 100) if previous else None,
            }
        )
    rows.sort(key=lambda r: -r["count"])
    # The current year is not over. Comparing eight months of 2026 against
    # twelve of 2025 makes every department look like it is collapsing --
    # ECE reads -59% on this data -- and a reader who is not told will
    # believe it. The comparison is still the one people ask for, so it is
    # shown with the caveat rather than quietly swapped for an older pair.
    today = timezone.localdate()
    partial = this_year >= today.year
    return {
        "this_year": this_year,
        "last_year": last_year,
        "this_year_is_partial": partial,
        "months_elapsed": today.month if partial else 12,
        "rows": rows,
    }



@api.get("/reports", auth=session_auth)
def reports(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    month: Optional[str] = None,
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

    qs = _reports_queryset(user, year, department, month)
    paid = qs.filter(status=ClaimStatus.PAID)
    payable = qs.filter(status__in=PAYABLE_STATUSES)

    #: Values that mean "nothing was recorded" rather than a real category.
    _BLANKISH = {"", "-", "--", "n/a", "na", "none", "null", "nil", "—", "–"}

    def rows(field: str, source=qs, label_blank: str = "Not recorded"):
        """Group by a field, folding the ways a blank can be spelt.

        Grouping on the raw column split one idea across several bars: the
        quartile chart carried "No quartile" (22), "No Quartile" (1) and "-" (1)
        as three separate rows, so no line in the report was the real total.
        """
        buckets: dict[str, dict[str, Any]] = {}
        for r in (
            source.values(field)
            .annotate(count=Count("id"), amount=Sum("remuneration"))
            .order_by("-count")
        ):
            raw = (r[field] or "").strip() if isinstance(r[field], str) else r[field]
            label = label_blank if (raw is None or str(raw).strip().lower() in _BLANKISH) else str(raw)
            slot = buckets.setdefault(
                label.casefold(), {"key": label, "count": 0, "amount": 0.0, "top": 0}
            )
            # Keep the spelling that most rows actually used.
            if r["count"] > slot["top"]:
                slot["key"] = label
                slot["top"] = r["count"]
            slot["count"] += r["count"]
            slot["amount"] += r["amount"] or 0
        out = [
            {"key": b["key"], "count": b["count"], "amount": round(b["amount"], 2)}
            for b in buckets.values()
        ]
        out.sort(key=lambda b: -b["count"])
        return out

    # A publication counts institutionally even when it carries no money.
    count_only = qs.filter(
        Q(claim_reason=ClaimReason.COUNT_ONLY) | Q(is_student_publication=True)
    ).count()

    year_rows = {
        int(r["publication_year"]): {
            "key": str(r["publication_year"]),
            "count": r["count"],
            "amount": round(r["amount"] or 0, 2),
        }
        for r in (
            qs.exclude(publication_year__isnull=True)
            .values("publication_year")
            .annotate(count=Count("id"), amount=Sum("remuneration"))
            .order_by("publication_year")
        )
    }
    # A year with nothing in it is a real answer, and leaving it out of the
    # series draws a straight climb from 2019 to 2023 across four years that
    # never happened. Plotted as the zeros they were.
    by_year = [
        year_rows.get(y, {"key": str(y), "count": 0, "amount": 0.0})
        for y in range(min(year_rows), max(year_rows) + 1)
    ] if year_rows else []

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
        "by_year": by_year,
        "by_type": rows("aggregation_type", label_blank="Not stated"),
        "by_indexing": _multi_rows(qs, "indexing_level"),
        "by_designation": rows("owner__designation", label_blank="Not recorded"),
        # Three cuts the page could not make. See the helpers above for what
        # each answers and, in the ageing case, why it is measured from the
        # live workflow rather than from the imported timestamps.
        "ageing": _ageing_payload(qs),
        "breadth": _breadth_rows(qs),
        "year_on_year": _year_on_year_rows(qs),
        # Long tails, so these are cut to what a chart can carry legibly. The
        # cut is reported rather than left to look like the whole set.
        "by_journal": _capped(rows("journal_title", label_blank="Not recorded"), 15),
        # Carrying the id, so a name in a report can open that person's record
        # rather than being a dead end the reader has to retype into a search.
        "top_by_publications": _capped(_people_rows(qs), 15),
        "top_by_amount": _capped(
            sorted(_people_rows(paid), key=lambda r: -r["amount"]), 15
        ),
        "per_paper": _per_paper(paid),
        "pipeline": _pipeline_stages(qs),
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
        # The months the college has actually settled in, so the picker offers
        # real ones rather than a calendar of mostly-empty options.
        "payout_months": _payout_months(user),
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
    # Narrowing to one person or one journal is what every drill-down from a
    # record page needs. Without them a chart on Dr X's page linked to the
    # college's Q1 papers rather than to hers, which is a worse answer than
    # no link at all.
    if f.get("owner"):
        qs = qs.filter(owner_id=f["owner"])
    if f.get("journal"):
        qs = qs.filter(journal_title__iexact=f["journal"])
    # The last three dimensions the reports draw that nothing could open. A
    # figure the reader cannot get behind is a figure they have to take on
    # trust, and these are the ones people query in meetings: which grade is
    # publishing, what kind of thing it was, and which month it was settled.
    if f.get("designation"):
        blank = f["designation"] in {"Not recorded", "Not stated", "—"}
        qs = (
            qs.filter(Q(owner__designation__isnull=True) | Q(owner__designation=""))
            if blank
            else qs.filter(owner__designation__iexact=f["designation"])
        )
    if f.get("publication_type"):
        blank = f["publication_type"] in {"Not stated", "Not recorded", "—"}
        qs = (
            qs.filter(Q(aggregation_type__isnull=True) | Q(aggregation_type=""))
            if blank
            else qs.filter(aggregation_type__iexact=f["publication_type"])
        )
    if f.get("month"):
        # "2026-08" — the month the college settled it, which is how the
        # payout chart is keyed and how Finance talks about a run.
        try:
            year_s, month_s = str(f["month"]).split("-")[:2]
            qs = qs.filter(payout_month__year=int(year_s), payout_month__month=int(month_s))
        except (ValueError, TypeError):
            raise HttpError(400, "A month looks like 2026-08.")
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
    owner: Optional[str] = None,
    journal: Optional[str] = None,
    designation: Optional[str] = None,
    publication_type: Optional[str] = None,
    month: Optional[str] = None,
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
        min_amount=min_amount, owner=owner, journal=journal,
        designation=designation, publication_type=publication_type, month=month,
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


#: Roughly the width each column needs to be read without adjustment, in the
#: order of _EXPORT_HEADERS.
_EXPORT_WIDTHS = [
    14, 12, 26, 22, 12, 60, 40, 14, 28, 8, 20, 18, 10, 8,
    18, 9, 9, 12, 14, 13, 12, 14, 13, 14,
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


def _claims_file(rows, stem: str, fmt: str) -> HttpResponse:
    """The same rows as a workbook or as CSV, named the same either way."""
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
        # Enough width to read a paper title without widening every column by
        # hand, which is what the office did to every export it received.
        for column, width in zip(ws.columns, _EXPORT_WIDTHS):
            ws.column_dimensions[column[0].column_letter].width = width
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


@api.get("/reports/export", auth=session_auth)
def reports_export(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    month: Optional[str] = None,
    fmt: str = "csv",
):
    """One row per publication — the sheet the R&D office actually files.

    fmt=xlsx returns a real workbook: the office re-imported the CSV into
    Excel by hand every month anyway, mangling ISSNs into dates on the way.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = _reports_queryset(user, year, department, month).select_related("owner")
    rows = qs.order_by("owner__department", "-publication_year")[:5000]
    stem = "-".join([
        "publications",
        str(year or "all"),
        (department or "all").replace(" ", "-"),
        *( [month] if month else [] ),
    ])

    return _claims_file(rows, stem, fmt)


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


# ---------- notes on a ticket, and lookup ----------


class ClaimNoteIn(Schema):
    body: str


def _may_read_notes(role: str) -> bool:
    """Admins read them; the principal reads back what they wrote."""
    return role in rbac.ADMIN_ROLES or role == Role.PRINCIPAL


@api.get("/claims/{claim_id}/notes", auth=session_auth)
def list_claim_notes(request: HttpRequest, claim_id: str):
    """Notes raised on one ticket. Never the claimant, never finance."""
    user = require_user(request)
    if not _may_read_notes(user.role):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    return {
        "results": [
            {
                "id": n.id,
                "body": n.body,
                "author_name": n.author.name if n.author else None,
                "author_role": n.author.role if n.author else None,
                "created_at": n.created_at.isoformat(),
                "resolved_at": n.resolved_at.isoformat() if n.resolved_at else None,
                "resolved_by_name": n.resolved_by.name if n.resolved_by else None,
            }
            for n in claim.notes.select_related("author", "resolved_by")
        ]
    }


@api.post("/claims/{claim_id}/notes", auth=session_auth)
def add_claim_note(request: HttpRequest, claim_id: str, payload: ClaimNoteIn):
    """The principal raises something about a specific ticket, for the admin.

    Tied to a ticket on purpose: a general message is a mail to somebody's inbox
    and dies there, while a note on the ticket is in front of whoever picks that
    ticket up.
    """
    user = require_user(request)
    if user.role != Role.PRINCIPAL and user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "Forbidden")
    body = (payload.body or "").strip()
    if len(body) < 3:
        raise HttpError(400, "Write the note first")

    claim = get_object_or_404(Claim, pk=claim_id)
    note = ClaimNote.objects.create(
        claim=claim, author=user, body=body[:5000], audience=ClaimNote.Audience.ADMIN
    )
    _notify_admins(
        claim,
        f"{user.name or user.email} raised a note · {claim.ticket_number or 'draft'}",
        body[:300],
    )
    AuditLog.objects.create(
        actor=user, action="CLAIM_NOTE", entity="Claim", entity_id=claim.id,
        detail_json=json.dumps({"note_id": note.id}),
    )
    return {"ok": True, "id": note.id}


@api.post("/claims/notes/{note_id}/resolve", auth=session_auth)
def resolve_claim_note(request: HttpRequest, note_id: str):
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "Only the research cell closes a note")
    note = get_object_or_404(ClaimNote, pk=note_id)
    note.resolved_at = timezone.now()
    note.resolved_by = user
    note.save(update_fields=["resolved_at", "resolved_by"])
    return {"ok": True}


@api.get("/lookup/ticket", auth=session_auth)
def lookup_ticket(request: HttpRequest, q: str):
    """Find a ticket by its number, or a faculty member by id, name or email.

    One box that takes whatever somebody has to hand — a ticket number off an
    email, a staff id off a spreadsheet, or a name — instead of three screens
    that each want a different key.
    """
    user = require_user(request)
    term = (q or "").strip()
    if len(term) < 2:
        raise HttpError(400, "Type at least two characters")

    scope = _claims_queryset(user)
    tickets = scope.filter(
        Q(ticket_number__iexact=term) | Q(ticket_number__icontains=term)
    ).select_related("owner")[:20]

    people = []
    if rbac.can_view_reports(user.role) or rbac.can_manage_users(user.role):
        people = User.objects.filter(role=Role.FACULTY).filter(
            Q(staff_id__iexact=term)
            | Q(biometric_id__iexact=term)
            | Q(employee_id__iexact=term)
            | Q(email__icontains=term)
            | Q(name__icontains=term)
        )[:20]

    return {
        "tickets": [
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "paper_title": c.paper_title,
                "status": c.status,
                "owner_name": c.owner.name,
                "remuneration": c.remuneration,
            }
            for c in tickets
        ],
        "faculty": [
            {
                "id": u.id,
                "name": u.name,
                "email": u.email,
                "department": u.department,
                "staff_id": u.staff_id,
            }
            for u in people
        ],
    }


def _authorship(claims) -> list[dict[str, Any]]:
    """Where this person sits on the author list.

    First authorship is what promotion panels ask about, and the scheme pays
    on it, so it is worth its own answer rather than being inferred from the
    per-claim author point.
    """
    buckets: dict[str, dict[str, Any]] = {}
    for c in claims:
        pos = c.author_position
        if pos == 1:
            label = "First author"
        elif pos and c.total_authors and pos == c.total_authors:
            label = "Last author"
        elif pos:
            label = f"Author {pos}"
        else:
            label = "Not stated"
        slot = buckets.setdefault(label, {"key": label, "count": 0, "amount": 0.0})
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0
    rows = [
        {"key": b["key"], "count": b["count"], "amount": round(b["amount"], 2)}
        for b in buckets.values()
    ]
    #: First, last, then the middle positions in order, then the unknowns.
    def rank(r: dict[str, Any]) -> tuple[int, int]:
        if r["key"] == "First author":
            return (0, 0)
        if r["key"] == "Last author":
            return (1, 0)
        if r["key"] == "Not stated":
            return (3, 0)
        return (2, int(r["key"].split()[-1]))

    return sorted(rows, key=rank)


@api.get("/faculty/{user_id}/report", auth=session_auth)
def faculty_report(request: HttpRequest, user_id: str):
    """Everything one faculty member has published and been paid.

    The oversight portals could count the college but not a person, so
    "how has Dr X done" meant exporting the ledger and pivoting it by hand.
    """
    user = require_user(request)
    if not (rbac.can_view_reports(user.role) or rbac.can_manage_users(user.role)):
        raise HttpError(403, "Forbidden")
    person = get_object_or_404(User, pk=user_id)
    # Drafts are private working notes, not a record of anything: the person
    # has not filed them. Counting them would inflate "publications" with
    # abandoned attempts, and the export already leaves them out -- the two
    # disagreeing is worse than either answer.
    claims = (
        Claim.objects.filter(owner=person)
        .exclude(status=ClaimStatus.DRAFT)
        .order_by("-updated_at")
    )
    paid = claims.filter(status=ClaimStatus.PAID)

    by_month: dict[str, dict[str, Any]] = {}
    for c in paid.exclude(payout_month__isnull=True):
        key = c.payout_month.strftime("%Y-%m")
        slot = by_month.setdefault(key, {"key": key, "count": 0, "amount": 0.0})
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0

    def group(field: str, blank: str):
        out: dict[str, dict[str, Any]] = {}
        for c in claims:
            # Not every groupable field is text: publication_year is an int,
            # and calling .strip() on it took the whole record down.
            raw = getattr(c, field, None)
            key = (str(raw).strip() or blank) if raw not in (None, "") else blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0.0})
            slot["count"] += 1
            slot["amount"] += c.remuneration or 0
        return sorted(out.values(), key=lambda r: -r["count"])

    return {
        "faculty": _user_dict(person),
        "totals": {
            "publications": claims.count(),
            "paid_claims": paid.count(),
            "paid_amount": round(
                sum(c.remuneration or 0 for c in paid), 2
            ),
            "in_review": claims.filter(status=ClaimStatus.SUBMITTED).count(),
        },
        "by_month": sorted(by_month.values(), key=lambda r: r["key"]),
        "by_quartile": group("quartile", "No quartile"),
        "by_status": group("status", "—"),
        "by_year": sorted(
            group("publication_year", "Not stated"), key=lambda r: str(r["key"])
        ),
        "by_journal": group("journal_title", "Not recorded")[:12],
        "by_type": group("aggregation_type", "Not stated"),
        "by_position": _authorship(claims),
        "per_paper": _per_paper(paid),
        "claims": [claim_to_dict(c) for c in claims[:200]],
    }


@api.get("/faculty/{user_id}/report/export", auth=session_auth)
def faculty_report_export(request: HttpRequest, user_id: str, fmt: str = "xlsx"):
    """One faculty member's publications as a file.

    The same sheet the office files for the college, filtered to one person --
    which is what an appraisal or a promotion panel actually asks for.
    """
    user = require_user(request)
    if not (rbac.can_view_reports(user.role) or rbac.can_manage_users(user.role)):
        raise HttpError(403, "Forbidden")
    person = get_object_or_404(User, pk=user_id)
    rows = (
        Claim.objects.filter(owner=person)
        .exclude(status=ClaimStatus.DRAFT)
        .select_related("owner")
        .order_by("-publication_year", "-updated_at")[:5000]
    )
    tag = (person.staff_id or person.email.split("@")[0] or "faculty").replace(" ", "-")
    return _claims_file(rows, f"publications-{tag}", fmt)


@api.get("/reports/pack", auth=session_auth)
def reports_pack(request: HttpRequest, year: Optional[int] = None, fmt: str = "xlsx"):
    """The NAAC / NIRF submission tables, as one workbook.

    Assembled by hand from exports every year, out of data the system already
    holds. The Notes sheet says what each figure counts and what could not be
    produced, because a number in an accreditation submission has to be
    defensible a year later.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    pack = build_pack(year=year, scope=_claims_queryset(user))
    # "preview" is the on-screen view: the same tables, capped, so the page
    # can show what it is about to hand over. A pack that could only be
    # downloaded had to be opened in Excel before anyone could tell whether
    # it was the right year.
    if fmt == "preview":
        return {
            "year": year,
            "tables": [
                {
                    "name": name,
                    "columns": list(sheet["columns"]),
                    "rows": [[_json_safe(v) for v in r] for r in sheet["rows"][:25]],
                    "row_count": len(sheet["rows"]),
                }
                for name, sheet in pack.items()
            ],
        }

    if fmt not in exporters.FORMATS:
        raise HttpError(400, f"Format must be one of: {', '.join(exporters.FORMATS)}.")

    stem = f"accreditation-pack-{year or 'all-years'}"
    body = exporters.render(
        pack,
        fmt,
        title="Accreditation pack",
        subtitle=(
            f"Saveetha Engineering College · "
            f"{'publication year ' + str(year) if year else 'all years on record'}"
        ),
    )
    res = HttpResponse(body, content_type=exporters.CONTENT_TYPES[fmt])
    res["Content-Disposition"] = f'attachment; filename="{exporters.filename(stem, fmt)}"'
    AuditLog.objects.create(
        actor=user, action="REPORT_PACK", entity="Report", entity_id=stem,
        detail_json=json.dumps(
            {"year": year, "fmt": fmt, "rows": len(pack["NAAC 3.4.3"]["rows"])}
        ),
    )
    return res


def _json_safe(value):
    """Dates and Decimals do not survive a JSON response as themselves."""
    from datetime import date as _date, datetime as _datetime
    from decimal import Decimal

    if isinstance(value, (_datetime, _date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


# ---------- the accreditation rows, and correcting them ----------

#: What NAAC 3.4.3 asks for on every row. A row missing any of these is one an
#: assessor will send back, so they are named rather than left to be noticed.
PACK_REQUIRED = {
    "paper_title": "No title",
    "owner_name": "No author",
    "owner_department": "No department",
    "journal_title": "No journal",
    "publication_year": "No year",
    "issn": "No ISSN",
    "link": "No link to the paper",
}

#: The only fields this screen may change. Bibliographic only: the pack holds
#: no money, and a screen for tidying a submission must not be able to move a
#: payment or a ticket's stage.
PACK_EDITABLE = {
    "paper_title": "Title of paper",
    "journal_title": "Name of journal",
    "issn": "ISSN",
    "publication_year": "Year of publication",
    "doi": "DOI",
    "scopus_url": "Link to the paper",
}


def _pack_row(claim: Claim, listed: str) -> dict[str, Any]:
    link = claim.scopus_url or (f"https://doi.org/{claim.doi}" if claim.doi else "")
    row = {
        "id": claim.id,
        "ticket_number": claim.ticket_number,
        "paper_title": claim.paper_title or "",
        "owner_id": claim.owner_id,
        "owner_name": claim.owner.name if claim.owner_id else "",
        "owner_department": (claim.owner.department if claim.owner_id else "") or "",
        "journal_title": claim.journal_title or "",
        "publication_year": claim.publication_year or "",
        "issn": normalize_issn(claim.issn) or "",
        "doi": claim.doi or "",
        "scopus_url": claim.scopus_url or "",
        "link": link,
        "ugc_care": listed,
    }
    row["gaps"] = [label for field, label in PACK_REQUIRED.items() if not row.get(field)]
    return row


@api.get("/reports/pack/rows", auth=session_auth)
def pack_rows(
    request: HttpRequest,
    year: Optional[int] = None,
    q: Optional[str] = None,
    only: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """The submission's rows, paged, with what is wrong with each.

    `only=incomplete` is the one people want: the rows an assessor would send
    back. `only=<a gap label>` narrows further, so "No ISSN" is a list of
    exactly the rows to go and find ISSNs for.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    claims = (
        _claims_queryset(user)
        .exclude(status=ClaimStatus.DRAFT)
        .select_related("owner")
        .order_by("owner__department", "owner__name", "-publication_year")
    )
    if year:
        claims = claims.filter(publication_year=year)
    if q and q.strip():
        term = q.strip()
        claims = claims.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(issn__icontains=term)
        )

    have_ugc, ugc = _pack_ugc_status()

    def listed_for(claim: Claim) -> str:
        if not have_ugc:
            return "Not checked"
        hit = next((ugc[v] for v in _issn_variants(claim.issn) if v in ugc), None)
        return "Yes" if hit else "No"

    # The gap counts are over the whole filtered set, not the page: "412 rows
    # have no ISSN" is the number somebody plans an afternoon around, and a
    # per-page count would understate it by two orders of magnitude.
    rows = [_pack_row(c, listed_for(c)) for c in claims]
    gap_counts: dict[str, int] = {}
    for row in rows:
        for gap in row["gaps"]:
            gap_counts[gap] = gap_counts.get(gap, 0) + 1

    if only == "incomplete":
        rows = [r for r in rows if r["gaps"]]
    elif only:
        rows = [r for r in rows if only in r["gaps"]]

    limit = max(1, min(limit, 200))
    return {
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "results": rows[offset : offset + limit],
        "gaps": [
            {"key": label, "count": gap_counts.get(label, 0)}
            for label in PACK_REQUIRED.values()
        ],
        "incomplete": sum(1 for r in rows if r["gaps"]) if only else
                      sum(1 for row in rows if row["gaps"]),
        "ugc_list_loaded": have_ugc,
        "editable": PACK_EDITABLE,
    }


def _pack_ugc_status() -> tuple[bool, dict[str, bool]]:
    rows = JournalStanding.objects.filter(source=JournalStanding.Source.UGC_CARE)
    if not rows.exists():
        return False, {}
    return True, {r.issn: r.listed for r in rows}


class PackRowEditIn(Schema):
    field: str
    value: Optional[str] = None
    reason: str


@api.patch("/reports/pack/rows/{claim_id}", auth=session_auth)
def pack_row_edit(request: HttpRequest, claim_id: str, payload: PackRowEditIn):
    """Correct one bibliographic field on one row of the submission.

    One field and a reason at a time, following the data explorer: a grid that
    lets somebody change forty things and press save produces an audit entry
    nobody can reconstruct a decision from.

    The allowed set is bibliographic only. Money and the ticket's stage are not
    in it and cannot be reached from here, whatever is posted.
    """
    user = require_user(request)
    if not (rbac.can_clear_claims(user.role) or rbac.can_manage_users(user.role)):
        raise HttpError(
            403,
            "Correcting a submission row is the research cell's to do.",
        )

    field = (payload.field or "").strip()
    if field not in PACK_EDITABLE:
        raise HttpError(
            400,
            "That field is not correctable here. This screen changes what the "
            "submission says about a paper — its title, journal, ISSN, year "
            "and link — and nothing about the payment or the ticket's stage.",
        )
    reason = (payload.reason or "").strip()
    if len(reason) < 5:
        raise HttpError(400, "Say why this is being changed.")

    claim = get_object_or_404(_claims_queryset(user), pk=claim_id)
    before = getattr(claim, field, None)
    value: Any = (payload.value or "").strip() or None

    if field == "publication_year" and value is not None:
        try:
            value = int(value)
        except ValueError:
            raise HttpError(400, "The year of publication is a number, like 2025.")
        if not 1900 <= value <= date.today().year + 1:
            raise HttpError(400, "That year is outside anything this college has published in.")
    if field == "issn" and value is not None:
        value = normalize_issn(value)
    if field == "doi" and value is not None:
        value = normalize_doi(value)

    setattr(claim, field, value)
    claim.save(update_fields=[field, "updated_at"])

    ClaimAction.objects.create(
        claim=claim, actor=user, action="PACK_CORRECT",
        note=f"{PACK_EDITABLE[field]}: {before or '—'} → {value or '—'}. {reason}",
    )
    AuditLog.objects.create(
        actor=user, action="PACK_CORRECT", entity="Claim", entity_id=claim.id,
        detail_json=json.dumps({
            "field": field,
            "from": str(before) if before is not None else None,
            "to": str(value) if value is not None else None,
            "reason": reason,
        }),
    )
    have_ugc, ugc = _pack_ugc_status()
    listed = "Not checked"
    if have_ugc:
        listed = "Yes" if next(
            (ugc[v] for v in _issn_variants(claim.issn) if v in ugc), None
        ) else "No"
    return {"ok": True, "row": _pack_row(claim, listed)}


# ---------- journals ----------


def _issn_variants(issn: str | None) -> list[str]:
    """Every spelling of one ISSN that the stored data actually uses.

    Three conventions ended up in the tables, all of the same number: dashed
    ("0272-8842"), bare ("02728842"), and float-mangled ("2728842.0") from
    9,993 reference rows a spreadsheet had opened. Matching only one of them
    is why a journal with an ISSN on file still fell back to a title search.
    """
    if not issn:
        return []
    cleaned = normalize_issn(issn) or ""
    bare = cleaned.replace("-", "")
    out = {cleaned, bare, issn.strip()}
    if bare.isdigit():
        out.add(f"{int(bare)}.0")  # the leading zero the float dropped
        out.add(str(int(bare)))
    return [v for v in out if v]


def _journal_reference(title: str, issn: str | None) -> dict[str, Any]:
    """What the reference data knows about this journal, if anything.

    Claims carry a title and usually nothing else, so the ISSN route is tried
    first and the title second. A near-match on a truncated title is worse
    than no match -- it would attach another journal's SJR to this one -- so
    the title lookup demands the whole name, case-insensitively.
    """
    out: dict[str, Any] = {"scimago": None, "snip": None}

    scimago_qs = ScimagoJournal.objects.all()
    row = None
    variants = _issn_variants(issn)
    if variants:
        row = (
            scimago_qs.filter(issn__in=variants).order_by("-year").first()
            or scimago_qs.filter(eissn__in=variants).order_by("-year").first()
        )
    if row is None and title:
        row = scimago_qs.filter(title__iexact=title).order_by("-year").first()
    if row is not None:
        try:
            categories = json.loads(row.categories_json or "[]")
        except (ValueError, TypeError):
            categories = []
        # Scimago nests the quartile inside each subject category, so a journal
        # is Q1 in one field and Q3 in another. Both are true; the best one is
        # what the policy pays on, and hiding the rest would misdescribe it.
        labels: list[dict[str, Any]] = []
        for c in categories if isinstance(categories, list) else []:
            if isinstance(c, dict):
                name = c.get("category") or c.get("name") or ""
                q = c.get("quartile") or c.get("Quartile") or ""
                if name:
                    labels.append({"category": str(name), "quartile": str(q or "—")})
        # SCImago's own id for the journal, which addresses its page directly.
        # Stored as "21522.0" because the dump was read as numbers, and a
        # search by title lands on a results page — or on nothing at all, for
        # a conference series whose name runs to fifteen words.
        source_id = (row.source_id or "").strip()
        if source_id.endswith(".0"):
            source_id = source_id[:-2]
        out["scimago"] = {
            "source_id": source_id or None,
            "sjr": row.sjr,
            "year": row.year,
            "issn": row.issn,
            "eissn": row.eissn,
            "verified_live": row.verified_live,
            "categories": labels[:12],
            "best_quartile": min(
                (c["quartile"] for c in labels if c["quartile"].startswith("Q")),
                default=None,
            ),
        }

    snip_row = None
    if variants:
        snip_row = (
            SnipSource.objects.filter(print_issn__in=variants).first()
            or SnipSource.objects.filter(e_issn__in=variants).first()
        )
    if snip_row is None and title:
        snip_row = SnipSource.objects.filter(title__iexact=title).first()
    if snip_row is not None:
        out["snip"] = {"snip": snip_row.snip, "sjr": snip_row.sjr, "year": snip_row.year}

    return out


@api.get("/journals/report", auth=session_auth)
def journal_report(request: HttpRequest, title: str):
    """One journal: what it is, and what the college has published in it.

    A head of department sees the same record narrowed to their own staff and
    with the money taken out, which is the rule everywhere else they look.
    """
    user = require_user(request)
    is_head = user.role == Role.HOD
    if not (
        is_head
        or rbac.can_view_reports(user.role)
        or rbac.can_manage_users(user.role)
    ):
        raise HttpError(403, "Forbidden")

    name = (title or "").strip()
    if not name:
        raise HttpError(400, "Name a journal.")

    if is_head:
        base = _hod_scope(user)
    else:
        base = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    claims = list(
        base.filter(journal_title__iexact=name)
        .select_related("owner")
        .order_by("-publication_year", "-updated_at")
    )
    if not claims:
        raise HttpError(404, "No publication on record names that journal.")

    paid = [c for c in claims if c.status == ClaimStatus.PAID]

    def group(field: str, blank: str) -> list[dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for c in claims:
            raw = getattr(c, field, None)
            key = (str(raw).strip() or blank) if raw not in (None, "") else blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0.0})
            slot["count"] += 1
            slot["amount"] += c.remuneration or 0
        return sorted(out.values(), key=lambda r: -r["count"])

    # One row per author, so "who publishes here" is answerable without
    # reading the ticket list -- and each row carries the id, so the name is
    # a door to that person's record rather than a label.
    authors: dict[str, dict[str, Any]] = {}
    for c in claims:
        owner = c.owner
        if owner is None:
            continue
        slot = authors.setdefault(
            owner.id,
            {
                "key": owner.name or owner.email,
                "id": owner.id,
                "department": owner.department or "—",
                "count": 0,
                "amount": 0.0,
            },
        )
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0

    years = [c.publication_year for c in claims if c.publication_year]
    # The ISSN is worth having from any ticket that recorded one, because the
    # reference lookup is far more reliable with it than with a title.
    issn = next((c.issn for c in claims if c.issn), None)

    def first(field: str):
        return next((getattr(c, field) for c in claims if getattr(c, field, None)), None)

    payload = {
        "journal": {
            "title": name,
            # Shown normalised: the ticket carries "2728842" because a
            # spreadsheet dropped the leading zero, and printing that back
            # gives the reader a number that will not find the journal
            # anywhere else.
            "issn": normalize_issn(issn) if issn else None,
            "indexing": first("indexing_level"),
            "engineering_class": first("engineering_class"),
            "subject_category": first("subject_category"),
            # The SNIP the college actually paid on, which is not always what
            # the current dump says -- a journal's SNIP moves year to year.
            "snip_on_record": first("snip"),
            "snip_year_on_record": first("snip_year"),
            **_journal_reference(name, issn),
        },
        "totals": {
            "publications": len(claims),
            "authors": len(authors),
            "departments": len({c.owner.department for c in claims if c.owner and c.owner.department}),
            "paid_claims": len(paid),
            "paid_amount": round(sum(c.remuneration or 0 for c in paid), 2),
            "first_year": min(years) if years else None,
            "last_year": max(years) if years else None,
        },
        "by_year": sorted(group("publication_year", "Not stated"), key=lambda r: str(r["key"])),
        "by_quartile": group("quartile", "No quartile"),
        "by_status": group("status", "—"),
        "by_department": sorted(
            [
                {"key": k or "—", "count": v["count"], "amount": v["amount"]}
                for k, v in _by_department(claims).items()
            ],
            key=lambda r: -r["count"],
        ),
        "authors": sorted(authors.values(), key=lambda r: -r["count"])[:50],
        "claims": [claim_to_dict(c) for c in claims[:200]],
    }
    if not is_head:
        return payload

    # A head reads progress, not workflow status. "PAID" is not an amount, but
    # it is still the statement that a named colleague was paid, which is the
    # thing their screens do not say -- and the money-blindness audit reads
    # every byte that comes back, so it caught this the moment the endpoint
    # opened to them.
    payload["by_status"] = sorted(
        _fold_by_progress(payload["by_status"]), key=lambda r: -r["count"]
    )
    for row in payload["claims"]:
        row["progress"] = hod.progress_of(row.pop("status", None))
    return hod.without_money(payload)


def _fold_by_progress(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Several statuses share one progress word, so their counts add up."""
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        key = hod.progress_of(r["key"])
        slot = out.setdefault(key, {"key": key, "count": 0})
        slot["count"] += r["count"]
    return list(out.values())


def _by_department(claims) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for c in claims:
        key = (c.owner.department if c.owner else None) or "Not stated"
        slot = out.setdefault(key, {"count": 0, "amount": 0.0})
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0
    return out


@api.get("/journals/top", auth=session_auth)
def journals_top(request: HttpRequest, q: str | None = None, limit: int = 100):
    """The journals the college publishes in, most-used first."""
    user = require_user(request)
    is_head = user.role == Role.HOD
    if not (
        is_head
        or rbac.can_view_reports(user.role)
        or rbac.can_manage_users(user.role)
    ):
        raise HttpError(403, "Forbidden")

    base = _hod_scope(user) if is_head else Claim.objects.exclude(status=ClaimStatus.DRAFT)
    base = base.exclude(journal_title__isnull=True).exclude(journal_title="")
    if q:
        base = base.filter(journal_title__icontains=q.strip())
    rows = (
        base.values("journal_title")
        .annotate(count=Count("id"), amount=Sum("remuneration"))
        .order_by("-count")[: max(1, min(limit, 500))]
    )
    out = [
        {
            "key": r["journal_title"],
            "count": r["count"],
            "amount": round(r["amount"] or 0, 2),
        }
        for r in rows
    ]
    return hod.without_money({"results": out}) if is_head else {"results": out}


# ---------- head of department ----------


def _hod_scope(user: User):
    """Every filed publication from this head's own department.

    Drafts are excluded: an unfinished ticket is the claimant's working paper,
    not the department's output, and counting them would tell a head they had
    more publications than they do.
    """
    department = hod.department_of(user)
    if not department:
        raise HttpError(
            400,
            "This account has no department set, so there is nothing to show. "
            "Ask the research cell to set it.",
        )
    return (
        Claim.objects.filter(owner__department__iexact=department)
        .exclude(status=ClaimStatus.DRAFT)
        .select_related("owner")
    )


def _require_hod(request: HttpRequest) -> User:
    user = require_user(request)
    if user.role != Role.HOD:
        raise HttpError(403, "Forbidden")
    return user


@api.get("/hod/overview", auth=session_auth)
def hod_overview(request: HttpRequest, year: Optional[int] = None):
    """What the department has published, and by whom. No money anywhere."""
    user = _require_hod(request)
    qs = _hod_scope(user)
    if year:
        qs = qs.filter(publication_year=year)

    def bucket(field: str, blank: str) -> list[dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for value in qs.values_list(field, flat=True):
            key = (str(value).strip() if value not in (None, "") else blank) or blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0})
            slot["count"] += 1
        return sorted(out.values(), key=lambda r: -r["count"])

    # Members of the department, whether or not they have published: a head
    # needs to see who has nothing as much as who has most.
    people = User.objects.filter(
        role=Role.FACULTY, department__iexact=hod.department_of(user)
    ).order_by("name")
    counts = {
        row["owner_id"]: row["n"]
        for row in qs.values("owner_id").annotate(n=Count("id"))
    }
    first_author = {
        row["owner_id"]: row["n"]
        for row in qs.filter(author_position=1).values("owner_id").annotate(n=Count("id"))
    }
    q1 = {
        row["owner_id"]: row["n"]
        for row in qs.filter(quartile__iexact="Q1").values("owner_id").annotate(n=Count("id"))
    }

    years = sorted({y for y in qs.values_list("publication_year", flat=True) if y})
    by_year = []
    if years:
        per = {
            row["publication_year"]: row["n"]
            for row in qs.exclude(publication_year__isnull=True)
            .values("publication_year")
            .annotate(n=Count("id"))
        }
        # Empty years plotted as the zeros they are, not skipped: a gap drawn
        # as a straight line reads as steady output through years with none.
        by_year = [
            {"key": str(y), "count": per.get(y, 0), "amount": 0}
            for y in range(min(years), max(years) + 1)
        ]

    indexing: dict[str, int] = {}
    for raw in qs.values_list("indexing_level", flat=True):
        for part in [p.strip() for p in (raw or "").split(",") if p.strip()] or ["Not stated"]:
            indexing[part] = indexing.get(part, 0) + 1

    return hod.without_money({
        "department": hod.department_of(user),
        "years_on_record": sorted(
            {y for y in _hod_scope(user).values_list("publication_year", flat=True) if y},
            reverse=True,
        ),
        "year": year,
        "totals": {
            "publications": qs.count(),
            "faculty_in_department": people.count(),
            "faculty_who_published": len(counts),
            "q1": qs.filter(quartile__iexact="Q1").count(),
            "first_author": qs.filter(author_position=1).count(),
            "under_review": qs.filter(
                status__in=(ClaimStatus.SUBMITTED, ClaimStatus.CLEARED)
            ).count(),
        },
        "by_year": by_year,
        "by_quartile": bucket("quartile", "Not recorded"),
        "by_type": bucket("aggregation_type", "Not stated"),
        "by_journal": bucket("journal_title", "Not recorded")[:12],
        "by_indexing": sorted(
            ({"key": k, "count": v, "amount": 0} for k, v in indexing.items()),
            key=lambda r: -r["count"],
        ),
        "people": [
            {
                "id": p.id,
                "name": p.name,
                "designation": p.designation,
                "staff_id": p.staff_id,
                "publications": counts.get(p.id, 0),
                "first_author": first_author.get(p.id, 0),
                "q1": q1.get(p.id, 0),
                "active": p.active,
            }
            for p in people
        ],
    })


@api.get("/hod/publications", auth=session_auth)
def hod_publications(
    request: HttpRequest,
    q: Optional[str] = None,
    year: Optional[int] = None,
    quartile: Optional[str] = None,
    person: Optional[str] = None,
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
):
    """Every filed publication in the department, one row each."""
    user = _require_hod(request)
    qs = _hod_scope(user)
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(owner__name__icontains=term)
        )
    if year:
        qs = qs.filter(publication_year=year)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if person:
        qs = qs.filter(owner_id=person)

    sorts = {
        "recent": "-updated_at",
        "year": "-publication_year",
        "title": "paper_title",
        "person": "owner__name",
        "journal": "journal_title",
    }
    qs = qs.order_by(sorts.get(sort, "-updated_at"))

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()

    return hod.without_money({
        "total": total,
        "limit": limit,
        "offset": offset,
        "department": hod.department_of(user),
        "results": [
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "paper_title": c.paper_title,
                "journal_title": c.journal_title,
                "issn": c.issn,
                "doi": c.doi,
                "publication_year": c.publication_year,
                "quartile": c.quartile,
                "snip": c.snip,
                "indexing_level": c.indexing_level,
                "publication_type": c.publication_type,
                "author_position": c.author_position,
                "total_authors": c.total_authors,
                "owner_name": c.owner.name,
                "owner_id": c.owner_id,
                # The DOI resolves for anybody; the Scopus link needs a
                # subscription and lands a head on Scopus's front page without
                # one. Both are bibliographic, so neither is money.
                "doi": c.doi,
                "scopus_url": c.scopus_url,
                # Translated, never the raw status: "PAID" tells a head that a
                # colleague was paid, which is not their business.
                "progress": hod.progress_of(c.status),
            }
            for c in qs[offset : offset + limit]
        ],
    })


_HOD_EXPORT_HEADERS = [
    "Ticket", "Faculty", "Paper title", "Journal", "ISSN", "DOI",
    "Year of publication", "Quartile", "SNIP", "Indexed in",
    "Publication type", "Author position", "Total authors", "Progress",
]


@api.get("/hod/export", auth=session_auth)
def hod_export(
    request: HttpRequest,
    q: Optional[str] = None,
    year: Optional[int] = None,
    quartile: Optional[str] = None,
    person: Optional[str] = None,
    fmt: str = "xlsx",
):
    """The department's publications as a file, carrying no money column.

    Same filters as the screen: an export that ignores them and returns
    everything is how a wrong number reaches a review meeting.
    """
    user = _require_hod(request)
    qs = _hod_scope(user)
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(owner__name__icontains=term)
        )
    if year:
        qs = qs.filter(publication_year=year)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if person:
        qs = qs.filter(owner_id=person)
    qs = qs.order_by("owner__name", "-publication_year")[:5000]

    rows = [
        [
            c.ticket_number, c.owner.name, c.paper_title, c.journal_title,
            c.issn, c.doi, c.publication_year, c.quartile, c.snip,
            c.indexing_level, c.publication_type, c.author_position,
            c.total_authors, hod.progress_of(c.status),
        ]
        for c in qs
    ]
    stem = f"{hod.department_of(user).replace(' ', '-').lower()}-publications"

    AuditLog.objects.create(
        actor=user, action="HOD_EXPORT", entity="Department",
        entity_id=hod.department_of(user),
        detail_json=json.dumps({"rows": len(rows), "format": fmt}),
    )

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(_csv_row(_HOD_EXPORT_HEADERS))
        for row in rows:
            writer.writerow(_csv_row(row))
        res = HttpResponse(buf.getvalue(), content_type="text/csv")
        res["Content-Disposition"] = f'attachment; filename="{stem}.csv"'
        return res

    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Publications"
    ws.append(_HOD_EXPORT_HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(["" if v is None else v for v in _csv_row(row)])
    ws.freeze_panes = "A2"
    for column, width in zip(ws.columns, [14, 24, 60, 36, 14, 28, 10, 9, 8, 18, 18, 9, 9, 14]):
        ws.column_dimensions[column[0].column_letter].width = width
    out = io.BytesIO()
    wb.save(out)
    res = HttpResponse(
        out.getvalue(),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    res["Content-Disposition"] = f'attachment; filename="{stem}.xlsx"'
    return res


# ---------- data explorer ----------


def _may_browse_data(role: str) -> bool:
    """The admin and the principal. Finance reads money through its own
    screens, which are shaped for that job."""
    return role in rbac.ADMIN_ROLES or role == Role.PRINCIPAL


class CellEditIn(Schema):
    column: str
    value: Any = None
    reason: str


@api.get("/admin/data/tables", auth=session_auth)
def data_tables(request: HttpRequest):
    """Every table, what it holds, and how many rows are in it."""
    user = require_user(request)
    if not _may_browse_data(user.role):
        raise HttpError(403, "Forbidden")

    out = []
    for table in explorer.TABLES:
        model = explorer.model_for(table.model_name)
        out.append({
            "name": table.model_name,
            "label": table.label,
            "about": table.about,
            "group": table.group,
            "rows": model.objects.count(),
            "columns": len(explorer.column_meta(model, table)),
            "editable": bool(table.editable) and user.role == Role.SUPER_ADMIN,
        })
    return {
        "tables": out,
        "may_edit": user.role == Role.SUPER_ADMIN,
        # Said once, here, rather than left for somebody to discover by being
        # refused: reading is wide, writing is deliberately narrow.
        "note": (
            "Reading covers every table and every column that is not a secret. "
            "Editing is limited to reference data — the journal tables, the "
            "faculty master, budgets and journal standing — because everything "
            "the workflow owns moves through the screens that recalculate it "
            "and record who did it."
        ),
    }


def _explorer_queryset(table, model, request_params: dict):
    """Rows for one table, filtered and sorted as asked."""
    qs = model.objects.all()

    q = (request_params.get("q") or "").strip()
    if q:
        condition = Q()
        for column in explorer.searchable_columns(model):
            condition |= Q(**{f"{column}__icontains": q})
        qs = qs.filter(condition)

    # column:value pairs, one per filter, exact for anything but text.
    for raw in request_params.get("filters") or []:
        if ":" not in raw:
            continue
        column, value = raw.split(":", 1)
        column, value = column.strip(), value.strip()
        if not column or not any(
            f.name == column for f in model._meta.fields
        ) or column in explorer.NEVER_SHOW:
            raise HttpError(400, f"No column called {column!r} on this table")
        if value == "":
            qs = qs.filter(**{f"{column}__isnull": True})
        elif value.lower() in ("true", "false"):
            qs = qs.filter(**{column: value.lower() == "true"})
        else:
            try:
                qs = qs.filter(**{f"{column}__icontains": value})
            except Exception:
                qs = qs.filter(**{column: value})

    names = {f.name for f in model._meta.fields}

    def usable(candidate: str) -> bool:
        bare = candidate.lstrip("-")
        return bool(bare) and bare in names and bare not in explorer.NEVER_SHOW

    sort = (request_params.get("sort") or "").strip()
    # The requested sort, then the table's declared default, then the primary
    # key. The declared default is checked too: a registry naming a column the
    # model does not have took the whole screen down with a 500 the moment
    # somebody opened that table.
    for candidate in (sort, table.order, "-id"):
        if usable(candidate):
            return qs.order_by(candidate)
    return qs.order_by("pk")


@api.get("/admin/data/{table_name}", auth=session_auth)
def data_rows(
    request: HttpRequest,
    table_name: str,
    q: Optional[str] = None,
    filters: Optional[str] = None,
    sort: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """Rows, with the columns described alongside so the screen can render
    anything without knowing the schema in advance."""
    user = require_user(request)
    if not _may_browse_data(user.role):
        raise HttpError(403, "Forbidden")
    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    params = {
        "q": q,
        "sort": sort,
        "filters": [f for f in (filters or "").split("|") if f],
    }
    qs = _explorer_queryset(table, model, params)
    columns = explorer.column_meta(model, table)

    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    total = qs.count()

    related = [c["name"] for c in columns if c["type"] == "reference"]
    if related:
        qs = qs.select_related(*related)

    return {
        "table": {
            "name": table.model_name,
            "label": table.label,
            "about": table.about,
            "group": table.group,
        },
        "columns": columns,
        "highlight": list(table.highlight),
        "rows": [explorer.serialise(o, columns) for o in qs[offset : offset + limit]],
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": params["sort"] or table.order,
        "may_edit": (
            user.role == Role.SUPER_ADMIN and any(c["editable"] for c in columns)
        ),
    }


@api.get("/admin/data/{table_name}/export", auth=session_auth)
def data_export(
    request: HttpRequest,
    table_name: str,
    q: Optional[str] = None,
    filters: Optional[str] = None,
    sort: Optional[str] = None,
    fmt: str = "csv",
    limit: int = 50000,
):
    """The rows currently on screen, in whichever format the reader works in.

    The filter is applied, not ignored: an export that quietly returns the
    whole table when the screen showed forty rows is how a wrong number ends
    up in a report.
    """
    user = require_user(request)
    if not _may_browse_data(user.role):
        raise HttpError(403, "Forbidden")
    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    params = {
        "q": q,
        "sort": sort,
        "filters": [f for f in (filters or "").split("|") if f],
    }
    qs = _explorer_queryset(table, model, params)
    columns = explorer.column_meta(model, table)
    related = [c["name"] for c in columns if c["type"] == "reference"]
    if related:
        qs = qs.select_related(*related)
    rows = [explorer.serialise(o, columns) for o in qs[: max(1, min(int(limit), 50000))]]
    headers = [c["name"] for c in columns]
    stem = f"{table.model_name.lower()}-{timezone.now():%Y%m%d}"

    AuditLog.objects.create(
        actor=user, action="DATA_EXPORT", entity=table.model_name, entity_id=stem,
        detail_json=json.dumps({"format": fmt, "rows": len(rows), "filters": params}),
    )

    if fmt == "json":
        res = HttpResponse(
            json.dumps(rows, indent=2, default=str), content_type="application/json"
        )
        res["Content-Disposition"] = f'attachment; filename="{stem}.json"'
        return res

    if fmt == "xlsx":
        from openpyxl import Workbook
        from openpyxl.styles import Font

        wb = Workbook()
        ws = wb.active
        ws.title = table.label[:31]
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for row in rows:
            ws.append([
                # A leading "=" is read as a formula by Excel.
                f"'{row[h]}" if isinstance(row.get(h), str) and str(row[h]).startswith("=")
                else row.get(h)
                for h in headers
            ])
        ws.freeze_panes = "A2"
        for column in ws.columns:
            longest = max(
                (len(str(c.value)) for c in column[:200] if c.value is not None),
                default=10,
            )
            ws.column_dimensions[column[0].column_letter].width = min(
                60, max(10, longest + 2)
            )
        out = io.BytesIO()
        wb.save(out)
        res = HttpResponse(
            out.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        res["Content-Disposition"] = f'attachment; filename="{stem}.xlsx"'
        return res

    if fmt == "md":
        lines = ["| " + " | ".join(headers) + " |",
                 "| " + " | ".join("---" for _ in headers) + " |"]
        for row in rows:
            lines.append(
                "| " + " | ".join(
                    str(row.get(h, "")).replace("|", "\\|").replace("\n", " ")[:120]
                    for h in headers
                ) + " |"
            )
        res = HttpResponse("\n".join(lines), content_type="text/markdown; charset=utf-8")
        res["Content-Disposition"] = f'attachment; filename="{stem}.md"'
        return res

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_csv_row(headers))
    for row in rows:
        writer.writerow(_csv_row([row.get(h) for h in headers]))
    delimiter = "\t" if fmt == "tsv" else ","
    body = buf.getvalue()
    if fmt == "tsv":
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter="\t")
        writer.writerow(_csv_row(headers))
        for row in rows:
            writer.writerow(_csv_row([row.get(h) for h in headers]))
        body = buf.getvalue()
    res = HttpResponse(
        body, content_type="text/tab-separated-values" if fmt == "tsv" else "text/csv"
    )
    res["Content-Disposition"] = f'attachment; filename="{stem}.{"tsv" if fmt == "tsv" else "csv"}"'
    return res


@api.patch("/admin/data/{table_name}/{row_id}", auth=session_auth)
def data_edit_cell(
    request: HttpRequest, table_name: str, row_id: str, payload: CellEditIn
):
    """Correct one value in a reference table, with the reason recorded.

    One column at a time and a reason each time, on purpose. A grid that lets
    somebody change forty things and press save produces an audit entry nobody
    can reconstruct a decision from.
    """
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may correct data here")
    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    reason = (payload.reason or "").strip()
    if len(reason) < 5:
        raise HttpError(400, "Say why this is being changed")

    columns = {c["name"]: c for c in explorer.column_meta(model, table)}
    column = columns.get(payload.column)
    if column is None:
        raise HttpError(400, "No such column")
    if not column["editable"]:
        raise HttpError(
            400,
            f"{payload.column} is not editable here. Everything the workflow "
            "owns — status, the money columns, who approved what — moves "
            "through the screen that recalculates it and records who did it.",
        )

    instance = get_object_or_404(model, pk=row_id)
    before = getattr(instance, payload.column, None)
    value = payload.value
    if column["type"] == "number" and value not in (None, ""):
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise HttpError(400, f"{payload.column} takes a number")
    if column["type"] == "boolean":
        value = str(value).lower() in ("true", "1", "yes")
    if value == "":
        value = None

    setattr(instance, payload.column, value)
    instance.save(update_fields=[payload.column])

    AuditLog.objects.create(
        actor=user, action="DATA_EDIT", entity=table.model_name,
        entity_id=str(row_id),
        detail_json=json.dumps({
            "column": payload.column,
            "from": str(before) if before is not None else None,
            "to": str(value) if value is not None else None,
            "reason": reason,
        }),
    )
    return {"ok": True, "column": payload.column, "value": value, "was": str(before)}


# ---------- budget ----------


def financial_year_of(d: date) -> str:
    """India's financial year runs April to March, so "2026-27" starts in April 2026."""
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def _fy_bounds(fy: str) -> tuple[date, date]:
    start_year = int(fy.split("-")[0])
    return date(start_year, 4, 1), date(start_year + 1, 3, 31)


class BudgetIn(Schema):
    financial_year: str
    department: Optional[str] = None
    amount: float
    note: Optional[str] = None


def _budget_status(fy: str, user: User) -> dict[str, Any]:
    """Allocated, spent, committed and left -- for the college and each department.

    Committed is the part nobody was tracking: a ticket the principal has
    approved is money the college owes, even though finance has not moved it
    yet. Reporting only what has been paid understates the position by exactly
    the amount that is about to leave.
    """
    start, end = _fy_bounds(fy)
    scope = _claims_queryset(user)

    paid = scope.filter(
        status=ClaimStatus.PAID, payout_month__gte=start, payout_month__lte=end
    )
    # Committed has no payout month yet -- it is defined by where the ticket
    # sits, not by a date it has not reached.
    committed = scope.filter(
        status__in=(ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED)
    )

    def by_dept(qs) -> dict[str, float]:
        out: dict[str, float] = {}
        for row in qs.values("owner__department").annotate(s=Sum("remuneration")):
            out[(row["owner__department"] or "").strip()] = round(row["s"] or 0, 2)
        return out

    spent_by = by_dept(paid)
    committed_by = by_dept(committed)
    budgets = {
        (b.department or ""): b
        for b in Budget.objects.filter(financial_year=fy)
    }

    def slice_for(dept: str) -> dict[str, Any]:
        allocated = budgets[dept].amount if dept in budgets else None
        if dept == "":
            # The college row is every department added up, not the rows that
            # happen to carry no department. Reading it the other way showed a
            # college that had spent nothing while its departments had spent
            # everything.
            spent = round(sum(spent_by.values()), 2)
            commit = round(sum(committed_by.values()), 2)
        else:
            spent = spent_by.get(dept, 0.0)
            commit = committed_by.get(dept, 0.0)
        left = None if allocated is None else round(allocated - spent - commit, 2)
        return {
            "department": dept or None,
            "allocated": allocated,
            "spent": spent,
            "committed": commit,
            "remaining": left,
            # Of the allocation, how much is already gone or spoken for.
            "used_fraction": (
                None if not allocated else round((spent + commit) / allocated, 4)
            ),
            "budget_id": budgets[dept].id if dept in budgets else None,
            "note": budgets[dept].note if dept in budgets else None,
        }

    departments = sorted(
        {d for d in list(spent_by) + list(committed_by) + list(budgets) if d}
    )
    college = slice_for("")
    # A college-wide allocation is the ceiling; without one, the total of the
    # department rows is the only figure there is, and it is not a ceiling.
    if college["allocated"] is None:
        total_alloc = sum(
            b.amount for k, b in budgets.items() if k
        )
        if total_alloc:
            college["allocated"] = round(total_alloc, 2)
            college["remaining"] = round(
                total_alloc - college["spent"] - college["committed"], 2
            )
            college["used_fraction"] = round(
                (college["spent"] + college["committed"]) / total_alloc, 4
            )
            college["note"] = "Sum of the departmental allocations"

    return {
        "financial_year": fy,
        "starts": start.isoformat(),
        "ends": end.isoformat(),
        "college": college,
        "departments": [slice_for(d) for d in departments],
        "years_on_record": sorted(
            {b.financial_year for b in Budget.objects.all()}
            | {financial_year_of(date.today())},
            reverse=True,
        ),
    }


@api.get("/budgets", auth=session_auth)
def budget_status(request: HttpRequest, financial_year: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    fy = financial_year or financial_year_of(date.today())
    if not re.fullmatch(r"\d{4}-\d{2}", fy):
        raise HttpError(400, "Financial year must look like 2026-27")
    return _budget_status(fy, user)


@api.post("/budgets", auth=session_auth)
def set_budget(request: HttpRequest, payload: BudgetIn):
    """Allocations are set by whoever runs the scheme, and the change is logged."""
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES and user.role != Role.FINANCE:
        raise HttpError(403, "Forbidden")
    fy = (payload.financial_year or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}", fy):
        raise HttpError(400, "Financial year must look like 2026-27")
    if payload.amount < 0:
        raise HttpError(400, "An allocation cannot be negative")
    dept = (payload.department or "").strip() or None

    budget, created = Budget.objects.update_or_create(
        financial_year=fy,
        department=dept,
        defaults={
            "amount": payload.amount,
            "note": (payload.note or "").strip() or None,
            "created_by": user,
        },
    )
    AuditLog.objects.create(
        actor=user,
        action="BUDGET_SET",
        entity="Budget",
        entity_id=budget.id,
        detail_json=json.dumps({
            "financial_year": fy, "department": dept,
            "amount": payload.amount, "created": created,
        }),
    )
    return {"ok": True, "id": budget.id, "created": created}


@api.delete("/budgets/{budget_id}", auth=session_auth)
def delete_budget(request: HttpRequest, budget_id: str):
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES and user.role != Role.FINANCE:
        raise HttpError(403, "Forbidden")
    budget = get_object_or_404(Budget, pk=budget_id)
    AuditLog.objects.create(
        actor=user, action="BUDGET_DELETE", entity="Budget", entity_id=budget.id,
        detail_json=json.dumps({
            "financial_year": budget.financial_year,
            "department": budget.department, "amount": budget.amount,
        }),
    )
    budget.delete()
    return {"ok": True}


# ---------- duplicate findings ----------


class FindingReviewIn(Schema):
    status: str
    note: Optional[str] = None
    recovered_amount: Optional[float] = None


@api.get("/admin/duplicate-findings", auth=session_auth)
def list_duplicate_findings(
    request: HttpRequest,
    kind: str = "SAME_PERSON",
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """What the sweep over paid history found, largest sum at issue first."""
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    qs = DuplicateFinding.objects.select_related("reviewed_by")
    if kind:
        qs = qs.filter(kind=kind)
    if status:
        qs = qs.filter(status=status)

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()

    everything = DuplicateFinding.objects.filter(kind=kind or "SAME_PERSON")
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [
            {
                "id": f.id,
                "kind": f.kind,
                "status": f.status,
                "matched_on": f.matched_on,
                "paper_title": f.paper_title,
                "faculty_name": f.faculty_name,
                "payment_count": f.payment_count,
                "total_amount": f.total_amount,
                "extra_amount": f.extra_amount,
                "rows": json.loads(f.rows_json or "[]"),
                "note": f.note,
                "recovered_amount": f.recovered_amount,
                "reviewed_by_name": f.reviewed_by.name if f.reviewed_by_id else None,
                "reviewed_at": f.reviewed_at.isoformat() if f.reviewed_at else None,
            }
            for f in qs[offset : offset + limit]
        ],
        "summary": {
            "open": everything.filter(status=DuplicateFinding.Status.OPEN).count(),
            "confirmed": everything.filter(status=DuplicateFinding.Status.CONFIRMED).count(),
            "dismissed": everything.filter(status=DuplicateFinding.Status.DISMISSED).count(),
            "recovered": everything.filter(status=DuplicateFinding.Status.RECOVERED).count(),
            "at_issue": round(
                everything.filter(
                    status__in=(
                        DuplicateFinding.Status.OPEN,
                        DuplicateFinding.Status.CONFIRMED,
                    )
                ).aggregate(s=Sum("extra_amount"))["s"]
                or 0,
                2,
            ),
            "recovered_amount": round(
                everything.aggregate(s=Sum("recovered_amount"))["s"] or 0, 2
            ),
        },
    }


@api.post("/admin/duplicate-findings/{finding_id}", auth=session_auth)
def review_duplicate_finding(request: HttpRequest, finding_id: str, payload: FindingReviewIn):
    """Record what a person decided about one finding.

    A note is required to dismiss: "not a duplicate" with no reason is not a
    review, and the next sweep would raise it again with nothing to go on.
    """
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES and user.role != Role.FINANCE:
        raise HttpError(403, "Forbidden")
    valid = {s.value for s in DuplicateFinding.Status}
    if payload.status not in valid:
        raise HttpError(400, f"Status must be one of {sorted(valid)}")
    note = (payload.note or "").strip()
    if payload.status == DuplicateFinding.Status.DISMISSED and len(note) < 5:
        raise HttpError(400, "Say why this is not a duplicate")

    finding = get_object_or_404(DuplicateFinding, pk=finding_id)
    finding.status = payload.status
    finding.note = note or finding.note
    finding.reviewed_by = user
    finding.reviewed_at = timezone.now()
    if payload.recovered_amount is not None:
        finding.recovered_amount = payload.recovered_amount
    finding.save()

    AuditLog.objects.create(
        actor=user, action="DUPLICATE_REVIEW", entity="DuplicateFinding",
        entity_id=finding.id,
        detail_json=json.dumps({
            "status": payload.status,
            "extra_amount": finding.extra_amount,
            "recovered_amount": finding.recovered_amount,
        }),
    )
    return {"ok": True, "status": finding.status}


# ---------- super-admin powers ----------


class ClaimEditIn(Schema):
    fields: dict[str, Any]
    reason: str


@api.post("/admin/claims/{claim_id}/edit", auth=session_auth)
def admin_edit_claim(request: HttpRequest, claim_id: str, payload: ClaimEditIn):
    """Edit any field on any claim, with a reason, recorded before and after.

    This exists because imported data is wrong in ways the normal screens cannot
    reach. It is deliberately not a quiet update: the reason is required, the
    before/after of every changed field goes to the audit log, and changing a
    settled amount also writes the balancing ledger row, so the claim and the
    ledger cannot drift apart -- which is the drift that made the reported
    totals wrong in the first place.
    """
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may edit a claim directly")
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Give a reason (at least 10 characters) — it is kept with the change")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        editable = {f.name for f in Claim._meta.get_fields() if hasattr(f, "attname")}
        editable -= {"id", "owner", "created_at", "updated_at"}

        before, after = {}, {}
        for key, value in (payload.fields or {}).items():
            if key not in editable:
                raise HttpError(400, f"{key} is not a field on a claim")
            old = getattr(claim, key, None)
            if old == value:
                continue
            before[key], after[key] = old, value
            setattr(claim, key, value)

        if not after:
            return {"ok": True, "changed": {}, "note": "nothing differed"}

        money_changed = "remuneration" in after and claim.status == ClaimStatus.PAID
        claim.save()

        if money_changed:
            # The ledger is append-only, so the correction is a new row rather
            # than an edit: the history keeps what was paid and what it became.
            paid_so_far = (
                claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
            )
            delta = (claim.remuneration or 0) - paid_so_far
            if abs(delta) > 0.01:
                PaidLedger.objects.create(
                    claim=claim,
                    payout_month=claim.payout_month or timezone.now().date().replace(day=1),
                    department=claim.owner.department,
                    faculty_name=claim.owner.name,
                    staff_id=claim.staff_id,
                    biometric_id=claim.biometric_id,
                    paper_title=claim.paper_title,
                    journal_title=claim.journal_title,
                    amount=delta,
                    voucher_number=f"{claim.voucher_number or claim.ticket_number}-ADJ",
                )

        ClaimAction.objects.create(
            claim=claim, actor=actor, action="ADMIN_EDIT", note=reason[:500]
        )
        AuditLog.objects.create(
            actor=actor,
            action="CLAIM_ADMIN_EDIT",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps(
                {
                    "reason": reason,
                    "before": {k: str(v) for k, v in before.items()},
                    "after": {k: str(v) for k, v in after.items()},
                    "ledger_adjusted": money_changed,
                }
            )[:20000],
        )
    return {"ok": True, "changed": {k: str(v) for k, v in after.items()},
            "ledger_adjusted": money_changed}


class ReassignIn(Schema):
    owner_email: str
    reason: str


@api.post("/admin/claims/{claim_id}/reassign", auth=session_auth)
def admin_reassign_claim(request: HttpRequest, claim_id: str, payload: ReassignIn):
    """Move a claim to the faculty member it actually belongs to.

    The import attributes by staff id, biometric id, then name; where all three
    miss, the payment lands on a holding record for someone who has left. This
    is how it gets put right.
    """
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may reassign a claim")
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Give a reason (at least 10 characters)")

    new_owner = User.objects.filter(email__iexact=payload.owner_email.strip()).first()
    if not new_owner:
        raise HttpError(404, "No account with that email")
    if new_owner.role != Role.FACULTY:
        raise HttpError(400, "Claims belong to faculty accounts")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        previous = claim.owner
        if previous.id == new_owner.id:
            return {"ok": True, "note": "already owned by that account"}
        claim.owner = new_owner
        # The identity columns travel with the claim, or the ledger would keep
        # paying the person it was moved away from.
        claim.staff_id = new_owner.staff_id or claim.staff_id
        claim.biometric_id = new_owner.biometric_id or claim.biometric_id
        claim.save()
        claim.ledger_rows.update(
            faculty_name=new_owner.name,
            staff_id=new_owner.staff_id,
            biometric_id=new_owner.biometric_id,
            department=new_owner.department,
        )
        ClaimAction.objects.create(
            claim=claim, actor=actor, action="REASSIGN",
            note=f"{previous.email} → {new_owner.email}: {reason}"[:500],
        )
        AuditLog.objects.create(
            actor=actor, action="CLAIM_REASSIGN", entity="Claim", entity_id=claim.id,
            detail_json=json.dumps({
                "from": previous.email, "to": new_owner.email, "reason": reason,
            }),
        )
    return {"ok": True, "owner": _user_dict(new_owner)}


@api.post("/admin/impersonate/{user_id}", auth=session_auth)
def admin_impersonate(request: HttpRequest, user_id: str):
    """View the app as another user. Read-only, and recorded.

    Every write is refused for the duration (see require_user), so this answers
    "what does this person actually see?" without being a way to act as them.
    """
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may view as another user")
    if request.session.get(IMPERSONATOR_KEY):
        raise HttpError(400, "Already viewing as somebody else — stop first")

    target = get_object_or_404(User, pk=user_id)
    if target.id == actor.id:
        raise HttpError(400, "That is already you")
    if target.role == Role.SUPER_ADMIN:
        raise HttpError(403, "Cannot view as another super admin")

    AuditLog.objects.create(
        actor=actor, action="IMPERSONATE_START", entity="User", entity_id=target.id,
        detail_json=json.dumps({"target": target.email}),
    )
    real_id = actor.id
    login(request, target, backend="django.contrib.auth.backends.ModelBackend")
    request.session[IMPERSONATOR_KEY] = real_id
    return {"ok": True, "viewing_as": _user_dict(target), "read_only": True}


# Not /admin/impersonate/stop: that is swallowed by the {user_id} route
# registered above it, which answers "Only a super admin may view as another
# user" for a user called "stop".
@api.post("/admin/stop-impersonating", auth=session_auth)
def admin_stop_impersonating(request: HttpRequest):
    real = impersonator_of(request)
    if not real:
        raise HttpError(400, "Not viewing as anybody")
    viewed = request.user
    AuditLog.objects.create(
        actor=real, action="IMPERSONATE_STOP", entity="User", entity_id=viewed.id,
        detail_json=json.dumps({"target": getattr(viewed, "email", "")}),
    )
    del request.session[IMPERSONATOR_KEY]
    login(request, real, backend="django.contrib.auth.backends.ModelBackend")
    return {"ok": True, "user": _user_dict(real)}


# ---------- operations: what is wrong right now ----------


def _fault(key, title, detail, count, *, severity="warning", to=None, sample=None):
    return {
        "key": key,
        "title": title,
        "detail": detail,
        "count": count,
        "severity": severity,
        "to": to,
        "sample": sample or [],
    }


@api.get("/admin/faults", auth=session_auth)
def admin_faults(request: HttpRequest):
    """Every fault worth an admin's attention, counted and sampled.

    Each of these was found by hand at some point, in a query nobody was going
    to run twice. Four groups, because they need four different responses: data
    that blocks a person, work that has stalled, verification that could not
    confirm, and money that does not add up.
    """
    user = require_user(request)
    # Read-only, and the principal oversees the scheme: they can already read
    # the audit log, the payable queue and every record, so hiding stalled
    # work from them was an inconsistency rather than a boundary.
    if not (rbac.can_manage_users(user.role) or user.role == Role.PRINCIPAL):
        raise HttpError(403, "Forbidden")

    now = timezone.now()
    claims = Claim.objects.all()
    groups: list[dict[str, Any]] = []

    def names(qs, field="email", n=4):
        return list(qs.values_list(field, flat=True)[:n])

    def tickets(qs, n=4):
        return [t or "(draft)" for t in qs.values_list("ticket_number", flat=True)[:n]]

    # ---- data gaps that stop somebody working ----
    faculty = User.objects.filter(role=Role.FACULTY, active=True)
    no_scopus = faculty.filter(Q(scopus_author_id__isnull=True) | Q(scopus_author_id=""))
    no_bio = faculty.filter(Q(biometric_id__isnull=True) | Q(biometric_id=""))
    no_dept = faculty.filter(Q(department__isnull=True) | Q(department=""))
    former = User.objects.filter(role=Role.FACULTY, email__endswith="@saveetha.invalid")
    groups.append({
        "key": "data",
        "title": "Data gaps",
        "blurb": "Missing details that stop a person filing or being paid",
        "faults": [
            _fault("no_scopus", "No Scopus author ID",
                   "Their profile link cannot be derived, so the claim form cannot pre-fill it.",
                   no_scopus.count(), to="/admin/users", sample=names(no_scopus)),
            _fault("no_biometric", "No biometric ID",
                   "Decides which account is paid. A claim cannot be submitted without it.",
                   no_bio.count(), severity="critical", to="/admin/users", sample=names(no_bio)),
            _fault("no_department", "No department",
                   "Routes the approval and every departmental figure.",
                   no_dept.count(), to="/admin/users", sample=names(no_dept)),
            _fault("former_staff", "Payments held by former staff",
                   "Imported rows whose faculty is not on the current roster. Reassign to the right person.",
                   former.count(), severity="info", to="/admin/users",
                   sample=names(former, "name")),
        ],
    })

    # ---- work that has stopped moving ----
    stale_days = 14
    stale_cut = now - timedelta(days=stale_days)
    stale_submitted = claims.filter(status=ClaimStatus.SUBMITTED, updated_at__lt=stale_cut)
    stale_cleared = claims.filter(status=ClaimStatus.CLEARED, updated_at__lt=stale_cut)
    legacy = claims.filter(status__in=[
        ClaimStatus.HOD_APPROVED, ClaimStatus.PRINCIPAL_APPROVED,
        ClaimStatus.RESEARCH_APPROVED, ClaimStatus.FINANCE_APPROVED,
    ])
    old_drafts = claims.filter(status=ClaimStatus.DRAFT, updated_at__lt=now - timedelta(days=30))
    groups.append({
        "key": "stuck",
        "title": "Stuck work",
        "blurb": "Claims that have stopped moving",
        "faults": [
            _fault("stale_submitted", f"Waiting to clear over {stale_days} days",
                   "Submitted and untouched since. The claimant is waiting.",
                   stale_submitted.count(), severity="critical",
                   to="/admin/clearing", sample=tickets(stale_submitted)),
            _fault("stale_cleared", f"Waiting to pay over {stale_days} days",
                   "Cleared but not paid. The money is approved and sitting.",
                   stale_cleared.count(), severity="critical",
                   to="/finance", sample=tickets(stale_cleared)),
            _fault("legacy_status", "Stranded on a retired status",
                   "Imported at a stage the current workflow has no button for. A super admin can override the status.",
                   legacy.count(), to="/admin/clearing", sample=tickets(legacy)),
            _fault("old_drafts", "Drafts abandoned over 30 days",
                   "Started and never submitted.",
                   old_drafts.count(), severity="info", sample=tickets(old_drafts)),
        ],
    })

    # ---- verification that could not confirm ----
    unverified = claims.filter(verification_ok=False).exclude(status=ClaimStatus.PAID)
    no_quartile = claims.filter(
        Q(quartile__isnull=True) | Q(quartile="")
    ).filter(status__in=[ClaimStatus.SUBMITTED, ClaimStatus.CLEARED])
    no_snip = claims.filter(snip__isnull=True).filter(
        status__in=[ClaimStatus.SUBMITTED, ClaimStatus.CLEARED]
    )
    dup_override = claims.filter(override_duplicate=True)
    groups.append({
        "key": "verification",
        "title": "Verification",
        "blurb": "What the indexes could not confirm",
        "faults": [
            _fault("unverified", "Verification did not pass",
                   "Sent forward with issues outstanding.",
                   unverified.count(), to="/admin/clearing", sample=tickets(unverified)),
            _fault("no_quartile", "In review with no quartile",
                   # Rupees are written the same way everywhere else in the app.
                   "The quartile is worth up to ₹50,000 of the payout and has to be "
                   "set before clearing.",
                   no_quartile.count(), severity="critical",
                   to="/admin/clearing", sample=tickets(no_quartile)),
            _fault("no_snip", "In review with no SNIP",
                   "Without a verified SNIP the claim prices at the fixed category rate.",
                   no_snip.count(), to="/admin/clearing", sample=tickets(no_snip)),
            _fault("duplicate_override", "Duplicate warning overridden",
                   "Paid or cleared despite matching an earlier payment.",
                   dup_override.count(), severity="critical", sample=tickets(dup_override)),
        ],
    })

    # ---- money that does not add up ----
    paid = claims.filter(status=ClaimStatus.PAID)
    paid_zero = paid.filter(Q(remuneration__isnull=True) | Q(remuneration=0))
    self_cleared = paid.filter(cleared_by__isnull=False, cleared_by=F("owner"))
    no_ledger = paid.filter(ledger_rows__isnull=True)
    voided = claims.filter(ledger_rows__amount__lt=0).distinct()
    groups.append({
        "key": "money",
        "title": "Money",
        "blurb": "Payments that do not reconcile",
        "faults": [
            _fault("paid_zero", "Paid, but for nothing",
                   "Marked paid with no amount. Either the figure was lost or it should not have been paid.",
                   paid_zero.count(), sample=tickets(paid_zero)),
            _fault("self_cleared", "Cleared by the claimant",
                   "The person who approved it is the person being paid.",
                   self_cleared.count(), severity="critical", sample=tickets(self_cleared)),
            _fault("no_ledger", "Paid with no ledger row",
                   "The claim says paid but nothing was written to the ledger.",
                   no_ledger.count(), severity="critical", sample=tickets(no_ledger)),
            _fault("voided", "Payments voided",
                   "A reversing row was written. Expected after a correction; unexpected otherwise.",
                   voided.count(), severity="info", sample=tickets(voided)),
        ],
    })

    total = sum(f["count"] for g in groups for f in g["faults"])
    urgent = sum(
        f["count"] for g in groups for f in g["faults"] if f["severity"] == "critical"
    )
    return {"groups": groups, "total": total, "urgent": urgent, "checked_at": now.isoformat()}


# ---------- admin ----------


@api.get("/admin/users", auth=session_auth)
def admin_users(
    request: HttpRequest,
    q: Optional[str] = None,
    role: Optional[str] = None,
    active: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """The staff directory, searched and paged server-side.

    It used to return every account as one array — the college has hundreds of
    faculty, so the screen loaded them all and filtered in the browser.
    """
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    qs = User.objects.all()
    if q:
        qs = qs.filter(
            Q(email__icontains=q)
            | Q(name__icontains=q)
            | Q(staff_id__icontains=q)
            | Q(employee_id__icontains=q)
            | Q(department__icontains=q)
        )
    if role:
        qs = qs.filter(role=role)
    if active in ("true", "false"):
        qs = qs.filter(active=(active == "true"))
    # Staff accounts first, then faculty alphabetically: the people an admin
    # opens this screen to find are never the 400 imported faculty.
    qs = qs.annotate(
        is_faculty=Case(
            When(role=Role.FACULTY, then=Value(1)), default=Value(0),
            output_field=IntegerField(),
        )
    ).order_by("is_faculty", "email")
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [_user_dict(u) for u in qs[offset : offset + limit]],
    }


@api.get("/admin/users/{user_id}", auth=session_auth)
def admin_user_detail(request: HttpRequest, user_id: str):
    """One account, with what it has actually done — an admin fixing a record
    needs to know whether it has claims and payments behind it."""
    actor = require_user(request)
    if not rbac.can_manage_users(actor.role):
        raise HttpError(403, "Forbidden")
    u = get_object_or_404(User, pk=user_id)
    claims = Claim.objects.filter(owner=u)
    paid = claims.filter(status=ClaimStatus.PAID)
    row = _user_dict(u)
    row["stats"] = {
        "claims": claims.count(),
        "paid_claims": paid.count(),
        "paid_amount": paid.aggregate(s=Sum("remuneration"))["s"] or 0,
        "drafts": claims.filter(status=ClaimStatus.DRAFT).count(),
        "in_review": claims.filter(status=ClaimStatus.SUBMITTED).count(),
        "last_claim_at": (
            claims.order_by("-updated_at").values_list("updated_at", flat=True).first()
        ),
    }
    if row["stats"]["last_claim_at"]:
        row["stats"]["last_claim_at"] = row["stats"]["last_claim_at"].isoformat()
    return row


#: Roles an account may be given. Every one of these carries capabilities;
#: HOD is deliberately absent, being retired and able to do nothing, and an
#: account holding one keeps it until somebody deliberately moves them.
ASSIGNABLE_ROLES = (
    Role.FACULTY,
    Role.HOD,
    Role.PRINCIPAL,
    Role.RESEARCH_CELL,
    Role.FINANCE,
    Role.SUPER_ADMIN,
)


def _check_assignable_role(role: str | None) -> None:
    """Refuse a role nothing recognises, rather than writing it.

    An account whose role is not a real one fails every `can_…` check while
    reading normally in the user list, so the person is locked out of
    everything with nothing on screen to explain it.
    """
    if role is None:
        return
    if role not in ASSIGNABLE_ROLES:
        known = ", ".join(ASSIGNABLE_ROLES)
        raise HttpError(400, f"Role must be one of: {known}.")


@api.post("/admin/users", auth=session_auth)
def admin_create_user(request: HttpRequest, payload: UserCreateIn):
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    _check_assignable_role(payload.role)

    email = payload.email.strip().lower()
    if not email:
        raise HttpError(400, "An email address is required")
    # Without this the database raises, the request answers 500, and the
    # screen shows a stack trace instead of the one fact that matters: the
    # address is already somebody's.
    taken = User.objects.filter(email__iexact=email).first()
    if taken:
        raise HttpError(
            400,
            f"{email} already belongs to {taken.name or 'an existing account'}"
            f" ({taken.get_role_display() if hasattr(taken, 'get_role_display') else taken.role})."
            " Use a different address, or change that account's role instead.",
        )

    u = User.objects.create_user(
        email=email,
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
    if "role" in data:
        _check_assignable_role(data["role"])
    # Identity is super-admin only, here as much as on the profile page.
    # Closing the self-edit route while leaving this one open would just move
    # the same mistake one desk over: the research cell processes the claims
    # these fields decide the outcome of, so it cannot also set them.
    if actor.role != Role.SUPER_ADMIN:
        blocked = sorted(set(data) & IDENTITY_FIELDS)
        if blocked:
            raise HttpError(
                403,
                "Only a super admin can change "
                + ", ".join(CORRECTABLE[f].lower() for f in blocked)
                + ". You can still set the role, the department and whether the "
                "account is active.",
            )
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
            # The policy's QFA table says Q4 is 7,000; this fallback said 5,000
            # and is what prices every claim when no policy row is active.
            "qf_q4": 7000,
            "qf_no_snip": 0,
            "qf_snip_only": 0,
            "qf_others": 0,
            "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS),
            "publication_type_multipliers_json": json.dumps(DEFAULT_PUB_TYPE_MULTIPLIERS),
            "student_remuneration_zero": True,
            "qf_only_for_no_snip": True,
            "high_value_threshold": 0,
            "fixed_journal_no_snip": 5000,
            "fixed_other_no_snip": 4000,
            "fixed_web_of_science": 5000,
            "max_authors": MAX_ELIGIBLE_AUTHORS,
            "min_sec_references": MIN_SEC_REFERENCES,
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
        "owner", "cleared_by", "second_approved_by", "principal_approved_by", "override_by"
    ).prefetch_related("attachments")
    if status == "PAID":
        qs = qs.filter(status=ClaimStatus.PAID)
        default_order = "-paid_at"
    elif status in ("CLEARED", "PRINCIPAL_APPROVED", "FINANCE_APPROVED"):
        # The payable queue: approved by the principal on this system. A merely
        # cleared ticket is not in it, because finance cannot pay one -- and a
        # queue full of rows whose pay button always refuses is worse than an
        # empty queue, since it reads as work.
        #
        # Legacy import rows keep their own home in the faults screen, where a
        # super admin unsticks them; they are deliberately not shown here as
        # though they were ready to pay.
        qs = qs.filter(
            status=ClaimStatus.PRINCIPAL_APPROVED, principal_approved_at__isnull=False
        )
        default_order = "-principal_approved_at"
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
