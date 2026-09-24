"""What this college is working on, who to work on it with, and what next.

Three questions in one module, deliberately in that order, because they are
answered by three different things and only the last one can be wrong.

1. **What the college is actually working on** -- `college_landscape()`.
   Counted from our own claims: subject areas and journals by volume over a
   recent window, which departments are moving into what, which areas are
   growing and which are fading. No model, no network, no key. This is the
   part that must always work, so it is the part that depends on nothing.

2. **Who to work with** -- `people_to_work_with()`. Colleagues whose recent
   output overlaps the reader's own subject areas or the domains they have
   said they follow. Every person named here is a row in our `User` table; the
   overlap is counted from filed papers rather than asserted.

3. **What to pursue next** -- `suggest_openings()`. The only part that asks a
   model, and the only part that can be wrong. It follows the rule the venue
   search already follows: **the model proposes, the database disposes.** The
   model may name a subject area and a colleague; both are re-resolved against
   our own tables before they are shown. An area that resolves carries its
   real paper count; a name that resolves becomes a link to a real person. A
   name that resolves to nothing is not quietly dropped and not quietly shown
   either -- it is returned in a separate `unverified` block with no counts,
   no link and nothing beside it that could be mistaken for a fact.

Two properties worth stating plainly because they are easy to lose:

**Nothing here carries money.** Not a remuneration, not an estimate, not a
total. A head of department may read every one of these answers, and the
money-blindness rule (`core.hod`) is enforced by there being no rupee figure
to strip -- but the payloads are put through `hod.without_money` on the way
out anyway, so that a future field named `amount` cannot leak one by being
added somewhere in the middle of a nested structure. Academic facts stay:
quartiles, counts and years are properties of the work, not of a bank account.

**The measured half never waits on the model.** Inference here runs on this
server's CPU at about four and a half tokens a second, so a suggestion is a
minute or two away. `college_landscape()` and `people_to_work_with()` are
single bounded passes over our own rows and answer in milliseconds. They are
separate functions, meant for separate endpoints, so that the slow half can
never hold the fast half hostage.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable

from django.db.models import Max

from core import hod
from core.models import Claim, ClaimStatus, ResearchInterest, User
from core.services import ai, discover

logger = logging.getLogger(__name__)

#: How many years count as "now", and how many before that count as "then".
#:
#: Three and three. Two years is too short to survive the lag between a paper
#: being published and somebody filing it -- a January window would report
#: half the college as having stopped -- and five flattens exactly the change
#: this is meant to show.
RECENT_YEARS = 3
PRIOR_YEARS = 3

#: A ceiling on one pass, not an expectation. A college's whole publication
#: record is a few thousand rows; this exists so that a bad import cannot turn
#: a page load into a table scan nobody bounded.
MAX_ROWS = 60000

#: A difference of one paper is noise, not a trend. Anything below this stays
#: "steady" rather than being reported as a direction the college is moving in.
TREND_STEP = 2

#: How few papers an area can have and still be called new. Two is a decision;
#: one is an accident.
MIN_NEW = 2

#: When the earlier window is too thin to be an earlier window.
#:
#: Measured against the live data, which is why these numbers exist at all:
#: this college's record holds 3,028 papers in 2024-2026 and 140 in
#: 2021-2023, because the import that filled it only reaches back so far. The
#: arithmetic then reports every single area as growing -- 193 of them, with
#: nothing fading -- which is not a trend, it is the shape of the import
#: showing through. A comparison against a window that was never populated is
#: a wrong answer with a confident direction on it, so it is refused and said
#: so instead.
#: The ratio is the test that matters; the floor only stops a handful of rows
#: being divided into a direction. A small department with five papers then
#: and six now is genuinely steady, and should be told so.
COMPARABLE_MIN = 5
COMPARABLE_RATIO = 0.2

#: The only four things a quartile can be. Our claims also carry sentinels --
#: "NO QUARTILE", "OTHERS" -- and printing one of those in a column headed
#: "quartile" is worse than printing nothing.
QUARTILES = frozenset({"Q1", "Q2", "Q3", "Q4"})

#: Asked for one more opening than is shown, because some will name an area or
#: a colleague that does not resolve. Deliberately not many more: every extra
#: opening is another three sentences of prose at four and a half tokens a
#: second, which is another twenty seconds of somebody's wait.
ASK_FOR = 4
SHOW = 3

_SUBJECT_QUARTILE = re.compile(r"\s*\((Q[1-4])\)\s*$", re.IGNORECASE)

#: Titles somebody's name arrives with, ours or the model's. Stripped before
#: comparison so that "Dr. R. Kumar" and "R Kumar" are the same person, and
#: kept to the forms actually seen in this data.
#:
#: The space after the dot is optional, and that is not a nicety. Names in
#: this database are really stored as "Dr.G.NaliniPriya" -- no space -- while
#: a model asked to copy one back writes "Dr. G.NaliniPriya". Requiring the
#: space stripped the title from one side only, and a real colleague the model
#: had been handed by name came back as unverified. The failure was in the
#: safe direction, which is why it was invisible.
_HONORIFIC = re.compile(
    r"^(dr|prof|professor|mr|mrs|ms|shri|smt)(\.\s*|\s+)", re.IGNORECASE
)


def split_subjects(raw: str | None) -> list[tuple[str, str | None]]:
    """One stored subjects string -> [(area, quartile or None), ...].

    The column is named `subjects_json` and holds no JSON: it is a
    semicolon-separated list of "Software (Q1)". Every reader of it has to
    know that, and a reader that guesses gets an area whose name is the whole
    raw string.

    "(miscellaneous)" is a real Scimago category and must survive, which is
    why only a trailing Q1-Q4 is stripped rather than anything in brackets.
    """
    out: list[tuple[str, str | None]] = []
    for part in (raw or "").split(";"):
        label = part.strip()
        if not label:
            continue
        found = _SUBJECT_QUARTILE.search(label)
        quartile = found.group(1).upper() if found else None
        area = _SUBJECT_QUARTILE.sub("", label).strip()
        if area:
            out.append((area, quartile))
    return out


def _norm(text: str) -> str:
    """A string reduced to what two spellings of the same thing have in common."""
    return " ".join(re.findall(r"[a-z0-9]+", (text or "").lower()))


def _norm_person(name: str) -> str:
    return _norm(_HONORIFIC.sub("", (name or "").strip()))


def _as_rows(raw: Any, key: str) -> list[dict]:
    """The rows a model returned, whatever container it chose for them.

    Asked for `{"openings": [...]}` a model this size sometimes answers with
    the bare array. That is close enough to right to use, and calling `.get`
    on it is an uncaught AttributeError -- a 500 for what should be a shrug.
    """
    rows = raw.get(key) if isinstance(raw, dict) else raw
    return [r for r in (rows or []) if isinstance(r, dict)]


# --------------------------------------------------------------------------- #
# 1. What this college is working on                                          #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Window:
    """The two spans every figure on the landscape is a comparison between."""

    latest: int
    recent_from: int
    prior_from: int

    @property
    def prior_to(self) -> int:
        return self.recent_from - 1

    def bucket(self, year: int | None) -> str | None:
        if year is None:
            return None
        if self.recent_from <= year <= self.latest:
            return "recent"
        if self.prior_from <= year <= self.prior_to:
            return "prior"
        return None

    def as_dict(self) -> dict[str, Any]:
        return {
            "latest_year": self.latest,
            "recent_from": self.recent_from,
            "recent_to": self.latest,
            "prior_from": self.prior_from,
            "prior_to": self.prior_to,
        }


def current_window() -> Window:
    """The window ends where the data ends, not where the calendar does.

    Taken from the most recent publication year anybody has actually filed
    for, because a college that files its 2025 papers through 2026 would
    otherwise open this page in January and be told every area it has is
    fading. A year further ahead than next year is somebody's typo and is
    ignored rather than allowed to drag the whole window forward.
    """
    ceiling = date.today().year + 1
    newest = (
        Claim.objects.exclude(status=ClaimStatus.DRAFT)
        .filter(publication_year__isnull=False, publication_year__lte=ceiling)
        .aggregate(latest=Max("publication_year"))["latest"]
    )
    latest = int(newest or date.today().year)
    recent_from = latest - (RECENT_YEARS - 1)
    return Window(latest=latest, recent_from=recent_from, prior_from=recent_from - PRIOR_YEARS)


def _trend(recent: int, prior: int) -> str:
    """Which of four things this area is doing, with one paper's worth of slack."""
    if prior == 0:
        return "new" if recent >= MIN_NEW else "steady"
    if recent >= prior + TREND_STEP:
        return "growing"
    if prior >= MIN_NEW + 1 and recent <= prior - TREND_STEP:
        return "fading"
    return "steady"


