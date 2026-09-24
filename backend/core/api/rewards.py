"""Badges, celebrations, goals, the impact card and the wall of fame.

Everything here is about work people have already done, and everything here
may be seen by people other than its owner -- a colleague looking at a badge
shelf, a head reading the department's goals, anybody at all holding a shared
card's link. So none of it carries money, and the records it is built from
(`core.services.records`) never read an amount in the first place.

Three kinds of visibility:

- **Anyone signed in**: a person's badges, the wall of fame.
- **The person themselves**: their celebrations, their goals, their card.
  A head sees the department's goals as counts and nothing else.
- **Anyone with the link**, signed in or not: a shared impact card, while its
  owner has sharing turned on. Off, the page and its image are a plain 404.
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from collections import defaultdict
from datetime import date
from typing import Any, Optional

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.http import Http404, HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.html import escape
from ninja import Schema
from ninja.errors import HttpError

from core import hod
from core.api.common import api, rate_limit, require_user, session_auth
from core.api.hod_planning import _acting_department
from core.models import (
    AuditLog,
    Badge,
    Celebration,
    ImpactShare,
    ResearchGoal,
    Role,
    User,
    WallPin,
)
from core.services import achievements, impact_card, records

# ---------- badges ----------


def _catalogue() -> list[dict[str, str]]:
    return [
        {"kind": kind, "label": label, "description": description}
        for kind, (label, description) in achievements.CATALOGUE.items()
    ]


@api.get("/me/badges", auth=session_auth)
def my_badges(request: HttpRequest):
    user = require_user(request)
    return {
        "badges": [
            achievements.badge_dict(b, for_owner=True)
            for b in Badge.objects.filter(user=user)
        ],
        "catalogue": _catalogue(),
    }


@api.get("/users/{user_id}/badges", auth=session_auth)
def user_badges(request: HttpRequest, user_id: str):
    """Somebody's badge shelf, as any colleague may see it."""
    viewer = require_user(request)
    person = get_object_or_404(User, pk=user_id)
    return {
        "user": {"id": person.id, "name": person.name, "department": person.department},
        "badges": [
            achievements.badge_dict(b, for_owner=person.id == viewer.id)
            for b in Badge.objects.filter(user=person)
        ],
        "catalogue": _catalogue(),
    }


@api.post("/admin/badges/run", auth=session_auth)
def run_badges(request: HttpRequest):
    """Run the hourly job now. Super admin only; safe to repeat."""
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Forbidden")
    return achievements.run_all()


# ---------- celebrations ----------


class SeenIn(Schema):
    ids: list[str] = []


def _celebration_dict(c: Celebration) -> dict[str, Any]:
    return {
        "id": c.id,
        "kind": c.kind,
        "title": c.title,
        "body": c.body,
        "created_at": c.created_at.isoformat(),
        "badge": achievements.badge_dict(c.badge, for_owner=True) if c.badge_id else None,
    }


@api.get("/me/celebrations", auth=session_auth)
def my_celebrations(request: HttpRequest):
    """What is waiting to be celebrated on this person's home screen."""
    user = require_user(request)
    rows = (
        Celebration.objects.filter(user=user, seen_at__isnull=True)
        .select_related("badge")
        .order_by("created_at")[:6]
    )
    return {"celebrations": [_celebration_dict(c) for c in rows]}


@api.post("/me/celebrations/seen", auth=session_auth)
def mark_celebrations_seen(request: HttpRequest, payload: SeenIn):
    """Shown once: marked the moment the screen has shown it."""
    user = require_user(request)
    marked = Celebration.objects.filter(
        user=user, id__in=payload.ids[:50], seen_at__isnull=True
    ).update(seen_at=timezone.now())
    return {"ok": True, "marked": marked}


# ---------- goals ----------

_METRICS = {m.value: m.label for m in ResearchGoal.Metric}
MAX_GOAL = 1000


class GoalItem(Schema):
    metric: str
    target: int


