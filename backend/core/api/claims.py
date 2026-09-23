"""claims.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.deps import claim_to_dict
from core.api.common import _quartile_year_note, _snip_year_note, require_user

import json
from dataclasses import replace
from typing import Optional
from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q
from django.http import HttpRequest
from ninja.errors import HttpError
from core.models import AttachmentKind, Claim, ClaimReason, ClaimStatus, FormulaConfig, Role, User
from core.services import rbac
from core.services.remuneration import calculate_remuneration, formula_from_model, snapshot_formula
from core.services.tickets import assign_ticket_number
from core import hod

# ---------- claims ----------


def _claims_queryset(user: User):
    """Claims this user may see.

    A draft is unsubmitted, half-typed work that its author has not shown to
    anyone yet, so nobody else sees it — not an admin, not the Principal. The
    oversight portals list whole pipelines, which is exactly the view that would
    otherwise expose them.
    """
    qs = (
        Claim.objects.select_related(
            "owner", "manual_verified_by", "cleared_by", "second_approved_by",
            "override_by", "held_by",
        )
        .prefetch_related("attachments")
        .all()
    )
    if rbac.can_view_college_wide(user.role):
        return qs.filter(~Q(status=ClaimStatus.DRAFT) | Q(owner=user))
    return qs.filter(owner=user)




def _peek_next_quota_slot(claim: Claim) -> int:
    """The next free position in this paper's author-and-year bucket.

    Split out from the allocation so the read can be repeated after a
    collision, and so a test can make it stale on purpose.
    """
    highest = (
        Claim.objects.filter(
            owner_id=claim.owner_id,
            publication_year=claim.publication_year,
            quota_position__isnull=False,
        )
        .exclude(pk=claim.pk)
        .aggregate(top=Max("quota_position"))["top"]
        or 0
    )
    return highest + 1


def _assign_quota_position(claim: Claim) -> None:
    """Give a paper its place in its author's research-quota year, once.

    Called when the claim is filed, which is the only moment that is both
    stable and meaningful: a draft must not consume somebody's allowance, and
    a position handed out later would depend on the order an admin happened to
    open tickets in rather than on the order they were filed. It is also
    called after a filed paper's year is corrected, because the correction
    drops the slot the old year issued and the paper has to take one in its
    new year.

    Idempotent. Re-filing a paper that was sent back keeps the slot it had.

    Concurrency-safe the same way `assign_ticket_number` is, and for the same
    reason: MAX + 1 read in one statement and written in another means two
    submits for one author and year can read the same maximum. The unique
    constraint on (owner, publication_year, quota_position) turns that into a
    failed write rather than a silently shared slot — which is the better of
    the two failures and still a failure, because what the claimant saw was a
    500 and a submission that did not happen. So: lock the bucket, take the
    next slot, and on a collision drop the number and try for another. The
    position is written here rather than left on the instance, since the row
    the constraint protects is only protected once it exists.
    """
    owner = claim.owner
    if (
        claim.quota_position is not None
        or owner is None
        or owner.faculty_type != "RESEARCH"
        or not owner.research_quota
        or not claim.publication_year
        or claim.claim_reason == ClaimReason.COUNT_ONLY
        or not claim.pk
    ):
        return

    for _ in range(8):
        try:
            with transaction.atomic():
                # Serialise the allocators for this one bucket. A no-op on
                # SQLite, which serialises writers anyway; the lock is what
                # holds on Postgres, where the college actually runs.
                list(
                    Claim.objects.select_for_update()
                    .filter(
                        owner_id=claim.owner_id,
                        publication_year=claim.publication_year,
                        quota_position__isnull=False,
                    )
                    .order_by("-quota_position")[:1]
                )
                claim.quota_position = _peek_next_quota_slot(claim)
                claim.save(update_fields=["quota_position", "updated_at"])
            return
        except IntegrityError:
            # Somebody else took it between the read and the write.
            claim.quota_position = None
            continue
    raise RuntimeError("Could not assign a research-quota position")




_CLAIM_SORTS = {
    "recent": "-updated_at",
    "amount": "-remuneration",
    "title": "paper_title",
}


def _refuse_hod_money_screens(user: User) -> None:
    """A head of department has their own screens, which carry no money.

    The claim payload carries the remuneration, and while a head owns no
    claims -- they cannot file one -- an open door that returns an empty list
    today returns a paid amount the day somebody gives the account a claim.
    Refused outright, pointing at the screen that answers their question.
    """
    if user.role == Role.HOD:
        raise HttpError(
            403,
            "Heads of department see their department's publications under "
            "Department, which carry no payment details.",
        )


@api.get("/claims", auth=session_auth)
def list_claims(
    request: HttpRequest,
    status: Optional[str] = None,
    q: Optional[str] = None,
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
):
    """Paginated. The old shape silently truncated at 200 rows — beyond that,
    tickets simply did not exist as far as the UI was concerned.

    `q` searches the whole queue rather than the page on screen. Both list
    screens used to filter the fifty rows they had already fetched, so an admin
    on page one searching for a ticket sitting on page three was told there was
    no such ticket.
    """
    user = require_user(request)
    _refuse_hod_money_screens(user)
    qs = _claims_queryset(user)
    if status:
        qs = qs.filter(status=status)
    if q and q.strip():
        term = q.strip()
        qs = qs.filter(
            Q(ticket_number__icontains=term)
            | Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(doi__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(owner__email__icontains=term)
            | Q(owner__department__icontains=term)
        )
    qs = qs.order_by(_CLAIM_SORTS.get(sort, "-updated_at"))
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in qs[offset : offset + limit]],
    }


# Registered above `/claims/{claim_id}` on purpose. django-ninja matches in
# registration order, so declared after it this resolves as a claim whose id
# is the literal string "counts" and 404s. The same collision already cost us
# `/admin/data/Claim/export` once.
@api.get("/claims/counts", auth=session_auth)
def claim_counts(request: HttpRequest, q: Optional[str] = None):
    """How many claims sit at each stage, in one query.

    Added because the papers screen was asking seven times -- one request per
    filter chip -- and still could not count a legacy ERP row correctly: the
    list endpoint takes a single status, while a stage covers several. Grouping
    here means one query, and it means the grouping matches `stageOf` on the
    client instead of approximating it.
    """
    user = require_user(request)
    scope = _claims_queryset(user)
    if q:
        scope = scope.filter(
            Q(paper_title__icontains=q) | Q(ticket_number__icontains=q)
        )

    raw = dict(
        scope.values_list("status").annotate(n=Count("id")).values_list("status", "n")
    )

    #: The same grouping `stageOf` uses on the client, including the legacy ERP
    #: statuses. Kept here so the two cannot drift apart silently.
    stages = {
        "draft": ["DRAFT"],
        "filed": ["SUBMITTED", "HOD_APPROVED"],
        "checked": ["CLEARED", "RESEARCH_APPROVED"],
        "approved": ["PRINCIPAL_APPROVED"],
        "authorised": ["DIRECTOR_APPROVED", "FINANCE_APPROVED"],
        "paid": ["PAID"],
        "sent_back": ["REJECTED"],
    }
    counts = {
        stage: sum(raw.get(status, 0) for status in statuses)
        for stage, statuses in stages.items()
    }
    counts["all"] = sum(raw.values())
    return {"counts": counts, "statuses": raw, "stages": stages}




__all__ = [
    '_CLAIM_SORTS',
    '_assign_quota_position',
    '_claims_queryset',
    '_peek_next_quota_slot',
    '_refuse_hod_money_screens',
    'claim_counts',
    'list_claims',
]
