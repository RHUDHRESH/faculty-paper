"""A department's research output, counted from the college's publication record.

The head's screens used to count **claims for the incentive** and call them the
department's papers: on the real copy ECE "published 19 papers, 1st of 16"
beside the Principal's own page for the same department showing 373 papers in
2025 and rank 4. A claim is a request for money; the paper is the record. So
this module answers every "how many papers" question a head asks with the same
functions the Principal's pages use:

- the department's papers are `college_totals.papers(year, department)`, the
  one definition of "a college paper" (record papers with a college author in
  the department, plus recognised claim-only papers the record does not hold);
- a person's papers are `person_record.papers_of`, the count the faculty
  directory and every profile use.

So the head's figure and the Principal's figure for one department and year
are the same number, and a person's count here equals the one on their card.

Nothing here carries money: both sources are money-free by construction.
"""
from __future__ import annotations

import json
from html import unescape
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Optional

from django.conf import settings

from core.models import Publication, Role, User
from core.services import college_totals
from core.services.person_record import Paper, papers_of

#: A department's teachers: the faculty and the head, current staff only. The
#: same population the Principal's roll uses (`principal_brief.TEACHER_ROLES`).
TEACHER_ROLES = (Role.FACULTY, Role.HOD)

#: How many years the output chart and the report look back over.
YEARS_SHOWN = 5


@dataclass
class PersonStats:
    """One teacher's papers, cut the ways a head asks about them."""

    user: User
    this_year: int = 0
    last_year: int = 0
    q1_this_year: int = 0
    led_this_year: int = 0
    total: int = 0
    #: Papers with a recorded quartile / Q1 papers since two years ago.
    q_known_recent: int = 0
    q1_recent: int = 0
    led_ever: int = 0
    last_paper_year: Optional[int] = None
    areas: Counter = field(default_factory=Counter)
    has_scopus_id: bool = False


@dataclass
class Snapshot:
    department: str
    year: int
    today: date
    people: list[PersonStats]
    #: {year: papers} and {year: Q1 papers} for the department, whole record.
    per_year: Counter
    q1_year: Counter
    #: The department's papers of `year`, and how many carry each quartile.
    papers_year: int
    q1_year_count: int
    quartile_known: int
    led_year: int
    #: Same date last year, from the papers that carry a date.
    this_to_date: int
    last_to_date: int
    last_year_full: int
    #: Quality of this year's record papers, the things an assessor sends back.
    missing_doi: int
    missing_issn: int
    missing_either: int
    scopus_indexed: int
    record_papers_year: int
    record_papers_window: int


def department_name(name: str) -> str:
    """The roll's own spelling of a department ("Civil" and "CIVIL" are one)."""
    return college_totals.canonical_departments()(name)


def teachers(department: str) -> list[User]:
    canon = college_totals.canonical_departments()
    want = canon(department)
    return [
        u for u in User.objects.filter(active=True, role__in=TEACHER_ROLES).order_by("name")
        if canon(u.department) == want
    ]


#: Only a journal has an ISSN to give. A conference paper, a preprint or a book
#: chapter without one is not a gap, so the "missing ISSN" list would otherwise
#: name hundreds of papers nobody can fix (740 of them for ECE).
_JOURNAL_TYPES = {"article", "journal", "journal-article", "review"}


def needs_issn(kind: Optional[str]) -> bool:
    return (kind or "").strip().lower() in _JOURNAL_TYPES


def _same_day(year: int, today: date) -> date:
    """`today` in another year; 29 February becomes the 28th."""
    try:
        return date(year, today.month, today.day)
    except ValueError:
        return date(year, today.month, today.day - 1)


def _area_of(pub_topics: dict[str, list[str]], p: Paper) -> list[str]:
    return pub_topics.get(p.publication_id or "", [])


