"""the calendar.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.common import require_user
from core.api.discussions import _write_post

import secrets
from datetime import date, datetime, time, timedelta
from typing import Any, Optional
from urllib.parse import quote
from django.db.models import Exists, OuterRef, Q
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.conf import settings
from ninja import Schema
from ninja.errors import HttpError
from core.models import (
    CalendarEvent,
    CalendarFeed,
    Claim,
    ClaimAction,
    ClaimStatus,
    Notification,
    PaidLedger,
    Post,
    Role,
    Thread,
    User,
)
from core import discussions
from core.services import ics, rbac
from core.services.record_dates import filing_recorded, ledger_month_recorded

# ---------- the calendar ----------


class EventIn(Schema):
    title: str
    kind: str = "OTHER"
    starts_on: str
    ends_on: Optional[str] = None
    description: Optional[str] = None
    visibility: str = "PRIVATE"
    department: Optional[str] = None
    thread_id: Optional[str] = None
    claim_id: Optional[str] = None
    #: "10:00". Both empty (or all_day) for an all-day entry.
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    all_day: bool = True


PRIVATE = "PRIVATE"


def allowed_visibilities(user: User) -> list[str]:
    """Who may put a date in front of whom.

    Faculty keep a diary: "Only me". A head of department may also tell their
    department. The office may tell anyone.
    """
    if discussions.is_office(user.role):
        return [PRIVATE, "DEPARTMENT", "PUBLIC", "OFFICE"]
    if user.role == Role.HOD and (getattr(user, "department", "") or "").strip():
        return [PRIVATE, "DEPARTMENT"]
    return [PRIVATE]


def _times(payload: EventIn) -> tuple[Optional[time], Optional[time]]:
    if payload.all_day or not payload.starts_at:
        return None, None
    try:
        starts = time.fromisoformat(payload.starts_at)
        ends = time.fromisoformat(payload.ends_at) if payload.ends_at else None
    except ValueError:
        raise HttpError(400, "Times must look like 10:00")
    return starts, ends


def _own_claim(user: User, claim_id: Optional[str]):
    """A reminder may point at one of *my* papers, never at a colleague's."""
    if not claim_id:
        return None
    claim = Claim.objects.filter(pk=claim_id).first()
    if claim is None or (claim.owner_id != user.id and not discussions.is_office(user.role)):
        raise HttpError(404, "No such paper of yours")
    return claim


def _event_dict(e: CalendarEvent) -> dict[str, Any]:
    return {
        "starts_at": e.starts_at.strftime("%H:%M") if e.starts_at else None,
        "ends_at": e.ends_at.strftime("%H:%M") if e.ends_at else None,
        "all_day": e.starts_at is None,
        "claim_title": e.claim.paper_title if e.claim_id and e.claim else None,
        "id": e.id,
        "title": e.title,
        "kind": e.kind,
        "kind_label": CalendarEvent.Kind(e.kind).label,
        "starts_on": e.starts_on.isoformat(),
        "ends_on": e.ends_on.isoformat() if e.ends_on else None,
        "description": e.description,
        "visibility": e.visibility,
        "department": e.department,
        "thread_id": e.thread_id,
        "claim_id": e.claim_id,
        "created_by": e.created_by.name if e.created_by_id else None,
        "created_by_id": e.created_by_id,
    }


def _visible_events(user: User):
    """Same three-way rule as a thread, applied to a date."""
    condition = Q(visibility=Thread.Visibility.PUBLIC) | Q(visibility=PRIVATE, created_by=user)
    department = (getattr(user, "department", "") or "").strip()
    if department:
        condition |= Q(
            visibility=Thread.Visibility.DEPARTMENT, department__iexact=department
        )
    if discussions.is_office(user.role):
        # Same reasoning as `discussions.visible_threads`: the office reads
        # everything, or an event and the thread it came out of disagree
        # about who may see them.
        condition |= Q(visibility=Thread.Visibility.OFFICE)
        condition |= Q(visibility=Thread.Visibility.DEPARTMENT)
    else:
        condition |= Q(visibility=Thread.Visibility.OFFICE, created_by=user)
    return CalendarEvent.objects.filter(condition)


