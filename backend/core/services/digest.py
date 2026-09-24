"""The weekly summary, sent Monday 8am IST (schedule "weekly-digest").

For each faculty member and head of department, four short parts:

1. **Where they stand** -- rank this academic year and the movement since
   last week (core.services.standing).
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
        "href": f"/people/{pid}",
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


def build_for(user: User, now=None, ctx: dict[str, Any] | None = None) -> dict[str, Any]:
    """One person's summary. Carries no money and no claim rows."""
    now = now or timezone.now()
    ctx = ctx or context(now)
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
        "scoring": standing.SCORING,
    }


def has_content(d: dict[str, Any]) -> bool:
    return any(d.get(k) for k in ("standing", "department", "collaborator", "open_items"))


def preview_for(user: User) -> dict[str, Any]:
    if user.role not in rbac.CLAIMANT_ROLES:
        return {
            "eligible": False,
            "reason": "The weekly summary is for people who file papers.",
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
    for user in ctx["people"].values():
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
    built.sort(key=lambda pair: (not pair[1]["open_items"], pair[0].name or ""))

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
                "/notifications?tab=week",
                email_template="notifications/digest_email.html",
                email_context={"digest": d, "text_sections": _text_sections(d),
                               "action_label": "Open this week in the app"},
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
    logger.info("weekly digest %s", summary)
    return summary
