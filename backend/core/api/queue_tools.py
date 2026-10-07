"""What a reviewer needs around a queue: past cases, claim-number search, bulk hold.

docs/ux/21-review-and-apply.md, section C.

- `GET /api/claims/{id}/context`: the claimant's earlier claims with how each
  ended, the same paper claimed by co-authors, the same journal's history at
  the college, and payment-history matches. Staff only. The rules are the
  desks' own and are enforced here, then again by the renderer as a net:
    * a faculty member or a head of department gets 403 (a head is not a
      reviewer here, and a claimant is never shown other people's claims);
    * the Director and Finance get no duplicate or ledger matches, the same
      contest-blind rule as everywhere (`core.visibility`);
    * nobody gets the context of their own claim: they are its claimant.
- `GET /api/search/claim-number?q=`: exact and prefix match on the claim
  number, scoped to the claims the asker may see.
- `POST /api/desk/bulk-hold`: hold many claims at the desk the asker sits at,
  with one reason. Bulk send-back does not exist on purpose: every send-back
  needs its own reason.

None of these writes anything except the bulk hold.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import Count, Q
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core.api.claims import _claims_queryset
from core.api.common import api, require_user, session_auth
from core.api.deps import claim_to_dict
from core.api.desks import _HOLD_COPY, _locked_at_own_desk, _record
from core.api.journals import _notify_claimant
from core.api.search_all import _claim_item, _claims_for
from core.models import Claim, ClaimAction, ClaimStatus, PaidLedger, User
from core.services import claim_numbers, rbac
from core.services.normalize import normalize_doi, normalize_title
from core.services.verify import check_already_paid
from core.visibility import ERP_CLOSED_NOTE

#: Steps that end with the paper sent back or refused, and carry a reason.
_SEND_BACK_ACTIONS = ("REJECT", "REJECT_OUTRIGHT", "PRINCIPAL_SEND_BACK", "DIRECTOR_SEND_BACK")

PAST_LIMIT = 25
CO_AUTHOR_LIMIT = 15
JOURNAL_RECENT = 8


def _item(c: Claim, reasons: dict[str, list[dict[str, Any]]], *, with_owner: bool) -> dict[str, Any]:
    filed = c.submitted_at or c.created_at
    out: dict[str, Any] = {
        "id": c.id,
        "ticket_number": c.ticket_number,
        "paper_title": c.paper_title or "(untitled)",
        "journal_title": c.journal_title,
        "publication_year": c.publication_year,
        "filed_on": filed.isoformat() if filed else None,
        "status": c.status,
        "outcome": claim_numbers.outcome(c),
        # Under the money key, so the renderer strips it for anybody who may
        # not see money, whatever this endpoint decided.
        "remuneration": c.remuneration,
        "send_backs": reasons.get(c.id, []),
    }
    if with_owner:
        out["owner_id"] = c.owner_id
        out["owner_name"] = c.owner.name if c.owner_id else None
        out["owner_department"] = c.owner.department if c.owner_id else None
    return out


def _reasons_for(ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    if not ids:
        return out
    rows = (
        ClaimAction.objects.filter(claim_id__in=ids, action__in=_SEND_BACK_ACTIONS)
        .exclude(note__isnull=True).exclude(note="")
        .select_related("actor").order_by("-created_at")
    )
    for a in rows:
        out.setdefault(a.claim_id, []).append({
            "reason": a.note,
            "kind": "refused" if a.action == "REJECT_OUTRIGHT" else (
                "faculty" if a.action == "REJECT" else "internal"),
            "by": a.actor.name if a.actor_id else None,
            "when": a.created_at.isoformat(),
        })
    return out


def _visible_others(user: User):
    """Claims the asker may look at, drafts of other people excluded."""
    return _claims_queryset(user).select_related("owner")


def _tally(qs) -> dict[str, int]:
    """How the journal's claims ended, in one query."""
    # ERP claims closed as handled in the old system were never decided here.
    qs = qs.exclude(status_note=ERP_CLOSED_NOTE, status=ClaimStatus.REJECTED)
    sent = Q(status=ClaimStatus.REJECTED)
    return qs.order_by().aggregate(
        total=Count("id"),
        paid=Count("id", filter=Q(status=ClaimStatus.PAID)),
        sent_back=Count("id", filter=sent & Q(rejected_outright=False)),
        rejected=Count("id", filter=sent & Q(rejected_outright=True)),
        in_progress=Count("id", filter=~Q(status__in=[ClaimStatus.PAID, ClaimStatus.REJECTED, ClaimStatus.DRAFT])),
    )


