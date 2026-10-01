"""Admin B: writing a data fix, the ledger checks and the plain-words change history.

The queue itself is `GET /admin/data-fixes` (attention.py). Writing a
fix is the super admin's alone: it changes a settled amount, and the college
keeps that behind one role.
"""

from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import _refuse_own_claim, api, require_user, session_auth
from core.models import AuditLog, Claim, Role
from core.services import change_history, claim_fixes, ledger_checks, rbac
from core import visibility


def _require_reader(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    return user


class DataFixIn(Schema):
    amount: Optional[float] = None
    title: Optional[str] = None
    quartile: Optional[str] = None
    no_payment: bool = False
    #: A ledger payment with no claim that this claim's amount comes from.
    link_ledger_row_id: Optional[str] = None
    #: The account the claim belongs to, for a claim whose claimant was not identified.
    owner_email: Optional[str] = None
    reason: str = ""


@api.post("/admin/data-fixes/{claim_id}", auth=session_auth)
def data_fix_apply(request: HttpRequest, claim_id: str, payload: DataFixIn):
    """Correct one imported claim. Writes the balancing ledger row for a
    settled amount, an audit entry with the reason, and says whether the
    ledger now agrees with the claim."""
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may correct an imported claim")
    if not Claim.objects.filter(pk=claim_id).exists():
        raise HttpError(404, "No such claim")
    try:
        return claim_fixes.apply_fix(
            actor,
            claim_id,
            amount=payload.amount,
            title=payload.title,
            quartile=payload.quartile,
            no_payment=payload.no_payment,
            link_ledger_row_id=payload.link_ledger_row_id,
            owner_email=payload.owner_email,
            reason=payload.reason,
        )
    except claim_fixes.FixError as exc:
        raise HttpError(400, str(exc))


@api.get("/admin/history", auth=session_auth)
def record_history(request: HttpRequest, entity: str, id: str, limit: int = 30):
    """Who changed this record, when, from what to what, in plain words."""
    user = require_user(request)
    if not rbac.can_view_audit(user.role):
        raise HttpError(403, "Forbidden")
    if entity not in ("Claim", "User", "FormulaConfig", "Budget", "PaidLedger", "DuplicateFinding", "system_setting"):
        raise HttpError(400, "No history is kept for that kind of record")
    if entity == "Claim":
        _refuse_own_claim_read(user, id)
    blind = visibility.is_contest_blind(user.role)
    if blind and entity == "DuplicateFinding":
        # A double-payment review is the contest itself; the Director and
        # Finance are not shown it.
        raise HttpError(403, "Forbidden")
    entries = change_history.for_record(
        entity, id, limit,
        exclude_actions=tuple(visibility.CONTEST_AUDIT_ACTIONS) if blind else (),
    )
    return {"entity": entity, "id": id, "entries": entries}


def _require_ledger_reader(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    return user


@api.get("/admin/ledger/checks", auth=session_auth)
def ledger_check_counts(request: HttpRequest):
    """Does the ledger agree with the paid claims? The real counts."""
    _require_ledger_reader(request)
    return ledger_checks.counts()


@api.get("/admin/ledger/problems", auth=session_auth)
def ledger_problems(request: HttpRequest, kind: str, q: str = "", limit: int = 50, offset: int = 0):
    """One list of what does not agree: paid with no ledger row, ledger rows
    that do not add up, or ledger rows with no claim."""
    _require_ledger_reader(request)
    try:
        return ledger_checks.problem_rows(kind, q.strip(), limit, offset)
    except ledger_checks.LedgerError as exc:
        raise HttpError(400, str(exc))


class LinkRowIn(Schema):
    claim: str
    reason: str = ""


class ReasonIn(Schema):
    reason: str = ""


@api.post("/admin/ledger/rows/{row_id}/link", auth=session_auth)
def ledger_link_row(request: HttpRequest, row_id: str, payload: LinkRowIn):
    """Attach a ledger row that has no claim to the paid claim it belongs to."""
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may change the ledger")
    try:
        return ledger_checks.link_row(actor, row_id, payload.claim, payload.reason)
    except ledger_checks.LedgerError as exc:
        raise HttpError(400, str(exc))


@api.post("/admin/ledger/claims/{claim_id}/add-row", auth=session_auth)
def ledger_add_row(request: HttpRequest, claim_id: str, payload: ReasonIn):
    """Write the ledger row a paid claim is missing, for its own amount."""
    actor = require_user(request)
    if actor.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may change the ledger")
    try:
        return ledger_checks.add_missing(actor, claim_id, payload.reason)
    except ledger_checks.LedgerError as exc:
        raise HttpError(400, str(exc))


@api.get("/admin/audit/actions", auth=session_auth)
def audit_actions(request: HttpRequest):
    """The kinds of entry the log actually holds, each in words, for the filter.
    Only what exists is offered, so a filter never returns nothing by design."""
    user = require_user(request)
    if not rbac.can_view_audit(user.role):
        raise HttpError(403, "Forbidden")
    codes = AuditLog.objects.order_by().values_list("action", flat=True).distinct()
    if visibility.is_contest_blind(user.role):
        codes = codes.exclude(action__in=visibility.CONTEST_AUDIT_ACTIONS)
    out = []
    for code in codes:
        phrase = change_history.ACTION_WORDS.get(code) or code.replace("_", " ").lower()
        out.append({"value": code, "label": phrase[:1].upper() + phrase[1:]})
    out.sort(key=lambda a: a["label"])
    return {"actions": out}


def _refuse_own_claim_read(user, claim_id: str) -> None:
    owner = Claim.objects.filter(pk=claim_id).values_list("owner_id", flat=True).first()
    if owner and owner == user.id:
        raise HttpError(403, "The trail of your own claim is not shown to you")


__all__ = [
    "audit_actions", "data_fix_apply", "ledger_add_row", "ledger_check_counts",
    "ledger_link_row", "ledger_problems", "record_history",
]
