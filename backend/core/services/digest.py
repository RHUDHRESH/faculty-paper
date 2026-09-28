"""The weekly summary, sent Monday 8am IST (schedule "weekly-digest").

For each faculty member and head of department, four short parts:

1. **Where they stand** -- their leaderboard rank this academic year and the
   movement since last week's summary (core.services.standing).
2. **What their department published** -- papers filed by colleagues in the
   last seven days. Titles, names and journals; never an amount.
3. **Somebody to write with** -- one person who publishes in the same
   journals or works in the same subject areas, and who is *never* an existing
   co-author: not anybody who filed a claim for the same paper, and not
   anybody named among the authors of either person's papers.
4. **What is waiting on them** -- papers sent back to them, and drafts.

A person with nothing in any part is not sent one. Nobody is sent two in a
week: a second run in the same week (a retry, a late catch-up) skips anybody
who already has this week's. The same summary, computed live, is the "This
week" tab on the notifications screen (`preview_for`).

Batch shape, for a 512 MB, 0.1-CPU worker: everything shared -- the ranking,
the co-authorship index, the week's papers -- is computed once per run, and
all the email goes over one SMTP connection.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import datetime, time, timedelta
from typing import Any

from django.core.mail import get_connection
from django.utils import timezone

from core.models import Claim, ClaimStatus, Notification, ResearchInterest, User
from core.services import notify as notify_service
from core.services import rbac, standing
from core.services.normalize import normalize_title

logger = logging.getLogger(__name__)

KIND = "digest"
DEPARTMENT_SHOWN = 5


def _name_key(name: str | None) -> str:
    return normalize_title(name or "")


def _names_on(claim: Claim) -> set[str]:
    try:
        authors = json.loads(claim.authors_json or "[]")
    except (TypeError, ValueError):
        return set()
    if not isinstance(authors, list):
        return set()
    out = set()
    for a in authors:
        name = a if isinstance(a, str) else (a or {}).get("name") if isinstance(a, dict) else None
        key = _name_key(name)
        if key:
            out.add(key)
    return out


def week_start(now) -> datetime:
    local = timezone.localtime(now)
    monday = local.date() - timedelta(days=local.weekday())
    return timezone.make_aware(datetime.combine(monday, time.min))


def context(now) -> dict[str, Any]:
    """Everything the summaries share, computed once per run."""
    from core.api.collaborate import _collaboration_index

    filed = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    partners, journals, papers = _collaboration_index(filed)
    journal_names: dict[str, str] = {}
    named: dict[str, set[str]] = defaultdict(set)
    for claim in filed.only("owner_id", "journal_title", "authors_json"):
        if claim.journal_title:
            journal_names.setdefault(claim.journal_title.strip().lower(), claim.journal_title.strip())
        named[claim.owner_id] |= _names_on(claim)
    interests: dict[str, set[str]] = defaultdict(set)
    for user_id, domain in ResearchInterest.objects.values_list("user_id", "domain"):
        interests[user_id].add(domain)
    week = list(
        Claim.objects.exclude(status__in=(ClaimStatus.DRAFT, ClaimStatus.REJECTED))
        .filter(submitted_at__gte=now - timedelta(days=7), submitted_at__lt=now, owner__active=True)
        .select_related("owner")
        .order_by("-submitted_at")
    )
    people = {
        u.id: u
        for u in User.objects.filter(active=True, role__in=rbac.CLAIMANT_ROLES).only(
            "id", "name", "email", "department", "role", "active"
        )
    }
    return {
        "now": now,
        "movement": standing.movement(now),
        "partners": partners,
        "journals": journals,
        "papers": papers,
        "journal_names": journal_names,
        "named": named,
        "interests": interests,
        "week": week,
        "people": people,
    }


def _department_part(user: User, ctx) -> dict[str, Any] | None:
    if not user.department:
        return None
    mine = [c for c in ctx["week"] if c.owner.department == user.department and c.owner_id != user.id]
    if not mine:
        return None
    return {
        "name": user.department,
        "count": len(mine),
        "papers": [
            {
                "title": c.paper_title or "Untitled",
                "person": c.owner.name or c.owner.email,
                "journal": c.journal_title or "",
                "href": f"/papers/{c.id}",
            }
            for c in mine[:DEPARTMENT_SHOWN]
        ],
    }


def collaborator_candidates(user: User, ctx) -> list[tuple]:
    """Everybody who could be suggested to `user`, best first.

    Each entry is (-score, -papers, name, id, shared journals, shared areas).
    Existing co-authors are never in it: whoever filed for the same paper,
    whoever is named on `user`'s papers, and whoever names `user` on theirs.
    """
    my_journals = ctx["journals"].get(user.id, set())
    my_interests = ctx["interests"].get(user.id, set())
    if not my_journals and not my_interests:
        return []
    my_key = _name_key(user.name)
    my_named = ctx["named"].get(user.id, set())
    already = set(ctx["partners"].get(user.id, {}))
    ranked = []
    for pid, person in ctx["people"].items():
        if pid == user.id or pid in already:
            continue
        if _name_key(person.name) in my_named or (my_key and my_key in ctx["named"].get(pid, set())):
            continue
        shared_journals = my_journals & ctx["journals"].get(pid, set())
        shared_areas = my_interests & ctx["interests"].get(pid, set())
        if not shared_journals and not shared_areas:
            continue
        cross = bool(person.department and person.department != user.department)
        score = 2 * len(shared_journals) + len(shared_areas) + (1 if cross else 0)
        ranked.append((-score, -ctx["papers"].get(pid, 0), person.name or "", pid,
                       shared_journals, shared_areas))
    ranked.sort()
    return ranked


def _collaborator_part(user: User, ctx) -> dict[str, Any] | None:
    ranked = collaborator_candidates(user, ctx)
    if not ranked:
        return None
    # Rotate among the best three week by week, so the suggestion is not the
    # same name every Monday for a year.
    week_no = timezone.localtime(ctx["now"]).isocalendar()[1]
    _, _, _, pid, shared_journals, shared_areas = ranked[week_no % min(3, len(ranked))]
    person = ctx["people"][pid]
    if shared_journals:
        shown = sorted(ctx["journal_names"].get(j, j) for j in shared_journals)
        why = f"Publishes in {', '.join(shown[:2])}" + (
            f" and {len(shown) - 2} more" if len(shown) > 2 else ""
        ) + ", as you do"
    else:
        why = f"Also works on {', '.join(sorted(shared_areas)[:2])}"
    if person.department and person.department != user.department:
        why += f", in {person.department}"
    return {
        "id": pid,
        "name": person.name or person.email,
        "department": person.department or "",
        "why": why + ".",
        "href": f"/u/{pid}",
    }


def _open_items(user: User) -> list[dict[str, Any]]:
    items = []
    for c in Claim.objects.filter(owner=user, status=ClaimStatus.REJECTED, rejected_outright=False).order_by("-updated_at"):
        items.append({
            "title": c.paper_title or "Untitled",
            "state": "Sent back to you",
            "reason": c.status_note or "",
            "href": f"/papers/{c.id}",
        })
    for c in Claim.objects.filter(owner=user, status=ClaimStatus.DRAFT).order_by("-updated_at"):
        items.append({
            "title": c.paper_title or "Untitled draft",
            "state": "Draft, not filed yet",
            "reason": "",
            "href": f"/papers/{c.id}/edit",
        })
    return items


#: Where a claimant's paper is, in words that never name a desk or a person.
_PROGRESS_WORDS = {
    ClaimStatus.SUBMITTED: "Being checked",
    ClaimStatus.CLEARED: "Being checked",
    ClaimStatus.PRINCIPAL_APPROVED: "Approved, payment being arranged",
    ClaimStatus.DIRECTOR_APPROVED: "Approved, payment being arranged",
}
FOUND_SHOWN = 3


def _progress_part(user: User, now) -> list[dict[str, Any]]:
    out = []
    for c in Claim.objects.filter(owner=user, status__in=list(_PROGRESS_WORDS)).order_by("-updated_at")[:5]:
        out.append({"title": c.paper_title or "Untitled", "state": _PROGRESS_WORDS[c.status],
                    "href": f"/papers/{c.id}"})
    for c in Claim.objects.filter(owner=user, status=ClaimStatus.PAID,
                                  updated_at__gte=now - timedelta(days=7)).order_by("-updated_at")[:3]:
        out.append({"title": c.paper_title or "Untitled", "state": "Paid this week", "href": f"/papers/{c.id}"})
    return out


def _found_part(user: User, now) -> dict[str, Any] | None:
    """Papers on this person's record that no claim has been filed for."""
    from core.models import Publication

    year = timezone.localtime(now).year
    qs = (
        Publication.objects.filter(authorships__user=user, claims__isnull=True, year__gte=year - 1)
        .distinct()
        .order_by("-year", "title")
    )
    count = qs.count()
    if not count:
        return None
    return {
        "count": count,
        "papers": [{"title": p.title or "Untitled", "year": p.year, "venue": p.venue}
                   for p in qs[:FOUND_SHOWN]],
        "href": "/record",
    }


