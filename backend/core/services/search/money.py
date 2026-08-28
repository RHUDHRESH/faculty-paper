"""The one door money leaves this package by, and the one role it may not pass.

A head of department must never receive a rupee figure. `hod.without_money`
already strips the keys it knows about from anything routed through it, but a
search engine is exactly the shape of thing that defeats that filter: it can
*compute* a figure that was not in the database a moment ago, under whatever
key the author of the day happened to pick.

There is only one place in this whole package where an amount exists at all --
the amount on a ticket that has already been filed. Papers, venues and people
carry academic standing only: quartile, SNIP, SJR, citations, counts. Those are
properties of a journal or of a body of work rather than of anybody's pay, and
a head of department is entitled to every one of them. Estimating what a venue
would pay stays on `/discover`, where the money guard already lives.

So money-blindness here is three things:

1. **The key is omitted, not zeroed.** `amount: 0` is the bug this codebase
   shipped last week: a client gating on `!= null` renders zero as a real
   figure, and a head of department gets a ₹0 "Paid" column. `amount_for()`
   returns an empty mapping for a blind viewer, so the key is not in the
   response at all.
2. **The name is one the filter already knows.** `amount` is in
   `hod.MONEY_KEYS`, so even a payload that skipped this module is caught by
   `redact()` on the way out.
3. **That is checked at import.** `EMITTED_MONEY_KEYS` must be a subset of
   `hod.MONEY_KEYS`. Adding a money-bearing field here under a new name fails
   the import, loudly, instead of shipping a leak.
"""

from __future__ import annotations

from typing import Any

from core import hod
from core.models import Role

#: Roles that may not receive a rupee figure by any route.
MONEY_BLIND_ROLES = frozenset({Role.HOD})

#: Every key under which this package will ever put a figure. Deliberately one.
EMITTED_MONEY_KEYS = frozenset({"amount"})

_UNCOVERED = EMITTED_MONEY_KEYS - hod.MONEY_KEYS
if _UNCOVERED:  # pragma: no cover - a programming error, not a runtime state
    raise RuntimeError(
        "core.services.search.money would emit rupee figures under keys "
        f"hod.without_money does not strip: {sorted(_UNCOVERED)}. Either rename "
        "them onto an existing key in hod.MONEY_KEYS or add them to it."
    )


def may_see_money(role: str | None) -> bool:
    """Whether a viewer in this role may be told what something paid."""
    return (role or "") not in MONEY_BLIND_ROLES


def amount_for(value: float | None, role: str | None) -> dict[str, Any]:
    """A mapping to splat into a ticket: `{"amount": ...}`, or nothing at all.

    Nothing at all is the point. Returning `{"amount": 0}` or
    `{"amount": None}` puts the key in the response, and every client that has
    ever had to guard one of those has eventually got the guard wrong.
    """
    if not may_see_money(role):
        return {}
    return {"amount": value}


def redact(payload: Any, role: str | None) -> Any:
    """Last gate before a response leaves. A no-op for anybody who may see money.

    Belt to the braces above: even though nothing money-bearing is built for a
    blind viewer, everything still passes through the same filter the rest of
    the codebase uses, so a field added upstream of here is still caught.
    """
    if may_see_money(role):
        return payload
    return hod.without_money(payload)