@api.get("/calendar", auth=session_auth)
def list_events(
    request: HttpRequest,
    start: Optional[str] = None,
    end: Optional[str] = None,
    kind: Optional[str] = None,
):
    """Everything with a date on it, in a window.

    Defaults to a span around today rather than to everything: a calendar
    that opens on four years of history is a calendar nobody scrolls.
    """
    user = require_user(request)
    qs = _visible_events(user).select_related("created_by", "claim")

    today = timezone.now().date()
    try:
        first = date.fromisoformat(start) if start else today - timedelta(days=30)
        last = date.fromisoformat(end) if end else today + timedelta(days=120)
    except ValueError:
        raise HttpError(400, "Dates must look like 2026-03-01")
    if last < first:
        raise HttpError(400, "The end of the window is before its start")

    # An event overlaps the window if it starts before the end of it and has
    # not already finished. A span is not just its first day.
    qs = qs.filter(starts_on__lte=last).filter(
        Q(ends_on__isnull=True, starts_on__gte=first) | Q(ends_on__gte=first)
    )
    if kind:
        qs = qs.filter(kind=kind)

    return {
        "start": first.isoformat(),
        "end": last.isoformat(),
        "results": [_event_dict(e) for e in qs],
        "kinds": [{"key": k.value, "label": k.label} for k in CalendarEvent.Kind],
        "record": _record(user, first, last),
        "record_kinds": [{"key": k, "label": v} for k, v in RECORD_KINDS.items()],
        "visibilities": allowed_visibilities(user),
    }


RECORD_KINDS = {
    "PAID": "Payments made",
    "PUBLISHED": "Published",
    "FILED": "Filed",
    "CUTOFF": "Filing cutoff",
}


