"""Reactions, sharing a paper, following topics and journals, pinned papers,
skills and endorsements, a person's own statistics, their social switches,
and the collaboration graph.

The same rules as `core.api.social`, and enforced the same way: a post is
fetched through `social.visible_posts` (via `_readable`), so one the reader may
not see answers 404 whatever is asked of it; nothing here returns money, a
ticket number or where a paper is in the chain; and the statistics endpoint
has no form that takes somebody else's id.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from typing import Any, Optional

from django.db import transaction
from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core import social, social_notify, social_profile, social_rank
from core.api.common import api, rate_limit_for, require_user, session_auth
from core.api.social import _fresh, _post_href, _readable, paper_card
from core.models import (
    Claim,
    Collaboration,
    Endorsement,
    FeedReaction,
    Follow,
    PinnedPaper,
    Skill,
    SocialSettings,
    User,
)

REACTION_WORDS = {
    FeedReaction.Kind.CONGRATS: "congratulated you on your post",
    FeedReaction.Kind.INTERESTED: "is interested in your post",
    FeedReaction.Kind.COLLABORATE: "would like to collaborate on your post",
}


# ---------------------------------------------------------------- reactions --


def _kind(raw: str) -> str:
    value = (raw or "").strip().upper()
    if value not in FeedReaction.Kind.values:
        raise HttpError(400, "A reaction is a like, congrats, interested, or want to collaborate.")
    return value


def _reaction_state(viewer: User, post_id: str) -> dict[str, Any]:
    fresh = _fresh(viewer, post_id)
    return {k: fresh[k] for k in ("reactions", "my_reactions", "like_count", "liked")}


@api.post("/feed/posts/{post_id}/reactions/{kind}", auth=session_auth)
def add_reaction(request: HttpRequest, post_id: str, kind: str):
    """React to a post. The author hears about a congrats, an interest or a wish to
    collaborate -- once per person per kind, however often it is toggled."""
    viewer = require_user(request)
    kind = _kind(kind)
    post = _readable(viewer, post_id)
    rate_limit_for(viewer, "feed_reaction", 300, "hour", what="reacting")
    _, created = FeedReaction.objects.get_or_create(post=post, user=viewer, kind=kind)
    if created and kind in REACTION_WORDS and post.author_id != viewer.id and post.author.active:
        social_notify.notify(
            post.author_id, "reaction", f"{viewer.name} {REACTION_WORDS[kind]}",
            social_excerpt(post.body), _post_href(post.id), once=True,
        )
    return _reaction_state(viewer, post.id)


@api.delete("/feed/posts/{post_id}/reactions/{kind}", auth=session_auth)
def remove_reaction(request: HttpRequest, post_id: str, kind: str):
    viewer = require_user(request)
    kind = _kind(kind)
    post = _readable(viewer, post_id)
    FeedReaction.objects.filter(post=post, user=viewer, kind=kind).delete()
    return _reaction_state(viewer, post.id)


@api.get("/feed/posts/{post_id}/reactions", auth=session_auth)
def who_reacted(request: HttpRequest, post_id: str, kind: Optional[str] = None):
    """Who reacted, and how -- to anybody who can read the post."""
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    rows = FeedReaction.objects.filter(post=post, user__active=True).select_related("user")
    if kind:
        rows = rows.filter(kind=_kind(kind))
    rows = list(rows.order_by("-created_at")[:500])
    return {
        "results": [
            {"kind": r.kind, "person": social.person_brief(r.user), "at": r.created_at.isoformat()}
            for r in rows
        ],
        "counts": _reaction_state(viewer, post.id)["reactions"],
    }


def social_excerpt(text: str) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= 160 else f"{flat[:157]}…"


# ------------------------------------------------------------------ sharing --


def _share_body(claim: Claim, coauthors: list[User]) -> str:
    where = ", ".join(
        str(x) for x in (claim.journal_title, claim.publication_year) if x
    )
    line = f"New paper out: “{claim.paper_title or 'Untitled'}”"
    if where:
        line += f" in {where}"
    if claim.quartile:
        line += f" ({claim.quartile})"
    line += "."
    if coauthors:
        names = [f"@{u.name}" for u in coauthors]
        joined = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} and {names[-1]}"
        line += f"\nWritten with {joined}."
    return line


@api.get("/feed/share/{claim_id}", auth=session_auth)
def share_draft(request: HttpRequest, claim_id: str):
    """A post about one of your own papers, ready to edit: the card, and words to start from.

    Only the owner's own filed work; a draft or a refused paper is not somebody's
    published work and answers 404, as does anybody else's paper.
    """
    viewer = require_user(request)
    claim = social.published_papers(viewer).filter(pk=claim_id).first()
    if claim is None:
        raise HttpError(404, "No such paper of yours to share.")
    coauthors = social_rank.coauthors_by_claim([claim]).get(claim.id, [])
    return {
        "paper": paper_card(claim, coauthors),
        "body": _share_body(claim, coauthors),
        "mention_ids": [u.id for u in coauthors],
    }


# ---------------------------------------------------- following topics, journals --


class TopicIn(Schema):
    topic: str


class JournalIn(Schema):
    journal: str


def _clean(text: str, limit: int, what: str) -> str:
    value = " ".join((text or "").split())
    if not value:
        raise HttpError(400, f"Name the {what} to follow.")
    if len(value) > limit:
        raise HttpError(400, f"That is too long for a {what}.")
    return value


@api.post("/follows/topics", auth=session_auth)
def follow_topic(request: HttpRequest, payload: TopicIn):
    viewer = require_user(request)
    topic = _clean(payload.topic, 160, "subject area")
    if not Follow.objects.filter(follower=viewer, topic__iexact=topic).exists():
        Follow.objects.create(follower=viewer, topic=topic)
    return {"following": True, "topic": topic}


@api.delete("/follows/topics", auth=session_auth)
def unfollow_topic(request: HttpRequest, topic: str = ""):
    viewer = require_user(request)
    Follow.objects.filter(follower=viewer, topic__iexact=topic.strip()).delete()
    return {"following": False, "topic": topic.strip()}


@api.post("/follows/journals", auth=session_auth)
def follow_journal(request: HttpRequest, payload: JournalIn):
    viewer = require_user(request)
    wanted = _clean(payload.journal, 512, "journal")
    # Spelt the way the papers here spell it, when anybody has published there.
    journal = (
        Claim.objects.filter(journal_title__iexact=wanted).values_list("journal_title", flat=True).first()
        or wanted
    )
    if not Follow.objects.filter(follower=viewer, journal__iexact=journal).exists():
        Follow.objects.create(follower=viewer, journal=journal)
    return {"following": True, "journal": journal}


@api.delete("/follows/journals", auth=session_auth)
def unfollow_journal(request: HttpRequest, journal: str = ""):
    viewer = require_user(request)
    Follow.objects.filter(follower=viewer, journal__iexact=journal.strip()).delete()
    return {"following": False, "journal": journal.strip()}


# ------------------------------------------------------------------- pinning --


class PinsIn(Schema):
    paper_ids: list[str]


@api.put("/people/me/pins", auth=session_auth)
def set_my_pins(request: HttpRequest, payload: PinsIn):
    """Your best papers, first on your profile, in the order given. Up to three."""
    viewer = require_user(request)
    ids = list(dict.fromkeys(i for i in payload.paper_ids if i))
    if len(ids) > social_profile.MAX_PINS:
        raise HttpError(400, f"Pin up to {social_profile.MAX_PINS} papers.")
    owned = set(social.published_papers(viewer).filter(pk__in=ids).values_list("id", flat=True))
    if len(owned) != len(ids):
        raise HttpError(400, "You can pin your own filed papers, and only those.")
    with transaction.atomic():
        PinnedPaper.objects.filter(user=viewer).delete()
        PinnedPaper.objects.bulk_create(
            [PinnedPaper(user=viewer, claim_id=pid, position=i) for i, pid in enumerate(ids)]
        )
    return {"pinned": social_profile.pinned_of(viewer)}


# --------------------------------------------------------------------- skills --


class SkillIn(Schema):
    name: str


@api.post("/people/me/skills", auth=session_auth)
def add_my_skill(request: HttpRequest, payload: SkillIn):
    viewer = require_user(request)
    name = " ".join((payload.name or "").split())
    if len(name) < 2:
        raise HttpError(400, "Name the skill in a word or two.")
    if len(name) > 80:
        raise HttpError(400, "Keep a skill under 80 characters.")
    if Skill.objects.filter(user=viewer, name__iexact=name).exists():
        raise HttpError(400, f"{name} is already on your profile.")
    if Skill.objects.filter(user=viewer).count() >= social_profile.MAX_SKILLS:
        raise HttpError(400, f"List up to {social_profile.MAX_SKILLS} skills — remove one to add another.")
    skill = Skill.objects.create(user=viewer, name=name)
    return {"id": skill.id, "name": skill.name, "count": 0, "coauthor_count": 0,
            "endorsed_by_me": False, "endorsers": [], "may_endorse": False}


@api.delete("/people/me/skills/{skill_id}", auth=session_auth)
def remove_my_skill(request: HttpRequest, skill_id: str):
    viewer = require_user(request)
    deleted, _ = Skill.objects.filter(pk=skill_id, user=viewer).delete()
    if not deleted:
        raise HttpError(404, "No such skill on your profile.")
    return {"ok": True}


def _endorsable(skill_id: str) -> Skill:
    skill = Skill.objects.select_related("user").filter(pk=skill_id, user__active=True).first()
    if skill is None:
        raise HttpError(404, "No such skill")
    return skill


@api.post("/skills/{skill_id}/endorse", auth=session_auth)
def endorse_skill(request: HttpRequest, skill_id: str):
    viewer = require_user(request)
    skill = _endorsable(skill_id)
    if skill.user_id == viewer.id:
        raise HttpError(400, "Colleagues endorse your skills; you cannot endorse your own.")
    rate_limit_for(viewer, "endorse", 100, "hour", what="endorsing")
    _, created = Endorsement.objects.get_or_create(skill=skill, endorser=viewer)
    if created:
        social_notify.notify(
            skill.user_id, "endorsement", f"{viewer.name} endorsed you for {skill.name}",
            None, f"/u/{skill.user_id}", once=True,
        )
    return {"endorsed": True, "count": skill.endorsements.count()}


@api.delete("/skills/{skill_id}/endorse", auth=session_auth)
def unendorse_skill(request: HttpRequest, skill_id: str):
    viewer = require_user(request)
    skill = _endorsable(skill_id)
    Endorsement.objects.filter(skill=skill, endorser=viewer).delete()
    return {"endorsed": False, "count": skill.endorsements.count()}


# ---------------------------------------------------------------------- stats --


@api.get("/people/me/stats", auth=session_auth)
def my_stats(request: HttpRequest):
    """Your followers, profile views, reach and engagement. Only ever your own."""
    return social_profile.stats_for(require_user(request))


# ------------------------------------------------------------------- settings --


class SocialSettingsIn(Schema):
    muted: Optional[list[str]] = None
    count_my_visits: Optional[bool] = None


def _settings_dict(user: User) -> dict[str, Any]:
    found = social_notify.settings_for(user)
    muted = social_notify.muted_kinds(user)
    return {
        "notifications": [
            {"kind": k, "label": label, "on": k not in muted} for k, label in social_notify.KINDS.items()
        ],
        "count_my_visits": found.count_my_visits,
    }


@api.get("/people/me/social-settings", auth=session_auth)
def my_social_settings(request: HttpRequest):
    return _settings_dict(require_user(request))


@api.put("/people/me/social-settings", auth=session_auth)
def set_my_social_settings(request: HttpRequest, payload: SocialSettingsIn):
    """Switch a kind of social notification off or on, and choose whether your visits are counted."""
    viewer = require_user(request)
    row, _ = SocialSettings.objects.get_or_create(user=viewer)
    if payload.muted is not None:
        unknown = set(payload.muted) - set(social_notify.KINDS)
        if unknown:
            raise HttpError(400, f"Not a kind of notification: {', '.join(sorted(unknown))}.")
        row.muted_json = json.dumps(sorted(set(payload.muted)))
    if payload.count_my_visits is not None:
        row.count_my_visits = payload.count_my_visits
    row.save()
    return _settings_dict(viewer)


# ---------------------------------------------------------------------- graph --


def _coauthor_partners() -> tuple[dict[str, dict[str, int]], dict[str, int]]:
    from core.api.collaborate import _collaboration_index

    scope = Claim.objects.exclude(status__in=social.NOT_PUBLISHED)
    partners, _journals, papers = _collaboration_index(scope)
    return partners, papers


def _collab_pairs() -> dict[tuple[str, str], str]:
    """Every pair in an active collaboration, with its topic."""
    pairs: dict[tuple[str, str], str] = {}
    for c in Collaboration.objects.filter(ended_at__isnull=True).prefetch_related("members"):
        ids = sorted(m.id for m in c.members.all())
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                pairs.setdefault((a, b), c.topic)
    return pairs


def _node(u: User, papers: dict[str, int], degree: int, **extra) -> dict[str, Any]:
    return {**social.person_brief(u), "papers": papers.get(u.id, 0), "degree": degree, **extra}


def _links(people: set[str], partners, collabs) -> list[dict[str, Any]]:
    out = []
    seen: set[tuple[str, str]] = set()
    for a in people:
        for b, n in partners.get(a, {}).items():
            pair = (a, b) if a < b else (b, a)
            if b in people and pair not in seen:
                seen.add(pair)
                out.append({"source": pair[0], "target": pair[1], "papers": n, "kind": "coauthor"})
    for (a, b), topic in collabs.items():
        if a in people and b in people:
            out.append({"source": a, "target": b, "papers": 0, "kind": "collab", "topic": topic})
    return out


@api.get("/people/{user_id}/graph", auth=session_auth)
def person_graph(request: HttpRequest, user_id: str):
    """One person's network in the college: who they wrote with, who they are collaborating
    with, and how those people are connected to each other."""
    viewer = require_user(request)
    person = viewer if user_id == "me" else User.objects.filter(pk=user_id, active=True).first()
    if person is None:
        raise HttpError(404, "No such person")
    partners, papers = _coauthor_partners()
    collabs = _collab_pairs()
    near = set(partners.get(person.id, {}))
    near |= {b for (a, b) in collabs if a == person.id} | {a for (a, b) in collabs if b == person.id}
    users = {u.id: u for u in User.objects.filter(pk__in=near | {person.id}, active=True)}
    ids = set(users)
    links = _links(ids, partners, collabs)
    degree: dict[str, int] = defaultdict(int)
    for l in links:
        degree[l["source"]] += 1
        degree[l["target"]] += 1
    return {
        "center": person.id,
        "nodes": [_node(u, papers, degree[u.id], center=u.id == person.id) for u in users.values()],
        "links": links,
    }


@api.get("/network", auth=session_auth)
def college_network(request: HttpRequest, department: Optional[str] = None, limit: int = 300):
    """Everybody in the college who has written with, or is collaborating with, a colleague.

    Capped at the best-connected few hundred, and says how many it left out.
    """
    require_user(request)
    partners, papers = _coauthor_partners()
    collabs = _collab_pairs()
    connected: dict[str, int] = defaultdict(int)
    for a, row in partners.items():
        connected[a] += len(row)
    for a, b in collabs:
        connected[a] += 1
        connected[b] += 1
    users = {u.id: u for u in User.objects.filter(pk__in=list(connected), active=True)}
    if (department or "").strip():
        wanted = department.strip().lower()
        users = {i: u for i, u in users.items() if (u.department or "").strip().lower() == wanted}
    ranked = sorted(users, key=lambda i: (-connected[i], users[i].name or ""))
    shown = set(ranked[: max(1, min(int(limit), 600))])
    links = _links(shown, partners, collabs)
    degree: dict[str, int] = defaultdict(int)
    for l in links:
        degree[l["source"]] += 1
        degree[l["target"]] += 1
    keep = {i for i in shown if degree[i] > 0}
    return {
        "nodes": [_node(users[i], papers, degree[i]) for i in keep],
        "links": [l for l in links if l["source"] in keep and l["target"] in keep],
        "department": (department or "").strip() or None,
        "hidden": max(0, len(users) - len(shown)),
        "departments": sorted({(u.department or "").strip() for u in users.values() if u.department}),
    }


__all__ = [
    "JournalIn",
    "PinsIn",
    "SkillIn",
    "SocialSettingsIn",
    "TopicIn",
    "add_my_skill",
    "add_reaction",
    "college_network",
    "endorse_skill",
    "follow_journal",
    "follow_topic",
    "my_social_settings",
    "my_stats",
    "person_graph",
    "remove_my_skill",
    "remove_reaction",
    "set_my_pins",
    "set_my_social_settings",
    "share_draft",
    "unendorse_skill",
    "unfollow_journal",
    "unfollow_topic",
    "who_reacted",
]