def snapshot(department: str, year: int, today: date) -> Snapshot:
    dept = department_name(department)
    people_users = teachers(dept)
    ids = [u.id for u in people_users]
    papers_by_person = papers_of(people_users)

    # ---- the department's own count, the Principal's definition ----
    dept_papers = college_totals.papers(None, dept)
    per_year: Counter = Counter()
    q1_year: Counter = Counter()
    for p in dept_papers:
        if p["year"]:
            per_year[p["year"]] += 1
            q1_year[p["year"]] += p.get("quartile") == "Q1"
    this = [p for p in dept_papers if p["year"] == year]
    last = [p for p in dept_papers if p["year"] == year - 1]

    # ---- to the same date last year: only papers that carry a date ----
    record_ids = [p["id"] for p in this + last if p["source"] == "record"]
    dates = dict(Publication.objects.filter(id__in=record_ids).values_list("id", "date"))
    cutoff_last = _same_day(year - 1, today) if year == today.year else None
    this_to_date = sum(1 for p in this if dates.get(p["id"]) and (year != today.year or dates[p["id"]] <= today))
    if cutoff_last is None:
        last_to_date = len(last)
    else:
        last_to_date = sum(1 for p in last if dates.get(p["id"]) and dates[p["id"]] <= cutoff_last)

    # ---- what an assessor sends back: the five years NAAC 3.3 and NBA look at ----
    rec_this = [p["id"] for p in this if p["source"] == "record"]
    window = range(year - YEARS_SHOWN + 1, year + 1)
    rec_window = [p["id"] for p in dept_papers if p["source"] == "record" and p["year"] in window]
    missing_doi = missing_issn = missing_either = 0
    for doi, issn, kind in Publication.objects.filter(id__in=rec_window).values_list("doi", "issn", "type"):
        no_doi = not (doi or "").strip()
        no_issn = needs_issn(kind) and not (issn or "").strip()
        missing_doi += no_doi
        missing_issn += no_issn
        missing_either += no_doi or no_issn
    indexed = Publication.objects.filter(id__in=rec_this, scopus_indexed=True).count()

    # ---- people ----
    pub_ids = {p.publication_id for ps in papers_by_person.values() for p in ps
               if p.publication_id and p.year and year - 2 <= p.year <= year}
    topics: dict[str, list[str]] = {}
    for pid, raw in Publication.objects.filter(id__in=pub_ids).values_list("id", "topics_json"):
        try:
            got = json.loads(raw or "[]")
        except ValueError:
            got = []
        topics[pid] = [t for t in got if isinstance(t, str)][:3]

    stats: list[PersonStats] = []
    led_pubs: set[str] = set()
    for u in people_users:
        s = PersonStats(user=u)
        s.has_scopus_id = bool((u.scopus_author_id or "").strip() or (u.scopus_author_url or "").strip())
        for p in papers_by_person.get(u.id, []):
            s.total += 1
            led = p.position == 1
            s.led_ever += led
            if p.year is None:
                continue
            if p.year <= year and (s.last_paper_year is None or p.year > s.last_paper_year):
                s.last_paper_year = p.year
            q1 = p.quartile == "Q1"
            if p.year == year:
                s.this_year += 1
                s.q1_this_year += q1
                s.led_this_year += led
                if led:
                    led_pubs.add(p.publication_id or p.claim_id or p.title)
            elif p.year == year - 1:
                s.last_year += 1
            if year - 2 <= p.year <= year:
                s.q_known_recent += bool(p.quartile)
                s.q1_recent += q1
                for t in _area_of(topics, p):
                    s.areas[t] += 1
        stats.append(s)

    return Snapshot(
        department=dept, year=year, today=today, people=stats,
        per_year=per_year, q1_year=q1_year,
        papers_year=len(this),
        q1_year_count=sum(1 for p in this if p.get("quartile") == "Q1"),
        quartile_known=sum(1 for p in this if p.get("quartile")),
        led_year=len(led_pubs),
        this_to_date=this_to_date, last_to_date=last_to_date, last_year_full=len(last),
        missing_doi=missing_doi, missing_issn=missing_issn, missing_either=missing_either, scopus_indexed=indexed,
        record_papers_year=len(rec_this), record_papers_window=len(rec_window),
    )


