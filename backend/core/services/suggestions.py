"""New things to work on: who to write with, where to aim, what to try.

Three lists, each counted from the college's own record (`paper_facts`) and
each entry carrying the reason it is there -- so they work on a server with
no model at all, which is what the free deployment is until somebody pastes
a key. A reason somebody can check against the record is worth more than a
fluent one they cannot.

- **People.** Colleagues on the roster with recent papers whose work
  overlaps yours -- shared subject areas, shared journals, domains you follow
  -- scored higher when they are in another department (the introduction you
  would not otherwise get) and when they have Q1 work in an area you share
  but have no Q1 in yet (a strength you do not have). Never anybody you have
  already written with: co-authorship is two people credited with the same
  paper, in a claim or in the historic ledger.
- **Journals.** Q1 and Q2 journals in your field where colleagues here have
  published recently, that you have not published in yet.
- **Topics.** Subject areas that sit next to yours -- they appear on the
  same papers as your areas -- that you have not published in yet.

A fourth list, industry partners, needs knowledge the college does not hold,
so it is the one part that asks a model (`industry_partners`). Nothing it
names can be checked against our tables, and it says so.

No money anywhere: the facts carry none.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from datetime import date
from typing import Any

from core.models import ResearchInterest
from core.services import ai, paper_facts
from core.services.paper_facts import Fact, Facts
from core.services.trends import _as_rows

#: "Recent" is the last three publication years on record. Long enough to
#: survive the lag between publishing and filing, short enough that somebody
#: suggested as a collaborator still works on the thing.
RECENT_YEARS = 3

SHOW = 6

#: A topic must sit beside your work on at least this many papers. One is a
#: coincidence of classification, not a neighbourhood.
MIN_ALONGSIDE = 2

#: When an area is too broad to be a suggestion. Measured on the live record:
#: "Engineering" is on the papers of 94 of the ~290 people publishing, and
#: telling any of them to try "Engineering" next says nothing. An area is too
#: broad when more than this many people *and* this share of everybody
#: publishing work in it; the floor keeps a small college's areas usable.
BROAD_FLOOR = 10
BROAD_SHARE = 0.2

HIGH = ("Q1", "Q2")


def _catch_all(area_key: str) -> bool:
    """Scimago's "(miscellaneous)" and "(all)" buckets name no topic."""
    return area_key.endswith("(miscellaneous)") or area_key.endswith("(all)") or area_key == "multidisciplinary"


