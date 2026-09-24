"""Who published, and which department, over a period -- ranked, with no money.

Arithmetic over `paper_facts`, nothing more: the facts are built once and
cached, and a board is a pass over them for the period asked about and one
for the period before it (to say who moved).

The weighting is printed on the page and pinned by the tests:

    Q1 = 4, Q2 = 3, Q3 = 2, Q4 = 1, any other indexed paper = 1, otherwise 0

It rewards quartile without making an unranked-but-indexed paper worthless,
which is the college's incentive policy in shape if not in rupees -- and
there are no rupees here at all. A leaderboard of amounts would be a
leaderboard of other people's pay.

Ranks are shared on a tie ("joint 3rd"), and the next rank skips accordingly,
because two people with the same score are in the same place and printing
one above the other would be a claim the numbers do not make.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable

from django.utils import timezone

from core.services.paper_facts import Fact, Facts, Person

WEIGHTS = {"Q1": 4, "Q2": 3, "Q3": 2, "Q4": 1}
OTHER_INDEXED = 1

SORTS = ("score", "papers", "q1", "first_author")
BOARDS = ("people", "departments")
PERIODS = ("academic", "last_academic", "calendar", "all")
METRICS = SORTS


def today() -> date:
    return timezone.localdate()


def score_of(fact: Fact) -> int:
    if fact.quartile in WEIGHTS:
        return WEIGHTS[fact.quartile]
    return OTHER_INDEXED if fact.indexed else 0


# --------------------------------------------------------------------------- #
# Periods                                                                     #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Span:
    key: str
    label: str
    start: date | None
    end: date | None

    def holds(self, fact: Fact) -> bool:
        if self.start is None:
            return True
        return fact.published is not None and self.start <= fact.published <= self.end

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "from": self.start.isoformat() if self.start else None,
            "to": self.end.isoformat() if self.end else None,
        }


def _academic(start_year: int, key: str, label: str) -> Span:
    return Span(key, label, date(start_year, 6, 1), date(start_year + 1, 5, 31))


def _academic_start_year(on: date) -> int:
    # The college's 1 June rule, from the one place that already states it.
    # Imported here rather than at the top: it lives in an API module, and a
    # service importing the API package at load time is an import cycle.
    from core.api.my_payments import academic_year_start

    return academic_year_start(on).year


def span(period: str, on: date) -> Span:
    this_year = _academic_start_year(on)
    if period == "academic":
        return _academic(this_year, "academic", f"This academic year ({this_year}–{str(this_year + 1)[2:]})")
    if period == "last_academic":
        y = this_year - 1
        return _academic(y, "last_academic", f"Last academic year ({y}–{str(y + 1)[2:]})")
    if period == "calendar":
        return Span("calendar", f"This calendar year ({on.year})", date(on.year, 1, 1), date(on.year, 12, 31))
    return Span("all", "All time", None, None)


def before(period: str, on: date) -> Span | None:
    """The period a movement is measured against. All time has none."""
    this_year = _academic_start_year(on)
    if period == "academic":
        return _academic(this_year - 1, "last_academic", f"{this_year - 1}–{str(this_year)[2:]}")
    if period == "last_academic":
        y = this_year - 2
        return _academic(y, "previous", f"{y}–{str(y + 1)[2:]}")
    if period == "calendar":
        y = on.year - 1
        return Span("previous", str(y), date(y, 1, 1), date(y, 12, 31))
    return None


def periods(on: date) -> list[dict[str, Any]]:
    return [span(p, on).as_dict() for p in PERIODS]


# --------------------------------------------------------------------------- #
# Counting                                                                    #
# --------------------------------------------------------------------------- #


def _empty() -> dict[str, int]:
    return {"papers": 0, "q1": 0, "score": 0, "first_author": 0}


def _add(tally: dict[str, int], fact: Fact) -> None:
    tally["papers"] += 1
    tally["q1"] += fact.quartile == "Q1"
    tally["score"] += score_of(fact)
    tally["first_author"] += fact.first_author is True


def _people_tallies(facts: Iterable[Fact], within: Span) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = defaultdict(_empty)
    for fact in facts:
        if within.holds(fact):
            _add(out[fact.person_id], fact)
    return out


def _department_tallies(
    facts: Iterable[Fact], within: Span, department_of: dict[str, str]
) -> dict[str, dict[str, int]]:
    """Per department, each paper once -- however many of its people wrote it.

    First author for the department if any of its people was first author.
    """
    papers: dict[tuple[str, str], Fact] = {}
    first: set[tuple[str, str]] = set()
    for fact in facts:
        dept = department_of.get(fact.person_id)
        if not dept or not within.holds(fact):
            continue
        slot = (dept, fact.key)
        papers.setdefault(slot, fact)
        if fact.first_author:
            first.add(slot)
    out: dict[str, dict[str, int]] = defaultdict(_empty)
    for (dept, key), fact in papers.items():
        tally = out[dept]
        tally["papers"] += 1
        tally["q1"] += fact.quartile == "Q1"
        tally["score"] += score_of(fact)
        tally["first_author"] += (dept, key) in first
    return out


def _ranks(values: dict[str, float]) -> dict[str, tuple[int, bool]]:
    """Competition ranking: equal values share a place; the next one skips."""
    ordered = sorted(values.values(), reverse=True)
    first_at: dict[float, int] = {}
    counts: dict[float, int] = defaultdict(int)
    for i, v in enumerate(ordered):
        first_at.setdefault(v, i + 1)
        counts[v] += 1
    return {k: (first_at[v], counts[v] > 1) for k, v in values.items()}


def _dept_key(name: str) -> str:
    return (name or "").strip().casefold()


def _departments(people: dict[str, Person]) -> dict[str, str]:
    """casefolded key -> the spelling most people's accounts use."""
    spellings: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for p in people.values():
        if p.department:
            spellings[_dept_key(p.department)][p.department] += 1
    return {k: max(v.items(), key=lambda kv: (kv[1], kv[0]))[0] for k, v in spellings.items()}


