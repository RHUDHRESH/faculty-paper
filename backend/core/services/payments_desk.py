"""Figures the Director's and Finance's desks read over a whole queue.

A page of fifty claims is not the queue: the Finance officer deciding whether
to run the batch, and the Director deciding whether the college can afford it,
both need the total over everything waiting. The screens used to add up the
page they happened to have and print a warning when there was more, which is
a partial total wearing a caveat. These are computed once, here, over the
whole set, so the Home, the queue and the statement cannot disagree.

Nothing here names a flag. The Director and Finance are contest-blind
(`core.visibility`): a claim held for a second signature is counted as held,
and the reason a second signature is wanted is not part of any figure.
"""
from __future__ import annotations

from typing import Any, Iterable

from django.db.models import Count, Sum

from core.models import PaidLedger


def _round(n: float | None) -> float:
    return round(n or 0.0, 2)


def payable_totals(qs) -> dict[str, Any]:
    """Whole-queue figures for the authorised-and-unpaid claims in `qs`.

    `ready` is what Finance can pay now; `held` needs a second signature or
    has no calculable amount. `held_back` is the research threshold: the part
    of the policy amounts that will not be paid because it counts against a
    research faculty member's yearly threshold.
    """
    from core.api.common import _high_value_threshold, _needs_second_approval

    limit = _high_value_threshold()
    rows = list(
        qs.select_related(None)
        .prefetch_related(None)
        .only(
            "id",
            "remuneration",
            "research_absorbed",
            "calc_error",
            "status",
            "cleared_by",
            "second_approved_by",
            "duplicate_warning",
            "override_duplicate",
            "director_approved_at",
        )
    )
    out = {
        "count": len(rows),
        "amount": 0.0,
        "ready_count": 0,
        "ready_amount": 0.0,
        "held_count": 0,
        "held_amount": 0.0,
        "no_amount_count": 0,
        "held_back": 0.0,
        "held_back_count": 0,
        "zero_count": 0,
    }
    for c in rows:
        amount = c.remuneration or 0.0
        out["amount"] += amount
        absorbed = c.research_absorbed or 0.0
        if absorbed > 0.005:
            out["held_back"] += absorbed
            out["held_back_count"] += 1
        if c.calc_error:
            out["no_amount_count"] += 1
        blocked = bool(c.calc_error) or _needs_second_approval(c, limit)
        if blocked:
            out["held_count"] += 1
            out["held_amount"] += amount
        else:
            out["ready_count"] += 1
            out["ready_amount"] += amount
            if amount <= 0.005:
                out["zero_count"] += 1
    for k in ("amount", "ready_amount", "held_amount", "held_back"):
        out[k] = _round(out[k])
    return out


def paid_totals(qs) -> dict[str, Any]:
    agg = qs.select_related(None).prefetch_related(None).aggregate(n=Count("id"), s=Sum("remuneration"))
    return {"count": agg["n"] or 0, "amount": _round(agg["s"])}


def threshold_totals(qs) -> dict[str, Any]:
    """The research threshold's effect on a queue: how many claims it touches
    and how much of their policy amounts it holds back."""
    agg = (
        qs.select_related(None)
        .prefetch_related(None)
        .filter(research_absorbed__gt=0.005)
        .aggregate(n=Count("id"), s=Sum("research_absorbed"))
    )
    return {"held_back_count": agg["n"] or 0, "held_back": _round(agg["s"])}


def attach_ledger(rows: Iterable[dict[str, Any]]) -> None:
    """Put `ledger_paid` (net of reversals) and `ledger_rows` on each claim dict.

    This is what makes the duplicate-payment guard visible: the server refuses
    to pay a claim that already has a positive net on the ledger, and the
    screen can now say "no payment on the ledger for this claim" before the
    button is pressed, or "₹X is already on the ledger" when it is.
    """
    rows = list(rows)
    ids = [r["id"] for r in rows if r.get("id")]
    if not ids:
        return
    net = {
        r["claim_id"]: (r["s"] or 0.0, r["n"])
        for r in PaidLedger.objects.filter(claim_id__in=ids)
        .values("claim_id")
        .annotate(s=Sum("amount"), n=Count("id"))
    }
    for r in rows:
        s, n = net.get(r["id"], (0.0, 0))
        r["ledger_paid"] = _round(s)
        r["ledger_rows"] = n
