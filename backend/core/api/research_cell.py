"""The research cell's desk tools: the journal watch-list and the monthly
processing report.

Both open to whoever may clear claims (`rbac.can_clear_claims`). The report
counts what left the clearing desk in a month from the ClaimAction history,
the same rows the ticket's own history shows, so the two never disagree.
"""

from __future__ import annotations

from core.services.cell_safe import csv_writer
import csv
import io
from datetime import date, datetime, time
from statistics import median
from typing import Optional

from django.db.models import Q
from django.http import HttpRequest, HttpResponse
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import _csv_row, api, require_user, session_auth
from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, JournalWatch
from core.services import rbac
from core.services.journal_watch import watch_dict
from core.services.normalize import normalize_issn


def _desk_user(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Only the research office can use this.")
    return user


# --------------------------------------------------------------------------
# Journal watch-list
# --------------------------------------------------------------------------


class WatchIn(Schema):
    issn: Optional[str] = None
    title: Optional[str] = None
    reason: str


def _claims_in(w: JournalWatch):
    """Every filed claim in the watched journal (ISSN when the entry has one,
    else the title, ignoring case), the same match `watch_for` makes."""
    qs = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    issn = normalize_issn(w.issn) if w.issn else None
    if issn:
        return qs.filter(Q(issn=issn) | Q(issn=w.issn))
    if w.title:
        return qs.filter(journal_title__iexact=w.title.strip())
    return qs.none()


def _open_in(w: JournalWatch) -> int:
    return _claims_in(w).filter(status=ClaimStatus.SUBMITTED).count()


def _watch_row(w: JournalWatch, viewer) -> dict:
    """A watch-list entry with why it is there and which claims it touches."""
    from core.api.flags import _erp_origin
    from core.services import coordination as coord

    now = timezone.now()
    every = _claims_in(w)
    waiting = list(
        every.filter(status=ClaimStatus.SUBMITTED)
        .exclude(owner=viewer)
        .select_related("owner")
        .order_by("submitted_at", "created_at")[:10]
    )
    titles = sorted(
        {t for t in every.exclude(journal_title__isnull=True).values_list("journal_title", flat=True).distinct()[:20] if t}
    )
    return {
        **watch_dict(w),
        "waiting": every.filter(status=ClaimStatus.SUBMITTED).count(),
        "claims_total": every.count(),
        "claims_paid": every.filter(status=ClaimStatus.PAID).count(),
        "journal_titles": titles,
        "waiting_claims": [
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "origin": _erp_origin(c.ticket_number),
                "paper_title": c.paper_title,
                "owner_name": c.owner.name,
                "waiting_days": coord._days(coord._arrival(c, {}), now),
            }
            for c in waiting
        ],
    }


@api.get("/admin/journal-watch", auth=session_auth)
def journal_watch_list(request: HttpRequest):
    """Every watched journal, newest first: why it is watched, who added it,
    how many claims are waiting in it now (with the first ten) and how many
    the college has ever filed there."""
    user = _desk_user(request)
    rows = JournalWatch.objects.select_related("added_by").order_by("-created_at")
    return [_watch_row(w, user) for w in rows]


@api.get("/admin/journal-watch/for", auth=session_auth)
def journal_watch_for(request: HttpRequest, title: Optional[str] = None, issn: Optional[str] = None):
    """The watch-list entry a journal falls under, or null. For a journal's
    own page, so it can say why it is watched."""
    from core.services.journal_watch import watch_for

    user = _desk_user(request)
    hit = watch_for(issn, title)
    if not hit:
        return None
    w = JournalWatch.objects.select_related("added_by").filter(id=hit["id"]).first()
    return _watch_row(w, user) if w else None