def _pace_part(user: User, now) -> dict[str, Any] | None:
    """A head's department against its publications target, and who to nudge."""
    from core.models import DepartmentTarget

    if user.role != rbac.Role.HOD or not user.department:
        return None
    local = timezone.localtime(now)
    target = DepartmentTarget.objects.filter(
        department=user.department, year=local.year, person__isnull=True,
        metric=DepartmentTarget.Metric.PUBLICATIONS,
    ).first()
    filed = Claim.objects.filter(owner__department=user.department, submitted_at__year=local.year).exclude(
        status__in=(ClaimStatus.DRAFT, ClaimStatus.REJECTED))
    done = filed.count()
    members = User.objects.filter(active=True, department=user.department,
                                  role__in=rbac.CLAIMANT_ROLES).exclude(pk=user.pk)
    busy = set(filed.values_list("owner_id", flat=True))
    push = [m.name or m.email for m in members.order_by("name") if m.id not in busy][:5]
    if target is None and not push:
        return None
    part: dict[str, Any] = {"department": user.department, "done": done, "push": push,
                            "href": "/department"}
    if target is not None:
        elapsed = (local.timetuple().tm_yday) / 365
        expected = round(target.target * elapsed)
        part.update(target=target.target, expected=expected)
        if done >= expected:
            part["line"] = f"{done} of {target.target} filed this year: on pace (about {expected} expected by now)."
        else:
            part["line"] = f"{done} of {target.target} filed this year: behind pace, about {expected} expected by now."
    else:
        part["line"] = f"{done} filed this year. No department target is set."
    return part


