"""What on the office's alarm counts is from before this system.

The office homes headline what someone can act on now. A problem on a claim
already paid, or on an ERP-imported claim closed as handled in the old system,
is history: still listed in full, counted apart as "from before this system".
Nothing here deletes or resolves anything.
"""
from __future__ import annotations

import json

from django.db.models import Q

from core.models import ClaimStatus, DuplicateFinding
from core.visibility import ERP_CLOSED_NOTE


def claim_q(prefix: str = "") -> Q:
    """Claims whose problems are history. `prefix` reaches them through a
    relation (`"claim__"` for a flag)."""
    return Q(**{f"{prefix}status": ClaimStatus.PAID}) | Q(
        **{f"{prefix}status": ClaimStatus.REJECTED, f"{prefix}status_note": ERP_CLOSED_NOTE}
    )


def finding_is_legacy(finding: DuplicateFinding) -> bool:
    """A duplicate payment found only among old-ERP payments. One payment made
    through this app makes it today's question."""
    try:
        rows = json.loads(finding.rows_json or "[]")
    except ValueError:
        return False
    return bool(rows) and all(
        r.get("source") == "prior" or str(r.get("reference") or "").startswith("ERP-")
        for r in rows
    )


def open_duplicates_split(kind: str | None = None) -> tuple[int, int]:
    """(actionable, legacy) among the open duplicate findings."""
    qs = DuplicateFinding.objects.filter(status=DuplicateFinding.Status.OPEN)
    if kind:
        qs = qs.filter(kind=kind)
    legacy = sum(1 for f in qs.only("id", "rows_json") if finding_is_legacy(f))
    return qs.count() - legacy, legacy
