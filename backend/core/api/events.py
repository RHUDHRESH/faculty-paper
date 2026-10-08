"""Events and research: seminars, workshops and calls for papers, who is going, and what the record shows lately.

A seminar is a `CalendarEvent` with a kind, a place and a speaker, so it shows
on the calendar and in the subscription feed with no second copy to keep right.
This module is the page built for finding them: a listing with the filters a
teacher reaches for, "I'm going", a one-event calendar file, the numbers for
Home, and the research showcase beside them.

Who may see an event is the calendar's rule, borrowed rather than rewritten
(`calendar._visible_events`), less the diary: a "only me" entry is somebody's
reminder, not an event to show off, so it is never listed here.

Who may *post* one is wider than on the calendar, on purpose. The calendar is a
diary where a head tells their department; here a seminar is how a department
learns something is on, and the people who organise them are the faculty. So a
faculty member may post for their own department, and a head, the Principal,
the Director and the office for the whole college.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta
from typing import Any, Optional
from urllib.parse import urlparse

from django.db.models import Count, Exists, F, OuterRef, Q, Subquery
from django.http import HttpRequest, HttpResponse
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core import discussions, hod
from core.api.calendar import PRIVATE, _dates, _editable, _times, _visible_events
from core.api.common import api, require_user, session_auth
from core.models import AuditLog, CalendarEvent, EventInvite, EventRsvp, Role, Thread, User
from core.services import event_people, ics, rbac, research_highlights
from core.services import notify as notify_service

logger = logging.getLogger("core.events")

#: What the page lists, in the order the filter chips run.
HUB_KINDS = ("SEMINAR", "WORKSHOP", "CONFERENCE", "FDP", "CALL_FOR_PAPERS", "OTHER")
DEPARTMENT, PUBLIC = Thread.Visibility.DEPARTMENT, Thread.Visibility.PUBLIC

#: Who may tell the whole college. The office, and the people who speak for it.
COLLEGE_WIDE = (*rbac.ADMIN_ROLES, Role.HOD, Role.PRINCIPAL, Role.DIRECTOR)

DEFAULT_LIMIT, MAX_LIMIT = 100, 300
WHENS = ("upcoming", "past", "week", "month")
#: "This week" runs from today for seven days, so it is never empty on a Saturday.
WEEK_DAYS = 7
#: Longest text a field takes; a seminar's description is a paragraph, not a document.
TEXT_MAX = {"title": 300, "venue": 255, "speaker": 255, "organiser": 255, "link": 500, "description": 4000}


class EventHubIn(Schema):
    title: str
    kind: str = "SEMINAR"
    starts_on: str
    ends_on: Optional[str] = None
    #: "15:00". Left out, it is an all-day entry.
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    all_day: bool = False
    description: Optional[str] = None
    venue: Optional[str] = None
    speaker: Optional[str] = None
    organiser: Optional[str] = None
    link: Optional[str] = None
    #: DEPARTMENT or PUBLIC. Not changed by an edit.
    visibility: str = "DEPARTMENT"
    department: Optional[str] = None


# ---------- who may do what ----------


def _own_department(user: User) -> str:
    return (getattr(user, "department", "") or "").strip()


def audiences(user: User) -> list[dict[str, str]]:
    """Who this person may tell, in the order the dialog offers them."""
    mine, office = _own_department(user), discussions.is_office(user.role)
    out: list[dict[str, str]] = []
    if mine or office:
        out.append({"key": DEPARTMENT, "label": f"My department ({mine})" if mine else "One department"})
    if user.role in COLLEGE_WIDE:
        out.append({"key": PUBLIC, "label": "The whole college"})
    return out


def _audience_for(user: User, visibility: str, department: Optional[str]) -> Optional[str]:
    """The department an event is for, after checking this person may post it."""
    if visibility not in (DEPARTMENT, PUBLIC):
        raise HttpError(400, "Choose who it is for: your department or the whole college.")
    if visibility not in {a["key"] for a in audiences(user)}:
        raise HttpError(
            403,
            "You can post for your own department. The whole college is for heads of department, the Principal, the Director and the office.",
        )
    mine, office = _own_department(user), discussions.is_office(user.role)
    asked = (department or "").strip()
    if visibility == DEPARTMENT:
        if office:
            if not asked:
                raise HttpError(400, "Choose which department this is for.")
            return asked
        if asked and asked.casefold() != mine.casefold():
            raise HttpError(403, f"You can only post for your own department, {mine}.")
        return mine
    # The whole college: the department, when there is one, is who is hosting.
    return (asked if office else (mine if user.role == Role.HOD else "")) or None


def _link(value: Optional[str]) -> Optional[str]:
    """A web address or nothing: it becomes a link on the page, so `javascript:` must never get in."""
    text = (value or "").strip()
    if not text:
        return None
    parts = urlparse(text)
    if parts.scheme not in ("http", "https") or not parts.netloc or re.search(r"\s", text):
        raise HttpError(400, "The link must be a web address starting with http:// or https://.")
    return text


def _text(payload: EventHubIn, field: str) -> Optional[str]:
    value = (getattr(payload, field) or "").strip()
    if len(value) > TEXT_MAX[field]:
        raise HttpError(400, f"The {field} is too long. Keep it under {TEXT_MAX[field]} characters.")
    return value or None


def _fields(payload: EventHubIn) -> dict[str, Any]:
    """What an event is, checked. Shared by posting and editing."""
    title = _text(payload, "title") or ""
    if len(title) < 3:
        raise HttpError(400, "Give the event a title.")
    if payload.kind not in HUB_KINDS:
        raise HttpError(400, f"Kind must be one of: {', '.join(HUB_KINDS)}.")
    starts_on, ends_on = _dates(payload)
    starts_at, ends_at = _times(payload)
    if starts_at and ends_at and not ends_on and ends_at < starts_at:
        raise HttpError(400, "It cannot end before it starts.")
    return {
        "title": title,
        "kind": payload.kind,
        "starts_on": starts_on,
        "ends_on": ends_on,
        "starts_at": starts_at,
        "ends_at": ends_at,
        "description": _text(payload, "description"),
        "venue": _text(payload, "venue"),
        "speaker": _text(payload, "speaker"),
        "organiser": _text(payload, "organiser"),
        "link": _link(payload.link),
    }


# ---------- reading ----------


def _hub_events(user: User):
    """What this person may see here: the calendar's rule, without diary entries or the calendar's own kinds."""
    return _visible_events(user).exclude(visibility=PRIVATE).filter(kind__in=HUB_KINDS)


def _with_going(qs, user: User):
    """What a card shows about each event: how many are going, and what this person was asked.

    The invite count is a subquery rather than a join: joined beside the RSVPs
    it would multiply every row by the number of invitees.
    """
    mine = EventInvite.objects.filter(event=OuterRef("pk"), user=user)
    invited = EventInvite.objects.filter(event=OuterRef("pk")).order_by().values("event").annotate(n=Count("pk")).values("n")
    return qs.select_related("created_by").annotate(
        going_count=Count("rsvps", distinct=True),
        going=Exists(EventRsvp.objects.filter(event=OuterRef("pk"), user=user)),
        invited_count=Subquery(invited),
        invited_me=Exists(mine),
        invited_by_me_id=Subquery(mine.values("invited_by_id")[:1]),
        invited_by_me_name=Subquery(mine.values("invited_by__name")[:1]),
    )


def _order(qs, *, newest_first: bool = False):
    if newest_first:
        return qs.order_by("-starts_on", F("starts_at").desc(nulls_last=True), "title")
    return qs.order_by("starts_on", F("starts_at").asc(nulls_first=True), "title")


def _upcoming_q(today: date) -> Q:
    """Still to come, or still going on: a conference that began yesterday is not over."""
    return Q(ends_on__gte=today) | Q(ends_on__isnull=True, starts_on__gte=today)


def _past_q(today: date) -> Q:
    return Q(ends_on__lt=today) | Q(ends_on__isnull=True, starts_on__lt=today)


def _month_q(today: date) -> Q:
    first = today.replace(day=1)
    last = (first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    return Q(starts_on__lte=last) & (Q(ends_on__gte=first) | Q(ends_on__isnull=True, starts_on__gte=first))


def _can_edit(user: User, event: CalendarEvent) -> bool:
    """Whoever posted it, and the office: who may change it, find people for it, and see who was asked."""
    return event.created_by_id == user.id or discussions.is_office(user.role)


def _event(e: CalendarEvent, user: User) -> dict[str, Any]:
    editor = _can_edit(user, e)
    invited_by = None
    if getattr(e, "invited_me", False) and getattr(e, "invited_by_me_id", None):
        invited_by = {"id": e.invited_by_me_id, "name": e.invited_by_me_name}
    return {
        "id": e.id,
        "title": e.title,
        "kind": e.kind,
        "kind_label": CalendarEvent.Kind(e.kind).label,
        "starts_on": e.starts_on.isoformat(),
        "ends_on": e.ends_on.isoformat() if e.ends_on else None,
        "starts_at": e.starts_at.strftime("%H:%M") if e.starts_at else None,
        "ends_at": e.ends_at.strftime("%H:%M") if e.ends_at else None,
        "all_day": e.starts_at is None,
        "description": e.description,
        "venue": e.venue,
        "speaker": e.speaker,
        "organiser": e.organiser,
        "link": e.link,
        "department": e.department,
        "visibility": e.visibility,
        "created_by": e.created_by.name if e.created_by_id else None,
        "created_by_id": e.created_by_id,
        "going_count": getattr(e, "going_count", 0),
        "going": bool(getattr(e, "going", False)),
        "can_edit": editor,
        # Only whoever may edit the event sees how many were asked; a reader sees their own invite.
        "invited_count": (getattr(e, "invited_count", 0) or 0) if editor else 0,
        "invited_by": invited_by,
    }


def _departments() -> list[str]:
    names = User.objects.filter(active=True).exclude(department__isnull=True).values_list("department", flat=True)
    return sorted(research_highlights.spellings(names).values(), key=str.casefold)


def _one(user: User, event_id: str) -> CalendarEvent:
    """An event this person may see, with its going count, or a 404 that does not say which."""
    event = _with_going(_hub_events(user), user).filter(pk=event_id).first()
    if event is None:
        raise HttpError(404, "No such event")
    return event


@api.get("/events/summary", auth=session_auth)
def events_summary(request: HttpRequest):
    """What Home shows: this week's, the next one, and how many of each kind are coming."""
    user = require_user(request)
    today = timezone.localdate()
    coming = _hub_events(user).filter(_upcoming_q(today))
    week = coming.filter(starts_on__lte=today + timedelta(days=WEEK_DAYS - 1))
    soonest = list(_order(_with_going(coming, user))[:3])
    return {
        "today": today.isoformat(),
        "this_week": [_event(e, user) for e in _order(_with_going(week, user))[:3]],
        "this_week_count": week.count(),
        "next": _event(soonest[0], user) if soonest else None,
        "upcoming": [_event(e, user) for e in soonest],
        "counts": dict(coming.order_by().values_list("kind").annotate(n=Count("pk"))),
        "total": coming.count(),
    }


