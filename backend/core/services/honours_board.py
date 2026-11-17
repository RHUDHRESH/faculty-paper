"""The report-grade leaderboard: many categories, many views, one source.

Counted from the Scopus-linked papers on people's records (`Publication` /
`Authorship`, filtered by the same "Scopus-linked" rule the faculty directory
uses) and from nothing else: no claim, no paid-ledger row, no spreadsheet of
the college's own. A paper's quartile and SNIP come from the journal tables by
ISSN and year (`journal_figures`), its citations are the Scopus figure the
app stores, and no amount is selected anywhere.

Built in two layers so a 0.1-CPU host pays once:

1. `_record()` -- one pass over the roster and the record (four queries),
   kept in this process for five minutes and dropped the moment the
   aggregate generation moves (any write).
2. `board()` -- one category x period x scope x filter, arithmetic over the
   record, stored in the shared aggregate cache. It is the same for every
   reader; only `me` (added by `for_viewer`) depends on who asks.

Rules a reader could doubt, each pinned by core/test_honours_board.py:

- **Score** (the overall board) is the weighted sum the research coordinator
  sets (`leaderboard_weights`), 0 to 100. Most improved is the change in that
  score between the two periods, Newcomers ranks people whose first paper is
  recent by it, and a department's figure is the total (and average) of its
  members' scores, each worked out among the whole college. Nothing here reads
  quartile points from a claim or the ledger.
- **Who is on a paper**: only authorships matched by an identifier, the record
  or a person's own confirmation (`STRONG_MATCHES`); a name-only match is a
  guess and is treated as somebody outside the college.
- **When** is the publication date; a paper with only a year counts from
  1 January of that year, and one with neither counts in all time only.
- **Nobody with nothing is ranked.** A zero is shown as "--", not as a tie
  for 54th: ranking zeros invents a place nobody earned.
- **Ties** share a place ("=4") and the next place skips.
- **Most cited** is the current citations of papers *published* in the
  period: OpenAlex gives counts, not a history of when they were earned.
- **Departments** count each paper once however many of their people wrote
  it; per-faculty divides by the active faculty and heads in the department.
"""

from __future__ import annotations

import json
import math
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Optional

from django.conf import settings
from django.db.models import Max
from django.utils import timezone

from core.models import Authorship, Publication, Team, User
from core.services import aggregate_cache, leaderboard_weights as lw
from core.services.journal_figures import Journals
from core.services.leaderboard import Span, before as _before_academic, span as _span_academic
from core.services.paper_facts import RANKED_ROLES

#: How an authorship may have been matched to a person and still count here: by an
#: identifier (Scopus id, author id, ORCID), by the record itself, or by a person's own
#: confirmation. A match on the name alone ("name", "name_dept", an alias) is a guess and
#: never counts towards a Scopus leaderboard.
STRONG_MATCHES = ("record", "scopus", "scopus_sheet", "scopus_id", "author_id", "orcid", "manual", "confirmed")

WEIGHTS = {"Q1": 4, "Q2": 3, "Q3": 2, "Q4": 1}
OTHER = 1

CATEGORIES = (
    "score", "papers", "q1", "first", "cited", "h_index",
    "rising", "collab", "cross_dept", "international", "newcomer",
)
PERIODS = ("academic", "last_academic", "calendar", "last12", "all")
VIEWS = ("people", "departments")

LABELS = {
    "score": "Overall score",
    "papers": "Most papers",
    "q1": "Q1 papers",
    "first": "First-author papers",
    "cited": "Most cited",
    "h_index": "h-index",
    "rising": "Rising",
    "collab": "Most collaborative",
    "cross_dept": "Across departments",
    "international": "International",
    "newcomer": "Newcomers",
}
UNITS = {
    "score": "points", "papers": "papers", "q1": "Q1 papers", "first": "first-author papers",
    "cited": "citations", "h_index": "h-index", "rising": "points gained", "collab": "co-authors",
    "cross_dept": "cross-department papers", "international": "international papers", "newcomer": "points",
}

