"""profiles, the feed, following and moderation.

The college's own small social network: anybody signed in can open anybody's
profile, post to the feed, comment, like, mention, follow a colleague or a
department, and report a post to the super admin, who can hide it.

Who sees what is decided in `core.social`, not here. Every endpoint that
touches a post fetches it through `social.visible_posts`, and a post the
reader may not see answers 404 -- a 403 would confirm it exists.

No endpoint here returns money, a ticket number, or where a paper is in the
chain. That is by construction, not by the renderer's stripping.
"""

from __future__ import annotations

import json
import re
import uuid as uuid_lib
from collections import defaultdict
from datetime import datetime, timedelta
from datetime import timezone as dt_timezone
from typing import Any, Optional

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db import transaction
from django.db.models import Count, Exists, F, OuterRef, Q, Subquery, Window
from django.db.models.functions import Coalesce, RowNumber
from django.http import HttpRequest
from django.utils import timezone
from ninja import File, Form, Schema, UploadedFile
from ninja.errors import HttpError

from core import social, social_notify, social_rank
from core.api.auth import may_set_field
from core.api.common import api, rate_limit_for, require_user, session_auth
from core.models import (
    AuditLog,
    Claim,
    FeedComment,
    FeedPost,
    FeedReaction,
    Follow,
    Notification,
    PostReport,
    PostView,
    ResearchInterest,
    Role,
    Skill,
    User,
)
from core.services import rbac
from core.services.images import NotAPicture, reencode
from core.services.uploads import PDF, sniff

#: Long enough for a paragraph and a list, short enough that the feed stays a
#: feed and not a place to paste a paper.
POST_MAX_CHARS = 5000
COMMENT_MAX_CHARS = 2000
REASON_MAX_CHARS = 500
#: The same cap the claim uploads use.
UPLOAD_MAX_BYTES = 10 * 1024 * 1024
#: A profile photo is shown at 32-96px; stored at a little over twice the
#: largest so it is sharp on a dense screen and still a few tens of KB.
PHOTO_SIDE = 320
#: The widest a picture is shown in the feed, at twice the density.
FEED_PICTURE_SIDE = 1600
#: What a post's page and a profile show before "load more".
FEED_PAGE = 20

ROLE_LABEL = {
    Role.FACULTY: "Faculty",
    Role.HOD: "Head of department",
    Role.PRINCIPAL: "Principal",
    Role.DIRECTOR: "Director",
    Role.FINANCE: "Finance",
    Role.RESEARCH_CELL: "Research cell",
    Role.RESEARCH_COORDINATOR: "Research coordinator",
    Role.SUPER_ADMIN: "Administrator",
}


# ------------------------------------------------------------------ helpers --


def _stored_name(folder: str, content: bytes, extension: str) -> str:
    """Saved through the storage API, so it lands in the database on production."""
    name = f"{folder}/{uuid_lib.uuid4().hex}.{extension}"
    return default_storage.save(name, ContentFile(content))


def _forget(name: Optional[str]) -> None:
    if name:
        try:
            default_storage.delete(name)
        except Exception:  # noqa: BLE001 -- a stale file must not block the change
            pass


def _notify(user_id: str, kind: str, title: str, body: str | None, href: str) -> None:
    """Through the one door, so the person's switch for this kind is always honoured."""
    social_notify.notify(user_id, kind, title, body, href)


def _tell(user_id: str, title: str, body: str | None, href: str) -> None:
    """Moderation, which is not a social notification and cannot be switched off:
    an author is always told their post was hidden, and the super admin always
    hears of a report."""
    Notification.objects.create(user_id=user_id, title=title[:255], body=(body or "")[:300], href=href)


def _excerpt(text: str) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= 160 else f"{flat[:157]}…"


def _post_href(post_id: str) -> str:
    return f"/discussions/p/{post_id}"


# --------------------------------------------------------------- serialising --


REACTION_KINDS = tuple(FeedReaction.Kind.values)


def _annotated(qs, viewer: User):
    comments = (
        FeedComment.objects.filter(post=OuterRef("pk")).order_by()
        .values("post").annotate(n=Count("id")).values("n")
    )
    counts = {}
    mine = {}
    for kind in REACTION_KINDS:
        counts[f"r_{kind.lower()}"] = Coalesce(
            Subquery(
                FeedReaction.objects.filter(post=OuterRef("pk"), kind=kind).order_by()
                .values("post").annotate(n=Count("id")).values("n")
            ),
            0,
        )
        mine[f"m_{kind.lower()}"] = Exists(
            FeedReaction.objects.filter(post=OuterRef("pk"), user=viewer, kind=kind)
        )
    return qs.select_related("author", "paper").annotate(
        comment_count=Coalesce(Subquery(comments), 0),
        reported_by_me=Exists(
            PostReport.objects.filter(
                post=OuterRef("pk"), reporter=viewer, status=PostReport.Status.OPEN
            )
        ),
        **counts,
        **mine,
    )


def _reactions(p: FeedPost) -> dict[str, int]:
    return {kind: int(getattr(p, f"r_{kind.lower()}", 0) or 0) for kind in REACTION_KINDS}


