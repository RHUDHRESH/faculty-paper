"""A person's papers, counted once, for every page that shows a count.

Home (`/me/summary`), My research (`/me/research`) and the Impact card each
used to count papers their own way -- the card from recognised claims and the
paid ledger, My research from the publication record -- and the owner saw 20
on one and 10 on the other. This module is the one count:

- **The publication record**: every `Publication` the person has an
  `Authorship` on (built by harvest_publications + match_authors), once each.
- **Plus claims-only papers**: a recognised claim or paid-ledger row
  (`core.services.records`) that the record does not yet hold -- not linked to
  one of the person's publications, and matching none of them by DOI or by
  normalised title. `match_authors --link` folds these into the record over
  time; until it runs, they still count.

Carries no money: the records it reads are money-free by construction.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Iterable, Optional

from core.models import Authorship, Publication, User
from core.services.normalize import clean_venue, normalize_doi, normalize_title
from core.services.records import POINTS, QUARTILES, paper_records


@dataclass(frozen=True)
class Paper:
    """One of a person's papers, from whichever source knows it."""

    title: str
    venue: str
    quartile: Optional[str]
    year: Optional[int]
    #: Publication date where known, else None (a record knows only a year).
    on: Optional[date]
    position: Optional[int]
    #: None when nobody has told us.
    citations: Optional[int]
    #: "record" (a Publication) or "claims" (a claim/ledger row only).
    source: str
    publication_id: Optional[str] = None
    #: The claim behind a claims-only paper, and its DOI.
    claim_id: Optional[str] = None
    doi: Optional[str] = None

    @property
    def points(self) -> int:
        return POINTS.get(self.quartile or "", 1)

    @property
    def first_author(self) -> bool:
        return self.position == 1


def _q(value: str | None) -> Optional[str]:
    q = (value or "").strip().upper()
    return q if q in QUARTILES else None


def papers_of(users: Iterable[User]) -> dict[str, list[Paper]]:
    """Each person's papers, oldest first, keyed by user id."""
    people = list(users)
    ids = [u.id for u in people]
    out: dict[str, list[Paper]] = {u.id: [] for u in people}

    rows = (
        Authorship.objects.filter(user_id__in=ids)
        .select_related("publication")
        .order_by("publication__year", "publication__date", "position")
    )
    seen: dict[str, set[str]] = defaultdict(set)
    dois: dict[str, set[str]] = defaultdict(set)
    titles: dict[str, set[str]] = defaultdict(set)
    pub_ids: set[str] = set()
    for a in rows:
        p: Publication = a.publication
        if p.id in seen[a.user_id]:
            continue
        seen[a.user_id].add(p.id)
        pub_ids.add(p.id)
        d = normalize_doi(p.doi) if p.doi else None
        if d:
            dois[a.user_id].add(d)
        t = p.normalized_title or normalize_title(p.title)
        if t:
            titles[a.user_id].add(t[:512])
        out[a.user_id].append(Paper(
            title=p.title, venue=clean_venue(p.venue), quartile=_q(p.quartile), year=p.year, on=p.date,
            position=a.position, citations=p.citations, source="record", publication_id=p.id,
        ))

    linked_claims: dict[str, set[str]] = defaultdict(set)
    Link = Publication.claims.through
    claim_links = Link.objects.filter(publication_id__in=pub_ids).values_list("publication_id", "claim_id")
    pub_owner: dict[str, set[str]] = defaultdict(set)
    for uid, pids in seen.items():
        for pid in pids:
            pub_owner[pid].add(uid)
    for pid, cid in claim_links:
        for uid in pub_owner[pid]:
            linked_claims[uid].add(cid)

    for uid, recs in paper_records(people).items():
        for r in recs:
            if r.claim_id and r.claim_id in linked_claims[uid]:
                continue
            if r.doi and r.doi in dois[uid]:
                continue
            if r.key and r.key[:512] in titles[uid]:
                continue
            out.setdefault(uid, []).append(Paper(
                title=r.title, venue=clean_venue(r.journal), quartile=r.quartile, year=r.year, on=r.filed_on,
                position=r.author_position, citations=r.citations, source="claims",
                claim_id=r.claim_id, doi=r.doi,
            ))
            if r.key:
                titles[uid].add(r.key[:512])

    for uid in out:
        out[uid].sort(key=lambda p: (p.year or 0, p.on or date.min, p.title))
    return out


def papers_for(user: User) -> list[Paper]:
    return papers_of([user])[user.id]


def department_of(user: User) -> tuple[list[Paper], dict[str, list[Paper]]]:
    """The person's papers, and every department colleague's (for a rank)."""
    department = (user.department or "").strip()
    colleagues = list(User.objects.filter(department__iexact=department)) if department else [user]
    if user.id not in {u.id for u in colleagues}:
        colleagues.append(user)
    everyone = papers_of(colleagues)
    return everyone.get(user.id, []), everyone


def rank_in(everyone: dict[str, list[Paper]], uid: str) -> tuple[Optional[int], int]:
    """(place, of) by quartile points; None when the person has no papers."""
    scores = {k: sum(p.points for p in v) for k, v in everyone.items() if v}
    if uid not in scores:
        return None, len(scores)
    return 1 + sum(1 for s in scores.values() if s > scores[uid]), len(scores)


__all__ = ["Paper", "papers_of", "papers_for", "department_of", "rank_in"]
