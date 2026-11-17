"""The faculty Home's record in one light call.

Home used to read `/me/summary` (which also works out the department rank,
about 0.8 s on the real data) and `/me/publications` (every paper with every
author, 300 KB) to draw one paper count, two figures and three unfiled
papers. This answers the same questions in one pass over the person's record:

- **papers** is the count My papers, My research and `/me/summary` share
  (`person_record.papers_for`), so they never disagree.
- **unfiled.count** is the My papers "Not claimed" rule (`claim_state`), and
  `unfiled.items` are the newest of those, one row per title, so a paper the
  record holds twice is offered once.

Everything here is the caller's own; there is no money and no desk.
"""
from __future__ import annotations

from typing import Optional

from django.http import HttpRequest

from core.api.common import api, require_user, session_auth
from core.api.me_summary import h_index
from core.api.publications import _ClaimIndex, _LedgerIndex, _publications, claim_state
from core.models import Authorship, User
from core.services.normalize import normalize_title
from core.services.person_record import papers_for

#: Unfiled papers named on Home; the rest are one click away on My papers.
UNFILED_SHOWN = 3


def journal_standing(p: dict) -> tuple[Optional[str], Optional[float]]:
    """The quartile and SNIP the filing form shows for this paper's journal.

    The publication row often has no quartile of its own, while the form fills
    it from the Scimago and SNIP tables by ISSN (`/lookup/enrich`). Home asks
    the same tables, so the two cannot say "None" and "Q4" about one paper.
    """
    from django.db.models import Q

    from core.models import SnipSource
    from core.services.scimago import issn_variants, lookup_scimago

    quartile = p.get("quartile") or None
    sc = lookup_scimago(issn=p.get("issn"), title=p.get("venue")) if (p.get("issn") or p.get("venue")) else None
    if sc and sc.get("found") and not quartile:
        quartile = sc.get("matched_quartile") or None
    codes = {v for raw in (p.get("issn"), (sc or {}).get("issn"), (sc or {}).get("eissn")) if raw for v in issn_variants(raw)}
    snip = None
    if codes:
        hit = (
            SnipSource.objects.filter(Q(print_issn__in=codes) | Q(e_issn__in=codes))
            .exclude(snip__isnull=True)
            .order_by("-year")
            .first()
        )
        snip = hit.snip if hit else None
    return quartile, snip


def unfiled_of(user: User) -> Optional[dict]:
    """`{count, items}` of papers on the record with no live claim, or None
    while the person has no authorships (the row is hidden, never "0")."""
    if not Authorship.objects.filter(user=user).exists():
        return None
    index, ledger = _ClaimIndex(user), _LedgerIndex(user)
    rows = [
        p
        for p in _publications(user)
        if (s := claim_state(p, index, ledger))["claim"] is None and s["eligible"]
    ]
    seen: set[str] = set()
    items = []
    for p in rows:
        key = normalize_title(p["title"] or "") or str(p["id"])
        if key in seen:
            continue
        seen.add(key)
        quartile, snip = journal_standing(p)
        items.append({
            "id": p["id"], "title": p["title"], "venue": p["venue"], "year": p["year"],
            # The journal's quartile as the record holds it, or null. It says
            # how much a paper is worth filing without guessing an amount:
            # the figure itself needs the journal's SNIP and subject class,
            # which are only settled while filing.
            "quartile": quartile,
            "snip": snip,
        })
        if len(items) == UNFILED_SHOWN:
            break
    return {"count": len(rows), "items": items}


def quartile_counts(papers) -> dict:
    """The record by journal quartile. Every paper is in exactly one group."""
    out = {"Q1": 0, "Q2": 0, "Q3": 0, "Q4": 0, "none": 0}
    for r in papers:
        q = (r.quartile or "").upper()
        out[q if q in out else "none"] += 1
    return out


@api.get("/me/home", auth=session_auth)
def my_home(request: HttpRequest):
    user = require_user(request)
    mine = papers_for(user)
    known = [r.citations for r in mine if r.citations is not None]
    return {
        "papers": len(mine),
        "citations": sum(known) if known else None,
        "h_index": h_index(known) if known else None,
        "quartiles": quartile_counts(mine),
        "unfiled": unfiled_of(user),
    }


__all__ = ["my_home"]
