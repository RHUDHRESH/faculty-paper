"""Who here has worked on this, and has this paper been filed already.

The third scope is the only one no external index can answer, and it is the one
that makes a search box worth building rather than buying. Crossref knows who
published on graphene supercapacitors; only this database knows that two of
them are down the corridor, that one has it half-filed as a draft, and that the
paper somebody is about to claim was claimed by a colleague eighteen months ago.

Three tables, one query:

- `Claim` -- the tickets. Matched on title, journal and DOI.
- `User` -- the person.
- `ResearchInterest` -- what somebody says they work on, which is the only
  thing a new lecturer with no publications here can be found by. Without it
  the newest member of staff is invisible to "who could I work with" forever.

Two rules on the way out, both about a head of department:

- The amount on a ticket is *omitted*, not zeroed. `amount: 0` is a figure as
  far as any client guard is concerned; a missing key is not. See money.py.
- "PAID" is a statement that a named colleague was paid, so heads get
  `hod.progress_of`'s translation in its place -- the same substitution every
  other view of theirs makes.
"""

from __future__ import annotations

from typing import Any

from django.db.models import Count, Q

from core import hod
from core.models import Claim, ClaimStatus, ResearchInterest, Role, User
from core.services.normalize import normalize_doi, normalize_title
from core.services.search.money import amount_for, may_see_money


def visible_claims(viewer) -> Any:
    """Which claims this viewer's search may reach.

    A head of department sees their own department and nothing else -- read
    from their account, never from a parameter, because a head asking about
    another department is a different question rather than a filter. Everybody
    else sees the college, which is what makes "has this been claimed before"
    answerable at all.
    """
    scope = Claim.objects.select_related("owner")
    if getattr(viewer, "role", None) == Role.HOD:
        department = hod.department_of(viewer)
        return scope.filter(owner__department__iexact=department) if department else scope.none()
    return scope


def visible_users(viewer) -> Any:
    scope = User.objects.filter(active=True)
    if getattr(viewer, "role", None) == Role.HOD:
        department = hod.department_of(viewer)
        return scope.filter(department__iexact=department) if department else scope.none()
    return scope


def status_for(claim: Claim, role: str | None) -> str:
    """The workflow status, or a head's translation of it."""
    return claim.status if may_see_money(role) else hod.progress_of(claim.status)


def find_tickets(
    query: str,
    *,
    viewer,
    doi: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Claims already on file that look like the thing being searched for.

    A DOI, where there is one, is the answer on its own: it identifies the
    paper rather than resembling it, so a DOI hit is reported whatever the
    title says.
    """
    role = getattr(viewer, "role", None)
    scope = visible_claims(viewer).exclude(status=ClaimStatus.REJECTED)
    matcher = Q()

    normalised = normalize_title(query)
    if normalised:
        matcher |= Q(normalized_title=normalised)
    if query.strip():
        matcher |= Q(paper_title__icontains=query.strip())
        matcher |= Q(journal_title__icontains=query.strip())
    wanted_doi = normalize_doi(doi) or normalize_doi(query)
    if wanted_doi:
        matcher |= Q(doi__iexact=wanted_doi)
    if not matcher:
        return []

    rows: list[dict[str, Any]] = []
    for claim in scope.filter(matcher).order_by("-publication_year", "-created_at")[:limit]:
        rows.append(
            {
                "id": claim.id,
                "paper_title": claim.paper_title,
                "doi": claim.doi,
                "journal_title": claim.journal_title,
                "status": status_for(claim, role),
                "publication_year": claim.publication_year,
                "department": claim.owner.department if claim.owner_id else None,
                "claimant": (
                    {"id": claim.owner_id, "name": claim.owner.name}
                    if claim.owner_id
                    else None
                ),
                # Splatted, so for a head of department the key is not there at
                # all rather than there and zero.
                **amount_for(claim.remuneration, role),
            }
        )
    return rows


def claims_by_doi(dois: list[str], *, viewer) -> dict[str, dict[str, Any]]:
    """Existing claims for a set of DOIs, keyed by normalised DOI.

    One query for the whole result page rather than one per row. DOIs are
    stored as they arrived, so the lookup asks for the forms they realistically
    take -- bare, upper-cased, and as a doi.org URL -- and then normalises both
    sides before matching, rather than scanning the table.
    """
    wanted = {d for d in (normalize_doi(x) for x in dois) if d}
    if not wanted:
        return {}

    forms: list[str] = []
    for doi in wanted:
        forms.extend([doi, doi.upper(), f"https://doi.org/{doi}", f"http://dx.doi.org/{doi}"])

    role = getattr(viewer, "role", None)
    viewer_id = getattr(viewer, "id", None)
    out: dict[str, dict[str, Any]] = {}
    for claim in visible_claims(viewer).filter(doi__in=forms):
        key = normalize_doi(claim.doi)
        if not key or key in out:
            continue
        out[key] = {
            "id": claim.id,
            "status": status_for(claim, role),
            "mine": bool(viewer_id) and claim.owner_id == viewer_id,
        }
    return out


def find_people(query: str, *, viewer, limit: int = 10) -> list[dict[str, Any]]:
    """Colleagues who match by name, by stated interest, or by what they published.

    The three routes are unioned rather than tried in order. Somebody found by
    interest and somebody found by publication are both answers to "who works
    on this", and preferring one route would hide half a department from a
    search whose entire purpose is to find a collaborator.
    """
    text = (query or "").strip()
    if not text:
        return []

    users = visible_users(viewer)
    claims = visible_claims(viewer)

    by_name = set(
        users.filter(Q(name__icontains=text) | Q(department__icontains=text))
        .values_list("id", flat=True)[: limit * 3]
    )
    by_interest = set(
        ResearchInterest.objects.filter(domain__icontains=text)
        .values_list("user_id", flat=True)[: limit * 3]
    )
    by_work = set(
        claims.filter(
            Q(paper_title__icontains=text)
            | Q(journal_title__icontains=text)
            | Q(subject_category__icontains=text)
        ).values_list("owner_id", flat=True)[: limit * 5]
    )

    wanted = by_name | by_interest | by_work
    if not wanted:
        return []

    counts = {
        r["owner_id"]: r["n"]
        for r in claims.filter(owner_id__in=wanted).values("owner_id").annotate(n=Count("id"))
    }
    interests: dict[str, list[str]] = {}
    for row in ResearchInterest.objects.filter(user_id__in=wanted).values("user_id", "domain"):
        interests.setdefault(row["user_id"], []).append(row["domain"])

    people: list[dict[str, Any]] = []
    for user in users.filter(id__in=wanted).order_by("name"):
        why = []
        if user.id in by_work:
            why.append("has published on this")
        if user.id in by_interest:
            why.append("lists it as a research interest")
        if user.id in by_name:
            why.append("name or department matches")
        people.append(
            {
                "id": user.id,
                "name": user.name,
                "department": user.department,
                "designation": user.designation,
                "papers": counts.get(user.id, 0),
                # Additive, and safe to ignore: the reason somebody is in this
                # list is most of what makes it useful, and a new lecturer with
                # no papers is only ever here because of an interest.
                "interests": sorted(interests.get(user.id, [])),
                "why": why,
            }
        )

    # Somebody with ten papers on the subject is a better answer than somebody
    # whose department name happens to contain the word.
    people.sort(key=lambda p: (-(p["papers"] or 0), p["name"] or ""))
    return people[:limit]