#: Newcomer: first paper in the record within this many months.
NEWCOMER_MONTHS = 24
SPARK_YEARS = 5
KEEP_SECONDS = 300


def today() -> date:
    return timezone.localdate()


def score_of(quartile: str) -> int:
    return WEIGHTS.get(quartile, OTHER)


# --------------------------------------------------------------------------- #
# Periods                                                                     #
# --------------------------------------------------------------------------- #


def span(period: str, on: date) -> Span:
    if period == "last12":
        return Span("last12", "Last 12 months", on - timedelta(days=365), on)
    return _span_academic(period, on)


def before(period: str, on: date) -> Span | None:
    if period == "last12":
        return Span("previous", "The 12 months before", on - timedelta(days=730), on - timedelta(days=366))
    return _before_academic(period, on)


def _holds(s: Span | None, d: Optional[date]) -> bool:
    """All time holds every paper, dated or not; a dated period only dated ones."""
    if s is None:
        return False
    if s.start is None:
        return True
    return d is not None and s.start <= d <= s.end


# --------------------------------------------------------------------------- #
# The record, once                                                            #
# --------------------------------------------------------------------------- #


@dataclass
class Paper:
    id: str
    title: str
    #: None when the record has no date or year: counted in all time only.
    when: Optional[date]
    year: Optional[int]
    venue: str
    quartile: str
    citations: int
    topics: tuple[str, ...]
    members: dict[str, Optional[int]] = field(default_factory=dict)  # uid -> position
    corresponding: set[str] = field(default_factory=set)  # uids marked corresponding author
    #: The journal's SNIP for the paper's year, from the journal tables (0 when the journal is in none).
    snip: float = 0.0
    eid: str = ""
    others: set[str] = field(default_factory=set)  # author keys of everybody else
    international: bool = False


@dataclass
class Record:
    people: dict[str, dict[str, Any]]
    papers: list[Paper]
    first_seen: dict[str, date]
    #: mentor uid -> the Scopus-linked papers their student teams' rosters name by EID.
    mentored: dict[str, list[Paper]] = field(default_factory=dict)
    #: The newest time anybody's Scopus profile was synced; None before the first sync.
    synced_at: Optional[datetime] = None


_MEMO: tuple[float, int, Record] | None = None
_LOCK = threading.Lock()


def forget() -> None:
    global _MEMO
    with _LOCK:
        _MEMO = None


def _generic(topic: str) -> bool:
    k = " ".join(topic.lower().split())
    return "research topics" in k or "miscellaneous" in k or k in ("multidisciplinary", "general")


def _topics(raw: str) -> tuple[str, ...]:
    try:
        value = json.loads(raw or "[]")
    except ValueError:
        return ()
    if not isinstance(value, list):
        return ()
    return tuple(str(t).strip() for t in value if str(t).strip() and not _generic(str(t)))


def _initials(name: str) -> str:
    from core.social import initials

    return initials(name)


