from __future__ import annotations

import csv
import io
import json
from dataclasses import replace
import logging
import os
import re
import time
import uuid as uuid_lib
from datetime import date, timedelta, datetime
from pathlib import Path
from typing import Any, Optional

from django.conf import settings
from django.contrib.auth import authenticate, login, logout, update_session_auth_hash
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import IntegrityError, models, transaction
from django.db.models import Max, Case, Count, F, IntegerField, Min, Q, Sum, Value, When
from django.http import HttpRequest, HttpResponse, StreamingHttpResponse
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
    ProfileChangeRequest,
    CalendarEvent,
    DepartmentTarget,
    Mention,
    Post,
    ResearchInterest,
    Team,
    TeamMember,
    Thread,
    ThreadParticipant,
    ThreadSubscription,
    PaidLedger,
    PriorImport,
    PriorPayment,
    Role,
    ScimagoJournal,
    SnipSource,
    User,
)
from core.services import ai, discover as discover_service, research_search, trends
from core.services import rbac
from core.services import thread_agent
from core import discussions
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


def _notify_director(claim: Claim, title: str, body: str) -> None:
    """Everyone who can authorise: the Director, and a super admin standing in."""
    for u in User.objects.filter(role__in=(Role.DIRECTOR, Role.SUPER_ADMIN), active=True):
        Notification.objects.create(
            user=u,
            title=title,
            body=body,
            href=f"/authorisations?claim={claim.id}",
            claim_id=claim.id,
        )


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
    #: The team code on a student-project claim. Codes, not ids: the code is
    #: what is printed on the project sheet the claimant is reading from, and
    #: an id is a thing they would have to go and look up.
    team_code: Optional[str] = None
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
    # "payout_month" is deliberately absent. It decides which month's ledger
    # and which financial year's budget a payment lands in, and a claimant who
    # set it to 2019-04 produced a real payment that the current year's budget
    # report could not see and the monthly run never listed. The office sets it
    # when the payment is prepared.
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

    # The team, on the claims that have one. Note this deliberately does not
    # touch `is_student_publication`: that flag makes the engine return zero,
    # and a student-project conference paper is *paid* -- it prices as
    # Category III like any other conference proceeding. Wiring the two
    # together on the strength of both having "student" in the name would pay
    # every one of these nothing.
    if "team_code" in data:
        code = (payload.team_code or "").strip()
        if not code:
            claim.team = None
        else:
            team = Team.objects.filter(code__iexact=code).first()
            if team is None:
                raise HttpError(
                    404,
                    f"No team with the code {code!r}. Create the team first, "
                    "with the students on it.",
                )
            claim.team = team
    # A claim that stops being a student project stops carrying a team, for
    # the same reason `is_student_publication` has to flip back: a stale one
    # would show a roster of students on a paper that is no longer theirs.
    if claim.claim_reason != ClaimReason.STUDENT_PROJECT:
        claim.team = None
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
    #: Optional. Left out, the account is created with no usable password and
    #: has to be given one before it can be signed into with a password at
    #: all -- which is the sane default for creating somebody else's account:
    #: a password chosen for you and typed into a form has been seen by the
    #: person who typed it, and is usually still in their sent items.
    #:
    #: The account is not stranded by this. Whoever created it sets one with
    #: "Set a password" and hands it over, or the person signs in with the
    #: Google account the college gave them, which never consults this field.
    password: Optional[str] = None
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
    #: Whether this post is expected to produce research, and how much before
    #: any incentive is due. Absent from this schema until now, which made the
    #: whole quota rule unreachable: it was implemented, tested, and settable
    #: only from a Django shell.
    faculty_type: Optional[str] = None
    research_quota: Optional[int] = None
    research_quota_note: Optional[str] = None


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
        "faculty_type": u.faculty_type,
        "research_quota": u.research_quota,
        "research_quota_note": u.research_quota_note,
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


def _quartile_year_note(c: Claim) -> str | None:
    """Say when the quartile being paid on is not the paper's own year's.

    `lookup_scimago` falls back to the newest table it holds when the paper's
    year is missing from the dump, and records which year that was in
    `scimago_dataset_year`. The number was serialised, but nothing anywhere
    said it was a fallback: a 2019 paper priced off the 2025 ranking read
    exactly like a 2019 one, and the quartile is a term in the amount. The
    dumps only reach back to 2024, so this is most older papers, not an edge.
    """
    if c.quartile_source != "SCIMAGO" or not c.quartile:
        return None
    used, published = c.scimago_dataset_year, c.publication_year
    if not used or not published or used == published:
        return None
    direction = "later" if used > published else "earlier"
    return (
        f"Quartile {c.quartile} is the journal's {used} ranking, not its "
        f"{published} one — Scimago holds no {published} table for this "
        f"journal, so a {direction} year was used. The quartile is a term in "
        "the amount."
    )