@api.get("/events", auth=session_auth)
def events_list(
    request: HttpRequest,
    when: str = "upcoming",
    kind: Optional[str] = None,
    department: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = DEFAULT_LIMIT,
):
    """Seminars, workshops, conferences, programmes and calls for papers this person may see."""
    user = require_user(request)
    if when not in WHENS:
        raise HttpError(400, "when must be upcoming, past, week or month.")
    today = timezone.localdate()

    base = _hub_events(user)
    if (department or "").strip():
        base = base.filter(department__iexact=department.strip())
    if (q or "").strip():
        needle = q.strip()
        base = base.filter(
            Q(title__icontains=needle) | Q(speaker__icontains=needle) | Q(venue__icontains=needle)
            | Q(organiser__icontains=needle) | Q(description__icontains=needle)
        )
    if when == "past":
        base = base.filter(_past_q(today))
    elif when == "month":
        base = base.filter(_month_q(today))
    else:
        base = base.filter(_upcoming_q(today))
        if when == "week":
            base = base.filter(starts_on__lte=today + timedelta(days=WEEK_DAYS - 1))

    # The chips show how many each kind has, so they are counted before the
    # kind chosen narrows the list.
    counts = dict(base.order_by().values_list("kind").annotate(n=Count("pk")))
    shown = base.filter(kind=kind) if kind else base
    rows = _order(_with_going(shown, user), newest_first=(when == "past"))[: max(1, min(limit, MAX_LIMIT))]

    seminars = _hub_events(user).filter(kind="SEMINAR", starts_on__year=today.year).filter(_past_q(today)).count()
    return {
        "today": today.isoformat(),
        "when": when,
        "results": [_event(e, user) for e in rows],
        "counts": counts,
        "kinds": [{"key": k, "label": CalendarEvent.Kind(k).label} for k in HUB_KINDS],
        "departments": _departments(),
        "audiences": audiences(user),
        "can_add": bool(audiences(user)),
        "can_pick_department": discussions.is_office(user.role),
        "seminars_this_year": seminars,
    }


