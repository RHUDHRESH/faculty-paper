"""notifications and discussions.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, logger, rate_limit_for, session_auth
from core.api.common import require_user

import json
from typing import Any, Optional
from django.db import models, transaction
from django.db.models import Q
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from django.conf import settings
from ninja.errors import HttpError
from core.models import AuditLog, Claim, FeedPost, Mention, Post, Thread, ThreadParticipant, ThreadSubscription, User
from core.services import rbac
from core.services import thread_agent
from core import discussions, social_notify

# ---------- notifications ----------


# ---------- discussions ----------


class ThreadIn(Schema):
    title: str
    body: str
    visibility: str = "PUBLIC"
    #: DIRECT only: who is in the conversation, besides whoever opened it.
    #: This is the audience, not a notification list -- `visible_threads`
    #: reads these rows, which is what makes a direct thread private.
    participant_ids: list[str] = []
    department: Optional[str] = None
    topic: Optional[str] = None
    claim_id: Optional[str] = None
    journal_title: Optional[str] = None


class PostIn(Schema):
    body: str
    reply_to: Optional[str] = None


class PostEditIn(Schema):
    body: str


def _mention_dict(m: Mention) -> dict[str, Any]:
    return {
        "kind": m.kind,
        "label": m.label,
        "user_id": m.user_id,
        "user_name": m.user.name if m.user_id else None,
        "claim_id": m.claim_id,
        "ticket_number": m.claim.ticket_number if m.claim_id else None,
        "journal_title": m.journal_title,
        "department": m.department,
    }


def _post_dict(post: Post) -> dict[str, Any]:
    deleted = post.deleted_at is not None
    return {
        "id": post.id,
        "thread_id": post.thread_id,
        "kind": post.kind,
        # A deleted post leaves a tombstone rather than a hole: the replies
        # underneath it still have to make sense.
        "body": "" if deleted else post.body,
        "deleted": deleted,
        "author_id": post.author_id,
        "author_name": post.author.name if post.author_id else None,
        "reply_to": post.reply_to_id,
        "created_at": post.created_at.isoformat(),
        "edited_at": post.edited_at.isoformat() if post.edited_at else None,
        "mentions": [] if deleted else [_mention_dict(m) for m in post.mentions.all()],
    }


def _thread_dict(t: Thread, user: User) -> dict[str, Any]:
    return {
        "id": t.id,
        "title": t.title,
        "visibility": t.visibility,
        "department": t.department,
        "topic": t.topic,
        "claim_id": t.claim_id,
        "ticket_number": t.claim.ticket_number if t.claim_id else None,
        "journal_title": t.journal_title,
        "created_by": t.created_by.name if t.created_by_id else None,
        "created_by_id": t.created_by_id,
        "created_at": t.created_at.isoformat(),
        "last_post_at": t.last_post_at.isoformat(),
        "post_count": t.post_count,
        "resolved": t.resolved,
        "resolved_by": t.resolved_by.name if t.resolved_by_id else None,
        "locked": t.locked,
        "may_post": discussions.may_post(user, t),
        "may_moderate": discussions.may_moderate(user, t),
    }


def _write_post(thread: Thread, author: User | None, body: str, *, kind: str,
                reply_to: Post | None = None) -> Post:
    """One post, its mentions resolved, with the thread's counters moved."""
    post = Post.objects.create(
        thread=thread, author=author, body=body, kind=kind, reply_to=reply_to
    )
    for row in discussions.parse_mentions(body):
        Mention.objects.create(post=post, **row)
    Thread.objects.filter(pk=thread.pk).update(
        last_post_at=timezone.now(), post_count=models.F("post_count") + 1
    )
    thread.refresh_from_db()
    return post


