"""The research compass: who you are, what you could be, and the next steps.

A guided walk in four steps, every one grounded in the person's own record and
none of them dependent on a model:

1. **Portrait** (`portrait`): a headline, three strengths with the evidence for
   each, the topics they publish on, and where they stand in their department.
2. **Topics**: the person says what they work on (`ResearchInterest`, written by
   the API through `discover.replace_interests`), which tunes the candidates.
3. **Paths** (`paths`): three directions they could grow in, each with a
   measure now and a target, and one or two colleagues who could help.
4. **Plan** (`plan`): four to six steps on the chosen path, ticked off as they
   are done (`tick`), summarised for Home (`summary`).

And a question box (`ask`), which answers only about the record and the compass
and can draft a first note to a colleague through the research helper's own
draft feature.

The rule is the research helper's: **the database proposes and the model only
chooses and explains.** `facts_for` counts the record and lists every candidate
(paper, journal, person, topic, goal) with a stable id. A model may cite those
ids and nothing else (`grounded_ids`); a sentence carrying a number the facts do
not hold, a link or an amount is replaced by the counted sentence; and a model
never sets a measure: a path's numbers are worked out here from fixed
archetypes (`ARCHETYPES`, `_measures`) whatever the model writes. With AI off,
failing or over its limit, every step answers from the counts and says so
(`counted: true`).

This replaces the research scout for anyone not on Claude: the scout needs
Claude's web search and so never ran on the hosted Groq models. A deadline is
the one thing the record cannot know, so a plan carries one only from the
person's own Claude scout run, and only while Claude is the provider.

No money anywhere, and nothing about a claim or the desk that holds it.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import Counter, defaultdict
from datetime import date
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.utils import timezone

from core.models import (
    AuditLog,
    Authorship,
    CompassState,
    DepartmentPlan,
    ResearchGoal,
    ResearchInterest,
    ScoutRun,
    User,
)
from core.services import ai
from core.services import ai_harness as harness
from core.services import coauthors as graph
from core.services import discover
from core.services import research_helper as helper
from core.services import research_picture as picture
from core.services import scout
from core.services.person_record import department_of, rank_in

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Names and limits                                                            #
# --------------------------------------------------------------------------- #

#: The paths a person can be offered. The model picks three and names them;
#: what each one measures, and its target, is decided here.
ARCHETYPES = ("q1_author", "first_author", "cross_dept", "conf_to_journal", "focus_topic", "citations")

#: Which `ResearchGoal` metric a path's goal step sets.
GOAL_FOR = {
    "q1_author": ResearchGoal.Metric.Q1,
    "first_author": ResearchGoal.Metric.FIRST_AUTHOR,
    "citations": ResearchGoal.Metric.CITATIONS,
    "cross_dept": ResearchGoal.Metric.PAPERS,
    "conf_to_journal": ResearchGoal.Metric.PAPERS,
    "focus_topic": ResearchGoal.Metric.PAPERS,
}
#: The largest target `PUT /me/goals` takes (`core.api.rewards.MAX_GOAL`): a
#: goal step is saved through that endpoint exactly as it stands.
GOAL_MAX = 1000

EVIDENCE_KINDS = ("paper", "journal", "person", "metric")
STEP_KINDS = ("journal", "person", "topic", "goal")
METRICS = (
    "papers", "citations", "h_index", "q1", "first_author_share", "journal_share", "rank",
    "coauthors_other_departments", "coauthors_outside", "this_year",
)

MIN_STEPS, MAX_STEPS = 4, 6
MAX_DEADLINES = 2
MAX_QUESTION = 500
#: The audit keeps this much of a question, and no more.
LOGGED_QUESTION = 200

ANSWER_TTL = 24 * 60 * 60
#: Counting the record reads the whole college's papers; a few minutes'
#: memory per person keeps the four steps from counting it four times.
FACTS_TTL = 120

ACTION_ASK = "COMPASS_ASK"

OFF_TEXT = "AI is off for this college, so the compass answers from your record."
FAILED_TEXT = "The AI did not answer this time, so here is what your record says."
UNCHECKED_TEXT = "The AI's answer quoted something your record does not hold, so here is what your record says."
OFF_TOPIC_TEXT = (
    "The compass only answers questions about your research: your papers, journals, co-authors, "
    "and the paths and steps on this page."
)

_LIMIT_CODES = ("person_limit", "feature_limit", "college_cap")
_QRANK = {"Q1": 0, "Q2": 1, "Q3": 2, "Q4": 3}


class InputError(ValueError):
    """The request cannot be used, with a sentence to show."""


class NotFound(LookupError):
    """No such step in the person's plan."""


class LimitReached(Exception):
    """Today's questions are used up, with a sentence to show."""


def ask_daily_limit() -> int:
    return int(getattr(settings, "COMPASS_ASK_DAILY_LIMIT", 0) or 20)


def _plural(n: int, word: str, many: str | None = None) -> str:
    return picture._plural(n, word, many)


def _clip(text: str | None, limit: int) -> str:
    """A title cut to `limit` at a word boundary, with an ellipsis: never "Pho"."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-–")
    return f"{cut}…"


def _fold(text: str | None) -> str:
    return picture._fold(text or "")


def _sid(prefix: str, key: str) -> str:
    return prefix + hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


def _pct(part: int, whole: int) -> int:
    return round(100 * part / whole) if whole else 0


# --------------------------------------------------------------------------- #
# The facts                                                                   #
# --------------------------------------------------------------------------- #


def facts_for(user: User) -> dict[str, Any]:
    """Everything the compass says, counted from the record. No model.

    The same counts as My research and Home (`research_picture.my_research`,
    `person_record`), plus the candidates a model may cite, each with an id,
    and `facts_hash`, which names this set of facts: an answer made from other
    facts is not shown as current.
    """
    key = _facts_key(user)
    hit = cache.get(key)
    if hit is not None:
        return hit
    facts = _count(user)
    cache.set(key, facts, FACTS_TTL)
    return facts


def forget_facts(user: User) -> None:
    """Count again on the next request (after the person changes their topics)."""
    cache.delete(_facts_key(user))


def _facts_key(user: User) -> str:
    return f"compass:facts:{user.pk}"


def _count(user: User) -> dict[str, Any]:
    today = timezone.localdate()
    college = picture.shared_college()
    mine = picture.my_research(user, college)
    m = mine["metrics"]
    papers_list, everyone = department_of(user)
    dept = (user.department or "").strip()
    rank, rank_of = rank_in(everyone, user.id) if dept else (None, 0)

    total = m["papers"] or 0
    quartiles = Counter(p.quartile or "none" for p in papers_list)
    # A paper known only from a claim counts as a journal paper: claims are
    # filed for journal articles, and the record has no type for it.
    mix = mine["mix"]
    journal_papers = mix.get("Journal article", 0) + mix.get("Review", 0) + (m["claims_only"] or 0)
    conference_papers = mix.get("Conference", 0)

    co = graph.coauthors(user)
    my_dept = _fold(dept)
    in_dept = sum(1 for c in co["inside"] if my_dept and _fold(c.get("department")) == my_dept)
    # Only those known to sit elsewhere: a college co-author with no
    # department on record is not counted as a bridge to another one.
    other_dept = sum(1 for c in co["inside"] if c.get("department") and _fold(c["department"]) != my_dept)

    pace = mine["this_year"]
    metrics = {
        "papers": total,
        "citations": m["citations"] or 0,
        "h_index": m["h_index"] or 0,
        "rank": rank,
        "rank_of": rank_of,
        "q1": m["q1"] or 0,
        "first_author": m["first_author"] or 0,
        "first_author_share": _pct(m["first_author"] or 0, total),
        "journal_papers": journal_papers,
        "conference_papers": conference_papers,
        "journal_share": _pct(journal_papers, total),
        "quartiles": {q: quartiles.get(q, 0) for q in ("Q1", "Q2", "Q3", "Q4", "none")},
        "coauthors_in_department": in_dept,
        "coauthors_other_departments": other_dept,
        "coauthors_outside": co["outside_count"],
        "year": pace["year"],
        "this_year": pace["papers"],
        "last_year_by_now": pace["same_date_last_year"],
        "last_year_total": pace["last_year_total"],
    }

    topics = [{"id": _sid("t", t["id"]), "name": t["label"], "papers": t["papers"]} for t in mine["topics"][:6]]
    interests = list(ResearchInterest.objects.filter(user=user).values_list("domain", flat=True))
    plan_row = DepartmentPlan.objects.filter(department__iexact=dept).first() if dept else None
    areas = [str(a) for a in (plan_row.research_areas or [])][:8] if plan_row else []
    goals = [
        {"metric": g.metric, "target": g.target, "year": g.year}
        for g in ResearchGoal.objects.filter(user=user, year__gte=today.year - 1).order_by("year", "metric")
    ]

    my_pubs = college.of(user.id)
    mine_keys = {k for p in my_pubs for k in p["keys"]}
    followed = {_fold(d) for d in interests}
    facts: dict[str, Any] = {
        "person": {"name": user.name, "department": dept or None, "designation": user.designation or None},
        "metrics": metrics,
        "topics": topics,
        "venues": [{"name": v["name"], "quartile": v["quartile"], "papers": v["papers"]} for v in mine["venues"]],
        "goals": goals,
        "interests": interests,
        "department_areas": areas,
        "papers": _papers(user, my_pubs),
        "candidates": {
            "journals": _journals(user, college, my_pubs, mine_keys | followed),
            "people": _people(user, college, co, mine_keys),
            "topics": _topics(college, topics, interests, mine_keys | followed, today),
            "goals": _goals(metrics, papers_list, today),
        },
    }
    facts["metric_labels"] = _metric_labels(metrics, dept)
    facts["facts_hash"] = hashlib.sha256(
        json.dumps(facts, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:16]
    return facts


def _papers(user: User, my_pubs: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    """The person's papers a sentence may point at: the most cited, and the newest."""
    position = dict(Authorship.objects.filter(user=user).values_list("publication_id", "position"))
    cited = sorted(my_pubs, key=lambda p: (-(p["citations"] or 0), -(p["year"] or 0), p["id"]))
    newest = sorted(my_pubs, key=lambda p: (-(p["year"] or 0), p["id"]))
    chosen: list[dict[str, Any]] = []
    for p in [*cited[: limit - 2], *newest[:2], *cited[limit - 2:]]:
        if p not in chosen:
            chosen.append(p)
        if len(chosen) == limit:
            break
    return [
        {"id": p["id"], "title": (p["title"] or "")[:200], "year": p["year"], "venue": p["venue"] or None,
         "quartile": (p["quartile"] or "").upper() or None, "citations": p["citations"] or 0,
         "first_author": position.get(p["id"]) == 1, "topics": p["topics"][:3]}
        for p in chosen
    ]