def _build() -> Record:
    people: dict[str, dict[str, Any]] = {}
    for uid, name, dept, designation, photo in User.objects.filter(
        active=True, role__in=RANKED_ROLES
    ).values_list("id", "name", "department", "designation", "photo"):
        people[uid] = {
            "id": uid,
            "name": name or "A colleague",
            "initials": _initials(name or ""),
            "photo_url": f"{settings.MEDIA_URL}{photo}" if photo else None,
            "department": (dept or "").strip() or None,
            "designation": designation or None,
        }
    # Only papers the Scopus sync linked: flagged by it or carrying an EID. The
    # rule is the faculty directory's own, so the two pages cannot disagree.
    from core.api.faculty_directory import _SCOPUS_LINKED  # an API module: imported late, as a service must

    pub_ids = set(
        Authorship.objects.filter(user_id__in=people.keys(), match_method__in=STRONG_MATCHES)
        .filter(_SCOPUS_LINKED)
        .values_list("publication_id", flat=True)
    )
    rows = list(
        Publication.objects.filter(id__in=pub_ids).values(
            "id", "title", "year", "date", "venue", "issn", "eid", "scopus_citations", "topics_json"
        )
    )
    journals = Journals(r["issn"] for r in rows)
    papers: dict[str, Paper] = {}
    for p in rows:
        when = p["date"] or (date(p["year"], 1, 1) if p["year"] else None)
        quartile, snip = journals.lookup(p["issn"], when.year if when else p["year"])
        papers[p["id"]] = Paper(
            id=p["id"], title=p["title"] or "", when=when, year=when.year if when else None,
            venue=(p["venue"] or "").strip(), quartile=quartile,
            # The Scopus figure the app stores; a paper Scopus has not counted has none.
            citations=p["scopus_citations"] or 0, topics=_topics(p["topics_json"]),
            snip=float(snip or 0.0), eid=(p["eid"] or "").strip().lower(),
        )
    for pid, uid, pos, key, country, corresponding, method in Authorship.objects.filter(
        publication_id__in=papers.keys()
    ).values_list(
        "publication_id", "user_id", "position", "author_key", "institution_country", "is_corresponding", "match_method"
    ):
        paper = papers[pid]
        if uid in people and method in STRONG_MATCHES:
            # A person on a paper twice (two matched rows) keeps their best position.
            old = paper.members.get(uid)
            paper.members[uid] = pos if old is None else (min(old, pos) if pos else old)
            if corresponding:
                paper.corresponding.add(uid)
        else:
            paper.others.add(f"u:{uid}" if uid else key)
        c = (country or "").strip().upper()
        if c and c != "IN":
            paper.international = True
    first_seen: dict[str, date] = {}
    for paper in papers.values():
        for uid in paper.members:
            if paper.when is None:
                continue
            if uid not in first_seen or paper.when < first_seen[uid]:
                first_seen[uid] = paper.when
    return Record(
        people=people, papers=list(papers.values()), first_seen=first_seen,
        mentored=_mentored(people, papers),
        synced_at=User.objects.aggregate(t=Max("scopus_synced_at"))["t"],
    )


def _mentored(people: dict[str, dict[str, Any]], papers: dict[str, Paper]) -> dict[str, list[Paper]]:
    """Per mentor, the linked papers their teams' rosters name by Scopus EID.

    A roster article with no EID, or an EID that matches no linked paper, is
    not counted: the roster is the college's own list and is evidence only
    when Scopus agrees.
    """
    by_eid = {p.eid: p for p in papers.values() if p.eid}
    out: dict[str, set[str]] = defaultdict(set)
    for mentor, listed in Team.objects.filter(active=True, mentor__isnull=False).values_list("mentor_id", "publications"):
        if mentor not in people or not isinstance(listed, list):
            continue
        for item in listed:
            eid = str(item.get("scopus_eid") or "").strip().lower() if isinstance(item, dict) else ""
            if eid in by_eid:
                out[mentor].add(eid)
    return {m: [by_eid[e] for e in sorted(eids)] for m, eids in out.items()}


def record() -> Record:
    global _MEMO
    gen = aggregate_cache.generation()
    now = time.monotonic()
    memo = _MEMO
    if memo is not None and memo[0] > now and memo[1] == gen:
        return memo[2]
    with _LOCK:
        if _MEMO is not None and _MEMO[0] > time.monotonic() and _MEMO[1] == gen:
            return _MEMO[2]
        built = _build()
        _MEMO = (time.monotonic() + KEEP_SECONDS, gen, built)
        return built


# --------------------------------------------------------------------------- #
# Measuring                                                                   #
# --------------------------------------------------------------------------- #


def h_index(cites: list[int]) -> int:
    ranked = sorted((c for c in cites if c), reverse=True)
    return sum(1 for i, c in enumerate(ranked, start=1) if c >= i)


def _dept_key(name: Optional[str]) -> str:
    return (name or "").strip().casefold()


