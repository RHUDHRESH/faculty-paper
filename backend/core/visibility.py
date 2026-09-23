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

**A faculty member never learns which desk, or which person, holds their
paper.** Every claim a FACULTY user receives gains `faculty_stage` -- one of
Draft, Submitted, Under review, Approved for payment, Paid, Sent back to you,
Not accepted, Withdrawn -- and `days_waiting`, counted from when the paper was
filed rather than from its last status change: a clock that restarted at each
desk would tell the claimant every time the paper changed hands. The names of
staff come off it, the desk's own notes come off it (the hold reason, and the
status note unless it is the reason the paper was sent back to them), and in
its history every step taken by somebody else reads as "The college", under an
action name that does not name a desk. The raw `status` stays, because the
client screens are built on it.

**A head of department sees nobody's money but their own.** A head is a
faculty member who also heads the department, so on their own claims they are
the claimant: those are shaped exactly as above and keep their amounts. Every
row that names anybody else as its owner loses every money key
(`hod.for_head`, which holds the rule and its one exception).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from django.utils import timezone

from core import hod
from core.models import ClaimStatus, Role

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


# ---- the claimant's view ----------------------------------------------------

#: The stage a claimant is shown for each status. Every step between filing
#: and the authorisation reads the same, on purpose: which of them it is, is
#: which desk has the paper.
_FACULTY_STAGE = {
    ClaimStatus.DRAFT: "Draft",
    ClaimStatus.SUBMITTED: "Under review",
    ClaimStatus.CLEARED: "Under review",
    ClaimStatus.PRINCIPAL_APPROVED: "Under review",
    ClaimStatus.DIRECTOR_APPROVED: "Approved for payment",
    ClaimStatus.PAID: "Paid",
    ClaimStatus.REJECTED: "Sent back to you",
    # Imported from the old ERP at stages the live chain has no name for.
    ClaimStatus.HOD_APPROVED: "Under review",
    ClaimStatus.RESEARCH_APPROVED: "Under review",
    ClaimStatus.FINANCE_APPROVED: "Approved for payment",
}

#: Every stage a claimant can be shown. "Submitted" is in the vocabulary for
#: the screens that draw the whole path; no status is shown as it, because a
#: filed paper is already with the college and so already under review.
FACULTY_STAGES = (
    "Draft", "Submitted", "Under review", "Approved for payment", "Paid",
    "Sent back to you", "Not accepted", "Withdrawn",
)

#: Statuses at which the college still has the paper and the claimant is
#: waiting on it.
_WAITING = {
    ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED,
    ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.HOD_APPROVED,
    ClaimStatus.RESEARCH_APPROVED, ClaimStatus.FINANCE_APPROVED,
}

#: Names of the staff who acted on a paper, as claim_to_dict emits them.
_STAFF_NAME_KEYS = (
    "cleared_by_name", "second_approved_by_name", "principal_approved_by_name",
    "director_approved_by_name", "held_by_name", "manual_verified_by_name",
    "override_by_name",
)

#: What a step taken by somebody else is called on the claimant's copy. The
#: history's own names (CLEAR, PRINCIPAL_APPROVE, DIRECTOR_APPROVE, ...) name
#: the desk; these name what happened to the paper.
_FACULTY_ACTION = {
    "ADMIN_CREATE": "CREATED",
    "CREATE_DRAFT": "CREATED",
    "SUBMIT": "SUBMITTED",
    "CONTEST_FORWARD": "SUBMITTED",
    "RESUBMIT": "SUBMITTED",
    "HOLD": "ON_HOLD",
    "RESUME": "RESUMED",
    "DIRECTOR_APPROVE": "APPROVED_FOR_PAYMENT",
    "MARK_PAID": "PAID",
    "VOID_PAYMENT": "PAYMENT_REVERSED",
    "REJECT": "SENT_BACK",
    "REJECT_OUTRIGHT": "NOT_ACCEPTED",
}
#: The steps whose note was written for the claimant: why it came back.
_NOTE_FOR_THE_CLAIMANT = {"REJECT", "REJECT_OUTRIGHT"}