def college_landscape(*, limit: int = 12) -> dict[str, Any]:
    """What the whole college published, counted rather than guessed.

    One pass over the claims in the two windows. The grouping is done in
    Python rather than in SQL for the same reason `/programme/me` does it: the
    subject areas live in a semicolon-separated column that no index can help
    with, and the alternative -- a LIKE per area -- is one table scan per area
    instead of one for all of them.

    A paper with three subject areas counts once in each of them, so the area
    counts add up to more than the paper count. That is the honest shape of
    the question ("how much work is happening in this area") rather than an
    arithmetic error, and `totals.papers` is reported separately so the two
    are never confused.
    """
    window = current_window()

    rows = (
        Claim.objects.exclude(status=ClaimStatus.DRAFT)
        .filter(publication_year__gte=window.prior_from, publication_year__lte=window.latest)
        .values_list(
            "publication_year",
            "subjects_json",
            "journal_title",
            "quartile",
            "owner__department",
            "owner_id",
        )
        .iterator(chunk_size=2000)
    )

    area_recent: Counter[str] = Counter()
    area_prior: Counter[str] = Counter()
    area_people: dict[str, set[str]] = {}
    area_departments: dict[str, Counter[str]] = {}
    dept_recent: dict[str, Counter[str]] = {}
    dept_prior: dict[str, Counter[str]] = {}
    dept_papers: Counter[str] = Counter()
    journal_recent: Counter[str] = Counter()
    journal_quartile: dict[str, Counter[str]] = {}
    journal_people: dict[str, set[str]] = {}
    per_year: Counter[int] = Counter()
    papers_recent = 0
    papers_prior = 0
    classified = 0
    people: set[str] = set()
    truncated = False

    for seen, (year, subjects, journal, quartile, department, owner_id) in enumerate(rows):
        if seen >= MAX_ROWS:
            truncated = True
            break
        bucket = window.bucket(year)
        if bucket is None:
            continue

        if bucket == "recent":
            papers_recent += 1
            per_year[int(year)] += 1
            people.add(owner_id)
        else:
            papers_prior += 1

        areas = {a for a, _q in split_subjects(subjects)}
        if areas and bucket == "recent":
            classified += 1

        dept = (department or "").strip()
        for area in areas:
            if bucket == "recent":
                area_recent[area] += 1
                area_people.setdefault(area, set()).add(owner_id)
                if dept:
                    area_departments.setdefault(area, Counter())[dept] += 1
                    dept_recent.setdefault(dept, Counter())[area] += 1
            else:
                area_prior[area] += 1
                if dept:
                    dept_prior.setdefault(dept, Counter())[area] += 1

        if dept and bucket == "recent":
            dept_papers[dept] += 1

        name = (journal or "").strip()
        if name and bucket == "recent":
            journal_recent[name] += 1
            journal_people.setdefault(name, set()).add(owner_id)
            if quartile and quartile.strip().upper() in QUARTILES:
                journal_quartile.setdefault(name, Counter())[quartile.strip().upper()] += 1

    # Whether the earlier window is populated enough to be compared against at
    # all. When it is not, the counts stay -- they are facts -- and every
    # direction is withheld, because a direction derived from an empty window
    # is not a weak signal, it is a wrong one.
    comparable = papers_prior >= COMPARABLE_MIN and papers_prior >= COMPARABLE_RATIO * papers_recent

    # ---- areas ------------------------------------------------------------
    mentions = sum(area_recent.values()) or 1
    areas: list[dict[str, Any]] = []
    for area, count in area_recent.most_common(max(limit, 24)):
        prior = area_prior.get(area, 0)
        areas.append(
            {
                "area": area,
                "papers": count,
                "prior": prior,
                "change": count - prior,
                "trend": _trend(count, prior) if comparable else "unknown",
                "share": round(100 * count / mentions, 1),
                "people": len(area_people.get(area, ())),
                "departments": [d for d, _n in area_departments.get(area, Counter()).most_common(3)],
            }
        )

    # An area that has gone to nothing never appears in `area_recent`, so it
    # would never be reported as fading -- which is exactly the case somebody
    # opening this page most wants to know about.
    gone = [
        {
            "area": area,
            "papers": 0,
            "prior": prior,
            "change": -prior,
            "trend": "fading",
            "share": 0.0,
            "people": 0,
            "departments": [],
        }
        for area, prior in area_prior.items()
        if comparable and area not in area_recent and prior >= MIN_NEW + 1
    ]

    rising = sorted(
        (a for a in areas if a["trend"] in ("growing", "new")),
        key=lambda a: (-a["change"], -a["papers"]),
    )[:6]
    fading = sorted(
        (a for a in areas + gone if a["trend"] == "fading"),
        key=lambda a: (a["change"], -a["prior"]),
    )[:6]

    # ---- departments ------------------------------------------------------
    departments: list[dict[str, Any]] = []
    for dept, count in dept_papers.most_common(limit):
        now = dept_recent.get(dept, Counter())
        before = dept_prior.get(dept, Counter())
        moving = [
            {"area": area, "papers": n, "prior": before.get(area, 0)}
            for area, n in now.most_common(12)
            if comparable and _trend(n, before.get(area, 0)) in ("growing", "new")
        ]
        moving.sort(key=lambda m: (-(m["papers"] - m["prior"]), -m["papers"]))
        departments.append(
            {
                "department": dept,
                "papers": count,
                "areas": [a for a, _n in now.most_common(4)],
                "moving_into": moving[:3],
            }
        )

    # ---- journals ---------------------------------------------------------
    journals = [
        {
            "title": title,
            "papers": count,
            # The commonest quartile recorded against this journal on our own
            # claims, not a fresh lookup: this is a description of what the
            # college filed, and re-deriving it here would let this panel and
            # the paper it counts disagree.
            "quartile": (journal_quartile.get(title, Counter()).most_common(1) or [(None, 0)])[0][0],
            "people": len(journal_people.get(title, ())),
        }
        for title, count in journal_recent.most_common(limit)
    ]

    payload = {
        "window": window.as_dict(),
        "totals": {
            "papers": papers_recent,
            "papers_prior": papers_prior,
            "classified": classified,
            "unclassified": papers_recent - classified,
            "areas": len(area_recent),
            "departments": len(dept_papers),
            "people": len(people),
            # Said rather than hidden: a landscape drawn from part of the
            # record is a different claim from one drawn from all of it.
            "truncated": truncated,
            "comparable": comparable,
            "not_comparable_why": (
                None
                if comparable
                else (
                    f"Only {papers_prior} papers are recorded for "
                    f"{window.prior_from}–{window.prior_to}, against {papers_recent} "
                    f"since {window.recent_from}. That gap is the reach of the import "
                    "rather than a change in output, so nothing here is called growing "
                    "or fading."
                )
            ),
        },
        "areas": areas[:limit],
        "rising": rising,
        "fading": fading,
        "departments": departments,
        "journals": journals,
        "years": [{"year": y, "papers": per_year[y]} for y in sorted(per_year)],
    }
    return hod.without_money(payload)