def _tally(papers: list[Paper], uid: Optional[str], dept_of: dict[str, str], dept: Optional[str] = None) -> dict[str, Any]:
    """Every measure over a set of papers, for one person (uid) or one
    department (dept key, uid None)."""
    b = Counter()
    first = cross = intl = cited = 0
    coauthors: set[str] = set()
    for p in papers:
        b[p.quartile if p.quartile in WEIGHTS else "other"] += 1
        cited += p.citations
        intl += p.international
        if uid is not None:
            first += p.members.get(uid) == 1
            mine = dept_of.get(uid, "")
            cross += any(dept_of.get(m, "") != mine for m in p.members if m != uid)
            coauthors |= {f"u:{m}" for m in p.members if m != uid} | p.others
        else:
            inside = [m for m in p.members if dept_of.get(m) == dept]
            first += any(p.members[m] == 1 for m in inside)
            cross += any(dept_of.get(m) != dept for m in p.members)
            coauthors |= {f"u:{m}" for m in p.members if dept_of.get(m) != dept} | p.others
    score = sum(WEIGHTS[q] * b[q] for q in WEIGHTS) + OTHER * b["other"]
    return {
        "papers": len(papers),
        "score": score,
        "q1": b["Q1"],
        "first": first,
        "cited": cited,
        "h_index": h_index([p.citations for p in papers]),
        "collab": len(coauthors),
        "cross_dept": cross,
        "international": intl,
        "breakdown": {"q1": b["Q1"], "q2": b["Q2"], "q3": b["Q3"], "q4": b["Q4"], "other": b["other"]},
    }


def _ranks(values: dict[str, float]) -> dict[str, tuple[Optional[int], bool]]:
    """Competition ranking over the non-zero values; zeros are unranked."""
    live = sorted((v for v in values.values() if v > 0), reverse=True)
    first_at: dict[float, int] = {}
    count: Counter = Counter(live)
    for i, v in enumerate(live):
        first_at.setdefault(v, i + 1)
    return {k: ((first_at[v], count[v] > 1) if v > 0 else (None, False)) for k, v in values.items()}


def _buckets(values: list[float]) -> list[dict[str, Any]]:
    """A histogram: nothing (zero or less) on its own, then up to 8 equal bins.
    Every measure is a whole number but the weighted score, which rounds up."""
    live = [math.ceil(v) for v in values if v > 0]
    out = [{"bucket": "0", "lo": None, "hi": 0, "count": sum(1 for v in values if v <= 0)}]
    if not live:
        return out
    width = max(1, math.ceil(max(live) / 8))
    for lo in range(1, max(live) + 1, width):
        hi = lo + width - 1
        out.append({
            "bucket": str(lo) if hi == lo else f"{lo}–{hi}",
            "lo": lo, "hi": hi, "count": sum(1 for v in live if lo <= v <= hi),
        })
    return out


def _filter(papers: list[Paper], topic: str, journal: str) -> list[Paper]:
    t, j = topic.strip().casefold(), journal.strip().casefold()
    if t:
        papers = [p for p in papers if any(t == x.casefold() for x in p.topics)]
    if j:
        papers = [p for p in papers if p.venue.casefold() == j]
    return papers


def _dept_names(people: dict[str, dict[str, Any]]) -> dict[str, str]:
    spellings: dict[str, Counter] = defaultdict(Counter)
    for p in people.values():
        if p["department"]:
            spellings[_dept_key(p["department"])][p["department"]] += 1
    return {k: max(v.items(), key=lambda kv: (kv[1], kv[0]))[0] for k, v in spellings.items()}


# --------------------------------------------------------------------------- #
# One board                                                                   #
# --------------------------------------------------------------------------- #


def board(
    *, category: str, period: str, department: str = "", topic: str = "", journal: str = "",
    on: Optional[date] = None,
) -> dict[str, Any]:
    """Viewer-independent, so cached for everyone.

    The overall score depends on the saved weights, so the weights in force are
    part of its cache key: saving new ones is seen at once, not in a minute.
    """
    on = on or today()
    weights = lw.current()["weights"]
    params = {
        "c": category, "p": period, "d": _dept_key(department), "t": topic, "j": journal, "on": on.isoformat(),
        "w": lw.fingerprint(weights) if weights else "",
    }
    return aggregate_cache.cached(
        "honours_board", params,
        lambda: _board(category=category, period=period, department=department, topic=topic, journal=journal,
                       on=on, weights=weights),
    )


