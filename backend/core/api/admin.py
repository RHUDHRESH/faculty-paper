"""admin.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.services.cell_safe import csv_writer
from core.api.common import api, session_auth
from core.api.schemas import FormulaIn, ResetPasswordByEmailIn, ResetPasswordIn, UserCreateIn, UserUpdateIn
from core.api.deps import _user_dict, claim_to_dict, record_authorships
from core.api.common import rate_limit, require_user
from core.api.auth import FIELD_LABELS, IDENTITY_FIELDS, clear_login_lockout, may_set_field
from core.api.claims import _CLAIM_SORTS
from core.api.common import _invalidate_threshold_cache

import csv
import io
import json
from datetime import date, timedelta
from typing import Optional
from django.db import transaction
from django.db.models import Max, Case, IntegerField, Q, Sum, Value, When
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import File, Form, Schema, UploadedFile
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimFlag, ClaimStatus, FormulaConfig, PriorImport, PriorPayment, Role, ScimagoJournal, User
from core import visibility
from core.services import change_history, coordination, heads, payments_desk, rbac, research_threshold, validation
from core.services.normalize import normalize_doi, normalize_title
from core.services.remuneration import DEFAULT_AUTHOR_POINTS, DEFAULT_PUB_TYPE_MULTIPLIERS, DEFAULT_STUDENT_PROJECT_AMOUNT, MAX_ELIGIBLE_AUTHORS, MIN_SEC_REFERENCES
from core.services.scimago_sync import SCIMAGO_RANK_URL, ScimagoSyncError, import_csv_text, sync_year

# ---------- admin ----------


@api.get("/admin/users", auth=session_auth)
def admin_users(
    request: HttpRequest,
    q: Optional[str] = None,
    role: Optional[str] = None,
    department: Optional[str] = None,
    active: Optional[str] = None,
    faculty_type: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """The staff directory, searched and paged server-side.

    `faculty_type` (REGULAR or RESEARCH) sits beside `role` because the office
    asks both questions of a person separately: are they head, and are they
    research faculty.

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
    if faculty_type in ("REGULAR", "RESEARCH"):
        qs = qs.filter(faculty_type=faculty_type)
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
    everyone = User.objects.all()
    now_active = everyone.filter(active=True)
    held = {
        r: now_active.filter(role=r).count() for r in (Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE)
    }
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        # Whole-roster figures, whatever the filters: the answer the People page
        # opens with. Desks are the three roles a claim waits on besides the
        # office (the super admin stands in for that one).
        "counts": {
            "active": now_active.count(),
            "left": everyone.filter(active=False).count(),
            "research": now_active.filter(faculty_type="RESEARCH").count(),
            "desks_empty": sum(1 for n in held.values() if n == 0),
        },
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


def _appoint_head(u: User, *, replace: bool, actor: User) -> None:
    """One head per department (`services.heads`), answered as HTTP.

    409 names the head already in post, so the office can decide rather than
    guess; `replace_hod` is the explicit decision, and demotes them in the same
    transaction as this write.
    """
    try:
        heads.appoint(u, replace=replace, actor=actor, via="account editor")
    except heads.NoDepartment as exc:
        raise HttpError(400, str(exc))
    except heads.HeadAlreadyAppointed as exc:
        raise HttpError(409, str(exc))


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
    validation.as_http(validation.check_user_fields, {**payload.dict(), "email": email})
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

    with transaction.atomic():
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
        if u.role == Role.HOD:
            # A refusal here unwinds the account created just above.
            _appoint_head(u, replace=bool(payload.replace_hod), actor=user)
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
    # An instruction about this write, not a field of the account.
    replace_hod = bool(data.pop("replace_hod", False))
    if "role" in data:
        _check_assignable_role(data["role"])
    # Identity is super-admin only, here as much as on the profile page.
    # Closing the self-edit route while leaving this one open would just move
    # the same mistake one desk over: the research cell processes the claims
    # these fields decide the outcome of, so it cannot also set them.
    if actor.role != Role.SUPER_ADMIN:
        blocked = sorted(f for f in set(data) & IDENTITY_FIELDS if not may_set_field(actor.role, f))
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
            raise HttpError(400, "You cannot change your own role. Ask another admin")
        if data.get("active") is False:
            raise HttpError(400, "You cannot deactivate your own account")
    validation.as_http(validation.check_user_fields, data)
    if data.get("faculty_type") not in (None, "REGULAR", "RESEARCH"):
        raise HttpError(400, "Faculty type must be REGULAR or RESEARCH.")
    if "research_quota" in data or "research_quota_note" in data:
        raise HttpError(
            400,
            "The papers-a-year quota is retired. Set a rupee threshold for "
            "this person instead.",
        )

    before = {k: getattr(u, k, None) for k in data}
    for k, v in data.items():
        setattr(u, k, v)
    # The retired quota on a regular post is a number that never applied.
    # A rupee threshold is kept on record (it is history), but it decides
    # nothing for somebody who is not research faculty.
    if u.faculty_type != "RESEARCH":
        u.research_quota = None
        u.research_quota_note = None
    changed = {k: {"from": before[k], "to": data[k]} for k in data if before[k] != data[k]}
    with transaction.atomic():
        # Checked only when this edit changes who holds the post -- the role,
        # where they sit, or whether the account is on. An unrelated edit to a
        # department that already has two heads from before the rule must not
        # be frozen by it.
        if u.role == Role.HOD and changed.keys() & {"role", "department", "active"}:
            _appoint_head(u, replace=replace_hod, actor=actor)
        u.save()
        if "faculty_type" in changed:
            # Becoming (or ceasing to be) research faculty changes what the
            # person's open claims are worth.
            research_threshold.refresh_open_claims(u)
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