#: Which statuses wait on which role's desk.
_DESK_STATUSES = {
    rbac.Role.RESEARCH_CELL: (ClaimStatus.SUBMITTED,),
    rbac.Role.RESEARCH_COORDINATOR: (ClaimStatus.SUBMITTED,),
    rbac.Role.SUPER_ADMIN: (ClaimStatus.SUBMITTED,),
    rbac.Role.PRINCIPAL: (ClaimStatus.CLEARED,),
    rbac.Role.DIRECTOR: (ClaimStatus.PRINCIPAL_APPROVED,),
    rbac.Role.FINANCE: (ClaimStatus.DIRECTOR_APPROVED,),
}
_DESK_HREF = {
    rbac.Role.RESEARCH_CELL: "/admin/clearing",
    rbac.Role.RESEARCH_COORDINATOR: "/admin/clearing",
    rbac.Role.SUPER_ADMIN: "/admin/clearing",
    rbac.Role.PRINCIPAL: "/principal",
    rbac.Role.DIRECTOR: "/authorisations",
    rbac.Role.FINANCE: "/finance",
}


def _desk_part(user: User, now) -> dict[str, Any] | None:
    """What waits on an officer's desk, and how long the oldest has waited."""
    statuses = _DESK_STATUSES.get(user.role)
    if not statuses:
        return None
    waiting = Claim.objects.filter(status__in=statuses).exclude(owner=user)
    count = waiting.count()
    if not count:
        return None
    oldest = waiting.order_by("updated_at").values_list("updated_at", flat=True).first()
    days = max(0, (now - oldest).days) if oldest else 0
    week = waiting.filter(updated_at__lte=now - timedelta(days=7)).count()
    return {"count": count, "oldest_days": days, "over_a_week": week,
            "href": _DESK_HREF.get(user.role, "/"),
            "line": (f"{count} paper{'s' if count != 1 else ''} waiting on your desk; "
                     f"the oldest for {days} day{'s' if days != 1 else ''}"
                     + (f", {week} for over a week." if week else "."))}