def _method(facts: Facts) -> dict[str, Any]:
    return {
        "weights": {**WEIGHTS, "other_indexed": OTHER_INDEXED},
        "from_claims": facts.from_claims,
        "from_ledger": facts.from_ledger,
        "left_out": facts.left_out,
        # Nothing the college holds records citations, so none are ranked.
        "citations": False,
        "updated": facts.built_at.isoformat(),
    }


# --------------------------------------------------------------------------- #
# The two boards                                                              #
# --------------------------------------------------------------------------- #


def people_board(
    facts: Facts,
    *,
    period: str,
    sort: str = "score",
    department: str | None = None,
    viewer=None,
    on: date | None = None,
) -> dict[str, Any]:
    on = on or today()
    now, then = span(period, on), before(period, on)
    names = _departments(facts.people)
    wanted = _dept_key(department or "")
    population = {
        pid: p
        for pid, p in facts.people.items()
        if not wanted or _dept_key(p.department) == wanted
    }

    current = _people_tallies((f for f in facts.facts if f.person_id in population), now)
    ranks = _ranks({pid: current[pid][sort] if pid in current else 0 for pid in population})
    previous = previous_ranks = None
    if then is not None:
        previous = _people_tallies((f for f in facts.facts if f.person_id in population), then)
        previous_ranks = _ranks({pid: previous[pid][sort] if pid in previous else 0 for pid in population})

    viewer_id = getattr(viewer, "pk", None)
    rows = []
    for pid, person in population.items():
        tally = current.get(pid) or _empty()
        rank, joint = ranks[pid]
        # Only somebody with something this period has moved. Everybody with
        # nothing shares the bottom place, so their "movement" would be a
        # count of how many others have published yet -- measured on the
        # live data, a head with no papers so far this year showed "up 21".
        movement = None
        if previous is not None and tally[sort]:
            movement = previous_ranks[pid][0] - rank
        rows.append(
            {
                "id": pid,
                "name": person.name,
                "department": names.get(_dept_key(person.department)) or None,
                "designation": person.designation or None,
                "rank": rank,
                "joint": joint,
                **tally,
                "movement": movement,
                "me": pid == viewer_id,
            }
        )
    rows.sort(key=lambda r: (r["rank"], -r["score"], -r["q1"], -r["papers"], r["name"].casefold()))

    mine = next((r for r in rows if r["me"]), None)
    return {
        "board": "people",
        "period": {**now.as_dict(), "compared_with": then.as_dict() if then else None},
        "periods": periods(on),
        "sort": sort,
        "department": names.get(wanted) if wanted else None,
        "departments": sorted(names.values(), key=str.casefold),
        "rows": rows,
        "me": (
            {
                "rank": mine["rank"],
                "of": len(rows),
                "joint": mine["joint"],
                "value": mine[sort],
                "movement": mine["movement"],
            }
            if mine
            else None
        ),
        "totals": {
            "papers": len({f.key for f in facts.facts if f.person_id in population and now.holds(f)}),
            "people": len(rows),
            "people_with_papers": sum(1 for r in rows if r["papers"]),
        },
        "method": _method(facts),
    }