@api.post("/admin/journal-watch", auth=session_auth)
def journal_watch_add(request: HttpRequest, payload: WatchIn):
    user = _desk_user(request)
    issn = (payload.issn or "").strip()
    title = (payload.title or "").strip()
    reason = (payload.reason or "").strip()
    if not issn and not title:
        raise HttpError(400, "Give the journal's ISSN or its title.")
    if not reason:
        raise HttpError(400, "Say why this journal is on the watch-list.")
    clean = normalize_issn(issn) if issn else None
    if issn and not clean:
        raise HttpError(400, "That ISSN is not in the form 1234-5678.")
    if clean and JournalWatch.objects.filter(issn=clean).exists():
        raise HttpError(409, "This ISSN is already on the watch-list.")
    w = JournalWatch.objects.create(
        issn=clean, title=title[:512] or None, reason=reason[:2000], added_by=user
    )
    AuditLog.objects.create(
        actor=user, action="JOURNAL_WATCH_ADD", entity="JournalWatch", entity_id=w.id,
        detail_json=f'{{"issn": "{clean or ""}"}}',
    )
    return _watch_row(w, user)


@api.delete("/admin/journal-watch/{watch_id}", auth=session_auth)
def journal_watch_remove(request: HttpRequest, watch_id: str):
    user = _desk_user(request)
    w = JournalWatch.objects.filter(id=watch_id).first()
    if w is None:
        raise HttpError(404, "Not on the watch-list.")
    w.delete()
    AuditLog.objects.create(
        actor=user, action="JOURNAL_WATCH_REMOVE", entity="JournalWatch", entity_id=watch_id,
    )
    return {"id": watch_id, "removed": True}


# --------------------------------------------------------------------------
# Monthly processing report
# --------------------------------------------------------------------------


def _month_bounds(month: Optional[str]) -> tuple[str, datetime, datetime]:
    today = timezone.localdate()
    if month:
        try:
            y, m = (int(p) for p in month.split("-", 1))
            first = date(y, m, 1)
        except (ValueError, TypeError):
            raise HttpError(400, "Month is YYYY-MM.")
    else:
        first = today.replace(day=1)
    nxt = date(first.year + (first.month == 12), first.month % 12 + 1, 1)
    tz = timezone.get_current_timezone()
    return (
        f"{first.year:04d}-{first.month:02d}",
        timezone.make_aware(datetime.combine(first, time.min), tz),
        timezone.make_aware(datetime.combine(nxt, time.min), tz),
    )


def _age_bucket(days: int) -> str:
    if days <= 7:
        return "a week or less"
    if days <= 14:
        return "8 to 14 days"
    if days <= 30:
        return "15 to 30 days"
    return "over 30 days"


AGE_BUCKETS = ["a week or less", "8 to 14 days", "15 to 30 days", "over 30 days"]


def clearing_report(month: Optional[str]) -> dict:
    label, start, end = _month_bounds(month)
    received = Claim.objects.filter(submitted_at__gte=start, submitted_at__lt=end).count()
    acts = (
        ClaimAction.objects.filter(
            from_status=ClaimStatus.SUBMITTED, created_at__gte=start, created_at__lt=end
        )
        .select_related("claim", "actor")
        .order_by("created_at")
    )
    cleared = sent_back = rejected = 0
    amount_cleared = 0.0
    turnaround: list[float] = []
    by_person: dict[str, dict] = {}
    rows = []
    for a in acts:
        if a.to_status == ClaimStatus.CLEARED:
            kind = "Cleared"
            cleared += 1
            amount_cleared += a.claim.remuneration or 0
        elif a.to_status == ClaimStatus.REJECTED:
            if a.action == "REJECT_OUTRIGHT":
                kind = "Not accepted"
                rejected += 1
            else:
                kind = "Sent back"
                sent_back += 1
        else:
            continue
        days = None
        if a.claim.submitted_at:
            days = max(0.0, (a.created_at - a.claim.submitted_at).total_seconds() / 86400)
            turnaround.append(days)
        p = by_person.setdefault(
            a.actor_id, {"name": a.actor.name, "cleared": 0, "sent_back": 0, "not_accepted": 0}
        )
        p[{"Cleared": "cleared", "Sent back": "sent_back", "Not accepted": "not_accepted"}[kind]] += 1
        rows.append(
            {
                "date": timezone.localtime(a.created_at).date().isoformat(),
                "ticket": a.claim.ticket_number or a.claim.id,
                "claim_id": a.claim.id,
                "title": a.claim.paper_title,
                "claimant": a.claim.owner.name if a.claim.owner_id else "",
                "department": a.claim.owner.department if a.claim.owner_id else "",
                "outcome": kind,
                "by": a.actor.name,
                "days_taken": round(days, 1) if days is not None else None,
                "amount": a.claim.remuneration if kind == "Cleared" else None,
                "note": a.note or "",
            }
        )
    now = timezone.now()
    ageing = {b: 0 for b in AGE_BUCKETS}
    waiting = Claim.objects.filter(status=ClaimStatus.SUBMITTED).only("submitted_at", "created_at")
    for c in waiting:
        since = c.submitted_at or c.created_at
        ageing[_age_bucket((now - since).days if since else 0)] += 1
    return {
        "month": label,
        "received": received,
        "cleared": cleared,
        "sent_back": sent_back,
        "not_accepted": rejected,
        "amount_cleared": round(amount_cleared, 2),
        "median_days": round(median(turnaround), 1) if turnaround else None,
        "within_week": sum(1 for d in turnaround if d <= 7),
        "decided": len(turnaround),
        "by_person": sorted(by_person.values(), key=lambda p: -(p["cleared"] + p["sent_back"] + p["not_accepted"])),
        "waiting_now": sum(ageing.values()),
        "ageing": [{"bucket": b, "count": ageing[b]} for b in AGE_BUCKETS],
        "rows": rows,
    }


