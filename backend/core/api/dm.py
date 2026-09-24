"""Direct messages: one-to-one and small-group chats, with read receipts and
collaboration requests.

Built on the private conversations that already existed -- a `Thread` with
DIRECT visibility, its audience in `ThreadParticipant`, its messages in
`Post` -- so a chat and an old direct thread are the same thing seen two ways.
`discussions.visible_threads` already makes a DIRECT thread readable by the
people in it and nobody else, the office included; every endpoint here goes
through `_conversation`, which asks exactly that, and answers 404 otherwise.

What this adds is what a chat needs and a thread did not: unread counts,
"seen" (`ThreadParticipant.last_read_at`, moved only when the reader actually
has the conversation open), a one-to-one conversation that is found again
rather than opened twice, and a collaboration request that travels as a card
in the conversation and, when accepted, becomes a `Collaboration` on both
profiles.
"""
from __future__ import annotations

from typing import Any, Optional

from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q, Subquery
from django.http import HttpRequest
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core import social, social_notify
from core.api.common import api, rate_limit_for, require_user, session_auth
from core.api.discussions import _write_post
from core.models import (
    Collaboration,
    CollaborationRequest,
    Notification,
    Post,
    Thread,
    ThreadParticipant,
    User,
)

ONE_TO_ONE_TITLE = "Direct message"
MESSAGE_MAX_CHARS = 4000
#: The same ceiling `discussions.check_visibility` puts on a direct thread.
MAX_OTHERS = 20
#: How much of a conversation one read returns. A chat is read from the
#: bottom; older history is a scroll nobody makes on a phone.
HISTORY = 200


def _href(thread_id: str) -> str:
    return f"/messages/c/{thread_id}"


def _mine(user: User):
    return Thread.objects.filter(
        visibility=Thread.Visibility.DIRECT,
    ).filter(Exists(ThreadParticipant.objects.filter(thread=OuterRef("pk"), user=user)))


def _conversation(user: User, thread_id: str) -> Thread:
    thread = _mine(user).filter(pk=thread_id).first()
    if thread is None:
        raise HttpError(404, "No such conversation")
    return thread


def _participants(thread: Thread) -> list[ThreadParticipant]:
    return list(thread.participants.select_related("user").order_by("added_at", "id"))


def _title(thread: Thread, parts: list[ThreadParticipant], viewer: User) -> str:
    others = [p.user for p in parts if p.user_id != viewer.id]
    if len(parts) <= 2:
        return others[0].name if others else "Just you"
    if thread.title and thread.title != ONE_TO_ONE_TITLE:
        return thread.title
    names = [u.name.split()[0] if u.name else "A colleague" for u in others]
    return ", ".join(names[:3]) + (f" and {len(names) - 3} more" if len(names) > 3 else "")


def _collab_dict(req: CollaborationRequest, viewer: User) -> dict[str, Any]:
    open_states = (CollaborationRequest.State.PENDING, CollaborationRequest.State.CALL)
    collaboration = getattr(req, "collaboration", None) if req.state == CollaborationRequest.State.ACCEPTED else None
    return {
        "id": req.id,
        "topic": req.topic,
        "journal": req.journal or None,
        "message": req.message or None,
        # "state", not "status": a status on anything a colleague sees reads as
        # a ticket's place in the chain, and nothing here is one.
        "state": req.state,
        "response_note": req.response_note or None,
        "responded_at": req.responded_at.isoformat() if req.responded_at else None,
        "sender": social.person_brief(req.sender),
        "recipient": social.person_brief(req.recipient),
        "may_respond": viewer.id == req.recipient_id and req.state in open_states,
        "collaboration_id": collaboration.id if collaboration else None,
    }


def _message(post: Post, viewer: User, collab: CollaborationRequest | None = None) -> dict[str, Any]:
    deleted = post.deleted_at is not None
    return {
        "id": post.id,
        "author": social.person_brief(post.author) if post.author_id else None,
        "kind": post.kind,
        "body": "" if deleted else post.body,
        "deleted": deleted,
        "created_at": post.created_at.isoformat(),
        "mine": post.author_id == viewer.id,
        "collab": _collab_dict(collab, viewer) if collab else None,
    }


def _mark_read(thread: Thread, user: User) -> None:
    now = timezone.now()
    ThreadParticipant.objects.filter(thread=thread, user=user).update(last_read_at=now)
    # The bell should not still be ringing about a conversation that is open.
    Notification.objects.filter(user=user, href=_href(thread.id), read=False).update(read=True)


