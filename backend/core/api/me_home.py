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
        items.append({"id": p["id"], "title": p["title"], "venue": p["venue"], "year": p["year"]})
        if len(items) == UNFILED_SHOWN:
            break
    return {"count": len(rows), "items": items}


@api.get("/me/home", auth=session_auth)
def my_home(request: HttpRequest):
    user = require_user(request)
    mine = papers_for(user)
    known = [r.citations for r in mine if r.citations is not None]
    return {
        "papers": len(mine),
        "citations": sum(known) if known else None,
        "h_index": h_index(known) if known else None,
        "unfiled": unfiled_of(user),
    }


__all__ = ["my_home"]