def _journals(user: User, college: picture._College, my_pubs: list[dict[str, Any]], keys: set[str]) -> list[dict[str, Any]]:
    """Journals worth aiming at: the person's own, and those where colleagues
    publish on their topics. Quartile and SNIP from our Scimago and SNIP rows
    (`discover`), never from a model."""
    mine = Counter(_fold(p["venue"]) for p in my_pubs if p["venue"] and picture._is_journal(p["type"]))
    names: dict[str, str] = {}
    quartile: dict[str, str] = {}
    colleagues: dict[str, set[str]] = defaultdict(set)
    on_topic: Counter[str] = Counter()
    for p in college.pubs.values():
        v = _fold(p["venue"])
        if not v or not picture._is_journal(p["type"]):
            continue
        names.setdefault(v, p["venue"])
        if p["quartile"]:
            quartile[v] = p["quartile"].upper()
        colleagues[v] |= p["members"] - {user.id}
        if user.id not in p["members"] and p["keys"] & keys:
            on_topic[v] += 1

    own = [v for v, _n in sorted(mine.items(), key=lambda kv: (-kv[1], kv[0]))][:4]
    others = sorted(
        (v for v in on_topic if v not in mine),
        # One stray paper on a shared topic is a coincidence, two are a habit.
        key=lambda v: (on_topic[v] < 2, _QRANK.get(quartile.get(v, ""), 4), -on_topic[v], v),
    )[:4]
    year = helper._latest_year()
    out = []
    for v in [*others, *own]:
        row = discover.find_journal(names[v], year=year)
        described = discover.describe_journal(row) if row else {}
        snip = described.get("snip")
        out.append({
            "id": _sid("j", v),
            "name": names[v],
            "quartile": described.get("quartile") or quartile.get(v),
            "snip": round(snip, 3) if snip is not None else None,
            "journal_id": row.id if row else None,
            "colleagues": len(colleagues[v]),
            "colleague_papers_on_your_topics": on_topic[v],
            "your_papers_here": mine.get(v, 0),
        })
    return out


def _people(user: User, college: picture._College, co: dict[str, Any], mine_keys: set[str]) -> list[dict[str, Any]]:
    """Colleagues whose topics touch the person's (any department; the scout's
    scoring), then the college co-authors they already write with."""
    my_dept = _fold(user.department)
    q1: Counter[str] = Counter()
    for p in college.pubs.values():
        if (p["quartile"] or "").upper() == "Q1":
            q1.update(p["members"])
    out: list[dict[str, Any]] = []
    seen = {user.id}

    def add(uid: str, relation: str, shared: list[str], together: int) -> None:
        u = college.users.get(uid) or User.objects.filter(id=uid).first()
        if u is None or uid in seen or not u.active:
            return
        seen.add(uid)
        out.append({
            "id": uid, "name": u.name, "dept": u.department or None, "relation": relation,
            "other_department": bool(u.department) and _fold(u.department) != my_dept,
            "shared_topics": shared[:3], "papers": len(college.of(uid)), "q1_papers": q1[uid],
            "papers_together": together,
        })

    for c in scout.colleague_candidates(user, college, limit=8, other_departments_only=False):
        add(c["user_id"], "colleague", c["shared_topics"], 0)
    spelled: dict[str, str] = {}
    for p in college.pubs.values():
        for t in p["topics"]:
            spelled.setdefault(_fold(t), t)
    for c in co["inside"][:5]:
        uid = c.get("user_id")
        if not uid:
            continue
        theirs = Counter(k for p in college.of(uid) for k in p["keys"] if k in mine_keys)
        add(uid, "coauthor", [spelled.get(k, k) for k, _n in theirs.most_common(3)], c["papers_together"])
    return out[:10]


def _topics(college: picture._College, mine: list[dict[str, Any]], interests: list[str], keys: set[str],
            today: date) -> list[dict[str, Any]]:
    """The person's own topics, the topics rising next to them, and the ones they follow."""
    out = [{"id": t["id"], "name": t["name"], "kind": "mine", "papers": t["papers"]} for t in mine[:4]]
    # Rising next to mine: the rule `research_picture.ideas_for` uses -- shares
    # a paper with one of my topics, at least two papers in the last twelve
    # months and more than in the twelve before.
    near: Counter[str] = Counter()
    for p in college.pubs.values():
        if p["keys"] & keys:
            near.update(p["keys"] - keys)
    now, before, spelled = picture._topic_growth(college, today)
    rising = sorted(
        (k for k in near if now.get(k, 0) >= 2 and now[k] > before.get(k, 0)),
        key=lambda k: (-(now[k] - before.get(k, 0)), -near[k], k),
    )[:3]
    out += [{"id": _sid("t", k), "name": spelled.get(k, k), "kind": "rising", "papers_last_12_months": now[k],
             "papers_the_12_before": before.get(k, 0)} for k in rising]
    named = {_fold(t["name"]) for t in out}
    out += [{"id": _sid("t", _fold(d)), "name": d, "kind": "followed"} for d in interests if _fold(d) not in named][:3]
    return out


def goal_year(today: date) -> int:
    """A plan made in the second half of the year aims at the next one."""
    return today.year + 1 if today.month >= 7 else today.year