# --------------------------------------------------------------------------- #
# 2. Who to work with                                                         #
# --------------------------------------------------------------------------- #


def my_profile(user) -> dict[str, Any]:
    """What we know this person works on: published areas, and stated domains.

    Kept apart on purpose. What somebody has published and what they have said
    they are interested in are two different facts, and a new lecturer has only
    the second -- so collapsing them would leave them matched against nobody.
    """
    areas: Counter[str] = Counter()
    for raw in (
        Claim.objects.filter(owner=user)
        .exclude(status=ClaimStatus.DRAFT)
        .values_list("subjects_json", flat=True)
    ):
        for area, _q in split_subjects(raw):
            areas[area] += 1

    interests = list(
        ResearchInterest.objects.filter(user=user).values_list("domain", flat=True)
    )
    return {
        "areas": [{"area": a, "papers": n} for a, n in areas.most_common(12)],
        "interests": interests,
        "papers": Claim.objects.filter(owner=user).exclude(status=ClaimStatus.DRAFT).count(),
    }


def _overlap_sentence(shared_areas: Iterable[str], shared_interests: Iterable[str], papers: int, since: int) -> str:
    """Why this person is on the list, written from the counts themselves.

    Not from the model. A reason somebody can check against the numbers beside
    it is worth more here than a fluent one they cannot.
    """
    named = list(shared_areas)[:2] or list(shared_interests)[:2]
    where = " and ".join(named) if named else "your areas"
    return f"{papers} paper{'' if papers == 1 else 's'} since {since}, in {where}."