def _fold(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _and(names: list[str]) -> str:
    return names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"


def recent_since(facts: Facts, on: date | None = None) -> date:
    """1 January, three publication years before the newest one on record."""
    ceiling = (on or date.today()).year + 1
    years = [f.published.year for f in facts.facts if f.published and f.published.year <= ceiling]
    latest = max(years) if years else (on or date.today()).year
    return date(latest - (RECENT_YEARS - 1), 1, 1)


_BUCKET = re.compile(r"\s*\((miscellaneous|all)\)\s*$", re.IGNORECASE)


class _Names:
    """The commonest spelling of each folded name, for display.

    Scimago's "Chemical Engineering (miscellaneous)" is shown as Chemical
    Engineering: the bucket suffix is a classification detail, and a reason
    reading "works in ... (miscellaneous)" tells the reader less, not more.
    """

    def __init__(self) -> None:
        self._seen: dict[str, Counter[str]] = defaultdict(Counter)

    def add(self, name: str) -> str:
        key = _fold(name)
        if key:
            self._seen[key][name.strip()] += 1
        return key

    def __getitem__(self, key: str) -> str:
        seen = self._seen.get(key)
        name = seen.most_common(1)[0][0] if seen else key
        return _BUCKET.sub("", name) or name

    def shown(self, keys, limit: int) -> list[str]:
        """Display names for these keys, without the same name twice."""
        out: list[str] = []
        for key in keys:
            name = self[key]
            if name not in out:
                out.append(name)
            if len(out) == limit:
                break
        return out


def for_person(user, *, facts: Facts | None = None) -> dict[str, Any]:
    facts = facts or paper_facts.load()
    since = recent_since(facts)
    names = _Names()
    for f in facts.facts:
        for area in f.subjects:
            names.add(area)
        if f.journal:
            names.add(f.journal)

    mine = [f for f in facts.facts if f.person_id == user.pk]
    my_areas = Counter(_fold(a) for f in mine for a in f.subjects)
    my_journals = {_fold(f.journal) for f in mine if f.journal}
    my_q1_areas = {_fold(a) for f in mine if f.quartile == "Q1" for a in f.subjects}
    interests = list(ResearchInterest.objects.filter(user=user).values_list("domain", flat=True))
    followed = {_fold(d): d for d in interests}
    grounding = set(my_areas) | set(followed)

    grounded_on = {
        "papers": len(mine),
        "areas": names.shown([a for a, _n in my_areas.most_common(10)], 5),
        "interests": interests,
        "since": since.year,
    }
    if not grounding and not my_journals:
        return {
            "people": [],
            "journals": [],
            "topics": [],
            "grounded_on": grounded_on,
            "why_empty": (
                "We do not know what you work on yet. File a paper, or pick the domains "
                "you follow below, and suggestions appear here."
            ),
        }

    my_keys = {f.key for f in mine}
    coauthors = {f.person_id for f in facts.facts if f.key in my_keys} - {user.pk}
    recent = [f for f in facts.facts if f.published and f.published >= since]

    # How many people publish in each area: the narrower an area, the more it
    # says about two people who share it, so reasons name narrow areas first.
    area_people: dict[str, set[str]] = defaultdict(set)
    for f in recent:
        for a in f.subjects:
            area_people[_fold(a)].add(f.person_id)
    breadth = Counter({a: len(p) for a, p in area_people.items()})
    publishing = len({f.person_id for f in recent})

    return {
        "people": _people(user, facts, recent, names, breadth, my_areas, my_journals,
                          my_q1_areas, followed, coauthors),
        "journals": _journals(user, recent, names, breadth, grounding, my_journals, since),
        "topics": _topics(recent, names, breadth, publishing, grounding, since),
        "grounded_on": grounded_on,
        "why_empty": None,
    }


# --------------------------------------------------------------------------- #
# People                                                                      #
# --------------------------------------------------------------------------- #


def _people(user, facts, recent, names, breadth, my_areas, my_journals, my_q1_areas, followed,
            coauthors):
    my_department = _fold(getattr(user, "department", "") or "")
    theirs: dict[str, list[Fact]] = defaultdict(list)
    for f in recent:
        if f.person_id != user.pk and f.person_id not in coauthors:
            theirs[f.person_id].append(f)

    out = []
    for pid, papers in theirs.items():
        person = facts.people.get(pid)
        if person is None:
            continue
        areas = Counter(_fold(a) for f in papers for a in f.subjects)
        journals = Counter(_fold(f.journal) for f in papers if f.journal)
        shared_areas = sorted(
            set(areas) & set(my_areas), key=lambda a: (_catch_all(a), breadth[a], -areas[a], a)
        )
        shared_journals = sorted(set(journals) & my_journals, key=lambda j: (-journals[j], j))
        shared_interests = sorted((set(areas) & set(followed)) - set(shared_areas))
        if not (shared_areas or shared_journals or shared_interests):
            continue

        q1_where = Counter(
            _fold(a)
            for f in papers
            if f.quartile == "Q1"
            for a in f.subjects
            if _fold(a) in shared_areas and _fold(a) not in my_q1_areas
        )
        cross = bool(person.department) and _fold(person.department) != my_department

        reasons = []
        if shared_journals:
            first = names[shared_journals[0]]
            reasons.append(
                f"Publishes in {first}, as you do."
                if len(shared_journals) == 1
                else f"Publishes in {first} and {_plural(len(shared_journals) - 1, 'other journal')} you use."
            )
        if shared_areas:
            # A "(miscellaneous)" bucket is named only when it is all there is.
            named = [a for a in shared_areas if not _catch_all(a)] or shared_areas
            reasons.append(f"Works in {_and(names.shown(named, 2))}, as you do.")
        if shared_interests:
            reasons.append(f"Publishes in {followed[shared_interests[0]]}, which you follow.")
        if q1_where:
            area, n = q1_where.most_common(1)[0]
            reasons.append(f"Has {_plural(n, 'Q1 paper')} in {names[area]}, where you have none yet.")
        if cross:
            reasons.append(f"In {person.department}, not your department.")

        score = (
            3 * min(len(shared_areas), 4)
            + 2 * min(len(shared_journals), 3)
            + 2 * min(len(shared_interests), 2)
            + (3 if cross else 0)
            + (2 if q1_where else 0)
            + 0.2 * min(len(papers), 5)
        )
        out.append(
            {
                "id": pid,
                "name": person.name,
                "department": person.department or None,
                "designation": person.designation or None,
                "papers": len(papers),
                "shared_areas": names.shown(shared_areas, 4),
                "shared_journals": [names[j] for j in shared_journals[:3]],
                "cross_department": cross,
                "reasons": reasons,
                "score": round(score, 2),
            }
        )
    out.sort(key=lambda p: (-p["score"], -p["papers"], p["name"].casefold()))
    return out[:SHOW]


# --------------------------------------------------------------------------- #
# Journals                                                                    #
# --------------------------------------------------------------------------- #


def _journals(user, recent, names, breadth, grounding, my_journals, since):
    quartiles: dict[str, Counter[str]] = defaultdict(Counter)
    people: dict[str, set[str]] = defaultdict(set)
    areas: dict[str, Counter[str]] = defaultdict(Counter)
    for f in recent:
        if f.person_id == user.pk or not f.journal:
            continue
        j = _fold(f.journal)
        if j in my_journals:
            continue
        if f.quartile:
            quartiles[j][f.quartile] += 1
        people[j].add(f.person_id)
        for a in f.subjects:
            areas[j][_fold(a)] += 1

    out = []
    for j, counts in quartiles.items():
        quartile = counts.most_common(1)[0][0]
        if quartile not in HIGH:
            continue
        overlap = sorted(
            (a for a in areas[j] if a in grounding),
            key=lambda a: (_catch_all(a), breadth[a], -areas[j][a], a),
        )
        if not overlap:
            continue
        who = len(people[j])
        field = _and(names.shown(overlap, 2))
        out.append(
            {
                "title": names[j],
                "quartile": quartile,
                "colleagues": who,
                "areas": names.shown(overlap, 3),
                "reason": (
                    f"{quartile} in {field}. {_plural(who, 'colleague')} here "
                    f"published in it since {since.year}; you have not yet."
                ),
                "score": (8 if quartile == "Q1" else 6) + 2 * min(len(overlap), 3) + min(who, 5),
            }
        )
    out.sort(key=lambda j: (-j["score"], j["title"].casefold()))
    return out[:SHOW]


# --------------------------------------------------------------------------- #
# Topics                                                                      #
# --------------------------------------------------------------------------- #


def _topics(recent, names, breadth, publishing, grounding, since):
    # One entry per paper, however many people are credited with it: a
    # co-authored paper is one piece of evidence that two areas meet.
    papers: dict[str, Fact] = {}
    for f in recent:
        papers.setdefault(f.key, f)

    def too_broad(area: str) -> bool:
        return breadth[area] > BROAD_FLOOR and breadth[area] > BROAD_SHARE * publishing

    alongside: Counter[str] = Counter()
    beside: dict[str, Counter[str]] = defaultdict(Counter)
    q1: Counter[str] = Counter()
    for f in papers.values():
        folds = {_fold(a) for a in f.subjects}
        near = folds & grounding
        if not near:
            continue
        for a in folds - grounding:
            alongside[a] += 1
            q1[a] += f.quartile == "Q1"
            for g in near:
                beside[a][g] += 1

    out = []
    for area, n in alongside.items():
        if n < MIN_ALONGSIDE or _catch_all(area) or too_broad(area):
            continue
        who = breadth[area]
        next_to = names[
            min(beside[area], key=lambda g: (-beside[area][g], _catch_all(g), breadth[g], g))
        ]
        out.append(
            {
                "area": names[area],
                "alongside": n,
                "next_to": next_to,
                "people": who,
                "q1": q1[area],
                "reason": (
                    f"Appears alongside {next_to} on {_plural(n, 'paper')} here since "
                    f"{since.year}, and {_plural(who, 'colleague')} publish in it. "
                    "You have not yet."
                ),
                "score": 2 * n + who + q1[area],
            }
        )
    out.sort(key=lambda t: (-t["score"], t["area"].casefold()))
    return out[:SHOW]


# --------------------------------------------------------------------------- #
# Industry partners -- the model's part                                       #
# --------------------------------------------------------------------------- #

_PARTNERS_SCHEMA = {
    "type": "object",
    "properties": {
        "partners": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "kind": {"type": "string"},
                    "why": {"type": "string"},
                    "first_step": {"type": "string"},
                },
                "required": ["name", "why"],
            },
        }
    },
    "required": ["partners"],
}