def _my_reactions(p: FeedPost) -> list[str]:
    return [kind for kind in REACTION_KINDS if getattr(p, f"m_{kind.lower()}", False)]


def paper_card(c, coauthors: list[User] | None) -> dict[str, Any]:
    """A paper as a post shows it: what it is and who here wrote it -- never what it paid."""
    return {
        "id": c.id,
        "title": c.paper_title or "Untitled",
        "journal_title": c.journal_title,
        "publication_year": c.publication_year,
        "quartile": c.quartile,
        "doi": c.doi,
        "coauthors": [{"id": u.id, "name": u.name} for u in (coauthors or [])],
    }


def _paper_brief(post: FeedPost) -> dict[str, Any] | None:
    c = post.paper
    # A paper later withdrawn or refused stops being shown, rather than
    # standing in the feed as work the college never accepted.
    if c is None or c.status in social.NOT_PUBLISHED:
        return None
    coauthors = getattr(post, "_coauthors", None)
    if coauthors is None:
        coauthors = social_rank.coauthors_by_claim([c]).get(c.id, [])
    return paper_card(c, coauthors)


def _with_coauthors(posts: list[FeedPost]) -> None:
    """Work out every paper card's co-authors for a page of posts at once."""
    papers = [p.paper for p in posts if p.paper_id and p.paper and p.paper.status not in social.NOT_PUBLISHED]
    found = social_rank.coauthors_by_claim(papers)
    for p in posts:
        if p.paper_id:
            p._coauthors = found.get(p.paper_id, [])


def record_views(posts: list[FeedPost], viewer: User) -> None:
    """Reach: each post that reached somebody other than its author, once per person."""
    others = [p for p in posts if p.author_id != viewer.id and not str(p.id).startswith("temp")]
    if not others or not social_notify.counts_visits(viewer):
        return
    PostView.objects.bulk_create(
        [PostView(post_id=p.id, viewer=viewer) for p in others], ignore_conflicts=True
    )


def _attachment(post: FeedPost) -> dict[str, Any] | None:
    if not post.attachment_name:
        return None
    return {
        "url": f"{settings.MEDIA_URL}{post.attachment_name}",
        "kind": post.attachment_kind,
        "name": post.attachment_label,
        "size": post.attachment_size,
    }


def _comment_dict(c: FeedComment, viewer: User, post_author_id: str) -> dict[str, Any]:
    mine = c.author_id is not None and c.author_id == viewer.id
    return {
        "id": c.id,
        "post_id": c.post_id,
        "author": social.person_brief(c.author),
        "kind": c.kind,
        "body": c.body,
        "mentions": json.loads(c.mentions_json or "[]"),
        "created_at": c.created_at.isoformat(),
        "edited_at": c.edited_at.isoformat() if c.edited_at else None,
        "may_edit": mine,
        # The author of a post keeps their own thread tidy; the super admin
        # moderates everywhere.
        "may_delete": mine or post_author_id == viewer.id or social.is_moderator(viewer),
    }


def _post_dict(p: FeedPost, viewer: User, *, comments=None, preview=None) -> dict[str, Any]:
    mine = p.author_id == viewer.id
    moderator = social.is_moderator(viewer)
    hidden = p.hidden_at is not None
    out = {
        "id": p.id,
        "author": social.person_brief(p.author),
        "body": p.body,
        "mentions": json.loads(p.mentions_json or "[]"),
        "visibility": p.visibility,
        "department": p.department,
        "link_url": p.link_url,
        "paper": _paper_brief(p),
        "attachment": _attachment(p),
        "created_at": p.created_at.isoformat(),
        "edited_at": p.edited_at.isoformat() if p.edited_at else None,
        "like_count": _reactions(p)["LIKE"],
        "liked": bool(getattr(p, "m_like", False)),
        "reactions": _reactions(p),
        "my_reactions": _my_reactions(p),
        "comment_count": getattr(p, "comment_count", 0),
        "comments_preview": preview or [],
        "hidden": hidden,
        # Why, to the one person it happened to and the one who did it.
        "hidden_reason": p.hidden_reason if hidden and (mine or moderator) else None,
        "reported_by_me": bool(getattr(p, "reported_by_me", False)),
        "may_edit": mine,
        "may_delete": mine,
        "may_moderate": moderator,
        "legacy_thread_id": p.legacy_thread_id,
    }
    if comments is not None:
        out["comments"] = comments
    return out


def _previews(posts: list[FeedPost], viewer: User) -> dict[str, list[dict[str, Any]]]:
    """The two newest comments under each post, oldest first, in one query."""
    if not posts:
        return {}
    authors = {p.id: p.author_id for p in posts}
    rows = (
        FeedComment.objects.filter(post_id__in=list(authors))
        .select_related("author")
        .annotate(
            rank=Window(
                RowNumber(),
                partition_by=[F("post_id")],
                order_by=[F("created_at").desc(), F("id").desc()],
            )
        )
        .filter(rank__lte=2)
    )
    grouped: dict[str, list[FeedComment]] = defaultdict(list)
    for c in rows:
        grouped[c.post_id].append(c)
    return {
        pid: [
            _comment_dict(c, viewer, authors[pid])
            for c in sorted(cs, key=lambda c: (c.created_at, c.id))
        ]
        for pid, cs in grouped.items()
    }


