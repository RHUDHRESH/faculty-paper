"""What the college's record shows has happened lately, counted and in plain words.

The Events page's research showcase (`GET /api/research/highlights`). Every
line is counted from the publication record (`Publication` / `Authorship`, via
`research_picture.shared_college`), none is written by a model, and there is no
money anywhere in it: the record carries none. Each paper comes with the reason
it is on the page, built from the counts ("First Q1 paper for Asha Menon").

Four things are looked for in the window that was asked about:

- **New in Q1 journals**: papers in a Q1 journal, and whether it is somebody's
  first.
- **First papers**: the first paper the college has ever had in a journal.
- **Most cited**: the papers of the last twelve months (or the window, if it is
  longer) with the most citations. OpenAlex gives a paper's citations so far,
  not when each was earned, so the reason says "since it came out" and does not
  pretend to a rate.
- **New names**: people whose first paper on the record lands in the window,
  by the same rule as the leaderboard's Newcomers board.

Rules a reader could doubt, each pinned by core/test_research_highlights.py:

- A paper counts by its publication *date*. One with only a year, or a date in
  the future, is never "new".
- Only people with an active account are named. A paper whose only college
  authors have left is not shown.
- A journal is "first" only if no earlier paper, even a year-only one, had it.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Any, Iterable, Optional

from django.utils import timezone

from core.models import User
from core.services import aggregate_cache, honours_board, person_record
from core.services.research_picture import shared_college

#: Days in each window. The page calls them the past month, three months and year.
PERIODS = {"month": 30, "quarter": 91, "year": 365}
LABELS = {"month": "Past month", "quarter": "Past 3 months", "year": "Past year"}
DEFAULT_PERIOD = "year"

#: "Most cited lately" never looks at less than this, or a month would show only
#: papers too new to have been cited.
CITED_FLOOR_DAYS = 365

PER_SECTION = 12
AUTHORS_SHOWN = 6


def _key(text: Optional[str]) -> str:
    return (text or "").strip().casefold()


def _names(people: list[User]) -> str:
    names = [p.name or "a colleague" for p in people]
    if len(names) <= 1:
        return "".join(names)
    shown, rest = names[:3], len(names) - 3
    if rest > 0:
        return ", ".join(shown) + f" and {rest} {'other' if rest == 1 else 'others'}"
    return ", ".join(shown[:-1]) + f" and {shown[-1]}"


def spellings(names: Iterable[Optional[str]]) -> dict[str, str]:
    """casefolded department -> the spelling most accounts use.

    "Ece" and "ECE" are one department; the page should not offer both.
    """
    seen: dict[str, Counter[str]] = defaultdict(Counter)
    for raw in names:
        name = (raw or "").strip()
        if name:
            seen[_key(name)][name] += 1
    return {k: max(v.items(), key=lambda kv: (kv[1], kv[0]))[0] for k, v in seen.items()}


def _item(p: dict[str, Any], authors: list[User], reason: str) -> dict[str, Any]:
    quartile = (p["quartile"] or "").strip().upper()
    return {
        "id": p["id"],
        "title": p["title"],
        "venue": p["venue"] or None,
        "quartile": quartile or None,
        "date": p["date"].isoformat() if p["date"] else None,
        "year": p["year"],
        "citations": p["citations"] or 0,
        "authors": [
            {"id": a.id, "name": a.name, "department": (a.department or "").strip() or None}
            for a in authors[:AUTHORS_SHOWN]
        ],
        "authors_more": max(0, len(authors) - AUTHORS_SHOWN),
        "reason": reason,
    }


def _effective(p: dict[str, Any]) -> Optional[date]:
    """The day to compare papers by: the date, else the start of the year."""
    if p["date"]:
        return p["date"]
    return date(p["year"], 1, 1) if p["year"] else None


def highlights(period: str = DEFAULT_PERIOD, department: str = "", *, on: Optional[date] = None) -> dict[str, Any]:
    """The page's payload for one window and, optionally, one department.

    The same for every reader, so it is shared until the record changes
    (`aggregate_cache.shared`); `on` is part of the key because the window moves
    with the day.
    """
    if period not in PERIODS:
        raise ValueError(f"period must be one of: {', '.join(PERIODS)}")
    today = on or timezone.localdate()
    return aggregate_cache.shared(
        "research-highlights",
        {"period": period, "department": _key(department), "on": today.isoformat()},
        lambda: _build(period, department, today),
    )


def _build(period: str, department: str, today: date) -> dict[str, Any]:
    days = PERIODS[period]
    start = today - timedelta(days=days)
    cited_days = max(days, CITED_FLOOR_DAYS)
    cited_start = today - timedelta(days=cited_days)

    college = shared_college()
    people = {uid: u for uid, u in college.users.items() if u.active}
    spelled = spellings(u.department for u in people.values())
    wanted = _key(department)

    def authors_of(p: dict[str, Any]) -> list[User]:
        return sorted((people[m] for m in p["members"] if m in people), key=lambda u: (u.name or "").casefold())

    def in_department(authors: list[User]) -> bool:
        return not wanted or any(_key(a.department) == wanted for a in authors)

    # When each journal first appeared in the college's record, by the day it
    # did (a year-only paper counts from 1 January, so it can only make a later
    # paper less "first", never more).
    earliest: dict[str, tuple[date, str]] = {}
    for p in college.pubs.values():
        venue, day = _key(p["venue"]), _effective(p)
        if venue and day and (venue not in earliest or (day, p["id"]) < earliest[venue]):
            earliest[venue] = (day, p["id"])

    def dated_between(p: dict[str, Any], lo: date) -> bool:
        return bool(p["date"]) and lo <= p["date"] <= today

    recent = [
        (p, authors_of(p)) for p in college.pubs.values() if dated_between(p, start)
    ]
    recent = [(p, a) for p, a in recent if a]
    newest_first = sorted(recent, key=lambda pa: (pa[0]["date"], pa[0]["title"]), reverse=True)

    # ---- New in Q1 journals ----
    q1_all = [(p, a) for p, a in newest_first if (p["quartile"] or "").strip().upper() == "Q1" and in_department(a)]
    q1_people = {a.id: a for _, authors in q1_all[:PER_SECTION] for a in authors}
    first_q1: dict[str, Optional[str]] = {}
    if q1_people:
        for uid, papers in person_record.papers_of(list(q1_people.values())).items():
            first = next((x for x in papers if x.quartile == "Q1"), None)
            first_q1[uid] = first.publication_id if first else None
    q1 = []
    for p, authors in q1_all[:PER_SECTION]:
        firsts = [a for a in authors if first_q1.get(a.id) == p["id"]]
        reason = (
            f"First Q1 paper for {_names(firsts)}"
            if firsts
            else f"In {p['venue']}, a Q1 journal" if p["venue"] else "In a Q1 journal"
        )
        q1.append(_item(p, authors, reason))

    # ---- First papers in a journal ----
    firsts_all = [
        (p, a) for p, a in newest_first
        if p["venue"] and earliest.get(_key(p["venue"])) == (p["date"], p["id"]) and in_department(a)
    ]
    first_papers = [
        _item(p, a, f"The college's first paper in {p['venue']}") for p, a in firsts_all[:PER_SECTION]
    ]

    # ---- Most cited lately ----
    cited_pool = [
        (p, authors_of(p)) for p in college.pubs.values()
        if dated_between(p, cited_start) and (p["citations"] or 0) > 0
    ]
    cited_all = sorted(
        ((p, a) for p, a in cited_pool if a and in_department(a)),
        key=lambda pa: (-(pa[0]["citations"] or 0), -pa[0]["date"].toordinal(), pa[0]["title"]),
    )
    most_cited = []
    for p, authors in cited_all[:PER_SECTION]:
        n = p["citations"]
        times = "once" if n == 1 else f"{n} times"
        most_cited.append(_item(p, authors, f"Cited {times} since it came out in {p['date']:%b %Y}"))

    # ---- New names ----
    # The leaderboard's own "first paper on the record" (Newcomers), so the two
    # pages cannot disagree about who is new.
    first_seen = honours_board.record().first_seen
    fresh = {uid: d for uid, d in first_seen.items() if uid in people and start <= d <= today}
    by_paper: dict[str, list[User]] = defaultdict(list)
    if fresh:
        for p in college.pubs.values():
            if not p["date"]:
                continue
            for uid in p["members"] & fresh.keys():
                if p["date"] == fresh[uid]:
                    by_paper[p["id"]].append(people[uid])
    new_all = []
    for pid, newcomers in by_paper.items():
        p = college.pubs[pid]
        authors = authors_of(p)
        if in_department(authors):
            new_all.append((p, authors, sorted(newcomers, key=lambda u: (u.name or "").casefold())))
    new_all.sort(key=lambda t: (t[0]["date"], t[0]["title"]), reverse=True)
    new_names = [
        _item(p, authors, f"First paper on the college record for {_names(newcomers)}")
        for p, authors, newcomers in new_all[:PER_SECTION]
    ]

    # What the page's sentence says: the papers of the department asked for,
    # or of the whole college when none was.
    scoped = [(p, a) for p, a in recent if in_department(a)]

    # ---- By department, whatever the department filter says ----
    papers_per: Counter[str] = Counter()
    q1_per: Counter[str] = Counter()
    for p, authors in recent:
        departments = {_key(a.department) for a in authors if (a.department or "").strip()}
        for d in departments:
            papers_per[d] += 1
            q1_per[d] += (p["quartile"] or "").strip().upper() == "Q1"
    by_department = [
        {"department": spelled.get(d, d), "papers": n, "q1": q1_per[d]}
        for d, n in sorted(papers_per.items(), key=lambda kv: (-kv[1], -q1_per[kv[0]], kv[0]))[:12]
    ]

    return {
        "period": period,
        "label": LABELS[period],
        "from": start.isoformat(),
        "to": today.isoformat(),
        "windows": {"days": days, "most_cited_days": cited_days},
        "department": spelled.get(wanted) if wanted else None,
        "departments": sorted(spelled.values(), key=str.casefold),
        "q1": q1,
        "first_papers": first_papers,
        "most_cited": most_cited,
        "new_names": new_names,
        "by_department": by_department,
        "counts": {
            "q1": len(q1_all),
            "first_papers": len(firsts_all),
            "most_cited": len(cited_all),
            "new_names": len(new_all),
        },
        "totals": {
            "papers": len(scoped),
            "q1": sum(1 for p, _ in scoped if (p["quartile"] or "").strip().upper() == "Q1"),
            "people": len({a.id for _, authors in scoped for a in authors}),
        },
        "empty": not (q1 or first_papers or most_cited or new_names or by_department),
    }
