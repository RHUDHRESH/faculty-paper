"""What each seat in the chain is shown about a paper, enforced in one place.

`hod.without_money` is the model: a rule about what a role must never see is
kept as a denylist of keys and applied to whole payloads, recursively, rather
than remembered at each endpoint. The difference here is where it is applied:
not by each endpoint that happens to return a claim, but once, on the way out,
by the API's renderer (`core.api.common.ViewerAwareRenderer`). An endpoint
added next year that returns a claim is covered without anybody remembering to
cover it.

The rule this module holds:

**The Director and Finance do not see a contested payment-history match.**
When a claimant's paper matched an earlier payment and they sent it on anyway
with a note, the research supervisor and the Principal weigh that; the two
seats after them authorise and pay what those desks have already decided. So
every key that carries the contest, the duplicate match, or the override of
it is removed from anything a Director or Finance user receives -- and the
paper's history is told without the contest: a CONTEST_FORWARD step reads as
an ordinary SUBMIT, and the claimant's contest note is dropped from it.

`verification_ok` and `verification_snapshot_json` are in the list because
either one tells the reader the same thing: a filed paper whose verification
did not pass is, by the submission rules, a contested one.
"""
from __future__ import annotations

from typing import Any

from core.models import Role

#: Every key that carries a contested or duplicate flag, under the names the
#: serialisers actually emit.
CONTEST_KEYS = frozenset({
    "contest_forward",
    "contest_note",
    "verification_ok",
    "verification_snapshot_json",
    "duplicate_warning",
    "duplicate_matches",
    "duplicate_matches_json",
    "override_duplicate",
    "override_reason",
    "override_by_name",
    "override_at",
})

#: Seats in the chain that do not see the contest.
CONTEST_BLIND_ROLES = frozenset({Role.DIRECTOR, Role.FINANCE})

#: History steps whose note is the claimant's contest note.
_CONTEST_ACTIONS = {"CONTEST_FORWARD": "SUBMIT", "RESUBMIT": "RESUBMIT"}

#: Audit entries that exist only because of a duplicate. Filtered out of the
#: audit log for the contest-blind roles by the audit endpoint itself, since a
#: row has to be dropped from the count as well as from the page.
CONTEST_AUDIT_ACTIONS = ("DUPLICATE_REVIEW",)


def is_contest_blind(role: str | None) -> bool:
    return role in CONTEST_BLIND_ROLES


def _is_history_step(value: dict) -> bool:
    return "action" in value and "from_status" in value and "to_status" in value


def without_contest_flags(value: Any) -> Any:
    """The same structure with every contested/duplicate flag removed.

    Recursive for the same reason `without_money` is: a claim arrives as a
    dict, a queue as a list of them, a report as a dict of lists.
    """
    if isinstance(value, dict):
        out = {
            k: without_contest_flags(v)
            for k, v in value.items()
            if k not in CONTEST_KEYS
        }
        if _is_history_step(out) and out.get("action") in _CONTEST_ACTIONS:
            out["action"] = _CONTEST_ACTIONS[out["action"]]
            out["note"] = None
        return out
    if isinstance(value, (list, tuple)):
        return [without_contest_flags(v) for v in value]
    return value


def for_viewer(user: Any, value: Any) -> Any:
    """`value` as the signed-in `user` may see it."""
    role = getattr(user, "role", None)
    if is_contest_blind(role):
        return without_contest_flags(value)
    return value