@api.get("/claims/{claim_id}/context", auth=session_auth)
def claim_context(request: HttpRequest, claim_id: str):
    """Past cases for the claim under review. See the module docstring."""
    user = require_user(request)
    if not rbac.can_view_college_wide(user.role):
        raise HttpError(403, "Past cases are for the people who review claims.")
    claim = get_object_or_404(_visible_others(user).select_related("owner"), pk=claim_id)
    sees_flags = rbac.can_review_flags(user.role)
    base = {
        "claim_id": claim.id,
        "ticket_number": claim.ticket_number,
        "can_see_flags": sees_flags,
        "own_claim": False,
        "claimant": {"user_id": claim.owner_id, "name": claim.owner.name,
                     "department": claim.owner.department},
        "previous_claims": [],
        "previous_total": 0,
        "co_author_claims": [],
        "journal": {"title": claim.journal_title, "tally": None, "recent": []},
    }
    if sees_flags:
        base["matches"] = {"duplicates": [], "ledger": []}
    if rbac.is_own_claim(user, claim):
        # Their own claim: they are the claimant, not the reviewer.
        base["own_claim"] = True
        return base

    scope = _visible_others(user).exclude(pk=claim.pk).exclude(status=ClaimStatus.DRAFT)

    # 1. The claimant's earlier claims, newest first.
    mine = scope.filter(owner_id=claim.owner_id).order_by("-created_at")
    base["previous_total"] = mine.count()
    previous = list(mine[:PAST_LIMIT])

    # 2. The same paper claimed by somebody else here.
    doi = normalize_doi(claim.doi) if claim.doi else None
    ntitle = claim.normalized_title or normalize_title(claim.paper_title)
    same = Q()
    if doi:
        same |= Q(doi__iexact=doi)
    if ntitle:
        same |= Q(normalized_title=ntitle)
    others: list[Claim] = []
    if same:
        others = list(scope.filter(same).exclude(owner_id=claim.owner_id).order_by("-created_at")[:CO_AUTHOR_LIMIT])

    # 3. The same journal at the college.
    journal_qs = None
    recent: list[Claim] = []
    if claim.journal_title:
        journal_qs = scope.filter(journal_title__iexact=claim.journal_title)
        recent = list(journal_qs.order_by("-created_at")[:JOURNAL_RECENT])
        base["journal"]["tally"] = _tally(journal_qs)

    reasons = _reasons_for([c.id for c in (*previous, *others, *recent)])
    base["previous_claims"] = [_item(c, reasons, with_owner=False) for c in previous]
    base["co_author_claims"] = [_item(c, reasons, with_owner=True) for c in others]
    base["journal"]["recent"] = [_item(c, reasons, with_owner=True) for c in recent]

    # 4. Payment-history and ledger matches: a doubt about the paper, so for
    # the desks that judge it. The Director and Finance are not shown them.
    if sees_flags:
        found = check_already_paid(
            title=claim.paper_title, doi=claim.doi, staff_id=claim.staff_id,
            exclude_claim_id=claim.pk,
        )
        base["matches"]["duplicates"] = found.get("matches") or []
        ledger = Q()
        if ntitle and claim.paper_title:
            ledger |= Q(paper_title__iexact=claim.paper_title.strip())
        if claim.staff_id and claim.paper_title:
            ledger |= Q(staff_id=claim.staff_id, paper_title__icontains=claim.paper_title.strip()[:60])
        if ledger:
            rows = PaidLedger.objects.filter(ledger).exclude(claim_id=claim.pk).order_by("-payout_month")[:10]
            base["matches"]["ledger"] = [{
                "id": r.id,
                "paper_title": r.paper_title,
                "faculty_name": r.faculty_name,
                "month": r.payout_month.strftime("%Y-%m") if r.payout_month else None,
                "voucher_number": r.voucher_number,
                "amount": r.amount,
                "claim_id": r.claim_id,
            } for r in rows]
    return base