def _conversation_dict(thread: Thread, viewer: User) -> dict[str, Any]:
    parts = _participants(thread)
    posts = list(
        thread.posts.select_related("author").order_by("-created_at", "-id")[:HISTORY]
    )[::-1]
    cards = {
        r.post_id: r
        for r in CollaborationRequest.objects.filter(post__in=posts)
        .select_related("sender", "recipient", "collaboration")
    }
    return {
        "id": thread.id,
        "is_group": len(parts) > 2,
        "title": _title(thread, parts, viewer),
        "people": [social.person_brief(p.user) for p in parts if p.user_id != viewer.id],
        "participants": [
            {
                **social.person_brief(p.user),
                "me": p.user_id == viewer.id,
                "last_read_at": p.last_read_at.isoformat() if p.last_read_at else None,
            }
            for p in parts
        ],
        "messages": [_message(p, viewer, cards.get(p.id)) for p in posts],
        "may_post": not thread.locked,
    }


def _unread(user: User, thread_ids: list[str]) -> dict[str, int]:
    """Messages from somebody else since this person last had each conversation open."""
    if not thread_ids:
        return {}
    marks = dict(
        ThreadParticipant.objects.filter(user=user, thread_id__in=thread_ids)
        .values_list("thread_id", "last_read_at")
    )
    condition = Q(pk__in=[])
    for tid, at in marks.items():
        condition |= Q(thread_id=tid, created_at__gt=at) if at else Q(thread_id=tid)
    rows = (
        Post.objects.filter(condition, deleted_at__isnull=True)
        .exclude(author=user)
        .values("thread_id").annotate(n=Count("id")).values_list("thread_id", "n")
    )
    return dict(rows)


def _one_to_one(me: User, other: User) -> Thread | None:
    members = ThreadParticipant.objects.filter(thread=OuterRef("pk"))
    size = members.order_by().values("thread").annotate(n=Count("id")).values("n")
    return (
        Thread.objects.filter(visibility=Thread.Visibility.DIRECT)
        .filter(Exists(members.filter(user=me)), Exists(members.filter(user=other)))
        .annotate(size=Subquery(size))
        .filter(size=2)
        .order_by("created_at")
        .first()
    )


def _open(me: User, others: list[User], title: str | None = None) -> Thread:
    with transaction.atomic():
        thread = Thread.objects.create(
            title=(title or ONE_TO_ONE_TITLE)[:300],
            visibility=Thread.Visibility.DIRECT,
            created_by=me,
            post_count=0,
        )
        # In the same transaction as the thread: a direct thread without its
        # participant rows is readable by nobody, its author included.
        ThreadParticipant.objects.bulk_create(
            [ThreadParticipant(thread=thread, user=u) for u in [me, *others]], ignore_conflicts=True
        )
    return thread


def _one_to_one_or_open(me: User, other: User) -> Thread:
    return _one_to_one(me, other) or _open(me, [other])


def _person(user_id: str) -> User:
    person = User.objects.filter(pk=user_id, active=True).first()
    if person is None:
        raise HttpError(404, "No such person")
    return person


def _clean_body(raw: str) -> str:
    body = (raw or "").strip()
    if not body:
        raise HttpError(400, "Write something first.")
    if len(body) > MESSAGE_MAX_CHARS:
        raise HttpError(400, f"Keep a message under {MESSAGE_MAX_CHARS} characters.")
    return body


def _send(thread: Thread, author: User, body: str) -> Post:
    post = _write_post(thread, author, body, kind=Post.Kind.HUMAN)
    _mark_read(thread, author)
    parts = _participants(thread)
    group = len(parts) > 2
    title = (
        f"{author.name} in {_title(thread, parts, author)}" if group
        else f"{author.name} sent you a message"
    )
    excerpt = " ".join(body.split())[:160]
    for p in parts:
        if p.user_id != author.id and p.user.active:
            social_notify.notify(p.user_id, "message", title, excerpt, _href(thread.id), coalesce=True)
    return post


def _system(thread: Thread, actor: User, text: str) -> Post:
    post = _write_post(thread, None, text, kind=Post.Kind.SYSTEM)
    _mark_read(thread, actor)
    return post


# ------------------------------------------------------------------ the inbox --