def preview(*, weights: dict[str, int], period: str, department: str = "", on: Optional[date] = None) -> dict[str, Any]:
    """The overall board under weights nobody has saved. Never cached, never stored."""
    return _board(category="score", period=period, department=department, topic="", journal="",
                  on=on or today(), weights=weights)


def _board(
    *, category: str, period: str, department: str, topic: str, journal: str, on: date,
    weights: Optional[dict[str, int]] = None,
) -> dict[str, Any]:
    rec = record()
    names = _dept_names(rec.people)
    dept_of = {uid: _dept_key(p["department"]) for uid, p in rec.people.items()}
    wanted = _dept_key(department)
    population = {uid for uid in rec.people if not wanted or dept_of[uid] == wanted}

    now, then = span(period, on), before(period, on)
    if category == "rising" and then is None:  # all time has no "before": compare academic years
        now, then = span("academic", on), before("academic", on)
    papers = _filter(rec.papers, topic, journal)

    by_person_now: dict[str, list[Paper]] = defaultdict(list)
    by_person_then: dict[str, list[Paper]] = defaultdict(list)
    by_person_year: dict[str, Counter] = defaultdict(Counter)
    by_person_all: dict[str, list[Paper]] = defaultdict(list)
    for p in papers:
        in_now, in_then = _holds(now, p.when), _holds(then, p.when)
        for uid in p.members:
            by_person_year[uid][p.year] += 1
            by_person_all[uid].append(p)
            if in_now:
                by_person_now[uid].append(p)
            if in_then:
                by_person_then[uid].append(p)

    newcomer_since = on - timedelta(days=NEWCOMER_MONTHS * 30)
    eligible = population
    if category == "newcomer":
        eligible = {u for u in population if rec.first_seen.get(u) and rec.first_seen[u] >= newcomer_since}

    everyone = set(rec.people)
    tallies: dict[str, dict[str, Any]] = {}
    before_tallies: dict[str, dict[str, Any]] = {}
    for uid in everyone:
        tallies[uid] = _tally(by_person_now.get(uid, []), uid, dept_of)
        before_tallies[uid] = _tally(by_person_then.get(uid, []), uid, dept_of)

    # The weighted score (core.services.leaderboard_weights), from Scopus-linked
    # papers only. Percentiles are taken among the people it is worked out for:
    # the board's own scope for the Overall board, the whole college for the
    # figures every other board and the department table are built from.
    in_scope_ids = {p.id for p in papers}

    def weighted(win: Span, by_person: dict[str, list[Paper]], tally_of: dict[str, dict[str, Any]], who: set[str]):
        anchor = min(on, win.end) if win.end else on
        figures = {}
        for uid in who:
            mentored = [p for p in rec.mentored.get(uid, []) if p.id in in_scope_ids and _holds(win, p.when)]
            figures[uid] = lw.metrics(
                tally=tally_of[uid], now_papers=by_person.get(uid, []), all_papers=by_person_all.get(uid, []),
                mentored=mentored, anchor=anchor, uid=uid,
            )
        return lw.score_all(figures, weights or lw.DEFAULTS)

    college = weighted(now, by_person_now, tallies, everyone)
    college_then = weighted(then, by_person_then, before_tallies, everyone) if then is not None else None
    scored = scored_then = None
    if category == "score":
        same = eligible == everyone
        scored = college if same else weighted(now, by_person_now, tallies, eligible)
        if then is not None:
            scored_then = college_then if same else weighted(then, by_person_then, before_tallies, eligible)
        values = {u: scored[u]["score"] for u in eligible}
    elif category == "rising":
        # Change in the weighted score between the two periods, both from Scopus dates.
        values = {u: round(college[u]["score"] - (college_then[u]["score"] if college_then else 0), 2) for u in eligible}
    elif category == "newcomer":
        values = {u: college[u]["score"] for u in eligible}
    else:
        values = {u: tallies[u][category] for u in eligible}
    ranks = _ranks(values)

    # Movement: where the same measure put them the period before.
    prev_ranks: dict[str, tuple[Optional[int], bool]] = {}
    if then is not None and category not in ("rising",):
        if scored_then is not None:
            prev_values = {u: scored_then[u]["score"] for u in eligible}
        elif category == "newcomer":
            prev_values = {u: college_then[u]["score"] for u in eligible}
        else:
            prev_values = {u: before_tallies[u][category] for u in eligible}
        prev_ranks = _ranks(prev_values)

    years = list(range(on.year - SPARK_YEARS + 1, on.year + 1))
    rows = []
    for uid in eligible:
        rank, joint = ranks[uid]
        t = tallies[uid]
        move: Optional[int] = None
        new = False
        if rank is not None and prev_ranks:
            prev = prev_ranks[uid][0]
            if prev is None:
                new = True
            else:
                move = prev - rank
        rows.append({
            "rank": rank,
            "joint": joint,
            "person": rec.people[uid],
            "value": values[uid],
            "papers": t["papers"], "score": college[uid]["score"], "q1": t["q1"], "first": t["first"],
            "cited": t["cited"], "h_index": t["h_index"],
            "breakdown": t["breakdown"],
            **({"contributions": lw.contributions(scored[uid]["parts"])} if scored else {}),
            "spark": [by_person_year[uid][y] for y in years],
            "move": move,
            "new": new,
        })
    rows.sort(key=lambda r: (r["rank"] is None, r["rank"] or 0, -r["score"], r["person"]["name"].casefold()))
    ranked = [r for r in rows if r["rank"] is not None]

    # Departments: each paper once per department.
    # Across the whole college whatever the scope: a head looking at their own
    # department still compares it with the others, per teacher.
    active_now = {m for p in papers if _holds(now, p.when) for m in p.members}
    heads: Counter = Counter(dept_of[u] for u in everyone if dept_of[u])
    dept_now: dict[str, list[Paper]] = defaultdict(list)
    dept_then: dict[str, list[Paper]] = defaultdict(list)
    dept_year: dict[str, Counter] = defaultdict(Counter)
    for p in papers:
        ds = {dept_of[m] for m in p.members if m in everyone and dept_of.get(m)}
        for d in ds:
            dept_year[d][p.year] += 1
            if _holds(now, p.when):
                dept_now[d].append(p)
            if _holds(then, p.when):
                dept_then[d].append(p)
    newcomers_college = {u: bool(rec.first_seen.get(u) and rec.first_seen[u] >= newcomer_since) for u in everyone}
    departments = []
    for d, n in heads.items():
        t = _tally(dept_now.get(d, []), None, dept_of, d)
        members = [u for u in everyone if dept_of[u] == d]
        total = round(sum(college[u]["score"] for u in members), 2)
        if category == "score":
            v = total
        elif category == "rising":
            v = round(total - sum(college_then[u]["score"] for u in members), 2) if college_then else total
        elif category == "newcomer":
            v = round(sum(college[u]["score"] for u in members if newcomers_college.get(u)), 2)
        else:
            v = t[category]
        departments.append({
            "department": names.get(d, d),
            "faculty": n,
            "value": v,
            "per_faculty": round(v / n, 2) if n else 0,
            "papers": t["papers"], "score": total, "q1": t["q1"], "cited": t["cited"],
            "papers_per_faculty": round(t["papers"] / n, 2) if n else 0,
            # The department's total of its members' weighted scores, and the average per member.
            "score_per_faculty": round(total / n, 2) if n else 0,
            "active": sum(1 for u in everyone if dept_of[u] == d and u in active_now),
            "trend": [{"year": y, "papers": dept_year[d][y]} for y in years],
        })
    d_ranks = _ranks({x["department"]: x["value"] for x in departments})
    d_ranks_pf = _ranks({x["department"]: x["per_faculty"] for x in departments})
    for x in departments:
        x["rank"], x["joint"] = d_ranks[x["department"]]
        x["rank_per_faculty"] = d_ranks_pf[x["department"]][0]
    departments.sort(key=lambda x: (x["rank"] is None, x["rank"] or 0, -x["papers"], x["department"].casefold()))

    # The college over the years, and what the period was about.
    college_years: Counter = Counter()
    topics: Counter = Counter()
    venues: Counter = Counter()
    in_scope = [p for p in papers if any(m in population for m in p.members)]
    for p in in_scope:
        college_years[p.year] += 1
        if _holds(now, p.when):
            topics.update(p.topics)
            if p.venue:
                venues[p.venue] += 1
    span_years = list(range(on.year - 9, on.year + 1))
    all_topics: Counter = Counter()
    all_venues: Counter = Counter()
    for p in rec.papers:
        all_topics.update(p.topics)
        if p.venue:
            all_venues[p.venue] += 1

    return {
        # Not "category": that key names a payout band and hod.without_money
        # strips it from every response.
        "measure": category,
        "label": LABELS[category],
        "unit": UNITS[category],
        "period": {**now.as_dict(), "compared_with": then.as_dict() if then else None},
        "periods": [span(p, on).as_dict() for p in PERIODS],
        "scope": names.get(wanted) if wanted else None,
        "departments_list": sorted(names.values(), key=str.casefold),
        "filters": {"topic": topic or None, "journal": journal or None},
        "podium": ranked[:3],
        "rows": rows,
        "ranked": len(ranked),
        "population": len(eligible),
        "distribution": _buckets(list(values.values())),
        "departments": departments,
        "college_trend": [{"year": y, "papers": college_years[y]} for y in span_years],
        "top_topics": [{"topic": k, "papers": v} for k, v in topics.most_common(10)],
        "top_journals": [{"journal": k, "papers": v} for k, v in venues.most_common(10)],
        "topic_options": [k for k, _ in all_topics.most_common(40)],
        "journal_options": [k for k, _ in all_venues.most_common(40)],
        "totals": {
            "papers": sum(1 for p in in_scope if _holds(now, p.when)),
            "people": len(population),
            "people_with_papers": sum(1 for u in population if by_person_now.get(u)),
        },
        "spark_years": years,
        "method": {
            "weights": {**WEIGHTS, "other": OTHER},
            "source": lw.SOURCE,
            "scopus_synced_at": rec.synced_at.isoformat() if rec.synced_at else None,
            "scoring": {"weights": lw.describe(weights or lw.current()["weights"]), "normalisation": lw.NORMALISATION},
            "papers_in_record": len(rec.papers),
            "newcomer_months": NEWCOMER_MONTHS,
            "updated": timezone.now().isoformat(),
        },
    }


