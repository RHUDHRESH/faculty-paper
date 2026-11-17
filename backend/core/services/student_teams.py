"""The student teams on the roster, as the people who may look at them see them.

`core.services.student_projects` holds the rule a claim is held to. This is
the other half: who may see which team, how a team is listed and searched, and
the plain pass or fail lines a reviewer reads before clearing a student-project
claim.

Who sees what (the college's rule, 2026-11):

- The research office, the Principal and the Director see every team.
- A head of department sees their department's teams, and never a rupee: the
  claim on a team shows its stage, not its amount.
- Anybody else sees the teams they mentor and nothing else. A team is a
  mentor's own project; a list of every student in the college is not theirs
  to browse.
"""
from __future__ import annotations

from typing import Any, Iterable, Optional

from django.db.models import Q, QuerySet

from core import hod
from core.models import Claim, Role, Team, TeamMember, User
from core.services import claim_numbers, rbac
from core.services.claim_scope import hide_others_drafts
from core.services.remuneration import is_conference_paper
from core.services.student_projects import claim_holding, holding_claims, mentor_label
from core.visibility import faculty_stage

#: Who sees every team on the roster.
SEES_ALL = (*rbac.ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR)

#: The status filter's words. More than one, joined by commas, must all hold:
#: "with_publication,unclaimed" is the office's own question, a team that has
#: written a paper and has not been paid for it.
STATUS_WORDS = ("claimed", "unclaimed", "with_publication", "no_publication")


def sees_money(user: User) -> bool:
    """A head of department is blind to money on every screen but their own paper."""
    return user.role != Role.HOD


def visible_teams(user: User) -> QuerySet[Team]:
    qs = Team.objects.all()
    if user.role in SEES_ALL:
        return qs
    own = Q(mentor=user)
    if user.role == Role.HOD:
        departments = _departments_like(hod.department_of(user))
        if departments:
            return qs.filter(own | Q(department__in=departments))
    return qs.filter(own)


def may_see(user: User, team: Team) -> bool:
    return visible_teams(user).filter(pk=team.pk).exists()


def _departments_like(name: str | None) -> list[str]:
    """Every spelling the roster uses for the department `name` is."""
    from core.services.college_totals import canonical_departments

    if not (name or "").strip():
        return []
    canon = canonical_departments()
    want = canon(name)
    spellings = {
        d
        for d in Team.objects.exclude(department__isnull=True).values_list("department", flat=True).distinct()
        if d and canon(d) == want
    }
    return sorted(spellings)


def _with_publications(qs: QuerySet[Team]) -> set[str]:
    """Ids of the teams that list at least one article.

    Read in Python rather than by a JSON lookup: "an empty list" is spelt
    differently by each database, and the roster is a few thousand teams.
    """
    return {pk for pk, pubs in qs.values_list("id", "publications") if pubs}


def _articles_matching(qs: QuerySet[Team], term: str) -> set[str]:
    needle = term.casefold()
    hits: set[str] = set()
    for pk, pubs in qs.values_list("id", "publications"):
        for p in pubs or []:
            if not isinstance(p, dict):
                continue
            text = " ".join(str(p.get(k) or "") for k in ("article_title", "source_title", "doi")).casefold()
            if needle in text:
                hits.add(pk)
                break
    return hits


def filtered(
    user: User,
    *,
    academic_year: Optional[str] = None,
    department: Optional[str] = None,
    mentor: Optional[str] = None,
    q: Optional[str] = None,
    status: Optional[str] = None,
    articles: bool = True,
) -> QuerySet[Team]:
    """The teams `user` may see, narrowed by what was asked for."""
    qs = visible_teams(user)

    if (academic_year or "").strip():
        qs = qs.filter(academic_year=academic_year.strip())
    if (department or "").strip():
        qs = qs.filter(department__in=_departments_like(department) or [department.strip()])
    if (mentor or "").strip():
        m = mentor.strip()
        qs = qs.filter(
            Q(mentor_staff_id__iexact=m) | Q(mentor__staff_id__iexact=m) | Q(mentor_id=m)
        )

    term = " ".join((q or "").split())
    if term:
        by_article = _articles_matching(qs, term) if articles else set()
        qs = qs.filter(
            Q(code__icontains=term)
            | Q(title__icontains=term)
            | Q(pk__in=TeamMember.objects.filter(Q(name__icontains=term) | Q(register_number__icontains=term)).values("team_id"))
            | Q(mentor_name__icontains=term)
            | Q(mentor__name__icontains=term)
            | Q(mentor_staff_id__iexact=term)
            | Q(pk__in=by_article)
        )

    for word in [w.strip() for w in (status or "").split(",") if w.strip()]:
        if word == "claimed":
            qs = qs.filter(pk__in=holding_claims().values("team_id"))
        elif word == "unclaimed":
            qs = qs.exclude(pk__in=holding_claims().values("team_id"))
        elif word == "with_publication":
            qs = qs.filter(pk__in=_with_publications(qs))
        elif word == "no_publication":
            qs = qs.exclude(pk__in=_with_publications(qs))
    return qs