def _notify_thread(thread: Thread, post: Post, actor: User) -> None:
    """Everybody mentioned, and everybody following, minus whoever wrote it.

    Mentions and subscriptions are gathered together and de-duplicated so
    being mentioned in a thread you already follow is one notification, not
    two -- and neither ever reaches the person who caused it.
    """
    recipients: set[str] = set()
    mentioned: set[str] = set()
    for m in post.mentions.filter(kind=Mention.Kind.USER).select_related("user"):
        if m.user_id and discussions.may_read(m.user, thread):
            recipients.add(m.user_id)
            mentioned.add(m.user_id)
    for sub in thread.subscriptions.select_related("user").filter(muted=False):
        if discussions.may_read(sub.user, thread):
            recipients.add(sub.user_id)
    recipients.discard(actor.id)
    if not recipients:
        return

    excerpt = (post.body or "")[:200]
    for uid in recipients:
        # Named in it, a mention; otherwise a reply in a thread they follow,
        # a comment -- so their switch for that kind holds here too.
        social_notify.notify(
            uid, "mention" if uid in mentioned else "comment",
            f"{actor.name} in “{thread.title[:80]}”", excerpt,
            f"/discussions/{thread.id}",
        )


def _subscribe(thread: Thread, user: User | None) -> None:
    if user is None:
        return
    ThreadSubscription.objects.get_or_create(thread=thread, user=user)


@api.get("/threads", auth=session_auth)
def list_threads(
    request: HttpRequest,
    q: Optional[str] = None,
    topic: Optional[str] = None,
    visibility: Optional[str] = None,
    mine: bool = False,
    unresolved: bool = False,
    limit: int = 30,
    offset: int = 0,
):
    """Threads this account may see, most recently active first."""
    user = require_user(request)
    qs = discussions.visible_threads(user).select_related("created_by", "claim")

    if q:
        qs = qs.filter(Q(title__icontains=q.strip()) | Q(posts__body__icontains=q.strip())).distinct()
    if topic:
        qs = qs.filter(topic__iexact=topic)
    if visibility:
        qs = qs.filter(visibility=visibility)
    if mine:
        qs = qs.filter(
            Q(created_by=user) | Q(subscriptions__user=user) | Q(posts__author=user)
        ).distinct()
    if unresolved:
        qs = qs.filter(resolved=False)

    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    total = qs.count()

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [_thread_dict(t, user) for t in qs[offset : offset + limit]],
        "visibilities": [
            {"key": v.value, "label": v.label} for v in Thread.Visibility
        ],
        "may_open_office": True,
    }


@api.post("/threads", auth=session_auth)
def create_thread(request: HttpRequest, payload: ThreadIn):
    """Open a thread. The first post is part of it, not a separate step."""
    user = require_user(request)
    title = (payload.title or "").strip()
    body = (payload.body or "").strip()
    if len(title) < 4:
        raise HttpError(400, "Give the thread a title somebody can recognise.")
    if not body:
        raise HttpError(400, "Say something in the first post.")

    refusal = discussions.check_visibility(
        user, payload.visibility, payload.department, payload.participant_ids
    )
    if refusal:
        raise HttpError(403 if "only" in refusal.lower() else 400, refusal)

    people: list[User] = []
    if payload.visibility == Thread.Visibility.DIRECT:
        wanted = {p for p in payload.participant_ids if p and p != user.id}
        people = list(User.objects.filter(pk__in=wanted, active=True))
        if len(people) != len(wanted):
            # Named somebody who is not here. Refused rather than quietly
            # dropped: a conversation silently missing the person it was for
            # is worse than one that failed to open.
            raise HttpError(404, "One of those people could not be found.")

    claim = None
    if payload.claim_id:
        claim = Claim.objects.filter(pk=payload.claim_id).first()
        if claim is None:
            raise HttpError(404, "No such paper")
        # Attaching a thread to somebody else's ticket would let a claimant
        # discover a paper they cannot otherwise see.
        if claim.owner_id != user.id and not rbac.can_view_reports(user.role):
            raise HttpError(403, "That paper is not yours to open a thread about.")

    with transaction.atomic():
        thread = Thread.objects.create(
            title=title,
            visibility=payload.visibility,
            department=(payload.department or "").strip() or None
            if payload.visibility == Thread.Visibility.DEPARTMENT
            else None,
            topic=(payload.topic or "").strip() or None,
            claim=claim,
            journal_title=(payload.journal_title or "").strip() or None,
            created_by=user,
            post_count=0,
        )
        if payload.visibility == Thread.Visibility.DIRECT:
            # Written inside the same transaction as the thread. A direct
            # thread that exists without its participant rows is readable by
            # nobody at all, including its author.
            ThreadParticipant.objects.bulk_create(
                [ThreadParticipant(thread=thread, user=u) for u in [user, *people]],
                ignore_conflicts=True,
            )
        post = _write_post(thread, user, body, kind=Post.Kind.HUMAN)
        _subscribe(thread, user)
        for u in people:
            _subscribe(thread, u)
        for m in post.mentions.filter(kind=Mention.Kind.USER):
            _subscribe(thread, m.user)

    _notify_thread(thread, post, user)
    _maybe_answer(thread, post, user)
    return _thread_dict(thread, user)


