"""Who may see a post, and what a person's public record says about them.

Both answered here rather than at each endpoint, for the reason
`core.discussions` gives: a rule spread across a dozen call sites is a rule
that is wrong at one of them.

The two rules this module exists to hold:

- **A department-only post is for that department.** Everybody signed in sees
  a post for everyone; a post for one department is seen by that department,
  by its author, and by the super admin, who moderates the feed and cannot
  moderate what they cannot see. Nobody else, by any route -- the feed, the
  post's own link, its comments, its likes, its attachment.
- **A profile is a social page, not a desk.** It lists what somebody has
  published, with the journal, year and quartile, and never an amount, a
  ticket number, or where a paper is in the chain. The same payload goes to a
  colleague, a head, the Principal and the Finance desk: seeing money is a
  permission for their queues, not for a colleague's page.
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from typing import Any, Iterable

from django.conf import settings
from django.db.models import Q, QuerySet

from core import discussions
from core.models import Claim, ClaimStatus, FeedPost, Mention, Role, User

#: A paper in any of these is not (or not yet, or no longer) somebody's work:
#: a draft is unfinished and a refused claim was refused.
NOT_PUBLISHED = (ClaimStatus.DRAFT, ClaimStatus.REJECTED)

#: The mentions a feed post keeps. A paper mention names a ticket number,
#: which is the office's handle for a claim; the assistant does not answer in
#: the feed. A post points at a paper through `FeedPost.paper` instead.
KEPT_MENTIONS = {Mention.Kind.USER, Mention.Kind.DEPARTMENT, Mention.Kind.JOURNAL}

_TITLES = re.compile(r"\b(Dr|Mr|Ms|Mrs|Miss|Prof|Er)\b\.?", re.IGNORECASE)


def is_moderator(user: User) -> bool:
    return getattr(user, "role", None) == Role.SUPER_ADMIN


# ------------------------------------------------------------------- people --


def initials(name: str | None) -> str:
    """Two letters for an avatar: the first and last real word of a name.

    College records put titles and initials anywhere ("Dr. R. Subhashini",
    "Srigitha S"), so titles are dropped and whatever words remain are used.
    """
    words = [w for w in re.split(r"[\s.,]+", _TITLES.sub(" ", name or "")) if w]
    if not words:
        return "?"
    if len(words) == 1:
        return words[0][0].upper()
    return (words[0][0] + words[-1][0]).upper()


def photo_url(user: User) -> str | None:
    return f"{settings.MEDIA_URL}{user.photo}" if user.photo else None


def person_brief(user: User | None) -> dict[str, Any] | None:
    """Enough to draw somebody's name and face, and link to their profile."""
    if user is None:
        return None
    return {
        "id": user.id,
        "name": user.name or "A colleague",
        "initials": initials(user.name),
        "photo_url": photo_url(user),
        "department": user.department or None,
        "designation": user.designation or None,
    }


def published_papers(user: User) -> QuerySet:
    return Claim.objects.filter(owner=user).exclude(status__in=NOT_PUBLISHED)


def _is_q1(quartile: str | None) -> bool:
    return (quartile or "").strip().upper() == "Q1"


