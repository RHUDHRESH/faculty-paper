"""shared setup: the NinjaAPI instance, logging, exception handlers.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

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
from core.services.search import KINDS as SEARCH_KINDS, search as run_search
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




# Definitions shared by several sections below, relocated here so the
# package stays importable (they would otherwise make two sections
# import each other).

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


__all__ = [
    '_apply_calc',
    '_csv_row',
    '_csv_safe',
    '_high_value_threshold',
    '_hod_scope',
    '_needs_second_approval',
    '_notify_admin_users',
    '_notify_admins',
    '_notify_director',
    '_notify_finance',
    '_notify_principal',
    '_parse_payout_month',
    '_require_admin_ops',
    '_require_may_see_money',
    '_verification_issues',
    '_waiting_days',
    '_worker_status',
    'api',
    'health',
    'logger',
    'session_auth',
]
