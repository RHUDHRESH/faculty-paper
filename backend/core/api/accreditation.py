"""the accreditation rows, and correcting them.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.deps import require_user
from core.api.claims import _assign_quota_position, _claims_queryset
from core.api.journals import _issn_variants
from core.api.dashboard import reports

import json
import time
from datetime import date
from typing import Any, Optional
from django.db.models import Q
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, JournalStanding
from core.services import rbac
from core.services.normalize import normalize_doi, normalize_issn

# ---------- the accreditation rows, and correcting them ----------

#: What NAAC 3.4.3 asks for on every row. A row missing any of these is one an
#: assessor will send back, so they are named rather than left to be noticed.
PACK_REQUIRED = {
    "paper_title": "No title",
    "owner_name": "No author",
    "owner_department": "No department",
    "journal_title": "No journal",
    "publication_year": "No year",
    "issn": "No ISSN",
    "link": "No link to the paper",
}

#: The only fields this screen may change. Bibliographic only: the pack holds
#: no money, and a screen for tidying a submission must not be able to move a
#: payment or a ticket's stage.
PACK_EDITABLE = {
    "paper_title": "Title of paper",
    "journal_title": "Name of journal",
    "issn": "ISSN",
    "publication_year": "Year of publication",
    "doi": "DOI",
    "scopus_url": "Link to the paper",
}


def _pack_row(claim: Claim, listed: str) -> dict[str, Any]:
    link = claim.scopus_url or (f"https://doi.org/{claim.doi}" if claim.doi else "")
    row = {
        "id": claim.id,
        "ticket_number": claim.ticket_number,
        "paper_title": claim.paper_title or "",
        "owner_id": claim.owner_id,
        "owner_name": claim.owner.name if claim.owner_id else "",
        "owner_department": (claim.owner.department if claim.owner_id else "") or "",
        "journal_title": claim.journal_title or "",
        "publication_year": claim.publication_year or "",
        "issn": normalize_issn(claim.issn) or "",
        "doi": claim.doi or "",
        "scopus_url": claim.scopus_url or "",
        "link": link,
        "ugc_care": listed,
    }
    row["gaps"] = [label for field, label in PACK_REQUIRED.items() if not row.get(field)]
    return row


@api.get("/reports/pack/rows", auth=session_auth)
def pack_rows(
    request: HttpRequest,
    year: Optional[int] = None,
    q: Optional[str] = None,
    only: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """The submission's rows, paged, with what is wrong with each.

    `only=incomplete` is the one people want: the rows an assessor would send
    back. `only=<a gap label>` narrows further, so "No ISSN" is a list of
    exactly the rows to go and find ISSNs for.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    claims = (
        _claims_queryset(user)
        .exclude(status=ClaimStatus.DRAFT)
        .select_related("owner")
        .order_by("owner__department", "owner__name", "-publication_year")
    )
    if year:
        claims = claims.filter(publication_year=year)
    if q and q.strip():
        term = q.strip()
        claims = claims.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(issn__icontains=term)
        )

    have_ugc, ugc = _pack_ugc_status()

    def listed_for(claim: Claim) -> str:
        if not have_ugc:
            return "Not checked"
        hit = next((ugc[v] for v in _issn_variants(claim.issn) if v in ugc), None)
        return "Yes" if hit else "No"

    # The gap counts are over the whole filtered set, not the page: "412 rows
    # have no ISSN" is the number somebody plans an afternoon around, and a
    # per-page count would understate it by two orders of magnitude.
    rows = [_pack_row(c, listed_for(c)) for c in claims]
    gap_counts: dict[str, int] = {}
    for row in rows:
        for gap in row["gaps"]:
            gap_counts[gap] = gap_counts.get(gap, 0) + 1

    if only == "incomplete":
        rows = [r for r in rows if r["gaps"]]
    elif only:
        rows = [r for r in rows if only in r["gaps"]]

    limit = max(1, min(limit, 200))
    return {
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "results": rows[offset : offset + limit],
        "gaps": [
            {"key": label, "count": gap_counts.get(label, 0)}
            for label in PACK_REQUIRED.values()
        ],
        "incomplete": sum(1 for r in rows if r["gaps"]) if only else
                      sum(1 for row in rows if row["gaps"]),
        "ugc_list_loaded": have_ugc,
        "editable": PACK_EDITABLE,
    }