def _maybe_answer(thread: Thread, post: Post, asker: User) -> Post | None:
    """Let the assistant reply, if it was asked and it has something to say."""
    try:
        rate_limit_for(
            asker, "agent", settings.AGENT_DAILY_LIMIT, "day",
            what="asking the assistant",
        )
    except HttpError:
        # Over the day's cap. The post itself is already written and stands;
        # like a failing assistant, an absent one must not lose it.
        logger.info("agent_rate_limited post=%s asker=%s", post.id, asker.pk)
        return None
    try:
        text = thread_agent.answer(post, asker)
    except Exception:
        logger.exception("thread_agent_failed post=%s", post.id)
        # A failing assistant must not lose somebody's message. The post is
        # already written; this is the only part that did not happen.
        return None
    if not text:
        return None
    return _write_post(thread, None, text, kind=Post.Kind.AGENT, reply_to=post)


@api.get("/threads/{thread_id}", auth=session_auth)
def get_thread(request: HttpRequest, thread_id: str):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")

    posts = (
        thread.posts.select_related("author")
        .prefetch_related("mentions__user", "mentions__claim")
        .order_by("created_at")
    )
    subscription = ThreadSubscription.objects.filter(thread=thread, user=user).first()
    if subscription:
        subscription.last_read_at = timezone.now()
        subscription.save(update_fields=["last_read_at"])
    # A direct thread read here is read in Messages too (`api/dm.py`).
    ThreadParticipant.objects.filter(thread=thread, user=user).update(last_read_at=timezone.now())

    return {
        **_thread_dict(thread, user),
        "posts": [_post_dict(p) for p in posts],
        "following": bool(subscription and not subscription.muted),
        "followers": thread.subscriptions.count(),
        # An open thread from before the feed now lives in it as a post. Old
        # links and notifications still arrive here, and are sent on.
        "feed_post_id": FeedPost.objects.filter(legacy_thread=thread)
        .values_list("id", flat=True)
        .first(),
    }


@api.post("/threads/{thread_id}/posts", auth=session_auth)
def add_post(request: HttpRequest, thread_id: str, payload: PostIn):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")
    if thread.locked:
        raise HttpError(400, "This thread is closed to new posts.")
    body = (payload.body or "").strip()
    if not body:
        raise HttpError(400, "Say something.")

    reply_to = None
    if payload.reply_to:
        reply_to = thread.posts.filter(pk=payload.reply_to).first()

    with transaction.atomic():
        post = _write_post(thread, user, body, kind=Post.Kind.HUMAN, reply_to=reply_to)
        # Posting is taking an interest; so is being named.
        _subscribe(thread, user)
        for m in post.mentions.filter(kind=Mention.Kind.USER):
            _subscribe(thread, m.user)

    _notify_thread(thread, post, user)
    reply = _maybe_answer(thread, post, user)
    return {
        "post": _post_dict(post),
        "agent_reply": _post_dict(reply) if reply else None,
    }


