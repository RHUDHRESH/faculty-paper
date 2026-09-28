"""Author-match review and duplicate accounts, for the office (super admin,
research coordinator -- `rbac.can_admin_portal`). No amounts, ever."""
from __future__ import annotations

import json
from typing import Optional

from django.db import IntegrityError
from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, session_auth
from core.api.teams import _require_office
from core.models import AuditLog
from core.services import author_review as svc


class DecideIn(Schema):
    key: str
    status: str
    user_id: Optional[str] = None


class UndoIn(Schema):
    key: str


class MergeIn(Schema):
    keep_id: str
    drop_id: str
    confirm: bool = False


@api.get("/admin/author-matches", auth=session_auth)
def author_matches(request: HttpRequest, status: str = "open", q: str = "", limit: int = 50, offset: int = 0):
    _require_office(request)
    return svc.unmatched_groups(status=status, q=q, limit=max(1, min(limit, 200)), offset=max(0, offset))


@api.post("/admin/author-matches/decide", auth=session_auth)
def author_match_decide(request: HttpRequest, payload: DecideIn):
    user = _require_office(request)
    try:
        return svc.decide(payload.key, payload.status, actor=user, user_id=payload.user_id)
    except svc.ReviewError as exc:
        raise HttpError(400, str(exc)) from exc


@api.post("/admin/author-matches/undo", auth=session_auth)
def author_match_undo(request: HttpRequest, payload: UndoIn):
    user = _require_office(request)
    try:
        return svc.undo(payload.key, actor=user)
    except svc.ReviewError as exc:
        raise HttpError(400, str(exc)) from exc


@api.post("/admin/author-matches/rerun", auth=session_auth)
def author_match_rerun(request: HttpRequest):
    """Queue match_authors (with record linking) on the job queue."""
    user = _require_office(request)
    from django_q.tasks import async_task

    job_id = async_task("core.tasks.rematch_authors", user.id, timeout=3600)
    AuditLog.objects.create(actor=user, action="AUTHOR_MATCH_QUEUED", entity="Publication",
                            detail_json=json.dumps({"job_id": job_id}))
    return {"ok": True, "queued": True, "job_id": job_id}


@api.get("/admin/duplicate-accounts", auth=session_auth)
def duplicate_accounts(request: HttpRequest):
    _require_office(request)
    return {"groups": svc.duplicate_accounts()}


@api.post("/admin/duplicate-accounts/merge", auth=session_auth)
def merge_accounts(request: HttpRequest, payload: MergeIn):
    user = _require_office(request)
    try:
        return svc.merge_accounts(payload.keep_id, payload.drop_id, actor=user, confirm=payload.confirm)
    except svc.ReviewError as exc:
        raise HttpError(400, str(exc)) from exc
    except IntegrityError as exc:
        raise HttpError(409, "Both accounts hold a claim in the same quota slot; resolve that claim first.") from exc


__all__ = [
    "author_match_decide",
    "author_match_rerun",
    "author_match_undo",
    "author_matches",
    "duplicate_accounts",
    "merge_accounts",
]