@api.get("/dm", auth=session_auth)
def my_conversations(request: HttpRequest, limit: int = 50):
    """Your conversations, most recently active first, each with its last message and unread count."""
    me = require_user(request)
    latest = Post.objects.filter(thread=OuterRef("pk")).order_by("-created_at", "-id").values("id")[:1]
    threads = list(
        _mine(me).annotate(last_post_id=Subquery(latest))
        .order_by("-last_post_at")[: max(1, min(int(limit), 100))]
    )
    ids = [t.id for t in threads]
    unread = _unread(me, ids)
    lasts = {p.id: p for p in Post.objects.filter(pk__in=[t.last_post_id for t in threads if t.last_post_id]).select_related("author")}
    parts: dict[str, list[ThreadParticipant]] = {}
    for p in ThreadParticipant.objects.filter(thread_id__in=ids).select_related("user").order_by("added_at"):
        parts.setdefault(p.thread_id, []).append(p)
    results = []
    for t in threads:
        members = parts.get(t.id, [])
        last = lasts.get(t.last_post_id)
        results.append({
            "id": t.id,
            "is_group": len(members) > 2,
            "title": _title(t, members, me),
            "people": [social.person_brief(p.user) for p in members if p.user_id != me.id],
            "last": {
                "body": ("" if last.deleted_at else " ".join(last.body.split())[:160]),
                "author_id": last.author_id,
                "mine": last.author_id == me.id,
                "kind": last.kind,
                "at": last.created_at.isoformat(),
            } if last else None,
            "unread": unread.get(t.id, 0),
            "updated_at": t.last_post_at.isoformat(),
        })
    return {
        "results": results,
        "unread_total": sum(unread.values()),
        "unread_conversations": sum(1 for n in unread.values() if n),
    }


@api.get("/dm/unread", auth=session_auth)
def my_unread(request: HttpRequest):
    """What the badge on Messages says, cheaply enough to ask every half minute."""
    me = require_user(request)
    unread = _unread(me, list(_mine(me).values_list("id", flat=True)))
    return {"unread": sum(unread.values()), "conversations": sum(1 for n in unread.values() if n)}


class NewConversationIn(Schema):
    participant_ids: list[str]
    title: Optional[str] = None
    body: Optional[str] = None


@api.post("/dm", auth=session_auth)
def start_conversation(request: HttpRequest, payload: NewConversationIn):
    """A chat with one colleague (found again if it exists) or a small group."""
    me = require_user(request)
    wanted = list(dict.fromkeys(p for p in payload.participant_ids if p and p != me.id))
    if not wanted:
        raise HttpError(400, "Choose at least one person to talk to.")
    if len(wanted) > MAX_OTHERS:
        raise HttpError(400, "A group conversation is for a handful of people, not a mailing list.")
    people = list(User.objects.filter(pk__in=wanted, active=True))
    if len(people) != len(wanted):
        raise HttpError(404, "One of those people could not be found.")
    if len(people) == 1:
        thread = _one_to_one_or_open(me, people[0])
    else:
        title = " ".join((payload.title or "").split())[:120] or None
        thread = _open(me, people, title)
    if (payload.body or "").strip():
        rate_limit_for(me, "dm_message", 600, "hour", what="messaging")
        _send(thread, me, _clean_body(payload.body))
    return _conversation_dict(thread, me)


@api.post("/dm/with/{user_id}", auth=session_auth)
def conversation_with(request: HttpRequest, user_id: str):
    """The one-to-one conversation with this person, opened if there is none yet."""
    me = require_user(request)
    other = _person(user_id)
    if other.id == me.id:
        raise HttpError(400, "That is you.")
    return _conversation_dict(_one_to_one_or_open(me, other), me)


# ------------------------------------------------------------ a conversation --


@api.get("/dm/{thread_id}", auth=session_auth)
def read_conversation(request: HttpRequest, thread_id: str, read: bool = False):
    """The conversation. `read=1` means it is open in front of the reader, and only
    then does it count as read -- a poll from a hidden tab is not somebody reading."""
    me = require_user(request)
    thread = _conversation(me, thread_id)
    if read:
        _mark_read(thread, me)
    return _conversation_dict(thread, me)


class MessageIn(Schema):
    body: str


@api.post("/dm/{thread_id}/messages", auth=session_auth)
def send_message(request: HttpRequest, thread_id: str, payload: MessageIn):
    me = require_user(request)
    thread = _conversation(me, thread_id)
    if thread.locked:
        raise HttpError(400, "This conversation is closed to new messages.")
    body = _clean_body(payload.body)
    rate_limit_for(me, "dm_message", 600, "hour", what="messaging")
    post = _send(thread, me, body)
    post.author = me
    return _message(post, me)


@api.post("/dm/{thread_id}/read", auth=session_auth)
def mark_conversation_read(request: HttpRequest, thread_id: str):
    me = require_user(request)
    _mark_read(_conversation(me, thread_id), me)
    return {"ok": True}