def _cutoffs(first: date, last: date) -> list[dict[str, Any]]:
    """The payout policy's filing cutoff, once a month -- only when it is set.
    A deadline nobody decided is fake urgency (core/services/nudges.py)."""
    from core.services.nudges import cutoff_day

    day = cutoff_day()
    if not day:
        return []
    out = []
    month = first.replace(day=1)
    while month <= last:
        try:
            when = month.replace(day=day)
        except ValueError:  # 31 in a 30-day month: the month's last day
            when = (month.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
        if first <= when <= last:
            out.append(_record_entry(
                "CUTOFF", when.strftime("%Y-%m"), when,
                "Filing cutoff for this month's payout", whole_month=False,
            ))
        month = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
    return out


def _record_entry(kind: str, key: str, starts_on: date, title: str, **extra) -> dict[str, Any]:
    return {
        "id": f"record-{kind.lower()}-{key}",
        "kind": kind,
        "kind_label": RECORD_KINDS[kind],
        "title": title,
        "starts_on": starts_on.isoformat(),
        "count": extra.get("count", 1),
        "amount": extra.get("amount"),
        "claim_id": extra.get("claim_id"),
        "titles": extra.get("titles", []),
        # A month's payments, or a month gathered for the college, is a month
        # and not its first day.
        "whole_month": extra.get("whole_month", kind == "PAID"),
    }


def _record(user: User, first: date, last: date) -> list[dict[str, Any]]:
    """The dates the record already holds, as calendar entries nobody has to type.

    Payments made, papers published and papers filed. The office, the
    Principal, the Director and Finance see the college's, a month or a day at
    a time. A claimant -- faculty, and a head of department, who sees no money
    but their own -- sees their own papers and their own payments, one by one.
    A date the ERP import stamped on a row because the workbook had none is not
    a date anything happened, and is left out (core/services/record_dates.py).
    """
    # Here, not at the top: importing the module registers its routes, and
    # route order is fixed by core/api/__init__.py.
    from core.api.my_payments import ledger_for

    college = rbac.can_view_reports(user.role)
    own = Q(owner=user)
    out: list[dict[str, Any]] = []

    # ---- payments made ----
    ledger = PaidLedger.objects.filter(payout_month__gte=first.replace(day=1), payout_month__lte=last)
    if college:
        months: dict[date, list[float]] = {}
        for month, raw, amount in ledger.values_list("payout_month", "raw_json", "amount"):
            if ledger_month_recorded(raw):
                slot = months.setdefault(month, [0, 0.0])
                slot[0] += 1
                slot[1] += amount or 0
        for month, (n, total) in sorted(months.items()):
            out.append(_record_entry(
                "PAID", month.strftime("%Y-%m"), month,
                f"{n} {'paper' if n == 1 else 'papers'} paid for",
                count=n, amount=round(total, 2),
            ))
    else:
        mine = ledger_for(user).filter(
            payout_month__gte=first.replace(day=1), payout_month__lte=last, amount__gt=0
        )
        for row in mine:
            if ledger_month_recorded(row.raw_json):
                out.append(_record_entry(
                    "PAID", row.id, row.payout_month,
                    f"Paid for {row.paper_title or 'a paper'}",
                    amount=round(row.amount or 0, 2), claim_id=row.claim_id,
                ))

    # ---- papers published ----
    papers = Claim.objects.exclude(status=ClaimStatus.DRAFT) | Claim.objects.filter(own)
    # A head of department sees their department's filed papers, as the
    # department page does -- titles and dates, never an amount -- gathered
    # by month like the college's, and never linked: a colleague's ticket is
    # not theirs to open.
    department = (getattr(user, "department", "") or "").strip()
    head = user.role == Role.HOD and bool(department)
    if head:
        papers = Claim.objects.filter(
            own | (Q(owner__department__iexact=department) & ~Q(status=ClaimStatus.DRAFT))
        )
    elif not college:
        papers = Claim.objects.filter(own)
    published: dict[date, list[tuple[str, str]]] = {}
    for claim_id, title, raw_day in papers.filter(
        publication_date__gte=first.isoformat(), publication_date__lte=last.isoformat() + "~"
    ).values_list("id", "paper_title", "publication_date"):
        try:
            day = date.fromisoformat((raw_day or "")[:10])
        except ValueError:
            continue
        if first <= day <= last:
            published.setdefault(day, []).append((claim_id, title or "Untitled paper"))
    _gathered(out, "PUBLISHED", published, college or head, "published", link=not head)

    # ---- papers filed ----
    lo = timezone.make_aware(datetime.combine(first, time.min))
    hi = timezone.make_aware(datetime.combine(last, time.max))
    filed: dict[date, list[tuple[str, str]]] = {}
    rows = (
        papers.exclude(status=ClaimStatus.DRAFT)
        .filter(submitted_at__gte=lo, submitted_at__lte=hi)
        .annotate(acted=Exists(ClaimAction.objects.filter(claim=OuterRef("pk"))))
        .values_list("id", "paper_title", "submitted_at", "created_at", "acted")
    )
    for claim_id, title, submitted, created, acted in rows:
        if filing_recorded(submitted, created, has_actions=acted):
            day = timezone.localtime(submitted).date()
            filed.setdefault(day, []).append((claim_id, title or "Untitled paper"))
    _gathered(out, "FILED", filed, college or head, "filed", link=not head)

    out.extend(_cutoffs(first, last))
    out.sort(key=lambda e: (e["starts_on"], e["kind"]))
    return out


def _gathered(
    out, kind: str, by_day: dict[date, list[tuple[str, str]]], college: bool, verb: str,
    *, link: bool = True,
):
    """One entry per paper for a claimant; for the college, one per month,
    naming the first few papers. A day at a time was a column of "1 paper
    filed" rows that hid the month's shape."""
    if not college:
        for day, papers in sorted(by_day.items()):
            for claim_id, title in papers:
                prefix = "You filed" if kind == "FILED" else "Published:"
                out.append(_record_entry(kind, claim_id, day, f"{prefix} {title}", claim_id=claim_id))
        return
    buckets: dict[date, list[tuple[str, str]]] = {}
    for day, papers in by_day.items():
        buckets.setdefault(day.replace(day=1), []).extend(papers)
    for day, papers in sorted(buckets.items()):
        n = len(papers)
        out.append(_record_entry(
            kind, day.isoformat(), day,
            f"{n} {'paper' if n == 1 else 'papers'} {verb}",
            count=n, titles=[t for _, t in papers[:3]],
            claim_id=papers[0][0] if n == 1 and link else None,
            whole_month=True,
        ))


# ---------- the subscription feed ----------


def _feed_for(user: User, *, rotate: bool = False) -> CalendarFeed:
    feed = CalendarFeed.objects.filter(user=user).first()
    if feed is None:
        return CalendarFeed.objects.create(user=user, token=secrets.token_urlsafe(32))
    if rotate:
        feed.token = secrets.token_urlsafe(32)
        feed.save()
    return feed


def _feed_links(request: HttpRequest, feed: CalendarFeed) -> dict[str, str]:
    path = f"/api/calendar/feed/{feed.token}.ics"
    # Behind the static site's rewrite the request arrives on the API's own
    # host; the address people subscribe to is the site's.
    base = (getattr(settings, "APP_BASE_URL", "") or "").rstrip("/")
    url = f"{base}{path}" if base else request.build_absolute_uri(path)
    webcal = "webcal://" + url.split("://", 1)[1]
    return {
        "url": url,
        "webcal": webcal,
        "google_subscribe_url": "https://calendar.google.com/calendar/r?cid=" + quote(webcal, safe=""),
    }


@api.get("/calendar/feed-link", auth=session_auth)
def feed_link(request: HttpRequest):
    user = require_user(request)
    return _feed_links(request, _feed_for(user))


@api.post("/calendar/feed-link/reset", auth=session_auth)
def feed_link_reset(request: HttpRequest):
    user = require_user(request)
    return _feed_links(request, _feed_for(user, rotate=True))


@api.get("/calendar/feed/{token}.ics", auth=None)
def feed(request: HttpRequest, token: str):
    """Everything on my calendar, for Google, Outlook or Apple to poll.

    Authorised by the token alone. Titles and dates only: no amount and no
    staff id ever leaves in it, whatever the record entry carries.
    """
    row = CalendarFeed.objects.filter(token=token).select_related("user").first()
    if row is None or not row.user.is_active:
        return HttpResponse("No such calendar.", status=404, content_type="text/plain")
    user = row.user
    today = timezone.localdate()
    first, last = today - timedelta(days=365), today + timedelta(days=365)
    events = (
        _visible_events(user)
        .filter(starts_on__lte=last)
        .filter(Q(ends_on__isnull=True, starts_on__gte=first) | Q(ends_on__gte=first))
    )
    body = ics.calendar(
        [ics.from_event(e) for e in events] + [ics.from_record(r) for r in _record(user, first, last)],
        name="Publications calendar",
    )
    response = HttpResponse(body, content_type="text/calendar; charset=utf-8")
    response["Cache-Control"] = "max-age=900"
    response["Content-Disposition"] = 'inline; filename="calendar.ics"'
    return response


def _check_visibility(user: User, visibility: str, department: Optional[str]) -> None:
    if visibility not in allowed_visibilities(user):
        if visibility not in [v for v, _ in CalendarEvent._meta.get_field("visibility").choices]:
            raise HttpError(400, "Choose who sees it: only you, your department or the college.")
        raise HttpError(403, "You can only add events for yourself.")
    if visibility == PRIVATE:
        return
    refusal = discussions.check_visibility(user, visibility, department)
    if refusal:
        raise HttpError(403 if "only" in refusal.lower() else 400, refusal)


def _dates(payload: EventIn) -> tuple[date, Optional[date]]:
    try:
        starts = date.fromisoformat(payload.starts_on)
        ends = date.fromisoformat(payload.ends_on) if payload.ends_on else None
    except (TypeError, ValueError):
        raise HttpError(400, "Dates must look like 2026-03-01")
    if ends and ends < starts:
        raise HttpError(400, "It cannot end before it starts.")
    if ends == starts:
        ends = None
    return starts, ends


@api.post("/calendar", auth=session_auth)
def create_event(request: HttpRequest, payload: EventIn):
    user = require_user(request)
    title = (payload.title or "").strip()
    if len(title) < 3:
        raise HttpError(400, "Give the event a title.")
    if payload.kind not in CalendarEvent.Kind.values:
        raise HttpError(400, f"Kind must be one of: {', '.join(CalendarEvent.Kind.values)}.")

    department = (payload.department or "").strip() or None
    if payload.visibility == "DEPARTMENT" and not department:
        department = (getattr(user, "department", "") or "").strip() or None
    _check_visibility(user, payload.visibility, department)
    starts, ends = _dates(payload)
    starts_at, ends_at = _times(payload)
    if starts_at and ends_at and not ends and ends_at < starts_at:
        raise HttpError(400, "It cannot end before it starts.")

    thread = Thread.objects.filter(pk=payload.thread_id).first() if payload.thread_id else None
    if thread and not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")

    event = CalendarEvent.objects.create(
        title=title,
        kind=payload.kind,
        starts_on=starts,
        ends_on=ends,
        starts_at=starts_at,
        ends_at=ends_at,
        description=(payload.description or "").strip() or None,
        visibility=payload.visibility,
        department=department if payload.visibility == "DEPARTMENT" else None,
        thread=thread,
        claim=_own_claim(user, payload.claim_id),
        created_by=user,
    )

    # An event that came out of a thread is recorded in it, so the decision
    # and the date do not live in two places that can disagree. A private
    # reminder is nobody's business but its owner's, so it says nothing.
    if thread and payload.visibility != PRIVATE:
        _write_post(
            thread, None,
            f"📅 **{title}** — {starts.isoformat()}"
            + (f" to {ends.isoformat()}" if ends else ""),
            kind=Post.Kind.SYSTEM,
        )

    return _event_dict(event)


def _editable(user: User, event_id: str) -> CalendarEvent:
    event = CalendarEvent.objects.filter(pk=event_id).first()
    # Somebody else's private reminder does not exist, as far as anyone else
    # can tell -- the office included.
    if event is None or (event.visibility == PRIVATE and event.created_by_id != user.id):
        raise HttpError(404, "No such event")
    if event.created_by_id != user.id and not discussions.is_office(user.role):
        raise HttpError(403, "Only the office, or whoever added it, can change an event.")
    return event


@api.patch("/calendar/{event_id}", auth=session_auth)
def update_event(request: HttpRequest, event_id: str, payload: EventIn):
    user = require_user(request)
    event = _editable(user, event_id)
    event.starts_on, event.ends_on = _dates(payload)
    event.starts_at, event.ends_at = _times(payload)
    if payload.kind not in CalendarEvent.Kind.values:
        raise HttpError(400, f"Kind must be one of: {', '.join(CalendarEvent.Kind.values)}.")
    title = (payload.title or event.title).strip()
    if len(title) < 3:
        raise HttpError(400, "Give the event a title.")
    event.title = title
    event.kind = payload.kind
    event.description = (payload.description or "").strip() or None
    if event.created_by_id == user.id:
        event.claim = _own_claim(user, payload.claim_id)
    event.save()
    return _event_dict(event)


@api.delete("/calendar/{event_id}", auth=session_auth)
def delete_event(request: HttpRequest, event_id: str):
    user = require_user(request)
    try:
        event = _editable(user, event_id)
    except HttpError as e:
        if e.status_code == 403:
            raise HttpError(403, "Only the office, or whoever added it, can remove an event.")
        raise
    event.delete()
    return {"ok": True}


@api.get("/notifications", auth=session_auth)
def notifications(
    request: HttpRequest,
    section: Optional[str] = None,
    unread: bool = False,
    limit: int = 50,
):
    """The bell's rows, newest first, less every kind the person switched off.

    `section` is the bell's tab (papers, people, work, updates); `unread`
    keeps only what has not been read.
    """
    from core.services import notify as notify_service

    user = require_user(request)
    qs = notify_service.visible_to(user)
    if section in notify_service.SECTIONS:
        qs = notify_service.in_section(qs, section)
    if unread:
        qs = qs.filter(read=False)
    items = list(qs.order_by("-created_at")[: max(1, min(limit, 200))])
    # "Approved for payment" and "Paid" are the moments a claimant has a paper
    # worth telling colleagues about, so those two offer "Share to the feed" --
    # for their own filed paper only (`social.published_papers`). Rows from
    # before alerts had kinds are recognised by their title.
    from core.social import published_papers

    shareable_titles = (" · Approved for payment", " · Paid")
    shareable_kinds = ("claim_approved", "claim_paid")

    def offers_share(n) -> bool:
        return bool(n.claim_id) and (n.kind in shareable_kinds or n.title.endswith(shareable_titles))

    candidates = {n.claim_id for n in items if offers_share(n)}
    shareable = set(
        published_papers(user).filter(pk__in=candidates).values_list("id", flat=True)
    ) if candidates else set()
    return [
        {
            **notify_service.serialize(n),
            "share_paper_id": n.claim_id if offers_share(n) and n.claim_id in shareable else None,
        }
        for n in items
    ]


@api.get("/notifications/unread-count", auth=session_auth)
def notifications_unread_count(request: HttpRequest):
    """The 45-second poll only needs this number — the full list loads when
    the bell is actually opened."""
    from core.services import notify as notify_service

    user = require_user(request)
    return {"unread": notify_service.visible_to(user).filter(read=False).count()}


@api.post("/notifications/{note_id}/read", auth=session_auth)
def notification_read(request: HttpRequest, note_id: str):
    user = require_user(request)
    note = get_object_or_404(Notification, pk=note_id, user=user)
    if not note.read:
        note.read = True
        note.save(update_fields=["read"])
    return {"ok": True}


@api.post("/notifications/read-all", auth=session_auth)
def notifications_read_all(request: HttpRequest):
    user = require_user(request)
    Notification.objects.filter(user=user, read=False).update(read=True)
    return {"ok": True}




__all__ = [
    'EventIn',
    '_event_dict',
    '_visible_events',
    'create_event',
    'delete_event',
    'list_events',
    'notification_read',
    'notifications',
    'notifications_read_all',
    'notifications_unread_count',
    'update_event',
]