def _stage(viewer: User, c: Claim) -> str:
    """Where the claim stands, in the words this reader is allowed."""
    if c.owner_id == viewer.id or viewer.role == Role.FACULTY:
        return faculty_stage(
            c.status, rejected_outright=c.rejected_outright,
            ticket_number=c.ticket_number, status_note=c.status_note,
        )
    if viewer.role == Role.HOD:
        return hod.progress_of(c.status)
    return claim_numbers.outcome(c)["label"]


def claim_summary(viewer: User, c: Claim) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": c.id,
        "ticket_number": c.ticket_number,
        # A head is shown the translated stage in both places: "PAID" would
        # tell them somebody was paid.
        "status": hod.progress_of(c.status) if viewer.role == Role.HOD else c.status,
        "stage": _stage(viewer, c),
        "url": claim_numbers.review_url(viewer, c) or f"/papers/{c.id}",
    }
    if sees_money(viewer):
        out["amount"] = c.remuneration
    return out


def mentor_dict(team: Team) -> Optional[dict[str, Any]]:
    if team.mentor_id:
        m = team.mentor
        return {
            "id": m.id, "user_id": m.id, "name": m.name,
            "staff_id": m.staff_id or team.mentor_staff_id,
        }
    if team.mentor_name or team.mentor_staff_id:
        # On the roster, with no account here yet.
        return {"id": None, "name": team.mentor_name, "staff_id": team.mentor_staff_id}
    return None


def team_row(team: Team, viewer: User, holders: dict[str, Claim]) -> dict[str, Any]:
    members = list(team.members.all())
    holder = holders.get(team.id)
    return {
        "id": team.id,
        "code": team.code,
        "academic_year": team.academic_year,
        "department": team.department,
        "mentor": mentor_dict(team),
        "students": [{"reg_no": m.register_number, "name": m.name} for m in members],
        "student_count": len(members),
        "project_title": team.title,
        "publications_count": len(team.publications or []),
        "claim": claim_summary(viewer, holder) if holder else None,
        "mine": team.mentor_id == viewer.id,
    }


def holders_of(teams: Iterable[Team]) -> dict[str, Claim]:
    """The filed claim holding each team, by team id."""
    out: dict[str, Claim] = {}
    for c in holding_claims().filter(team__in=list(teams)).order_by("-submitted_at", "-created_at"):
        out[c.team_id] = c
    return out


def counts(qs: QuerySet[Team]) -> dict[str, int]:
    """The KPI row: teams, students, teams with an article, teams claimed."""
    ids = list(qs.values_list("id", flat=True))
    return {
        "teams": len(ids),
        "students": TeamMember.objects.filter(team_id__in=ids).count(),
        "with_publication": len(_with_publications(qs)),
        "claimed": holding_claims().filter(team_id__in=ids).values("team_id").distinct().count(),
    }


def years(user: User) -> list[str]:
    return sorted(
        {y for y in visible_teams(user).values_list("academic_year", flat=True) if y}, reverse=True
    )


def departments(user: User) -> list[str]:
    """The departments the viewer's teams are in, in the roll's own spelling."""
    from core.services.college_totals import canonical_departments

    canon = canonical_departments()
    return sorted(
        {
            canon(d)
            for d in visible_teams(user).values_list("department", flat=True)
            if d and (d or "").strip()
        }
    )