def for_viewer(payload: dict[str, Any], viewer: User, *, category: str, period: str) -> dict[str, Any]:
    """The reader's own place, in the college and in their department."""
    uid = getattr(viewer, "pk", None)
    rows = payload["rows"]
    mine = next((r for r in rows if r["person"]["id"] == uid), None)
    if mine is None:
        return {**payload, "me": None}
    dept = _dept_key(mine["person"]["department"])
    same = [r for r in rows if _dept_key(r["person"]["department"]) == dept and r["value"] > 0]
    dept_rank = None
    if mine["rank"] is not None:
        dept_rank = 1 + sum(1 for r in same if r["value"] > mine["value"])
    ranked = payload["ranked"]
    percentile = math.ceil(mine["rank"] / ranked * 100) if mine["rank"] and ranked else None
    alltime = None
    if mine["rank"] is None and period != "all":
        other = board(category=category, period="all", department=payload["scope"] or "",
                      topic=payload["filters"]["topic"] or "", journal=payload["filters"]["journal"] or "")
        again = next((r for r in other["rows"] if r["person"]["id"] == uid), None)
        alltime = again["rank"] if again else None
    return {
        **payload,
        "me": {
            "id": uid,
            "rank": mine["rank"],
            "joint": mine["joint"],
            "of": ranked,
            "population": payload["population"],
            "dept_rank": dept_rank,
            "dept_of": len(same),
            "department": mine["person"]["department"],
            "percentile": percentile,
            "move": mine["move"],
            "value": mine["value"],
            "alltime_rank": alltime,
        },
    }