# ---------- posting and changing ----------


def _clock(t) -> str:
    hour = t.hour % 12 or 12
    return f"{hour}{f':{t.minute:02d}' if t.minute else ''} {'am' if t.hour < 12 else 'pm'}"


def when_in_words(e: CalendarEvent) -> str:
    """"Thursday 16 Oct, 3 pm, Seminar Hall 2": how a person would say it."""
    day = f"{e.starts_on:%A} {e.starts_on.day} {e.starts_on:%b}"
    if e.ends_on:
        day += f" to {e.ends_on:%A} {e.ends_on.day} {e.ends_on:%b}"
    if e.kind == "CALL_FOR_PAPERS":
        day = f"Closes {day}"
    parts = [day]
    if e.starts_at:
        parts.append(_clock(e.starts_at))
    if e.venue:
        parts.append(e.venue)
    return ", ".join(parts)


def _announce(event: CalendarEvent, poster: User) -> None:
    """Tell the people it is for, once. Never for an edit, and never the poster.

    A failure to tell somebody must not undo an event that has been saved, so
    it is logged and the post stands.
    """
    people = User.objects.filter(active=True).exclude(pk=poster.pk)
    if event.visibility == DEPARTMENT:
        people = people.filter(department__iexact=event.department)
    title = f"{event.get_kind_display()}: {event.title}"
    body = f"{when_in_words(event)}. Posted by {poster.name}."
    href = f"/events?event={event.id}"
    try:
        notify_service.notify_many(people, "event", title, body, href, actor=poster)
    except Exception:  # noqa: BLE001 -- see the docstring
        logger.exception("could not tell everybody about event %s", event.id)