def claim_history(team: Team, viewer: User) -> list[dict[str, Any]]:
    """Every claim that ever named this team, newest first, with which one holds it."""
    claims = hide_others_drafts(Claim.objects.filter(team=team).select_related("owner"), viewer)
    held = holding_claims().filter(team=team).values_list("id", flat=True)
    held_ids = set(held)
    out = []
    for c in claims.order_by("-created_at"):
        row = claim_summary(viewer, c)
        row["holds_team"] = c.id in held_ids
        row["owner_name"] = c.owner.name if c.owner_id else None
        row["submitted_at"] = c.submitted_at.isoformat() if c.submitted_at else None
        row["paper_title"] = c.paper_title
        out.append(row)
    return out


def team_detail(team: Team, viewer: User) -> dict[str, Any]:
    holders = holders_of([team])
    row = team_row(team, viewer, holders)
    mentor_is_viewer = team.mentor_id == viewer.id
    holder = holders.get(team.id)
    return {
        **row,
        "students": [
            {
                "reg_no": m.register_number, "name": m.name,
                "programme": m.programme, "year_of_study": m.year_of_study,
            }
            for m in team.members.all()
        ],
        "publications": [p for p in (team.publications or []) if isinstance(p, dict)],
        "claims": claim_history(team, viewer),
        # The mentor files for their own team, once, when nothing holds it.
        "can_file": mentor_is_viewer and holder is None,
        "cannot_file_because": (
            None if mentor_is_viewer and holder is None
            else (
                f"Team {team.code} is already claimed."
                if mentor_is_viewer
                else f"Only the team's mentor, {mentor_label(team)}, files its claim."
            )
        ),
    }


def students_of(reg_no: str, viewer: User) -> list[Team]:
    """The teams a register number is on, among those `viewer` may see."""
    return list(
        visible_teams(viewer)
        .filter(pk__in=TeamMember.objects.filter(register_number__iexact=reg_no.strip()).values("team_id"))
        .select_related("mentor")
        .prefetch_related("members")
        .order_by("-academic_year", "code")
    )


# ---------------------------------------------------------------------------
# The reviewer's "Team check"
# ---------------------------------------------------------------------------


def team_check(claim: Claim) -> Optional[dict[str, Any]]:
    """Five plain pass or fail lines on a student-project claim, from the server.

    The same facts `check_student_project` refuses on, laid out one by one so a
    reviewer sees which hold before clearing -- including the ones that held
    when it was filed and have changed since (the roster was re-imported, the
    team was claimed on another ticket, the mentor was changed).
    """
    from core.models import ClaimReason

    if claim.claim_reason != ClaimReason.STUDENT_PROJECT:
        return None

    team = claim.team if claim.team_id else None
    lines: list[dict[str, Any]] = []

    def line(key: str, ok: bool, text: str) -> None:
        lines.append({"key": key, "ok": bool(ok), "text": text})

    if team is None:
        line("roster", False, "No team is named on this claim.")
        line("mentor", False, "There is no team, so there is no mentor to match.")
        line("unclaimed", False, "There is no team to check for another claim.")
        line("students", False, "There are no students to list without a team.")
    else:
        line("roster", True, f"Team {team.code} is on the roster.")
        if team.mentor_id and team.mentor_id == claim.owner_id:
            line("mentor", True, f"{claim.owner.name} is the team's mentor.")
        else:
            line(
                "mentor", False,
                f"The roster names {mentor_label(team)} as mentor, not {claim.owner.name}.",
            )
        holder = claim_holding(team, besides=claim)
        if holder is None:
            line("unclaimed", True, "The team is not claimed on any other claim.")
        else:
            line(
                "unclaimed", False,
                f"The team is already claimed on claim {holder.ticket_number or 'without a number yet'}.",
            )
        n = team.members.count()
        if n:
            line("students", True, f"{n} {'student' if n == 1 else 'students'} listed on the team.")
        else:
            line("students", False, "No students are listed on the team.")

    pub_type = claim.publication_type or claim.aggregation_type
    if pub_type and is_conference_paper(pub_type):
        line("conference", True, f"The paper is a conference paper ({pub_type}).")
    elif pub_type:
        line("conference", False, f"The paper is a {pub_type}, and the scheme covers conference papers only.")
    else:
        line("conference", False, "The type of paper is not stated, and the scheme covers conference papers only.")

    return {
        "team_code": team.code if team else None,
        "team_url": f"/teams/{team.code}" if team else None,
        "ok": all(l["ok"] for l in lines),
        "lines": lines,
    }