def department_board(
    facts: Facts,
    *,
    period: str,
    sort: str = "score",
    per_head: bool = False,
    viewer=None,
    on: date | None = None,
) -> dict[str, Any]:
    on = on or today()
    now, then = span(period, on), before(period, on)
    names = _departments(facts.people)
    department_of = {
        pid: _dept_key(p.department) for pid, p in facts.people.items() if p.department
    }
    heads: dict[str, int] = defaultdict(int)
    for key in department_of.values():
        heads[key] += 1

    def value(tallies: dict[str, dict[str, int]], key: str) -> float:
        raw = (tallies.get(key) or _empty())[sort]
        return raw / heads[key] if per_head else raw

    current = _department_tallies(facts.facts, now, department_of)
    ranks = _ranks({k: value(current, k) for k in names})
    previous = previous_ranks = None
    if then is not None:
        previous = _department_tallies(facts.facts, then, department_of)
        previous_ranks = _ranks({k: value(previous, k) for k in names})

    # A department is "yours" only if you are counted in it. A Principal whose
    # account happens to carry a department is not one of its faculty.
    viewer_id = getattr(viewer, "pk", None)
    mine_key = _dept_key(facts.people[viewer_id].department) if viewer_id in facts.people else ""
    rows = []
    for key, name in names.items():
        tally = current.get(key) or _empty()
        rank, joint = ranks[key]
        movement = None
        if previous is not None and value(current, key):
            movement = previous_ranks[key][0] - rank
        rows.append(
            {
                "department": name,
                "people": heads[key],
                "rank": rank,
                "joint": joint,
                **tally,
                "per_head": {m: round(tally[m] / heads[key], 2) for m in METRICS},
                "movement": movement,
                "me": key == mine_key,
            }
        )
    rows.sort(
        key=lambda r: (
            r["rank"], -r["per_head"][sort] if per_head else -r[sort], -r["score"], r["department"].casefold()
        )
    )
    mine = next((r for r in rows if r["me"]), None)
    return {
        "board": "departments",
        "period": {**now.as_dict(), "compared_with": then.as_dict() if then else None},
        "periods": periods(on),
        "sort": sort,
        "per_head": per_head,
        "rows": rows,
        "me": (
            {
                "department": mine["department"],
                "rank": mine["rank"],
                "of": len(rows),
                "joint": mine["joint"],
                "movement": mine["movement"],
            }
            if mine
            else None
        ),
        "totals": {
            "papers": len({f.key for f in facts.facts if f.person_id in department_of and now.holds(f)}),
            "departments": len(rows),
            "people": sum(heads.values()),
        },
        "method": _method(facts),
    }
