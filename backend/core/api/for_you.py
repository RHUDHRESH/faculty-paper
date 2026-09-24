"""The "For you" tab: posts from people in your field, new papers from
colleagues, new faculty who work on what you do, and people you could write
with -- mixed, each with the one sentence that says why it is there.

Deterministic overlap scoring rather than a model: shared subject areas,
journals and skills (`social_rank.overlap`), plus what you follow and who you
have written with, decayed by age. A `seed` jitters the scores and so varies
the mix from one visit to the next; the same seed gives the same page, so a
refresh within a visit does not reshuffle what somebody was reading.

Posts come from `social.visible_posts`, so a department-only post never
reaches another department here either. Nothing returns money or a paper's
place in the chain.
"""
from __future__ import annotations

import math
import random
from datetime import timedelta
from typing import Any

from django.db.models import Count, Q
from django.http import HttpRequest
from django.utils import timezone

from core import social, social_rank
from core.api.common import api, require_user, session_auth
from core.api.social import (
    _annotated,
    _post_dict,
    _previews,
    _with_coauthors,
    about_journal,
    about_topic,
    paper_card,
    record_views,
)
from core.models import Claim, Follow, User
from core.social_profile import coauthor_ids

#: How far back each kind of item is looked for.
POST_DAYS = 60
PAPER_DAYS = 120
NEW_PERSON_DAYS = 60

#: How many of each kind a page carries at most.
TAKE = {"post": 18, "paper": 6, "person": 3, "suggestion": 4}


def _decay(created, now) -> float:
    days = max(0.0, (now - created).total_seconds() / 86400)
    return 1.0 / (1.0 + days / 14.0)


def _jitter(rng: random.Random, items: list[tuple[float, Any]]) -> list[Any]:
    """Order by score, shaken by up to a third either way -- different on each visit."""
    shaken = [(score * rng.uniform(0.7, 1.3), i, item) for i, (score, item) in enumerate(items)]
    shaken.sort(key=lambda row: (-row[0], row[1]))
    return [item for _, _, item in shaken]


def _person_card(u: User, fields: social_rank.Field, papers: int) -> dict[str, Any]:
    labels = sorted(fields.labels.values())[:3] if fields else []
    return {**social.person_brief(u), "interests": labels, "papers": papers}