def build_for(user: User, now=None, ctx: dict[str, Any] | None = None) -> dict[str, Any]:
    """One person's summary. Carries no money and no claim rows."""
    now = now or timezone.now()
    ctx = ctx or context(now)
    if user.role not in rbac.CLAIMANT_ROLES:
        monday = week_start(now)
        return {"eligible": True, "week_of": f"{monday.day} {monday:%B %Y}", "standing": None,
                "department": None, "collaborator": None, "open_items": [], "progress": [],
                "found": None, "pace": None, "desk": _desk_part(user, now),
                "scoring": standing.SCORING}
    place = ctx["movement"].get(user.id)
    standing_part = {**place, "line": standing.sentence(place)} if place else None
    monday = week_start(now)
    return {
        "eligible": True,
        "week_of": f"{monday.day} {monday:%B %Y}",
        "standing": standing_part,
        "department": _department_part(user, ctx),
        "collaborator": _collaborator_part(user, ctx),
        "open_items": _open_items(user),
        "progress": _progress_part(user, now),
        "found": _found_part(user, now),
        "pace": _pace_part(user, now),
        "desk": _desk_part(user, now),
        "scoring": standing.SCORING,
    }


PARTS = ("standing", "department", "collaborator", "open_items", "progress", "found", "pace", "desk")


def has_content(d: dict[str, Any]) -> bool:
    return any(d.get(k) for k in PARTS)


def preview_for(user: User) -> dict[str, Any]:
    if user.role not in rbac.CLAIMANT_ROLES and user.role not in _DESK_STATUSES:
        return {
            "eligible": False,
            "reason": "The weekly summary is for people who file or review papers.",
        }
    d = build_for(user)
    d["level"] = notify_service.level_for(user, KIND)
    return d


def _headline(d: dict[str, Any]) -> str:
    parts = []
    if d["standing"]:
        parts.append(f"{standing.ordinal(d['standing']['rank'])} this year")
    if d["department"]:
        n = d["department"]["count"]
        parts.append(f"{n} new paper{'s' if n != 1 else ''} in your department")
    if d["open_items"]:
        n = len(d["open_items"])
        parts.append(f"{n} waiting on you")
    if d.get("found"):
        n = d["found"]["count"]
        parts.append(f"{n} paper{'s' if n != 1 else ''} found to file")
    if d.get("pace") and d["pace"].get("target"):
        parts.append(f"department at {d['pace']['done']} of {d['pace']['target']}")
    if d.get("desk"):
        parts.append(f"{d['desk']['count']} on your desk")
    return "Your week: " + ", ".join(parts) if parts else "Your weekly summary"