@api.patch("/posts/{post_id}", auth=session_auth)
def edit_post(request: HttpRequest, post_id: str, payload: PostEditIn):
    """Your own words, and only yours. An edit is marked, never silent."""
    user = require_user(request)
    post = get_object_or_404(Post.objects.select_related("thread"), pk=post_id)
    if post.author_id != user.id:
        raise HttpError(403, "You can only edit your own posts.")
    if post.deleted_at:
        raise HttpError(400, "That post has been deleted.")
    body = (payload.body or "").strip()
    if not body:
        raise HttpError(400, "A post cannot be emptied — delete it instead.")

    with transaction.atomic():
        post.body = body
        post.edited_at = timezone.now()
        post.save(update_fields=["body", "edited_at"])
        # The mentions are part of the text, so they are rewritten with it.
        post.mentions.all().delete()
        for row in discussions.parse_mentions(body):
            Mention.objects.create(post=post, **row)

    return _post_dict(post)


@api.delete("/posts/{post_id}", auth=session_auth)
def delete_post(request: HttpRequest, post_id: str):
    user = require_user(request)
    post = get_object_or_404(Post.objects.select_related("thread"), pk=post_id)
    if post.author_id != user.id and not discussions.may_moderate(user, post.thread):
        raise HttpError(403, "You can only delete your own posts.")
    post.deleted_at = timezone.now()
    post.deleted_by = user
    post.save(update_fields=["deleted_at", "deleted_by"])
    AuditLog.objects.create(
        actor=user, action="POST_DELETE", entity="Post", entity_id=post.id,
        detail_json=json.dumps({"thread": post.thread_id}),
    )
    return {"ok": True}


@api.post("/threads/{thread_id}/subscribe", auth=session_auth)
def set_subscription(request: HttpRequest, thread_id: str, following: bool = True):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")
    sub, _ = ThreadSubscription.objects.get_or_create(thread=thread, user=user)
    # Muted rather than deleted: leaving a noisy thread should not lose the
    # record that you were in it.
    sub.muted = not following
    sub.save(update_fields=["muted"])
    return {"ok": True, "following": following}


@api.post("/threads/{thread_id}/resolve", auth=session_auth)
def resolve_thread(request: HttpRequest, thread_id: str, resolved: bool = True):
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.may_moderate(user, thread):
        raise HttpError(403, "Only the office, or whoever opened it, can close a thread.")
    thread.resolved = resolved
    thread.resolved_by = user if resolved else None
    thread.resolved_at = timezone.now() if resolved else None
    thread.save(update_fields=["resolved", "resolved_by", "resolved_at"])
    return _thread_dict(thread, user)


@api.post("/threads/{thread_id}/lock", auth=session_auth)
def lock_thread(request: HttpRequest, thread_id: str, locked: bool = True):
    """Closed to new posts, still readable. Moderation, not deletion."""
    user = require_user(request)
    thread = get_object_or_404(Thread, pk=thread_id)
    if not discussions.is_office(user.role):
        raise HttpError(403, "Only the office can lock a thread.")
    thread.locked = locked
    thread.save(update_fields=["locked"])
    AuditLog.objects.create(
        actor=user, action="THREAD_LOCK", entity="Thread", entity_id=thread.id,
        detail_json=json.dumps({"locked": locked}),
    )
    return _thread_dict(thread, user)


@api.get("/mentions/search", auth=session_auth)
def search_mentions(request: HttpRequest, q: str = "", kind: Optional[str] = None):
    """What the @ autocomplete offers, scoped to what this account may see."""
    user = require_user(request)
    return {"results": discussions.mention_candidates(user, q, kind)}




__all__ = [
    'PostEditIn',
    'PostIn',
    'ThreadIn',
    '_maybe_answer',
    '_mention_dict',
    '_notify_thread',
    '_post_dict',
    '_subscribe',
    '_thread_dict',
    '_write_post',
    'add_post',
    'create_thread',
    'delete_post',
    'edit_post',
    'get_thread',
    'list_threads',
    'lock_thread',
    'resolve_thread',
    'search_mentions',
    'set_subscription',
]