_EPOCH = datetime(1970, 1, 1, tzinfo=dt_timezone.utc)


def _cursor_for(post: FeedPost) -> str:
    """Where the next page starts, as whole microseconds and an id.

    Integers rather than an ISO timestamp: the `+` in "+00:00" arrives as a
    space once it has been through a query string, and a page marker that
    only works when the client remembered to escape it is a broken one.
    """
    micros = (post.created_at - _EPOCH) // timedelta(microseconds=1)
    return f"{micros}.{post.id}"


def _page(qs, viewer: User, *, limit: int, cursor: Optional[str]) -> dict[str, Any]:
    """Newest first, by keyset rather than offset, so a post written while
    somebody scrolls does not push the next page back onto the one they read."""
    limit = max(1, min(int(limit), 50))
    qs = qs.order_by("-created_at", "-id")
    if cursor:
        micros, _, last_id = cursor.partition(".")
        try:
            at = _EPOCH + timedelta(microseconds=int(micros))
        except (ValueError, OverflowError):
            raise HttpError(400, "That page marker is not one this feed handed out.") from None
        qs = qs.filter(Q(created_at__lt=at) | Q(created_at=at, id__lt=last_id))
    rows = list(_annotated(qs, viewer)[: limit + 1])
    more = len(rows) > limit
    rows = rows[:limit]
    previews = _previews(rows, viewer)
    _with_coauthors(rows)
    record_views(rows, viewer)
    return {
        "results": [_post_dict(p, viewer, preview=previews.get(p.id)) for p in rows],
        "next": _cursor_for(rows[-1]) if more and rows else None,
    }


def _readable(viewer: User, post_id: str) -> FeedPost:
    post = _annotated(social.visible_posts(viewer).filter(pk=post_id), viewer).first()
    if post is None:
        raise HttpError(404, "No such post")
    return post


def _fresh(viewer: User, post_id: str, **kwargs) -> dict[str, Any]:
    post = _readable(viewer, post_id)
    return _post_dict(post, viewer, **kwargs)


# ------------------------------------------------------------------ profiles --


def _person_dict(u: User) -> dict[str, Any]:
    scopus = (u.scopus_author_url or "").strip()
    if not scopus and u.scopus_author_id:
        from core.services.scopus import author_profile_url

        scopus = author_profile_url(u.scopus_author_id) or ""
    return {
        **social.person_brief(u),
        "role_label": ROLE_LABEL.get(u.role, "Staff"),
        "bio": u.bio or None,
        "interests": list(
            ResearchInterest.objects.filter(user=u).order_by("domain").values_list("domain", flat=True)
        ),
        "scopus_url": scopus or None,
        "orcid_id": u.orcid_id or None,
        "orcid_url": f"https://orcid.org/{u.orcid_id}" if u.orcid_id else None,
        # A badge, and nothing more, for anybody who is not setting it.
        "research_faculty": u.faculty_type == "RESEARCH",
    }


def _research_post(person: User, viewer: User) -> dict[str, Any] | None:
    """The research-faculty setting, for the two kinds of reader who have a use for it.

    The person themself sees how far into their quota they are, because the
    quota decides which of their papers carry no remuneration. The research
    coordinator and the super admin see the setting and may change it
    (`may_set_field`). Everybody else sees the badge on `person` and no more:
    the quota is a term of somebody's pay.
    """
    if person.role not in rbac.CLAIMANT_ROLES:
        return None
    editor = may_set_field(viewer.role, "faculty_type")
    if not editor and not (viewer.id == person.id and person.faculty_type == "RESEARCH"):
        return None
    year = timezone.now().year
    quota = person.research_quota or 0
    used = 0
    if person.faculty_type == "RESEARCH" and quota:
        used = (
            Claim.objects.filter(
                owner=person, publication_year=year,
                quota_position__isnull=False, quota_position__lte=quota,
            )
            .exclude(status__in=social.NOT_PUBLISHED)
            .count()
        )
    return {
        "research_faculty": person.faculty_type == "RESEARCH",
        "quota": person.research_quota,
        # `note` is a money key to the head-of-department renderer; this one is
        # the coordinator's note about the agreement, so it travels under its
        # own name.
        "quota_note": person.research_quota_note,
        "year": year,
        "used": used,
        "may_edit": editor,
    }


def _people_qs(viewer: User):
    published = (
        Claim.objects.filter(owner=OuterRef("pk")).exclude(status__in=social.NOT_PUBLISHED)
        .order_by().values("owner").annotate(n=Count("id")).values("n")
    )
    return User.objects.filter(active=True).annotate(
        paper_count=Coalesce(Subquery(published), 0),
        followed=Exists(Follow.objects.filter(follower=viewer, person=OuterRef("pk"))),
        completeness=social_rank.completeness_score_expr(),
    )