def research_record(user: User) -> dict[str, Any]:
    """A person's own published work: the papers, what they add up to, who they wrote with.

    Co-authors are colleagues who filed a claim for the same paper -- the only
    co-authorship signal the system holds (`collaborate._paper_key`: the DOI
    where there is one, the normalised title where there is not).

    Carries no amount and no status: the paper list is the same for every
    reader, and the renderer that strips money for some roles is not what
    keeps it out of here -- nothing here ever puts it in.
    """
    from core.api.collaborate import _paper_key
    from core.api.dashboard import _split_subjects

    mine = list(
        published_papers(user).order_by("-publication_year", "-created_at").only(
            "id", "paper_title", "journal_title", "publication_year", "quartile", "doi",
            "author_position", "total_authors", "subjects_json", "owner_id",
        )
    )

    # Who else filed each of my papers. One pass over the published claims of
    # everybody, as `_collaboration_index` does, keyed the same way.
    my_keys = {_paper_key(c) for c in mine} - {None}
    owners_by_key: dict[tuple[str, str], set[str]] = defaultdict(set)
    if my_keys:
        for other in (
            Claim.objects.exclude(status__in=NOT_PUBLISHED)
            .exclude(owner=user)
            .only("id", "owner_id", "doi", "paper_title")
            .iterator(chunk_size=2000)
        ):
            key = _paper_key(other)
            if key in my_keys and other.owner_id:
                owners_by_key[key].add(other.owner_id)

    people = {
        u.id: u
        for u in User.objects.filter(
            pk__in={pid for ids in owners_by_key.values() for pid in ids}, active=True
        )
    }

    together: Counter[str] = Counter()
    papers = []
    areas: Counter[str] = Counter()
    for claim in mine:
        with_them = sorted(
            (people[pid] for pid in owners_by_key.get(_paper_key(claim), ()) if pid in people),
            key=lambda u: u.name or "",
        )
        together.update(u.id for u in with_them)
        for area, _q in _split_subjects(claim.subjects_json):
            areas[area] += 1
        papers.append({
            "id": claim.id,
            "title": claim.paper_title or "Untitled",
            "journal_title": claim.journal_title,
            "publication_year": claim.publication_year,
            "quartile": claim.quartile,
            "doi": claim.doi,
            "author_position": claim.author_position,
            "total_authors": claim.total_authors,
            "coauthors": [{"id": u.id, "name": u.name} for u in with_them],
        })

    coauthors = [
        {**person_brief(people[pid]), "together": n}
        for pid, n in sorted(together.items(), key=lambda kv: (-kv[1], people[kv[0]].name or ""))
    ]

    return {
        "papers": papers,
        "counts": {
            "papers": len(mine),
            "q1": sum(1 for c in mine if _is_q1(c.quartile)),
            "first_author": sum(1 for c in mine if c.author_position == 1),
            "areas": len(areas),
        },
        "areas": [{"key": a, "count": n} for a, n in areas.most_common(12)],
        "coauthors": coauthors,
    }


# --------------------------------------------------------------------- feed --


def visible_posts(user: User) -> QuerySet:
    """Every post this account may read, hidden ones included only for their author."""
    if is_moderator(user):
        return FeedPost.objects.all()

    condition = Q(visibility=FeedPost.Visibility.EVERYONE) | Q(author=user)
    department = (getattr(user, "department", "") or "").strip()
    if department:
        condition |= Q(visibility=FeedPost.Visibility.DEPARTMENT, department__iexact=department)
    return FeedPost.objects.filter(condition).filter(Q(hidden_at__isnull=True) | Q(author=user))


def may_read_post(user: User, post: FeedPost) -> bool:
    return visible_posts(user).filter(pk=post.pk).exists()


def any_of_departments(field: str, names: Iterable[str]) -> Q:
    """`field` equal to any of `names`, ignoring case -- `__in` cannot."""
    condition = Q(pk__in=[])
    for name in names:
        if name:
            condition |= Q(**{f"{field}__iexact": name})
    return condition


def resolve_mentions(body: str, chosen_ids: Iterable[str] = ()) -> list[dict[str, Any]]:
    """Every @name in a post or comment that points at something, as stored JSON rows.

    `chosen_ids` are the people picked from the @ menu. Two colleagues can
    share a name, and `parse_mentions` resolves an ambiguous name to nobody
    rather than guess -- so the person actually picked travels with the text
    and wins, provided their name really is mentioned in it.
    """
    rows: list[dict[str, Any]] = []
    named_by_id: set[str] = set()

    for user in User.objects.filter(pk__in=[i for i in chosen_ids if i], active=True):
        pattern = r"@(?:user:|person:)?\"?" + re.escape(user.name or "")
        if user.name and re.search(pattern, body or "", re.IGNORECASE):
            rows.append({
                "kind": Mention.Kind.USER, "label": user.name, "user_id": user.id,
                "user_name": user.name, "department": None, "journal_title": None,
            })
            named_by_id.add((user.name or "").lower())

    seen = {r["user_id"] for r in rows}
    for row in discussions.parse_mentions(body or ""):
        kind = row["kind"]
        if kind not in KEPT_MENTIONS:
            continue
        if kind == Mention.Kind.USER:
            user = row["user"]
            if user.id in seen or row["label"].lower() in named_by_id or not user.active:
                continue
            seen.add(user.id)
            rows.append({
                "kind": kind, "label": row["label"], "user_id": user.id,
                "user_name": user.name, "department": None, "journal_title": None,
            })
        else:
            rows.append({
                "kind": kind, "label": row["label"], "user_id": None, "user_name": None,
                "department": row.get("department"), "journal_title": row.get("journal_title"),
            })
    return rows


def mentioned_user_ids(mentions_json: str) -> list[str]:
    try:
        rows = json.loads(mentions_json or "[]")
    except ValueError:
        return []
    return [r["user_id"] for r in rows if r.get("kind") == Mention.Kind.USER and r.get("user_id")]
