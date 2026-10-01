"""Claims imported from the old ERP that need a person to fix them.

The old ERP's workbook left holes: a claim marked paid with no amount, a
paper whose title is "-", a journal article with no quartile. The claim is
real, so it cannot be dropped; it needs a human to fill the gap. This module
is the one place that says which claims those are, so Admin, Track and the
fix page count the same set the same way.

Only claims carrying an ERP number ("ERP-RAW-3" from the ERP's raw sheet,
"ERP-PROCESSED-10" from its processed sheet) are looked at. A claim filed in this system has a form that will not let it be
saved without a title, so a hole there is a bug, not an import gap.

Read-only: nothing here changes a claim.
"""
from __future__ import annotations

from typing import Any

from django.db.models import Q, QuerySet

from core.models import Claim, ClaimStatus

#: The accounts workbook pays some papers nothing on purpose ("processed only
#: for count"). Those are not a lost figure, so they are not a fix.
_COUNT_ONLY = Q(status_note__icontains="only for count") | Q(status_note__iregex=r"no\s*re[nm]u")
_BLANK_TITLE = Q(paper_title__isnull=True) | Q(paper_title__regex=r"^[-–—.?\s]*$") | Q(
    paper_title__iregex=r"^(n/?a|nil|null|none|tbd)$"
)
_BLANK_QUARTILE = Q(quartile__isnull=True) | Q(quartile__regex=r"^[-–—.?\s]*$")

KINDS: tuple[tuple[str, str, str], ...] = (
    ("paid_no_amount", "Paid with no amount",
     "The claim is marked paid but the amount was lost in the import. Find it in the accounts sheet."),
    ("untitled", "No paper title",
     "The old ERP row had no title, so nobody can tell which paper this is."),
    ("no_quartile", "No quartile",
     "A journal article with no quartile cannot be priced. Set it from the journal's page."),
    ("no_claimant", "Claimant not identified",
     "The old ERP row named someone who is not on the faculty list, so nobody is credited with the paper."),
)

#: What a person reads for each problem on a row.
PROBLEM_WORDS = {
    "paid_no_amount": "Amount not recorded",
    "untitled": "No title",
    "no_quartile": "No quartile",
    "no_claimant": "Claimant not identified",
}


def _erp() -> QuerySet:
    return Claim.objects.filter(ticket_number__startswith="ERP-")


def queryset(kind: str) -> QuerySet:
    base = _erp()
    if kind == "paid_no_amount":
        return (
            base.filter(status=ClaimStatus.PAID)
            .filter(Q(remuneration__isnull=True) | Q(remuneration=0))
            .exclude(_COUNT_ONLY)
        )
    if kind == "untitled":
        return base.filter(_BLANK_TITLE)
    if kind == "no_claimant":
        return base.filter(owner__name__iexact="Not Found")
    if kind == "no_quartile":
        # A conference paper has no quartile to give, and a draft is not yet
        # anyone's problem.
        return (
            base.filter(_BLANK_QUARTILE)
            .exclude(status=ClaimStatus.DRAFT)
            .exclude(publication_type__icontains="conference")
            .exclude(publication_type__icontains="proceeding")
        )
    raise ValueError(kind)


def counts() -> list[dict[str, Any]]:
    return [
        {"key": key, "label": label, "why": why, "count": queryset(key).count()}
        for key, label, why in KINDS
    ]


def total() -> int:
    """Claims with at least one problem (a claim with two counts once)."""
    ids: set[str] = set()
    for key, _l, _w in KINDS:
        ids.update(queryset(key).values_list("id", flat=True))
    return len(ids)


def problems_for(claim_ids: list[str]) -> dict[str, list[str]]:
    """{claim id: [problem key, ...]} for just these claims (one query each)."""
    out: dict[str, list[str]] = {}
    if not claim_ids:
        return out
    for key, _l, _w in KINDS:
        for cid in queryset(key).filter(id__in=claim_ids).values_list("id", flat=True):
            out.setdefault(cid, []).append(key)
    return out


def rows(kind: str | None = None, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    if kind:
        qs = queryset(kind)
        ids = list(qs.order_by("ticket_number").values_list("id", flat=True))
    else:
        seen: dict[str, None] = {}
        for key, _l, _w in KINDS:
            for cid in queryset(key).order_by("ticket_number").values_list("id", flat=True):
                seen.setdefault(cid, None)
        ids = list(seen)
    page_ids = ids[offset: offset + limit]
    found = {
        c.id: c for c in Claim.objects.filter(id__in=page_ids).select_related("owner")
    }
    kinds = problems_for(page_ids)
    out = []
    for cid in page_ids:
        c = found.get(cid)
        if c is None:
            continue
        out.append({
            "id": c.id,
            "ticket_number": c.ticket_number,
            "owner_id": c.owner_id,
            "owner_name": c.owner.name,
            "owner_department": c.owner.department,
            "paper_title": c.paper_title,
            "journal_title": c.journal_title,
            "problems": [
                {"key": k, "label": PROBLEM_WORDS[k]} for k in kinds.get(cid, [])
            ],
        })
    return {"total": len(ids), "limit": limit, "offset": offset, "rows": out}