def _card(u: User) -> dict[str, Any]:
    interests = [i.domain for i in u.research_interests.all()][:3]
    return {
        **social.person_brief(u),
        "interests": interests,
        "skills": [s.name for s in u.skills.all()][:3],
        "papers": getattr(u, "paper_count", 0),
        "following": bool(getattr(u, "followed", False)),
    }


@api.get("/people", auth=session_auth)
def search_people(
    request: HttpRequest,
    q: str = "",
    department: str = "",
    interest: str = "",
    skill: str = "",
    limit: int = 24,
    offset: int = 0,
):
    """Colleagues by name, department, designation, research interest or skill.

    A fuller profile comes first: it is the one a colleague can actually
    decide from, and the order says so without hiding anybody.
    """
    viewer = require_user(request)
    qs = _people_qs(viewer)
    text = q.strip()
    if text:
        qs = qs.filter(
            Q(name__icontains=text)
            | Q(department__icontains=text)
            | Q(designation__icontains=text)
            | Q(research_interests__domain__icontains=text)
            | Q(skills__name__icontains=text)
        )
    if department.strip():
        qs = qs.filter(department__iexact=department.strip())
    if interest.strip():
        qs = qs.filter(research_interests__domain__iexact=interest.strip())
    if skill.strip():
        qs = qs.filter(skills__name__iexact=skill.strip())
    qs = qs.distinct().order_by("-completeness", "name")

    limit = max(1, min(int(limit), 60))
    offset = max(0, int(offset))
    total = qs.count()
    rows = list(qs.prefetch_related("research_interests", "skills")[offset : offset + limit])
    return {"total": total, "limit": limit, "offset": offset, "results": [_card(u) for u in rows]}


@api.get("/people/{user_id}", auth=session_auth)
def person_profile(request: HttpRequest, user_id: str):
    """One person's public profile: who they are, their own work, and their posts."""
    viewer = require_user(request)
    person = viewer if user_id == "me" else User.objects.filter(pk=user_id, active=True).first()
    if person is None:
        raise HttpError(404, "No such person")

    posts = _annotated(social.visible_posts(viewer).filter(author=person), viewer).order_by(
        "-created_at", "-id"
    )[:5]
    posts = list(posts)
    previews = _previews(posts, viewer)
    _with_coauthors(posts)
    record_views(posts, viewer)

    from core.social_profile import profile_extras, record_visit

    record_visit(person, viewer)

    may_open_record = rbac.can_view_reports(viewer.role) or (
        viewer.role == Role.HOD
        and (viewer.department or "").strip().lower() == (person.department or "").strip().lower()
    )

    return {
        "person": _person_dict(person),
        "is_me": person.id == viewer.id,
        **social.research_record(person),
        "follow": {
            "following": Follow.objects.filter(follower=viewer, person=person).exists(),
            "followers": Follow.objects.filter(person=person).count(),
            "following_count": Follow.objects.filter(follower=person, person__isnull=False).count(),
        },
        "posts": [_post_dict(p, viewer, preview=previews.get(p.id)) for p in posts],
        "research_post": _research_post(person, viewer),
        "may_open_record": bool(may_open_record) and person.id != viewer.id,
        # Skills, pinned papers, collaborations -- and, for the owner alone,
        # the completeness meter and their statistics.
        **profile_extras(person, viewer),
    }


@api.post("/people/me/photo", auth=session_auth)
def set_my_photo(request: HttpRequest, file: UploadedFile = File(...)):
    """A profile photo, made small and stripped of camera metadata before anyone sees it."""
    user = require_user(request)
    content = file.read()
    if not content:
        raise HttpError(400, "That file is empty.")
    if len(content) > UPLOAD_MAX_BYTES:
        raise HttpError(400, "That photo is over 10 MB. A smaller copy will look the same here.")
    try:
        data, kind = reencode(content, max_side=PHOTO_SIDE, square=True)
    except NotAPicture as exc:
        raise HttpError(400, str(exc)) from exc

    old = user.photo
    user.photo = _stored_name("avatars", data, kind.extension)
    user.save(update_fields=["photo", "updated_at"])
    _forget(old)
    return {"photo_url": social.photo_url(user)}


@api.delete("/people/me/photo", auth=session_auth)
def remove_my_photo(request: HttpRequest):
    user = require_user(request)
    old = user.photo
    if old:
        user.photo = None
        user.save(update_fields=["photo", "updated_at"])
        _forget(old)
    return {"photo_url": None}


# ------------------------------------------------------------------ follows --


class FollowDepartmentIn(Schema):
    department: str


def _follow_counts(person: User) -> int:
    return Follow.objects.filter(person=person).count()


@api.get("/follows", auth=session_auth)
def my_follows(request: HttpRequest):
    viewer = require_user(request)
    rows = Follow.objects.filter(follower=viewer).select_related("person").order_by("created_at")
    return {
        "people": [social.person_brief(f.person) for f in rows if f.person_id and f.person.active],
        "departments": [f.department for f in rows if f.department],
        "topics": [f.topic for f in rows if f.topic],
        "journals": [f.journal for f in rows if f.journal],
    }