def people_to_work_with(user, *, limit: int = 8) -> dict[str, Any]:
    """Colleagues whose recent work overlaps this person's, from filed papers.

    Everyone here is a real, active row in our own `User` table, and every
    overlap is a subject area both people have actually published in -- or one
    the reader has said they follow. Nothing is inferred from a name.

    Recent output only. A colleague who worked on this six years ago and has
    since moved on is not somebody to start a project with this month, and
    presenting them as one is the failure mode of every all-time collaborator
    list.
    """
    window = current_window()
    profile = my_profile(user)
    mine = {_norm(a["area"]): a["area"] for a in profile["areas"]}
    followed = {_norm(d): d for d in profile["interests"]}

    if not mine and not followed:
        return hod.without_money(
            {
                "people": [],
                "grounded_on": {"areas": [], "interests": [], "since": window.recent_from},
                "why_empty": (
                    "We do not know what you work on yet. File a paper, or pick the "
                    "domains you follow, and the people working nearby appear here."
                ),
            }
        )

    rows = (
        Claim.objects.exclude(owner=user)
        .exclude(status=ClaimStatus.DRAFT)
        .filter(
            owner__active=True,
            publication_year__gte=window.recent_from,
            publication_year__lte=window.latest,
        )
        .exclude(subjects_json__isnull=True)
        .exclude(subjects_json="")
        .select_related("owner")
        .order_by("-publication_year", "-created_at")
    )

    found: dict[str, dict[str, Any]] = {}
    for seen, claim in enumerate(rows.iterator(chunk_size=500)):
        if seen >= MAX_ROWS:
            break
        areas = {a for a, _q in split_subjects(claim.subjects_json)}
        keys = {_norm(a) for a in areas}
        shared_areas = {mine[k] for k in keys & mine.keys()}
        shared_interests = {followed[k] for k in keys & followed.keys()} - shared_areas
        if not shared_areas and not shared_interests:
            continue

        slot = found.setdefault(
            claim.owner_id,
            {
                "id": claim.owner_id,
                "name": claim.owner.name,
                "department": claim.owner.department,
                "designation": claim.owner.designation,
                "papers": 0,
                "shared_areas": set(),
                "shared_interests": set(),
                # The ordering above is newest first, so the first paper of
                # theirs we meet is the most recent one -- which is the one
                # worth showing somebody deciding whether to write an email.
                "recent": {
                    "title": claim.paper_title or "Untitled",
                    "journal": claim.journal_title or None,
                    "year": claim.publication_year,
                    "quartile": claim.quartile,
                },
            },
        )
        slot["papers"] += 1
        slot["shared_areas"] |= shared_areas
        slot["shared_interests"] |= shared_interests

    people = []
    for slot in found.values():
        shared_areas = sorted(slot["shared_areas"])
        shared_interests = sorted(slot["shared_interests"])
        people.append(
            {
                **slot,
                "shared_areas": shared_areas,
                "shared_interests": shared_interests,
                "overlap": len(shared_areas) + len(shared_interests),
                "why": _overlap_sentence(
                    shared_areas, shared_interests, slot["papers"], window.recent_from
                ),
            }
        )
    people.sort(key=lambda p: (-p["overlap"], -p["papers"], p["name"]))

    return hod.without_money(
        {
            "people": people[:limit],
            "grounded_on": {
                "areas": list(mine.values()),
                "interests": list(followed.values()),
                "since": window.recent_from,
            },
            "why_empty": (
                None
                if people
                else (
                    "Nobody else here has filed a paper in your areas since "
                    f"{window.recent_from}. That is a gap, not a fault."
                )
            ),
        }
    )


