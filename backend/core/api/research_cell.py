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
        raise HttpError(403, "Only the research cell can use this.")
    return user


# --------------------------------------------------------------------------
# Journal watch-list
# --------------------------------------------------------------------------


class WatchIn(Schema):
    issn: Optional[str] = None
    title: Optional[str] = None
    reason: str


def _open_in(w: JournalWatch) -> int:
    qs = Claim.objects.filter(status=ClaimStatus.SUBMITTED)
    issn = normalize_issn(w.issn) if w.issn else None
    if issn:
        return qs.filter(Q(issn=issn) | Q(issn=w.issn)).count()
    if w.title:
        return qs.filter(journal_title__iexact=w.title.strip()).count()
    return 0


@api.get("/admin/journal-watch", auth=session_auth)
def journal_watch_list(request: HttpRequest):
    """Every watched journal, newest first, with how many tickets in it are
    waiting at the clearing desk now."""
    _desk_user(request)
    rows = JournalWatch.objects.select_related("added_by").order_by("-created_at")
    return [{**watch_dict(w), "waiting": _open_in(w)} for w in rows]


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
    return {**watch_dict(w), "waiting": _open_in(w)}


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


__all__ = [
    "journal_watch_list",
    "journal_watch_add",
    "journal_watch_remove",
    "admin_clearing_report",
]
