"""who has worked with whom.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.common import require_user

from typing import Any, Optional
from django.http import HttpRequest
from core.models import Claim, ClaimStatus, Role, User
from core.services.normalize import normalize_doi, normalize_title
from core import hod

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




__all__ = [
    '_collaboration_index',
    '_paper_key',
    '_person_brief',
    'collaboration_graph',
    'my_collaborators',
]
