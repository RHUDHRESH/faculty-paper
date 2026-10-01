"""Research faculty and their yearly rupee threshold.

Research faculty are already paid to do research, so the first part of the
incentives they earn each year is not paid. The research coordinator or a
super admin sets that amount per person ("₹3 lakh a year"); every decision is
kept with who made it, when it takes effect and why. The person sees their own
threshold and how much of it is used (`/me/research-threshold`).

The rule itself lives in core.services.research_threshold so that every screen
that shows or moves an amount agrees.
"""
from __future__ import annotations

import json
from datetime import date
from typing import Optional

from django.db import transaction
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, ResearchThreshold, Role, User
from core.services import rbac, research_threshold as rt
from core.services.notify import GENERAL, notify

#: A generous ceiling: a threshold is a number of lakhs, and a slipped digit
#: should be refused rather than accepted.
MAX_THRESHOLD = 10_00_00_000  # ten crore


class ThresholdIn(Schema):
    #: Rupees a year. Empty clears it (the person is then treated as regular
    #: faculty and the coordinator is warned).
    amount: Optional[float] = None
    #: The day it takes effect; today when left out.
    effective_from: Optional[date] = None
    note: Optional[str] = None


def _setter(request: HttpRequest) -> User:
    user = require_user(request)
    if not rbac.can_set_research_threshold(user.role):
        raise HttpError(403, "Only the research coordinator or a super admin can set a research threshold.")
    return user


def _row(u: User) -> dict:
    s = rt.summary(u)
    latest = s["history"][0] if s.get("history") else None
    return {
        "user_id": u.id,
        "name": u.name,
        "department": u.department,
        "designation": u.designation,
        "threshold": s["threshold"],
        "unset": s["unset"],
        "used": s["used"],
        "left": s["left"],
        "on_the_way": s["on_the_way"],
        "on_the_way_above": s["on_the_way_above"],
        "year": s["year"],
        "old_quota": u.research_quota,
        "old_quota_note": u.research_quota_note,
        "needs_rupee_threshold": s["needs_rupee_threshold"],
        "set_by": latest["set_by"] if latest else None,
        "set_at": latest["set_at"] if latest else None,
        "effective_from": latest["effective_from"] if latest else None,
        "note": latest["note"] if latest else None,
    }


@api.get("/research-faculty", auth=session_auth)
def research_faculty_list(request: HttpRequest):
    """Every research faculty member, their threshold and what is left of it."""
    _setter(request)
    people = User.objects.filter(active=True, faculty_type="RESEARCH").order_by("name")
    rows = [_row(u) for u in people]
    start, end = rt.year_bounds(rt.today())
    return {
        "year": rt.year_label(start),
        "year_start": start.isoformat(),
        "year_end": end.isoformat(),
        "count": len(rows),
        "unset_count": sum(1 for r in rows if r["unset"]),
        "old_rule_count": sum(1 for r in rows if r["needs_rupee_threshold"]),
        "rows": rows,
    }


@api.get("/research-faculty/{user_id}/threshold", auth=session_auth)
def research_threshold_detail(request: HttpRequest, user_id: str):
    """One person's threshold, this year's use and the history of decisions."""
    _setter(request)
    u = get_object_or_404(User, pk=user_id)
    return rt.summary(u) if u.faculty_type == "RESEARCH" else {"research": False, "history": [
        {
            "id": r.id, "amount": r.amount, "effective_from": r.effective_from.isoformat(),
            "note": r.note, "set_by": r.set_by.name if r.set_by else None,
            "set_at": r.created_at.isoformat(),
        }
        for r in rt.history(u.id)
    ]}


@api.put("/research-faculty/{user_id}/threshold", auth=session_auth)
def research_threshold_set(request: HttpRequest, user_id: str, payload: ThresholdIn):
    """Set (or clear) a research faculty member's yearly rupee threshold."""
    actor = _setter(request)
    u = get_object_or_404(User, pk=user_id)
    if u.id == actor.id:
        # A threshold decides how much of your own incentive is paid.
        raise HttpError(403, "You cannot set your own research threshold. Ask another officer or the super admin.")
    if u.faculty_type != "RESEARCH":
        raise HttpError(400, "This person is not research faculty. Tick research faculty first.")
    amount = payload.amount
    if amount is not None:
        if amount < 0:
            raise HttpError(400, "A threshold cannot be negative.")
        if amount > MAX_THRESHOLD:
            raise HttpError(400, "That is more than ₹10 crore a year. Check the number of zeros.")
        amount = round(amount, 2)
    note = (payload.note or "").strip()[:500] or None
    when = payload.effective_from or rt.today()
    before = rt.threshold_on(rt.history(u.id), rt.today())
    with transaction.atomic():
        row = ResearchThreshold.objects.create(
            user=u, amount=amount, effective_from=when, note=note, set_by=actor
        )
        AuditLog.objects.create(
            actor=actor,
            action="RESEARCH_THRESHOLD_SET",
            entity="User",
            entity_id=u.id,
            detail_json=json.dumps({
                "from": before, "to": amount, "effective_from": when.isoformat(), "note": note,
            }),
        )
        # Open claims are worth different amounts under the new threshold.
        rt.refresh_open_claims(u)
    if amount is not None and u.id != actor.id and when <= rt.today():
        notify(
            u, GENERAL,
            "Your research threshold was set",
            f"Your research threshold is {rt.inr(amount)} a year. Incentives are paid once "
            "your approved and paid incentives in the year go past it.",
            "/",
        )
    return {"id": row.id, **rt.summary(u)}


@api.get("/me/research-threshold", auth=session_auth)
def my_research_threshold(request: HttpRequest):
    """Your own threshold, what is used and what is left. Research faculty only."""
    user = require_user(request)
    s = rt.summary(user)
    if s.get("research"):
        # The history names who set it; the person needs the amounts and the
        # reasons, not the desk. Same rule as everywhere faculty read.
        s["history"] = [
            {"amount": h["amount"], "effective_from": h["effective_from"], "note": h["note"]}
            for h in s["history"]
        ]
    return s