def _body(d: dict[str, Any]) -> str:
    lines = []
    if d["standing"]:
        lines.append(d["standing"]["line"])
    if d["department"]:
        dep = d["department"]
        lines.append(f"{dep['name']} filed {dep['count']} paper{'s' if dep['count'] != 1 else ''} this week.")
    if d["collaborator"]:
        c = d["collaborator"]
        lines.append(f"Somebody to write with: {c['name']}. {c['why']}")
    if d["open_items"]:
        lines.append(f"Waiting on you: {len(d['open_items'])}.")
    if d.get("progress"):
        lines.append(f"In progress: {len(d['progress'])}.")
    if d.get("found"):
        lines.append(f"Found on your record, not filed yet: {d['found']['count']}.")
    if d.get("pace"):
        lines.append(d["pace"]["line"])
    if d.get("desk"):
        lines.append(d["desk"]["line"])
    return "\n".join(lines)


def _text_sections(d: dict[str, Any]) -> str:
    out = []
    if d["department"]:
        out.append("New in your department:")
        out += [f"- {p['title']} ({p['person']})" for p in d["department"]["papers"]]
    if d["open_items"]:
        out.append("Waiting on you:")
        out += [f"- {i['title']}: {i['state']}" + (f" ({i['reason']})" if i["reason"] else "")
                for i in d["open_items"]]
    if d.get("progress"):
        out.append("Your papers:")
        out += [f"- {i['title']}: {i['state']}" for i in d["progress"]]
    if d.get("found"):
        out.append("Found on your record, not filed yet:")
        out += [f"- {p['title']}" for p in d["found"]["papers"]]
    if d.get("pace") and d["pace"]["push"]:
        out.append("Nothing filed this year yet: " + ", ".join(d["pace"]["push"]))
    return "\n".join(out)


def send_weekly_digest(now=None) -> dict[str, int]:
    """Monday's run. Returns what it did, for the task log."""
    now = now or timezone.now()
    since = week_start(now)
    already = set(
        Notification.objects.filter(kind=KIND, created_at__gte=since).values_list("user_id", flat=True)
    )
    ctx = context(now)
    summary = {"people": len(ctx["people"]), "sent": 0, "emailed": 0, "nothing_to_say": 0,
               "already": 0, "switched_off": 0}
    built = []
    officers = User.objects.filter(active=True, role__in=list(_DESK_STATUSES)).exclude(
        role__in=rbac.CLAIMANT_ROLES)
    summary["people"] += officers.count()
    for user in [*ctx["people"].values(), *officers]:
        if user.id in already:
            summary["already"] += 1
            continue
        if notify_service.level_for(user, KIND) == notify_service.OFF:
            summary["switched_off"] += 1
            continue
        d = build_for(user, now, ctx)
        if not has_content(d):
            summary["nothing_to_say"] += 1
            continue
        built.append((user, d))
    # People with something waiting on them first, so that if the day's email
    # cap runs out it runs out on the summaries that ask nothing of anybody.
    built.sort(key=lambda pair: (not (pair[1]["open_items"] or pair[1]["desk"]), pair[0].name or ""))

    connection = None
    if notify_service.email_enabled():
        try:
            connection = get_connection()
            connection.open()
        except Exception:
            logger.warning("digest: could not open the mail connection", exc_info=True)
            connection = None
    try:
        for user, d in built:
            note = notify_service.notify(
                user,
                KIND,
                _headline(d),
                _body(d),
                d["desk"]["href"] if d.get("desk") else "/notifications?tab=week",
                email_template="notifications/digest_email.html",
                email_context={"digest": d, "text_sections": _text_sections(d),
                               "action_label": "Open your desk" if d.get("desk") else "Open this week in the app"},
                email_connection=connection,
                at=now,
            )
            if note is not None:
                summary["sent"] += 1
                summary["emailed"] += note.emailed_at is not None
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass
    # What next week's movement is measured against.
    standing.remember(now, ctx["movement"])
    logger.info("weekly digest %s", summary)
    return summary
