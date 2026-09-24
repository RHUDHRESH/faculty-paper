"""What a profile carries beyond the record: skills, pinned papers, collaborations,
and -- for its owner alone -- how complete it is and how far their posts reach.

The privacy line this module holds: statistics are about the person reading
them and nobody else. `profile_extras` returns `completeness` and `stats` only
when the reader is the person, and there is no endpoint that takes somebody
else's id and answers with their numbers. Who visited a profile is recorded so
the count is of people rather than page loads, and is never shown to anybody.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from typing import Any

from django.db.models import Count
from django.utils import timezone

from core import social, social_notify, social_rank
from core.models import (
    Collaboration,
    Endorsement,
    FeedComment,
    FeedPost,
    FeedReaction,
    Follow,
    PinnedPaper,
    PostView,
    ProfileVisit,
    Skill,
    User,
)

#: How many papers a person may pin.
MAX_PINS = 3
#: How many skills a person may list; past a dozen or two a list of skills
#: stops saying what somebody is good at.
MAX_SKILLS = 20
STATS_DAYS = 30


def record_visit(person: User, viewer: User) -> None:
    """Count this visit, once per viewer per day -- unless it is your own page or you opted out."""
    if person.pk == viewer.pk or not social_notify.counts_visits(viewer):
        return
    ProfileVisit.objects.bulk_create(
        [ProfileVisit(profile=person, viewer=viewer, day=timezone.localdate())],
        ignore_conflicts=True,
    )


def coauthor_ids(person: User) -> set[str]:
    found = social_rank.coauthors_by_claim(social.published_papers(person).only(
        "id", "owner_id", "doi", "paper_title"
    ))
    return {u.id for users in found.values() for u in users}


# ------------------------------------------------------------------ sections --


def skills_of(person: User, viewer: User) -> list[dict[str, Any]]:
    skills = list(
        Skill.objects.filter(user=person).annotate(n=Count("endorsements")).order_by("-n", "name")
    )
    if not skills:
        return []
    near = coauthor_ids(person)
    by_skill: dict[str, list[User]] = defaultdict(list)
    for e in (
        Endorsement.objects.filter(skill__in=skills, endorser__active=True)
        .select_related("endorser").order_by("created_at")
    ):
        by_skill[e.skill_id].append(e.endorser)
    out = []
    for s in skills:
        people = by_skill.get(s.id, [])
        # Co-authors first: somebody who has written with you knows what you can do.
        people.sort(key=lambda u: (u.id not in near, u.name or ""))
        out.append({
            "id": s.id,
            "name": s.name,
            "count": len(people),
            "coauthor_count": sum(1 for u in people if u.id in near),
            "endorsed_by_me": any(u.id == viewer.id for u in people),
            "endorsers": [
                {**social.person_brief(u), "coauthor": u.id in near} for u in people[:5]
            ],
            "may_endorse": viewer.id != person.id,
        })
    out.sort(key=lambda r: (-r["count"], -r["coauthor_count"], r["name"].lower()))
    return out


def pinned_of(person: User) -> list[dict[str, Any]]:
    from core.api.social import paper_card

    pins = list(
        PinnedPaper.objects.filter(user=person)
        .exclude(claim__status__in=social.NOT_PUBLISHED)
        .select_related("claim").order_by("position", "created_at")
    )
    claims = [p.claim for p in pins]
    coauthors = social_rank.coauthors_by_claim(claims)
    return [paper_card(c, coauthors.get(c.id, [])) for c in claims]


def collaborations_of(person: User, viewer: User) -> list[dict[str, Any]]:
    rows = (
        Collaboration.objects.filter(members=person, ended_at__isnull=True)
        .prefetch_related("members").order_by("-created_at")
    )
    out = []
    for c in rows:
        members = [m for m in c.members.all() if m.active]
        out.append({
            "id": c.id,
            "topic": c.topic,
            "journal": c.journal or None,
            "since": c.created_at.isoformat(),
            "with": [social.person_brief(m) for m in members if m.id != person.id],
            "may_end": any(m.id == viewer.id for m in members),
        })
    return out


def profile_extras(person: User, viewer: User) -> dict[str, Any]:
    is_me = person.pk == viewer.pk
    return {
        "skills": skills_of(person, viewer),
        "pinned": pinned_of(person),
        "collaborations": collaborations_of(person, viewer),
        "completeness": social_rank.completeness(person) if is_me else None,
        "stats": stats_summary(person) if is_me else None,
    }


# --------------------------------------------------------------------- stats --


def _excerpt(post: FeedPost) -> str:
    text = " ".join((post.body or "").split())
    if not text and post.paper_id and post.paper:
        text = post.paper.paper_title or ""
    return text if len(text) <= 120 else f"{text[:117]}…"


def stats_for(user: User) -> dict[str, Any]:
    """Everything the owner's stats page shows. Counts only -- never who."""
    now = timezone.now()
    since = now - timedelta(days=STATS_DAYS)
    today = timezone.localdate()
    first_day = today - timedelta(days=STATS_DAYS - 1)

    visits = ProfileVisit.objects.filter(profile=user, day__gte=first_day)
    per_day = dict(visits.values_list("day").annotate(n=Count("id")).values_list("day", "n"))
    views_by_day = [
        {"day": (first_day + timedelta(days=i)).isoformat(), "count": per_day.get(first_day + timedelta(days=i), 0)}
        for i in range(STATS_DAYS)
    ]

    posts = list(FeedPost.objects.filter(author=user).select_related("paper").order_by("-created_at"))
    ids = [p.id for p in posts]
    reach = dict(PostView.objects.filter(post_id__in=ids).values_list("post").annotate(n=Count("id")))
    reactions = dict(
        FeedReaction.objects.filter(post_id__in=ids).exclude(user=user)
        .values_list("post").annotate(n=Count("id"))
    )
    comments = dict(
        FeedComment.objects.filter(post_id__in=ids).exclude(author=user)
        .values_list("post").annotate(n=Count("id"))
    )
    engagers: dict[str, set[str]] = defaultdict(set)
    for pid, uid in FeedReaction.objects.filter(post_id__in=ids).exclude(user=user).values_list("post", "user"):
        engagers[pid].add(uid)
    for pid, uid in (
        FeedComment.objects.filter(post_id__in=ids, author__isnull=False).exclude(author=user)
        .values_list("post", "author")
    ):
        engagers[pid].add(uid)
    by_kind = dict(
        FeedReaction.objects.filter(post_id__in=ids).exclude(user=user)
        .values_list("kind").annotate(n=Count("id"))
    )

    rows = []
    for p in posts:
        r = reach.get(p.id, 0)
        engaged = len(engagers.get(p.id, ()))
        rows.append({
            "id": p.id,
            "excerpt": _excerpt(p) or "A post",
            "created_at": p.created_at.isoformat(),
            "visibility": p.visibility,
            "reach": r,
            "reactions": reactions.get(p.id, 0),
            "comments": comments.get(p.id, 0),
            "engaged": engaged,
            "engagement_rate": round(engaged / r, 3) if r else None,
        })
    top = sorted(
        rows,
        key=lambda x: (-(x["reactions"] + x["comments"]), -x["reach"], x["created_at"]),
    )[:5]

    total_reach = sum(reach.values())
    total_engaged = sum(len(s) for s in engagers.values())
    recent = [p for p in posts if p.created_at >= since]
    return {
        "days": STATS_DAYS,
        "followers": Follow.objects.filter(person=user).count(),
        "following": Follow.objects.filter(follower=user, person__isnull=False).count(),
        "new_followers_30d": Follow.objects.filter(person=user, created_at__gte=since).count(),
        "profile_views_30d": visits.values("viewer").distinct().count(),
        "profile_visits_30d": visits.count(),
        "views_by_day": views_by_day,
        "posts": {
            "count": len(posts),
            "count_30d": len(recent),
            "reach": total_reach,
            "reach_30d": sum(reach.get(p.id, 0) for p in recent),
            "reactions": sum(reactions.values()),
            "reactions_by_kind": {k: by_kind.get(k, 0) for k in FeedReaction.Kind.values},
            "comments": sum(comments.values()),
            "engagement_rate": round(total_engaged / total_reach, 3) if total_reach else None,
        },
        "top_posts": top,
        # Said on the page, so nobody wonders whether their visitors are listed somewhere.
        "privacy": "Only you see these numbers. Nobody is shown who visited their profile.",
    }


def stats_summary(user: User) -> dict[str, Any]:
    """The small card on your own profile."""
    full = stats_for(user)
    return {
        "followers": full["followers"],
        "following": full["following"],
        "profile_views_30d": full["profile_views_30d"],
        "reach_30d": full["posts"]["reach_30d"],
        "engagement_rate": full["posts"]["engagement_rate"],
    }