# --------------------------------------------------------------------------- #
# 3. The model's part                                                         #
# --------------------------------------------------------------------------- #

_OPENINGS_SCHEMA = {
    "type": "object",
    "properties": {
        "openings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string"},
                    "why": {"type": "string"},
                    "first_step": {"type": "string"},
                    "area": {"type": "string"},
                    "with_whom": {"type": "string"},
                },
                "required": ["topic", "why", "first_step"],
            },
        }
    },
    "required": ["openings"],
}


def _person_index(exclude_id: str | None = None) -> dict[str, dict[str, Any] | None]:
    """Every active colleague by normalised name, with ambiguity marked.

    A `None` value means two people here normalise to the same name. That is
    resolved as *not found* rather than as either of them: a suggestion that
    sends somebody to the wrong colleague of the same name is worse than one
    that names nobody.
    """
    index: dict[str, dict[str, Any] | None] = {}
    for pk, name, department in User.objects.filter(active=True).values_list(
        "id", "name", "department"
    ):
        key = _norm_person(name or "")
        if not key or pk == exclude_id:
            continue
        if key in index:
            index[key] = None
            continue
        index[key] = {"id": pk, "name": name, "department": department}
    return index


def suggest_openings(
    *,
    user,
    landscape: dict[str, Any] | None = None,
    colleagues: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Directions worth pursuing, proposed by the model and checked against us.

    The one part of this feature that can be wrong, and it is kept structurally
    separate for that reason: its own function, its own endpoint, its own
    panel on screen. Everything above it is counted.

    What the model is allowed to contribute is a *topic*, a *reason* and a
    *first step* -- prose, which is what it is good for. What it is not
    trusted with is a fact. It may point at a subject area and at a colleague,
    and both are looked up here before they are shown:

    - an area is matched against the areas the college has actually published
      in, and carries that area's real paper count;
    - a name is matched against active `User` rows, exactly, and becomes a
      link to that person or nothing at all.

    Whatever fails to resolve comes back under `unverified`, as a bare string
    with no count, no link and no quartile beside it. The model inventing a
    plausible colleague is the exact failure this shape exists to survive.
    """
    landscape = landscape or college_landscape()
    colleagues = colleagues or people_to_work_with(user, limit=6)
    profile = my_profile(user)
    history = discover.publication_history(user, limit=10)

    known_areas = {
        _norm(a["area"]): a
        for a in list(landscape.get("areas") or []) + list(landscape.get("rising") or [])
    }
    for a in profile["areas"]:
        known_areas.setdefault(_norm(a["area"]), {"area": a["area"], "papers": a["papers"], "trend": "steady"})

    offered = [p["name"] for p in colleagues.get("people") or []]

    if not history and not profile["interests"]:
        return {
            "openings": [],
            "unverified": {"people": [], "areas": []},
            "grounded_on": {
                "papers": 0,
                "interests": [],
                "college_areas": [],
                "colleagues_offered": offered,
            },
            "note": (
                "There is nothing of yours to build on yet. File a paper, or pick the "
                "domains you work in, and this will have something to work from."
            ),
            "model": ai.model_name(),
        }

    # Growing areas where the record is deep enough to know which are growing;
    # otherwise the areas with the most work in them. Both are true statements
    # about this college, and the model is given whichever we can stand behind.
    busiest = landscape.get("rising") or landscape.get("areas") or []
    rising = [a["area"] for a in busiest][:6]
    mine = [a["area"] for a in profile["areas"][:5]]

    # Kept short on purpose. Generation runs on this server's CPU at about
    # four and a half tokens a second, so every line of context is paid for
    # twice -- once reading it and once in the longer answer it invites.
    lines = [f"- {h['title']} ({h['year']})" for h in history[:8]]
    prompt = (
        "You advise engineering academics in an Indian college on what to work on next.\n\n"
        + ("Their recent papers:\n" + "\n".join(lines) + "\n\n" if lines else "")
        + (f"Subject areas they publish in: {', '.join(mine)}\n" if mine else "")
        + (
            f"Domains they follow: {', '.join(profile['interests'][:6])}\n"
            if profile["interests"]
            else ""
        )
        + (f"Areas growing across this college: {', '.join(rising)}\n" if rising else "")
        + (f"Colleagues here publishing nearby: {', '.join(offered)}\n" if offered else "")
        + f"\nGive {ASK_FOR} specific openings this person is well placed to take in the "
        "next year, building on the work above rather than changing field. For each: "
        "'topic' (concrete, no buzzwords), 'why' (one sentence, specific to them), "
        "'first_step' (something doable in a week without new equipment or funding), "
        "'area' (one subject area from the lists above, copied exactly), and "
        "'with_whom' (one colleague from the list above, copied exactly, or an empty "
        "string). Never invent a name."
    )

    raw = ai.ask_json(prompt, schema=_OPENINGS_SCHEMA, temperature=0.6)
    proposed = _as_rows(raw, "openings")

    directory = _person_index(exclude_id=getattr(user, "pk", None))
    openings: list[dict[str, Any]] = []
    unverified_people: list[str] = []
    unverified_areas: list[str] = []

    for entry in proposed[: ASK_FOR + 2]:
        topic = (entry.get("topic") or "").strip()
        if not topic:
            continue

        area_name = (entry.get("area") or "").strip()
        area = known_areas.get(_norm(area_name)) if area_name else None
        if area_name and area is None and area_name not in unverified_areas:
            unverified_areas.append(area_name)

        person_name = (entry.get("with_whom") or "").strip()
        person = directory.get(_norm_person(person_name)) if person_name else None
        if person_name and person is None and person_name not in unverified_people:
            unverified_people.append(person_name)

        openings.append(
            {
                "topic": topic,
                "why": (entry.get("why") or "").strip(),
                "first_step": (entry.get("first_step") or "").strip(),
                # Present only when it resolved. A key holding a name we could
                # not find is a key somebody's screen will render.
                "area": (
                    {
                        "name": area["area"],
                        "papers": area.get("papers", 0),
                        "trend": area.get("trend", "steady"),
                    }
                    if area
                    else None
                ),
                "with_whom": person,
            }
        )

    return {
        "openings": openings[:SHOW],
        # Separate, and bare. No count, no link, nothing that reads as checked.
        "unverified": {"people": unverified_people[:4], "areas": unverified_areas[:4]},
        # Said on screen, so a thin answer reads as a thin history rather than
        # as a broken feature.
        "grounded_on": {
            "papers": len(history),
            "interests": profile["interests"],
            "college_areas": rising,
            "colleagues_offered": offered,
        },
        "model": ai.model_name(),
    }


# --------------------------------------------------------------------------- #
# Degrading honestly                                                          #
# --------------------------------------------------------------------------- #


def overview(user, *, limit: int = 12, people_limit: int = 8) -> dict[str, Any]:
    """Everything measured, plus whether the suggestions can run, in one request.

    Composed here rather than in the request handler so that the shape a screen
    depends on is testable without HTTP, and so that the fast half stays one
    round trip. It is deliberately *not* joined to `suggest_openings`: putting
    them in one response would make every page load wait a minute and a half
    for the part that is allowed to be wrong.

    `ai` rides along so the page can draw its counts and say in the same breath
    that the suggestions are off and what the one command to fix it is, without
    a second request to find out.
    """
    return {
        "college": college_landscape(limit=limit),
        "people": people_to_work_with(user, limit=people_limit),
        "ai": status(),
    }


def status() -> dict[str, Any]:
    """Whether the suggestion half can run, and if not, which way it is off.

    Returned alongside the measured landscape rather than from a separate
    request, so a page that has drawn its counts can say in the same breath
    that the suggestions are off and what the one command to fix it is. "Off"
    covers three situations with three remedies -- no service, no model, or a
    provider name nobody recognises -- and a screen that cannot tell them
    apart can only shrug at somebody who could have fixed it in ten seconds.

    A health probe that itself fails is reported as a fourth state rather than
    being allowed to take the measured half down with it.
    """
    try:
        state = ai.health()
    except Exception:  # noqa: BLE001 - a probe must never break the page
        logger.exception("trends_health_probe_failed")
        return {
            "available": False,
            "code": "error",
            "detail": "The model service could not be checked. The figures above are unaffected.",
            "model": "",
            "provider": "",
            "hosted": False,
            "host": "",
        }
    return {
        "available": bool(state.get("ready")),
        "code": state.get("code"),
        "detail": state.get("detail"),
        "model": state.get("model") or "",
        "provider": state.get("provider"),
        # Whether a question leaves the college, and for where, so the page
        # does not promise "nothing leaves this machine" when it does.
        "hosted": bool(state.get("hosted")),
        "host": state.get("host") or "",
    }