def paper_rows(department: str, years: list[int]) -> list[dict[str, Any]]:
    """The department's papers of those years, one row each, for the files.

    The row NAAC 3.3 asks for: title, the department's authors, journal, year,
    ISSN, quartile, where it is indexed, and links to the paper. Carries no
    money. Record papers first, then recognised claim-only papers the record
    does not hold.
    """
    from core.models import Authorship

    dept = department_name(department)
    users = {u.id: u for u in teachers(dept)}
    by_pub: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for pid, uid, pos in Authorship.objects.filter(
        user_id__in=list(users), publication__year__in=years
    ).values_list("publication_id", "user_id", "position"):
        by_pub[pid].append((pos if pos is not None else 999, uid))
    out: list[dict[str, Any]] = []
    for pub in Publication.objects.filter(id__in=list(by_pub)).order_by("-year", "title"):
        seen: list[str] = []
        for _, uid in sorted(by_pub[pub.id]):
            if users[uid].name not in seen:
                seen.append(users[uid].name)
        out.append({
            "title": unescape(pub.title), "authors": seen, "journal": unescape(pub.venue), "year": pub.year,
            "issn": pub.issn, "doi": pub.doi, "quartile": (pub.quartile or "").strip().upper() or None,
            "indexed": "Scopus" if pub.scopus_indexed else "",
            "eid": pub.eid, "position": min(p for p, _ in by_pub[pub.id]), "type": pub.type,
        })
    for p in college_totals.papers(None, dept):
        if p["source"] == "claims" and p["year"] in years:
            out.append({
                "title": p.get("title") or "", "authors": [p["author"]] if p.get("author") else [],
                "journal": p.get("journal") or "", "year": p["year"], "issn": "", "doi": p.get("doi"),
                "quartile": p.get("quartile") or None, "indexed": "", "eid": None, "position": None, "type": None,
            })
    return out


QUARTILE_ORDER = {"Q1": 0, "Q2": 1, "Q3": 2, "Q4": 3, "": 4}


def _quartile_ok(p: dict[str, Any], quartile: Optional[str]) -> bool:
    if not quartile:
        return True
    q = quartile.strip().upper()
    if q == "NONE":
        return not p.get("quartile")
    if q == "TOP":
        return p.get("quartile") in ("Q1", "Q2")
    if q == "LOW":
        return p.get("quartile") in ("Q3", "Q4")
    return p.get("quartile") == q


def department_papers(
    department: str,
    year: Optional[int] = None,
    quartile: Optional[str] = None,
    q: Optional[str] = None,
    person: Optional[str] = None,
    missing: Optional[str] = None,
    limit: int = 25,
    offset: int = 0,
) -> dict[str, Any]:
    """The papers behind any department figure, newest first.

    The same rows the Principal's list would give for this department and year
    (`college_totals.papers`), so a figure and the list it opens agree. `person`
    narrows to one teacher's papers; `missing` is "doi" or "issn" (what an
    assessor sends back). Carries no money and no claim link: a head does not
    open a colleague's claim.
    """
    from core.models import Authorship

    dept = department_name(department)
    rows = [p for p in college_totals.papers(year, dept) if _quartile_ok(p, quartile)]

    if person:
        mine = set(
            Authorship.objects.filter(user_id=person).values_list("publication_id", flat=True)
        )
        rows = [p for p in rows if (p["source"] == "record" and p["id"] in mine)
                or (p["source"] == "claims" and p.get("author_id") == person)]

    record_ids = [p["id"] for p in rows if p["source"] == "record"]
    pubs = {
        p.id: p for p in Publication.objects.filter(id__in=record_ids).only(
            "id", "title", "venue", "doi", "issn", "type", "year", "date", "quartile", "scopus_indexed", "citations"
        )
    }

    def blank(v: Optional[str]) -> bool:
        return not (v or "").strip()

    if missing in ("doi", "issn"):
        def lacks(pub) -> bool:
            return blank(pub.doi) if missing == "doi" else (needs_issn(pub.type) and blank(pub.issn))

        rows = [
            p for p in rows
            if (p["source"] == "record" and p["id"] in pubs and lacks(pubs[p["id"]]))
            or (p["source"] == "claims" and missing == "doi" and blank(p.get("doi")))
        ]

    term = (q or "").strip().casefold()
    if term:
        names = {}
        if record_ids:
            for pid, name in Authorship.objects.filter(
                publication_id__in=record_ids, user__isnull=False
            ).values_list("publication_id", "user__name"):
                names.setdefault(pid, []).append(name)

        def hit(p: dict[str, Any]) -> bool:
            if p["source"] == "record":
                pub = pubs.get(p["id"])
                hay = [pub.title, pub.venue, pub.doi or ""] + names.get(p["id"], []) if pub else []
            else:
                hay = [p.get("title") or "", p.get("journal") or "", p.get("author") or "", p.get("doi") or ""]
            return any(term in (h or "").casefold() for h in hay)

        rows = [p for p in rows if hit(p)]

    rows.sort(key=lambda p: (-(p["year"] or 0), QUARTILE_ORDER.get(p.get("quartile") or "", 4), str(p["id"])))
    total = len(rows)
    by_quartile = Counter(p.get("quartile") or "none" for p in rows)
    page = rows[offset: offset + limit]

    page_ids = [p["id"] for p in page if p["source"] == "record"]
    authors: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for a in (
        Authorship.objects.filter(publication_id__in=page_ids, user__isnull=False)
        .order_by("publication_id", "position")
        .values("publication_id", "user_id", "user__name", "user__department")
    ):
        if all(x["user_id"] != a["user_id"] for x in authors[a["publication_id"]]):
            authors[a["publication_id"]].append(
                {"user_id": a["user_id"], "name": a["user__name"], "department": a["user__department"] or ""}
            )
    out = []
    for p in page:
        if p["source"] == "record":
            pub = pubs.get(p["id"])
            out.append({
                "id": p["id"], "source": "record",
                "title": unescape(pub.title) if pub else "", "journal": unescape(pub.venue) if pub else "",
                "year": p["year"], "quartile": p.get("quartile") or None,
                "doi": (pub.doi if pub else None) or None, "issn": (pub.issn if pub else "") or None,
                "indexed": bool(pub and pub.scopus_indexed), "citations": pub.citations if pub else None,
                "authors": authors.get(p["id"], []),
            })
        else:
            out.append({
                "id": p["id"], "source": "claims",
                "title": p.get("title") or "", "journal": p.get("journal") or "",
                "year": p["year"], "quartile": p.get("quartile") or None,
                "doi": p.get("doi"), "issn": None, "indexed": False, "citations": None,
                "authors": ([{"user_id": p.get("author_id"), "name": p["author"], "department": dept}]
                            if p.get("author") else []),
            })
    return {
        "total": total, "limit": limit, "offset": offset, "department": dept,
        "results": out, "by_quartile": dict(by_quartile),
        "years": sorted({p["year"] for p in college_totals.papers(None, dept) if p["year"]}, reverse=True),
    }