# ---------------------------------------------------------------------------
# Claim-number search
# ---------------------------------------------------------------------------


@api.get("/search/claim-number", auth=session_auth)
def search_claim_number(request: HttpRequest, q: str = "", limit: int = 8):
    """Exact and prefix match on claim numbers, for the asker's own reach.

    `exact` is set when the text is one whole number ("fp 2026 123" finds
    FP-2026-000123). `results` are the numbers that start with it. Each hit
    carries `review_url` when it is at one of the asker's desks.
    """
    user = require_user(request)
    limit = max(1, min(limit, 25))
    forms = claim_numbers.variants(q)
    if not forms or len(forms[0]) < 2:
        return {"q": q, "exact": None, "results": []}
    # Nobody else's draft; one's own withdrawn claim is still findable.
    qs = _claims_for(user).exclude(~Q(owner=user), status=ClaimStatus.DRAFT)
    exact = None
    for form in forms:
        exact = qs.filter(ticket_number__iexact=form).first()
        if exact:
            break
    prefix = Q()
    for form in forms:
        prefix |= Q(ticket_number__istartswith=form)
    rows = list(qs.filter(prefix).order_by("ticket_number")[:limit])
    if exact and all(r.pk != exact.pk for r in rows):
        rows.insert(0, exact)
    def shape(c: Claim) -> dict[str, Any]:
        item = _claim_item(c, user)
        item["review_url"] = claim_numbers.review_url(user, c)
        # Words to print. The raw status is a code; staff read the outcome
        # label, and everybody else the stage `_claim_item` already made.
        staff_view = rbac.can_view_college_wide(user.role) and c.owner_id != user.id
        item["stage"] = claim_numbers.outcome(c)["label"] if staff_view else item["meta"]["status"]
        return item

    return {
        "q": q,
        "exact": shape(exact) if exact else None,
        "results": [shape(c) for c in rows[:limit]],
    }


# ---------------------------------------------------------------------------
# Bulk hold
# ---------------------------------------------------------------------------


class BulkHoldIn(Schema):
    claim_ids: list[str]
    reason: str


@api.post("/desk/bulk-hold", auth=session_auth)
def bulk_hold(request: HttpRequest, payload: BulkHoldIn):
    """Hold a batch at the desk the asker sits at. Each claim is its own step.

    A claim that cannot be held (already on hold, at another desk, the asker's
    own) is skipped by name rather than failing the batch.
    """
    user = require_user(request)
    if not rbac.sits_at_a_desk(user.role):
        raise HttpError(403, "Only the research office and the Principal hold claims.")
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Say why they are on hold (10+ characters). The desk reads it later")
    ids = list(dict.fromkeys(payload.claim_ids or []))[:200]
    if not ids:
        raise HttpError(400, "Select at least one claim")

    held: list[str] = []
    skipped: list[dict[str, str]] = []
    for claim_id in ids:
        try:
            with transaction.atomic():
                claim = _locked_at_own_desk(user, claim_id)
                if claim.on_hold:
                    skipped.append({"id": claim_id, "reason": f"{claim.ticket_number or 'This claim'} is already on hold"})
                    continue
                claim.on_hold = True
                claim.hold_reason = reason
                claim.held_by = user
                claim.held_at = timezone.now()
                claim.save(update_fields=["on_hold", "hold_reason", "held_by", "held_at", "updated_at"])
                _record(claim, user, "HOLD", reason)
            _notify_claimant(claim, *_HOLD_COPY)
            held.append(claim_id)
        except HttpError as e:
            skipped.append({"id": claim_id, "reason": str(e.message)})
        except Exception:  # noqa: BLE001 -- one bad row must not sink the batch
            skipped.append({"id": claim_id, "reason": "Not found"})
    return {"held": len(held), "held_ids": held, "skipped": skipped}


__all__ = [
    "BulkHoldIn",
    "bulk_hold",
    "claim_context",
    "search_claim_number",
]
