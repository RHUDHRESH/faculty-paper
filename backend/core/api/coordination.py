"""The coordination desk: supervise the review desks and hand out claims.

For the research coordinator, the research cell and the super admin, and for
nobody else. Counts and names only: no amounts and no flags anywhere on it
(`core.services.coordination`).

`assigned_to` is advisory. Assigning changes who is asked to look at a claim,
not who may clear it, so it is recorded in the audit trail and not in the
claim's own history, which the claimant can read.
"""

from __future__ import annotations

import json
from typing import Optional

from django.db import transaction
from django.http import HttpRequest
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Claim, User
from core.services import coordination as svc, rbac


def _coordinator(request: HttpRequest) -> User:
    user = require_user(request)
    if not svc.can_coordinate(user.role):
        raise HttpError(403, "Only the research cell, the research coordinator and the super admin use this.")
    return user


@api.get("/coordination/overview", auth=session_auth)
def coordination_overview(request: HttpRequest, weeks: int = 12):
    """Workload per reviewer, throughput per week, ageing, breaches of the
    14-day service level, and where claims are stuck. Counts only."""
    _coordinator(request)
    return svc.overview(weeks)


@api.get("/coordination/claims", auth=session_auth)
def coordination_claims(request: HttpRequest, scope: str = "all", limit: int = 200):
    """The claims at the research cell's desk, oldest first. `scope` is
    all, unassigned, assigned or breach."""
    user = _coordinator(request)
    if scope not in ("all", "unassigned", "assigned", "breach"):
        raise HttpError(400, "Scope is all, unassigned, assigned or breach.")
    return svc.desk_claims(scope, user, max(1, min(int(limit), 500)))


@api.get("/coordination/reviewers", auth=session_auth)
def coordination_reviewers(request: HttpRequest):
    """Everyone a claim can be given to."""
    _coordinator(request)
    return [
        {
            "user_id": u.id,
            "name": u.name,
            "role_label": svc.ROLE_LABEL.get(u.role, "Reviewer"),
            "desks": [d for d in (rbac.SUPERVISOR_DESK, rbac.PRINCIPAL_DESK) if rbac.can_act_at_desk(u.role, d)],
        }
        for u in svc.reviewers()
    ]


class AssignIn(Schema):
    claim_ids: list[str]
    #: Null takes the claim back to nobody.
    assignee_id: Optional[str] = None


@api.post("/coordination/assign", auth=session_auth)
def coordination_assign(request: HttpRequest, payload: AssignIn):
    """Give one or many claims to a reviewer, or take them back.

    Each claim is checked on its own: the assignee must sit at the desk the
    claim is at, and can never be the person who filed it. Claims that fail
    are skipped by name and the rest go through.
    """
    actor = _coordinator(request)
    claim_ids = svc.ids(payload.claim_ids)
    if not claim_ids:
        raise HttpError(400, "Choose at least one claim.")
    if len(claim_ids) > 200:
        raise HttpError(400, "Assign up to 200 claims at a time.")
    assignee = None
    if payload.assignee_id:
        assignee = User.objects.filter(id=payload.assignee_id).first()
        if assignee is None or not assignee.active or assignee.role not in svc.REVIEW_ROLES:
            raise HttpError(400, "Claims can only be given to someone who reviews them.")

    done: list[str] = []
    skipped: list[dict] = []
    with transaction.atomic():
        found = {c.id: c for c in Claim.objects.select_for_update().filter(id__in=claim_ids).select_related("owner")}
        for cid in claim_ids:
            c = found.get(cid)
            if c is None:
                skipped.append({"claim_id": cid, "ticket_number": None, "reason": "No such claim."})
                continue
            why = svc.refusal(actor, c, assignee)
            if why:
                skipped.append({"claim_id": cid, "ticket_number": c.ticket_number, "reason": why})
                continue
            previous = c.assigned_to_id
            c.assigned_to = assignee
            c.assigned_at = timezone.now() if assignee else None
            c.save(update_fields=["assigned_to", "assigned_at"])
            AuditLog.objects.create(
                actor=actor, action="CLAIM_ASSIGN" if assignee else "CLAIM_UNASSIGN",
                entity="Claim", entity_id=c.id,
                detail_json=json.dumps({"ticket": c.ticket_number, "from": previous, "to": assignee.id if assignee else None}),
            )
            done.append(cid)
    return {
        "assigned": len(done) if assignee else 0,
        "unassigned": len(done) if not assignee else 0,
        "claim_ids": done,
        "skipped": skipped,
        "assignee": {"user_id": assignee.id, "name": assignee.name} if assignee else None,
    }


@api.get("/coordination/research", auth=session_auth)
def coordination_research(request: HttpRequest):
    """The final-year project teams and the size of the journal watch-list.

    Research faculty and their threshold are somebody else's page; this only
    links to it."""
    _coordinator(request)
    from core.models import JournalWatch

    return {
        "fyp": svc.fyp_overview(),
        "watch": {"count": JournalWatch.objects.count()},
    }


__all__ = [
    "coordination_overview",
    "coordination_claims",
    "coordination_reviewers",
    "coordination_assign",
    "coordination_research",
]
