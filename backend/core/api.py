from __future__ import annotations

import csv
import io
import json
import logging
from datetime import date, datetime
from typing import Any, Optional

from django.contrib.auth import authenticate, login, logout
from django.db import transaction
from django.db.models import Q
from django.http import HttpRequest, HttpResponse
from django.middleware.csrf import get_token
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import NinjaAPI, Schema, UploadedFile, File, Form
from ninja.errors import HttpError
from ninja.security import SessionAuth

logger = logging.getLogger("core.api")

from core.models import (
    AuditLog,
    Claim,
    ClaimAction,
    ClaimStatus,
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
from core.services.normalize import normalize_doi, normalize_title
from core.services.remuneration import (
    DEFAULT_AUTHOR_POINTS,
    DEFAULT_PUB_TYPE_MULTIPLIERS,
    calculate_remuneration,
    formula_from_model,
    snapshot_formula,
)
from core.services.notify_email import send_optional_email
from core.services.scimago import lookup_scimago, parse_categories_field
from core.services.scopus import ScopusError, lookup_paper_by_doi, lookup_serial_by_issn, search_by_title
from core.services.tickets import next_ticket_number
from core.services.verify import apply_verify_to_claim, check_already_paid, verify_publication

api = NinjaAPI(title="Faculty Remuneration", version="1.0.0")
session_auth = SessionAuth()


def _require_admin_ops(user: User) -> None:
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")


@api.get("/health", auth=None)
def health(request: HttpRequest):
    return {"ok": True, "service": "faculty-paper-api", "time": timezone.now().isoformat()}


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


def _notify_hods(claim: Claim, title: str, body: str) -> None:
    dept = claim.owner.department
    qs = User.objects.filter(role=Role.HOD, active=True)
    if dept:
        qs = qs.filter(department__iexact=dept)
    for u in qs:
        Notification.objects.create(
            user=u,
            title=title,
            body=body,
            href=f"/hod?claim={claim.id}",
            claim_id=claim.id,
        )


def _notify_principals(claim: Claim, title: str, body: str) -> None:
    for u in User.objects.filter(role=Role.PRINCIPAL, active=True):
        Notification.objects.create(
            user=u,
            title=title,
            body=body,
            href=f"/principal?claim={claim.id}",
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


class ClaimIn(Schema):
    doi: Optional[str] = None
    issn: Optional[str] = None
    journal_title: Optional[str] = None
    paper_title: Optional[str] = None
    publication_year: Optional[int] = None
    publication_date: Optional[str] = None
    publication_type: Optional[str] = None
    indexing_level: Optional[str] = None
    yukthi_id: Optional[str] = None
    self_reported_quartile: Optional[str] = None
    impact_factor: Optional[str] = None
    proof_url: Optional[str] = None
    sec_refs: Optional[str] = None
    sec_proof_url: Optional[str] = None
    is_student_publication: bool = False
    affiliation_ok: bool = True
    payout_month: Optional[str] = None
    subject_category: Optional[str] = None
    subjects_json: Optional[str] = None
    snip: Optional[float] = None
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


# Fields faculty may set — verification / money / identity are server-owned
_FACULTY_WRITABLE = {
    "doi",
    "issn",
    "journal_title",
    "paper_title",
    "publication_year",
    "publication_date",
    "publication_type",
    "indexing_level",
    "yukthi_id",
    "self_reported_quartile",
    "impact_factor",
    "proof_url",
    "sec_refs",
    "sec_proof_url",
    "is_student_publication",
    "affiliation_ok",
    "payout_month",
    "subject_category",
    "subjects_json",
    "snip",
    "snip_year",
    "quartile",
    "manual_quartile_reason",
    "total_authors",
    "author_position",
    "authors_json",
    "year_mismatch",
    "year_mismatch_override",
    "year_mismatch_reason",
    "eid",
    "scopus_url",
    "cover_date",
    "aggregation_type",
    "engineering_class",
}


def _apply_faculty_payload(claim: Claim, payload: ClaimIn) -> None:
    data = payload.dict(exclude={"submit", "contest_forward", "contest_note"}, exclude_unset=True)
    for k, v in data.items():
        if k not in _FACULTY_WRITABLE:
            continue
        if k == "payout_month":
            claim.payout_month = _parse_payout_month(v)
        elif k == "total_authors":
            claim.total_authors = max(1, min(int(v or 1), 50))
        elif k == "author_position":
            claim.author_position = max(1, min(int(v or 1), 50))
        elif k == "snip" and v is not None:
            claim.snip = float(v)
        elif hasattr(claim, k):
            setattr(claim, k, v)
    # Never trust client verification / override flags
    claim.scimago_verified = False
    claim.override_duplicate = False
    claim.override_reason = None


def _bind_identity_from_user(claim: Claim, user: User) -> None:
    claim.staff_id = user.staff_id
    claim.biometric_id = user.biometric_id
    claim.designation = user.designation
    claim.scopus_author_url = user.scopus_author_url
    claim.scopus_author_id = user.scopus_author_id


class ActionIn(Schema):
    note: Optional[str] = None
    voucher_number: Optional[str] = None


class CalcIn(Schema):
    snip: Optional[float] = None
    quartile: Optional[str] = None
    total_authors: int = 1
    author_position: int = 1
    publication_type: Optional[str] = None
    is_student_publication: bool = False


class ResetPasswordByEmailIn(Schema):
    email: str
    password: str


class ScopusLookupIn(Schema):
    doi: Optional[str] = None
    title: Optional[str] = None
    issn: Optional[str] = None


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


class MonthlyCreateIn(Schema):
    name: str
    rows: list[dict[str, Any]]


def require_user(request: HttpRequest) -> User:
    if not request.user.is_authenticated:
        raise HttpError(401, "Unauthorized")
    user: User = request.user  # type: ignore
    if not user.active:
        raise HttpError(403, "Inactive")
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
        "indexing_status": c.indexing_status,
        "linkage_status": c.linkage_status,
        "is_student_publication": c.is_student_publication,
        "affiliation_ok": c.affiliation_ok,
        "payout_month": _format_payout_month(c.payout_month),
        "subject_category": c.subject_category,
        "subjects_json": c.subjects_json,
        "snip": c.snip,
        "snip_year": c.snip_year,
        "quartile": c.quartile,
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
        "duplicate_warning": c.duplicate_warning,
        "duplicate_matches_json": c.duplicate_matches_json,
        "override_duplicate": c.override_duplicate,
        "override_reason": c.override_reason,
        "year_mismatch": c.year_mismatch,
        "year_mismatch_override": c.year_mismatch_override,
        "year_mismatch_reason": c.year_mismatch_reason,
        "voucher_number": c.voucher_number,
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


@api.post("/auth/login")
def auth_login(request: HttpRequest, payload: LoginIn):
    user = authenticate(
        request, username=payload.email.strip().lower(), password=payload.password
    )
    if not user:
        raise HttpError(401, "Invalid credentials")
    if not getattr(user, "active", True):
        raise HttpError(403, "Inactive account")
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
    name: Optional[str] = None
    department: Optional[str] = None
    staff_id: Optional[str] = None
    biometric_id: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None


@api.patch("/auth/profile", auth=session_auth)
def update_profile(request: HttpRequest, payload: ProfileUpdateIn):
    u = require_user(request)
    data = payload.dict(exclude_unset=True)
    for k, v in data.items():
        setattr(u, k, v)
    u.save()
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


@api.post("/lookup/enrich", auth=session_auth)
def lookup_enrich(request: HttpRequest, payload: ScopusLookupIn):
    """One-shot: Scopus paper + SNIP + Scimago quartile for Faculty form."""
    require_user(request)
    if not payload.doi and not payload.title:
        return {
            "ok": False,
            "code": "bad_payload",
            "message": "Provide DOI or title",
            "paper": None,
            "serial": None,
            "scimago": None,
        }
    try:
        paper = lookup_paper_by_doi(payload.doi) if payload.doi else None
        if not paper and payload.title:
            paper, _ = search_by_title(payload.title)
        if not paper:
            return {
                "ok": False,
                "code": "not_found",
                "message": "Not found in Scopus",
                "paper": None,
                "serial": None,
                "scimago": None,
            }
        serial = lookup_serial_by_issn(paper.get("issn") or "") if paper.get("issn") else None
        scimago = lookup_scimago(
            issn=paper.get("issn"),
            title=paper.get("journal_title"),
            subject=None,
        )
        return {
            "ok": True,
            "code": "ok",
            "message": None,
            "paper": paper,
            "serial": serial,
            "scimago": scimago,
            "matched_title": paper.get("title"),
            "doi": paper.get("doi"),
            "issn": paper.get("issn"),
            "eid": paper.get("eid"),
            "journal": paper.get("journal_title"),
            "cover_date": paper.get("cover_date"),
            "snip": (serial or {}).get("snip") if serial else None,
            "snip_year": (serial or {}).get("snip_year") if serial else None,
            "quartile": (scimago or {}).get("matched_quartile") if scimago and scimago.get("found") else None,
            "scimago_found": bool(scimago and scimago.get("found")),
        }
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
    )
    return {
        "base": result.base,
        "point": result.point,
        "remuneration": result.remuneration,
        "qf": result.qf,
        "error": result.error,
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


# ---------- claims ----------


def _claims_queryset(user: User):
    qs = Claim.objects.select_related("owner").all()
    if user.role == Role.HOD:
        if user.department:
            return qs.filter(owner__department__iexact=user.department)
        return qs.none()
    if rbac.can_view_college_wide(user.role):
        return qs
    return qs.filter(owner=user)


def _apply_calc(claim: Claim) -> None:
    cfg_obj = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = formula_from_model(cfg_obj) if cfg_obj else None
    pub_type = claim.aggregation_type or claim.publication_type
    result = calculate_remuneration(
        claim.snip,
        claim.quartile,
        claim.total_authors,
        claim.author_position,
        cfg,
        is_student_publication=claim.is_student_publication,
        publication_type=pub_type,
    )
    claim.base_amount = result.base
    claim.author_point = result.point
    claim.remuneration = result.remuneration
    claim.qf_amount = result.qf
    claim.calc_error = result.error
    if cfg_obj and cfg:
        claim.formula_config = cfg_obj
        claim.formula_snapshot_json = json.dumps(snapshot_formula(cfg))
    elif cfg:
        claim.formula_snapshot_json = json.dumps(snapshot_formula(cfg))


@api.get("/claims", auth=session_auth)
def list_claims(request: HttpRequest, status: Optional[str] = None):
    user = require_user(request)
    qs = _claims_queryset(user).order_by("-updated_at")
    if status:
        qs = qs.filter(status=status)
    return [claim_to_dict(c) for c in qs[:200]]


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
    if user.role not in (Role.FACULTY, Role.SUPER_ADMIN):
        raise HttpError(403, "Only faculty can create tickets")
    claim = Claim(owner=user)
    _apply_faculty_payload(claim, payload)
    _bind_identity_from_user(claim, user)

    paid_check = check_already_paid(
        title=claim.paper_title,
        doi=claim.doi,
        staff_id=claim.staff_id,
        exclude_claim_id=None,
    )
    claim.duplicate_warning = bool(paid_check.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid_check.get("matches") or [])

    _apply_calc(claim)
    if payload.submit:
        _submit_claim(claim, user, contest=bool(payload.contest_forward), contest_note=payload.contest_note)
    else:
        claim.save()
        ClaimAction.objects.create(
            claim=claim,
            actor=user,
            from_status=None,
            to_status=claim.status,
            action="CREATE_DRAFT",
        )
    return claim_to_dict(claim)


def _submit_claim(claim: Claim, user: User, *, contest: bool, contest_note: str | None) -> None:
    if not (claim.paper_title or "").strip():
        raise HttpError(400, "Paper title is required")

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

    if not claim.quartile:
        if contest:
            # allow forward without quartile only with a note; leave blank for HoD
            pass
        else:
            raise HttpError(400, "Pick a journal ranking (Q1–Q4), or send with a note")

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

    if not claim.ticket_number:
        claim.ticket_number = next_ticket_number()

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
    _notify_hods(
        claim,
        f"Ticket {claim.ticket_number}",
        f"{'Needs review: ' if claim.contest_forward else ''}{claim.paper_title}",
    )


@api.patch("/claims/{claim_id}", auth=session_auth)
def patch_claim(request: HttpRequest, claim_id: str, payload: ClaimIn):
    user = require_user(request)
    claim = get_object_or_404(Claim, pk=claim_id, owner=user)
    if claim.status not in (ClaimStatus.DRAFT, ClaimStatus.REJECTED):
        raise HttpError(400, "Only draft/rejected claims can be edited")
    _apply_faculty_payload(claim, payload)
    _bind_identity_from_user(claim, user)
    paid_check = check_already_paid(
        title=claim.paper_title,
        doi=claim.doi,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id,
    )
    claim.duplicate_warning = bool(paid_check.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid_check.get("matches") or [])
    _apply_calc(claim)
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
    else:
        claim.save()
    return claim_to_dict(claim)


def _faculty_status_copy(to_status: str, note: str | None = None) -> tuple[str, str]:
    """Short faculty-facing notification title/body — no internal process detail."""
    if to_status == ClaimStatus.HOD_APPROVED:
        return ("Approved by HoD", "Your ticket was approved by HoD and is with the Principal.")
    if to_status == ClaimStatus.PRINCIPAL_APPROVED:
        return (
            "Approved — payment ordered",
            "Your ticket is approved. Finance has been ordered to process the payment.",
        )
    if to_status == ClaimStatus.PAID:
        return (
            "Payment cleared",
            "Your payment has been cleared and will be processed shortly.",
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


@api.post("/claims/{claim_id}/hod-approve", auth=session_auth)
def hod_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    user = require_user(request)
    if not rbac.can_approve_as_hod(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(_claims_queryset(user).select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.SUBMITTED:
            raise HttpError(400, "Invalid status for HoD approve")
        _transition(claim, user, ClaimStatus.HOD_APPROVED, "HOD_APPROVE", payload.note)
    _notify_principals(claim, f"Ticket {claim.ticket_number}", f"HoD approved: {claim.paper_title}")
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/principal-approve", auth=session_auth)
def principal_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    user = require_user(request)
    if not rbac.can_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.HOD_APPROVED:
            raise HttpError(400, "Invalid status for Principal approve")
        _transition(claim, user, ClaimStatus.PRINCIPAL_APPROVED, "PRINCIPAL_APPROVE", payload.note)
        amount = claim.remuneration or 0
    _notify_finance(
        claim,
        f"Pay order · {claim.ticket_number}",
        f"Please process payment of ₹{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
    )
    return claim_to_dict(claim)


# Legacy aliases
@api.post("/claims/{claim_id}/approve", auth=session_auth)
def admin_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Backward-compatible: route by current status + role."""
    user = require_user(request)
    claim = get_object_or_404(Claim, pk=claim_id)
    if claim.status == ClaimStatus.SUBMITTED and rbac.can_approve_as_hod(user.role):
        return hod_approve(request, claim_id, payload)
    if claim.status == ClaimStatus.HOD_APPROVED and rbac.can_approve_as_principal(user.role):
        return principal_approve(request, claim_id, payload)
    raise HttpError(400, "Use role-specific approve endpoints")


@api.post("/claims/{claim_id}/research-approve", auth=session_auth)
def research_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    return principal_approve(request, claim_id, payload)


@api.post("/claims/{claim_id}/finance-approve", auth=session_auth)
def finance_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """No separate finance approve hop — Principal lands in Finance queue."""
    raise HttpError(400, "Finance marks paid directly after Principal approval")


@api.post("/claims/{claim_id}/mark-paid", auth=session_auth)
def mark_paid(request: HttpRequest, claim_id: str, payload: ActionIn):
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status not in (ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.FINANCE_APPROVED):
            raise HttpError(400, "Invalid status — Principal approval required")
        if PaidLedger.objects.filter(claim=claim).exists():
            raise HttpError(400, "Already processed")
        if payload.voucher_number:
            claim.voucher_number = payload.voucher_number[:64]
        _transition(claim, user, ClaimStatus.PAID, "MARK_PAID", payload.note)
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
            voucher_number=claim.voucher_number or payload.voucher_number,
        )
    return claim_to_dict(claim)


@api.post("/claims/{claim_id}/reject", auth=session_auth)
def reject_claim(request: HttpRequest, claim_id: str, payload: ActionIn):
    user = require_user(request)
    if not (
        rbac.can_approve_as_hod(user.role)
        or rbac.can_approve_as_principal(user.role)
        or rbac.can_approve_as_finance(user.role)
    ):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(_claims_queryset(user) if user.role == Role.HOD else Claim.objects.all(), pk=claim_id)
    if claim.status not in (
        ClaimStatus.SUBMITTED,
        ClaimStatus.HOD_APPROVED,
        ClaimStatus.PRINCIPAL_APPROVED,
        ClaimStatus.FINANCE_APPROVED,
    ):
        raise HttpError(400, "Invalid status for reject")
    if payload.note:
        claim.status_note = payload.note[:255]
        claim.save(update_fields=["status_note"])
    _transition(claim, user, ClaimStatus.REJECTED, "REJECT", payload.note)
    return claim_to_dict(claim)


def _verify_claim(claim: Claim) -> Claim:
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


# ---------- dashboard ----------


@api.get("/dashboard", auth=session_auth)
def dashboard(request: HttpRequest):
    user = require_user(request)
    qs = _claims_queryset(user)
    by_status = {}
    for s in ClaimStatus.values:
        by_status[s] = qs.filter(status=s).count()
    recent = [claim_to_dict(c) for c in qs.order_by("-updated_at")[:10]]
    total_paid = (
        qs.filter(status=ClaimStatus.PAID).aggregate_sum
        if False
        else sum(c.remuneration or 0 for c in qs.filter(status=ClaimStatus.PAID))
    )
    return {"by_status": by_status, "recent": recent, "total_paid": total_paid}


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
    for k, v in data.items():
        setattr(u, k, v)
    u.save()
    AuditLog.objects.create(
        actor=actor, action="USER_UPDATE", entity="User", entity_id=u.id
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
    AuditLog.objects.create(
        actor=actor, action="USER_RESET_PASSWORD", entity="User", entity_id=u.id
    )
    return {"ok": True}


@api.post("/admin/users/reset-password", auth=session_auth)
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
    AuditLog.objects.create(
        actor=actor, action="USER_RESET_PASSWORD", entity="User", entity_id=u.id
    )
    return {"ok": True}


@api.get("/admin/formula", auth=session_auth)
def get_formula(request: HttpRequest):
    require_user(request)
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
        "notes": cfg.notes,
    }


@api.put("/admin/formula", auth=session_auth)
def put_formula(request: HttpRequest, payload: FormulaIn):
    user = require_user(request)
    if not rbac.can_edit_formula(user.role):
        raise HttpError(403, "Forbidden")
    prev = FormulaConfig.objects.filter(active=True).order_by("-version").first()
    next_version = (prev.version + 1) if prev else 1
    FormulaConfig.objects.filter(active=True).update(active=False)
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
    pub_json = payload.publication_type_multipliers_json or json.dumps(DEFAULT_PUB_TYPE_MULTIPLIERS)
    try:
        json.loads(pub_json)
    except Exception:
        raise HttpError(400, "Invalid publication_type_multipliers_json")
    try:
        json.loads(payload.author_point_json)
    except Exception:
        raise HttpError(400, "Invalid author_point_json")
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
        notes=payload.notes,
        updated_by=user,
        active=True,
    )
    AuditLog.objects.create(
        actor=user,
        action="FORMULA_UPDATE",
        entity="FormulaConfig",
        entity_id=cfg.id,
        detail_json=json.dumps({"version": cfg.version, "name": cfg.name}),
    )
    return {"id": cfg.id, "version": cfg.version, "name": cfg.name}


@api.get("/admin/audit", auth=session_auth)
def admin_audit(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_view_audit(user.role):
        raise HttpError(403, "Forbidden")
    logs = AuditLog.objects.select_related("actor").order_by("-created_at")[:100]
    return [
        {
            "id": l.id,
            "action": l.action,
            "entity": l.entity,
            "entity_id": l.entity_id,
            "actor": l.actor.email if l.actor else None,
            "created_at": l.created_at.isoformat(),
        }
        for l in logs
    ]


@api.get("/admin/payouts", auth=session_auth)
def admin_payouts(request: HttpRequest, status: str = "PRINCIPAL_APPROVED"):
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    qs = Claim.objects.select_related("owner")
    if status == "PAID":
        qs = qs.filter(status=ClaimStatus.PAID).order_by("-paid_at")
    elif status == "FINANCE_APPROVED":
        # legacy alias → Principal-approved queue
        qs = qs.filter(
            status__in=(ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.FINANCE_APPROVED)
        ).order_by("-updated_at")
    else:
        qs = qs.filter(status=status).order_by("-updated_at")
    return [claim_to_dict(c) for c in qs[:200]]


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
    reader = csv.DictReader(io.StringIO(content))
    n = 0
    for row in reader:
        title = row.get("Title") or row.get("title") or ""
        issn = row.get("Issn") or row.get("ISSN") or row.get("issn")
        eissn = row.get("EISSN") or row.get("eissn")
        sjr_raw = row.get("SJR") or row.get("sjr")
        cats = row.get("Categories") or row.get("categories") or ""
        try:
            sjr = float(str(sjr_raw).replace(",", "")) if sjr_raw else None
        except ValueError:
            sjr = None
        if not title:
            continue
        issn_n = (issn or "").split(",")[0].strip() if issn else None
        ScimagoJournal.objects.update_or_create(
            issn=issn_n or f"TITLE:{title[:40]}",
            year=year,
            defaults={
                "title": title[:512],
                "eissn": eissn,
                "sjr": sjr,
                "categories_json": json.dumps(parse_categories_field(cats)),
                "raw_json": json.dumps(row)[:50000],
            },
        )
        n += 1
    AuditLog.objects.create(
        actor=user, action="SCIMAGO_IMPORT", entity="ScimagoJournal", detail_json=json.dumps({"n": n, "year": year})
    )
    return {"imported": n}


@api.post("/admin/prior/import", auth=session_auth)
def prior_import(request: HttpRequest, file: UploadedFile = File(...)):
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read().decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(content))
    batch = PriorImport.objects.create(
        filename=file.name or "upload.csv",
        row_count=0,
        mapping_json="{}",
        imported_by=user,
    )
    n = 0
    for row in reader:
        title = row.get("paper_title") or row.get("title") or row.get("Paper Title")
        doi = row.get("doi") or row.get("DOI")
        PriorPayment.objects.create(
            faculty_name=row.get("faculty_name") or row.get("name"),
            employee_id=row.get("employee_id"),
            paper_title=title,
            normalized_title=normalize_title(title) if title else None,
            doi=normalize_doi(doi) if doi else None,
            issn=row.get("issn"),
            journal_title=row.get("journal"),
            amount_paid=float(row["amount"]) if row.get("amount") else None,
            raw_json=json.dumps(row),
            import_batch=batch,
        )
        n += 1
    batch.row_count = n
    batch.save()
    return {"imported": n, "batch_id": batch.id}


# ---------- process queue ----------


@api.get("/admin/process", auth=session_auth)
def admin_process_queue(request: HttpRequest, status: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    qs = Claim.objects.select_related("owner").order_by("-updated_at")
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
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    results = []
    for cid in payload.claim_ids:
        claim = Claim.objects.filter(pk=cid).first()
        if not claim:
            results.append({"id": cid, "ok": False, "error": "Not found"})
            continue
        if not (claim.paper_title or "").strip():
            results.append({"id": cid, "ok": False, "error": "No paper title"})
            continue
        try:
            _verify_claim(claim)
            ClaimAction.objects.create(
                claim=claim,
                actor=user,
                from_status=claim.status,
                to_status=claim.status,
                action="VERIFY_BATCH",
            )
            results.append({"id": cid, "ok": True, "claim": claim_to_dict(claim)})
        except Exception as e:
            results.append({"id": cid, "ok": False, "error": str(e)})
    return {"results": results}


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
        issn_key = (print_issn or e_issn or f"TITLE:{title[:40]}").split(",")[0].strip()
        SnipSource.objects.update_or_create(
            print_issn=issn_key,
            year=year,
            defaults={
                "title": title[:512],
                "e_issn": e_issn,
                "snip": snip,
                "sjr": sjr,
                "source_id": source_id,
                "raw_json": json.dumps(row)[:50000],
            },
        )
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
def admin_ledger(request: HttpRequest, month: Optional[str] = None, department: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
        raise HttpError(403, "Forbidden")
    qs = _ledger_queryset(month, department)
    return [_ledger_row_dict(r) for r in qs[:500]]


@api.get("/admin/ledger/export", auth=session_auth)
def admin_ledger_export(request: HttpRequest, month: Optional[str] = None, department: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_approve_as_finance(user.role):
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
        raise HttpError(400, "Already running")
    start_batch_async(batch.id)
    return {"ok": True, "status": "RUNNING"}


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
    resp = HttpResponse(buf.getvalue(), content_type="text/csv")
    resp["Content-Disposition"] = f'attachment; filename="monthly-{batch.id}.csv"'
    return resp