@api.get("/feed/for-you", auth=session_auth)
def for_you(request: HttpRequest, seed: str = ""):
    me = require_user(request)
    rng = random.Random(f"{me.id}:{seed}")
    now = timezone.now()

    mine = social_rank.fields_of([me.id])[me.id]
    follows = list(Follow.objects.filter(follower=me))
    followed_people = {f.person_id for f in follows if f.person_id}
    followed_topics = [f.topic for f in follows if f.topic]
    followed_journals = [f.journal for f in follows if f.journal]
    near = coauthor_ids(me)

    # ---- posts from people in your field, and about what you follow
    candidates = (
        social.visible_posts(me).exclude(author=me)
        .filter(hidden_at__isnull=True, created_at__gte=now - timedelta(days=POST_DAYS))
    )
    followed_about = Q(pk__in=[])
    for t in followed_topics:
        followed_about |= about_topic(t)
    for j in followed_journals:
        followed_about |= about_journal(j)
    about_ids = set(candidates.filter(followed_about).values_list("id", flat=True)) if follows else set()
    posts = list(_annotated(candidates.order_by("-created_at", "-id"), me)[:200])
    authors = social_rank.fields_of({p.author_id for p in posts})

    scored_posts: list[tuple[float, tuple[Any, str]]] = []
    for p in posts:
        f = authors.get(p.author_id) or social_rank.Field()
        theirs = social_rank.Field(set(f.areas), set(f.journals), set(f.skills), dict(f.labels))
        if p.paper_id and p.paper and p.paper.status not in social.NOT_PUBLISHED:
            for area in social_rank.split_subjects(p.paper.subjects_json):
                theirs.areas.add(area.lower())
                theirs.labels.setdefault(area.lower(), area)
            if p.paper.journal_title:
                theirs.journals.add(p.paper.journal_title.strip().lower())
        ov = social_rank.overlap(mine, theirs)
        score, why = ov.score, ov.why
        if p.id in about_ids:
            score += 4
            why = "About something you follow"
        if p.author_id in near:
            score += 3
            why = why or "From somebody you have written with"
        if p.author_id in followed_people:
            score += 3
            why = why or "From somebody you follow"
        engagement = sum(getattr(p, f"r_{k}", 0) or 0 for k in ("like", "congrats", "interested", "collaborate"))
        engagement += getattr(p, "comment_count", 0) or 0
        if score <= 0 and engagement < 3:
            continue
        if not why:
            why = "Popular in the college this week"
        score = (score + min(3.0, engagement / 3.0)) * _decay(p.created_at, now)
        scored_posts.append((score, (p, why)))

    chosen_posts = _jitter(rng, scored_posts)[: TAKE["post"]]
    shown_posts = [p for p, _ in chosen_posts]
    previews = _previews(shown_posts, me)
    _with_coauthors(shown_posts)
    record_views(shown_posts, me)
    shown_papers = {p.paper_id for p in shown_posts if p.paper_id}

    # ---- new papers from colleagues
    recent = list(
        Claim.objects.exclude(status__in=social.NOT_PUBLISHED)
        .exclude(owner=me).exclude(pk__in=shown_papers)
        .filter(owner__active=True, created_at__gte=now - timedelta(days=PAPER_DAYS))
        .select_related("owner").order_by("-created_at")[:150]
    )
    scored_papers: list[tuple[float, tuple[Claim, str]]] = []
    for c in recent:
        areas = social_rank.split_subjects(c.subjects_json)
        theirs = social_rank.Field(
            {a.lower() for a in areas},
            {c.journal_title.strip().lower()} if c.journal_title else set(),
            set(),
            {a.lower(): a for a in areas},
        )
        ov = social_rank.overlap(mine, theirs)
        score = ov.score
        why = f"New paper in {areas[0]}" if ov.score and areas else ""
        if c.owner_id in near:
            score += 3
            why = "New from somebody you have written with"
        elif c.owner_id in followed_people:
            score += 3
            why = why or "New from somebody you follow"
        if score <= 0:
            continue
        scored_papers.append((score * _decay(c.created_at, now), (c, why or ov.why)))
    chosen_papers = _jitter(rng, scored_papers)[: TAKE["paper"]]
    paper_coauthors = social_rank.coauthors_by_claim([c for c, _ in chosen_papers])

    # ---- people: new faculty in your field, and collaborators you have not met
    everyone = {u.id: u for u in User.objects.filter(active=True).exclude(pk=me.id)}
    fields = social_rank.fields_of(everyone)
    paper_counts = dict(
        Claim.objects.exclude(status__in=social.NOT_PUBLISHED).filter(owner_id__in=list(everyone))
        .values_list("owner").annotate(n=Count("id"))
    )
    completeness = dict(
        User.objects.filter(pk__in=list(everyone))
        .annotate(done=social_rank.completeness_score_expr()).values_list("id", "done")
    )
    newcomers: list[tuple[float, tuple[User, str]]] = []
    suggestions: list[tuple[float, tuple[User, str]]] = []
    for uid, u in everyone.items():
        if uid in followed_people:
            continue
        ov = social_rank.overlap(mine, fields.get(uid) or social_rank.Field())
        if ov.score <= 0:
            continue
        # A fuller profile is easier to decide on, so it is suggested first.
        bonus = 2.0 * (completeness.get(uid, 0) / len(social_rank.PARTS))
        is_new = u.created_at >= now - timedelta(days=NEW_PERSON_DAYS) and not paper_counts.get(uid)
        if is_new:
            newcomers.append((ov.score + bonus, (u, f"New to the college. {ov.why}.")))
        elif uid not in near:
            cross = (u.department or "").strip().lower() != (me.department or "").strip().lower()
            why = f"Could be a collaborator. {ov.why}" + (f", in {u.department}" if cross and u.department else "") + "."
            suggestions.append((ov.score + bonus + (0.5 if cross else 0.0), (u, why)))
    chosen_new = _jitter(rng, newcomers)[: TAKE["person"]]
    chosen_suggestions = _jitter(rng, sorted(suggestions, key=lambda s: -s[0])[:12])[: TAKE["suggestion"]]

    # ---- the mix: mostly posts, with something else every third item
    others: list[dict[str, Any]] = []
    for c, why in chosen_papers:
        others.append({
            "kind": "paper", "why": why,
            "paper": paper_card(c, paper_coauthors.get(c.id, [])),
            "owner": social.person_brief(c.owner),
        })
    for u, why in chosen_new:
        others.append({"kind": "person", "why": why, "new": True,
                       "person": _person_card(u, fields.get(u.id), paper_counts.get(u.id, 0))})
    for u, why in chosen_suggestions:
        others.append({"kind": "person", "why": why, "new": False,
                       "person": _person_card(u, fields.get(u.id), paper_counts.get(u.id, 0))})
    rng.shuffle(others)

    items: list[dict[str, Any]] = []
    post_items = [
        {"kind": "post", "why": why, "post": _post_dict(p, me, preview=previews.get(p.id))}
        for p, why in chosen_posts
    ]
    step = 3 if post_items else 1
    while post_items or others:
        items.extend(post_items[: step - 1] if others else post_items)
        post_items = post_items[step - 1:] if others else []
        if others:
            items.append(others.pop(0))
    return {
        "seed": seed,
        "items": items,
        "explained": (
            "Chosen from the subject areas of your papers and interests, the journals you "
            "publish in, your skills, and what you follow. Nothing is paid for or promoted."
        ),
    }


__all__ = ["for_you"]
