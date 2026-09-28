"""Super admin: publication-record quality (/data/record).

GET  /admin/record/duplicates              pairs that look like one paper
POST /admin/record/duplicates/merge        {keep_id, drop_id, reason}
POST /admin/record/duplicates/dismiss      {a, b}  not the same paper
GET  /admin/record/merges                  recent merges
POST /admin/record/merges/{id}/undo
GET  /admin/record/roster-names            roster spellings the papers disagree with
POST /admin/record/roster-names/apply      {user_id, name}
POST /admin/record/roster-names/dismiss    {user_id, name}
GET  /admin/record/anomalies               counts and samples
"""
from __future__ import annotations

import json
from typing import Optional

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import PublicationMerge, Role, User
from core.services import record_quality as rq


def _super(request: HttpRequest) -> User:
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can correct the publication record")
    return user


class MergeIn(Schema):
    keep_id: str
    drop_id: str
    reason: str = ""


class PairIn(Schema):
    a: str
    b: str


class NameIn(Schema):
    user_id: str
    name: str


@api.get("/admin/record/duplicates", auth=session_auth)
def record_duplicates(request: HttpRequest, person: Optional[str] = None, reason: Optional[str] = None):
    _super(request)
    pairs = rq.find_duplicates(user_id=person or None)
    s = rq.summary(pairs)
    if reason:
        pairs = [p for p in pairs if p["reason"] == reason]
    names = dict(User.objects.filter(pk__in={u for p in pairs for u in p["shared_people"]}).values_list("pk", "name"))
    for p in pairs:
        p["people"] = [{"id": u, "name": names.get(u, "")} for u in p["shared_people"]]
    return {"summary": s, "reasons": rq.REASONS, "pairs": pairs[:200]}


@api.post("/admin/record/duplicates/merge", auth=session_auth)
def record_merge(request: HttpRequest, payload: MergeIn):
    user = _super(request)
    try:
        m = rq.merge(payload.keep_id, payload.drop_id, user, reason=payload.reason[:32])
    except rq.MergeError as exc:
        raise HttpError(409, str(exc))
    return {"ok": True, "merge_id": m.pk}


@api.post("/admin/record/duplicates/dismiss", auth=session_auth)
def record_dismiss(request: HttpRequest, payload: PairIn):
    user = _super(request)
    rq.dismiss(payload.a, payload.b, user)
    return {"ok": True}


@api.get("/admin/record/merges", auth=session_auth)
def record_merges(request: HttpRequest, limit: int = 50):
    _super(request)
    rows = []
    for m in PublicationMerge.objects.select_related("actor")[: max(1, min(limit, 200))]:
        snap = json.loads(m.snapshot_json or "{}")
        removed = snap.get("removed", {})
        rows.append({"id": m.pk, "kept_id": m.kept_id, "removed_id": m.removed_id, "reason": m.reason,
                     "title": removed.get("title", ""), "year": removed.get("year"), "doi": removed.get("doi"),
                     "by": m.actor.name if m.actor_id else "A scheduled run", "at": m.created_at.isoformat(),
                     "undone_at": m.undone_at.isoformat() if m.undone_at else None})
    return {"merges": rows}


@api.post("/admin/record/merges/{merge_id}/undo", auth=session_auth)
def record_undo(request: HttpRequest, merge_id: str):
    user = _super(request)
    try:
        rq.undo_merge(merge_id, user)
    except rq.MergeError as exc:
        raise HttpError(409, str(exc))
    return {"ok": True}


@api.get("/admin/record/roster-names", auth=session_auth)
def record_roster_names(request: HttpRequest):
    _super(request)
    return {"suggestions": rq.roster_name_suggestions()}


@api.post("/admin/record/roster-names/apply", auth=session_auth)
def record_roster_apply(request: HttpRequest, payload: NameIn):
    user = _super(request)
    if not User.objects.filter(pk=payload.user_id).exists():
        raise HttpError(404, "No such person")
    try:
        u = rq.apply_roster_name(payload.user_id, payload.name, user)
    except ValueError as exc:
        raise HttpError(400, str(exc))
    return {"ok": True, "name": u.name}


@api.post("/admin/record/roster-names/dismiss", auth=session_auth)
def record_roster_dismiss(request: HttpRequest, payload: NameIn):
    user = _super(request)
    rq.dismiss_roster_suggestion(payload.user_id, payload.name, user)
    return {"ok": True}


@api.get("/admin/record/anomalies", auth=session_auth)
def record_anomalies(request: HttpRequest):
    _super(request)
    out = {}
    for key, qs in rq.anomalies().items():
        out[key] = {
            "count": qs.count(),
            "rows": [{"id": p.pk, "title": p.title, "year": p.year, "venue": p.venue, "doi": p.doi}
                     for p in qs[:25]],
        }
    return {"anomalies": out}


__all__ = [
    "record_duplicates", "record_merge", "record_dismiss", "record_merges", "record_undo",
    "record_roster_names", "record_roster_apply", "record_roster_dismiss", "record_anomalies",
]