class GoalsIn(Schema):
    year: int
    goals: list[GoalItem]


def _progress(recs: list[records.PaperRecord], all_recs: list[records.PaperRecord], metric: str):
    """How far along a goal is: this year's papers, or citations to date."""
    if metric == ResearchGoal.Metric.Q1:
        return sum(1 for r in recs if r.quartile == "Q1")
    if metric == ResearchGoal.Metric.FIRST_AUTHOR:
        return sum(1 for r in recs if r.first_author)
    if metric == ResearchGoal.Metric.CITATIONS:
        known = [r.citations for r in all_recs if r.citations is not None]
        return sum(known) if known else None
    return len(recs)


def _goal_row(metric: str, target: int, done: Optional[int], *, built_in=False, label=None):
    return {
        "metric": metric,
        "label": label or _METRICS.get(metric, metric),
        "target": target,
        "done": done,
        "available": done is not None,
        "fraction": round(done / target, 4) if done is not None and target else None,
        "met": done is not None and done >= target,
        "built_in": built_in,
    }


def _this_year() -> int:
    return timezone.localdate().year


@api.get("/me/goals", auth=session_auth)
def my_goals(request: HttpRequest, year: Optional[int] = None):
    """A person's own goals for a year, with where each one stands."""
    user = require_user(request)
    year = year or _this_year()
    all_recs = records.paper_records([user])[user.id]
    recs = [r for r in all_recs if r.year == year]

    rows = []
    if user.faculty_type == "RESEARCH" and user.research_quota:
        # The quota is agreed, not chosen, so it sits first and cannot be
        # edited here -- the research coordinator sets it.
        rows.append(_goal_row(
            ResearchGoal.Metric.PAPERS, user.research_quota, len(recs),
            built_in=True, label="Research quota",
        ))
    for g in ResearchGoal.objects.filter(user=user, year=year):
        rows.append(_goal_row(g.metric, g.target, _progress(recs, all_recs, g.metric)))

    years = set(ResearchGoal.objects.filter(user=user).values_list("year", flat=True))
    years |= {_this_year(), year}
    return {
        "year": year,
        "years": sorted(years, reverse=True),
        "goals": rows,
        "metrics": [{"key": k, "label": v} for k, v in _METRICS.items()],
        "citations_available": any(r.citations is not None for r in all_recs),
    }


@api.put("/me/goals", auth=session_auth)
def set_my_goals(request: HttpRequest, payload: GoalsIn):
    """Set this year's goals. A target of 0 takes a goal away."""
    user = require_user(request)
    now = _this_year()
    if not now - 1 <= payload.year <= now + 1:
        raise HttpError(400, f"Goals can be set for {now - 1} to {now + 1}.")
    for item in payload.goals:
        if item.metric not in _METRICS:
            raise HttpError(400, f"A goal is one of: {', '.join(_METRICS.values())}.")
        if not 0 <= item.target <= MAX_GOAL:
            raise HttpError(400, f"A goal is a number from 0 to {MAX_GOAL}.")
    with transaction.atomic():
        for item in payload.goals:
            if item.target == 0:
                ResearchGoal.objects.filter(user=user, year=payload.year, metric=item.metric).delete()
            else:
                ResearchGoal.objects.update_or_create(
                    user=user, year=payload.year, metric=item.metric,
                    defaults={"target": item.target},
                )
    return my_goals(request, year=payload.year)