def _goals(metrics: dict[str, Any], papers_list: list, today: date) -> list[dict[str, Any]]:
    """One goal per metric, each one step past the person's best recent year."""
    def best(pred) -> int:
        return max(sum(1 for p in papers_list if p.year == y and pred(p)) for y in (today.year - 1, today.year))

    year = goal_year(today)
    citations = metrics["citations"]
    targets = {
        ResearchGoal.Metric.PAPERS: (best(lambda p: True) + 1, "One more paper than your best of this year and last."),
        ResearchGoal.Metric.Q1: (best(lambda p: p.quartile == "Q1") + 1,
                                 "One more Q1 paper than your best of this year and last."),
        ResearchGoal.Metric.FIRST_AUTHOR: (best(lambda p: p.first_author) + 1,
                                           "One more first-author paper than your best of this year and last."),
        ResearchGoal.Metric.CITATIONS: (citations + max(10, citations // 5),
                                        "About a fifth more citations than you have now, and at least ten."),
    }
    return [
        {"id": f"g:{metric}", "metric": str(metric), "target": target, "year": year, "rule": rule}
        for metric, (target, rule) in targets.items()
        if 1 <= target <= GOAL_MAX
    ]


def _metric_labels(m: dict[str, Any], dept: str) -> dict[str, str]:
    return {
        "papers": _plural(m["papers"], "paper") + " on record",
        "citations": _plural(m["citations"], "citation"),
        "h_index": f"h-index {m['h_index']}",
        "q1": f"{m['q1']} in Q1 journals",
        "first_author_share": f"First author on {m['first_author_share']}%",
        "journal_share": f"{m['journal_share']}% in journals",
        "rank": (f"{m['rank']} of {m['rank_of']} in {dept}" if m["rank"] else "No department rank yet"),
        "coauthors_other_departments": _plural(m["coauthors_other_departments"], "co-author") + " in other departments",
        "coauthors_outside": _plural(m["coauthors_outside"], "co-author") + " outside the college",
        "this_year": _plural(m["this_year"], "paper") + f" in {m['year']}",
    }


def allowed_ids(facts: dict[str, Any]) -> set[str]:
    """Every id a model may cite: the facts' own, and the metric names."""
    c = facts["candidates"]
    return (
        {p["id"] for p in facts["papers"]}
        | {j["id"] for j in c["journals"]}
        | {p["id"] for p in c["people"]}
        | {t["id"] for t in c["topics"]}
        | {g["id"] for g in c["goals"]}
        | set(METRICS)
    )


def public_facts(facts: dict[str, Any]) -> dict[str, Any]:
    """The counts the compass page shows above the steps."""
    m = facts["metrics"]
    return {
        "papers": m["papers"], "citations": m["citations"], "h_index": m["h_index"],
        "rank": m["rank"], "rank_of": m["rank_of"], "q1": m["q1"],
        "first_author_share": m["first_author_share"], "journal_share": m["journal_share"],
        "topics": [{"name": t["name"], "papers": t["papers"]} for t in facts["topics"]],
    }


# --------------------------------------------------------------------------- #
# What a model's words may carry                                              #
# --------------------------------------------------------------------------- #

_ID_KEYS = {"id", "journal_id", "facts_hash"}


def _without_ids(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _without_ids(v) for k, v in value.items() if k not in _ID_KEYS}
    if isinstance(value, list):
        return [_without_ids(v) for v in value]
    return value


def _numbers(*values: Any) -> set[str]:
    """Every number the facts carry. Ids are left out: a cuid is full of digits
    that are not facts."""
    return helper._numbers(json.dumps([_without_ids(v) for v in values], default=str))


def _trusted(text: Any, allowed: set[str], limit: int) -> str:
    """A model's sentence, or "" when it carries a link, an amount, markup or a
    number the facts do not (the research helper's test)."""
    return helper._clean_sentence(text, allowed, limit)


def _index(facts: dict[str, Any]) -> dict[str, dict[str, str]]:
    c = facts["candidates"]
    return {
        "paper": {p["id"]: p["title"] for p in facts["papers"]},
        "journal": {j["id"]: j["name"] for j in c["journals"]},
        "person": {p["id"]: p["name"] for p in c["people"]},
        "metric": dict(facts["metric_labels"]),
    }


def _evidence(raw: Any, facts: dict[str, Any], limit: int = 3) -> list[dict[str, str]]:
    """Evidence a model cited, kept only where the kind and id are the facts' own;
    the label is ours."""
    index = _index(facts)
    out: list[dict[str, str]] = []
    for e in raw if isinstance(raw, list) else []:
        if not isinstance(e, dict):
            continue
        kind, eid = str(e.get("kind") or ""), str(e.get("id") or "")
        label = index.get(kind, {}).get(eid)
        if label and not any(x["kind"] == kind and x["id"] == eid for x in out):
            out.append({"kind": kind, "id": eid, "label": label})
        if len(out) == limit:
            break
    return out


def _ev(facts: dict[str, Any], kind: str, eid: str) -> dict[str, str]:
    return {"kind": kind, "id": eid, "label": _index(facts)[kind][eid]}


# --------------------------------------------------------------------------- #
# The four features                                                           #
# --------------------------------------------------------------------------- #


def _feature_guards(user: Any) -> list[harness.Guard]:
    """No amounts, no flags or desks for a claimant, no claim that it acted, no
    contact details, no links: the research helper's guards, and no URL at all."""
    return [
        *harness.role_guards(user, allow_money=False, strip_keys=False),
        harness.NoDecisions(),
        harness.no_pii(),
        harness.no_urls_except([]),
    ]


def _evidence_spec() -> harness.Arr:
    return harness.Arr(
        harness.Obj({"kind": harness.Enum(*EVIDENCE_KINDS), "id": harness.Str(64)}),
        max_items=4, drop_invalid=True, required=False, default=[],
    )


def _opt(limit: int) -> harness.Str:
    return harness.Str(limit, truncate=True, required=False, default="")


FACTS_LABEL = "the faculty member's facts, counted from the college's record"

_PORTRAIT_RULES = (
    "You hold up a mirror to a faculty member at an engineering college in India: you describe their "
    "research record back to them. The data holds facts counted from the college's record; every paper, "
    "journal, person and measure in it has an id (the measures are under metric_labels).\n"
    "Write, in the second person and plain English: a headline of at most 30 words on who they are as a "
    "researcher; exactly three strengths, one sentence each, each citing the facts that show it by kind "
    "(paper, journal, person or metric) and id; and one sentence on where they stand. Use only numbers "
    "that appear in the facts and do not work out new ones. Do not mention money, incentives, claims or "
    "payments. No links."
)

#: The considered model: this is the person's first impression of the compass.
PORTRAIT = harness.register(harness.Feature(
    name="compass.portrait",
    model="considered",
    system=_PORTRAIT_RULES,
    schema=harness.Obj({
        "headline": _opt(300),
        "strengths": harness.Arr(
            harness.Obj({"text": harness.Str(400, truncate=True), "evidence": _evidence_spec()}),
            max_items=5, drop_invalid=True, required=False, default=[],
        ),
        "standing": _opt(400),
    }),
    guards=_feature_guards,
    limits=harness.Limits(timeout=60, reasks=1, transient_retries=1, ttl=ANSWER_TTL),
    temperature=0.3,
))

_PATHS_RULES = (
    "You suggest three paths a faculty member at an engineering college in India could grow along. "
    "The data holds their facts, counted from the college's record, and six possible paths, each with a key "
    "and measures the server worked out.\n"
    "Choose the three paths that suit this person best, best first. For each give: the key exactly as given; "
    "a short name of at most six words; one or two sentences on why it suits them, using only the facts; up "
    "to two peers, chosen by id from the candidate people; and up to three pieces of evidence by kind and id. "
    "Do not change, invent or work out any number. Do not mention money, incentives, claims or payments. "
    "No links."
)

PATHS = harness.register(harness.Feature(
    name="compass.paths",
    model="considered",
    system=_PATHS_RULES,
    schema=harness.Obj({
        "paths": harness.Arr(
            harness.Obj({
                "key": harness.Enum(*ARCHETYPES),
                "name": _opt(120),
                "why": _opt(500),
                "peers": harness.Arr(harness.Obj({"id": harness.Str(64)}), max_items=4, drop_invalid=True,
                                     required=False, default=[]),
                "evidence": _evidence_spec(),
            }),
            max_items=8, drop_invalid=True, required=False, default=[],
        ),
    }, from_list="paths"),
    guards=_feature_guards,
    limits=harness.Limits(timeout=60, reasks=1, transient_retries=1, ttl=ANSWER_TTL),
    temperature=0.3,
))

_PLAN_RULES = (
    "You turn one research path a faculty member has chosen into four to six concrete steps, in the order "
    "to take them. The data holds the chosen path with its measures, and their facts with candidate "
    "journals, people, topics and goals, each with an id.\n"
    "Each step has a kind (journal, person, topic or goal), the id of one candidate of that kind, a short "
    "title of at most twelve words, and one sentence on why. Use only candidates and numbers in the data. "
    "Never invent a deadline, a call or a link. Do not mention money, incentives, claims or payments."
)

PLAN = harness.register(harness.Feature(
    name="compass.plan",
    model="considered",
    system=_PLAN_RULES,
    schema=harness.Obj({
        "actions": harness.Arr(
            harness.Obj({"kind": harness.Enum(*STEP_KINDS), "id": harness.Str(64), "title": _opt(160),
                         "why": _opt(400)}),
            max_items=10, drop_invalid=True, required=False, default=[],
        ),
    }, from_list="actions"),
    guards=_feature_guards,
    limits=harness.Limits(timeout=60, reasks=1, transient_retries=1, ttl=ANSWER_TTL),
    temperature=0.3,
))

_ASK_RULES = (
    "You answer a faculty member's questions about their own research record and their research compass. "
    "The data holds their facts, counted from the college's record, the compass so far (portrait, paths "
    "and plan) and their question.\n"
    "Answer in at most 120 words of plain English, using only the data, and cite up to four facts by kind "
    "and id. If the question is not about their research, publishing, co-authors, journals or the compass, "
    "set on_topic to false and say only that you help with their research. Never state a number that is not "
    "in the data. Do not mention money, incentives, claims or payments. No links. You cannot send, save or "
    "change anything."
)

#: The fast model: somebody is waiting on the answer. Counted per person per
#: day here as well as by the endpoint, which also counts turns without AI.
ASK = harness.register(harness.Feature(
    name="compass.ask",
    model="fast",
    system=_ASK_RULES,
    schema=harness.Obj({
        "answer": harness.Str(1200, truncate=True),
        "on_topic": harness.Bool(required=False, default=True),
        "evidence": _evidence_spec(),
    }, from_scalar="answer"),
    guards=_feature_guards,
    limits=harness.Limits(timeout=30, reasks=0, transient_retries=1, person_daily=20, ttl=ANSWER_TTL),
    temperature=0.2,
))


def _facts_block(facts: dict[str, Any]) -> harness.DataBlock:
    shown = {k: v for k, v in facts.items() if k != "facts_hash"}
    return harness.DataBlock(FACTS_LABEL, json.dumps(shown, ensure_ascii=False, default=str), 9000)


def _grounded(facts: dict[str, Any]) -> list[harness.Guard]:
    return [harness.grounded_ids(sorted(allowed_ids(facts)), keys=("id",))]


def _ready(fast: bool = False) -> bool:
    try:
        return bool(ai.health().get("fast_ready" if fast else "ready"))
    except Exception:  # noqa: BLE001 - a health probe never breaks a page
        logger.exception("compass_health_failed")
        return False


# --------------------------------------------------------------------------- #
# Kept between visits                                                         #
# --------------------------------------------------------------------------- #


def _load(raw: str | None) -> dict[str, Any] | None:
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _held(user: User) -> CompassState | None:
    return CompassState.objects.filter(user=user).first()


def _keep(user: User, facts_hash: str, **fields: str) -> CompassState:
    state, _ = CompassState.objects.get_or_create(user=user)
    for name, value in fields.items():
        setattr(state, name, value)
    state.facts_hash = facts_hash
    state.save()
    return state


#: What each kept step was made from. Naming topics (step 2) changes the
#: plan's candidates and so `facts_hash`, but not the record a portrait or a
#: path describes: those stay current through it.
_BASIS = {
    "portrait": ("person", "metrics", "topics", "venues", "papers", "department_areas"),
    "paths": ("metrics", "topics", "papers"),
}


def basis(facts: dict[str, Any], step: str) -> str:
    """The hash of the facts one step (``portrait`` or ``paths``) depends on."""
    part = {k: facts[k] for k in _BASIS[step]}
    part["people"] = facts["candidates"]["people"]
    return hashlib.sha256(json.dumps(part, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def _current(blob: dict[str, Any] | None, facts: dict[str, Any], step: str) -> bool:
    return bool(blob) and blob.get("basis") == basis(facts, step)


def _fresh(blob: dict[str, Any] | None, facts: dict[str, Any], step: str, refresh: bool) -> bool:
    """Whether a kept answer may be shown again: made from these facts, not
    refused by the person, and not a counted stand-in now that AI is back."""
    if refresh or not _current(blob, facts, step):
        return False
    return not (blob.get("counted") and _ready())


# --------------------------------------------------------------------------- #
# Step 1: the portrait                                                        #
# --------------------------------------------------------------------------- #

_PORTRAIT_KEYS = ("headline", "strengths", "topics", "standing", "counted")


def portrait(user: User, *, refresh: bool = False) -> dict[str, Any]:
    """Who the person is as a researcher: a headline, three strengths with
    evidence, their topics and where they stand. Counted when AI is off."""
    facts = facts_for(user)
    state = _held(user)
    kept = _load(state.portrait_json) if state else None
    if _fresh(kept, facts, "portrait", refresh):
        return {k: kept[k] for k in _PORTRAIT_KEYS}
    made_from = basis(facts, "portrait")
    result = counted_portrait(facts)
    if _ready():
        got = PORTRAIT.run(user=user, data_blocks=[_facts_block(facts)], cache_key=made_from,
                           guards=_grounded(facts), refresh=refresh)
        if got.ok:
            result = _merge_portrait(got.data, facts, result)
        else:
            logger.info("compass_portrait_counted code=%s", got.code)
    _keep(user, facts["facts_hash"], portrait_json=json.dumps(
        {**result, "basis": made_from, "facts_hash": facts["facts_hash"]}))
    return result


def counted_portrait(facts: dict[str, Any]) -> dict[str, Any]:
    return {
        "headline": _headline(facts),
        "strengths": _counted_strengths(facts)[:3],
        "topics": [{"name": t["name"], "papers": t["papers"]} for t in facts["topics"]],
        "standing": _standing(facts),
        "counted": True,
    }


def _headline(facts: dict[str, Any]) -> str:
    m = facts["metrics"]
    if not m["papers"]:
        return "There are no papers on your record yet. Name the topics you work on and the compass starts there."
    tail = f"{_plural(m['papers'], 'paper')}, h-index {m['h_index']}, {m['q1']} in Q1 journals."
    names = [t["name"] for t in facts["topics"][:2]]
    text = f"You have {tail}"
    for k in (2, 1):
        if len(names) >= k:
            candidate = f"You publish mostly on {' and '.join(names[:k])}, {tail}"
            if len(candidate.split()) <= 30:
                return candidate
    return text


def _counted_strengths(facts: dict[str, Any]) -> list[dict[str, Any]]:
    """Strengths read off the counts, strongest evidence first; padded with
    plain, true sentences for a record too thin to have three."""
    m, papers = facts["metrics"], facts["papers"]
    n = m["papers"]
    out: list[dict[str, Any]] = []

    def add(text: str, evidence: list[dict[str, str]]) -> None:
        out.append({"text": text, "evidence": evidence[:3]})

    if m["q1"]:
        verb = "is in a Q1 journal" if m["q1"] == 1 else "are in Q1 journals"
        add(f"{m['q1']} of your {_plural(n, 'paper')} {verb}.",
            [_ev(facts, "metric", "q1"), *[_ev(facts, "paper", p["id"]) for p in papers if p["quartile"] == "Q1"][:2]])
    top = max(papers, key=lambda p: p["citations"], default=None)
    if top and top["citations"]:
        add(f"Your most cited paper, “{_clip(top['title'], 90)}”, has {_plural(top['citations'], 'citation')}.",
            [_ev(facts, "paper", top["id"])])
    if m["first_author"]:
        add(f"You are first author on {m['first_author']} of your {_plural(n, 'paper')} "
            f"({m['first_author_share']}%).", [_ev(facts, "metric", "first_author_share")])
    if facts["topics"]:
        t = facts["topics"][0]
        on = [p for p in papers if t["name"] in p["topics"]]
        add(f"{t['papers']} of your papers {'is' if t['papers'] == 1 else 'are'} on {t['name']}.",
            [_ev(facts, "paper", p["id"]) for p in on[:2]])
    if m["coauthors_other_departments"]:
        add(f"You have written with {_plural(m['coauthors_other_departments'], 'colleague')} in other departments.",
            [_ev(facts, "metric", "coauthors_other_departments")])
    if m["coauthors_outside"]:
        add(f"You have written with {_plural(m['coauthors_outside'], 'co-author')} outside the college.",
            [_ev(facts, "metric", "coauthors_outside")])
    if m["this_year"] > m["last_year_by_now"]:
        add(f"You have {_plural(m['this_year'], 'paper')} this year, against {m['last_year_by_now']} by this "
            "time last year.", [_ev(facts, "metric", "this_year")])
    if m["citations"]:
        add(f"Your papers have {_plural(m['citations'], 'citation')} in all.", [_ev(facts, "metric", "citations")])
    if facts["department_areas"]:
        add(f"Your department works on {', '.join(facts['department_areas'][:3])}, so you have colleagues to "
            "build with.", [])
    if facts["interests"]:
        add(f"You follow {', '.join(facts['interests'][:3])}, and the suggestions here follow them too.", [])
    for text in (
        "Every paper you add to the record shows here first.",
        "You can name the topics you work on, and the compass tunes its suggestions to them.",
        "Colleagues across the college publish in areas you can join.",
    ):
        if len(out) >= 3:
            break
        add(text, [])
    return out


def _standing(facts: dict[str, Any]) -> str:
    m, dept = facts["metrics"], facts["person"]["department"]
    if m["rank"]:
        text = f"By papers weighted for their quartile you are {m['rank']} of {m['rank_of']} in {dept}."
    elif m["papers"]:
        text = f"You have {_plural(m['papers'], 'paper')} on record."
    else:
        return "Your record starts with your first paper."
    if m["this_year"] or m["last_year_by_now"]:
        text += (f" This year: {_plural(m['this_year'], 'paper')}, against {m['last_year_by_now']} "
                 "by this time last year.")
    return text


def _merge_portrait(data: Any, facts: dict[str, Any], counted: dict[str, Any]) -> dict[str, Any]:
    """The model's words where they can be trusted, the counted ones where not."""
    data = data if isinstance(data, dict) else {}
    allowed = _numbers(facts)
    headline = _trusted(data.get("headline"), allowed, 300)
    if not headline or len(headline.split()) > 30:
        headline = ""
    strengths: list[dict[str, Any]] = []
    for s in data.get("strengths") or []:
        text = _trusted(s.get("text") if isinstance(s, dict) else None, allowed, 400)
        if text:
            strengths.append({"text": text, "evidence": _evidence(s.get("evidence"), facts)})
        if len(strengths) == 3:
            break
    standing = _trusted(data.get("standing"), allowed, 400)
    if not (headline or strengths or standing):
        return counted
    for s in counted["strengths"]:
        if len(strengths) == 3:
            break
        strengths.append(s)
    return {
        "headline": headline or counted["headline"],
        "strengths": strengths,
        "topics": counted["topics"],
        "standing": standing or counted["standing"],
        "counted": False,
    }


# --------------------------------------------------------------------------- #
# Step 3: the paths                                                           #
# --------------------------------------------------------------------------- #


def _top_topic(facts: dict[str, Any]) -> dict[str, Any] | None:
    return facts["topics"][0] if facts["topics"] else None


def _measures(key: str, facts: dict[str, Any]) -> list[dict[str, Any]]:
    """A path's measure now and its target, by a rule anybody can check."""
    m = facts["metrics"]
    if key == "q1_author":
        return [{"label": "Q1 papers within two years", "now": m["q1"], "target": m["q1"] + 2, "unit": "papers"}]
    if key == "first_author":
        now = m["first_author_share"]
        return [{"label": "Share of papers as first author", "now": now, "target": min(100, now + 20), "unit": "%"}]
    if key == "cross_dept":
        now = m["coauthors_other_departments"]
        return [{"label": "Co-authors in other departments", "now": now, "target": now + 2, "unit": "people"}]
    if key == "conf_to_journal":
        now = m["journal_share"]
        return [{"label": "Share of papers in journals", "now": now, "target": min(100, now + 20), "unit": "%"}]
    if key == "focus_topic":
        t = _top_topic(facts)
        now = t["papers"] if t else 0
        return [{"label": f"Papers on {t['name'] if t else 'your main topic'}", "now": now, "target": now + 3,
                 "unit": "papers"}]
    return [{"label": "h-index", "now": m["h_index"], "target": m["h_index"] + 2, "unit": ""}]


def _gap(key: str, facts: dict[str, Any]) -> float:
    """How far the person is from strong on a path, from 0 (there) to 1."""
    m = facts["metrics"]
    n = m["papers"]
    if key == "q1_author":
        return 1 - (m["q1"] / n if n else 0)
    if key == "first_author":
        return 1 - m["first_author_share"] / 100
    if key == "cross_dept":
        return 1 / (1 + m["coauthors_other_departments"])
    if key == "conf_to_journal":
        return 1 - m["journal_share"] / 100
    if key == "focus_topic":
        t = _top_topic(facts)
        return 1 - ((t["papers"] / n) if (t and n) else 0)
    return 1 / (1 + m["h_index"])


def _name(key: str, facts: dict[str, Any]) -> str:
    t = _top_topic(facts)
    return {
        "q1_author": "Q1 author",
        "first_author": "Lead author",
        "cross_dept": "Bridge across departments",
        "conf_to_journal": "Journal first",
        "focus_topic": f"Specialist in {t['name']}" if t else "A field of your own",
        "citations": "Cited and known",
    }[key]


def _why(key: str, facts: dict[str, Any]) -> str:
    (measure,) = _measures(key, facts)
    now, target = measure["now"], measure["target"]
    m = facts["metrics"]
    if key == "q1_author":
        return f"{m['q1']} of your {_plural(m['papers'], 'paper')} {'is' if m['q1'] == 1 else 'are'} in Q1 journals. " \
               f"Aim for {target} within two years."
    if key == "first_author":
        return f"You are first author on {now}% of your papers. Aim for {target}%."
    if key == "cross_dept":
        return f"You have written with {_plural(now, 'colleague')} in other departments. Aim for {target}."
    if key == "conf_to_journal":
        return f"{now}% of your papers are in journals. Aim for {target}%."
    if key == "focus_topic":
        t = _top_topic(facts)
        if not t:
            return "Pick one topic and publish on it again and again until it is yours."
        return f"{t['papers']} of your papers {'is' if t['papers'] == 1 else 'are'} on {t['name']}. Aim for {target}."
    return f"Your h-index is {now}. Aim for {target}."


def _peer(p: dict[str, Any]) -> dict[str, Any]:
    return {"id": p["id"], "name": p["name"], "dept": p["dept"]}


def _peers_for(key: str, facts: dict[str, Any], k: int = 2) -> list[dict[str, Any]]:
    """Who could help on a path, counted: another department for a bridge, Q1
    papers for Q1 and journals, the main topic for a specialist."""
    people = facts["candidates"]["people"]
    if key == "cross_dept":
        pool = [p for p in people if p["other_department"]]
    # No fallback to "anyone": a colleague named under a path they are not on
    # is worse than naming nobody, and the page hides the line when empty.
    elif key in ("q1_author", "conf_to_journal", "citations"):
        pool = sorted((p for p in people if p["q1_papers"]), key=lambda p: -p["q1_papers"])
    elif key == "focus_topic":
        t = _top_topic(facts)
        pool = [p for p in people if t and t["name"] in p["shared_topics"]]
    else:
        pool = [p for p in people if p["relation"] == "coauthor"] or people
    return [_peer(p) for p in pool[:k]]


def _path(key: str, name: str, why: str, evidence: list[dict[str, str]], peers: list[dict[str, Any]],
          facts: dict[str, Any]) -> dict[str, Any]:
    return {"key": key, "name": name, "why": why, "evidence": evidence, "metrics": _measures(key, facts),
            "peers": peers}


def counted_paths(facts: dict[str, Any]) -> dict[str, Any]:
    """The three paths with the largest gaps, named from templates."""
    keys = sorted(ARCHETYPES, key=lambda k: (-_gap(k, facts), ARCHETYPES.index(k)))[:3]
    return {"paths": [_path(k, _name(k, facts), _why(k, facts), _path_evidence(k, facts), _peers_for(k, facts), facts)
                      for k in keys], "counted": True}


def _path_evidence(key: str, facts: dict[str, Any]) -> list[dict[str, str]]:
    metric = {"q1_author": "q1", "first_author": "first_author_share", "cross_dept": "coauthors_other_departments",
              "conf_to_journal": "journal_share", "focus_topic": "papers", "citations": "h_index"}[key]
    return [_ev(facts, "metric", metric)]


def _archetype_block(facts: dict[str, Any]) -> harness.DataBlock:
    rows = [{"key": k, "measures": _measures(k, facts), "plain_name": _name(k, facts)} for k in ARCHETYPES]
    return harness.DataBlock("the six paths, measured by the server", json.dumps(rows, ensure_ascii=False), 3000)


def paths(user: User, *, refresh: bool = False) -> dict[str, Any]:
    """Three paths the person could grow along. Measures from code, always."""
    facts = facts_for(user)
    state = _held(user)
    kept = _load(state.paths_json) if state else None
    if _fresh(kept, facts, "paths", refresh):
        return {"paths": kept["paths"], "counted": kept["counted"]}
    made_from = basis(facts, "paths")
    result = counted_paths(facts)
    if _ready():
        got = PATHS.run(user=user, data_blocks=[_facts_block(facts), _archetype_block(facts)],
                        cache_key=made_from, guards=_grounded(facts), refresh=refresh)
        if got.ok:
            result = _merge_paths(got.data, facts, result)
        else:
            logger.info("compass_paths_counted code=%s", got.code)
    _keep(user, facts["facts_hash"], paths_json=json.dumps(
        {**result, "basis": made_from, "facts_hash": facts["facts_hash"]}))
    return result


def _merge_paths(data: Any, facts: dict[str, Any], counted: dict[str, Any]) -> dict[str, Any]:
    data = data if isinstance(data, dict) else {}
    allowed = _numbers(facts, [_measures(k, facts) for k in ARCHETYPES])
    people = {p["id"]: p for p in facts["candidates"]["people"]}
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in data.get("paths") or []:
        key = row.get("key") if isinstance(row, dict) else None
        if key not in ARCHETYPES or key in seen:
            continue
        seen.add(key)
        peers = [_peer(people[p["id"]]) for p in row.get("peers") or []
                 if isinstance(p, dict) and p.get("id") in people][:2]
        out.append(_path(
            key,
            _trusted(row.get("name"), allowed, 80) or _name(key, facts),
            _trusted(row.get("why"), allowed, 400) or _why(key, facts),
            _evidence(row.get("evidence"), facts) or _path_evidence(key, facts),
            peers or _peers_for(key, facts),
            facts,
        ))
        if len(out) == 3:
            break
    if not out:
        return counted
    for p in counted["paths"]:
        if len(out) < 3 and p["key"] not in seen:
            out.append(p)
            seen.add(p["key"])
    for k in sorted(ARCHETYPES, key=lambda k: (-_gap(k, facts), ARCHETYPES.index(k))):
        if len(out) < 3 and k not in seen:
            out.append(_path(k, _name(k, facts), _why(k, facts), _path_evidence(k, facts), _peers_for(k, facts), facts))
            seen.add(k)
    return {"paths": out, "counted": False}


# --------------------------------------------------------------------------- #
# Step 4: the plan                                                            #
# --------------------------------------------------------------------------- #

_GOAL_WORDS = {"PAPERS": ("paper", "papers"), "Q1": ("Q1 paper", "Q1 papers"),
               "FIRST_AUTHOR": ("first-author paper", "first-author papers"), "CITATIONS": ("citation", "citations")}


def _action_id(path_key: str, kind: str, cid: str) -> str:
    return _sid("a", f"{path_key}|{kind}|{cid}")


def _step(path_key: str, kind: str, c: dict[str, Any]) -> dict[str, Any]:
    """A step from one candidate: the counted title and reason, and the ref,
    which is always the record's and never a model's."""
    if kind == "journal":
        bits = [c["quartile"] or "Not ranked in Scimago"]
        if c["snip"] is not None:
            bits.append(f"SNIP {c['snip']}")
        why = ", ".join(bits) + "."
        if c["colleague_papers_on_your_topics"]:
            why += f" Colleagues here published {_plural(c['colleague_papers_on_your_topics'], 'paper')} on your topics in it."
        elif c["your_papers_here"]:
            why += f" You have published {_plural(c['your_papers_here'], 'paper')} in it."
        title = f"Aim a paper at {c['name']}"
        ref = {"journal_id": c["journal_id"], "name": c["name"], "quartile": c["quartile"], "snip": c["snip"]}
    elif kind == "person":
        topic = c["shared_topics"][0] if c["shared_topics"] else None
        title = f"Talk to {c['name']}" + (f" about {topic}" if topic else "")
        if c["relation"] == "coauthor":
            why = f"You have written {_plural(c['papers_together'], 'paper')} together."
        else:
            why = (f"{c['dept'] or 'A colleague'}" + (f", also working on {', '.join(c['shared_topics'][:2])}"
                                                       if c["shared_topics"] else "") + ".")
        ref = {"user_id": c["id"], "name": c["name"], "dept": c["dept"]}
    elif kind == "topic":
        title = f"Read the newest papers on {c['name']}"
        if c["kind"] == "rising":
            why = (f"{_plural(c['papers_last_12_months'], 'paper')} here in the last 12 months, "
                   f"up from {c['papers_the_12_before']}.")
        elif c["kind"] == "mine":
            why = f"{c['papers']} of your papers {'is' if c['papers'] == 1 else 'are'} on it already."
        else:
            why = "You said you follow it."
        ref = {"name": c["name"]}
    else:
        one, many = _GOAL_WORDS.get(c["metric"], ("paper", "papers"))
        title = f"Set a goal: {c['target']} {one if c['target'] == 1 else many} in {c['year']}"
        why = c["rule"]
        ref = {"metric": c["metric"], "target": c["target"], "year": c["year"]}
    return {"id": _action_id(path_key, kind, c["id"]), "kind": kind, "title": title[:160], "why": why, "ref": ref,
            "done": False}


def _candidates_of(facts: dict[str, Any]) -> dict[str, dict[str, dict[str, Any]]]:
    c = facts["candidates"]
    return {
        "journal": {j["id"]: j for j in c["journals"]},
        "person": {p["id"]: p for p in c["people"]},
        "topic": {t["id"]: t for t in c["topics"]},
        "goal": {g["id"]: g for g in c["goals"]},
    }


def counted_plan(path_key: str, facts: dict[str, Any]) -> dict[str, Any]:
    """Steps on a path, chosen by rules from the same candidates."""
    c = facts["candidates"]
    # A journal is worth aiming at when it publishes the person's kind of work:
    # their own journals and those with colleagues' papers on their topics come
    # before a high SNIP alone (a Q1 biosensors journal is no target for an
    # English-teaching researcher just because it ranks well).
    relevant = [j for j in c["journals"] if j["your_papers_here"] or j["colleague_papers_on_your_topics"] >= 2]
    by_rank = sorted(relevant or c["journals"], key=lambda j: (
        _QRANK.get(j["quartile"] or "", 4), -(j["your_papers_here"] > 0), -j["colleague_papers_on_your_topics"],
        -(j["snip"] or 0), j["name"]))
    by_topic = sorted(c["journals"], key=lambda j: (-j["colleague_papers_on_your_topics"], -j["your_papers_here"],
                                                    _QRANK.get(j["quartile"] or "", 4), j["name"]))
    people = {p["id"]: p for p in c["people"]}
    peers = [people[p["id"]] for p in _peers_for(path_key, facts)]
    rising = [t for t in c["topics"] if t["kind"] == "rising"]
    own = [t for t in c["topics"] if t["kind"] == "mine"]
    goal = [g for g in c["goals"] if g["metric"] == GOAL_FOR[path_key]]

    picks: list[tuple[str, dict[str, Any]]] = []
    # The person's own topics first: a topic rising elsewhere in the college is
    # only the point on the bridge-building path.
    if path_key in ("q1_author", "conf_to_journal"):
        picks += [("journal", j) for j in by_rank[:2]] + [("person", p) for p in peers[:1]]
        picks += [("topic", t) for t in (own or rising)[:1]]
    elif path_key == "cross_dept":
        picks += [("person", p) for p in peers[:2]] + [("topic", t) for t in (rising or own)[:1]]
        picks += [("journal", j) for j in by_topic[:1]]
    elif path_key == "focus_topic":
        picks += [("topic", t) for t in own[:1]] + [("journal", j) for j in by_topic[:1]]
        picks += [("person", p) for p in peers[:1]]
    else:  # first_author, citations
        picks += [("journal", j) for j in (by_rank if path_key == "citations" else by_topic)[:1]]
        picks += [("person", p) for p in peers[:1]] + [("topic", t) for t in (own or rising)[:1]]
    picks += [("goal", g) for g in goal]
    # A thin record still gets four steps where there are four candidates.
    for kind, pool in (("topic", c["topics"]), ("journal", by_rank), ("person", c["people"])):
        for item in pool:
            if len(picks) >= MIN_STEPS:
                break
            if (kind, item["id"]) not in {(k, x["id"]) for k, x in picks}:
                picks.append((kind, item))
    steps = [_step(path_key, kind, item) for kind, item in picks][:MAX_STEPS]
    return {"actions": steps, "counted": True}


def _merge_plan(data: Any, path_key: str, facts: dict[str, Any], counted: dict[str, Any]) -> dict[str, Any]:
    data = data if isinstance(data, dict) else {}
    allowed = _numbers(facts, _measures(path_key, facts))
    index = _candidates_of(facts)
    steps: list[dict[str, Any]] = []
    for row in data.get("actions") or []:
        if not isinstance(row, dict):
            continue
        kind, cid = row.get("kind"), str(row.get("id") or "")
        cand = index.get(kind, {}).get(cid)
        if cand is None:
            continue
        step = _step(path_key, kind, cand)
        if any(s["id"] == step["id"] for s in steps):
            continue
        step["title"] = _trusted(row.get("title"), allowed, 160) or step["title"]
        step["why"] = _trusted(row.get("why"), allowed, 400) or step["why"]
        steps.append(step)
        if len(steps) == MAX_STEPS:
            break
    if not steps:
        return counted
    for s in counted["actions"]:
        if len(steps) >= MIN_STEPS:
            break
        if all(x["id"] != s["id"] for x in steps):
            steps.append(s)
    return {"actions": steps, "counted": False}


def _deadlines(user: User, path_key: str, today: date) -> list[dict[str, Any]]:
    """Dated calls from the person's own latest Claude scout run, and only while
    Claude is the provider: its links were ones the web search returned
    (`scout._clean`). Nothing else may put a date in a plan."""
    if ai.provider_name() != "anthropic":
        return []
    run = ScoutRun.objects.filter(user=user, status=ScoutRun.Status.DONE).first()
    if run is None:
        return []
    web = (_load(run.result_json) or {}).get("web") or {}
    out = []
    for o in web.get("opportunities") or []:
        if not isinstance(o, dict):
            continue
        title = " ".join(str(o.get("title") or "").split())[:200]
        url = str(o.get("url") or "").strip()
        try:
            on = date.fromisoformat(str(o.get("deadline") or "")[:10])
        except ValueError:
            continue
        if on < today or len(title) < 3 or not re.match(r"https?://\S+$", url):
            continue
        out.append({
            "id": _action_id(path_key, "deadline", f"{on.isoformat()}|{url}"),
            "kind": "deadline",
            "title": f"Closes {on.isoformat()}: {title}"[:160],
            "why": "Found by your research scout on the web. Check the page before you rely on the date.",
            "ref": {"date": on.isoformat(), "url": url, "title": title},
            "done": False,
        })
    return sorted(out, key=lambda a: a["ref"]["date"])[:MAX_DEADLINES]


def plan(user: User, path_key: str) -> dict[str, Any]:
    """Four to six steps on the chosen path. Choosing the same path again keeps
    the plan and its ticks; another path starts a new one."""
    if path_key not in ARCHETYPES:
        raise InputError("Choose one of the paths shown.")
    facts = facts_for(user)
    state = _held(user)
    kept = _load(state.plan_json) if state else None
    if state and state.chosen_path == path_key and kept and kept.get("path") == path_key:
        return {"plan": kept["actions"], "counted": kept["counted"]}

    result = counted_plan(path_key, facts)
    if _ready():
        chosen = _path_named(state, path_key, facts)
        block = harness.DataBlock("the chosen path", json.dumps({
            "key": path_key, "name": chosen["name"], "why": chosen["why"], "measures": _measures(path_key, facts),
        }, ensure_ascii=False), 2000)
        got = PLAN.run(user=user, data_blocks=[block, _facts_block(facts)],
                       cache_key=f"{facts['facts_hash']}:{path_key}", guards=_grounded(facts))
        if got.ok:
            result = _merge_plan(got.data, path_key, facts, result)
        else:
            logger.info("compass_plan_counted code=%s", got.code)
    deadlines = _deadlines(user, path_key, timezone.localdate())
    actions = deadlines + result["actions"][: MAX_STEPS - len(deadlines)]
    name = _path_named(state, path_key, facts)["name"]
    _keep(user, facts["facts_hash"], chosen_path=path_key, plan_json=json.dumps({
        "path": path_key, "path_name": name, "actions": actions, "counted": result["counted"],
        "facts_hash": facts["facts_hash"],
    }))
    return {"plan": actions, "counted": result["counted"]}


def _path_named(state: CompassState | None, path_key: str, facts: dict[str, Any]) -> dict[str, str]:
    """The path as the person was shown it, or as the templates name it."""
    kept = _load(state.paths_json) if state else None
    for p in (kept or {}).get("paths") or []:
        if p.get("key") == path_key:
            return {"name": p["name"], "why": p["why"]}
    return {"name": _name(path_key, facts), "why": _why(path_key, facts)}


def _progress(actions: list[dict[str, Any]]) -> dict[str, int]:
    return {"done": sum(1 for a in actions if a.get("done")), "total": len(actions)}


def tick(user: User, action_id: str, done: bool) -> dict[str, Any]:
    """Mark one step done or not done; the plan keeps it."""
    state = _held(user)
    kept = _load(state.plan_json) if state else None
    actions = (kept or {}).get("actions") or []
    step = next((a for a in actions if a.get("id") == action_id), None)
    if step is None:
        raise NotFound("That step is not in your plan.")
    step["done"] = bool(done)
    state.plan_json = json.dumps(kept)
    state.save(update_fields=["plan_json", "updated_at"])
    return {"ok": True, "done": bool(done), "progress": _progress(actions)}


# --------------------------------------------------------------------------- #
# The page, and the card on Home                                              #
# --------------------------------------------------------------------------- #


def overview(user: User) -> dict[str, Any]:
    """Everything the compass page draws on arrival. Reads; writes nothing, and
    asks no model."""
    facts = facts_for(user)
    state = _held(user)
    out: dict[str, Any] = {"ai": _ready(), "facts": public_facts(facts), "portrait": None, "paths": None,
                           "chosen_path": None, "plan": None}
    if state is None:
        return out
    kept = _load(state.portrait_json)
    if _current(kept, facts, "portrait"):
        out["portrait"] = {k: kept[k] for k in _PORTRAIT_KEYS}
    kept = _load(state.paths_json)
    if _current(kept, facts, "paths"):
        out["paths"] = kept["paths"]
    kept = _load(state.plan_json)
    if kept and state.chosen_path:
        out["chosen_path"] = state.chosen_path
        out["plan"] = kept["actions"]
    return out


def summary(user: User) -> dict[str, Any]:
    """The Home and My research card: no counting and no model, only what is kept."""
    out: dict[str, Any] = {"headline": None, "path_name": None, "progress": None, "next_action": None}
    state = _held(user)
    if state is None:
        return out
    kept = _load(state.portrait_json)
    out["headline"] = kept.get("headline") if kept else None
    kept = _load(state.plan_json)
    if kept and state.chosen_path:
        actions = kept.get("actions") or []
        named = _load(state.paths_json) or {}
        out["path_name"] = next((p["name"] for p in named.get("paths") or [] if p.get("key") == state.chosen_path),
                                kept.get("path_name"))
        out["progress"] = _progress(actions)
        out["next_action"] = next((a for a in actions if not a.get("done")), None)
    return out


# --------------------------------------------------------------------------- #
# Asking                                                                      #
# --------------------------------------------------------------------------- #

#: "Draft an email ...", "write a note ...": a request for a note, named or not.
_NOTE = re.compile(
    r"\b(?:draft|write|compose)\b.*\b(?:e-?mail|mail|message|note|letter|introduction|intro)\b", re.IGNORECASE
)
#: "Email Dr X", "write to Dr X": a note only when it names somebody, because
#: "message" alone is as often a noun in a question about the record.
_TO_SOMEONE = re.compile(r"\b(?:e-?mail|message|write to|introduce me to)\b", re.IGNORECASE)
_HONORIFIC = {"dr", "prof", "professor", "mr", "mrs", "ms", "miss", "sir", "madam"}


def asked_today(user: User) -> int:
    since = timezone.localtime().replace(hour=0, minute=0, second=0, microsecond=0)
    return AuditLog.objects.filter(actor=user, action=ACTION_ASK, created_at__gte=since).count()


def ask(user: User, question: str) -> dict[str, Any]:
    """An answer from the record and the compass, or a first note to a colleague.

    Raises `InputError` for an empty or overlong question and `LimitReached`
    once today's questions are used. Every turn is written to the audit trail
    with no more of the question than `LOGGED_QUESTION` characters.
    """
    q = " ".join((question or "").split())
    if not q:
        raise InputError("Ask a question about your research.")
    if len(q) > MAX_QUESTION:
        raise InputError(f"Keep the question under {MAX_QUESTION} characters.")
    limit = ask_daily_limit()
    if asked_today(user) >= limit:
        raise LimitReached(f"You have asked the compass {limit} questions today. It answers again tomorrow.")
    facts = facts_for(user)
    person = _named_person(q, facts)
    if person is not None and (_NOTE.search(q) or _TO_SOMEONE.search(q)):
        out, kind = _draft(user, facts, person, q), "draft"
    elif _NOTE.search(q):
        out, kind = _who_to_write_to(facts), "draft"
    else:
        out, kind = _answer(user, facts, q)
    AuditLog.objects.create(
        actor=user, action=ACTION_ASK, entity="Compass", entity_id=None,
        detail_json=json.dumps({"question": q[:LOGGED_QUESTION], "kind": kind, "counted": out["counted"]}),
    )
    return out


def _named_person(q: str, facts: dict[str, Any]) -> dict[str, Any] | None:
    """The candidate whose name the question uses most fully, if any."""
    words = set(re.findall(r"[a-z]+", q.lower()))
    best, score = None, 0
    for p in facts["candidates"]["people"]:
        parts = [w for w in re.findall(r"[a-z]+", p["name"].lower()) if w not in _HONORIFIC and len(w) > 1]
        hit = sum(1 for w in parts if w in words)
        if hit > score:
            best, score = p, hit
    return best


def _who_to_write_to(facts: dict[str, Any]) -> dict[str, Any]:
    people = facts["candidates"]["people"][:3]
    if not people:
        return {"answer": "There is nobody in your compass to write to yet. Add a paper or a topic and ask again.",
                "evidence": [], "counted": True}
    names = ", ".join(p["name"] for p in people)
    return {"answer": f"I can draft a first note to someone in your compass, such as {names}. Ask again with their name.",
            "evidence": [_ev(facts, "person", p["id"]) for p in people], "counted": True}


def _draft(user: User, facts: dict[str, Any], person: dict[str, Any], q: str) -> dict[str, Any]:
    """A first note to a colleague, through the research helper's own draft
    feature and its template. Returned to be edited; nothing is sent."""
    college = picture.shared_college()
    theirs = sorted(college.of(person["id"]), key=lambda p: (-len(set(p["topics"]) & set(person["shared_topics"])),
                                                              -(p["year"] or 0), p["id"]))
    links = helper._shared_coauthors(user.id, [person["id"]])[person["id"]]
    described = graph._describe(set(links["shared"]))
    who = {
        "user_id": person["id"],
        "name": person["name"],
        "department": person["dept"],
        "papers": [{"title": p["title"], "year": p["year"]} for p in theirs[:3]]
        or [{"title": "your work", "year": None}],
        "papers_together": links["papers_together"],
        "shared_coauthors": [{"user_id": described[n]["user_id"], "name": described[n]["name"]}
                             for n in links["shared"] if n in described and described[n]["name"]],
    }
    about = re.search(r"\babout\b(.+)$", q, re.IGNORECASE)
    topics = [t["name"] for t in facts["topics"][:2]]
    idea = about.group(1).strip(" .?!") if about else ("my work on " + " and ".join(topics) if topics else "my research")
    inp = {"title": "", "text": idea[:300]}
    evidence = [_ev(facts, "person", person["id"])]
    message, counted = helper.template_draft(user, who, inp), True
    if _ready(fast=True):
        key = f"compass:{facts['facts_hash']}:{person['id']}:{hashlib.sha1(idea.encode()).hexdigest()[:10]}"
        got = helper.DRAFT.run(user=user, data_blocks=helper._draft_blocks(user, who, inp), cache_key=key)
        if got.ok:
            text = helper.validate_draft(got.data)
            if text:
                message, counted = text, False
        elif got.code in _LIMIT_CODES:
            raise LimitReached(got.message)
    return {"answer": message, "evidence": evidence, "counted": counted}


_FACT_RULES = (
    (re.compile(r"h-?\s?index", re.I), "h_index"),
    (re.compile(r"\bcit(?:e|ed|ation|ations)\b", re.I), "citations"),
    (re.compile(r"\bq1\b|quartile", re.I), "q1"),
    (re.compile(r"first[- ]author|\blead", re.I), "first_author_share"),
    (re.compile(r"journal|conference", re.I), "journal_share"),
    (re.compile(r"\brank|\bstand|department", re.I), "rank"),
    (re.compile(r"co-?author|collaborat|work with|partner", re.I), "coauthors_other_departments"),
    (re.compile(r"this year|pace|last year", re.I), "this_year"),
)


def _fact(q: str, facts: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """The one counted fact that answers the question best."""
    m = facts["metrics"]
    key = next((k for rx, k in _FACT_RULES if rx.search(q)), "papers")
    sentence = {
        "h_index": f"Your h-index is {m['h_index']}.",
        "citations": f"Your papers have {_plural(m['citations'], 'citation')} in all.",
        "q1": f"{m['q1']} of your {_plural(m['papers'], 'paper')} are in Q1 journals.",
        "first_author_share": f"You are first author on {m['first_author_share']}% of your papers.",
        "journal_share": f"{m['journal_share']}% of your papers are in journals.",
        "rank": _standing(facts),
        "coauthors_other_departments": (
            f"You have written with {m['coauthors_in_department']} in your department, "
            f"{m['coauthors_other_departments']} in other departments and {m['coauthors_outside']} outside the college."),
        "this_year": (f"You have {_plural(m['this_year'], 'paper')} this year, against {m['last_year_by_now']} "
                      "by this time last year."),
        "papers": _headline(facts),
    }[key]
    return sentence, [_ev(facts, "metric", key)]


def _compass_block(user: User) -> harness.DataBlock:
    state = _held(user)
    shown: dict[str, Any] = {}
    if state is not None:
        for name, field in (("portrait", "portrait_json"), ("paths", "paths_json"), ("plan", "plan_json")):
            kept = _load(getattr(state, field))
            if kept:
                shown[name] = {k: v for k, v in kept.items() if k != "facts_hash"}
    return harness.DataBlock("the compass so far", json.dumps(shown, ensure_ascii=False, default=str), 4000)


def _answer(user: User, facts: dict[str, Any], q: str) -> tuple[dict[str, Any], str]:
    fact, evidence = _fact(q, facts)
    if not _ready(fast=True):
        return {"answer": f"{OFF_TEXT} {fact}", "evidence": evidence, "counted": True}, "off"
    compass_block = _compass_block(user)
    key = hashlib.sha1(f"{q}|{compass_block.text}".encode("utf-8")).hexdigest()[:16]
    got = ASK.run(user=user, data_blocks=[_facts_block(facts), compass_block,
                                          harness.DataBlock("the question", q, MAX_QUESTION + 20)],
                  cache_key=f"{facts['facts_hash']}:{key}", guards=_grounded(facts))
    if not got.ok:
        if got.code in _LIMIT_CODES:
            raise LimitReached(got.message)
        return {"answer": f"{FAILED_TEXT} {fact}", "evidence": evidence, "counted": True}, "failed"
    data = got.data if isinstance(got.data, dict) else {}
    if data.get("on_topic") is False:
        return {"answer": OFF_TOPIC_TEXT, "evidence": [], "counted": False}, "refused"
    text = _trusted(data.get("answer"), _numbers(facts), 1200)
    if not text:
        return {"answer": f"{UNCHECKED_TEXT} {fact}", "evidence": evidence, "counted": True}, "unchecked"
    return {"answer": text, "evidence": _evidence(data.get("evidence"), facts, limit=4), "counted": False}, "answer"