@api.post("/follows/people/{user_id}", auth=session_auth)
def follow_person(request: HttpRequest, user_id: str):
    viewer = require_user(request)
    person = User.objects.filter(pk=user_id, active=True).first()
    if person is None:
        raise HttpError(404, "No such person")
    if person.id == viewer.id:
        raise HttpError(400, "You already see everything you post.")
    _, created = Follow.objects.get_or_create(follower=viewer, person=person)
    if created:
        _notify(person.id, "follow", f"{viewer.name} started following you", None, f"/u/{viewer.id}")
    return {"following": True, "followers": _follow_counts(person)}


@api.delete("/follows/people/{user_id}", auth=session_auth)
def unfollow_person(request: HttpRequest, user_id: str):
    viewer = require_user(request)
    person = User.objects.filter(pk=user_id).first()
    if person is None:
        raise HttpError(404, "No such person")
    Follow.objects.filter(follower=viewer, person=person).delete()
    return {"following": False, "followers": _follow_counts(person)}


@api.post("/follows/departments", auth=session_auth)
def follow_department(request: HttpRequest, payload: FollowDepartmentIn):
    viewer = require_user(request)
    wanted = (payload.department or "").strip()
    # Spelt the way the college files people, so a follow always matches.
    name = (
        User.objects.filter(department__iexact=wanted, active=True)
        .values_list("department", flat=True)
        .first()
        if wanted
        else None
    )
    if not name:
        raise HttpError(404, "Nobody here is in a department by that name.")
    if not Follow.objects.filter(follower=viewer, department__iexact=name).exists():
        Follow.objects.create(follower=viewer, department=name)
    return {"following": True, "department": name}


@api.delete("/follows/departments", auth=session_auth)
def unfollow_department(request: HttpRequest, department: str = ""):
    viewer = require_user(request)
    Follow.objects.filter(follower=viewer, department__iexact=department.strip()).delete()
    return {"following": False, "department": department.strip()}


# --------------------------------------------------------------------- feed --


class PostForm(Schema):
    body: str = ""
    visibility: str = FeedPost.Visibility.EVERYONE
    link_url: Optional[str] = None
    paper_id: Optional[str] = None
    #: The people picked from the @ menu, so a namesake is never the one notified.
    mention_ids: list[str] = []


class PostEditIn(Schema):
    body: Optional[str] = None
    visibility: Optional[str] = None
    link_url: Optional[str] = None


class CommentIn(Schema):
    body: str
    mention_ids: list[str] = []


class ReasonIn(Schema):
    reason: str = ""


def _clean_link(raw: Optional[str]) -> Optional[str]:
    text = (raw or "").strip()
    if not text:
        return None
    # Only somewhere a browser goes. `javascript:` and `data:` links are how a
    # post would run code in a colleague's session when they click it.
    if not re.match(r"^https?://[^\s/]+\.[^\s]+$", text, re.IGNORECASE) or len(text) > 500:
        raise HttpError(400, "A link has to be a web address starting with http:// or https://.")
    return text


def _clean_visibility(viewer: User, raw: Optional[str]) -> str:
    value = (raw or FeedPost.Visibility.EVERYONE).strip().upper()
    if value not in FeedPost.Visibility.values:
        raise HttpError(400, "Choose who can see it: everybody, or your department.")
    if value == FeedPost.Visibility.DEPARTMENT and not (viewer.department or "").strip():
        raise HttpError(
            400,
            "Your account has no department, so there is nobody to show a department post to.",
        )
    return value


def _notify_mentions(post: FeedPost, mentions_json: str, actor: User, *, where: str,
                     text: str, skip: set[str] | None = None) -> set[str]:
    """Tell everybody named, who can read the post, once. Returns who was told."""
    told: set[str] = set()
    ids = set(social.mentioned_user_ids(mentions_json)) - {actor.id} - (skip or set())
    for person in User.objects.filter(pk__in=ids, active=True):
        # Naming somebody in a department post they cannot open must not send
        # them a notification that leads to a 404 -- or tell them it exists.
        if not social.may_read_post(person, post):
            continue
        _notify(person.id, "mention", f"{actor.name} mentioned you in {where}", _excerpt(text), _post_href(post.id))
        told.add(person.id)
    return told


@api.get("/feed", auth=session_auth)
def feed(
    request: HttpRequest,
    tab: str = "everyone",
    author: Optional[str] = None,
    cursor: Optional[str] = None,
    limit: int = FEED_PAGE,
    topic: Optional[str] = None,
    journal: Optional[str] = None,
):
    """The feed: everybody, what you follow, or your department -- optionally about one topic or journal.

    Following covers people, departments, subject areas and journals. Whatever
    the filter, it narrows `visible_posts` and never widens it: a followed
    topic cannot surface another department's private post.
    """
    viewer = require_user(request)
    qs = social.visible_posts(viewer)
    if tab == "following":
        follows = list(Follow.objects.filter(follower=viewer))
        people = [f.person_id for f in follows if f.person_id]
        departments = [f.department for f in follows if f.department]
        condition = Q(author_id__in=people) | social.any_of_departments("department", departments)
        for f in follows:
            if f.topic:
                condition |= about_topic(f.topic)
            if f.journal:
                condition |= about_journal(f.journal)
        qs = qs.filter(condition)
    elif tab == "department":
        mine = (viewer.department or "").strip()
        qs = qs.filter(department__iexact=mine) if mine else qs.none()
    elif tab != "everyone":
        raise HttpError(400, "That is not one of the feed's tabs.")
    if author:
        qs = qs.filter(author_id=author)
    if (topic or "").strip():
        qs = qs.filter(about_topic(topic.strip()))
    if (journal or "").strip():
        qs = qs.filter(about_journal(journal.strip()))
    return {"tab": tab, **_page(qs, viewer, limit=limit, cursor=cursor)}


