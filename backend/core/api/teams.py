"""student project teams.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.schemas import ATTACHMENT_LIMITS
from core.api.deps import require_user
from core.api.lookups import MAX_UPLOAD_BYTES

import json
import time
from typing import Any, Optional
from django.db import transaction
from django.db.models import Q
from django.http import HttpRequest
from ninja import File, Schema
from ninja.errors import HttpError
from core.models import AttachmentKind, AuditLog, Claim, FacultyMaster, FormulaConfig, Role, Team, TeamMember, User
from core.services import rbac
from core.services.remuneration import MAX_ELIGIBLE_AUTHORS, MIN_SEC_REFERENCES

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




__all__ = [
    'TeamIn',
    'TeamMemberIn',
    '_min_sec_references',
    '_numbered_sec_references',
    '_team_dict',
    'filing_rules',
    'get_team',
    'list_departments',
    'list_teams',
    'upsert_team',
]