@api.get("/hod/goals", auth=session_auth)
def hod_goals(request: HttpRequest, year: Optional[int] = None, department: Optional[str] = None):
    """The department's goals as counts: who set one, and how many are met.

    Never whose goal is whose. A goal is a private intention; a head who could
    read each person's would be reading a to-do list somebody wrote for
    themselves.
    """
    user = require_user(request)
    chosen = _acting_department(user, department)
    year = year or _this_year()
    members = list(User.objects.filter(department__iexact=chosen, active=True))
    goals = list(ResearchGoal.objects.filter(user__in=members, year=year))
    all_recs = records.paper_records(members)

    per_metric: dict[str, dict[str, Any]] = {}
    for g in goals:
        mine = all_recs.get(g.user_id, [])
        done = _progress([r for r in mine if r.year == year], mine, g.metric)
        slot = per_metric.setdefault(g.metric, {
            "metric": g.metric, "label": _METRICS.get(g.metric, g.metric),
            "people": 0, "target_total": 0, "done_total": 0, "met": 0,
        })
        slot["people"] += 1
        slot["target_total"] += g.target
        slot["done_total"] += done or 0
        slot["met"] += 1 if done is not None and done >= g.target else 0

    return hod.without_money({
        "department": chosen,
        "year": year,
        "people_in_department": len(members),
        "people_with_goals": len({g.user_id for g in goals}),
        "metrics": [per_metric[m] for m in _METRICS if m in per_metric],
    })


# ---------- the impact card ----------

_SHARE_PATH = "/api/share/impact/{token}"
#: The rendered PNG is kept this long, keyed on what is drawn on it.
_CARD_CACHE_SECONDS = 600


class ShareIn(Schema):
    enabled: bool


def _share_state(share: Optional[ImpactShare]) -> dict[str, Any]:
    on = bool(share and share.enabled)
    return {
        "enabled": on,
        "token": share.token if share else None,
        "path": _SHARE_PATH.format(token=share.token) if on else None,
    }


def _size(size: Optional[str]) -> str:
    return size if size in impact_card.SIZES else "wide"


def _png(user: User, size: str) -> HttpResponse:
    facts = impact_card.summary(user)
    drawn = hashlib.sha1(json.dumps(facts, sort_keys=True).encode()).hexdigest()
    key = f"impact-card:{user.id}:{size}:{drawn}"
    body = cache.get(key)
    if body is None:
        body = impact_card.render(facts, size)
        cache.set(key, body, _CARD_CACHE_SECONDS)
    response = HttpResponse(body, content_type="image/png")
    response["Cache-Control"] = "no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response


@api.get("/me/impact", auth=session_auth)
def my_impact(request: HttpRequest):
    user = require_user(request)
    share = ImpactShare.objects.filter(user=user).first()
    return {**impact_card.summary(user), "share": _share_state(share)}


@api.get("/me/impact/card.png", auth=session_auth)
def my_impact_card(request: HttpRequest, size: Optional[str] = None):
    user = require_user(request)
    rate_limit(request, "impact-card", 120, "hour", what="card images")
    return _png(user, _size(size))


@api.get("/me/impact/share", auth=session_auth)
def my_impact_share(request: HttpRequest):
    user = require_user(request)
    return _share_state(ImpactShare.objects.filter(user=user).first())


@api.put("/me/impact/share", auth=session_auth)
def set_my_impact_share(request: HttpRequest, payload: ShareIn):
    """Turn the public link on or off. The link stays the same across both."""
    user = require_user(request)
    share = ImpactShare.objects.filter(user=user).first()
    if share is None:
        if not payload.enabled:
            return _share_state(None)
        try:
            share = ImpactShare.objects.create(
                user=user, token=secrets.token_urlsafe(24), enabled=True
            )
        except IntegrityError:  # a double click racing itself
            share = ImpactShare.objects.get(user=user)
    share.enabled = payload.enabled
    share.save(update_fields=["enabled", "updated_at"])
    AuditLog.objects.create(
        actor=user, action="IMPACT_SHARE_ON" if payload.enabled else "IMPACT_SHARE_OFF",
        entity="ImpactShare", entity_id=share.id,
    )
    return _share_state(share)


def _shared(token: str) -> User:
    share = (
        ImpactShare.objects.filter(token=token, enabled=True, user__active=True)
        .select_related("user")
        .first()
    )
    if share is None:
        # One answer for "no such link" and "turned off": the difference is
        # the owner's business.
        raise Http404
    return share.user