class IssuePasswordsIn(Schema):
    who: str
    role: Optional[str] = None
    department: Optional[str] = None
    ids: Optional[list[str]] = None
    include_inactive: bool = False
    dry_run: bool = False


#: Real runs an hour. Each one replaces passwords people may already be using;
#: a script or a stuck double-click must not be able to do that on a loop.
ISSUE_PASSWORDS_PER_HOUR = 5


@api.post("/admin/passwords/issue", auth=session_auth)
def admin_issue_passwords(request: HttpRequest, payload: IssuePasswordsIn):
    """A super admin gives a group of accounts new one-time passwords.

    `dry_run` answers how many, and of which role and department, and changes
    nothing. The real call answers with the sign-in list as a CSV download:
    the only copy of those passwords there will ever be. They are never stored
    in plain text, logged, or written to the audit row, which records who, when,
    the scope and the count.
    """
    from django.http import HttpResponse

    from core.services import issue_passwords
    from core.viewas import is_viewing_as

    actor = require_user(request)
    if is_viewing_as(request):
        raise HttpError(403, "You are viewing as another user. Stop viewing before issuing passwords.")
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can issue passwords.")

    try:
        qs = issue_passwords.scope_queryset(
            payload.who,
            role=payload.role,
            department=payload.department,
            ids=payload.ids,
            include_inactive=payload.include_inactive,
            actor=actor,
        )
    except issue_passwords.ScopeError as exc:
        raise HttpError(400, str(exc))

    if payload.dry_run:
        return issue_passwords.preview(qs)

    if not qs.exists():
        raise HttpError(400, "Nobody matches that. No passwords were changed.")
    rate_limit(request, "issue_passwords", ISSUE_PASSWORDS_PER_HOUR, "hour", what="password runs")

    rows = issue_passwords.issue(qs)
    scope = {"who": payload.who, "include_inactive": payload.include_inactive, "count": len(rows)}
    if payload.who == "role":
        scope["role"] = payload.role
    elif payload.who == "department":
        scope["department"] = payload.department
    elif payload.who == "ids":
        scope["ids"] = len(payload.ids or [])
    AuditLog.objects.create(
        actor=actor, action="PASSWORDS_ISSUE", entity="User", detail_json=json.dumps(scope)
    )
    body = issue_passwords.to_csv(rows)
    del rows
    resp = HttpResponse(body.encode("utf-8"), content_type="text/csv; charset=utf-8")
    stamp = timezone.now().strftime("%Y-%m-%d")
    resp["Content-Disposition"] = f'attachment; filename="sign-in-list-{stamp}.csv"'
    resp["X-Issued-Count"] = str(scope["count"])
    # The only copy: nothing on the way may keep one.
    resp["Cache-Control"] = "no-store"
    return resp


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
            "student_project_amount": DEFAULT_STUDENT_PROJECT_AMOUNT,
            "filing_cutoff_day": None,
            "research_year_start_month": research_threshold.DEFAULT_YEAR_START_MONTH,
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
        "student_project_amount": cfg.student_project_amount,
        "filing_cutoff_day": cfg.filing_cutoff_day,
        "research_year_start_month": cfg.research_year_start_month,
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
        ("student_project_amount", payload.student_project_amount or 0),
    ):
        if amount < 0:
            raise HttpError(400, f"{label} cannot be negative")
    cutoff_given = "filing_cutoff_day" in payload.model_fields_set
    if payload.research_year_start_month is not None and not 1 <= payload.research_year_start_month <= 12:
        raise HttpError(400, "The research year starts in a month from 1 to 12")
    if payload.filing_cutoff_day is not None and not 1 <= payload.filing_cutoff_day <= 28:
        raise HttpError(
            400, "The filing cutoff is a day of the month from 1 to 28, so every month has it"
        )

    with transaction.atomic():
        prev = FormulaConfig.objects.filter(active=True).order_by("-version").first()
        # With no stored row the college is priced from the built-in rates,
        # which every screen calls v1 -- the editor says "retires v1, makes v2
        # active" and asks the admin to type v2. Saving that as version 1 gave
        # two different policies the same number. Never reuse a number either:
        # count on from the highest version ever stored.
        highest = FormulaConfig.objects.aggregate(m=Max("version"))["m"] or 0
        next_version = max(highest, prev.version if prev else 1) + 1
        student_project_amount = (
            payload.student_project_amount
            if payload.student_project_amount is not None
            else (prev.student_project_amount if prev else DEFAULT_STUDENT_PROJECT_AMOUNT)
        )
        # A client that does not know about the cutoff (an older screen, a
        # script) must not clear it by saving the rest of the policy.
        cutoff = payload.filing_cutoff_day if cutoff_given else (prev.filing_cutoff_day if prev else None)
        year_month = (
            payload.research_year_start_month
            if payload.research_year_start_month is not None
            else (prev.research_year_start_month if prev else research_threshold.DEFAULT_YEAR_START_MONTH)
        )
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
            student_project_amount=student_project_amount,
            filing_cutoff_day=cutoff,
            research_year_start_month=year_month,
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
            detail_json=json.dumps(_formula_audit_detail(prev, cfg)),
        )
    return {"id": cfg.id, "version": cfg.version, "name": cfg.name}