ASK_FOR_PARTNERS = 5


def industry_partners(user, *, facts: Facts | None = None) -> dict[str, Any]:
    """Organisations outside the college worth approaching, from a model.

    Grounded on the person's own published titles and subject areas, and
    nothing else about them. Unlike every other suggestion on the page these
    cannot be checked against the college's tables -- we hold no register of
    companies -- so the answer is marked `unverified` and the page says so.
    """
    facts = facts or paper_facts.load()
    mine = sorted(
        (f for f in facts.facts if f.person_id == user.pk),
        key=lambda f: f.published or date.min,
        reverse=True,
    )
    areas = [a for a, _n in Counter(a for f in mine for a in f.subjects).most_common(5)]
    interests = list(ResearchInterest.objects.filter(user=user).values_list("domain", flat=True))
    titles = [f.title for f in mine if f.title][:8]
    grounded_on = {"papers": len(mine), "areas": areas, "interests": interests}

    if not titles and not areas and not interests:
        return {
            "partners": [],
            "unverified": True,
            "grounded_on": grounded_on,
            "note": (
                "There is nothing of yours to build on yet. File a paper, or pick the "
                "domains you work in, and this will have something to work from."
            ),
            "model": ai.model_name(),
        }

    prompt = (
        "You advise engineering academics at an Indian college on industry collaboration.\n\n"
        + ("Their recent papers:\n" + "\n".join(f"- {t}" for t in titles) + "\n\n" if titles else "")
        + (f"Subject areas they publish in: {', '.join(areas)}\n" if areas else "")
        + (f"Domains they follow: {', '.join(interests[:6])}\n" if interests else "")
        + f"\nName up to {ASK_FOR_PARTNERS} real organisations -- companies, government "
        "laboratories or non-profits, preferably with a presence in India -- that work on "
        "these topics and could plausibly collaborate with this academic. For each give "
        "'name', 'kind' (company, government lab, non-profit or other), 'why' (one "
        "sentence tied to their work above) and 'first_step' (one concrete, low-cost first "
        "step). Only name organisations you are confident exist; give fewer rather than guess."
    )
    raw = ai.ask_json(prompt, schema=_PARTNERS_SCHEMA, temperature=0.4)

    partners: list[dict[str, str]] = []
    seen: set[str] = set()
    for row in _as_rows(raw, "partners"):
        name = str(row.get("name") or "").strip()
        if not name or _fold(name) in seen:
            continue
        seen.add(_fold(name))
        partners.append(
            {
                "name": name[:120],
                "kind": str(row.get("kind") or "").strip()[:40] or None,
                "why": str(row.get("why") or "").strip()[:400],
                "first_step": str(row.get("first_step") or "").strip()[:400] or None,
            }
        )
    return {
        "partners": partners[:ASK_FOR_PARTNERS],
        "unverified": True,
        "grounded_on": grounded_on,
        "model": ai.model_name(),
        "hosted": ai.is_hosted(),
    }