@api.get("/admin/clearing-report", auth=session_auth)
def admin_clearing_report(request: HttpRequest, month: Optional[str] = None, format: Optional[str] = None):
    """What the clearing desk did in one month (default: this month): received,
    cleared, sent back, not accepted, median days from filing to decision,
    per person, and how long the tickets still waiting have waited.
    `format=csv` gives one row per decision."""
    _desk_user(request)
    body = clearing_report(month)
    if format != "csv":
        return body
    buf = io.StringIO()
    w = csv_writer(buf)
    w.writerow(["Date", "Ticket", "Title", "Claimant", "Department", "Outcome", "By", "Days taken", "Amount", "Note"])
    for r in body["rows"]:
        w.writerow(_csv_row([r["date"], r["ticket"], r["title"], r["claimant"], r["department"], r["outcome"], r["by"],
                    r["days_taken"] if r["days_taken"] is not None else "",
                    f"{r['amount']:.2f}" if r["amount"] is not None else "", r["note"]]))
    w.writerow([])
    w.writerow(["Received", body["received"]])
    w.writerow(["Cleared", body["cleared"]])
    w.writerow(["Sent back", body["sent_back"]])
    w.writerow(["Not accepted", body["not_accepted"]])
    w.writerow(["Median days to decide", body["median_days"] if body["median_days"] is not None else ""])
    res = HttpResponse(("﻿" + buf.getvalue()).encode("utf-8"), content_type="text/csv; charset=utf-8")
    res["Content-Disposition"] = f'attachment; filename="clearing-{body["month"]}.csv"'
    return res


# --------------------------------------------------------------------------
# The desk's Home: what to do first today
# --------------------------------------------------------------------------

#: A claim this close to the service level is today's work, not tomorrow's.
DUE_SOON_DAYS = 1


def _desk_row(c: Claim, now: datetime) -> dict:
    """One waiting claim as Home draws it: no amount, no flag detail."""
    from core.api.flags import _erp_origin
    from core.services import coordination as coord
    from core.services.journal_watch import watch_for

    days = coord._days(coord._arrival(c, {}), now)
    watch = watch_for(c.issn, c.journal_title)
    return {
        "id": c.id,
        "ticket_number": c.ticket_number,
        "origin": _erp_origin(c.ticket_number),
        "paper_title": c.paper_title,
        "journal_title": c.journal_title,
        "owner_id": c.owner_id,
        "owner_name": c.owner.name,
        "owner_department": c.owner.department,
        "waiting_days": days,
        "on_hold": c.on_hold,
        "watched_reason": watch["reason"] if watch else None,
        "assigned_to": coord.assignee_dict(c),
    }