#: Shorter than this, a topic is matched against paper subject areas only:
#: "AI" as a substring of the words is inside "said", "mail" and "html".
TOPIC_IN_WORDS_MIN = 5


def about_topic(topic: str) -> Q:
    """A post is about a subject area when its paper is filed under it, or its words name it."""
    condition = Q(paper__subjects_json__icontains=topic)
    if len(topic.strip()) >= TOPIC_IN_WORDS_MIN:
        condition |= Q(body__icontains=topic)
    return condition


def about_journal(journal: str) -> Q:
    """A post is about a journal when its paper appeared there, or it @-names it."""
    return Q(paper__journal_title__iexact=journal) | Q(mentions_json__icontains=journal)


@api.get("/feed/my-papers", auth=session_auth)
def my_shareable_papers(request: HttpRequest, q: str = ""):
    """Your own filed papers, to point a post at."""
    viewer = require_user(request)
    qs = social.published_papers(viewer).order_by("-publication_year", "-created_at")
    if q.strip():
        qs = qs.filter(Q(paper_title__icontains=q.strip()) | Q(journal_title__icontains=q.strip()))
    return {
        "results": [
            {
                "id": c.id,
                "title": c.paper_title or "Untitled",
                "journal_title": c.journal_title,
                "publication_year": c.publication_year,
                "quartile": c.quartile,
            }
            for c in qs[:30]
        ]
    }


@api.post("/feed/posts", auth=session_auth)
def create_post(request: HttpRequest, payload: Form[PostForm], file: File[UploadedFile] = None):
    """A new post: words, and optionally a link, one of your papers, or a picture or PDF."""
    viewer = require_user(request)
    rate_limit_for(viewer, "feed_post", 30, "hour", what="posting")

    body = (payload.body or "").strip()
    if len(body) > POST_MAX_CHARS:
        raise HttpError(400, f"Keep a post under {POST_MAX_CHARS} characters — this one is {len(body)}.")
    visibility = _clean_visibility(viewer, payload.visibility)
    link = _clean_link(payload.link_url)

    paper = None
    if payload.paper_id:
        paper = social.published_papers(viewer).filter(pk=payload.paper_id).first()
        if paper is None:
            raise HttpError(400, "You can point a post at a paper you have filed, and only that.")

    attachment: dict[str, Any] = {}
    if file is not None:
        content = file.read()
        if not content:
            raise HttpError(400, "That file is empty.")
        if len(content) > UPLOAD_MAX_BYTES:
            raise HttpError(400, "That file is over 10 MB.")
        if sniff(content) == PDF:
            data, kind, label = content, PDF, "file"
        else:
            try:
                data, kind = reencode(content, max_side=FEED_PICTURE_SIDE)
            except NotAPicture as exc:
                raise HttpError(400, "A post can carry a picture (PNG, JPEG, WebP, GIF) or a PDF.") from exc
            label = "image"
        attachment = {
            "attachment_name": _stored_name("feed", data, kind.extension),
            "attachment_kind": label,
            "attachment_label": (file.name or f"attachment.{kind.extension}")[:255],
            "attachment_size": len(data),
        }

    if not body and not paper and not attachment and not link:
        raise HttpError(400, "Write something, or add a link, a paper or a picture.")

    mentions = json.dumps(social.resolve_mentions(body, payload.mention_ids))
    post = FeedPost.objects.create(
        author=viewer,
        body=body,
        visibility=visibility,
        department=(viewer.department or "").strip() or None,
        link_url=link,
        paper=paper,
        mentions_json=mentions,
        **attachment,
    )
    _notify_mentions(post, mentions, viewer, where="a post", text=body)
    return _fresh(viewer, post.id, comments=[])


@api.get("/feed/posts/{post_id}", auth=session_auth)
def get_post(request: HttpRequest, post_id: str):
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    comments = [
        _comment_dict(c, viewer, post.author_id)
        for c in post.comments.select_related("author").order_by("created_at", "id")
    ]
    record_views([post], viewer)
    return _post_dict(post, viewer, comments=comments)