#: What the claimant reads in place of a colleague's name.
THE_COLLEGE = "The college"


def faculty_stage(
    status: str | None, *, rejected_outright: bool = False, ticket_number: str | None = None
) -> str:
    """The stage a claimant is shown. A hold does not change it."""
    if status == ClaimStatus.REJECTED and rejected_outright:
        return "Not accepted"
    if status == ClaimStatus.DRAFT and ticket_number:
        # A ticket number is handed out when a paper is filed and kept after
        # it is pulled back, so a draft carrying one was withdrawn.
        return "Withdrawn"
    return _FACULTY_STAGE.get(status or "", "Under review")


def days_waiting(status: str | None, submitted_at: datetime | str | None) -> int | None:
    """Whole days since the paper was (last) filed, while the college has it."""
    if status not in _WAITING or not submitted_at:
        return None
    if isinstance(submitted_at, str):
        submitted_at = datetime.fromisoformat(submitted_at)
    return max(0, (timezone.now() - submitted_at).days)


def _is_claim(value: dict) -> bool:
    """A claim as claim_to_dict emits it."""
    return {"owner_id", "ticket_number", "status", "rejected_outright"} <= value.keys()


def _step_for_claimant(step: dict, owner_id: str | None) -> dict:
    if step.get("actor_id") is not None and step.get("actor_id") == owner_id:
        return step
    action = step.get("action")
    return {
        **step,
        "action": _FACULTY_ACTION.get(action, "IN_REVIEW"),
        "actor_id": None,
        "actor_name": THE_COLLEGE,
        "note": step.get("note") if action in _NOTE_FOR_THE_CLAIMANT else None,
    }


def _claim_for_claimant(claim: dict) -> dict:
    status = claim.get("status")
    claim["faculty_stage"] = faculty_stage(
        status,
        rejected_outright=bool(claim.get("rejected_outright")),
        ticket_number=claim.get("ticket_number"),
    )
    claim["days_waiting"] = days_waiting(status, claim.get("submitted_at"))
    owner_name = claim.get("owner_name")
    for key in _STAFF_NAME_KEYS:
        # Kept only where it is the claimant's own name -- a contest they
        # forwarded themselves records them as the one who set it aside.
        if key in claim and claim[key] != owner_name:
            claim[key] = None
    # Written by the desk, for the desk.
    claim["hold_reason"] = None
    if status != ClaimStatus.REJECTED:
        claim["status_note"] = None
    if isinstance(claim.get("actions"), list):
        claim["actions"] = [
            _step_for_claimant(step, claim.get("owner_id")) if isinstance(step, dict) else step
            for step in claim["actions"]
        ]
    return claim


def for_claimant(value: Any, *, owner_id: Any = None) -> Any:
    """The same structure with every claim in it shaped for its claimant.

    With `owner_id`, only that person's claims are shaped: a head of
    department is the claimant on their own papers and not on anybody else's.
    """
    if isinstance(value, dict):
        out = {k: for_claimant(v, owner_id=owner_id) for k, v in value.items()}
        mine = owner_id is None or out.get("owner_id") == owner_id
        return _claim_for_claimant(out) if _is_claim(out) and mine else out
    if isinstance(value, (list, tuple)):
        return [for_claimant(v, owner_id=owner_id) for v in value]
    return value


def for_viewer(user: Any, value: Any) -> Any:
    """`value` as the signed-in `user` may see it."""
    role = getattr(user, "role", None)
    if is_contest_blind(role):
        return without_contest_flags(value)
    if role == Role.FACULTY:
        return for_claimant(value)
    if role == Role.HOD:
        # A faculty member who also heads the department: the claimant's view
        # of their own papers, and nobody's money but their own.
        viewer_id = getattr(user, "pk", None)
        return hod.for_head(for_claimant(value, owner_id=viewer_id), viewer_id)
    return value
