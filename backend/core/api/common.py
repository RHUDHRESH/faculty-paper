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
from ninja.renderers import JSONRenderer
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

class ViewerAwareRenderer(JSONRenderer):
    """Every JSON response, shaped for whoever is signed in, on its way out.

    The rules about what a seat in the chain must not see live in
    `core.visibility`. Applying them here rather than at each endpoint is the
    point: a new endpoint that returns a claim is covered by default. Files
    (CSV, workbooks) are HttpResponses and do not pass through a renderer;
    their columns carry none of the fields in question.
    """

    def render(self, request: HttpRequest, data: Any, *, response_status: int) -> Any:
        from core import visibility

        user = getattr(request, "user", None)
        if getattr(user, "is_authenticated", False):
            data = visibility.for_viewer(user, data)
        return super().render(request, data, response_status=response_status)


api = NinjaAPI(
    title="Faculty Remuneration",
    version="1.0.0",
    # Swagger and the OpenAPI schema publish the whole endpoint surface, so they
    # stay off outside development.
    docs_url="/docs" if settings.DEBUG else None,
    openapi_url="/openapi.json" if settings.DEBUG else None,
    renderer=ViewerAwareRenderer(),
)
session_auth = SessionAuth()

IMPERSONATOR_KEY = "impersonator_id"

_PASSWORD_CHANGE_EXEMPT = {"/api/auth/change-password", "/api/auth/me"}

#: The expensive endpoints run under a per-account fixed-window cap. The
#: numbers come from settings (AI_DAILY_LIMIT and friends); the counter
#: lives in the process cache. Gunicorn runs one worker on Cloud Run, so
#: that cache is the deployment; if the worker count ever grows, each worker
#: gets its own counter and this is the line to revisit -- a shared cache
#: (Redis would be a second outside service, so probably the database) is
#: the fix, not deleting the caps.
_RATE_WINDOWS = {"day": 86400, "hour": 3600}


def rate_limit_for(user: User | None, bucket: str, limit: int, window: str, *, what: str) -> None:
    """Refuse the call when `user` has had `limit` of `bucket` this window.

    Raises HttpError 429 with the time the window has left, which the screen
    can show instead of a bare refusal. A request that carries no account
    (an anonymous probe) is keyed by address instead -- those are the
    requests most worth capping.
    """
    import time as _time

    from django.core.cache import cache

    who = getattr(user, "pk", None) or "anon"
    seconds = _RATE_WINDOWS[window]
    epoch = int(_time.time()) // seconds
    key = f"rate:{bucket}:{epoch}:{who}"
    try:
        seen = cache.incr(key)
    except ValueError:
        cache.set(key, 1, seconds)
        seen = 1
    if seen > limit:
        remaining = int((epoch + 1) * seconds - _time.time())
        minutes = max(1, -(-remaining // 60))
        logger.warning(
            "rate_limited bucket=%s who=%s seen=%s limit=%s", bucket, who, seen, limit
        )
        raise HttpError(
            429,
            f"That is a lot of {what} for one {'day' if window == 'day' else 'hour'} "
            f"— the limit is {limit}. Try again in about {minutes} minute"
            f"{'s' if minutes != 1 else ''}.",
        )


def rate_limit(request: HttpRequest, bucket: str, limit: int, window: str, *, what: str) -> None:
    rate_limit_for(getattr(request, "user", None), bucket, limit, window, what=what)


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


def _migrations_pending() -> bool:
    """Are there migration files the database has not recorded?"""
    try:
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor

        executor = MigrationExecutor(connection)
        plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
        return bool(plan)
    except Exception:  # never let the health probe itself fall over
        return False


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
    s3_bucket = getattr(settings, "S3_BUCKET_NAME", "")
    if bucket:
        media_backend = f"gs://{bucket}"
        media_is_ephemeral = False
    elif s3_bucket:
        media_backend = f"s3://{s3_bucket}"
        media_is_ephemeral = False
    elif getattr(settings, "MEDIA_IN_DATABASE", False):
        media_backend = "database"
        media_is_ephemeral = False
    else:
        media_backend = str(Path(settings.MEDIA_ROOT).resolve())
        media_is_ephemeral = not settings.DEBUG
    # The job worker shares this container. If it dies, gunicorn keeps serving
    # and the revision looks perfectly healthy while queued work — ERP imports,
    # monthly batches — silently stops running. Nothing else would notice.
    worker = _worker_status()
    # Migrations run on container start, so "the new revision is up but the
    # schema is not" should be a visible fact for the minute or two it is
    # true, not something discovered when a query names a column that does
    # not exist yet.
    migrations_pending = _migrations_pending()
    payload = {
        "ok": db_ok,
        "db": db_ok,
        "service": "faculty-paper-api",
        "version": getattr(settings, "APP_VERSION", "dev"),
        "git": (os.getenv("GIT_COMMIT") or os.getenv("K_REVISION") or "")[:24] or None,
        "media_backend": media_backend,
        "media_persistent": not media_is_ephemeral,
        "worker": worker,
        "migrations_pending": migrations_pending,
        "time": timezone.now().isoformat(),
    }
    if media_is_ephemeral:
        payload["warnings"] = [
            "Uploads are on the container filesystem and will be lost on the "
            "next deploy. Set GS_BUCKET_NAME (Google Cloud Storage) or S3_BUCKET_NAME (S3 / Cloudflare R2)."
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
    title: str,
    body: str,
    href: str,
    *,
    super_admin_only: bool = False,
    claim_id: str | None = None,
) -> None:
    """An admin notification, about one ticket when `claim_id` says which."""
    roles = (Role.SUPER_ADMIN,) if super_admin_only else rbac.ADMIN_ROLES
    for u in User.objects.filter(role__in=roles, active=True):
        Notification.objects.create(
            user=u, title=title, body=body, href=href, claim_id=claim_id
        )
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
    'IMPERSONATOR_KEY',
    'ViewerAwareRenderer',
    '_PASSWORD_CHANGE_EXEMPT',
    '_THRESHOLD_CACHE',
    '_THRESHOLD_TTL_SECONDS',
    '_invalidate_threshold_cache',
    'require_user',
    '_quota_state',
    '_quartile_year_note',
    '_snip_year_note',
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


# The second-approval threshold's memo, moved with the function that owns it;
# two copies of a cache would mean one of them goes stale, and this one prices money.

_THRESHOLD_CACHE: dict[str, Any] = {}
_THRESHOLD_TTL_SECONDS = 30


def _invalidate_threshold_cache() -> None:
    _THRESHOLD_CACHE.clear()
