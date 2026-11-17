"""Super admin: fill the gaps in the record from the college's own files.

GET  /admin/data-fill                  the fixes and the last figures kept for each
POST /admin/data-fill/check            dry run (all, or ?key=); writes nothing, keeps the figures
POST /admin/data-fill/apply            queue one fix (?key=) or every safe one (no key); poll /admin/jobs/{id}
GET  /admin/data-fill/accounts         accounts with no department: the list to fix (readers of reports)
"""
from __future__ import annotations

import json
from typing import Optional

from django.http import HttpRequest
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Role
from core.services import data_fill, rbac


def _super(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can fill the record")
    return user


def _table(report: Optional[dict]) -> list[dict]:
    kept = {r["key"]: r for r in (report or {}).get("fixes", [])}
    return [
        {"key": f.key, "label": f.label, "help": f.help, "kind": f.kind, "safe": f.safe, "last": kept.get(f.key)}
        for f in data_fill.FIXES
    ]


@api.get("/admin/data-fill", auth=session_auth)
def data_fill_table(request: HttpRequest):
    _super(request)
    report = data_fill.last_report()
    from core.models import SystemSetting

    deploy = SystemSetting.objects.filter(key=data_fill.DEPLOY_KEY).first()
    return {"fixes": _table(report), "checked_at": (report or {}).get("updated_at"),
            "after_deploy": deploy.value if deploy else None}


@api.post("/admin/data-fill/check", auth=session_auth)
def data_fill_check(request: HttpRequest, key: Optional[str] = None):
    """A dry run. Nothing is written but the figures kept for this page."""
    _super(request)
    try:
        results = data_fill.run([key] if key else None, apply=False)
    except data_fill.UnknownFix as exc:
        raise HttpError(404, "No such fix") from exc
    report = data_fill.store_report(results)
    return {"fixes": _table(report), "checked_at": report["updated_at"]}


@api.post("/admin/data-fill/apply", auth=session_auth)
def data_fill_apply(request: HttpRequest, key: Optional[str] = None):
    """Queue one fix, or every safe one. Each is its own transaction with its own audit row."""
    user = _super(request)
    if key and (key not in data_fill.BY_KEY or key not in data_fill.WRITE_KEYS):
        raise HttpError(404, "No such fix, or one that is not applied from here")
    job = data_fill.queue_fills(user, "data health", [key] if key else None)
    AuditLog.objects.create(actor=user, action="DATA_FILL_QUEUED", entity="DataFill", entity_id=key or "all",
                            detail_json=json.dumps(job, default=str))
    return {"ok": True, **job}


@api.get("/admin/data-fill/accounts", auth=session_auth)
def data_fill_accounts(request: HttpRequest):
    """Active accounts with no department. Anyone who reads the college's reports
    can see which accounts the unknown bucket comes from; a super admin fixes them."""
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    rows = data_fill.accounts_without_department()
    return {"total": len(rows), "rows": rows, "can_fix": user.role == Role.SUPER_ADMIN}


__all__ = ["data_fill_table", "data_fill_check", "data_fill_apply", "data_fill_accounts"]
