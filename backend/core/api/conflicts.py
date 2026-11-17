"""The Data conflicts screen: what the college's files say that the app does not.

GET  /admin/conflicts?status=open&kind=   the list, with the counts above it
POST /admin/conflicts/{id}/resolve        one action on one conflict

The importers note each difference (`services/import_conflicts.py`); this is
where the office settles them by clicking. The list is read by the roles that
may import (`rbac.can_import_prior`) and by the Vice principal, read-only
(`rbac.can_read_conflicts`). Changing anything is for the office that
manages accounts (`rbac.can_manage_users`): a settled amount is money and a
settled email or Staff ID is somebody's sign-in. An account that decides
whether money moves is a super admin's alone (`_refuse_protected`), here as
everywhere else.
"""
from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import ImportConflict, Role, User
from core.services import import_conflicts as svc
from core.services import rbac
from core.services.fyp_roster import staff_key

MAX_ROWS = 1500
STATUSES = ("open", "resolved", "dismissed")

PERSON_LOCKED = "Only a super admin can change this account. It decides whether money moves."
LEDGER_LOCKED = "Only a super admin can change the payments of this account. It decides whether money moves."


class ResolveIn(Schema):
    action: str
    note: Optional[str] = ""


def _protected(actor: User):
    """What the service calls before it touches an account: a super admin's alone if it is protected."""

    def protect(target: User, doing: str) -> None:
        from core.api.admin import _refuse_protected  # late: keeps route registration order

        _refuse_protected(actor, target, doing=doing)

    return protect


def _row(c: ImportConflict, account: User | None, actor: User) -> dict:
    p = c.payload or {}
    locked = None
    actions: list[str] = []
    paused = c.paused_at is not None
    if c.kind != svc.DOUBLE and account is not None and account.role in rbac.PROTECTED_ROLES and actor.role != Role.SUPER_ADMIN:
        locked = PERSON_LOCKED if c.kind == svc.FACULTY else LEDGER_LOCKED
    elif c.kind == svc.FACULTY:
        if account is not None:
            if c.status == svc.OPEN:
                actions = ["use_list", "keep_app"]
                if account.active:
                    actions.append("pause_account")
            if paused:
                actions.append("reactivate")
    elif c.kind == svc.DOUBLE:
        if c.status == svc.OPEN:
            actions = list(svc.DOUBLE_ACTIONS)
    elif c.status == svc.OPEN:
        actions = ["update_ledger", "keep_ledger"]
    out = {
        "id": c.id,
        "kind": c.kind,
        "key": c.key,
        "status": c.status,
        "source_file": c.source_file,
        "detected_at": c.detected_at.isoformat(),
        "staff_id": p.get("staff_id") or "",
        "name": p.get("name") or "",
        "field": p.get("field"),
        "field_label": svc.FIELD_LABEL.get(p.get("field") or "", None),
        "current": p.get("current"),
        "incoming": p.get("incoming"),
        "title": p.get("title"),
        "month": p.get("month"),
        "ledger_amount": p.get("ledger_amount"),
        "file_amount": p.get("file_amount"),
        "payments": p.get("payments"),
        "total": p.get("total"),
        "resolution": c.resolution,
        "resolution_note": c.resolution_note,
        "resolved_by": (c.resolved_by.name or c.resolved_by.email) if c.resolved_by_id else None,
        "resolved_at": c.resolved_at.isoformat() if c.resolved_at else None,
        "paused": paused,
        "account_active": account.active if account is not None else None,
        "actions": actions,
        "locked": locked,
        "user_id": account.id if account is not None else None,
    }
    return out


@api.get("/admin/conflicts", auth=session_auth)
def list_conflicts(request: HttpRequest, status: str = "open", kind: str = ""):
    user = require_user(request)
    if not rbac.can_read_conflicts(user.role):
        raise HttpError(403, "Forbidden")
    if status not in (*STATUSES, "all"):
        raise HttpError(400, "Status must be open, resolved, dismissed or all.")
    if kind not in ("", svc.FACULTY, svc.AMOUNT, svc.DOUBLE):
        raise HttpError(400, "Kind must be faculty, amount or double_payment.")
    qs = ImportConflict.objects.select_related("resolved_by")
    if status != "all":
        qs = qs.filter(status=status)
    if kind:
        qs = qs.filter(kind=kind)
    rows = list(qs.order_by("-detected_at", "key")[: MAX_ROWS + 1])
    truncated = len(rows) > MAX_ROWS
    rows = rows[:MAX_ROWS]

    # One account per row, found in a few queries for the whole list.
    faculty = [c for c in rows if c.kind == svc.FACULTY]
    mine = svc.targets_for([c.payload or {} for c in faculty])
    accounts: dict[str, User | None] = {c.id: mine[i] for i, c in enumerate(faculty)}
    amounts = [c for c in rows if c.kind in (svc.AMOUNT, svc.DOUBLE)]
    staff_map = svc.by_staff({staff_key((c.payload or {}).get("staff_id")) for c in amounts})
    for c in amounts:
        found = staff_map.get(staff_key((c.payload or {}).get("staff_id")), [])
        accounts[c.id] = found[0] if len(found) == 1 else None

    return {
        "counts": svc.counts(),
        "total": len(rows),
        "truncated": truncated,
        "may_resolve": rbac.can_manage_users(user.role),
        "rows": [_row(c, accounts.get(c.id), user) for c in rows],
    }


@api.post("/admin/conflicts/{conflict_id}/resolve", auth=session_auth)
def resolve_conflict(request: HttpRequest, conflict_id: str, payload: ResolveIn):
    user = require_user(request)
    if not rbac.can_manage_users(user.role):
        raise HttpError(403, "Forbidden")
    try:
        return svc.resolve(user, conflict_id, (payload.action or "").strip(), payload.note or "", _protected(user))
    except svc.ConflictError as exc:
        raise HttpError(exc.status, exc.message) from exc


__all__ = ["list_conflicts", "resolve_conflict", "ResolveIn"]
