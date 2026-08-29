"""the auth dependency, and the endpoints reachable while a password change is owed.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api

from datetime import date, datetime
from typing import Any
from django.http import HttpRequest
from ninja.errors import HttpError
from core.models import Claim, ClaimStatus, User
from core.services import rbac
from core.services.scimago import lookup_scimago
from core.services.scopus import author_profile_url

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




__all__ = [
    'IMPERSONATOR_KEY',
    '_PASSWORD_CHANGE_EXEMPT',
    '_format_payout_month',
    '_me_dict',
    '_quartile_year_note',
    '_snip_year_note',
    '_user_dict',
    'claim_to_dict',
    'impersonator_of',
    'require_user',
]