def _pack_ugc_status() -> tuple[bool, dict[str, bool]]:
    rows = JournalStanding.objects.filter(source=JournalStanding.Source.UGC_CARE)
    if not rows.exists():
        return False, {}
    return True, {r.issn: r.listed for r in rows}


class PackRowEditIn(Schema):
    field: str
    value: Optional[str] = None
    reason: str


@api.patch("/reports/pack/rows/{claim_id}", auth=session_auth)
def pack_row_edit(request: HttpRequest, claim_id: str, payload: PackRowEditIn):
    """Correct one bibliographic field on one row of the submission.

    One field and a reason at a time, following the data explorer: a grid that
    lets somebody change forty things and press save produces an audit entry
    nobody can reconstruct a decision from.

    The allowed set is bibliographic only. Money and the ticket's stage are not
    in it and cannot be reached from here, whatever is posted.
    """
    user = require_user(request)
    if not (rbac.can_clear_claims(user.role) or rbac.can_manage_users(user.role)):
        raise HttpError(
            403,
            "Correcting a submission row is the research cell's to do.",
        )

    field = (payload.field or "").strip()
    if field not in PACK_EDITABLE:
        raise HttpError(
            400,
            "That field is not correctable here. This screen changes what the "
            "submission says about a paper — its title, journal, ISSN, year "
            "and link — and nothing about the payment or the ticket's stage.",
        )
    reason = (payload.reason or "").strip()
    if len(reason) < 5:
        raise HttpError(400, "Say why this is being changed.")

    claim = get_object_or_404(_claims_queryset(user), pk=claim_id)
    before = getattr(claim, field, None)
    value: Any = (payload.value or "").strip() or None

    if field == "publication_year" and value is not None:
        try:
            value = int(value)
        except ValueError:
            raise HttpError(400, "The year of publication is a number, like 2025.")
        if not 1900 <= value <= date.today().year + 1:
            raise HttpError(400, "That year is outside anything this college has published in.")
    if field == "issn" and value is not None:
        value = normalize_issn(value)
    if field == "doi" and value is not None:
        value = normalize_doi(value)

    # A slot belongs to the year that issued it, so `Claim.save` drops it when
    # the year is corrected. Nothing then handed the paper one in its new
    # year: `_assign_quota_position` runs at submission and this paper was
    # submitted long ago, so it sat in the new year unnumbered, counting
    # against nobody's quota and taking a slot from nobody. Only a paper that
    # actually held one gets a new one -- a draft still consumes no allowance.
    held_a_slot = field == "publication_year" and claim.quota_position is not None

    setattr(claim, field, value)
    claim.save(update_fields=[field, "updated_at"])
    if held_a_slot and claim.quota_position is None:
        _assign_quota_position(claim)

    ClaimAction.objects.create(
        claim=claim, actor=user, action="PACK_CORRECT",
        note=f"{PACK_EDITABLE[field]}: {before or '—'} → {value or '—'}. {reason}",
    )
    AuditLog.objects.create(
        actor=user, action="PACK_CORRECT", entity="Claim", entity_id=claim.id,
        detail_json=json.dumps({
            "field": field,
            "from": str(before) if before is not None else None,
            "to": str(value) if value is not None else None,
            "reason": reason,
        }),
    )
    have_ugc, ugc = _pack_ugc_status()
    listed = "Not checked"
    if have_ugc:
        listed = "Yes" if next(
            (ugc[v] for v in _issn_variants(claim.issn) if v in ugc), None
        ) else "No"
    return {"ok": True, "row": _pack_row(claim, listed)}




__all__ = [
    'PACK_EDITABLE',
    'PACK_REQUIRED',
    'PackRowEditIn',
    '_pack_row',
    '_pack_ugc_status',
    'pack_row_edit',
    'pack_rows',
]