def records_to_fix(department: str, years: list[int]) -> dict[str, Any]:
    """What an assessor would send back, with names: papers without a DOI or an
    ISSN (the record's own papers), and faculty with no Scopus ID on file."""
    from core.models import Authorship

    dept = department_name(department)
    users = {u.id: u for u in teachers(dept)}
    ids = {p["id"] for p in college_totals.papers(None, dept)
           if p["source"] == "record" and p["year"] in years}
    who: dict[str, list[str]] = defaultdict(list)
    for pid, uid in Authorship.objects.filter(publication_id__in=ids, user_id__in=list(users)).values_list(
        "publication_id", "user_id"
    ):
        if users[uid].name not in who[pid]:
            who[pid].append(users[uid].name)
    papers = []
    for pub in Publication.objects.filter(id__in=ids).order_by("-year", "title"):
        gone = []
        if not (pub.doi or "").strip():
            gone.append("DOI")
        if needs_issn(pub.type) and not (pub.issn or "").strip():
            gone.append("ISSN")
        if gone:
            papers.append({
                "id": pub.id, "title": unescape(pub.title), "journal": unescape(pub.venue), "year": pub.year,
                "authors": who.get(pub.id, []), "missing": gone,
            })
    no_scopus = [
        {"id": u.id, "name": u.name, "designation": u.designation,
         "photo_url": f"{settings.MEDIA_URL}{u.photo}" if u.photo else None}
        for u in users.values()
        if not ((u.scopus_author_id or "").strip() or (u.scopus_author_url or "").strip())
    ]
    return {"department": dept, "years": years, "papers": papers, "no_scopus_id": no_scopus,
            "papers_checked": len(ids)}


def metric_done(s: Snapshot, metric: str) -> int:
    """How far the department is on one target metric, this snapshot's year."""
    if metric == "Q1":
        return s.q1_year_count
    if metric == "FIRST_AUTHOR":
        return s.led_year
    return s.papers_year


def person_done(p: PersonStats, metric: str) -> int:
    if metric == "Q1":
        return p.q1_this_year
    if metric == "FIRST_AUTHOR":
        return p.led_this_year
    return p.this_year


__all__ = ["PersonStats", "Snapshot", "snapshot", "paper_rows", "department_papers", "records_to_fix", "teachers", "department_name", "metric_done", "person_done",
           "TEACHER_ROLES", "YEARS_SHOWN"]
