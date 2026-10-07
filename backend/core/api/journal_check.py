"""Check a journal before submitting: GET /journals/check, and loading the flag lists."""

from __future__ import annotations

import json
from typing import Optional

from django.http import HttpRequest
from ninja import File
from ninja.errors import HttpError
from ninja.files import UploadedFile

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, JournalFlagList, Role
from core.services import journal_check


@api.get("/journals/check", auth=session_auth)
def check_journal(request: HttpRequest, q: str = "", pick: Optional[str] = None):
    user = require_user(request)
    if not q.strip():
        raise HttpError(400, "Type a journal name, an ISSN or a website.")
    return journal_check.check(user, q, pick)


@api.get("/journals/flag-lists", auth=session_auth)
def flag_lists(request: HttpRequest):
    require_user(request)
    from django.db.models import Count, Max

    rows = JournalFlagList.objects.values("source").annotate(n=Count("id"), loaded=Max("loaded_at"))
    have = {r["source"]: r for r in rows}
    return [
        {"source": s, "label": label, "entries": have.get(s, {}).get("n", 0),
         "loaded_at": have[s]["loaded"].isoformat() if s in have else None}
        for s, label in JournalFlagList.Source.choices
    ]


@api.post("/journals/flag-lists/upload", auth=session_auth)
def upload_flag_list(request: HttpRequest, source: str, file: UploadedFile = File(...), append: bool = False):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only the super admin can load a journal list.")
    if source not in JournalFlagList.Source.values:
        raise HttpError(400, "Choose which list this file is.")
    text = file.read(5_000_000).decode("utf-8-sig", errors="replace")
    n = journal_check.load_flags(text, source, replace=not append)
    AuditLog.objects.create(actor=user, action="JOURNAL_FLAGS_LOADED", entity="JournalFlagList",
                            detail_json=json.dumps({"source": source, "entries": n}))
    return {"source": source, "entries": n}
