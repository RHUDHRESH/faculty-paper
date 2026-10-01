"""Supervising the review desks: who holds which claim, how fast the desks
move, and where claims are stuck.

Everything here is counts and names, never money and never flags. The people
who open the coordination page (the research cell, the research coordinator,
the super admin) may see both elsewhere, but this page is the one a lead
shares on a screen, and a count carries what it needs to.

`assigned_to` is advisory. Anyone at the desk may still act on a claim; the
field says who was asked to. It only counts while that person can still act
at the desk the claim is at, so a claim that has moved on stops belonging to
its old reviewer without any transition having to remember to clear it.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from statistics import median
from typing import Any, Iterable, Optional

from django.db.models import Max
from django.utils import timezone

from core.models import Claim, ClaimAction, ClaimStatus, Role, User
from core.services import rbac

#: More than this many days at a desk is a breach of the service level.
SLA_DAYS = 14

#: Who can be given a claim: everybody who sits at a review desk.
REVIEW_ROLES = tuple(dict.fromkeys((*rbac.ADMIN_ROLES, Role.PRINCIPAL)))

ROLE_LABEL = {
    Role.RESEARCH_CELL: "Research cell",
    Role.RESEARCH_COORDINATOR: "Research coordinator",
    Role.SUPER_ADMIN: "Administrator",
    Role.PRINCIPAL: "Principal",
}

AGE_BUCKETS = [
    ("a week or less", 0, 7),
    ("8 to 14 days", 8, 14),
    ("15 to 30 days", 15, 30),
    ("over 30 days", 31, 10**6),
]


def can_coordinate(role: str | None) -> bool:
    """The coordination page: the office roles (research cell, research
    coordinator, super admin). Nobody else, whatever else they can see."""
    return role in rbac.ADMIN_ROLES


# ---------------------------------------------------------------- assignment


def desk_for(claim: Claim) -> str | None:
    return rbac.desk_for_status(claim.status)


def can_hold_claim(user: User, claim: Claim) -> bool:
    """Whether `user` is a person who could act on `claim` where it now is."""
    return bool(user.active) and rbac.can_act_at_desk(user.role, desk_for(claim))


def effective_assignee(claim: Claim) -> Optional[User]:
    """The assignee, while the assignment still means something."""
    u = claim.assigned_to if claim.assigned_to_id else None
    if u is None or not can_hold_claim(u, claim):
        return None
    return u


def assignee_dict(claim: Claim) -> Optional[dict[str, Any]]:
    """`{user_id, name}` (the renderer adds the face), or null."""
    u = effective_assignee(claim)
    if u is None:
        return None
    return {
        "user_id": u.id,
        "name": u.name,
        "assigned_at": claim.assigned_at.isoformat() if claim.assigned_at else None,
    }


def reviewers(desk: str | None = None) -> list[User]:
    qs = User.objects.filter(active=True, role__in=REVIEW_ROLES).order_by("name")
    return [u for u in qs if desk is None or rbac.can_act_at_desk(u.role, desk)]


def refusal(actor: User, claim: Claim, assignee: User | None) -> str | None:
    """Why this claim cannot be given to this person, or None if it can."""
    if rbac.is_own_claim(actor, claim):
        return "This is your own claim. Another coordinator assigns it."
    if desk_for(claim) is None:
        return "This claim is not waiting at a review desk."
    if assignee is None:
        return None
    if assignee.id == claim.owner_id:
        return "A claim cannot be given to the person who filed it."
    if not can_hold_claim(assignee, claim):
        return f"{assignee.name} does not review claims at this step."
    return None


# ------------------------------------------------------------------- timings


def _arrival(claim: Claim, rejected_at: dict[str, datetime]) -> datetime | None:
    """When the claim reached the step it is at now."""
    at = {
        ClaimStatus.SUBMITTED: claim.submitted_at,
        ClaimStatus.CLEARED: claim.cleared_at,
        ClaimStatus.PRINCIPAL_APPROVED: claim.principal_approved_at,
        ClaimStatus.DIRECTOR_APPROVED: claim.director_approved_at,
        ClaimStatus.REJECTED: rejected_at.get(claim.id),
    }.get(claim.status)
    return at or claim.updated_at or claim.created_at


def _days(since: datetime | None, now: datetime) -> int:
    return max(0, (now - since).days) if since else 0


def _week_start(when: datetime):
    d = timezone.localtime(when).date()
    return d - timedelta(days=d.weekday())


def open_claims():
    """Every claim sitting at a desk or with the claimant to fix."""
    return (
        Claim.objects.filter(
            status__in=[
                ClaimStatus.SUBMITTED,
                ClaimStatus.CLEARED,
                ClaimStatus.PRINCIPAL_APPROVED,
                ClaimStatus.DIRECTOR_APPROVED,
                ClaimStatus.REJECTED,
            ]
        )
        .exclude(status=ClaimStatus.REJECTED, rejected_outright=True)
        .select_related("owner", "assigned_to")
    )


STAGES = [
    (ClaimStatus.SUBMITTED, "research", "With the research cell"),
    (ClaimStatus.CLEARED, "principal", "Waiting for the Principal"),
    (ClaimStatus.PRINCIPAL_APPROVED, "director", "Waiting for the Director"),
    (ClaimStatus.DIRECTOR_APPROVED, "finance", "Waiting for Finance"),
    (ClaimStatus.REJECTED, "claimant", "Sent back, with the claimant"),
]


def claim_row(c: Claim, now: datetime, arrival: datetime | None) -> dict[str, Any]:
    """One claim as the assignment list shows it: no money, no flags."""
    from core.api.flags import _erp_origin

    return {
        "id": c.id,
        "ticket_number": c.ticket_number,
        "origin": _erp_origin(c.ticket_number),
        "paper_title": c.paper_title,
        "owner_id": c.owner_id,
        "owner_name": c.owner.name,
        "owner_department": c.owner.department,
        "waiting_days": _days(arrival, now),
        "on_hold": c.on_hold,
        "assigned_to": assignee_dict(c),
    }


def overview(weeks: int = 12) -> dict[str, Any]:
    now = timezone.now()
    weeks = max(4, min(int(weeks), 26))

    claims = list(open_claims())
    rejected_at = dict(
        ClaimAction.objects.filter(
            claim__in=[c.id for c in claims if c.status == ClaimStatus.REJECTED],
            to_status=ClaimStatus.REJECTED,
        )
        .values("claim_id")
        .annotate(at=Max("created_at"))
        .values_list("claim_id", "at")
    )

    # ---- where claims are, and for how long ----
    stages = []
    for status, key, label in STAGES:
        here = [c for c in claims if c.status == status]
        ages = [_days(_arrival(c, rejected_at), now) for c in here]
        stages.append(
            {
                "key": key,
                "label": label,
                "count": len(here),
                "over_sla": sum(1 for a in ages if a > SLA_DAYS),
                "oldest_days": max(ages) if ages else 0,
                "on_hold": sum(1 for c in here if c.on_hold),
            }
        )

    # ---- the research cell's own desk: ageing, breaches, assignment ----
    desk = [c for c in claims if c.status == ClaimStatus.SUBMITTED]
    desk_age = {c.id: _days(_arrival(c, rejected_at), now) for c in desk}
    ageing = [
        {
            "bucket": name,
            "count": sum(1 for c in desk if lo <= desk_age[c.id] <= hi),
            "breach": lo > SLA_DAYS,
        }
        for name, lo, hi in AGE_BUCKETS
    ]
    breaching = sorted((c for c in desk if desk_age[c.id] > SLA_DAYS), key=lambda c: -desk_age[c.id])

    # ---- throughput and workload from what the desk actually decided ----
    since = timezone.make_aware(
        datetime.combine(_week_start(now) - timedelta(weeks=weeks - 1), datetime.min.time())
    )
    decisions = list(
        ClaimAction.objects.filter(
            from_status=ClaimStatus.SUBMITTED,
            to_status__in=[ClaimStatus.CLEARED, ClaimStatus.REJECTED],
            created_at__gte=since,
        ).values("actor_id", "to_status", "created_at", "claim__submitted_at")
    )
    starts = [_week_start(now) - timedelta(weeks=weeks - 1 - i) for i in range(weeks)]
    throughput = {s: {"received": 0, "decided": 0, "cleared": 0} for s in starts}
    for (when,) in Claim.objects.filter(submitted_at__gte=since).values_list("submitted_at"):
        w = _week_start(when)
        if w in throughput:
            throughput[w]["received"] += 1
    for d in decisions:
        w = _week_start(d["created_at"])
        if w in throughput:
            throughput[w]["decided"] += 1
            if d["to_status"] == ClaimStatus.CLEARED:
                throughput[w]["cleared"] += 1

    this_week = _week_start(now)
    month_ago = now - timedelta(days=30)
    per_actor: dict[str, dict[str, Any]] = {}
    for d in decisions:
        p = per_actor.setdefault(d["actor_id"], {"cleared_week": 0, "decided_week": 0, "days": []})
        if _week_start(d["created_at"]) == this_week:
            p["decided_week"] += 1
            if d["to_status"] == ClaimStatus.CLEARED:
                p["cleared_week"] += 1
        if d["created_at"] >= month_ago and d["claim__submitted_at"]:
            p["days"].append(max(0.0, (d["created_at"] - d["claim__submitted_at"]).total_seconds() / 86400))

    held_by: dict[str, int] = {}
    for c in desk:
        a = effective_assignee(c)
        if a is not None:
            held_by[a.id] = held_by.get(a.id, 0) + 1
    people = []
    for u in reviewers(rbac.SUPERVISOR_DESK):
        p = per_actor.get(u.id, {"cleared_week": 0, "decided_week": 0, "days": []})
        people.append(
            {
                "user_id": u.id,
                "name": u.name,
                "role_label": ROLE_LABEL.get(u.role, "Reviewer"),
                "open": held_by.get(u.id, 0),
                "cleared_this_week": p["cleared_week"],
                "decided_this_week": p["decided_week"],
                "median_days": round(median(p["days"]), 1) if p["days"] else None,
            }
        )
    people.sort(key=lambda r: (-r["open"], -r["decided_this_week"], r["name"]))

    unassigned = sum(1 for c in desk if effective_assignee(c) is None)
    return {
        "generated_at": now.isoformat(),
        "sla_days": SLA_DAYS,
        "desk_open": len(desk),
        "unassigned": unassigned,
        "held": sum(1 for c in desk if c.on_hold),
        "reviewers": people,
        "throughput": [
            {"week_start": s.isoformat(), **throughput[s]} for s in starts
        ],
        "ageing": ageing,
        "breaches": {
            "count": len(breaching),
            "oldest_days": desk_age[breaching[0].id] if breaching else 0,
            "rows": [claim_row(c, now, _arrival(c, rejected_at)) for c in breaching[:8]],
        },
        "stages": stages,
    }


def desk_claims(scope: str, viewer: User, limit: int = 200) -> dict[str, Any]:
    """The claims at the research cell's desk, oldest first, for assigning.

    Never the viewer's own claim: they cannot act on it, and it would only be
    a row they could not do anything with.
    """
    now = timezone.now()
    qs = (
        Claim.objects.filter(status=ClaimStatus.SUBMITTED)
        .exclude(owner=viewer)
        .select_related("owner", "assigned_to")
        .order_by("submitted_at", "created_at")
    )
    rows = []
    for c in qs:
        row = claim_row(c, now, _arrival(c, {}))
        if scope == "unassigned" and row["assigned_to"]:
            continue
        if scope == "assigned" and not row["assigned_to"]:
            continue
        if scope == "breach" and row["waiting_days"] <= SLA_DAYS:
            continue
        rows.append(row)
    return {"total": len(rows), "results": rows[:limit]}


def assigned_filter(qs, viewer: User, assigned: str | None):
    """Narrow a queue to what is assigned to the viewer (`me`), to somebody
    else's id, or to nobody (`none`). Used by the clearing queue."""
    if not assigned:
        return qs
    if assigned == "none":
        return qs.filter(assigned_to__isnull=True)
    who = viewer.id if assigned == "me" else assigned
    return qs.filter(assigned_to_id=who)


def fyp_overview() -> dict[str, Any]:
    from core.models import Team
    from core.services.student_projects import holding_claims

    teams = list(Team.objects.filter(active=True).select_related("mentor"))
    claimed_ids = set(holding_claims().values_list("team_id", flat=True))
    by_dept: dict[str, dict[str, Any]] = {}
    for t in teams:
        d = by_dept.setdefault(t.department or "No department", {"department": t.department or "No department", "teams": 0, "claimed": 0})
        d["teams"] += 1
        d["claimed"] += 1 if t.id in claimed_ids else 0
    return {
        "teams": len(teams),
        "claimed": sum(1 for t in teams if t.id in claimed_ids),
        "academic_years": sorted({t.academic_year for t in teams if t.academic_year}, reverse=True),
        "mentors_unmatched": sum(1 for t in teams if t.mentor_id is None),
        "departments": sorted(by_dept.values(), key=lambda d: (-d["teams"], d["department"])),
    }


def ids(values: Iterable[str]) -> list[str]:
    seen: dict[str, None] = {}
    for v in values:
        if isinstance(v, str) and v:
            seen[v] = None
    return list(seen)