# ------------------------------------------------------ collaboration requests --


class CollabRequestIn(Schema):
    to_id: str
    topic: str
    journal: str = ""
    message: str = ""


class CollabAnswerIn(Schema):
    action: str
    note: str = ""


@api.post("/collaborations/requests", auth=session_auth)
def request_collaboration(request: HttpRequest, payload: CollabRequestIn):
    """Ask a colleague to work on something together. Lands as a card in your chat with them."""
    me = require_user(request)
    other = _person(payload.to_id)
    if other.id == me.id:
        raise HttpError(400, "A collaboration takes somebody else.")
    topic = " ".join((payload.topic or "").split())
    if not topic:
        raise HttpError(400, "Say what you would like to work on together.")
    if len(topic) > 200:
        raise HttpError(400, "Keep the topic under 200 characters.")
    journal = " ".join((payload.journal or "").split())[:512]
    message = (payload.message or "").strip()[:MESSAGE_MAX_CHARS]
    rate_limit_for(me, "collab_request", 30, "day", what="collaboration requests")

    thread = _one_to_one_or_open(me, other)
    with transaction.atomic():
        post = _write_post(thread, me, message or f"Would you like to collaborate on {topic}?", kind=Post.Kind.HUMAN)
        req = CollaborationRequest.objects.create(
            thread=thread, post=post, sender=me, recipient=other,
            topic=topic, journal=journal, message=message,
        )
    _mark_read(thread, me)
    social_notify.notify(
        other.id, "collab", f"{me.name} asked to collaborate on {topic}", message[:160] or None,
        _href(thread.id),
    )
    return {"conversation_id": thread.id, "request": _collab_dict(req, me)}


@api.post("/collaborations/requests/{request_id}/respond", auth=session_auth)
def answer_collaboration(request: HttpRequest, request_id: str, payload: CollabAnswerIn):
    """Accept, decline, or suggest a call first. Only the person asked may answer."""
    me = require_user(request)
    req = (
        CollaborationRequest.objects.select_related("sender", "recipient", "thread")
        .filter(pk=request_id).first()
    )
    if req is None or not _mine(me).filter(pk=req.thread_id).exists():
        raise HttpError(404, "No such request")
    if req.recipient_id != me.id:
        raise HttpError(403, "Only the person asked can answer a collaboration request.")
    if req.state in (CollaborationRequest.State.ACCEPTED, CollaborationRequest.State.DECLINED):
        raise HttpError(400, "This request has already been answered.")
    action = (payload.action or "").strip().lower()
    note = " ".join((payload.note or "").split())[:500]
    now = timezone.now()

    with transaction.atomic():
        if action == "accept":
            req.state = CollaborationRequest.State.ACCEPTED
            collaboration = Collaboration.objects.create(request=req, topic=req.topic, journal=req.journal)
            collaboration.members.add(req.sender, req.recipient)
            text = f"{me.name} accepted. You are now collaborating on {req.topic}."
            told = f"{me.name} accepted your collaboration request"
        elif action == "decline":
            req.state = CollaborationRequest.State.DECLINED
            text = f"{me.name} can't take this on right now."
            told = None
        elif action == "call":
            req.state = CollaborationRequest.State.CALL
            text = f"{me.name} suggested a call first" + (f": {note}" if note else ".")
            told = f"{me.name} suggested a call about {req.topic}"
        else:
            raise HttpError(400, "Answer with accept, decline or call.")
        req.response_note = note
        req.responded_at = now
        req.save(update_fields=["state", "response_note", "responded_at"])
        _system(req.thread, me, text)
    if told:
        social_notify.notify(req.sender_id, "collab", told, note or None, _href(req.thread_id))
    req.refresh_from_db()
    return _collab_dict(req, me)


@api.delete("/collaborations/{collab_id}", auth=session_auth)
def end_collaboration(request: HttpRequest, collab_id: str):
    """Either member can end a collaboration; it leaves both profiles."""
    me = require_user(request)
    updated = Collaboration.objects.filter(pk=collab_id, members=me, ended_at__isnull=True).update(
        ended_at=timezone.now()
    )
    if not updated:
        raise HttpError(404, "No such collaboration of yours")
    return {"ok": True}


__all__ = [
    "CollabAnswerIn",
    "CollabRequestIn",
    "MessageIn",
    "NewConversationIn",
    "answer_collaboration",
    "conversation_with",
    "end_collaboration",
    "mark_conversation_read",
    "my_conversations",
    "my_unread",
    "read_conversation",
    "request_collaboration",
    "send_message",
    "start_conversation",
]
