"""Who an event is for: the topics it is about, the people who work on them, and who has been asked.

Whoever may edit an event (the person who posted it, or the office) finds people
to invite here. The topics come from the college's record (`research_picture`):
the 120 most common topics on its papers. A model may choose an event's topics
only from that list (`events.audience`, the harness's grounded guard on the
names); with AI off, failing, or naming nothing on the list, the topics are
chosen by word overlap with the event's own text.

People are scored by their papers on the chosen topics, plus one for each chosen
topic they list as a research interest. Only people who may see the event are
offered or invited: the Events page's rule (`calendar._visible_events`) applied
to a set of people, because an invitation that opens a page its reader cannot
open is worse than no invitation.
"""
from __future__ import annotations

import logging
import math
import re
from collections import Counter, defaultdict
from typing import Any, Iterable

from django.db import transaction
from django.db.models import Exists, OuterRef, Q, QuerySet

from core.models import CalendarEvent, EventInvite, EventRsvp, ResearchInterest, Thread, User
from core.services import ai
from core.services import ai_harness as harness
from core.services import research_picture as picture
from core.services.rbac import ADMIN_ROLES, CLAIMANT_ROLES
from core.social import initials, photo_url

logger = logging.getLogger("core.events")

#: The most common topics the record holds; the only topics an event can be given.
TOPIC_LIMIT = 120
#: Topics an event is about, at most.
PICK_LIMIT = 6
#: A word has to be this long to tell two subjects apart.
MIN_WORD = 4
#: A word on more than this share of the candidate topics says little about which subject an event is.
COMMON_WORD_SHARE = 0.08
#: With fewer candidate topics than this, no word is common enough to drop a topic over.
COMMON_MIN_TOPICS = 13
#: A topic keeps its place only if it scores at least this share of the best topic's score.
BEST_SHARE = 0.5
#: How many topics a reason names before it says how many more there are.
REASON_TOPICS = 2
#: How long a model's choice of topics for one event text is kept.
TOPIC_TTL = 60 * 60

#: Words that say nothing about a subject, including what events are called.
STOPWORDS = frozenset({
    "about", "above", "across", "after", "again", "against", "along", "also", "among", "another", "around",
    "because", "been", "before", "being", "below", "between", "both", "call", "could", "conference",
    "during", "each", "event", "every", "from", "further", "general", "given", "have", "here", "into", "its",
    "just", "lecture", "like", "meeting", "more", "most", "much", "must", "next", "only", "other", "over",
    "paper", "papers", "programme", "program", "research", "session", "same", "should", "since", "some",
    "study", "studies", "such", "talk", "than", "that", "their", "them", "then", "there", "these", "they",
    "this", "those", "through", "topic", "topics", "under", "until", "upon", "very", "want", "welcome", "what",
    "when", "where", "which", "while", "will", "with", "within", "without", "workshop", "would", "your",
})

_WORD = re.compile(r"[^\W\d_]+")

_AUDIENCE_RULES = (
    "You name the research topics an event is about. The data holds the event's kind, title and speaker, "
    "its description (which may be empty), and the topics the college's own record holds, one per line.\n"
    f"Choose up to {PICK_LIMIT} topics from that list that the event is about, best first. Use only names from "
    "the list, exactly as written there. If none fits, return an empty list. Do not write a topic that is not "
    "in the list, and do not mention money, links or people's contact details."
)


def _text_of(event: CalendarEvent) -> str:
    return " ".join(part for part in (event.title, event.description, event.speaker) if part)


def _singular(word: str) -> str:
    """The singular of a plural, the simple way: "cells" is "cell", "class" stays "class"."""
    return word[:-1] if len(word) > 4 and word.endswith("s") and not word.endswith("ss") else word


def _meaning(text: str | None) -> set[str]:
    """The singular words of `text` that can tell two subjects apart: long enough, and not a stopword."""
    words = {w for w in _WORD.findall((text or "").casefold()) if len(w) >= MIN_WORD and w not in STOPWORDS}
    return {_singular(w) for w in words} - STOPWORDS


def candidate_topics(college: picture._College) -> list[dict[str, Any]]:
    """The topics the college writes on most, by the number of papers, most common first."""
    count: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    for p in college.pubs.values():
        keys = {picture._fold(t) for t in p["topics"]}
        for t in p["topics"]:
            spelled.setdefault(picture._fold(t), t)
        count.update(keys)
    ranked = sorted(count, key=lambda k: (-count[k], spelled[k].casefold()))[:TOPIC_LIMIT]
    return [{"name": spelled[k], "papers": count[k]} for k in ranked]


def candidate_guard(names: Iterable[str]) -> harness.Guard:
    """Keep only topic names the record holds: a model may choose among them, never add to them."""
    return harness.grounded_ids(sorted(set(names)), keys=("name",))


