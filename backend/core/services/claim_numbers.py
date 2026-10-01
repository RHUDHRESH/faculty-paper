"""Claim numbers as people type them.

A claim number is `FP-2026-000123` for a claim filed here and
`ERP-PROCESSED-120` for one brought over from the old ERP. People type them
with spaces, in lower case, or with the zeros left off ("fp 2026 123"). This
module turns what was typed into the forms worth looking up, and says which
review queue holds a claim for the person asking, so a search hit can open the
right screen.

No database work happens here except `desk_queue_for`, which only reads the
claim it is given.
"""

from __future__ import annotations

import re

from core.models import ClaimStatus, Role
from core.services import rbac

_FP = re.compile(r"^FP(\d{4})(\d{1,6})$")
_SEPARATORS = re.compile(r"[\s_]+")


def dashed(text: str | None) -> str:
    """Upper case, with runs of spaces and underscores turned into one dash."""
    return _SEPARATORS.sub("-", (text or "").strip().upper()).strip("-")


def canonical(text: str | None) -> str | None:
    """The full form of a typed `FP-` number ("fp 2026 123" -> "FP-2026-000123"),
    or None when the text is not a complete one."""
    m = _FP.match(dashed(text).replace("-", ""))
    if not m:
        return None
    return f"FP-{m.group(1)}-{int(m.group(2)):06d}"


def variants(text: str | None) -> list[str]:
    """Every exact form worth trying, best first, without duplicates."""
    out: list[str] = []
    for v in (dashed(text), canonical(text)):
        if v and v not in out:
            out.append(v)
    return out


def looks_like_claim_number(text: str | None) -> bool:
    """True for "FP-2026-000123", "ERP-PROCESSED-120" and a start of either."""
    d = dashed(text)
    return bool(re.match(r"^(FP|ERP)(-|\d|$)", d)) and len(d) >= 2


def desk_queue_for(user, claim) -> str | None:
    """The review queue that holds `claim` for `user` to act on, if any.

    "clearing" for the research cell's desk, "approvals" for the Principal's,
    "authorisations" for the Director's. None for anybody who cannot act
    there, and for their own claim (nobody acts on their own).
    """
    if rbac.is_own_claim(user, claim):
        return None
    role = getattr(user, "role", None)
    status = claim.status
    if status == ClaimStatus.SUBMITTED and rbac.can_clear_claims(role):
        return "clearing"
    if status == ClaimStatus.CLEARED and role in (Role.PRINCIPAL, Role.SUPER_ADMIN):
        return "approvals"
    if status == ClaimStatus.PRINCIPAL_APPROVED and rbac.can_approve_as_director(role):
        return "authorisations"
    return None


def review_url(user, claim) -> str | None:
    """`/review/<id>?queue=…` when `claim` is at one of the viewer's desks."""
    queue = desk_queue_for(user, claim)
    return f"/review/{claim.id}?queue={queue}" if queue else None


def ticket_q(term: str | None):
    """A `Q` matching a claim number typed loosely ("fp 2026 123"), to be OR-ed
    into a queue's text search. Matches nothing for text that is not one."""
    from django.db.models import Q

    q = Q()
    for form in variants(term):
        q |= Q(ticket_number__iexact=form)
    return q


def outcome(c) -> dict[str, str]:
    """How a claim stands, in the words staff use."""
    s = c.status
    if s == ClaimStatus.PAID:
        return {"key": "paid", "label": "Paid"}
    if s in (ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.FINANCE_APPROVED):
        return {"key": "authorised", "label": "Authorised"}
    if s == ClaimStatus.PRINCIPAL_APPROVED:
        return {"key": "approved", "label": "Approved"}
    if s in (ClaimStatus.CLEARED, ClaimStatus.RESEARCH_APPROVED):
        return {"key": "on_hold" if c.on_hold else "cleared", "label": "On hold" if c.on_hold else "Cleared"}
    if s == ClaimStatus.REJECTED:
        if c.rejected_outright:
            return {"key": "rejected", "label": "Rejected"}
        return {"key": "sent_back", "label": "Sent back"}
    if s == ClaimStatus.DRAFT:
        return {"key": "draft", "label": "Withdrawn" if c.ticket_number else "Draft"}
    return {"key": "on_hold" if c.on_hold else "submitted", "label": "On hold" if c.on_hold else "Submitted"}