#: The rates and rules an admin reads in the audit log as "from what to what".
_FORMULA_AUDIT_FIELDS = (
    "snip_multiplier", "snip_cap", "qf_q1", "qf_q2", "qf_q3", "qf_q4",
    "fixed_journal_no_snip", "fixed_other_no_snip", "fixed_web_of_science",
    "student_project_amount", "high_value_threshold", "max_authors",
    "min_sec_references", "filing_cutoff_day", "research_year_start_month",
    "student_remuneration_zero",
)


def _formula_audit_detail(prev, cfg) -> dict:
    detail: dict = {"version": cfg.version, "name": cfg.name}
    if cfg.notes:
        detail["reason"] = cfg.notes
    if prev is not None:
        before = {f: getattr(prev, f) for f in _FORMULA_AUDIT_FIELDS if getattr(prev, f) != getattr(cfg, f)}
        if before:
            detail["before"] = before
            detail["after"] = {f: getattr(cfg, f) for f in before}
    return detail


def _audit_queryset(
    user,
    q: Optional[str] = None,
    action: Optional[str] = None,
    person: Optional[str] = None,
    claim: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """The rows this reader may see, narrowed by the log's filters.

    `person` matches the actor's email or name; `claim` matches a claim id or
    ticket number (and the flags filed under that claim); `date_from` and
    `date_to` are inclusive calendar days in the college's time zone.
    """
    qs = AuditLog.objects.select_related("actor").order_by("-created_at")
    # The trail of the reader's own papers names every desk and person that
    # handled them; on those they are the claimant, who is told neither. A
    # flag's rows are filed under the flag, so they are left out by the flag.
    qs = qs.exclude(
        entity="Claim",
        entity_id__in=Claim.objects.filter(owner=user).values_list("id", flat=True),
    ).exclude(
        entity="ClaimFlag",
        entity_id__in=ClaimFlag.objects.filter(claim__owner=user).values_list("id", flat=True),
    )
    if visibility.is_contest_blind(user.role):
        # Dropped from the query rather than from the page, so the total does
        # not count rows the reader is not shown.
        qs = qs.exclude(action__in=visibility.CONTEST_AUDIT_ACTIONS)
    if action:
        qs = qs.filter(action__icontains=action)
    if q:
        qs = qs.filter(
            Q(entity_id__icontains=q)
            | Q(entity__icontains=q)
            | Q(actor__email__icontains=q)
            | Q(actor__name__icontains=q)
        )
    if person:
        qs = qs.filter(Q(actor__email__icontains=person) | Q(actor__name__icontains=person))
    if claim:
        ids = list(
            Claim.objects.filter(Q(id=claim) | Q(ticket_number__iexact=claim)).values_list("id", flat=True)
        ) or [claim]
        flag_ids = list(ClaimFlag.objects.filter(claim_id__in=ids).values_list("id", flat=True))
        qs = qs.filter(
            Q(entity="Claim", entity_id__in=ids) | Q(entity="ClaimFlag", entity_id__in=flag_ids)
        )
    for raw, lookup in ((date_from, "created_at__date__gte"), (date_to, "created_at__date__lte")):
        if raw:
            try:
                day = date.fromisoformat(raw)
            except ValueError:
                raise HttpError(400, f"Not a date: {raw}. Use YYYY-MM-DD.")
            qs = qs.filter(**{lookup: day})
    if date_from and date_to and date_to < date_from:
        raise HttpError(400, "The end date is before the start date.")
    return qs


def _audit_row(l: AuditLog) -> dict:
    return {
        "id": l.id,
        "action": l.action,
        "entity": l.entity,
        "entity_id": l.entity_id,
        "actor": l.actor.email if l.actor else None,
        "actor_name": l.actor.name if l.actor else None,
        "detail_json": l.detail_json,
        "created_at": l.created_at.isoformat(),
    }


@api.get("/admin/audit", auth=session_auth)
def admin_audit(
    request: HttpRequest,
    q: Optional[str] = None,
    action: Optional[str] = None,
    person: Optional[str] = None,
    claim: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """Filterable, paginated audit trail: who changed what, and when."""
    user = require_user(request)
    if not rbac.can_view_audit(user.role):
        raise HttpError(403, "Forbidden")
    qs = _audit_queryset(user, q, action, person, claim, date_from, date_to)
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    total = qs.count()
    page = list(qs[offset : offset + limit])
    words = change_history.describe_many(page)
    results = []
    for l, w in zip(page, words):
        results.append({
            **_audit_row(l),
            # In plain words: who (with a face), what they did, from what to
            # what, the reason given, and a readable name for the record.
            "who": w["who"],
            "what": w["what"],
            "changes": w["changes"],
            "reason": w["reason"],
            "note": w["note"],
            "context": w["context"],
            "record": w["record"],
        })
    # Counts over the same filtered rows, so the figures above the list
    # always agree with the list.
    system = qs.filter(actor__isnull=True).count()
    week = qs.filter(created_at__gte=timezone.now() - timedelta(days=7)).count()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "summary": {"last_week": week, "by_people": total - system, "by_system": system},
        "results": results,
    }


AUDIT_CSV_CAP = 50000


@api.get("/admin/audit.csv", auth=session_auth)
def admin_audit_csv(
    request: HttpRequest,
    q: Optional[str] = None,
    action: Optional[str] = None,
    person: Optional[str] = None,
    claim: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
):
    """The same filtered trail as a spreadsheet, for an auditor or an inquiry."""
    import csv
    import io

    from django.http import HttpResponse

    user = require_user(request)
    if not rbac.can_view_audit(user.role):
        raise HttpError(403, "Forbidden")
    qs = _audit_queryset(user, q, action, person, claim, date_from, date_to)
    buf = io.StringIO()
    w = csv_writer(buf)
    total = qs.count()
    truncated = total > AUDIT_CSV_CAP
    if truncated:
        w.writerow([
            f"Truncated: this file holds the newest {AUDIT_CSV_CAP:,} of {total:,} "
            "matching rows. Narrow the dates to export the rest."
        ])
    w.writerow(["When (IST)", "Who", "Email", "Action", "Record", "Record id", "Detail"])
    for l in qs[:AUDIT_CSV_CAP]:
        w.writerow([
            # Local time a person reads, not a UTC ISO stamp with microseconds.
            timezone.localtime(l.created_at).strftime("%Y-%m-%d %H:%M:%S"),
            l.actor.name if l.actor else "System",
            l.actor.email if l.actor else "",
            l.action,
            l.entity,
            l.entity_id or "",
            l.detail_json or "",
        ])
    resp = HttpResponse(("﻿" + buf.getvalue()).encode("utf-8"), content_type="text/csv; charset=utf-8")
    stamp = timezone.now().strftime("%Y-%m-%d")
    resp["Content-Disposition"] = f'attachment; filename="audit-log-{stamp}.csv"'
    resp["X-Total-Rows"] = str(total)
    resp["X-Truncated"] = "true" if truncated else "false"
    return resp


@api.get("/admin/audit/origins", auth=session_auth)
def admin_audit_origins(request: HttpRequest):
    """Where the record came from: the imports and restores that built it.

    The college's history arrived by import, and the ERP import wrote no
    audit rows, so the log's first screen was a column of identical automatic
    entries and nothing about the claims and payments behind them. These are
    worked out from the rows themselves -- the payment-history batches, the
    ERP tickets by sheet and day, accounts created in bulk -- plus any restore
    or upload the log did record. Newest first. A reader who is not shown
    flags (the Director, Finance) is not shown the check that raised them.
    """
    from django.db.models import Count, Min
    from django.db.models.functions import TruncDate

    user = require_user(request)
    if not rbac.can_view_audit(user.role):
        raise HttpError(403, "Forbidden")
    events: list[dict] = []

    def add(at, title, detail, by=None):
        events.append({
            "at": at.isoformat() if at else None,
            "title": title,
            "detail": detail,
            "by": by,
        })

    for log in AuditLog.objects.select_related("actor").filter(
        Q(action__icontains="RESTORE") | Q(action__icontains="IMPORT")
    ).order_by("-created_at")[:20]:
        add(log.created_at, log.action.replace("_", " ").capitalize(), "",
            log.actor.name if log.actor else None)

    for batch in PriorImport.objects.select_related("imported_by").order_by("-created_at")[:20]:
        add(batch.created_at, "Payment history loaded",
            f"{batch.row_count:,} payments from {batch.filename}",
            batch.imported_by.name if batch.imported_by_id else None)

    sheets: dict = {}
    for row in (
        Claim.objects.filter(ticket_number__startswith="ERP-")
        .annotate(day=TruncDate("created_at"))
        .values("day", "ticket_number")
    ):
        tag = row["ticket_number"].split("-")[1] if row["ticket_number"].count("-") >= 2 else ""
        per_day = sheets.setdefault(row["day"], {})
        per_day[tag] = per_day.get(tag, 0) + 1
    firsts = dict(
        Claim.objects.filter(ticket_number__startswith="ERP-")
        .annotate(day=TruncDate("created_at")).values("day")
        .annotate(first=Min("created_at")).values_list("day", "first")
    )
    names = {"PROCESSED": "the Processed sheet", "RAW": "Raw_Data (the Google Form's sheet)"}
    for day, tags in sheets.items():
        parts = [f"{n} from {names.get(t, t.title() + ' sheet')}" for t, n in sorted(tags.items())]
        add(firsts.get(day), "Claims brought across from the ERP workbook", ", ".join(parts))

    for row in (
        User.objects.annotate(day=TruncDate("created_at")).values("day")
        .annotate(n=Count("id"), faculty=Count("id", filter=Q(role=Role.FACULTY)), first=Min("created_at"))
        .filter(n__gte=25)
    ):
        add(row["first"], "Accounts created from the roster",
            f"{row['n']:,} accounts, {row['faculty']:,} of them faculty")

    if not visibility.is_contest_blind(user.role):
        for row in (
            AuditLog.objects.filter(action="CLAIM_FLAG_RAISE", actor__isnull=True)
            .annotate(day=TruncDate("created_at")).values("day")
            .annotate(n=Count("id"), first=Min("created_at"))
        ):
            add(row["first"], "The import check raised flags",
                f"{row['n']:,} flags on imported claims — listed below, and on the Flags page")

    events.sort(key=lambda e: e["at"] or "", reverse=True)
    return {"events": events}


@api.get("/admin/payouts", auth=session_auth)
def admin_payouts(
    request: HttpRequest,
    status: str = "CLEARED",
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
    q: Optional[str] = None,
    month: Optional[str] = None,
):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = (
        Claim.objects.select_related(
            "owner", "cleared_by", "second_approved_by", "principal_approved_by", "override_by"
        )
        .prefetch_related("attachments")
        # Finance's desk never carries the officer's own paper
        # (`rbac.is_own_claim`); another officer, or the super admin, pays it.
        .exclude(owner=user)
    )
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
    # Find by name, staff id, claim number, voucher or title; narrow to one
    # month paid. Done here so a search covers every payment, not the page.
    term = (q or "").strip()
    if term:
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(voucher_number__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(owner__staff_id__icontains=term)
            | Q(staff_id__icontains=term)
        )
    if month:
        try:
            y, m = (int(x) for x in month.split("-"))
            qs = qs.filter(payout_month=date(y, m, 1))
        except ValueError:
            raise HttpError(400, "Month must look like 2026-08")
    qs = qs.order_by(_CLAIM_SORTS.get(sort, default_order))
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    results = [claim_to_dict(c) for c in qs[offset : offset + limit]]
    # Whole-queue figures and each row's position on the ledger: the Finance
    # desk decides a run from the total, and checks a claim is not paid yet.
    payments_desk.attach_ledger(results)
    if status == "PAID":
        totals = payments_desk.paid_totals(qs)
    elif status in ("CLEARED", "PRINCIPAL_APPROVED", "DIRECTOR_APPROVED", "FINANCE_APPROVED"):
        totals = payments_desk.payable_totals(qs)
    else:
        totals = None
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "totals": totals,
        "results": results,
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
def admin_clearing_queue(
    request: HttpRequest, status: Optional[str] = None, assigned: Optional[str] = None
):
    """Submitted tickets waiting on admin clearing — the only approval step.

    `assigned` narrows to what the coordination desk gave `me`, gave somebody
    else (their id), or gave nobody (`none`). Each row carries `assigned_to`."""
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    qs = (
        Claim.objects.select_related("owner")
        .prefetch_related("attachments")
        .select_related("assigned_to")
        # Never the clearer's own paper: another officer at the desk, or the
        # super admin, clears it (`rbac.is_own_claim`).
        .exclude(owner=user)
    )
    if status and status != "ALL":
        qs = qs.filter(status=status)
    else:
        qs = qs.filter(status=ClaimStatus.SUBMITTED)
    qs = coordination.assigned_filter(qs, user, assigned)
    # Oldest first: the ticket that has waited longest is the one to clear next.
    claims = list(qs.order_by("submitted_at", "created_at")[:200])
    record = record_authorships(claims)
    return [
        {**claim_to_dict(c), **record[c.id], "assigned_to": coordination.assignee_dict(c)}
        for c in claims
    ]




__all__ = [
    'ASSIGNABLE_ROLES',
    'PRIVILEGED_ROLES',
    'ScimagoSyncIn',
    '_check_assignable_role',
    '_check_privileged_assignment',
    'admin_audit',
    'admin_clearing_queue',
    'admin_create_user',
    'admin_issue_passwords',
    'admin_payouts',
    'admin_reset_password',
    'admin_reset_password_by_email',
    'admin_update_user',
    'admin_user_detail',
    'admin_users',
    'get_formula',
    'prior_import',
    'put_formula',
    'scimago_import',
    'scimago_stats',
    'scimago_sync',
]


#: Statuses whose amount is still open to change. Paid, rejected and withdrawn
#: tickets keep the amount they were settled on; a draft reprices on submit.
_REPRICEABLE = (
    ClaimStatus.SUBMITTED,
    ClaimStatus.CLEARED,
    ClaimStatus.PRINCIPAL_APPROVED,
    ClaimStatus.DIRECTOR_APPROVED,
)


@api.post("/admin/formula/preview", auth=session_auth)
def preview_formula(request: HttpRequest, payload: FormulaIn):
    """Before/after: what every open claim is worth now, and under this draft.

    Nothing is saved. Paid tickets are not repriced by a new version, so they
    are not listed. A research faculty member's yearly threshold is spent in
    the order claims are paid under either version, so the payable amounts on
    both sides are after it; what it absorbs is reported per person under
    `threshold`.
    """
    from core.api.common import price_claim
    from core.services.remuneration import formula_from_model
    user = require_user(request)
    if not rbac.can_edit_formula(user.role):
        raise HttpError(403, "Forbidden")
    live = FormulaConfig.objects.filter(active=True).order_by("-version").first()
    fields = payload.dict()
    for k in ("effective_from", "effective_to", "filing_cutoff_day", "research_year_start_month"):
        fields.pop(k, None)
    if fields.get("student_project_amount") is None:
        fields["student_project_amount"] = (
            live.student_project_amount if live else DEFAULT_STUDENT_PROJECT_AMOUNT
        )
    if not fields.get("publication_type_multipliers_json"):
        fields["publication_type_multipliers_json"] = json.dumps(DEFAULT_PUB_TYPE_MULTIPLIERS)
    try:
        json.loads(fields["author_point_json"])
    except Exception:
        raise HttpError(400, "Invalid author_point_json")
    draft = FormulaConfig(**fields)
    before_cfg = formula_from_model(live) if live else None
    after_cfg = formula_from_model(draft)

    changed = []
    count = 0
    before_total = 0.0
    after_total = 0.0
    qs = (
        Claim.objects.filter(status__in=_REPRICEABLE)
        .select_related("owner")
        .order_by("-updated_at")
    )
    priced = []
    by_owner: dict = {}
    for c in qs.iterator():
        b = price_claim(c, before_cfg).remuneration or 0.0
        a = price_claim(c, after_cfg).remuneration or 0.0
        priced.append((c, b, a))
        if research_threshold.is_research(c.owner) and research_threshold.applies_to(c):
            by_owner.setdefault(c.owner_id, (c.owner, {}, {}))
            by_owner[c.owner_id][1][c.id] = b
            by_owner[c.owner_id][2][c.id] = a
    # A research faculty member's threshold takes its part off each claim under
    # either version of the policy, in the order claims are paid; what it takes
    # is reported per person so the admin sees what the threshold absorbs.
    absorbed_before: dict = {}
    absorbed_after: dict = {}
    people: dict = {}
    for owner_id, (owner, fb, fa) in by_owner.items():
        pb = research_threshold.plan(owner, fulls=fb)
        pa = research_threshold.plan(owner, fulls=fa)
        if pb.unset:
            continue
        for cid, e in pb.effects.items():
            absorbed_before[cid] = e.absorbed
        for cid, e in pa.effects.items():
            absorbed_after[cid] = e.absorbed
        people[owner_id] = {
            "user_id": owner.id,
            "name": owner.name,
            "threshold": pb.threshold,
            "claims_inside": 0,
            "absorbed_before": 0.0,
            "absorbed_after": 0.0,
            "tickets": [],
        }
    for c, b, a in priced:
        count += 1
        ab, aa = absorbed_before.get(c.id, 0.0), absorbed_after.get(c.id, 0.0)
        row = people.get(c.owner_id)
        if row is not None and (ab > 0 or aa > 0):
            row["claims_inside"] += 1
            row["absorbed_before"] = round(row["absorbed_before"] + ab, 2)
            row["absorbed_after"] = round(row["absorbed_after"] + aa, 2)
            row["tickets"].append(c.ticket_number)
        b -= ab
        a -= aa
        before_total += b
        after_total += a
        if round(a, 2) != round(b, 2):
            changed.append({
                "id": c.id,
                "ticket_number": c.ticket_number,
                "title": c.paper_title,
                "owner": c.owner.name if c.owner_id else None,
                "status": c.status,
                "before": round(b, 2),
                "after": round(a, 2),
            })
    changed.sort(key=lambda r: abs(r["after"] - r["before"]), reverse=True)
    inside = [r for r in people.values() if r["claims_inside"]]
    return {
        "live_version": live.version if live else None,
        "open_claims": count,
        "changed_count": len(changed),
        "before_total": round(before_total, 2),
        "after_total": round(after_total, 2),
        "changed": changed[:200],
        "threshold": sorted(inside, key=lambda r: r["name"] or ""),
        "threshold_claims": sum(r["claims_inside"] for r in inside),
    }