def _snip_year_note(c: Claim) -> str | None:
    """Say when the SNIP being paid on is not matched to the paper's year.

    `lookup_snip_dump` takes no year at all: it returns whichever row carries
    the ISSN. So unlike the quartile there is nothing recorded to compare —
    `snip_year` stays empty — and the honest thing to say is that the figure
    is unyeared rather than to guess which year it came from. Recording the
    matched row's year belongs in `lookup_snip_dump` itself.
    """
    if c.snip is None or c.snip_source != "SNIP_DUMP" or c.snip_year is not None:
        return None
    published = f" (published {c.publication_year})" if c.publication_year else ""
    return (
        f"SNIP {c.snip:g} was read off the SNIP dataset, which holds one "
        f"figure per journal and is not matched to the year of publication"
        f"{published}. SNIP is a term in the amount."
    )


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
        # Who else is on it. A student-project claim is the work of a team, and
        # a ticket that names only the person who filed it hides the students
        # the incentive is partly for.
        "team": (
            {
                "code": c.team.code,
                "title": c.team.title,
                "department": c.team.department,
                "academic_year": c.team.academic_year,
                # The account it would be paid against, and the name off the
                # roster. Both, because the roster carries mentors this system
                # has no account for.
                "mentor_name": (
                    c.team.mentor.name if c.team.mentor_id else c.team.mentor_name
                ),
                "members": [
                    {
                        "name": m.name,
                        "register_number": m.register_number,
                        "programme": m.programme,
                        "year_of_study": m.year_of_study,
                        "mentor_name": m.mentor_name,
                    }
                    for m in c.team.members.all()
                ],
            }
            if c.team_id
            else None
        ),
        "attachments": [
            {
                "id": a.id,
                "kind": a.kind,
                "url": a.url,
                "filename": a.filename,
                "size_bytes": a.size_bytes,
                "ref_number": a.ref_number,
                "ref_title": a.ref_title,
                # Sent back so a reopened draft can return it.
                #
                # `_persist_attachments` deletes the set and rebuilds it from
                # whatever the payload holds, so a field this serialiser omits
                # is a field the next save erases. This one is the file's own
                # fingerprint, and losing it blinds the duplicate check on
                # /claims/upload for that claim permanently -- the same PDF
                # could then be attached to a second ticket with nothing to
                # notice. It has been silently wiped on every edit until now.
                "content_hash": a.content_hash,
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
        # The year was already here as a bare number. These two say what it
        # means -- that a figure the money is worked out from came from a
        # year other than the paper's -- so an approver and the claimant
        # read a sentence instead of being left to compare two integers.
        "quartile_year_note": _quartile_year_note(c),
        "snip_year_note": _snip_year_note(c),
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
        "director_approved_by_name": (
            c.director_approved_by.name if c.director_approved_by_id else None
        ),
        "director_approved_at": (
            c.director_approved_at.isoformat() if c.director_approved_at else None
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


def _client_ip(request: HttpRequest) -> str:
    """The address a proxy vouched for, not the one the client claimed.

    X-Forwarded-For is a list the client writes the first entry of and each
    proxy appends to, so the leftmost value is attacker-controlled. Taking it
    meant a fresh header per request produced a fresh lockout bucket every
    time, and the ten-attempt limit never fired -- unlimited password guessing
    against 508 accounts, several of which can move money.

    The rightmost entry is the one our own proxy wrote, so it is the last one
    nobody downstream could forge.
    """
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.META.get("REMOTE_ADDR", "")


def _login_throttle_key(request: HttpRequest, email: str) -> str:
    # The email is in the key as well as the address, so a rotating proxy pool
    # still cannot get more than the allowance for the account it is guessing.
    return f"login-fail:{_login_unlock_epoch(email)}:{email}:{_client_ip(request)}"


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


class GoogleSignInIn(Schema):
    #: The ID token the browser got from Google Identity Services.
    credential: str


@api.get("/auth/google/config", auth=None)
def google_config(request: HttpRequest):
    """What the sign-in page needs to draw the Google button, or why it cannot.

    Answered rather than left to fail: with no client id configured the button
    would render, be pressed, and do nothing, which reads as the account being
    broken. The page asks first and shows the password form alone instead.
    """
    client_id = (getattr(settings, "GOOGLE_OAUTH_CLIENT_ID", "") or "").strip()
    return {
        "enabled": bool(client_id),
        "client_id": client_id or None,
        "hosted_domain": (getattr(settings, "GOOGLE_HOSTED_DOMAIN", "") or "").strip() or None,
    }


@api.post("/auth/google", auth=None)
def auth_google(request: HttpRequest, payload: GoogleSignInIn):
    """Sign in with a Google ID token, into an account that already exists.

    Verified server-side against Google's public keys, with our own client id
    as the audience. The token the browser hands over is the only thing that
    crosses, and a token minted for somebody else's application will not
    verify against ours -- which is the whole reason this is not "trust the
    email the client sent us".

    **No account is ever created here.** An address Google recognises and this
    college does not is refused. Accounts carry staff ids, biometric ids and a
    Scopus link; they decide who gets paid, and letting anybody with a Google
    account mint one would put a payable identity behind a free signup form.
    """
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token as google_id_token

    client_id = (getattr(settings, "GOOGLE_OAUTH_CLIENT_ID", "") or "").strip()
    if not client_id:
        raise HttpError(503, "Google sign-in is not configured on this server.")

    try:
        claims = google_id_token.verify_oauth2_token(
            payload.credential, google_requests.Request(), client_id
        )
    except Exception:
        # Deliberately not echoed back. The reasons a token fails to verify
        # (expired, wrong audience, bad signature) are useful to an attacker
        # and useless to the person in front of the screen.
        logger.warning("google_signin_rejected")
        raise HttpError(401, "That Google sign-in could not be verified. Try again.")

    if not claims.get("email_verified"):
        raise HttpError(403, "That Google account has no verified email address.")

    hosted = (getattr(settings, "GOOGLE_HOSTED_DOMAIN", "") or "").strip()
    if hosted and (claims.get("hd") or "").lower() != hosted.lower():
        raise HttpError(403, f"Sign in with your {hosted} account.")

    email = (claims.get("email") or "").strip().lower()
    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        raise HttpError(
            403,
            f"There is no account here for {email}. Ask the research cell to "
            "create one — signing in with Google does not make one.",
        )
    if not user.active:
        raise HttpError(403, "That account is not active.")

    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    clear_login_lockout(user.email)
    AuditLog.objects.create(
        actor=user, action="LOGIN_GOOGLE", entity="User", entity_id=user.id
    )
    return _me_dict(request, user)


class ClerkSignInIn(Schema):
    #: The session token the browser got from Clerk.
    token: str


@api.get("/auth/clerk/config", auth=None)
def clerk_config(request: HttpRequest):
    """What the sign-in page needs to start Clerk, or why it cannot.

    Answered rather than left to fail, for the same reason as the Google one:
    a button that renders, is pressed, and does nothing reads as the account
    being broken rather than the feature being off.
    """
    key = (getattr(settings, "CLERK_PUBLISHABLE_KEY", "") or "").strip()
    return {"enabled": bool(key), "publishable_key": key or None}


@api.post("/auth/clerk", auth=None)
def auth_clerk(request: HttpRequest, payload: ClerkSignInIn):
    """Sign in with a Clerk session token, into an account that already exists.

    Clerk is the front door and nothing more. It establishes that somebody is
    who they say they are; everything about what they may then do -- the role,
    the department, whether they see a rupee figure at all -- stays in our own
    user table, because every one of those is part of deciding who gets paid.

    The token is verified against the instance's published signing keys, and
    its issuer is checked: a perfectly valid token from somebody else's Clerk
    instance is still somebody else's token.

    **No account is ever created here**, exactly as with Google. An address
    Clerk recognises and this college does not is refused. Accounts carry
    staff ids, biometric ids and a Scopus link, and putting a payable identity
    behind a free signup form is not a thing that can be allowed.
    """
    from core import clerk as clerk_auth

    key = (getattr(settings, "CLERK_PUBLISHABLE_KEY", "") or "").strip()
    if not key:
        raise HttpError(503, "Clerk sign-in is not configured on this server.")

    try:
        claims = clerk_auth.verify_clerk_token(payload.token, key)
    except clerk_auth.ClerkError as exc:
        logger.warning("clerk_signin_rejected")
        raise HttpError(401, str(exc))

    email = clerk_auth.email_from_claims(claims)
    if not email:
        # Clerk's default session token carries no email; it is added by a JWT
        # template. Say so, because the alternative is a sign-in that verifies
        # perfectly and then fails to match anybody, which reads as the
        # account being missing rather than the instance being unconfigured.
        raise HttpError(
            403,
            "That Clerk sign-in carried no email address, so it cannot be "
            "matched to an account here. The Clerk session token needs an "
            "email claim.",
        )

    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        raise HttpError(
            403,
            f"There is no account here for {email}. Ask the research cell to "
            "create one — signing in with Clerk does not make one.",
        )
    if not user.active:
        raise HttpError(403, "That account is not active.")

    login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    clear_login_lockout(user.email)
    AuditLog.objects.create(
        actor=user, action="LOGIN_CLERK", entity="User", entity_id=user.id
    )
    return _me_dict(request, user)


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
#: How a field is named back to somebody who was refused it.
FIELD_LABELS = {
    **{k: v.lower() for k, v in CORRECTABLE.items()},
    "faculty_type": "whether this is a research post",
    "research_quota": "the research quota",
    "research_quota_note": "the research quota note",
}

IDENTITY_FIELDS = frozenset(CORRECTABLE) - {"department"} | {
    # Not a correctable field — a claimant cannot even ask for it — but it
    # belongs in the same super-admin-only tier, and for the same reason the
    # rest are here. Being marked research faculty with a quota of four means
    # four papers a year are paid nothing. The research cell processes the
    # claims that decides the outcome of, so it cannot also set it.
    "faculty_type",
    "research_quota",
    "research_quota_note",
}


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
    if str(current or "").strip() == proposed:
        raise HttpError(400, f"{CORRECTABLE[field]} already says that.")

    # One open request per field. Asking twice because nothing visibly
    # happened should not put two of the same thing in the queue.
    existing = ProfileChangeRequest.objects.filter(
        user=u, field=field, status=ProfileChangeRequest.State.PENDING
    ).first()
    if existing:
        existing.proposed_value = proposed
        existing.note = (payload.note or "").strip()[:500] or None
        existing.current_value = str(current or "")
        existing.save()
        req = existing
    else:
        req = ProfileChangeRequest.objects.create(
            user=u,
            field=field,
            current_value=str(current or ""),
            proposed_value=proposed,
            note=(payload.note or "").strip()[:500] or None,
        )

    AuditLog.objects.create(
        actor=u,
        action="PROFILE_CORRECTION_REQUEST",
        entity="User",
        entity_id=u.id,
        detail_json=json.dumps({
            "request_id": req.id,
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
        "/admin/profile-requests",
        # Only a super admin can action an identity change, so only a super
        # admin is told about one -- a notification the reader cannot act on
        # trains them to ignore the rest.
        super_admin_only=field in IDENTITY_FIELDS,
    )
    return {
        "ok": True,
        "id": req.id,
        "field": field,
        "label": CORRECTABLE[field],
        "proposed": proposed,
        "status": req.status,
    }


# ---------- the queue those requests land in ----------


def _request_dict(r) -> dict[str, Any]:
    return {
        "id": r.id,
        "field": r.field,
        "label": CORRECTABLE.get(r.field, r.field),
        "current_value": r.current_value or "",
        "proposed_value": r.proposed_value,
        # The record may have moved since the request was made, and an
        # approver overwriting something different from what was asked about
        # should be told so rather than left to compare two screens.
        "value_now": str(getattr(r.user, r.field, "") or ""),
        "note": r.note or "",
        "status": r.status,
        "identity": r.field in IDENTITY_FIELDS,
        "requested_by": {
            "id": r.user_id,
            "name": r.user.name or r.user.email,
            "email": r.user.email,
            "department": r.user.department or "",
            "staff_id": r.user.staff_id or "",
        },
        "decided_by": r.decided_by.name if r.decided_by_id else None,
        "decided_at": r.decided_at.isoformat() if r.decided_at else None,
        "decision_note": r.decision_note or "",
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@api.get("/admin/profile-requests", auth=session_auth)
def profile_requests(request: HttpRequest, status: str = "PENDING", limit: int = 100):
    """Profile corrections waiting on somebody."""
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    qs = ProfileChangeRequest.objects.select_related("user", "decided_by")
    if status and status != "ALL":
        qs = qs.filter(status=status)
    rows = list(qs.order_by("-created_at")[: max(1, min(limit, 500))])
    return {
        "results": [_request_dict(r) for r in rows],
        "pending": ProfileChangeRequest.objects.filter(
            status=ProfileChangeRequest.State.PENDING
        ).count(),
    }


class ProfileDecisionIn(Schema):
    approve: bool
    note: Optional[str] = None


@api.post("/admin/profile-requests/{request_id}", auth=session_auth)
def decide_profile_request(
    request: HttpRequest, request_id: str, payload: ProfileDecisionIn
):
    """Apply a requested profile change, or decline it with a reason.

    Approving writes the value onto the account, which is the whole point --
    the alternative was an admin reading a notification and retyping it into
    another screen, where a typo becomes somebody else's staff id.
    """
    actor = require_user(request)
    if not rbac.can_manage_users(actor.role):
        raise HttpError(403, "Forbidden")

    req = get_object_or_404(
        ProfileChangeRequest.objects.select_related("user"), pk=request_id
    )
    if req.status != ProfileChangeRequest.State.PENDING:
        raise HttpError(
            400,
            f"This was already {req.get_status_display().lower()} "
            f"by {req.decided_by.name if req.decided_by_id else 'somebody'}.",
        )

    # Identity is super-admin only, here as much as everywhere else it is
    # written. The research cell processes the claims these fields decide the
    # outcome of, so it cannot also set them.
    if req.field in IDENTITY_FIELDS and actor.role != Role.SUPER_ADMIN:
        raise HttpError(
            403,
            f"Only a super admin can change {CORRECTABLE[req.field].lower()}. "
            "You can decline it, or leave it for one.",
        )

    note = (payload.note or "").strip()
    if not payload.approve and len(note) < 5:
        raise HttpError(400, "Say why it is being declined — the person is told.")

    if payload.approve:
        before = getattr(req.user, req.field, None)
        setattr(req.user, req.field, req.proposed_value)
        req.user.save(update_fields=[req.field, "updated_at"])
        req.status = ProfileChangeRequest.State.APPROVED
    else:
        before = None
        req.status = ProfileChangeRequest.State.DECLINED

    req.decided_by = actor
    req.decided_at = timezone.now()
    req.decision_note = note or None
    req.save()

    AuditLog.objects.create(
        actor=actor,
        action="PROFILE_CORRECTION_DECIDED",
        entity="User",
        entity_id=req.user_id,
        detail_json=json.dumps({
            "request_id": req.id,
            "field": req.field,
            "approved": payload.approve,
            "from": str(before) if before is not None else None,
            "to": req.proposed_value if payload.approve else None,
            "note": note,
        }),
    )

    # The person who asked finds out. Not being told was half of why the old
    # flow felt like shouting into a cupboard.
    label = CORRECTABLE.get(req.field, req.field)
    Notification.objects.create(
        user=req.user,
        title=(
            f"{label} updated" if payload.approve else f"{label} change declined"
        ),
        body=(
            f"Your {label.lower()} now reads “{req.proposed_value}”."
            if payload.approve
            else f"{note}"
        ),
        href="/faculty/profile",
    )
    return {"ok": True, "request": _request_dict(req)}


@api.get("/auth/profile/corrections", auth=session_auth)
def my_profile_requests(request: HttpRequest):
    """What I have asked for, and what came of it."""
    u = require_user(request)
    rows = ProfileChangeRequest.objects.filter(user=u).order_by("-created_at")[:20]
    return {"results": [_request_dict(r) for r in rows]}


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
    # The response embeds the same paid-history block as /prior/check.
    _require_may_see_money(request)
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
    _require_may_see_money(request)
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
    # Every match carries the amount a named colleague was paid and when. A
    # head of department must not see a rupee figure by any route, and this
    # route hands one over for any title somebody cares to type.
    _require_may_see_money(request)
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


# ---------- student project teams ----------


class TeamMemberIn(Schema):
    name: str
    register_number: Optional[str] = None
    programme: Optional[str] = None
    year_of_study: Optional[str] = None
    mentor_name: Optional[str] = None


class TeamIn(Schema):
    code: str
    title: Optional[str] = None
    department: Optional[str] = None
    academic_year: Optional[str] = None
    mentor_id: Optional[str] = None
    mentor_name: Optional[str] = None
    members: list[TeamMemberIn] = []


def _team_dict(team: Team) -> dict[str, Any]:
    return {
        "id": team.id,
        "code": team.code,
        "title": team.title,
        "department": team.department,
        "academic_year": team.academic_year,
        "mentor_id": team.mentor_id,
        "mentor_name": team.mentor.name if team.mentor_id else team.mentor_name,
        "active": team.active,
        "members": [
            {
                "id": m.id,
                "name": m.name,
                "register_number": m.register_number,
                "programme": m.programme,
                "year_of_study": m.year_of_study,
                "mentor_name": m.mentor_name or (
                    team.mentor.name if team.mentor_id else team.mentor_name
                ),
            }
            for m in team.members.all()
        ],
    }


@api.get("/teams/{code}", auth=session_auth)
def get_team(request: HttpRequest, code: str):
    """Pull a team up by the code a faculty member has to hand.

    A 404 here is an ordinary answer, not a failure: the filing form uses it
    to decide between "confirm this team" and "tell us who is on it", and a
    team that does not exist yet is the normal case the first time a project
    is entered anywhere.
    """
    require_user(request)
    team = Team.objects.filter(code__iexact=code.strip()).prefetch_related("members").first()
    if team is None:
        raise HttpError(404, f"No team with the code {code.strip()!r}.")
    return _team_dict(team)


@api.get("/teams", auth=session_auth)
def list_teams(request: HttpRequest, q: Optional[str] = None, limit: int = 20):
    user = require_user(request)
    qs = Team.objects.prefetch_related("members").select_related("mentor")
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(code__icontains=term) | Q(title__icontains=term) | Q(members__name__icontains=term)
        ).distinct()
    elif not rbac.can_view_reports(user.role):
        # Without a search, a claimant sees the teams they mentor rather than
        # the whole college's — a list of every student project is not what
        # they came for and not theirs to browse.
        qs = qs.filter(Q(mentor=user) | Q(created_by=user))
    return {"results": [_team_dict(t) for t in qs[: max(1, min(limit, 100))]]}


@api.post("/teams", auth=session_auth)
def upsert_team(request: HttpRequest, payload: TeamIn):
    """Create a team, or confirm and correct one that already exists.

    One endpoint for both because that is what the form does: the code is
    typed, the team comes up, and what comes back is either agreed with or
    edited. Two endpoints would mean the screen deciding which of them it is
    in, and getting it wrong the first time a code is mistyped.
    """
    user = require_user(request)
    code = (payload.code or "").strip()
    if len(code) < 2:
        raise HttpError(400, "A team needs a code.")

    members = [m for m in payload.members if (m.name or "").strip()]
    if not members:
        raise HttpError(400, "A team needs at least one student on it.")

    mentor = None
    if payload.mentor_id:
        mentor = User.objects.filter(pk=payload.mentor_id).first()
        if mentor is None:
            raise HttpError(404, "No such mentor")

    with transaction.atomic():
        team = Team.objects.filter(code__iexact=code).first()
        if team is None:
            team = Team.objects.create(
                code=code,
                title=(payload.title or "").strip() or None,
                department=(payload.department or "").strip() or (user.department or None),
                academic_year=(payload.academic_year or "").strip() or None,
                # The creator is only assumed to be the mentor when nobody
                # said otherwise. Naming one and then being overruled by the
                # act of typing it in is the kind of surprise that gets a
                # field quietly ignored afterwards.
                mentor=mentor
                or (
                    user
                    if user.role == Role.FACULTY and not (payload.mentor_name or "").strip()
                    else None
                ),
                mentor_name=(payload.mentor_name or "").strip() or None,
                created_by=user,
            )
            created = True
        else:
            team.title = (payload.title or "").strip() or team.title
            team.department = (payload.department or "").strip() or team.department
            team.academic_year = (payload.academic_year or "").strip() or team.academic_year
            if mentor:
                team.mentor = mentor
            if payload.mentor_name:
                team.mentor_name = payload.mentor_name.strip()
            team.save()
            created = False

        # The list that comes back is the list, so removing somebody works.
        team.members.all().delete()
        for m in members:
            TeamMember.objects.create(
                team=team,
                name=m.name.strip(),
                register_number=(m.register_number or "").strip() or None,
                programme=(m.programme or "").strip() or None,
                year_of_study=(m.year_of_study or "").strip() or None,
                mentor_name=(m.mentor_name or "").strip() or None,
            )

    AuditLog.objects.create(
        actor=user, action="TEAM_CREATE" if created else "TEAM_UPDATE",
        entity="Team", entity_id=team.id,
        detail_json=json.dumps({"code": team.code, "members": len(members)}),
    )
    team.refresh_from_db()
    return {**_team_dict(team), "created": created}


def _min_sec_references() -> int:
    """How many evidenced SEC-affiliated references the live policy requires.

    Read from the active `FormulaConfig` and only then from the code default,
    because the same number decides three things — what the form tells a
    claimant, whether the submission is accepted, and what the calculator
    pays — and a hard-coded copy in any one of them is a rule that silently
    stops matching the money.
    """
    cfg = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    raw = getattr(cfg, "min_sec_references", None)
    return int(raw if raw is not None else MIN_SEC_REFERENCES)


def _numbered_sec_references(claim: Claim) -> int:
    """SEC references the claim actually evidences.

    The same count `_apply_calc` pays on: a SEC_REFERENCE attachment carrying
    the number that citation has in the paper's own reference list. A typed
    `sec_refs` string is not this — nobody can check a number against a file
    that was never attached.
    """
    if not claim.pk:
        return 0
    return (
        claim.attachments.filter(kind=AttachmentKind.SEC_REFERENCE)
        .exclude(ref_number__isnull=True)
        .exclude(ref_number="")
        .count()
    )


@api.get("/meta/filing-rules", auth=session_auth)
def filing_rules(request: HttpRequest):
    """The eligibility rules the filing form has to enforce, from the live policy.

    Not the policy sheet -- that stays an oversight document and 403s a
    claimant. These are the handful of rules that decide whether a paper is
    eligible at all, and the form has to know them because the alternative is
    what happened before: a claimant fills in five steps, files, and is paid
    nothing because the policy needs two SEC-affiliated references and they
    attached one. The rule was enforced in the calculator, mentioned in a note
    on the resulting zero, and stated nowhere a person could read it *first*.

    Submission is now refused rather than ticketed at Rs 0, which makes saying
    it here load-bearing: a form that does not repeat these sentences sends
    people into a refusal they were never warned about.

    They are read from the active `FormulaConfig` rather than hard-coded, so
    a policy change moves the form on its own. A hard-coded 2 in the client
    is a rule that silently stops matching the one the money is calculated
    from.
    """
    require_user(request)
    cfg = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()

    max_authors = int(
        getattr(cfg, "max_authors", None) or MAX_ELIGIBLE_AUTHORS
    )
    min_sec = _min_sec_references()

    return {
        "max_authors": max_authors,
        "min_sec_references": min_sec,
        "attachment_limits": {
            "PUBLISHED_PAPER": ATTACHMENT_LIMITS[AttachmentKind.PUBLISHED_PAPER],
            "SEC_REFERENCE": ATTACHMENT_LIMITS[AttachmentKind.SEC_REFERENCE],
        },
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        # Said in the words the form will repeat, so the sentence a claimant
        # reads before filing is the same one the calculator would have told
        # them afterwards.
        "why": {
            "max_authors": (
                f"A paper with more than {max_authors} authors is counted but "
                "carries no remuneration."
            ),
            "min_sec_references": (
                f"The policy requires {min_sec} cited references with a Saveetha "
                "Engineering College affiliation, each attached and numbered as "
                "it appears in your reference list. An incentive claim with "
                "fewer than that is not accepted — it would be worked out as "
                "Rs 0. File it as a publication count instead if you have no "
                "more to cite."
            ),
        },
        "policy_version": getattr(cfg, "version", None),
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


def _require_may_see_money(request: HttpRequest) -> User:
    """Anybody but a head of department.

    Money-blindness is the one rule in this system that is not a matter of
    taste, and `hod.without_money` only strips it from payloads that go
    through it. An endpoint that *computes* a figure and returns it — pricing
    a hypothetical paper, pricing a search result — hands one over without
    ever touching that filter. Three of them did.
    """
    user = require_user(request)
    if user.role == Role.HOD:
        raise HttpError(
            403,
            "Amounts are not shown to a head of department. The academic "
            "standing of a journal is on the journal's own page.",
        )
    return user


def _quota_state(claim: Claim) -> tuple[bool, str | None]:
    """Whether this paper falls inside a research faculty member's quota.

    Research faculty are already paid to do research, so the scheme rewards
    what exceeds the expectation rather than the expectation itself: papers up
    to the quota carry no remuneration and only the surplus is reimbursed.

    Position is **handed out once and stored**, in `quota_position`. Deriving
    it was tried and does not work: `created_at` comes from a clock coarser
    than the loop that writes the rows, so several claims share a timestamp to
    the microsecond, and the id is a random uuid, so breaking that tie on the
    id orders papers arbitrarily. With the amount recomputed at creation, a
    paper filed fifth could take first place and be zeroed while an earlier
    one was paid — four of five papers landed inside a quota of two before
    this was a stored number.

    A draft gets a provisional position and keeps none: an unfinished paper
    must not consume somebody's allowance.

    Returns (inside_the_quota, why).
    """
    owner = claim.owner
    if owner is None or owner.faculty_type != "RESEARCH":
        return False, None
    quota = owner.research_quota
    if not quota:
        return False, None
    if claim.claim_reason == ClaimReason.COUNT_ONLY:
        # It asks for no money, so it cannot spend the allowance for money.
        return False, None

    year = claim.publication_year
    if not year:
        # No year, no bucket to count against. Left payable rather than
        # zeroed: refusing money over a missing field somebody else is
        # supposed to verify is the wrong way round.
        return False, None

    position = claim.quota_position
    if position is None:
        # The next slot, not the number of slots taken. `count()` gives the
        # same answer only while the sequence has no gaps -- and a paper whose
        # year is corrected leaves one, after which two papers share a slot.
        highest = (
            Claim.objects.filter(
                owner=owner, publication_year=year, quota_position__isnull=False
            )
            .exclude(pk=claim.pk)
            .aggregate(top=Max("quota_position"))["top"]
            or 0
        )
        position = highest + 1
        # Assigned by `_assign_quota_position` at submission, not here: at the
        # moment this runs during a submit the claim is still DRAFT, so a
        # status test here never fires. This function only *reads*.

    # The stored number decides, not this paper's rank among the year's.
    # Ranking -- count the year's papers below this one, add one -- was
    # considered, because "a quota of 2" means "the year's first two papers"
    # and the two readings differ the moment the sequence has a hole. They
    # differ in exactly one bucket: the one `Claim._close_quota_gap` refuses
    # to renumber because a paper that would move down has already been paid.
    # Ranking there would move that paper from outside the quota to inside it
    # and reprice settled money downward -- which is the thing the model
    # declines to do, so doing it here would only be doing it later and in
    # another file. Everywhere else the sequence is kept hole-free and the two
    # readings agree, so the rank query would buy nothing and cost a COUNT on
    # every pass of `_apply_calc` -- every create, patch, submit, re-verify,
    # bulk clear and monthly batch row.
    if position <= quota:
        return True, (
            f"Paper {position} of a {quota}-paper research quota for {year}. "
            "The quota is what the post already expects, so it carries no "
            "remuneration — only papers beyond it are reimbursed."
        )
    return False, (
        f"Paper {position} for {year}, beyond the {quota}-paper research "
        "quota, so it is reimbursed in full."
    )


def _peek_next_quota_slot(claim: Claim) -> int:
    """The next free position in this paper's author-and-year bucket.

    Split out from the allocation so the read can be repeated after a
    collision, and so a test can make it stale on purpose.
    """
    highest = (
        Claim.objects.filter(
            owner_id=claim.owner_id,
            publication_year=claim.publication_year,
            quota_position__isnull=False,
        )
        .exclude(pk=claim.pk)
        .aggregate(top=Max("quota_position"))["top"]
        or 0
    )
    return highest + 1


def _assign_quota_position(claim: Claim) -> None:
    """Give a paper its place in its author's research-quota year, once.

    Called when the claim is filed, which is the only moment that is both
    stable and meaningful: a draft must not consume somebody's allowance, and
    a position handed out later would depend on the order an admin happened to
    open tickets in rather than on the order they were filed. It is also
    called after a filed paper's year is corrected, because the correction
    drops the slot the old year issued and the paper has to take one in its
    new year.

    Idempotent. Re-filing a paper that was sent back keeps the slot it had.

    Concurrency-safe the same way `assign_ticket_number` is, and for the same
    reason: MAX + 1 read in one statement and written in another means two
    submits for one author and year can read the same maximum. The unique
    constraint on (owner, publication_year, quota_position) turns that into a
    failed write rather than a silently shared slot — which is the better of
    the two failures and still a failure, because what the claimant saw was a
    500 and a submission that did not happen. So: lock the bucket, take the
    next slot, and on a collision drop the number and try for another. The
    position is written here rather than left on the instance, since the row
    the constraint protects is only protected once it exists.
    """
    owner = claim.owner
    if (
        claim.quota_position is not None
        or owner is None
        or owner.faculty_type != "RESEARCH"
        or not owner.research_quota
        or not claim.publication_year
        or claim.claim_reason == ClaimReason.COUNT_ONLY
        or not claim.pk
    ):
        return

    for _ in range(8):
        try:
            with transaction.atomic():
                # Serialise the allocators for this one bucket. A no-op on
                # SQLite, which serialises writers anyway; the lock is what
                # holds on Postgres, where the college actually runs.
                list(
                    Claim.objects.select_for_update()
                    .filter(
                        owner_id=claim.owner_id,
                        publication_year=claim.publication_year,
                        quota_position__isnull=False,
                    )
                    .order_by("-quota_position")[:1]
                )
                claim.quota_position = _peek_next_quota_slot(claim)
                claim.save(update_fields=["quota_position", "updated_at"])
            return
        except IntegrityError:
            # Somebody else took it between the read and the write.
            claim.quota_position = None
            continue
    raise RuntimeError("Could not assign a research-quota position")


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
    # The quota zeroes the payable amount and nothing else. base_amount, qf and
    # the author point stay exactly as the policy computed them, so the ticket
    # still shows what the paper was worth and why it came to nothing --
    # rather than looking like a paper the formula could not price.
    inside_quota, quota_why = _quota_state(claim)
    claim.quota_applied = inside_quota
    claim.quota_note = quota_why
    if inside_quota:
        result = replace(result, remuneration=0.0, note=quota_why)
    claim.base_amount = result.base
    claim.author_point = result.point
    claim.remuneration = result.remuneration
    claim.qf_amount = result.qf
    claim.calc_error = result.error
    claim.remuneration_category = result.category
    # `remuneration_note` is the "why this amount" line the ticket, the
    # clearing queue and the approval screen all already display. A quartile
    # or a SNIP taken from another year is part of why the amount is what it
    # is, so it is said here and not only in a field nothing renders.
    claim.remuneration_note = " ".join(
        s for s in (result.note, _quartile_year_note(claim), _snip_year_note(claim)) if s
    ) or None
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


# Registered above `/claims/{claim_id}` on purpose. django-ninja matches in
# registration order, so declared after it this resolves as a claim whose id
# is the literal string "counts" and 404s. The same collision already cost us
# `/admin/data/Claim/export` once.
@api.get("/claims/counts", auth=session_auth)
def claim_counts(request: HttpRequest, q: Optional[str] = None):
    """How many claims sit at each stage, in one query.

    Added because the papers screen was asking seven times -- one request per
    filter chip -- and still could not count a legacy ERP row correctly: the
    list endpoint takes a single status, while a stage covers several. Grouping
    here means one query, and it means the grouping matches `stageOf` on the
    client instead of approximating it.
    """
    user = require_user(request)
    scope = _claims_queryset(user)
    if q:
        scope = scope.filter(
            Q(paper_title__icontains=q) | Q(ticket_number__icontains=q)
        )

    raw = dict(
        scope.values_list("status").annotate(n=Count("id")).values_list("status", "n")
    )

    #: The same grouping `stageOf` uses on the client, including the legacy ERP
    #: statuses. Kept here so the two cannot drift apart silently.
    stages = {
        "draft": ["DRAFT"],
        "filed": ["SUBMITTED", "HOD_APPROVED"],
        "checked": ["CLEARED", "RESEARCH_APPROVED"],
        "approved": ["PRINCIPAL_APPROVED"],
        "authorised": ["DIRECTOR_APPROVED", "FINANCE_APPROVED"],
        "paid": ["PAID"],
        "sent_back": ["REJECTED"],
    }
    counts = {
        stage: sum(raw.get(status, 0) for status in statuses)
        for stage, statuses in stages.items()
    }
    counts["all"] = sum(raw.values())
    return {"counts": counts, "statuses": raw, "stages": stages}


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


def _flatten_title(title: str) -> str:
    """A journal title with everything but its letters and digits removed."""
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()


def _match_on_punctuation(qs, title: str):
    """The same journal, spelled without its punctuation.

    The ERP dropped colons, commas and brackets out of journal titles on the
    way in, so "Journal of Materials Science: Materials in Electronics" is
    stored as "Journal of Materials Science Materials in Electronics" and an
    exact match finds nothing. Sixty of the college's journals are in that
    position and every one of them was reported as unranked.

    Narrowed by the two longest words before anything is compared -- they are
    the most selective and they cannot themselves contain punctuation -- so
    this reads a few hundred rows rather than thirty-two thousand.
    """
    flat = _flatten_title(title)
    if not flat:
        return None
    words = sorted(set(flat.split()), key=len, reverse=True)
    probes = [w for w in words if len(w) > 3][:2]
    if not probes:
        return None
    candidates = qs
    for w in probes:
        candidates = candidates.filter(title__icontains=w)
    for row in candidates.order_by("-year")[:300]:
        if _flatten_title(row.title) == flat:
            return row
    return None


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
    if row is None and title:
        row = _match_on_punctuation(scimago_qs, title)
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

    # The one field that is mandatory on some claims and meaningless on the
    # rest. Checked here rather than added to `missing` above so the message
    # can say what to do about it: "Team" in a list of missing fields does not
    # tell somebody that the team has to exist before the claim can name it.
    if claim.claim_reason == ClaimReason.STUDENT_PROJECT and claim.team_id is None:
        raise HttpError(
            400,
            "A student project claim has to name the team. Enter the team "
            "code and confirm the students on it before submitting — the "
            "incentive is claimed on their project, and a ticket that names "
            "only you does not show whose work it was.",
        )

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

    # The formula is the policy, and the formula counts numbered SEC_REFERENCE
    # attachments. This gate used to count something else — a typed `sec_refs`
    # string, or any single reference URL — so a claim could satisfy every gate,
    # reach Finance, and be worked out as Rs 0 with a note saying it cited none
    # while the form in front of the claimant said three. Refuse it here, where
    # it can still be fixed, rather than pay nothing later.
    #
    # COUNT_ONLY is exempt: it asks for no money, so a threshold whose only job
    # is to decide an amount has nothing to say about it. It keeps the older,
    # looser rule — one reference on file — which is all a publication record
    # needs.
    if claim.claim_reason == ClaimReason.COUNT_ONLY:
        if not has_refs:
            raise HttpError(
                400, "Upload at least one cited reference with SEC affiliation (PDF)"
            )
    else:
        min_sec = _min_sec_references()
        numbered = _numbered_sec_references(claim)
        if numbered < min_sec:
            raise HttpError(
                400,
                f"The incentive is paid on {min_sec} cited references with a "
                "Saveetha Engineering College affiliation, and only the ones "
                f"you evidence count — {numbered} of {min_sec} so far. For each "
                "one, attach the cited paper and enter the number it has in "
                "your reference list. Filed without them this claim would be "
                "worked out as Rs 0; if you have no more to cite, file it as a "
                "publication count instead.",
            )


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
    # The paper is now in its author's year, so it takes a slot -- and the
    # amount is worked out again, because the first pass priced it without
    # one. Without this every research-faculty paper is "paper 1" and pays
    # nothing, which is what happened.
    _assign_quota_position(claim)
    _apply_calc(claim)
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
            "Approved — with the Director",
            "The Principal has approved your ticket. It is with the Director to "
            "be authorised.",
        )
    if to_status == ClaimStatus.DIRECTOR_APPROVED:
        return (
            "Authorised — with Finance",
            "The Director has authorised your ticket. It is with Finance for payment.",
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
    elif claim.status == ClaimStatus.DIRECTOR_APPROVED:
        started = claim.director_approved_at
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
    if claim.status not in (
        ClaimStatus.CLEARED,
        ClaimStatus.PRINCIPAL_APPROVED,
        ClaimStatus.DIRECTOR_APPROVED,
    ):
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

    # Goes to the Director, not to Finance. Finance cannot see it until it is
    # authorised, and telling them it was "approved for payment" at this point
    # was the exact confusion the extra step exists to remove.
    _notify_director(
        claim,
        f"Awaiting your authorisation · {claim.ticket_number}",
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
        _notify_director(
            claim,
            f"Awaiting your authorisation · {claim.ticket_number}",
            f"₹{(claim.remuneration or 0):,.0f} for {claim.owner.name}: {claim.paper_title}",
        )
    return {"approved": approved, "total": round(total, 2), "skipped": skipped}


# ---------- the director: authorising what the principal approved ----------


def _may_approve_as_director(role: str) -> bool:
    """The Director, and a super admin who has to stand in for one."""
    return rbac.can_approve_as_director(role)


@api.post("/claims/{claim_id}/director-approve", auth=session_auth)
def director_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Authorise a Principal-approved claim, which is what lets finance pay it.

    The Principal agrees the spend is correct on its own terms. The Director
    authorises it against the institution's position -- the budget it comes out
    of, and everything else authorised the same month. Two separate decisions
    taken by two separate people, which is the whole reason this step exists
    rather than being folded into the one before it.
    """
    user = require_user(request)
    if not _may_approve_as_director(user.role):
        raise HttpError(403, "Forbidden")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.PRINCIPAL_APPROVED:
            raise HttpError(
                400,
                "Only a ticket the Principal has approved can be authorised"
                f" -- this one is {claim.status}",
            )
        # The amount on the screen is the amount being authorised. Recomputing
        # here means an authorisation cannot be given for one figure and the
        # payment made at another.
        _apply_calc(claim)
        _guard_recomputed_amount(claim, payload.expected_amount)

        claim.director_approved_by = user
        claim.director_approved_at = timezone.now()
        # A third pair of eyes satisfies the second-signature rule if the
        # Principal has not already -- but only where this really is somebody
        # other than whoever cleared it.
        if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
            claim.second_approved_by = user
            claim.second_approved_at = timezone.now()
        _transition(
            claim, user, ClaimStatus.DIRECTOR_APPROVED, "DIRECTOR_APPROVE", payload.note
        )
        amount = claim.remuneration or 0

    _notify_finance(
        claim,
        f"Authorised for payment \u00b7 {claim.ticket_number}",
        f"\u20b9{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
    )
    return claim_to_dict(claim)


@api.get("/director/queue", auth=session_auth)
def director_queue(
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
    """Everything the Principal has approved and the Director has not authorised.

    Shaped exactly like the principal queue, deliberately: the two roles do the
    same kind of work one step apart, and a second queue that sorted or totalled
    differently would have the two disagreeing about the same money.

    The totals are over the whole filtered set, not the page -- a decision about
    a month's spend cannot be taken from the fifty rows that fit on screen.
    """
    user = require_user(request)
    if not _may_approve_as_director(user.role):
        raise HttpError(403, "Forbidden")

    qs = (
        Claim.objects.filter(status=ClaimStatus.PRINCIPAL_APPROVED)
        .select_related("owner", "cleared_by", "principal_approved_by", "override_by")
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
        qs = qs.filter(
            principal_approved_at__lte=timezone.now() - timedelta(days=int(waiting_over))
        )

    sorts = {
        "waiting": "principal_approved_at",   # longest wait first
        "recent": "-principal_approved_at",
        "amount": "-remuneration",
        "amount_asc": "remuneration",
        "department": "owner__department",
        "title": "paper_title",
    }
    qs = qs.order_by(sorts.get(sort, "principal_approved_at"))

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    agg = qs.aggregate(amount=Sum("remuneration"), oldest=Min("principal_approved_at"))
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
            for d in Claim.objects.filter(status=ClaimStatus.PRINCIPAL_APPROVED)
            .values_list("owner__department", flat=True)
            .distinct()
            if d
        ),
    }


@api.post("/director/bulk-approve", auth=session_auth)
def director_bulk_approve(request: HttpRequest, payload: PrincipalBulkIn):
    """Authorise a batch, one row at a time, skipping what does not qualify.

    A batch that fails as a unit is a batch nobody dares run: one stale row out
    of two hundred and the Director is back to clicking through them singly.
    """
    user = require_user(request)
    if not _may_approve_as_director(user.role):
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
            if claim.status != ClaimStatus.PRINCIPAL_APPROVED:
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
                        f"recalculation (\u20b9{(shown or 0):,.0f} \u2192 \u20b9{(claim.remuneration or 0):,.0f})"
                        " -- open it to review"
                    ),
                })
                transaction.set_rollback(True)
                continue
            claim.director_approved_by = user
            claim.director_approved_at = timezone.now()
            if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
                claim.second_approved_by = user
                claim.second_approved_at = timezone.now()
            _transition(
                claim, user, ClaimStatus.DIRECTOR_APPROVED, "DIRECTOR_APPROVE", payload.note
            )
            approved += 1
            total += claim.remuneration or 0
        _notify_finance(
            claim,
            f"Authorised for payment \u00b7 {claim.ticket_number}",
            f"\u20b9{(claim.remuneration or 0):,.0f} for {claim.owner.name}: {claim.paper_title}",
        )
    return {"approved": approved, "total": round(total, 2), "skipped": skipped}


@api.post("/claims/{claim_id}/director-reject", auth=session_auth)
def director_reject(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Send an approved ticket back to the Principal with a reason.

    Back one step, not all the way: what the Director is querying is the
    approval, so it returns to the person who gave it. Dropping it to the
    claimant instead would have somebody who did nothing wrong re-filing a
    paper to answer a question about the institution's budget.
    """
    user = require_user(request)
    if not _may_approve_as_director(user.role):
        raise HttpError(403, "Forbidden")
    note = (payload.note or "").strip()
    if len(note) < 5:
        raise HttpError(400, "Say why it is going back")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.PRINCIPAL_APPROVED:
            raise HttpError(
                400, "Only a Principal-approved ticket can be sent back from here"
            )
        claim.status_note = note
        # The approval is withdrawn along with the status. Leaving the name and
        # the timestamp on a ticket that is no longer approved is how a later
        # reader concludes it was signed off twice.
        claim.principal_approved_by = None
        claim.principal_approved_at = None
        claim.save(update_fields=["principal_approved_by", "principal_approved_at"])
        _transition(claim, user, ClaimStatus.CLEARED, "DIRECTOR_SEND_BACK", note)

    for u in User.objects.filter(
        role__in=(Role.PRINCIPAL, Role.SUPER_ADMIN), active=True
    ):
        Notification.objects.create(
            user=u,
            title=f"Sent back by the Director \u00b7 {claim.ticket_number}",
            body=note[:300],
            href=f"/approvals?claim={claim.id}",
            claim_id=claim.id,
        )
    return claim_to_dict(claim)


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
        # Payable means the Director authorised it on this system. Three
        # things are deliberately not payable:
        #
        # - a merely cleared ticket, which the office has checked but nobody
        #   has agreed to spend money on;
        # - a Principal-approved ticket, which has been agreed but not yet
        #   authorised — the step this chain gained most recently;
        # - a row carrying an approval status from the old ERP import, which
        #   has no verification, no recomputed amount and nobody's signature
        #   behind it. Those are told apart by director_approved_at, which
        #   only a live authorisation sets.
        authorised_here = bool(claim.director_approved_at)
        if not (claim.status == ClaimStatus.DIRECTOR_APPROVED and authorised_here):
            if claim.status == ClaimStatus.CLEARED:
                raise HttpError(
                    400,
                    "Cleared, but not yet approved by the Principal — payment "
                    "needs that approval, and then the Director's authorisation.",
                )
            if claim.status == ClaimStatus.PRINCIPAL_APPROVED:
                raise HttpError(
                    400,
                    "Approved by the Principal but not yet authorised by the "
                    "Director. Finance pays what the Director authorises.",
                )
            if claim.status in PAYABLE_STATUSES:
                raise HttpError(
                    400,
                    "This ticket is on a retired approval status from the old ERP. "
                    "A super admin must move it to Cleared before it can be paid, "
                    "so the amount is verified rather than taken from the import.",
                )
            raise HttpError(
                400,
                "Invalid status — the ticket must be authorised by the Director first",
            )
        # Net of the ledger, not mere existence: a voided payment leaves a
        # reversing row behind, and the claim must be payable again.
        net_paid = claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
        if net_paid > 0:
            raise HttpError(400, "Already processed")
        if claim.status == ClaimStatus.DIRECTOR_APPROVED:
            # Recompute FIRST, then decide whether it needs a second signature.
            #
            # The other order was the bug: the threshold was tested against the
            # stored figure and the amount was recomputed immediately after, so
            # a claim sitting just under the threshold that recomputed just
            # over it was paid at the higher amount with nobody's second
            # signature on it. The guard has to see the number that is about to
            # be paid, not the one that happened to be on the row.
            if reverify:
                _reverify_or_recalc(claim, user, skip_external=skip_external)
            else:
                _apply_calc(claim)
            # The amount guard goes first of the two. If the figure moved, the
            # actor confirmed a number that is not the one about to be paid,
            # and every question after that is about the wrong amount --
            # including whether it needs a second signature.
            _guard_recomputed_amount(claim, expected_amount)
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
        if claim.status not in (
            ClaimStatus.CLEARED,
            ClaimStatus.PRINCIPAL_APPROVED,
            ClaimStatus.DIRECTOR_APPROVED,
        ):
            raise HttpError(
                400,
                "Only a cleared, principal-approved or director-authorised "
                "ticket can be second-approved",
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
    # Returns total_paid and a remuneration on every recent row. /claims and
    # /claims/{id} both refuse a head here and this one did not, which held
    # only while a head owned no claims -- the condition the guard's own
    # docstring says must never be relied on.
    _refuse_hod_money_screens(user)
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
#: Scimago writes a subject's own quartile into the label -- "Signal
#: Processing (Q4)" -- so the same field carries two facts joined by a
#: bracket. Splitting them means "Signal Processing" is one area with a
#: quartile rather than four areas that happen to share a name.
_SUBJECT_QUARTILE = re.compile(r"\s*\((Q[1-4])\)\s*$", re.IGNORECASE)


def _split_subjects(raw: str | None) -> list[tuple[str, str | None]]:
    """One stored subjects string -> [(area, quartile or None), ...].

    The column is named `subjects_json` and holds no JSON: it is a
    semicolon-separated list, and every reader of it has to know that. Parsing
    it in one place is the only thing stopping three screens from each
    inventing their own split.
    """
    out: list[tuple[str, str | None]] = []
    for part in (raw or "").split(";"):
        label = part.strip()
        if not label:
            continue
        found = _SUBJECT_QUARTILE.search(label)
        quartile = found.group(1).upper() if found else None
        area = _SUBJECT_QUARTILE.sub("", label).strip()
        # "(miscellaneous)" is a real Scimago category and must survive; only
        # a trailing quartile is stripped, which is why this is a regex on
        # Q1-Q4 rather than "drop anything in brackets".
        if area:
            out.append((area, quartile))
    return out


#: What a report can be broken down by: the key a caller asks for, the
#: heading it prints under, and the column it groups on. "area" is the odd
#: one and is handled separately, because a paper belongs to several subject
#: areas at once and no single column holds that.
REPORT_DIMENSIONS: dict[str, tuple[str, str | None]] = {
    "year": ("Year", "publication_year"),
    "department": ("Department", "owner__department"),
    "quartile": ("Quartile", "quartile"),
    "journal": ("Journal", "journal_title"),
    "type": ("Publication type", "aggregation_type"),
    "indexing": ("Indexing", "indexing_level"),
    "designation": ("Designation", "owner__designation"),
    "status": ("Stage", "status"),
    "engineering": ("Engineering class", "engineering_class"),
    "category": ("Payout category", "remuneration_category"),
    "person": ("Person", "owner__name"),
    "area": ("Subject area", None),
}

_BLANKISH_LABELS = {"", "-", "--", "n/a", "na", "none", "null", "nil", "\u2014", "\u2013"}

#: Dimensions where one paper belongs to several rows at once -- a paper in
#: three subject areas, a journal indexed by both Scopus and SCIE.
#:
#: Counting the paper under each is the honest answer to "how much work do we
#: do in this area". Adding up the *money* the same way is not: the same
#: rupee is counted once per area, and the college's 2.8 crore of payouts
#: totalled 12.6 crore across subject areas. Per-row amounts are still
#: meaningful -- "papers in this area were worth this much" -- so they stay;
#: it is the column total that is a fiction, and it is withheld rather than
#: printed with a caveat nobody reads.
OVERLAPPING_DIMENSIONS = {"area", "indexing"}


def _build_rows(qs, dimension: str) -> list[dict[str, Any]]:
    """One dimension, grouped, counted and summed.

    Blanks are folded the same way `/reports` folds them. Grouping on the raw
    column split one idea across several rows -- the quartile breakdown
    carried "No quartile", "No Quartile" and "-" as three separate lines, so
    no row in the report was the real total.
    """
    if dimension == "area":
        buckets: dict[str, dict[str, Any]] = {}
        for raw, amount in qs.values_list("subjects_json", "remuneration"):
            for area, _quartile in _split_subjects(raw):
                slot = buckets.setdefault(area, {"key": area, "count": 0, "amount": 0.0})
                slot["count"] += 1
                slot["amount"] += amount or 0
        return sorted(buckets.values(), key=lambda r: (-r["count"], r["key"]))

    if dimension == "indexing":
        buckets = {}
        for raw, amount in qs.values_list("indexing_level", "remuneration"):
            parts = [p.strip() for p in (raw or "").split(",") if p.strip()] or ["Not stated"]
            for part in parts:
                slot = buckets.setdefault(part, {"key": part, "count": 0, "amount": 0.0})
                slot["count"] += 1
                slot["amount"] += amount or 0
        return sorted(buckets.values(), key=lambda r: (-r["count"], r["key"]))

    _label, field = REPORT_DIMENSIONS[dimension]
    assert field
    buckets = {}
    for row in (
        qs.values(field).annotate(count=Count("id"), amount=Sum("remuneration"))
    ):
        raw = row[field]
        text = str(raw).strip() if raw is not None else ""
        label = "Not recorded" if text.lower() in _BLANKISH_LABELS else text
        slot = buckets.setdefault(label, {"key": label, "count": 0, "amount": 0.0})
        slot["count"] += row["count"]
        slot["amount"] += row["amount"] or 0
    ordered = sorted(buckets.values(), key=lambda r: (-r["count"], r["key"]))
    if dimension == "year":
        # A time axis reads forwards, not by size.
        ordered.sort(key=lambda r: r["key"])
    return ordered


@api.get("/reports/build", auth=session_auth)
def reports_build(
    request: HttpRequest,
    dimensions: str = "department",
    year: Optional[int] = None,
    department: Optional[str] = None,
    month: Optional[str] = None,
    fmt: Optional[str] = None,
    limit: int = 100,
):
    """A report the reader assembled, previewed and downloaded from one place.

    The preview and the file come out of this same call: ask without `fmt` and
    it answers JSON for the screen, ask with one and it answers the workbook.
    That is the whole point of it being one endpoint rather than two. A screen
    and a download built by separate code paths drift, and the way anybody
    finds out is a board meeting where the printed figure and the projected
    one disagree.

    Money is stripped for a role that may not see it -- but `can_view_reports`
    already excludes a head of department outright, so in practice this is a
    belt-and-braces guard rather than a live path.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    wanted = [d.strip() for d in (dimensions or "").split(",") if d.strip()]
    if not wanted:
        raise HttpError(400, "Choose at least one breakdown")
    unknown = [d for d in wanted if d not in REPORT_DIMENSIONS]
    if unknown:
        raise HttpError(
            400,
            f"No breakdown called {unknown[0]!r}. "
            f"Available: {', '.join(sorted(REPORT_DIMENSIONS))}",
        )

    qs = _reports_queryset(user, year, department, month)
    limit = max(1, min(int(limit), 1000))

    scope_bits = [
        f"publication year {year}" if year else "all years on record",
        department or "every department",
    ]
    if month:
        scope_bits.append(f"payout month {month}")
    subtitle = "Saveetha Engineering College \u00b7 " + " \u00b7 ".join(scope_bits)

    tables = []
    for key in wanted:
        label, _field = REPORT_DIMENSIONS[key]
        rows = _build_rows(qs, key)
        overlapping = key in OVERLAPPING_DIMENSIONS
        tables.append({
            "key": key,
            "label": label,
            "rows": [
                {**r, "amount": round(r["amount"], 2)} for r in rows[:limit]
            ],
            "row_count": len(rows),
            "truncated": max(0, len(rows) - limit),
            # One paper sits in several rows here, so neither total is a
            # total of anything real. The count is still worth showing as a
            # sum of appearances; the money is not, and is null.
            "overlapping": overlapping,
            "totals": {
                "count": sum(r["count"] for r in rows),
                "amount": None if overlapping else round(sum(r["amount"] for r in rows), 2),
            },
        })

    if not fmt:
        return {
            "tables": tables,
            "filters": {"year": year, "department": department, "month": month},
            "subtitle": subtitle,
            "available": [
                {"key": k, "label": v[0]} for k, v in REPORT_DIMENSIONS.items()
            ],
            "years": sorted(
                {y for y in qs.values_list("publication_year", flat=True) if y},
                reverse=True,
            ),
        }

    if fmt not in exporters.FORMATS:
        raise HttpError(400, f"Format must be one of: {', '.join(exporters.FORMATS)}.")

    # The pack is built from the very rows the preview returned, so the file
    # cannot disagree with the screen about anything except how it is dressed.
    pack: dict[str, dict[str, Any]] = {}
    for table in tables:
        body = [[r["key"], r["count"], r["amount"]] for r in table["rows"]]
        if table["overlapping"]:
            # No money total, and the sheet says why rather than leaving a
            # blank cell that reads as a bug.
            body.append([
                "Total (appearances)", table["totals"]["count"], None,
            ])
            body.append([
                "One paper appears under every area it belongs to, so these "
                "add to more than the number of papers and the amounts "
                "cannot be summed.",
                None, None,
            ])
        else:
            body.append(["Total", table["totals"]["count"], table["totals"]["amount"]])
        pack[table["label"]] = {
            "columns": [table["label"], "Publications", "Amount"],
            "rows": body,
        }

    body = exporters.render(
        pack, fmt, title="Publication report", subtitle=subtitle
    )
    stem = "report-" + "-".join(wanted) + f"-{year or 'all'}"
    res = HttpResponse(body, content_type=exporters.CONTENT_TYPES[fmt])
    res["Content-Disposition"] = f'attachment; filename="{exporters.filename(stem, fmt)}"'
    AuditLog.objects.create(
        actor=user, action="REPORT_BUILD", entity="Report", entity_id=stem,
        detail_json=json.dumps({"dimensions": wanted, "fmt": fmt, "year": year}),
    )
    return res


@api.get("/reports/areas", auth=session_auth)
def reports_areas(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    limit: int = 40,
):
    """What the college researches, by subject area.

    Nothing else in the system answers this. `subject_category` is a column
    that exists and is empty on every one of the 3,226 filed claims; the real
    answer lives in `subjects_json`, which Scimago fills in for a journal we
    recognise.

    Which is exactly why `coverage` is returned and must be shown. Subjects
    are only known for a paper whose journal we could match, so an area chart
    silently describes that subset and not the college. Presented without the
    denominator it reads as "this is what we do" when it means "this is what
    we do, among the half of our output we can classify" -- and a director
    setting research priorities off the difference would be reading a
    conclusion the data cannot support.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    qs = _reports_queryset(user, year, department)
    rows = list(qs.values_list("subjects_json", "remuneration", "publication_year"))

    areas: dict[str, dict[str, Any]] = {}
    classified = 0
    for raw, amount, _pub_year in rows:
        parsed = _split_subjects(raw)
        if not parsed:
            continue
        classified += 1
        for area, quartile in parsed:
            slot = areas.setdefault(
                area,
                {"key": area, "count": 0, "amount": 0.0, "quartiles": {}},
            )
            # A paper counts once per area it belongs to, so the bars sum to
            # more than the number of papers. That is the honest shape of a
            # question about a multi-disciplinary body of work, and the
            # caption on the screen says so.
            slot["count"] += 1
            slot["amount"] += amount or 0
            if quartile:
                slot["quartiles"][quartile] = slot["quartiles"].get(quartile, 0) + 1

    ordered = sorted(areas.values(), key=lambda r: (-r["count"], r["key"]))
    total = len(rows)
    limit = max(1, min(int(limit), 200))

    return {
        "areas": [
            {**r, "amount": round(r["amount"], 2)} for r in ordered[:limit]
        ],
        "distinct": len(ordered),
        "shown": min(limit, len(ordered)),
        "coverage": {
            "classified": classified,
            "total": total,
            "unclassified": total - classified,
            "fraction": round(classified / total, 4) if total else 0,
        },
        "filters": {"year": year, "department": department},
        "years": sorted(
            {y for y in qs.values_list("publication_year", flat=True) if y}, reverse=True
        ),
    }


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


@api.get("/reports/search/export", auth=session_auth)
def search_export(
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
    fmt: str = "xlsx",
):
    """Exactly the rows on screen, as a file.

    The existing export takes a year, a department and a month, which is the
    monthly filing. It cannot express "Q1 Engineering papers in ECE that went
    unpaid", so anyone looking at that set had to rebuild it by hand in Excel
    after exporting something wider. Same filters as the query screen, same
    ordering, so the file matches what was being read.
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
    rows = qs.order_by(_SEARCH_SORTS.get(sort, "-updated_at"), "-id")[:5000]
    stem = "publications-" + (
        "-".join(
            str(v).replace(" ", "-")
            for v in [department, designation, publication_type, quartile, status, year, month]
            if v
        )
        or "all"
    )
    return _claims_file(rows, stem[:80], fmt)


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


# ---------- discussions ----------


class ThreadIn(Schema):
    title: str
    body: str
    visibility: str = "PUBLIC"
    #: DIRECT only: who is in the conversation, besides whoever opened it.
    #: This is the audience, not a notification list -- `visible_threads`
    #: reads these rows, which is what makes a direct thread private.
    participant_ids: list[str] = []
    department: Optional[str] = None
    topic: Optional[str] = None
    claim_id: Optional[str] = None
    journal_title: Optional[str] = None


class PostIn(Schema):
    body: str
    reply_to: Optional[str] = None


class PostEditIn(Schema):
    body: str


def _mention_dict(m: Mention) -> dict[str, Any]:
    return {
        "kind": m.kind,
        "label": m.label,
        "user_id": m.user_id,
        "user_name": m.user.name if m.user_id else None,
        "claim_id": m.claim_id,
        "ticket_number": m.claim.ticket_number if m.claim_id else None,
        "journal_title": m.journal_title,
        "department": m.department,
    }


def _post_dict(post: Post) -> dict[str, Any]:
    deleted = post.deleted_at is not None
    return {
        "id": post.id,
        "thread_id": post.thread_id,
        "kind": post.kind,
        # A deleted post leaves a tombstone rather than a hole: the replies
        # underneath it still have to make sense.
        "body": "" if deleted else post.body,
        "deleted": deleted,
        "author_id": post.author_id,
        "author_name": post.author.name if post.author_id else None,
        "reply_to": post.reply_to_id,
        "created_at": post.created_at.isoformat(),
        "edited_at": post.edited_at.isoformat() if post.edited_at else None,
        "mentions": [] if deleted else [_mention_dict(m) for m in post.mentions.all()],
    }


def _thread_dict(t: Thread, user: User) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title,
        "visibility": t.visibility,
        "department": t.department,
        "topic": t.topic,
        "claim_id": t.claim_id,
        "ticket_number": t.claim.ticket_number if t.claim_id else None,
        "journal_title": t.journal_title,
        "created_by": t.created_by.name if t.created_by_id else None,
        "created_by_id": t.created_by_id,
        "created_at": t.created_at.isoformat(),
        "last_post_at": t.last_post_at.isoformat(),
        "post_count": t.post_count,
        "resolved": t.resolved,
        "resolved_by": t.resolved_by.name if t.resolved_by_id else None,
        "locked": t.locked,
        "may_post": discussions.may_post(user, t),
        "may_moderate": discussions.may_moderate(user, t),
    }


def _write_post(thread: Thread, author: User | None, body: str, *, kind: str,
                reply_to: Post | None = None) -> Post:
    """One post, its mentions resolved, with the thread's counters moved."""
    post = Post.objects.create(
        thread=thread, author=author, body=body, kind=kind, reply_to=reply_to
    )
    for row in discussions.parse_mentions(body):
        Mention.objects.create(post=post, **row)
    Thread.objects.filter(pk=thread.pk).update(
        last_post_at=timezone.now(), post_count=models.F("post_count") + 1
    )
    thread.refresh_from_db()
    return post


def _notify_thread(thread: Thread, post: Post, actor: User) -> None:
    """Everybody mentioned, and everybody following, minus whoever wrote it.

    Mentions and subscriptions are gathered together and de-duplicated so
    being mentioned in a thread you already follow is one notification, not
    two -- and neither ever reaches the person who caused it.
    """
    recipients: set[str] = set()
    for m in post.mentions.filter(kind=Mention.Kind.USER).select_related("user"):
        if m.user_id and discussions.may_read(m.user, thread):
            recipients.add(m.user_id)
    for sub in thread.subscriptions.select_related("user").filter(muted=False):
        if discussions.may_read(sub.user, thread):
            recipients.add(sub.user_id)
    recipients.discard(actor.id)
    if not recipients:
        return

    excerpt = (post.body or "")[:200]
    for uid in recipients:
        Notification.objects.create(
            user_id=uid,
            title=f"{actor.name} in “{thread.title[:80]}”",
            body=excerpt,
            href=f"/discussions/{thread.id}",
        )


def _subscribe(thread: Thread, user: User | None) -> None:
    if user is None:
        return
    ThreadSubscription.objects.get_or_create(thread=thread, user=user)


@api.get("/threads", auth=session_auth)
def list_threads(
    request: HttpRequest,
    q: Optional[str] = None,
    topic: Optional[str] = None,
    visibility: Optional[str] = None,
    mine: bool = False,
    unresolved: bool = False,
    limit: int = 30,
    offset: int = 0,
):
    """Threads this account may see, most recently active first."""
    user = require_user(request)
    qs = discussions.visible_threads(user).select_related("created_by", "claim")

    if q:
        qs = qs.filter(Q(title__icontains=q.strip()) | Q(posts__body__icontains=q.strip())).distinct()
    if topic:
        qs = qs.filter(topic__iexact=topic)
    if visibility:
        qs = qs.filter(visibility=visibility)
    if mine:
        qs = qs.filter(
            Q(created_by=user) | Q(subscriptions__user=user) | Q(posts__author=user)
        ).distinct()
    if unresolved:
        qs = qs.filter(resolved=False)

    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    total = qs.count()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [_thread_dict(t, user) for t in qs[offset : offset + limit]],
        "visibilities": [
            {"key": v.value, "label": v.label} for v in Thread.Visibility
        ],
        "may_open_office": True,
    }


@api.post("/threads", auth=session_auth)
def create_thread(request: HttpRequest, payload: ThreadIn):
    """Open a thread. The first post is part of it, not a separate step."""
    user = require_user(request)
    title = (payload.title or "").strip()
    body = (payload.body or "").strip()
    if len(title) < 4:
        raise HttpError(400, "Give the thread a title somebody can recognise.")
    if not body:
        raise HttpError(400, "Say something in the first post.")

    refusal = discussions.check_visibility(
        user, payload.visibility, payload.department, payload.participant_ids
    )
    if refusal:
        raise HttpError(403 if "only" in refusal.lower() else 400, refusal)

    people: list[User] = []
    if payload.visibility == Thread.Visibility.DIRECT:
        wanted = {p for p in payload.participant_ids if p and p != user.id}
        people = list(User.objects.filter(pk__in=wanted, active=True))
        if len(people) != len(wanted):
            # Named somebody who is not here. Refused rather than quietly
            # dropped: a conversation silently missing the person it was for
            # is worse than one that failed to open.
            raise HttpError(404, "One of those people could not be found.")

    claim = None
    if payload.claim_id:
        claim = Claim.objects.filter(pk=payload.claim_id).first()
        if claim is None:
            raise HttpError(404, "No such paper")
        # Attaching a thread to somebody else's ticket would let a claimant
        # discover a paper they cannot otherwise see.
        if claim.owner_id != user.id and not rbac.can_view_reports(user.role):
            raise HttpError(403, "That paper is not yours to open a thread about.")

    with transaction.atomic():
        thread = Thread.objects.create(
            title=title,
            visibility=payload.visibility,
            department=(payload.department or "").strip() or None
            if payload.visibility == Thread.Visibility.DEPARTMENT
            else None,
            topic=(payload.topic or "").strip() or None,
            claim=claim,
            journal_title=(payload.journal_title or "").strip() or None,
            created_by=user,
            post_count=0,
        )
        if payload.visibility == Thread.Visibility.DIRECT:
            # Written inside the same transaction as the thread. A direct
            # thread that exists without its participant rows is readable by
            # nobody at all, including its author.
            ThreadParticipant.objects.bulk_create(
                [ThreadParticipant(thread=thread, user=u) for u in [user, *people]],
                ignore_conflicts=True,
            )
        post = _write_post(thread, user, body, kind=Post.Kind.HUMAN)
        _subscribe(thread, user)
        for u in people:
            _subscribe(thread, u)
        for m in post.mentions.filter(kind=Mention.Kind.USER):
            _subscribe(thread, m.user)

    _notify_thread(thread, post, user)
    _maybe_answer(thread, post, user)
    return _thread_dict(thread, user)


def _maybe_answer(thread: Thread, post: Post, asker: User) -> Post | None:
    """Let the assistant reply, if it was asked and it has something to say."""
    try:
        text = thread_agent.answer(post, asker)
    except Exception:
        logger.exception("thread_agent_failed post=%s", post.id)
        # A failing assistant must not lose somebody's message. The post is
        # already written; this is the only part that did not happen.
        return None
    if not text:
        return None
    return _write_post(thread, None, text, kind=Post.Kind.AGENT, reply_to=post)


@api.get("/threads/{thread_id}", auth=session_auth)
def get_thread(request: HttpRequest, thread_id: str):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")

    posts = (
        thread.posts.select_related("author")
        .prefetch_related("mentions__user", "mentions__claim")
        .order_by("created_at")
    )
    subscription = ThreadSubscription.objects.filter(thread=thread, user=user).first()
    if subscription:
        subscription.last_read_at = timezone.now()
        subscription.save(update_fields=["last_read_at"])

    return {
        **_thread_dict(thread, user),
        "posts": [_post_dict(p) for p in posts],
        "following": bool(subscription and not subscription.muted),
        "followers": thread.subscriptions.count(),
    }


@api.post("/threads/{thread_id}/posts", auth=session_auth)
def add_post(request: HttpRequest, thread_id: str, payload: PostIn):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")
    if thread.locked:
        raise HttpError(400, "This thread is closed to new posts.")
    body = (payload.body or "").strip()
    if not body:
        raise HttpError(400, "Say something.")

    reply_to = None
    if payload.reply_to:
        reply_to = thread.posts.filter(pk=payload.reply_to).first()

    with transaction.atomic():
        post = _write_post(thread, user, body, kind=Post.Kind.HUMAN, reply_to=reply_to)
        # Posting is taking an interest; so is being named.
        _subscribe(thread, user)
        for m in post.mentions.filter(kind=Mention.Kind.USER):
            _subscribe(thread, m.user)

    _notify_thread(thread, post, user)
    reply = _maybe_answer(thread, post, user)
    return {
        "post": _post_dict(post),
        "agent_reply": _post_dict(reply) if reply else None,
    }


@api.patch("/posts/{post_id}", auth=session_auth)
def edit_post(request: HttpRequest, post_id: str, payload: PostEditIn):
    """Your own words, and only yours. An edit is marked, never silent."""
    user = require_user(request)
    post = get_object_or_404(Post.objects.select_related("thread"), pk=post_id)
    if post.author_id != user.id:
        raise HttpError(403, "You can only edit your own posts.")
    if post.deleted_at:
        raise HttpError(400, "That post has been deleted.")
    body = (payload.body or "").strip()
    if not body:
        raise HttpError(400, "A post cannot be emptied — delete it instead.")

    with transaction.atomic():
        post.body = body
        post.edited_at = timezone.now()
        post.save(update_fields=["body", "edited_at"])
        # The mentions are part of the text, so they are rewritten with it.
        post.mentions.all().delete()
        for row in discussions.parse_mentions(body):
            Mention.objects.create(post=post, **row)

    return _post_dict(post)


@api.delete("/posts/{post_id}", auth=session_auth)
def delete_post(request: HttpRequest, post_id: str):
    user = require_user(request)
    post = get_object_or_404(Post.objects.select_related("thread"), pk=post_id)
    if post.author_id != user.id and not discussions.may_moderate(user, post.thread):
        raise HttpError(403, "You can only delete your own posts.")
    post.deleted_at = timezone.now()
    post.deleted_by = user
    post.save(update_fields=["deleted_at", "deleted_by"])
    AuditLog.objects.create(
        actor=user, action="POST_DELETE", entity="Post", entity_id=post.id,
        detail_json=json.dumps({"thread": post.thread_id}),
    )
    return {"ok": True}


@api.post("/threads/{thread_id}/subscribe", auth=session_auth)
def set_subscription(request: HttpRequest, thread_id: str, following: bool = True):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")
    sub, _ = ThreadSubscription.objects.get_or_create(thread=thread, user=user)
    # Muted rather than deleted: leaving a noisy thread should not lose the
    # record that you were in it.
    sub.muted = not following
    sub.save(update_fields=["muted"])
    return {"ok": True, "following": following}


@api.post("/threads/{thread_id}/resolve", auth=session_auth)
def resolve_thread(request: HttpRequest, thread_id: str, resolved: bool = True):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_moderate(user, thread):
        raise HttpError(403, "Only the office, or whoever opened it, can close a thread.")
    thread.resolved = resolved
    thread.resolved_by = user if resolved else None
    thread.resolved_at = timezone.now() if resolved else None
    thread.save(update_fields=["resolved", "resolved_by", "resolved_at"])
    return _thread_dict(thread, user)


@api.post("/threads/{thread_id}/lock", auth=session_auth)
def lock_thread(request: HttpRequest, thread_id: str, locked: bool = True):
    """Closed to new posts, still readable. Moderation, not deletion."""
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.is_office(user.role):
        raise HttpError(403, "Only the office can lock a thread.")
    thread.locked = locked
    thread.save(update_fields=["locked"])
    AuditLog.objects.create(
        actor=user, action="THREAD_LOCK", entity="Thread", entity_id=thread.id,
        detail_json=json.dumps({"locked": locked}),
    )
    return _thread_dict(thread, user)


@api.get("/mentions/search", auth=session_auth)
def search_mentions(request: HttpRequest, q: str = "", kind: Optional[str] = None):
    """What the @ autocomplete offers, scoped to what this account may see."""
    user = require_user(request)
    return {"results": discussions.mention_candidates(user, q, kind)}


# ---------- the calendar ----------


class EventIn(Schema):
    title: str
    kind: str = "OTHER"
    starts_on: str
    ends_on: Optional[str] = None
    description: Optional[str] = None
    visibility: str = "PUBLIC"
    department: Optional[str] = None
    thread_id: Optional[str] = None
    claim_id: Optional[str] = None


def _event_dict(e: CalendarEvent) -> dict[str, Any]:
    return {
        "id": e.id,
        "title": e.title,
        "kind": e.kind,
        "kind_label": CalendarEvent.Kind(e.kind).label,
        "starts_on": e.starts_on.isoformat(),
        "ends_on": e.ends_on.isoformat() if e.ends_on else None,
        "description": e.description,
        "visibility": e.visibility,
        "department": e.department,
        "thread_id": e.thread_id,
        "claim_id": e.claim_id,
        "created_by": e.created_by.name if e.created_by_id else None,
        "created_by_id": e.created_by_id,
    }


def _visible_events(user: User):
    """Same three-way rule as a thread, applied to a date."""
    condition = Q(visibility=Thread.Visibility.PUBLIC)
    department = (getattr(user, "department", "") or "").strip()
    if department:
        condition |= Q(
            visibility=Thread.Visibility.DEPARTMENT, department__iexact=department
        )
    if discussions.is_office(user.role):
        # Same reasoning as `discussions.visible_threads`: the office reads
        # everything, or an event and the thread it came out of disagree
        # about who may see them.
        condition |= Q(visibility=Thread.Visibility.OFFICE)
        condition |= Q(visibility=Thread.Visibility.DEPARTMENT)
    else:
        condition |= Q(visibility=Thread.Visibility.OFFICE, created_by=user)
    return CalendarEvent.objects.filter(condition)


@api.get("/calendar", auth=session_auth)
def list_events(
    request: HttpRequest,
    start: Optional[str] = None,
    end: Optional[str] = None,
    kind: Optional[str] = None,
):
    """Everything with a date on it, in a window.

    Defaults to a span around today rather than to everything: a calendar
    that opens on four years of history is a calendar nobody scrolls.
    """
    user = require_user(request)
    qs = _visible_events(user).select_related("created_by")

    today = timezone.now().date()
    try:
        first = date.fromisoformat(start) if start else today - timedelta(days=30)
        last = date.fromisoformat(end) if end else today + timedelta(days=120)
    except ValueError:
        raise HttpError(400, "Dates must look like 2026-03-01")
    if last < first:
        raise HttpError(400, "The end of the window is before its start")

    # An event overlaps the window if it starts before the end of it and has
    # not already finished. A span is not just its first day.
    qs = qs.filter(starts_on__lte=last).filter(
        Q(ends_on__isnull=True, starts_on__gte=first) | Q(ends_on__gte=first)
    )
    if kind:
        qs = qs.filter(kind=kind)

    return {
        "start": first.isoformat(),
        "end": last.isoformat(),
        "results": [_event_dict(e) for e in qs],
        "kinds": [{"key": k.value, "label": k.label} for k in CalendarEvent.Kind],
    }


@api.post("/calendar", auth=session_auth)
def create_event(request: HttpRequest, payload: EventIn):
    user = require_user(request)
    title = (payload.title or "").strip()
    if len(title) < 3:
        raise HttpError(400, "Give the event a title.")
    if payload.kind not in CalendarEvent.Kind.values:
        raise HttpError(400, f"Kind must be one of: {', '.join(CalendarEvent.Kind.values)}.")

    refusal = discussions.check_visibility(user, payload.visibility, payload.department)
    if refusal:
        raise HttpError(403 if "only" in refusal.lower() else 400, refusal)

    try:
        starts = date.fromisoformat(payload.starts_on)
        ends = date.fromisoformat(payload.ends_on) if payload.ends_on else None
    except (TypeError, ValueError):
        raise HttpError(400, "Dates must look like 2026-03-01")
    if ends and ends < starts:
        raise HttpError(400, "It cannot end before it starts.")

    thread = Thread.objects.filter(pk=payload.thread_id).first() if payload.thread_id else None
    if thread and not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")

    event = CalendarEvent.objects.create(
        title=title,
        kind=payload.kind,
        starts_on=starts,
        ends_on=ends,
        description=(payload.description or "").strip() or None,
        visibility=payload.visibility,
        department=(payload.department or "").strip() or None
        if payload.visibility == Thread.Visibility.DEPARTMENT
        else None,
        thread=thread,
        claim=Claim.objects.filter(pk=payload.claim_id).first() if payload.claim_id else None,
        created_by=user,
    )

    # An event that came out of a thread is recorded in it, so the decision
    # and the date do not live in two places that can disagree.
    if thread:
        _write_post(
            thread, None,
            f"📅 **{title}** — {starts.isoformat()}"
            + (f" to {ends.isoformat()}" if ends else ""),
            kind=Post.Kind.SYSTEM,
        )

    return _event_dict(event)


@api.patch("/calendar/{event_id}", auth=session_auth)
def update_event(request: HttpRequest, event_id: str, payload: EventIn):
    user = require_user(request)
    event = get_object_or_404(CalendarEvent, pk=event_id)
    if event.created_by_id != user.id and not discussions.is_office(user.role):
        raise HttpError(403, "Only the office, or whoever added it, can change an event.")
    try:
        event.starts_on = date.fromisoformat(payload.starts_on)
        event.ends_on = date.fromisoformat(payload.ends_on) if payload.ends_on else None
    except (TypeError, ValueError):
        raise HttpError(400, "Dates must look like 2026-03-01")
    if event.ends_on and event.ends_on < event.starts_on:
        raise HttpError(400, "It cannot end before it starts.")
    event.title = (payload.title or event.title).strip()
    event.kind = payload.kind
    event.description = (payload.description or "").strip() or None
    event.save()
    return _event_dict(event)


@api.delete("/calendar/{event_id}", auth=session_auth)
def delete_event(request: HttpRequest, event_id: str):
    user = require_user(request)
    event = get_object_or_404(CalendarEvent, pk=event_id)
    if event.created_by_id != user.id and not discussions.is_office(user.role):
        raise HttpError(403, "Only the office, or whoever added it, can remove an event.")
    event.delete()
    return {"ok": True}


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
    # Every ticket row carries its remuneration.
    _refuse_hod_money_screens(user)
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

    # A slot belongs to the year that issued it, so `Claim.save` drops it when
    # the year is corrected. Nothing then handed the paper one in its new
    # year: `_assign_quota_position` runs at submission and this paper was
    # submitted long ago, so it sat in the new year unnumbered, counting
    # against nobody's quota and taking a slot from nobody. Only a paper that
    # actually held one gets a new one -- a draft still consumes no allowance.
    held_a_slot = field == "publication_year" and claim.quota_position is not None

    setattr(claim, field, value)
    claim.save(update_fields=[field, "updated_at"])
    if held_a_slot and claim.quota_position is None:
        _assign_quota_position(claim)

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


# ---------- removing rows, and emptying the system ----------

#: Tables that can never be deleted from, whatever the caller says.
#: The audit log is the record of who did what, including of a wipe, and a
#: wipe that erases its own trace is not something this system will do.
UNDELETABLE = {"AuditLog"}

#: Tables whose rows are the evidence that money moved.
MONEY_TABLES = {"PaidLedger", "PriorPayment", "MonthlyBatch"}


def _deletion_guard(user: User, table_name: str) -> None:
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may delete records here.")
    if table_name in UNDELETABLE:
        raise HttpError(
            400,
            "The audit log cannot be deleted from. It is the record of who "
            "changed what, and a system that can erase its own trail cannot "
            "be relied on for anything else it says.",
        )


def _refuses_because_paid(instance) -> str | None:
    """Why this row must stay, or None if it may go.

    Judged on everything the delete would take, not on the row that was named.
    Those are different questions, and answering the easy one was a hole: a
    claim that has been paid is refused, but `Claim.owner` cascades, so
    deleting the *account* took 113 paid publications with it and never
    reached this check at all — the row being deleted was a User, and a User
    has no status and is not a money table. The largest account on the live
    database would have taken ₹398,204 of settled payments out of the record
    with one call and left an audit entry reading "deleted one user".
    """
    from django.db import router
    from django.db.models.deletion import Collector

    collector = Collector(using=router.db_for_write(instance.__class__))
    try:
        collector.collect([instance])
    except Exception:
        # Nothing here is worth a 500. If the cascade cannot be worked out,
        # fall back to judging the row itself, which is what this did before.
        collected = {instance.__class__: [instance]}
    else:
        collected = collector.data

    paid = 0
    money = set()
    for model, objects in collected.items():
        name = model.__name__
        if name in MONEY_TABLES:
            money.add(name)
        if name == "Claim":
            paid += sum(1 for o in objects if getattr(o, "status", None) == ClaimStatus.PAID)

    if paid and not isinstance(instance, Claim):
        return (
            f"Deleting this would also remove {paid} publication"
            f"{'s' if paid != 1 else ''} that {'have' if paid != 1 else 'has'} "
            "been paid, because they belong to it. That is the record of money "
            "that really left the account. Deactivate it instead — the account "
            "stops working and everything it did stays on the record."
        )
    if paid:
        return (
            "This publication has been paid. Deleting it removes the record of "
            "a payment that really happened — void the payment first if it was "
            "made in error, which keeps the reversal on the ledger."
        )
    if money:
        return (
            "This row is part of the payment record. It is what the college "
            "would show if anybody asked why money left the account."
        )
    return None


class DeleteRowIn(Schema):
    reason: str


# "/admin/data/{table}/row/{id}" rather than "/admin/data/{table}/{id}":
# the second shape matches "/admin/data/Claim/export" too, and because this
# operation is registered first the export answered 405. The same trap is
# documented on the reset-password route below.
@api.delete("/admin/data/{table_name}/row/{row_id}", auth=session_auth)
def data_delete_row(
    request: HttpRequest, table_name: str, row_id: str, payload: DeleteRowIn
):
    """Remove one row, with the reason recorded and the money protected."""
    user = require_user(request)
    _deletion_guard(user, table_name)

    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Say why this is being deleted, in a sentence.")

    instance = get_object_or_404(model, pk=row_id)
    refusal = _refuses_because_paid(instance)
    if refusal:
        raise HttpError(400, refusal)
    if isinstance(instance, User) and instance.id == user.id:
        raise HttpError(400, "You cannot delete the account you are signed in as.")

    described = str(instance)[:200]
    # Written before the delete: afterwards there is no row to describe, and
    # an audit entry that cannot say what went is not much of a record.
    AuditLog.objects.create(
        actor=user, action="DATA_DELETE", entity=table.model_name,
        entity_id=str(row_id),
        detail_json=json.dumps({"was": described, "reason": reason}),
    )
    instance.delete()
    return {"ok": True, "deleted": described}


class WipeIn(Schema):
    #: The exact phrase, typed out. Nothing else is accepted.
    confirm: str
    reason: str
    #: What the caller was told would go. A mismatch means the system changed
    #: under them between reading and confirming, and the wipe is refused.
    expect_rows: Optional[int] = None
    #: Required separately when settled payments are present.
    i_understand_payments_will_be_lost: bool = False


#: What a wipe empties, in the order a foreign key will tolerate.
WIPE_ORDER = [
    "ClaimAttachment", "ClaimAction", "Notification", "DuplicateFinding",
    "PaidLedger", "Claim", "PriorPayment", "MonthlyBatch",
]

WIPE_PHRASE = "DELETE EVERYTHING"


def _wipe_counts() -> dict[str, int]:
    out: dict[str, int] = {}
    for name in WIPE_ORDER:
        model = explorer.model_for(name)
        if model is not None:
            out[name] = model.objects.count()
    return out


@api.get("/admin/wipe/preview", auth=session_auth)
def wipe_preview(request: HttpRequest):
    """What a wipe would remove, before anybody types the words."""
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may see this.")
    counts = _wipe_counts()
    paid = Claim.objects.filter(status=ClaimStatus.PAID).count()
    paid_amount = (
        Claim.objects.filter(status=ClaimStatus.PAID).aggregate(
            s=Sum("remuneration")
        )["s"]
        or 0
    )
    return {
        "counts": counts,
        "total_rows": sum(counts.values()),
        "paid_claims": paid,
        "paid_amount": round(paid_amount, 2),
        "phrase": WIPE_PHRASE,
        # Said plainly rather than left for the dialog to word.
        "kept": [
            "Accounts and roles — everybody keeps their login",
            "The audit log, including this wipe",
            "Journal reference data and the payout formula",
        ],
    }


@api.post("/admin/wipe", auth=session_auth)
def wipe_everything(request: HttpRequest, payload: WipeIn):
    """Empty the publication and payment tables. Accounts and audit survive.

    Every guard here exists because the alternative is losing 2.76 crore of
    payment history to a mis-click.
    """
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may do this.")

    if (payload.confirm or "").strip() != WIPE_PHRASE:
        raise HttpError(400, f'Type "{WIPE_PHRASE}" exactly to confirm.')
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Say why the system is being emptied, in a sentence.")

    counts = _wipe_counts()
    total = sum(counts.values())
    if payload.expect_rows is not None and payload.expect_rows != total:
        raise HttpError(
            409,
            f"The system now holds {total:,} rows, not the {payload.expect_rows:,} "
            "you were shown. Something changed while you were reading — look "
            "again before confirming.",
        )

    paid = Claim.objects.filter(status=ClaimStatus.PAID).count()
    if paid and not payload.i_understand_payments_will_be_lost:
        raise HttpError(
            400,
            f"This system holds {paid:,} settled payments. Emptying it destroys "
            "the record that they were made. Confirm that separately if it is "
            "genuinely what you want.",
        )

    # Recorded first: the log survives the wipe on purpose, and an entry
    # written afterwards would be missing if the delete failed halfway.
    AuditLog.objects.create(
        actor=user, action="SYSTEM_WIPE", entity="System", entity_id="all",
        detail_json=json.dumps({"counts": counts, "total": total, "reason": reason}),
    )

    removed: dict[str, int] = {}
    with transaction.atomic():
        for name in WIPE_ORDER:
            model = explorer.model_for(name)
            if model is None:
                continue
            n, _ = model.objects.all().delete()
            removed[name] = counts.get(name, 0)

    return {"ok": True, "removed": removed, "total": total}


# ---------- who has worked with whom ----------


def _paper_key(claim) -> tuple[str, str] | None:
    """What makes two claims the same paper.

    The same rule the duplicate sweep uses, and for the same reason: a DOI is
    definitive where it exists, and a normalised title is what is left when it
    does not.
    """
    doi = normalize_doi(claim.doi) if claim.doi else None
    if doi:
        return ("doi", doi)
    title = normalize_title(claim.paper_title or "")
    return ("title", title) if title else None


def _collaboration_index(scope):
    """One pass over the claims, producing everything the graph needs.

    Returns:
      partners  person -> {person: papers written together}
      journals  person -> {journal titles they publish in}
      papers    person -> how many publications on record
    """
    from collections import defaultdict

    by_paper: dict[tuple[str, str], set[str]] = defaultdict(set)
    journals: dict[str, set[str]] = defaultdict(set)
    papers: dict[str, int] = defaultdict(int)

    for claim in scope.only(
        "id", "owner_id", "doi", "paper_title", "journal_title"
    ).iterator(chunk_size=2000):
        if not claim.owner_id:
            continue
        papers[claim.owner_id] += 1
        if claim.journal_title:
            journals[claim.owner_id].add(claim.journal_title.strip().lower())
        key = _paper_key(claim)
        if key:
            by_paper[key].add(claim.owner_id)

    partners: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for people in by_paper.values():
        if len(people) < 2:
            continue
        ordered = sorted(people)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1 :]:
                partners[a][b] += 1
                partners[b][a] += 1

    return partners, journals, papers


def _person_brief(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "name": user.name or user.email,
        "department": user.department or "",
        "designation": user.designation or "",
    }


@api.get("/collaborate/me", auth=session_auth)
def my_collaborators(request: HttpRequest, limit: int = 12):
    """The people you have written with, and the ones you might.

    Carries no money: it is open to heads of department, and this is not a
    payment screen for anybody.
    """
    me = require_user(request)
    scope = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    partners, journals, papers = _collaboration_index(scope)

    mine = partners.get(me.id, {})
    my_journals = journals.get(me.id, set())

    people = {
        u.id: u
        for u in User.objects.filter(active=True).only(
            "id", "name", "email", "department", "designation"
        )
    }

    worked_with = sorted(
        (
            {**_person_brief(people[pid]), "together": n, "papers": papers.get(pid, 0)}
            for pid, n in mine.items()
            if pid in people
        ),
        key=lambda r: -r["together"],
    )

    # A suggestion has to be explainable in one sentence or nobody acts on it,
    # so the reason is computed alongside the score rather than inferred from
    # it afterwards.
    suggestions = []
    for pid, their_journals in journals.items():
        if pid == me.id or pid in mine or pid not in people:
            continue
        shared = my_journals & their_journals
        if not shared:
            continue
        person = people[pid]
        # Somebody in another department publishing in your journals is a more
        # interesting introduction than the colleague at the next desk, who
        # you already know.
        cross = person.department and person.department != me.department
        suggestions.append(
            {
                **_person_brief(person),
                "papers": papers.get(pid, 0),
                "shared_journals": sorted(shared)[:3],
                "shared_count": len(shared),
                "cross_department": bool(cross),
                "why": (
                    f"Publishes in {len(shared)} journal"
                    f"{'s' if len(shared) > 1 else ''} you publish in"
                    + (f", in {person.department}" if cross else "")
                ),
                "score": len(shared) * 2 + (1 if cross else 0),
            }
        )
    suggestions.sort(key=lambda r: (-r["score"], -r["papers"]))

    return {
        "me": _person_brief(me),
        "papers": papers.get(me.id, 0),
        "worked_with": worked_with[: max(1, min(limit, 50))],
        "suggestions": suggestions[: max(1, min(limit, 50))],
        # Said plainly on the screen, because a graph nobody can account for
        # is a graph nobody trusts.
        "derived_from": (
            "Two people who filed a claim for the same paper are counted as "
            "co-authors. Nothing here was entered by hand."
        ),
    }


@api.get("/collaborate/graph", auth=session_auth)
def collaboration_graph(
    request: HttpRequest, department: Optional[str] = None, limit: int = 150
):
    """The network, for drawing.

    Capped, and it says what it dropped. A force-directed graph of every
    connected person is a hairball nobody can read.
    """
    user = require_user(request)
    if user.role == Role.HOD:
        department = hod.department_of(user)

    scope = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    partners, _journals, papers = _collaboration_index(scope)

    people = {
        u.id: u
        for u in User.objects.filter(active=True).only(
            "id", "name", "email", "department", "designation"
        )
    }
    if department:
        people = {i: u for i, u in people.items() if u.department == department}

    connected = [pid for pid in partners if pid in people and partners[pid]]
    connected.sort(key=lambda pid: -len(partners[pid]))
    shown = set(connected[: max(1, min(limit, 400))])

    nodes = [
        {
            **_person_brief(people[pid]),
            "papers": papers.get(pid, 0),
            "degree": len([o for o in partners[pid] if o in shown]),
        }
        for pid in shown
    ]
    seen: set[tuple[str, str]] = set()
    links = []
    for a in shown:
        for b, n in partners[a].items():
            if b not in shown:
                continue
            pair = (a, b) if a < b else (b, a)
            if pair in seen:
                continue
            seen.add(pair)
            links.append({"source": pair[0], "target": pair[1], "papers": n})

    return {
        "nodes": nodes,
        "links": links,
        "department": department,
        "hidden": max(0, len(connected) - len(shown)),
    }


# ---------- what to write next, and where to send it ----------
#
# The only part of this system that is any use *before* a paper exists.
# Everything else deals with work already done.
#
# The rule throughout: the model proposes, the database disposes. Gemini names
# journals; those names are resolved against our own Scimago and SNIP rows and
# only what resolves carries a quartile or an amount. See services/discover.py.


class VenueIn(Schema):
    title: str
    abstract: Optional[str] = None
    keywords: Optional[str] = None
    #: The position being considered, since the payout depends on it and
    #: nobody knows the eventual author order while choosing a venue.
    author_position: int = 1
    total_authors: int = 1


class InterestsIn(Schema):
    domains: list[str]


@api.get("/discover/status", auth=session_auth)
def discover_status(request: HttpRequest):
    """Whether the discovery features can run at all.

    The screen asks before offering, so that an unconfigured deployment says
    "this is switched off" rather than presenting a button that always fails.
    """
    require_user(request)
    # More than a boolean, because "off" covers three different situations
    # with three different remedies: no service, a service with the model
    # missing, or a provider name nobody recognises. A screen that cannot tell
    # them apart can only shrug at somebody who could have fixed it.
    state = ai.health()
    return {
        "available": bool(state.get("ready")),
        "model": state.get("model") or "",
        "provider": state.get("provider"),
        "code": state.get("code"),
        "detail": state.get("detail"),
        "base_url": state.get("base_url"),
    }


@api.get("/meta/research-domains", auth=session_auth)
def research_domains(request: HttpRequest, q: str = "", limit: int = 40):
    """The subject vocabulary, taken from our own journal data.

    302 categories that journals in our dataset are actually classified under,
    rather than a list somebody typed. A domain outside this vocabulary cannot
    be matched against anything later.
    """
    require_user(request)
    return {"domains": discover_service.research_domains(q, limit)}


@api.get("/me/interests", auth=session_auth)
def my_interests(request: HttpRequest):
    user = require_user(request)
    return {
        "domains": list(
            ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
        )
    }


@api.put("/me/interests", auth=session_auth)
def set_my_interests(request: HttpRequest, payload: InterestsIn):
    """Replace the whole set.

    A whole-set write rather than add and remove endpoints: the screen is a
    multi-select, and two round trips per tick would make it feel slow and
    leave it half-applied if one of them failed.
    """
    user = require_user(request)
    wanted = []
    for raw in payload.domains[:20]:
        name = (raw or "").strip()
        if name and name not in wanted:
            wanted.append(name)

    with transaction.atomic():
        ResearchInterest.objects.filter(user=user).exclude(domain__in=wanted).delete()
        existing = set(
            ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
        )
        ResearchInterest.objects.bulk_create(
            [ResearchInterest(user=user, domain=d) for d in wanted if d not in existing],
            ignore_conflicts=True,
        )
    return {"domains": wanted}


@api.post("/discover/venues", auth=session_auth)
def discover_venues(request: HttpRequest, payload: VenueIn):
    """Where this paper could go, and what each venue would pay.

    Note what is returned separately: journals we could verify, and names we
    could not. The unverified ones still appear -- the model may be right and
    the journal simply absent from a 2025 dump -- but they carry no quartile
    and no amount, because attaching a number to a journal we cannot identify
    is how somebody ends up submitting to a venue that does not exist.
    """
    # Every suggested journal comes back with the rupee figure the policy would
    # pay for it. /discover/reprice and /research/search return the same kind of
    # figure and are both guarded; this one, which is where the figure is first
    # produced, was not.
    user = _require_may_see_money(request)
    title = (payload.title or "").strip()
    if len(title) < 8:
        raise HttpError(400, "Give the paper's title so there is something to go on")

    state = ai.health()
    if not state.get("ready"):
        # 503 with the reason attached. "Switched off" was the only thing this
        # ever said, and it is wrong for two of the three ways it happens --
        # the service being down and the model not being pulled are both
        # things somebody can fix in one command.
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")

    try:
        result = discover_service.suggest_venues(
            title=title,
            abstract=(payload.abstract or "").strip(),
            keywords=(payload.keywords or "").strip(),
            author_position=max(1, payload.author_position),
            total_authors=max(1, payload.total_authors),
        )
    except ai.AIError as exc:
        raise HttpError(_ai_failure_status(exc), str(exc)) from exc

    _log_venue_search(user, title, result)
    return result


def _ai_failure_status(exc: ai.AIError) -> int:
    """Which of the two ways this was not the reader's fault.

    A missing model is configuration, not a bad gateway. Answering 502 for it
    sends somebody looking for a network fault that is not there, when the fix
    is one `ollama pull` on the machine it runs on.
    """
    return 503 if exc.code in ("model_missing", "unreachable", "misconfigured") else 502


def _log_venue_search(user: User, title: str, result: dict[str, Any]) -> None:
    AuditLog.objects.create(
        actor=user,
        action="DISCOVER_VENUES",
        entity="Claim",
        entity_id="",
        detail_json=json.dumps({"title": title[:300], "verified": len(result["journals"])}),
    )


def _ndjson(obj: dict[str, Any]) -> bytes:
    """One JSON object, one line.

    NDJSON rather than Server-Sent Events because this is a POST with a body
    and `EventSource` cannot make one, so the client is a `fetch` reader
    either way -- and once it is, splitting on newlines is less to get wrong
    than parsing the SSE framing by hand.
    """
    return (json.dumps(obj, default=str) + "\n").encode("utf-8")


@api.post("/discover/venues/stream", auth=session_auth)
def discover_venues_stream(request: HttpRequest, payload: VenueIn):
    """The same answer as `/discover/venues`, with the wait made visible.

    The model runs on this server's CPU at about four and a half tokens a
    second, so this request takes a minute and a half and there is nothing
    anybody can do to make it take less. What was wrong was not the ninety
    seconds; it was that the screen said "Searching..." for all of them and
    offered no way out, so a request that was working looked like one that
    had hung, and the only remedy anybody had was to reload the page --
    which left the model generating an answer no longer going anywhere.

    So: the same result, preceded by the model saying where it has got to,
    and stoppable for real -- see `/discover/venues/cancel`, which exists
    because a dropped connection turned out not to be something this server
    notices.

    Everything that can be refused is refused before the first byte, because
    after that the status is 200 and a failure has to be carried in the body
    instead. What is left -- the model failing part way through -- arrives as
    an `error` event carrying the status it would have been.
    """
    user = _require_may_see_money(request)
    title = (payload.title or "").strip()
    if len(title) < 8:
        raise HttpError(400, "Give the paper's title so there is something to go on")

    state = ai.health()
    if not state.get("ready"):
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")

    # Named so it can be stopped. Prefixed with the reader's own id so the
    # endpoint that stops it can check that it is theirs to stop, and random
    # in the rest so it is not somebody else's to guess.
    token = f"{user.pk}:{uuid_lib.uuid4()}"

    def events():
        started = time.monotonic()
        phase = "connecting"

        def since() -> float:
            return round(time.monotonic() - started, 1)

        # Sent immediately, so the screen has a clock and an expectation
        # before the model has done anything at all. A wait somebody was told
        # about in advance is a different experience from the same wait
        # discovered halfway through.
        yield _ndjson(
            {
                "event": "start",
                "token": token,
                "model": state.get("model") or "",
                "expected_seconds": ai.EXPECTED_SECONDS,
                "expected_tokens": ai.EXPECTED_TOKENS,
            }
        )

        for kind, value in ai.run_with_progress(
            discover_service.suggest_venues,
            {
                "title": title,
                "abstract": (payload.abstract or "").strip(),
                "keywords": (payload.keywords or "").strip(),
                "author_position": max(1, payload.author_position),
                "total_authors": max(1, payload.total_authors),
            },
            token=token,
        ):
            if kind == "step":
                phase = value.get("phase") or phase
                yield _ndjson({"event": "step", "elapsed": since(), **value})
            elif kind == "tick":
                # Nothing new, said once a second anyway, because the first
                # eight seconds of a cold search produce no tokens at all and
                # a counter that has not moved since the button was pressed
                # is the thing this endpoint exists to stop showing.
                yield _ndjson({"event": "tick", "phase": phase, "elapsed": since()})
            elif kind == "cancelled":
                yield _ndjson({"event": "cancelled", "elapsed": since()})
            elif kind == "error":
                yield _ndjson(
                    {
                        "event": "error",
                        "status": _ai_failure_status(value),
                        "code": value.code,
                        "detail": str(value),
                        "elapsed": since(),
                    }
                )
            elif kind == "result":
                # Logged here rather than in the worker, on the request's own
                # database connection, and only for a search somebody stayed
                # for. The unverified names are not counted: the audit trail
                # records what the database agreed to, which is the same
                # split the screen shows.
                _log_venue_search(user, title, value)
                yield _ndjson({"event": "result", "elapsed": since(), "data": value})

    response = StreamingHttpResponse(events(), content_type="application/x-ndjson")
    # Nothing between here and the browser may hold this back waiting for a
    # complete body -- buffering a progress stream turns it back into the
    # silence it exists to replace.
    response["Cache-Control"] = "no-cache, no-store, no-transform"
    response["X-Accel-Buffering"] = "no"
    return response


class CancelIn(Schema):
    #: The token the `start` event of a venue stream carried.
    token: str


@api.post("/discover/venues/cancel", auth=session_auth)
def discover_venues_cancel(request: HttpRequest, payload: CancelIn):
    """Stop a search somebody has given up on.

    A separate request rather than an inference from the stream's connection
    dropping, because that inference does not hold. Measured on this server:
    a client closing a streaming connection mid-answer was never noticed --
    the writes into the dead socket went on succeeding -- and the model spent
    another eighty-eight seconds finishing an answer with nowhere to go, on
    the four cores the next reader was waiting for. A cancel button that only
    stops the spinner is not a cancel button.

    Answering whether it found the run is deliberate. With more than one
    worker process the request can land on a worker that never had it, and
    saying so is better than an empty 200 that implies something happened.
    """
    user = require_user(request)
    # A token names one reader's own search. Somebody else's is not theirs to
    # stop, and the prefix is checked rather than trusted because a cancel is
    # a write, however small.
    if not payload.token.startswith(f"{user.pk}:"):
        raise HttpError(403, "That search is not yours to stop.")
    return {"stopped": ai.stop(payload.token)}


class RepriceIn(Schema):
    #: ISSNs from journals `/discover/venues` already resolved.
    issns: list[str]
    author_position: int = 1
    total_authors: int = 1


@api.get("/trends/me", auth=session_auth)
def trends_me(request: HttpRequest, limit: int = 12, people_limit: int = 8):
    """What this college is working on, and who to work with.

    Deliberately `require_user` and not `_require_may_see_money`: there is no
    rupee figure anywhere in this payload, and locking a head of department
    out of a money-free picture of their own institution would be the wrong
    call. Both halves go through `hod.without_money` on the way out anyway, so
    a field named `amount` added here later cannot leak one.

    Never answers 503. It needs no model -- the measured half is the half that
    must always work.
    """
    user = require_user(request)
    return trends.overview(
        user,
        limit=max(1, min(int(limit), 30)),
        people_limit=max(1, min(int(people_limit), 25)),
    )


@api.get("/trends/openings", auth=session_auth)
def trends_openings(request: HttpRequest):
    """The part a model wrote, kept behind its own request.

    Separate from `/trends/me` on purpose. The measured picture answers in
    milliseconds; this takes a couple of minutes on a CPU, and putting them in
    one response would make the fast half wait for the slow one.
    """
    user = require_user(request)
    state = ai.health()
    if not state.get("ready"):
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")
    try:
        return trends.suggest_openings(user=user)
    except ai.AIError as exc:
        raise HttpError(_ai_failure_status(exc), str(exc)) from exc


@api.get("/programme/me", auth=session_auth)
def programme_me(request: HttpRequest, limit: int = 12):
    """The research picture around one person: their areas, and who else is in them.

    Everything here is derived from data the college already holds, and none of
    it needs a model or a key. That is deliberate. The AI features switch off
    when the credits run out; "what is my department publishing and who should
    I talk to" is too useful to switch off with them.

    The three questions it answers, in the order somebody asks them:

    - what do I work on? -- taken from the subject areas of papers they have
      actually filed, not from a profile they filled in once and never revised;
    - who else works on it? -- colleagues with papers in the same areas, most
      overlap first, excluding the person themselves;
    - what is happening in it right now? -- the most recent papers filed in
      those areas by anybody, so a new arrival can see the live front rather
      than a historical total.

    No money anywhere in the payload. A faculty member may see their own
    amounts and nobody else's, and this endpoint is about other people --
    including it would leak a colleague's payout through the back door.
    """
    user = require_user(request)
    limit = max(1, min(int(limit), 50))

    mine = Claim.objects.filter(owner=user).exclude(status=ClaimStatus.DRAFT)

    # ---- my areas, from what I have actually published --------------------
    my_areas: dict[str, int] = {}
    for raw in mine.values_list("subjects_json", flat=True):
        for area, _q in _split_subjects(raw):
            my_areas[area] = my_areas.get(area, 0) + 1
    ranked_areas = sorted(my_areas.items(), key=lambda kv: -kv[1])
    top_areas = [a for a, _n in ranked_areas[:8]]

    stated = list(
        ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
    )

    # Interests a person stated but has not published in are still theirs, and
    # are what a new arrival with no papers has instead of an area list.
    search_terms = top_areas[:4] or stated[:4]

    colleagues: list[dict[str, Any]] = []
    live: list[dict[str, Any]] = []

    if top_areas:
        # One pass over other people's papers, matched on area. Done in Python
        # rather than SQL because the areas live in a semicolon-separated
        # column that no index can help with -- and the alternative, a LIKE per
        # area, is eight table scans instead of one.
        wanted = set(top_areas)
        others = (
            Claim.objects.exclude(owner=user)
            .exclude(status=ClaimStatus.DRAFT)
            .exclude(subjects_json__isnull=True)
            .exclude(subjects_json="")
            .select_related("owner")
            .order_by("-publication_year", "-created_at")
        )
        people: dict[str, dict[str, Any]] = {}
        for claim in others[:4000]:
            areas = {a for a, _q in _split_subjects(claim.subjects_json)}
            shared = areas & wanted
            if not shared:
                continue
            if len(live) < limit:
                live.append({
                    "id": claim.id,
                    "paper_title": claim.paper_title,
                    "journal_title": claim.journal_title,
                    "publication_year": claim.publication_year,
                    "quartile": claim.quartile,
                    "owner_id": claim.owner_id,
                    "owner_name": claim.owner.name if claim.owner_id else None,
                    "owner_department": claim.owner.department if claim.owner_id else None,
                    "areas": sorted(shared),
                })
            slot = people.setdefault(
                claim.owner_id,
                {
                    "id": claim.owner_id,
                    "name": claim.owner.name if claim.owner_id else "Unknown",
                    "department": claim.owner.department if claim.owner_id else None,
                    "designation": claim.owner.designation if claim.owner_id else None,
                    "papers": 0,
                    "areas": set(),
                },
            )
            slot["papers"] += 1
            slot["areas"] |= shared
        colleagues = sorted(
            (
                {**v, "areas": sorted(v["areas"]), "shared": len(v["areas"])}
                for v in people.values()
            ),
            key=lambda r: (-r["shared"], -r["papers"]),
        )[:limit]

    return {
        "areas": [{"key": a, "count": n} for a, n in ranked_areas[:12]],
        "interests": stated,
        "search_terms": search_terms,
        "colleagues": colleagues,
        "live": live,
        "totals": {
            "my_papers": mine.count(),
            "my_areas": len(ranked_areas),
            "colleagues": len(colleagues),
        },
        # Said on screen, because an empty programme page looks broken and is
        # usually just somebody whose journals we could not classify.
        "classified": mine.exclude(subjects_json__isnull=True)
        .exclude(subjects_json="")
        .count(),
    }


@api.get("/research/search", auth=session_auth)
def research_search_endpoint(
    request: HttpRequest,
    q: str = "",
    limit: int = 20,
    sources: Optional[str] = None,
    author_position: int = 1,
    total_authors: int = 1,
):
    """Search the scholarly record, and price what you find.

    Deliberately needs no model and no key: the AI features degrade to
    "switched off" without credits, and this does not. Somebody can still find
    what is being published in their field, and what it would be worth to them,
    with no AI involved at all.
    """
    _require_may_see_money(request)
    picked = [s.strip() for s in (sources or "").split(",") if s.strip()] or None
    return research_search.search(
        q,
        limit=max(1, min(limit, 50)),
        sources=picked,
        author_position=max(1, author_position),
        total_authors=max(1, total_authors),
        this_year=timezone.now().year,
    )


@api.post("/discover/reprice", auth=session_auth)
def discover_reprice(request: HttpRequest, payload: RepriceIn):
    """The same journals, priced for a different author position.

    No model call — this is arithmetic over rows we already hold, so trying
    "what if I were third of five" costs nothing and answers immediately.
    Available whether or not a model is configured, because it does not need
    one.
    """
    _require_may_see_money(request)
    return discover_service.reprice(
        issns=payload.issns,
        author_position=max(1, payload.author_position),
        total_authors=max(1, payload.total_authors),
    )


@api.get("/discover/directions", auth=session_auth)
def discover_directions(request: HttpRequest):
    """What this person might write next, from what they have written.

    Grounded on filed claims and stated interests. Drafts are excluded --
    an unfinished ticket is a private intention, and feeding one to a model
    would be reading somebody's notes.
    """
    user = require_user(request)
    state = ai.health()
    if not state.get("ready"):
        # 503 with the reason attached. "Switched off" was the only thing this
        # ever said, and it is wrong for two of the three ways it happens --
        # the service being down and the model not being pulled are both
        # things somebody can fix in one command.
        raise HttpError(503, state.get("detail") or "Suggestions are switched off.")

    history = discover_service.publication_history(user)
    interests = list(
        ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
    )
    if not history and not interests:
        return {
            "directions": [],
            "grounded_on": {"papers": 0, "interests": []},
            "note": (
                "There is nothing to go on yet. File a paper, or pick the domains "
                "you work in, and this will have something to work from."
            ),
        }

    try:
        return discover_service.suggest_directions(history=history, interests=interests)
    except ai.AIError as exc:
        raise HttpError(_ai_failure_status(exc), str(exc)) from exc


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


# ---------- what a head is measured on, and can steer ----------


class TargetIn(Schema):
    year: int
    metric: str
    target: int
    #: Omitted or null sets the target on the department as a whole.
    person_id: Optional[str] = None
    note: Optional[str] = None


def _target_progress(qs, metric: str, person_id: str | None) -> int:
    """How far along a target is, counted the same way every time.

    One function so the number under a departmental target and the number
    under a personal one cannot be arrived at differently -- which is exactly
    how a head ends up with a department at 80% made of people who are each,
    somehow, at 60%.
    """
    scoped = qs.filter(owner_id=person_id) if person_id else qs
    if metric == DepartmentTarget.Metric.Q1:
        return scoped.filter(quartile__iexact="Q1").count()
    if metric == DepartmentTarget.Metric.FIRST_AUTHOR:
        return scoped.filter(author_position=1).count()
    return scoped.count()


@api.get("/hod/targets", auth=session_auth)
def hod_targets(request: HttpRequest, year: Optional[int] = None):
    """Every target this head has set, with where it actually stands.

    Progress is recomputed on read rather than stored. A stored figure is one
    that is wrong from the moment somebody files a paper, and a head checking
    a target is checking it *now*.
    """
    user = _require_hod(request)
    department = hod.department_of(user)
    year = year or timezone.now().year

    qs = _hod_scope(user).filter(publication_year=year)
    rows = (
        DepartmentTarget.objects.filter(department__iexact=department, year=year)
        .select_related("person", "set_by")
        .order_by("person__name", "metric")
    )

    def as_dict(t: DepartmentTarget) -> dict[str, Any]:
        done = _target_progress(qs, t.metric, t.person_id)
        return {
            "id": t.id,
            "year": t.year,
            "metric": t.metric,
            "metric_label": DepartmentTarget.Metric(t.metric).label,
            "target": t.target,
            "done": done,
            "remaining": max(0, t.target - done),
            "fraction": round(done / t.target, 4) if t.target else None,
            "met": done >= t.target,
            "person_id": t.person_id,
            "person_name": t.person.name if t.person_id else None,
            "note": t.note,
            "set_by": t.set_by.name if t.set_by_id else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        }

    all_rows = [as_dict(t) for t in rows]
    return hod.without_money({
        "department": department,
        "year": year,
        "department_targets": [r for r in all_rows if r["person_id"] is None],
        "personal_targets": [r for r in all_rows if r["person_id"] is not None],
        "metrics": [
            {"key": m.value, "label": m.label} for m in DepartmentTarget.Metric
        ],
        "years": sorted(
            {y for y in _hod_scope(user).values_list("publication_year", flat=True) if y},
            reverse=True,
        ),
    })


@api.post("/hod/targets", auth=session_auth)
def hod_set_target(request: HttpRequest, payload: TargetIn):
    """Set or change one target. A head may only set them inside their own
    department, and only on somebody who is actually in it."""
    user = _require_hod(request)
    department = hod.department_of(user)

    valid = {m.value for m in DepartmentTarget.Metric}
    if payload.metric not in valid:
        raise HttpError(400, f"Metric must be one of: {', '.join(sorted(valid))}.")
    if payload.target < 0:
        raise HttpError(400, "A target cannot be negative")
    if payload.year < 2000 or payload.year > timezone.now().year + 5:
        raise HttpError(400, "That is not a year this can be set against")

    person = None
    if payload.person_id:
        person = User.objects.filter(pk=payload.person_id).first()
        if person is None:
            raise HttpError(404, "No such person")
        # Checked on the server, not just hidden on the screen: a head setting
        # targets on somebody else's staff is not a filter mistake, it is a
        # different head's business.
        if (person.department or "").strip().lower() != department.lower():
            raise HttpError(
                403, f"{person.name} is not in {department}."
            )

    target, created = DepartmentTarget.objects.update_or_create(
        department=department,
        year=payload.year,
        metric=payload.metric,
        person=person,
        defaults={
            "target": payload.target,
            "note": (payload.note or "").strip() or None,
            "set_by": user,
        },
    )
    AuditLog.objects.create(
        actor=user, action="TARGET_SET", entity="DepartmentTarget", entity_id=target.id,
        detail_json=json.dumps({
            "department": department, "year": payload.year, "metric": payload.metric,
            "target": payload.target, "person": person.id if person else None,
            "created": created,
        }),
    )
    return {"ok": True, "id": target.id, "created": created}


@api.delete("/hod/targets/{target_id}", auth=session_auth)
def hod_delete_target(request: HttpRequest, target_id: str):
    user = _require_hod(request)
    department = hod.department_of(user)
    target = get_object_or_404(DepartmentTarget, pk=target_id)
    if (target.department or "").lower() != department.lower():
        raise HttpError(403, "That target belongs to another department.")
    AuditLog.objects.create(
        actor=user, action="TARGET_DELETE", entity="DepartmentTarget",
        entity_id=target.id,
        detail_json=json.dumps({"metric": target.metric, "year": target.year}),
    )
    target.delete()
    return {"ok": True}


@api.get("/hod/people/{user_id}", auth=session_auth)
def hod_person(request: HttpRequest, user_id: str):
    """One member of this head's department, and what they have published.

    A head could see a list of their staff with counts beside each name and
    could not open any of them: `/api/faculty/{id}/report` needs
    `can_view_reports`, which a head does not have, so every name on their own
    department screen was a dead link. This is the same question asked inside
    the two limits a head works under -- their own department, and no money.

    The scope check is on the person's department, not on a parameter: a head
    asking about somebody else's staff is not a filter, it is a different
    question with a different answer.
    """
    user = _require_hod(request)
    department = hod.department_of(user)
    person = get_object_or_404(User, pk=user_id)

    if (person.department or "").strip().lower() != department.lower():
        raise HttpError(
            403,
            f"{person.name} is not in {department}. A head sees their own department.",
        )

    claims = (
        Claim.objects.filter(owner=person)
        .exclude(status=ClaimStatus.DRAFT)
        .order_by("-publication_year", "-updated_at")
    )

    def bucket(field: str, blank: str) -> list[dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for value in claims.values_list(field, flat=True):
            key = (str(value).strip() if value not in (None, "") else blank) or blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0})
            slot["count"] += 1
        return sorted(out.values(), key=lambda r: -r["count"])

    years = sorted({y for y in claims.values_list("publication_year", flat=True) if y})
    by_year = []
    if years:
        per: dict[int, int] = {}
        for y in claims.values_list("publication_year", flat=True):
            if y:
                per[y] = per.get(y, 0) + 1
        # Empty years drawn as the zeros they are: a gap joined by a straight
        # line reads as steady output through a year with nothing in it.
        by_year = [
            {"key": str(y), "count": per.get(y, 0), "amount": 0}
            for y in range(min(years), max(years) + 1)
        ]

    targets = [
        {
            "id": t.id,
            "year": t.year,
            "metric": t.metric,
            "metric_label": DepartmentTarget.Metric(t.metric).label,
            "target": t.target,
            "done": _target_progress(
                claims.filter(publication_year=t.year), t.metric, person.id
            ),
        }
        for t in DepartmentTarget.objects.filter(
            department__iexact=department, person=person
        ).order_by("-year", "metric")
    ]
    for t in targets:
        t["remaining"] = max(0, t["target"] - t["done"])
        t["met"] = t["done"] >= t["target"]
        t["fraction"] = round(t["done"] / t["target"], 4) if t["target"] else None

    return hod.without_money({
        "person": {
            "id": person.id,
            "name": person.name,
            "email": person.email,
            "department": person.department,
            "designation": person.designation,
            "staff_id": person.staff_id,
            "active": person.active,
        },
        "totals": {
            "publications": claims.count(),
            "q1": claims.filter(quartile__iexact="Q1").count(),
            "first_author": claims.filter(author_position=1).count(),
            "under_review": claims.filter(
                status__in=(
                    ClaimStatus.SUBMITTED,
                    ClaimStatus.CLEARED,
                    ClaimStatus.PRINCIPAL_APPROVED,
                    ClaimStatus.DIRECTOR_APPROVED,
                )
            ).count(),
        },
        "by_year": by_year,
        "by_quartile": bucket("quartile", "Not recorded"),
        "by_journal": bucket("journal_title", "Not recorded")[:10],
        "targets": targets,
        "papers": [
            {
                "id": c.id,
                "paper_title": c.paper_title,
                "journal_title": c.journal_title,
                "publication_year": c.publication_year,
                "quartile": c.quartile,
                "author_position": c.author_position,
                "total_authors": c.total_authors,
                "progress": hod.progress_of(c.status),
            }
            for c in claims[:100]
        ],
    })


@api.get("/hod/standing", auth=session_auth)
def hod_standing(request: HttpRequest, year: Optional[int] = None):
    """How this department compares with the rest of the college.

    A head knows their own numbers and has no way to tell whether they are
    good. Forty papers is a triumph or a disappointment depending entirely on
    what the department next door did, and nothing in this system would say.

    Every figure here is a count or a rate. **No money, and no other
    department is named** -- the head sees where they sit and what the college
    typically does, not a ranked table of their colleagues' departments, which
    is a different document with different politics and is not a head's to
    hold.
    """
    user = _require_hod(request)
    department = hod.department_of(user)

    college = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    if year:
        college = college.filter(publication_year=year)
    mine = college.filter(owner__department__iexact=department)

    def rates(qs) -> dict[str, Any]:
        total = qs.count()
        q1 = qs.filter(quartile__iexact="Q1").count()
        first = qs.filter(author_position=1).count()
        return {
            "publications": total,
            "q1": q1,
            "q1_rate": round(q1 / total, 4) if total else None,
            "first_author": first,
            "first_author_rate": round(first / total, 4) if total else None,
        }

    # Per-department counts, used for the share and the position. The names
    # are dropped straight after; only this department's own is kept.
    per_department: dict[str, int] = {}
    for row in college.values("owner__department").annotate(n=Count("id")):
        key = (row["owner__department"] or "").strip()
        if key:
            per_department[key] = per_department.get(key, 0) + row["n"]

    counts = sorted(per_department.values(), reverse=True)
    my_count = per_department.get(department, 0)
    position = counts.index(my_count) + 1 if my_count in counts else None
    college_total = sum(per_department.values())

    heads = User.objects.filter(
        role=Role.FACULTY, department__iexact=department, active=True
    ).count()
    college_heads = User.objects.filter(role=Role.FACULTY, active=True).count()

    mine_rates = rates(mine)
    college_rates = rates(college)

    return hod.without_money({
        "department": department,
        "year": year,
        "mine": {
            **mine_rates,
            "faculty": heads,
            "per_head": round(my_count / heads, 2) if heads else None,
        },
        "college": {
            **college_rates,
            "departments": len(per_department),
            "faculty": college_heads,
            "per_head": round(college_total / college_heads, 2) if college_heads else None,
        },
        "share": round(my_count / college_total, 4) if college_total else None,
        # "3rd of 22" is the whole answer a head wants and the least
        # inflammatory way to give it: no other department is named.
        "position": position,
        "of": len(per_department),
        "years": sorted(
            {y for y in Claim.objects.exclude(status=ClaimStatus.DRAFT)
             .values_list("publication_year", flat=True) if y},
            reverse=True,
        ),
    })


@api.get("/hod/opportunities", auth=session_auth)
def hod_opportunities(request: HttpRequest, year: Optional[int] = None):
    """Where this department could realistically do more, with the names.

    Every item is something a head can actually act on this term, and each one
    carries the people or papers behind it rather than only a count -- "eleven
    papers would fail accreditation" is a statistic, and the list of which
    eleven is a task.
    """
    user = _require_hod(request)
    department = hod.department_of(user)
    qs = _hod_scope(user)
    if year:
        qs = qs.filter(publication_year=year)

    def people_rows(users) -> list[dict[str, Any]]:
        return [
            {
                "id": u.id, "name": u.name,
                "designation": u.designation, "staff_id": u.staff_id,
            }
            for u in users
        ]

    members = list(
        User.objects.filter(role=Role.FACULTY, department__iexact=department, active=True)
        .order_by("name")
    )
    filed = set(qs.values_list("owner_id", flat=True))
    with_q1 = set(qs.filter(quartile__iexact="Q1").values_list("owner_id", flat=True))
    led = set(qs.filter(author_position=1).values_list("owner_id", flat=True))

    silent = [u for u in members if u.id not in filed]
    no_q1 = [u for u in members if u.id in filed and u.id not in with_q1]
    never_led = [u for u in members if u.id in filed and u.id not in led]

    # Accreditation asks for these on every row; a paper missing one is a row
    # an assessor sends back, and it is far cheaper to fix now than in the
    # week the submission is due.
    incomplete = qs.filter(
        Q(issn__isnull=True) | Q(issn="") | Q(doi__isnull=True) | Q(doi="")
    ).order_by("-publication_year")

    # Where the department already publishes, worst standing first: the
    # realistic next move is usually a better journal in a field somebody is
    # already in, not a new field.
    low_quartile = (
        qs.filter(quartile__iregex=r"^Q[34]$")
        .values("journal_title", "quartile")
        .annotate(n=Count("id"))
        .order_by("-n")[:10]
    )

    return hod.without_money({
        "department": department,
        "year": year,
        "groups": [
            {
                "key": "silent",
                "title": "Nobody has filed anything for them",
                "blurb": (
                    "Not the same as having published nothing -- a paper nobody "
                    "filed a claim for does not exist anywhere in this system."
                ),
                "count": len(silent),
                "people": people_rows(silent),
            },
            {
                "key": "no_q1",
                "title": "Publishing, but nothing in a Q1 journal",
                "blurb": "The clearest single lift available to the department.",
                "count": len(no_q1),
                "people": people_rows(no_q1),
            },
            {
                "key": "never_led",
                "title": "Never first author",
                "blurb": (
                    "Contributing to other people's papers without leading one. "
                    "First authorship is what the department is credited with."
                ),
                "count": len(never_led),
                "people": people_rows(never_led),
            },
        ],
        "incomplete_records": {
            "count": incomplete.count(),
            "blurb": (
                "Missing an ISSN or a DOI. An assessor sends these back, and "
                "they are far cheaper to fix now than in submission week."
            ),
            "papers": [
                {
                    "id": c.id,
                    "paper_title": c.paper_title,
                    "journal_title": c.journal_title,
                    "publication_year": c.publication_year,
                    "owner_name": c.owner.name if c.owner_id else None,
                    "missing": [
                        label for label, present in (
                            ("ISSN", bool((c.issn or "").strip())),
                            ("DOI", bool((c.doi or "").strip())),
                        ) if not present
                    ],
                }
                for c in incomplete[:25]
            ],
        },
        "lower_quartile_journals": [
            {
                "journal_title": r["journal_title"] or "Not recorded",
                "quartile": r["quartile"],
                "count": r["n"],
            }
            for r in low_quartile
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

    # Same rule as the pack screen: a corrected year drops the research-quota
    # slot the old year issued, and the paper has to take one in the new year
    # or it sits there unnumbered. Unreachable today -- the Claim table
    # declares no editable columns, so this endpoint cannot touch
    # `publication_year` at all -- and here so that the day it does, the slot
    # is not quietly lost.
    held_a_slot = (
        isinstance(instance, Claim)
        and payload.column == "publication_year"
        and instance.quota_position is not None
    )

    setattr(instance, payload.column, value)
    instance.save(update_fields=[payload.column])
    if held_a_slot and instance.quota_position is None:
        _assign_quota_position(instance)

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
        status__in=(
            ClaimStatus.CLEARED,
            ClaimStatus.PRINCIPAL_APPROVED,
            ClaimStatus.DIRECTOR_APPROVED,
        )
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
        ClaimStatus.HOD_APPROVED,
        ClaimStatus.RESEARCH_APPROVED,
        ClaimStatus.FINANCE_APPROVED,
    ]) | claims.filter(
        # A live Principal approval sets this; an ERP import does not. Without
        # the distinction every ticket legitimately waiting on the Director was
        # reported as stranded on a retired status.
        status=ClaimStatus.PRINCIPAL_APPROVED,
        principal_approved_at__isnull=True,
    )
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
    department: Optional[str] = None,
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
    # A filter of its own rather than folded into `q`. `q` already matches
    # department, but only as one of six things it matches, so it cannot be
    # combined with a name search -- picking a department would clear the
    # search box and vice versa. Thirty-one departments is exactly the case
    # where "everyone in ECE called Kumar" is the question being asked.
    if department:
        qs = qs.filter(department__iexact=department.strip())
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


#: Roles an account may be given. Every one of them now carries capabilities.
#:
#: HOD was once described here as "retired and able to do nothing". That has
#: not been true since a head got their own department screen: standing
#: against the college, targets they set for their staff, and a money-free
#: view of one person. It is a real post again, and it is assignable.
#: Roles whose appointment decides whether money moves, and which therefore
#: only a super admin may hand out.
#:
#: The research cell and the coordinator manage accounts -- that is their job,
#: and taking it away would stop the office working. But `can_manage_users`
#: covered every role including SUPER_ADMIN, so the desk that clears a claim
#: could promote itself, or reset the Finance password and pay the claim it had
#: just cleared. Every separation in the approval chain was optional for the
#: one role positioned to exploit it.
PRIVILEGED_ROLES = (Role.SUPER_ADMIN, Role.DIRECTOR, Role.FINANCE)

ASSIGNABLE_ROLES = (
    Role.FACULTY,
    Role.HOD,
    Role.PRINCIPAL,
    # Without this the office could not create or promote the one role that
    # has to authorise every payment -- the chain would have a step nobody
    # could be appointed to.
    Role.DIRECTOR,
    Role.RESEARCH_COORDINATOR,
    Role.RESEARCH_CELL,
    Role.FINANCE,
    Role.SUPER_ADMIN,
)


def _check_privileged_assignment(actor: User, role: str | None) -> None:
    """Only a super admin appoints the roles that decide whether money moves.

    Separate from `_check_assignable_role`, which answers "is this a real
    role"; this answers "is this yours to hand out". The research cell keeps
    every other part of account management.
    """
    if role and role in PRIVILEGED_ROLES and actor.role != Role.SUPER_ADMIN:
        raise HttpError(
            403,
            f"Only a super admin can appoint the {role.replace('_', ' ').lower()} "
            "role. It decides whether money moves, so the office that prepares "
            "a payment cannot also create the account that authorises it.",
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
    _check_privileged_assignment(user, payload.role)

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
        # `None` here is not "no password", it is "no password that works":
        # Django stores an unusable marker that no input can ever match.
        password=payload.password or None,
        name=payload.name,
        role=payload.role,
        department=payload.department,
        employee_id=payload.employee_id,
        staff_id=payload.staff_id,
        biometric_id=payload.biometric_id,
        designation=payload.designation,
        scopus_author_url=payload.scopus_author_url,
        scopus_author_id=payload.scopus_author_id,
        # An account with no usable password must be made to set one; the
        # flag is not the caller's to turn off in that case.
        must_change_password=payload.must_change_password or not payload.password,
    )
    if not payload.password:
        u.set_unusable_password()
        u.save(update_fields=["password"])
    AuditLog.objects.create(
        actor=user, action="USER_CREATE", entity="User", entity_id=u.id
    )
    return {
        "id": u.id,
        "email": u.email,
        "needs_password": not payload.password,
    }


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
                + ", ".join(FIELD_LABELS.get(f, f.replace("_", " ")) for f in blocked)
                + ". You can still set the role, the department and whether the "
                "account is active.",
            )
    _check_privileged_assignment(actor, data.get("role"))
    # Self-lockout guard: an admin demoting or deactivating their own account
    # can leave the system with nobody able to manage users.
    if u.id == actor.id:
        if "role" in data and data["role"] != actor.role:
            raise HttpError(400, "You cannot change your own role — ask another admin")
        if data.get("active") is False:
            raise HttpError(400, "You cannot deactivate your own account")
    if data.get("faculty_type") not in (None, "REGULAR", "RESEARCH"):
        raise HttpError(400, "Faculty type must be REGULAR or RESEARCH.")
    if data.get("research_quota") is not None and data["research_quota"] < 0:
        raise HttpError(400, "A quota cannot be negative.")

    before = {k: getattr(u, k, None) for k in data}
    for k, v in data.items():
        setattr(u, k, v)
    # A quota on a regular post is a number that never applies, and reading one
    # on screen would suggest papers are being zeroed when they are not.
    if u.faculty_type != "RESEARCH":
        u.research_quota = None
        u.research_quota_note = None
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
    elif status in (
        "CLEARED", "PRINCIPAL_APPROVED", "DIRECTOR_APPROVED", "FINANCE_APPROVED"
    ):
        # The payable queue: *authorised by the Director* on this system. Neither
        # a merely cleared ticket nor a merely Principal-approved one is in it,
        # because finance cannot pay either -- and a queue full of rows whose pay
        # button always refuses is worse than an empty queue, since it reads as
        # work.
        #
        # Every one of the older aliases still routes here rather than 404ing,
        # so a client that has not caught up asks the same question and gets the
        # currently-correct answer instead of a queue that is silently wrong.
        #
        # Legacy import rows keep their own home in the faults screen, where a
        # super admin unsticks them; they are deliberately not shown here as
        # though they were ready to pay.
        qs = qs.filter(
            status=ClaimStatus.DIRECTOR_APPROVED, director_approved_at__isnull=False
        )
        default_order = "-director_approved_at"
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