@api.patch("/feed/posts/{post_id}", auth=session_auth)
def edit_post(request: HttpRequest, post_id: str, payload: PostEditIn):
    """Your own words, and only yours. An edit is marked, never silent."""
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    if post.author_id != viewer.id:
        raise HttpError(403, "You can only edit your own posts.")

    data = payload.dict(exclude_unset=True)
    fields = ["edited_at"]
    if "body" in data:
        body = (data["body"] or "").strip()
        if len(body) > POST_MAX_CHARS:
            raise HttpError(400, f"Keep a post under {POST_MAX_CHARS} characters.")
        if not body and not post.paper_id and not post.attachment_name and not post.link_url:
            raise HttpError(400, "A post cannot be emptied — delete it instead.")
        before = set(social.mentioned_user_ids(post.mentions_json))
        post.body = body
        post.mentions_json = json.dumps(social.resolve_mentions(body))
        fields += ["body", "mentions_json"]
    if "visibility" in data and data["visibility"]:
        post.visibility = _clean_visibility(viewer, data["visibility"])
        post.department = (viewer.department or "").strip() or None
        fields += ["visibility", "department"]
    if "link_url" in data:
        post.link_url = _clean_link(data["link_url"])
        fields += ["link_url"]
    post.edited_at = timezone.now()
    post.save(update_fields=fields)
    if "body" in data:
        # Somebody newly named in an edit is told; nobody is told twice.
        _notify_mentions(post, post.mentions_json, viewer, where="a post", text=post.body, skip=before)
    return _fresh(viewer, post.id)


@api.delete("/feed/posts/{post_id}", auth=session_auth)
def delete_post(request: HttpRequest, post_id: str):
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    if post.author_id != viewer.id:
        raise HttpError(403, "You can only delete your own posts.")
    name = post.attachment_name
    AuditLog.objects.create(
        actor=viewer, action="FEED_POST_DELETE", entity="FeedPost", entity_id=post.id,
        detail_json=json.dumps({"comments": post.comment_count}),
    )
    post.delete()
    _forget(name)
    return {"ok": True}


@api.post("/feed/posts/{post_id}/like", auth=session_auth)
def like_post(request: HttpRequest, post_id: str):
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    FeedReaction.objects.get_or_create(post=post, user=viewer, kind=FeedReaction.Kind.LIKE)
    return {"liked": True, "like_count": post.reactions.filter(kind=FeedReaction.Kind.LIKE).count()}


@api.delete("/feed/posts/{post_id}/like", auth=session_auth)
def unlike_post(request: HttpRequest, post_id: str):
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    FeedReaction.objects.filter(post=post, user=viewer, kind=FeedReaction.Kind.LIKE).delete()
    return {"liked": False, "like_count": post.reactions.filter(kind=FeedReaction.Kind.LIKE).count()}


@api.get("/feed/posts/{post_id}/comments", auth=session_auth)
def list_comments(request: HttpRequest, post_id: str):
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    return {
        "results": [
            _comment_dict(c, viewer, post.author_id)
            for c in post.comments.select_related("author").order_by("created_at", "id")
        ]
    }


@api.post("/feed/posts/{post_id}/comments", auth=session_auth)
def add_comment(request: HttpRequest, post_id: str, payload: CommentIn):
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    rate_limit_for(viewer, "feed_comment", 120, "hour", what="commenting")
    body = (payload.body or "").strip()
    if not body:
        raise HttpError(400, "Say something.")
    if len(body) > COMMENT_MAX_CHARS:
        raise HttpError(400, f"Keep a comment under {COMMENT_MAX_CHARS} characters.")

    mentions = json.dumps(social.resolve_mentions(body, payload.mention_ids))
    with transaction.atomic():
        comment = FeedComment.objects.create(post=post, author=viewer, body=body, mentions_json=mentions)

    told = _notify_mentions(post, mentions, viewer, where="a comment", text=body)
    if post.author_id != viewer.id and post.author_id not in told and post.author.active:
        _notify(post.author_id, "comment", f"{viewer.name} commented on your post", _excerpt(body), _post_href(post.id))
    comment.author = viewer
    return _comment_dict(comment, viewer, post.author_id)


def _own_comment(viewer: User, comment_id: str) -> tuple[FeedComment, FeedPost]:
    comment = FeedComment.objects.select_related("author").filter(pk=comment_id).first()
    if comment is None:
        raise HttpError(404, "No such comment")
    post = _readable(viewer, comment.post_id)
    return comment, post


@api.patch("/feed/comments/{comment_id}", auth=session_auth)
def edit_comment(request: HttpRequest, comment_id: str, payload: CommentIn):
    viewer = require_user(request)
    comment, post = _own_comment(viewer, comment_id)
    if comment.author_id != viewer.id:
        raise HttpError(403, "You can only edit your own comments.")
    body = (payload.body or "").strip()
    if not body:
        raise HttpError(400, "A comment cannot be emptied — delete it instead.")
    if len(body) > COMMENT_MAX_CHARS:
        raise HttpError(400, f"Keep a comment under {COMMENT_MAX_CHARS} characters.")
    comment.body = body
    comment.mentions_json = json.dumps(social.resolve_mentions(body, payload.mention_ids))
    comment.edited_at = timezone.now()
    comment.save(update_fields=["body", "mentions_json", "edited_at"])
    return _comment_dict(comment, viewer, post.author_id)