@api.get("/cell/today", auth=session_auth)
def cell_today(request: HttpRequest):
    """What the first desk does first today, in one request.

    Mine (given to the viewer) then the rest, oldest first; how many decisions
    keep the desk inside its service level today and how many the viewer has
    made; and the claims that came back to the desk (fixed by the claimant, or
    returned by the Principal) so they do not hide among brand-new ones.
    Never the viewer's own claim.
    """
    from core.models import ClaimFlag
    from core.services import coordination as coord
    from core.services import legacy

    user = _desk_user(request)
    now = timezone.now()
    sla = coord.SLA_DAYS
    desk = list(
        Claim.objects.filter(status=ClaimStatus.SUBMITTED)
        .exclude(owner=user)
        .select_related("owner", "assigned_to")
        .order_by("submitted_at", "created_at")
    )
    rows = [_desk_row(c, now) for c in desk]
    mine = [r for r in rows if r["assigned_to"] and r["assigned_to"]["user_id"] == user.id]
    mine_ids = {r["id"] for r in mine}
    rest = [r for r in rows if r["id"] not in mine_ids]

    past = sum(1 for r in rows if r["waiting_days"] > sla)
    due = sum(1 for r in rows if sla - DUE_SOON_DAYS <= r["waiting_days"] <= sla)
    start = timezone.make_aware(
        datetime.combine(timezone.localdate(), time.min), timezone.get_current_timezone()
    )
    todays = ClaimAction.objects.filter(
        from_status=ClaimStatus.SUBMITTED,
        to_status__in=[ClaimStatus.CLEARED, ClaimStatus.REJECTED],
        created_at__gte=start,
    )
    decided_by_me = todays.filter(actor=user).count()
    decided_by_desk = todays.count()

    # Came back: the latest thing that happened to a waiting claim was the
    # claimant fixing it, or the Principal returning it.
    came_back = []
    seen: set[str] = set()
    told: dict[str, str] = {}
    by_id = {r["id"]: r for r in rows}
    for a in (
        ClaimAction.objects.filter(claim_id__in=list(by_id)).select_related("actor").order_by("-created_at", "-id")
    ):
        if a.to_status == ClaimStatus.REJECTED and a.claim_id not in told and a.note:
            told[a.claim_id] = a.note
        if a.claim_id in seen:
            continue
        seen.add(a.claim_id)
        if a.action in ("RESUBMIT", "PRINCIPAL_SEND_BACK"):
            came_back.append((a, by_id[a.claim_id]))
    back_rows = []
    for a, r in came_back:
        fixed = a.action == "RESUBMIT"
        back_rows.append(
            {
                **r,
                "kind": "fixed" if fixed else "returned",
                "since_days": max(0, (now - a.created_at).days),
                # What the claimant was told (for a fix), or what the Principal
                # said (for a return).
                "note": (told.get(a.claim_id) if fixed else a.note) or None,
                "by_name": None if fixed else a.actor.name,
            }
        )
    back_rows.sort(key=lambda r: r["since_days"])

    others = ClaimFlag.objects.exclude(claim__owner=user).filter(resolved_at__isnull=True)
    watched_waiting = sum(1 for r in rows if r["watched_reason"])
    month = clearing_report(None)
    return {
        "sla_days": sla,
        "desk_open": len(rows),
        "mine_count": len(mine),
        "unassigned": sum(1 for r in rows if not r["assigned_to"]),
        "past_sla": past,
        "held": sum(1 for r in rows if r["on_hold"]),
        "target": {
            "due": due + past,
            "past": past,
            "due_soon": due,
            "decided_by_me": decided_by_me,
            "decided_by_desk": decided_by_desk,
        },
        "mine": mine[:8],
        "rest": rest[:8],
        "came_back": back_rows[:8],
        "came_back_count": len(back_rows),
        "watched_waiting": watched_waiting,
        "flags": {
            "open": others.count(),
            "open_on_paid": others.filter(claim__status=ClaimStatus.PAID).count(),
            # Open on claims already paid or closed in the old system: still
            # listed, but nobody's work today.
            "legacy": others.filter(legacy.claim_q("claim__")).count(),
        },
        "month": {k: month[k] for k in ("month", "received", "cleared", "sent_back", "not_accepted", "median_days", "within_week", "decided")},
    }


__all__ = [
    "cell_today",
    "journal_watch_list",
    "journal_watch_for",
    "journal_watch_add",
    "journal_watch_remove",
    "admin_clearing_report",
]
