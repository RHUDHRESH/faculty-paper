"""the calendar.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.common import require_user
from core.api.discussions import _write_post

from datetime import date, datetime, time, timedelta
from typing import Any, Optional
from django.db.models import Exists, OuterRef, Q
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core.models import (
    CalendarEvent,
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
from core.services import rbac
from core.services.record_dates import filing_recorded, ledger_month_recorded

# ---------- the calendar ----------


class EventIn(Schema):
    title: str
    kind: str = "OTHER"
    starts_on: str
    ends_on: Optional[str] = None
    description: Optional[str] = None
    visibility: str = "PUBLIC"
    department: Optional[str] = None
    thread_id: Optional[str] = None
    claim_id: Optional[str] = None


def _event_dict(e: CalendarEvent) -> dict[str, Any]:
    return {
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
    condition = Q(visibility=Thread.Visibility.PUBLIC)
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
    qs = _visible_events(user).select_related("created_by")

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
    }


RECORD_KINDS = {"PAID": "Payments made", "PUBLISHED": "Published", "FILED": "Filed"}


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


@api.post("/calendar", auth=session_auth)
def create_event(request: HttpRequest, payload: EventIn):
    user = require_user(request)
    title = (payload.title or "").strip()
    if len(title) < 3:
        raise HttpError(400, "Give the event a title.")
    if payload.kind not in CalendarEvent.Kind.values:
        raise HttpError(400, f"Kind must be one of: {', '.join(CalendarEvent.Kind.values)}.")

    refusal = discussions.check_visibility(user, payload.visibility, payload.department)
    if refusal:
        raise HttpError(403 if "only" in refusal.lower() else 400, refusal)

    try:
        starts = date.fromisoformat(payload.starts_on)
        ends = date.fromisoformat(payload.ends_on) if payload.ends_on else None
    except (TypeError, ValueError):
        raise HttpError(400, "Dates must look like 2026-03-01")
    if ends and ends < starts:
        raise HttpError(400, "It cannot end before it starts.")

    thread = Thread.objects.filter(pk=payload.thread_id).first() if payload.thread_id else None
    if thread and not discussions.may_read(user, thread):
        raise HttpError(404, "No such thread")

    event = CalendarEvent.objects.create(
        title=title,
        kind=payload.kind,
        starts_on=starts,
        ends_on=ends,
        description=(payload.description or "").strip() or None,
        visibility=payload.visibility,
        department=(payload.department or "").strip() or None
        if payload.visibility == Thread.Visibility.DEPARTMENT
        else None,
        thread=thread,
        claim=Claim.objects.filter(pk=payload.claim_id).first() if payload.claim_id else None,
        created_by=user,
    )

    # An event that came out of a thread is recorded in it, so the decision
    # and the date do not live in two places that can disagree.
    if thread:
        _write_post(
            thread, None,
            f"📅 **{title}** — {starts.isoformat()}"
            + (f" to {ends.isoformat()}" if ends else ""),
            kind=Post.Kind.SYSTEM,
        )

    return _event_dict(event)


@api.patch("/calendar/{event_id}", auth=session_auth)
def update_event(request: HttpRequest, event_id: str, payload: EventIn):
    user = require_user(request)
    event = get_object_or_404(CalendarEvent, pk=event_id)
    if event.created_by_id != user.id and not discussions.is_office(user.role):
        raise HttpError(403, "Only the office, or whoever added it, can change an event.")
    try:
        event.starts_on = date.fromisoformat(payload.starts_on)
        event.ends_on = date.fromisoformat(payload.ends_on) if payload.ends_on else None
    except (TypeError, ValueError):
        raise HttpError(400, "Dates must look like 2026-03-01")
    if event.ends_on and event.ends_on < event.starts_on:
        raise HttpError(400, "It cannot end before it starts.")
    event.title = (payload.title or event.title).strip()
    event.kind = payload.kind
    event.description = (payload.description or "").strip() or None
    event.save()
    return _event_dict(event)


@api.delete("/calendar/{event_id}", auth=session_auth)
def delete_event(request: HttpRequest, event_id: str):
    user = require_user(request)
    event = get_object_or_404(CalendarEvent, pk=event_id)
    if event.created_by_id != user.id and not discussions.is_office(user.role):
        raise HttpError(403, "Only the office, or whoever added it, can remove an event.")
    event.delete()
    return {"ok": True}


@api.get("/notifications", auth=session_auth)
def notifications(request: HttpRequest):
    user = require_user(request)
    items = Notification.objects.filter(user=user).order_by("-created_at")[:50]
    return [
        {
            "id": n.id,
            "title": n.title,
            "body": n.body,
            "href": n.href,
            "read": n.read,
            "created_at": n.created_at.isoformat(),
        }
        for n in items
    ]


@api.get("/notifications/unread-count", auth=session_auth)
def notifications_unread_count(request: HttpRequest):
    """The 45-second poll only needs this number — the full list loads when
    the bell is actually opened."""
    user = require_user(request)
    return {"unread": Notification.objects.filter(user=user, read=False).count()}


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