@api.get("/share/impact/{token}/card.png")
def shared_impact_card(request: HttpRequest, token: str, size: Optional[str] = None):
    """The card image, for a crawler or anybody holding the link."""
    return _png(_shared(token), _size(size))


@api.get("/share/impact/{token}")
def shared_impact_page(request: HttpRequest, token: str):
    """A plain page with OpenGraph tags, readable without JavaScript.

    LinkedIn and WhatsApp read the tags and never run the app, which is why
    this is HTML from the server rather than a route in the single-page app.
    """
    user = _shared(token)
    facts = impact_card.summary(user)
    image = request.build_absolute_uri(f"{_SHARE_PATH.format(token=token)}/card.png?size=wide")
    page = request.build_absolute_uri(_SHARE_PATH.format(token=token))
    name = escape(facts["name"])
    where = ", ".join(p for p in (facts["department"], facts["college"]) if p)
    papers = facts["papers"]
    line = f"{papers} paper{'s' if papers != 1 else ''}, {facts['q1']} in Q1 journals"
    if facts.get("citations") is not None:
        line += f", {facts['citations']} citations"
    description = escape(f"{line}. {where}.")
    title = f"{name} · Research impact"
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{title}</title>
<meta name="description" content="{description}">
<meta property="og:type" content="profile">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:url" content="{escape(page)}">
<meta property="og:image" content="{escape(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="627">
<meta property="og:image:alt" content="{title}: {description}">
<meta name="twitter:card" content="summary_large_image">
<style>
  :root {{ color-scheme: light dark; font-family: system-ui, sans-serif; }}
  body {{ margin: 0; display: grid; min-height: 100vh; place-items: center; background: #f4f5fb; color: #1b1f33; }}
  main {{ max-width: 960px; padding: 24px; }}
  img {{ width: 100%; height: auto; border-radius: 12px; }}
  p {{ color: #4a5070; line-height: 1.5; }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #10131f; color: #e8eaf6; }} p {{ color: #aab0cc; }} }}
</style>
</head>
<body>
<main>
<img src="{escape(image)}" alt="{title}: {description}" width="1200" height="627">
<h1>{name}</h1>
<p>{description}</p>
</main>
</body>
</html>"""
    response = HttpResponse(html, content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store"
    response["X-Robots-Tag"] = "noindex"
    return response


# ---------- the wall of fame ----------

_MONTH = re.compile(r"^(\d{4})-(\d{2})$")


class PinIn(Schema):
    department: str = ""
    month: str
    key: str


def _month(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    m = _MONTH.match(value.strip())
    if not m or not 1 <= int(m.group(2)) <= 12:
        raise HttpError(400, "A month is written YYYY-MM.")
    return date(int(m.group(1)), int(m.group(2)), 1)


def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _papers() -> dict[str, list[records.PaperRecord]]:
    """Every college paper, grouped across its authors by normalised title."""
    grouped: dict[str, list[records.PaperRecord]] = defaultdict(list)
    for r in records.collect(include_unmatched=True):
        grouped[r.key].append(r)
    return grouped


def _card(key: str, group: list[records.PaperRecord], pinned_key: Optional[str]) -> dict[str, Any]:
    quartiles = [r.quartile for r in group if r.quartile]
    lead = min(group, key=lambda r: (r.claim_id is None, r.on))
    authors: dict[str, dict[str, Any]] = {}
    for r in group:
        who = r.user_id or f"name:{r.author_name.lower()}"
        authors.setdefault(who, {"id": r.user_id, "name": r.author_name, "department": r.department})
    return {
        "key": key,
        "title": lead.title,
        "journal": lead.journal,
        "quartile": min(quartiles) if quartiles else None,
        "year": lead.year,
        "authors": sorted(authors.values(), key=lambda a: a["name"].lower()),
        "pinned": key == pinned_key,
    }


def _wall(department: str, month: Optional[date]) -> dict[str, Any]:
    dept = department.strip().lower()
    by_month: dict[str, list[tuple[str, list[records.PaperRecord]]]] = defaultdict(list)
    for key, group in _papers().items():
        if dept and not any(r.department.lower() == dept for r in group):
            continue
        # A paper appears once, in the month the college first recognised it.
        first = min(r.on for r in group)
        by_month[_month_key(first)].append((key, group))

    months = sorted(by_month, reverse=True)
    chosen = _month_key(month) if month else (months[0] if months else _month_key(timezone.localdate()))
    y, mo = map(int, chosen.split("-"))
    pin = WallPin.objects.filter(department__iexact=department.strip(), month=date(y, mo, 1)).first()
    pinned_key = pin.paper_key if pin else None

    cards = [_card(k, g, pinned_key) for k, g in by_month.get(chosen, [])]
    order = {"Q1": 0, "Q2": 1, "Q3": 2, "Q4": 3}
    cards.sort(key=lambda c: (not c["pinned"], order.get(c["quartile"] or "", 4), c["title"].lower()))
    return {
        "department": department.strip(),
        "month": chosen,
        "months": [{"month": m, "count": len(by_month[m])} for m in months],
        "pinned": next((c for c in cards if c["pinned"]), None),
        "cards": cards,
    }


def _departments() -> list[str]:
    seen: dict[str, str] = {}
    for d in User.objects.filter(active=True).exclude(department__isnull=True).values_list("department", flat=True):
        d = (d or "").strip()
        if d and d.lower() not in seen:
            seen[d.lower()] = d
    return sorted(seen.values(), key=str.lower)


@api.get("/wall", auth=session_auth)
def wall(request: HttpRequest, department: str = "", month: Optional[str] = None):
    """A month of new publications, for one department or the whole college."""
    require_user(request)
    return {**_wall(department, _month(month)), "departments": _departments()}


def _may_pin(user: User, department: str) -> bool:
    if user.role == Role.SUPER_ADMIN:
        return True
    if not department.strip():
        return user.role == Role.PRINCIPAL
    return user.role == Role.HOD and hod.department_of(user).lower() == department.strip().lower()


@api.post("/wall/pin", auth=session_auth)
def pin_paper(request: HttpRequest, payload: PinIn):
    """Choose the paper of the month: a head for their department, the
    Principal for the college."""
    user = require_user(request)
    if not _may_pin(user, payload.department):
        raise HttpError(403, "Only the department's head chooses its paper of the month.")
    month = _month(payload.month)
    board = _wall(payload.department, month)
    card = next((c for c in board["cards"] if c["key"] == payload.key), None)
    if card is None:
        raise HttpError(400, "That paper is not on this wall for that month.")
    pin, _ = WallPin.objects.update_or_create(
        department=payload.department.strip(), month=month,
        defaults={"paper_key": card["key"], "title": card["title"], "pinned_by": user},
    )
    AuditLog.objects.create(
        actor=user, action="WALL_PIN", entity="WallPin", entity_id=pin.id,
        detail_json=json.dumps({"department": pin.department, "month": payload.month, "title": card["title"]}),
    )
    return {"ok": True}


@api.delete("/wall/pin", auth=session_auth)
def unpin_paper(request: HttpRequest, month: str, department: str = ""):
    user = require_user(request)
    if not _may_pin(user, department):
        raise HttpError(403, "Only the department's head chooses its paper of the month.")
    WallPin.objects.filter(department__iexact=department.strip(), month=_month(month)).delete()
    return {"ok": True}


__all__ = [
    "my_badges",
    "user_badges",
    "run_badges",
    "my_celebrations",
    "mark_celebrations_seen",
    "my_goals",
    "set_my_goals",
    "hod_goals",
    "my_impact",
    "my_impact_card",
    "my_impact_share",
    "set_my_impact_share",
    "shared_impact_card",
    "shared_impact_page",
    "wall",
    "pin_paper",
    "unpin_paper",
]