@api.post("/events", auth=session_auth)
def events_create(request: HttpRequest, payload: EventHubIn):
    user = require_user(request)
    department = _audience_for(user, payload.visibility, payload.department)
    event = CalendarEvent.objects.create(
        **_fields(payload), visibility=payload.visibility, department=department, created_by=user
    )
    _announce(event, user)
    return _event(_one(user, event.id), user)


# `.ics` before the bare id: Django takes the first pattern that matches, and
# `<event_id>` would swallow "abc.ics" and answer a download with a 405.
@api.get("/events/{event_id}.ics", auth=session_auth)
def event_ics(request: HttpRequest, event_id: str):
    """One event as a calendar file: "Add to my calendar" for Google, Outlook or Apple."""
    user = require_user(request)
    event = _one(user, event_id)
    slug = re.sub(r"[^a-z0-9]+", "-", event.title.lower()).strip("-")[:60] or "event"
    response = HttpResponse(ics.calendar([ics.from_event(event)], name=event.title), content_type="text/calendar; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{slug}.ics"'
    return response


@api.post("/events/{event_id}/going", auth=session_auth)
def event_going(request: HttpRequest, event_id: str):
    user = require_user(request)
    event = _one(user, event_id)
    if (event.ends_on or event.starts_on) < timezone.localdate():
        raise HttpError(400, "That one has already happened.")
    EventRsvp.objects.get_or_create(event=event, user=user)
    return {"going": True, "going_count": event.rsvps.count()}


@api.delete("/events/{event_id}/going", auth=session_auth)
def event_not_going(request: HttpRequest, event_id: str):
    user = require_user(request)
    event = _one(user, event_id)
    EventRsvp.objects.filter(event=event, user=user).delete()
    return {"going": False, "going_count": event.rsvps.count()}


def _mine_to_change(user: User, event_id: str) -> CalendarEvent:
    """Whoever added it, or the office, and only an event this page lists:
    it is not a way round the calendar for a payment run or somebody's diary."""
    event = _editable(user, event_id)
    if event.visibility == PRIVATE or event.kind not in HUB_KINDS:
        raise HttpError(404, "No such event")
    return event


@api.patch("/events/{event_id}", auth=session_auth)
def event_update(request: HttpRequest, event_id: str, payload: EventHubIn):
    """Change what an event says. Who it is for stays as it was, and nobody is told again."""
    user = require_user(request)
    event = _mine_to_change(user, event_id)
    for name, value in _fields(payload).items():
        setattr(event, name, value)
    event.save()
    return _event(_one(user, event.id), user)


@api.delete("/events/{event_id}", auth=session_auth)
def event_delete(request: HttpRequest, event_id: str):
    user = require_user(request)
    _mine_to_change(user, event_id).delete()
    return {"ok": True}


# ---------- finding and inviting people ----------

#: Most people one invitation names, and the longest note that goes with it.
MAX_INVITES, NOTE_MAX = 200, 500


class EventInviteIn(Schema):
    user_ids: list[str]
    note: str = ""


def _editors_only(user: User, event: CalendarEvent) -> None:
    if not _can_edit(user, event):
        raise HttpError(403, "Only whoever posted this event, or the office, can invite people to it.")


def _announce_invite(event: CalendarEvent, inviter: User, people: list[User], note: str) -> None:
    """Tell each person just asked, once. A failure to tell somebody leaves the invitations standing, as `_announce` does."""
    title = f"{inviter.name} invites you: {event.title}"
    body = when_in_words(event) + (f". {note}" if note else "")
    href = f"/events?event={event.id}"
    try:
        notify_service.notify_many(people, "event", title, body, href, actor=inviter)
    except Exception:  # noqa: BLE001 -- see the docstring
        logger.exception("could not tell people about an invitation to event %s", event.id)


@api.get("/events/{event_id}/people", auth=session_auth)
def event_people_view(request: HttpRequest, event_id: str, department: Optional[str] = None, q: Optional[str] = None):
    """People to find for this event: the topics it is about, and who on the record works on them."""
    user = require_user(request)
    event = _one(user, event_id)
    _editors_only(user, event)
    return event_people.suggest(event, user, department=(department or "").strip() or None, q=q)


@api.post("/events/{event_id}/invite", auth=session_auth)
def event_invite(request: HttpRequest, event_id: str, payload: EventInviteIn):
    """Ask people to the event. Each newly asked person is told once; the counts go to the audit log."""
    user = require_user(request)
    event = _one(user, event_id)
    _editors_only(user, event)
    if not 1 <= len(payload.user_ids) <= MAX_INVITES:
        raise HttpError(400, f"Choose between 1 and {MAX_INVITES} people to invite.")
    note = (payload.note or "").strip()
    if len(note) > NOTE_MAX:
        raise HttpError(400, f"The note is too long. Keep it under {NOTE_MAX} characters.")
    counts, asked = event_people.invite(event, user, payload.user_ids, note)
    if asked:
        _announce_invite(event, user, asked, note)
    AuditLog.objects.create(
        actor=user, action="EVENT_INVITES_SENT", entity="CalendarEvent", entity_id=event.id,
        detail_json=json.dumps(counts),
    )
    return counts


@api.get("/events/{event_id}/invites", auth=session_auth)
def event_invites(request: HttpRequest, event_id: str):
    """Who has been asked to this event, who invited them, and how many of them are going."""
    user = require_user(request)
    event = _one(user, event_id)
    _editors_only(user, event)
    return event_people.invitees(event)


# ---------- the research showcase ----------


@api.get("/research/highlights", auth=session_auth)
def research_highlights_view(request: HttpRequest, period: str = research_highlights.DEFAULT_PERIOD, department: Optional[str] = None):
    """What the record shows lately: new Q1 papers, first papers, most cited, new names. Counted; no money."""
    require_user(request)
    if period not in research_highlights.PERIODS:
        raise HttpError(400, "Choose the past month, the past three months or the past year.")
    found = research_highlights.highlights(period, (department or "").strip()[:100])
    # Nothing here carries an amount; this is the belt that keeps it so.
    return hod.without_money(found)


__all__ = [
    "EventHubIn",
    "EventInviteIn",
    "event_delete",
    "event_invite",
    "event_invites",
    "event_going",
    "event_ics",
    "event_not_going",
    "event_people_view",
    "event_update",
    "events_create",
    "events_list",
    "events_summary",
    "research_highlights_view",
]