AUDIENCE = harness.register(harness.Feature(
    name="events.audience",
    model="fast",
    system=_AUDIENCE_RULES,
    schema=harness.Obj({
        "topics": harness.Arr(
            harness.Obj({"name": harness.Str(300, min_len=1)}),
            max_items=PICK_LIMIT, drop_invalid=True, required=False, default=[],
        ),
    }, from_list="topics"),
    limits=harness.Limits(timeout=30, reasks=1, transient_retries=1, ttl=TOPIC_TTL),
    temperature=0.2,
))


def _ai_topics(event: CalendarEvent, viewer: User, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The model's choice, grounded to the record's topic names. Empty when it gave nothing usable."""
    names = [c["name"] for c in candidates]
    blocks = [
        harness.DataBlock("the event", "\n".join(filter(None, [
            f"Kind: {event.get_kind_display()}", f"Title: {event.title}",
            f"Speaker: {event.speaker}" if event.speaker else "",
        ]))),
        harness.DataBlock("the event's description", event.description or "(none)"),
        harness.DataBlock("the topics on record", "\n".join(names)),
    ]
    got = AUDIENCE.run(user=viewer, data_blocks=blocks, cache_key=harness.AUTO, guards=[candidate_guard(names)])
    if not got.ok:
        logger.info("event_audience_counted code=%s", got.code)
        return []
    by_name = {c["name"]: c for c in candidates}
    picked: list[dict[str, Any]] = []
    for row in got.data.get("topics") or []:
        c = by_name.get(row.get("name"))
        if c and c not in picked:
            picked.append(c)
    return picked[:PICK_LIMIT]


def _counted_topics(event: CalendarEvent, candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Topics that share a meaningful word with the event's text, the rarest shared words counting most.

    A word most candidates share ("materials", "energy") says little about which
    subject an event is, so each shared word counts for how rare it is among the
    candidates. Once there are enough candidates, a topic sharing only common words
    is no match, and so is one scoring under BEST_SHARE of the best topic's score.
    Ties keep the candidates' order, by paper count.
    """
    words = _meaning(_text_of(event))
    topic_words = [_meaning(c["name"]) for c in candidates]
    n = len(candidates)
    df: Counter[str] = Counter()
    for ws in topic_words:
        df.update(ws)
    scored: list[tuple[float, dict[str, Any]]] = []
    for c, ws in zip(candidates, topic_words):
        shared = ws & words
        if not shared:
            continue
        if n >= COMMON_MIN_TOPICS and all(df[w] / n > COMMON_WORD_SHARE for w in shared):
            continue
        scored.append((sum(math.log((n + 1) / (df[w] + 0.5)) for w in shared), c))
    scored.sort(key=lambda s: (-s[0], -s[1]["papers"]))
    best = scored[0][0] if scored else 0.0
    return [c for s, c in scored if s >= BEST_SHARE * best][:PICK_LIMIT]


def _who_can_see(event: CalendarEvent, people: QuerySet) -> QuerySet:
    """`people` narrowed to those the Events page shows this event to (`calendar._visible_events`)."""
    if event.visibility == Thread.Visibility.PUBLIC:
        return people
    if event.visibility == Thread.Visibility.DEPARTMENT:
        dept = (event.department or "").strip()
        same_dept = Q(department__iexact=dept) if dept else Q(pk__in=[])
        return people.filter(Q(role__in=ADMIN_ROLES) | same_dept)
    return people.none()


def _candidates(event: CalendarEvent) -> QuerySet:
    """Active people who file papers, other than whoever posted the event, who may see it."""
    pool = User.objects.filter(active=True, role__in=CLAIMANT_ROLES).exclude(pk=event.created_by_id)
    return _who_can_see(event, pool).order_by("name", "id")


def _listing(names: list[str]) -> str:
    if len(names) <= 1:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def _named(names: list[str]) -> str:
    """At most REASON_TOPICS names, then how many more: "A", "A and B", "A, B and 2 more"."""
    if len(names) <= REASON_TOPICS:
        return _listing(names)
    return f"{', '.join(names[:REASON_TOPICS])} and {len(names) - REASON_TOPICS} more"


def _why(papers: int, paper_topics: list[str], interest_topics: list[str]) -> str:
    parts = []
    if papers:
        parts.append(f"{picture._plural(papers, 'paper')} on {_named(paper_topics)}")
    if interest_topics:
        if len(interest_topics) == 1:
            parts.append(f"Lists {_named(interest_topics)} as a research area")
        else:
            parts.append(f"Lists {_named(interest_topics)} as research areas")
    return ". ".join(parts)


def _people(event: CalendarEvent, college: picture._College, topics: list[dict[str, Any]],
            department: str | None, q: str | None) -> list[dict[str, Any]]:
    """Everyone with a paper or an interest on one of `topics`, best match first, filtered as asked."""
    chosen = [t["name"] for t in topics]
    folded = {picture._fold(n): n for n in chosen}
    if not folded:
        return []
    papers_on: Counter[str] = Counter()
    topics_on: dict[str, Counter[str]] = defaultdict(Counter)
    for p in college.pubs.values():
        matched = p["keys"] & set(folded)
        if not matched:
            continue
        for uid in p["members"]:
            papers_on[uid] += 1
            topics_on[uid].update(matched)
    interests: dict[str, set[str]] = defaultdict(set)
    for uid, domain in ResearchInterest.objects.values_list("user_id", "domain"):
        if picture._fold(domain) in folded:
            interests[uid].add(picture._fold(domain))

    needle = (q or "").strip().casefold()
    rows = []
    for u in _candidates(event):
        if department is not None and (u.department or "") != department:
            continue
        if needle and needle not in (u.name or "").casefold():
            continue
        n_papers = papers_on.get(u.id, 0)
        mine = interests.get(u.id, set())
        score = n_papers + len(mine)
        if score <= 0:
            continue
        on_topics = topics_on.get(u.id, Counter())
        paper_names = [folded[k] for k in folded if on_topics.get(k)]
        interest_names = [folded[k] for k in folded if k in mine]
        rows.append({"user": u, "score": score, "why": _why(n_papers, paper_names, interest_names)})
    rows.sort(key=lambda r: (-r["score"], (r["user"].name or "").casefold(), r["user"].id))
    return rows


def suggest(event: CalendarEvent, viewer: User, *, department: str | None = None, q: str | None = None,
            limit: int = 50) -> dict[str, Any]:
    """The topics an event is about, and the people to find for them. Counted when AI is off or cannot answer."""
    college = picture.shared_college()
    candidates = candidate_topics(college)
    ai_on = ai.available(fast=True)
    picked = _ai_topics(event, viewer, candidates) if ai_on else []
    counted = not picked
    if counted:
        picked = _counted_topics(event, candidates)
    rows = _people(event, college, picked, department, q)
    shown = rows[:max(0, limit)]
    ids = [r["user"].id for r in shown]
    going = set(EventRsvp.objects.filter(event=event, user_id__in=ids).values_list("user_id", flat=True))
    invited = set(EventInvite.objects.filter(event=event, user_id__in=ids).values_list("user_id", flat=True))
    people = []
    for r in shown:
        u = r["user"]
        status = "going" if u.id in going else "invited" if u.id in invited else "none"
        people.append({
            "id": u.id, "name": u.name, "department": u.department, "designation": u.designation,
            "photo_url": photo_url(u), "initials": initials(u.name), "why": r["why"],
            "score": r["score"], "papers_on_topic": r["score"], "status": status,
        })
    return {
        "event_id": event.id,
        "topics": [{"name": t["name"], "papers": t["papers"]} for t in picked],
        "ai": ai_on,
        "counted": counted,
        "people": people,
        "total": len(rows),
    }


def invite(event: CalendarEvent, inviter: User, user_ids: Iterable[str], note: str = "") -> tuple[dict[str, int], list[User]]:
    """Ask these people to the event. Returns the counts, and the people newly asked (to be told once each).

    A person already asked, an unknown or closed account, somebody who may not
    see the event, and the person asking are all skipped, not invited.
    """
    wanted = list(dict.fromkeys(user_ids))
    valid = list(_who_can_see(event, User.objects.filter(active=True, id__in=wanted).exclude(pk=inviter.pk)))
    have = set(EventInvite.objects.filter(event=event, user__in=valid).values_list("user_id", flat=True))
    created: list[User] = []
    with transaction.atomic():
        for u in valid:
            if u.id in have:
                continue
            _, made = EventInvite.objects.get_or_create(
                event=event, user=u, defaults={"invited_by": inviter, "note": note},
            )
            if made:
                created.append(u)
    counts = {
        "invited": len(created),
        "already": len(valid) - len(created),
        "skipped": len(wanted) - len(valid),
    }
    return counts, created


def invitees(event: CalendarEvent) -> dict[str, Any]:
    """Who has been asked to the event, and how many of them are going."""
    going = EventRsvp.objects.filter(event=event, user_id=OuterRef("user_id"))
    rows = list(
        EventInvite.objects.filter(event=event)
        .select_related("user", "invited_by")
        .annotate(going=Exists(going))
        .order_by("user__name", "user_id")
    )
    people = [
        {
            "id": r.user.id, "name": r.user.name, "department": r.user.department,
            "photo_url": photo_url(r.user), "initials": initials(r.user.name),
            "invited_at": r.created_at.isoformat(),
            "invited_by_name": r.invited_by.name if r.invited_by_id else None,
            "going": bool(r.going),
        }
        for r in rows
    ]
    return {"people": people, "counts": {"invited": len(people), "going": sum(p["going"] for p in people)}}