@api.delete("/feed/comments/{comment_id}", auth=session_auth)
def delete_comment(request: HttpRequest, comment_id: str):
    viewer = require_user(request)
    comment, post = _own_comment(viewer, comment_id)
    if not _comment_dict(comment, viewer, post.author_id)["may_delete"]:
        raise HttpError(403, "You can delete your own comments, or comments on your own post.")
    comment.delete()
    return {"ok": True}


# --------------------------------------------------------------- moderation --


def _require_moderator(viewer: User) -> None:
    if not social.is_moderator(viewer):
        raise HttpError(403, "Only the super admin moderates the feed.")


@api.post("/feed/posts/{post_id}/report", auth=session_auth)
def report_post(request: HttpRequest, post_id: str, payload: ReasonIn):
    viewer = require_user(request)
    post = _readable(viewer, post_id)
    if post.author_id == viewer.id:
        raise HttpError(400, "That is your own post — edit or delete it instead.")
    reason = (payload.reason or "").strip()[:REASON_MAX_CHARS] or "No reason given"
    _, created = PostReport.objects.get_or_create(
        post=post, reporter=viewer, status=PostReport.Status.OPEN, defaults={"reason": reason}
    )
    if created:
        for admin_id in User.objects.filter(role=Role.SUPER_ADMIN, active=True).values_list("id", flat=True):
            _tell(admin_id, "A post was reported", _excerpt(reason), "/discussions?tab=reported")
    return {"ok": True, "reported": True}


@api.get("/feed/reports", auth=session_auth)
def open_reports(request: HttpRequest):
    viewer = require_user(request)
    _require_moderator(viewer)
    reports = list(
        PostReport.objects.filter(status=PostReport.Status.OPEN)
        .select_related("reporter")
        .order_by("created_at")
    )
    posts = {
        p.id: p
        for p in _annotated(FeedPost.objects.filter(pk__in={r.post_id for r in reports}), viewer)
    }
    return {
        "results": [
            {
                "id": r.id,
                "reason": r.reason,
                "created_at": r.created_at.isoformat(),
                "reporter": social.person_brief(r.reporter),
                "post": _post_dict(posts[r.post_id], viewer),
            }
            for r in reports
            if r.post_id in posts
        ]
    }


@api.post("/feed/posts/{post_id}/hide", auth=session_auth)
def hide_post(request: HttpRequest, post_id: str, payload: ReasonIn):
    viewer = require_user(request)
    _require_moderator(viewer)
    post = _readable(viewer, post_id)
    reason = (payload.reason or "").strip()[:300] or "Hidden by the administrator"
    now = timezone.now()
    with transaction.atomic():
        FeedPost.objects.filter(pk=post.pk).update(hidden_at=now, hidden_by=viewer, hidden_reason=reason)
        PostReport.objects.filter(post=post, status=PostReport.Status.OPEN).update(
            status=PostReport.Status.HIDDEN, resolved_at=now, resolved_by=viewer
        )
        AuditLog.objects.create(
            actor=viewer, action="FEED_POST_HIDE", entity="FeedPost", entity_id=post.id,
            detail_json=json.dumps({"reason": reason}),
        )
    if post.author_id != viewer.id:
        _tell(post.author_id, "Your post was hidden by the administrator", reason, _post_href(post.id))
    return _fresh(viewer, post.id)


@api.post("/feed/posts/{post_id}/unhide", auth=session_auth)
def unhide_post(request: HttpRequest, post_id: str):
    viewer = require_user(request)
    _require_moderator(viewer)
    post = _readable(viewer, post_id)
    FeedPost.objects.filter(pk=post.pk).update(hidden_at=None, hidden_by=None, hidden_reason=None)
    AuditLog.objects.create(
        actor=viewer, action="FEED_POST_UNHIDE", entity="FeedPost", entity_id=post.id,
        detail_json="{}",
    )
    return _fresh(viewer, post.id)


@api.post("/feed/reports/{report_id}/dismiss", auth=session_auth)
def dismiss_report(request: HttpRequest, report_id: str):
    viewer = require_user(request)
    _require_moderator(viewer)
    updated = PostReport.objects.filter(pk=report_id, status=PostReport.Status.OPEN).update(
        status=PostReport.Status.DISMISSED, resolved_at=timezone.now(), resolved_by=viewer
    )
    if not updated:
        raise HttpError(404, "No open report by that id")
    return {"ok": True}


__all__ = [
    'CommentIn',
    'FollowDepartmentIn',
    'PostEditIn',
    'PostForm',
    'ReasonIn',
    'add_comment',
    'create_post',
    'delete_comment',
    'delete_post',
    'dismiss_report',
    'edit_comment',
    'edit_post',
    'feed',
    'follow_department',
    'follow_person',
    'get_post',
    'hide_post',
    'like_post',
    'list_comments',
    'my_follows',
    'my_shareable_papers',
    'open_reports',
    'person_profile',
    'remove_my_photo',
    'report_post',
    'search_people',
    'set_my_photo',
    'unfollow_department',
    'unfollow_person',
    'unhide_post',
    'unlike_post',
]
