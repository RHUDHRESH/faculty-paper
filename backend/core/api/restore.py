"""Load a full export into a fresh installation.

The one way to move an existing college onto a host with no shell (Render's
free plan): export with `manage.py dumpdata --natural-foreign
--natural-primary` where the data lives, then upload the file here as the
first super admin of the new installation. It runs on the job queue; poll
/api/admin/jobs/{job_id}.

It refuses once the installation holds any claim -- a restore merges rows by
primary key, and doing that over live data would be a silent overwrite.
"""
from __future__ import annotations

import json
import uuid as uuid_lib
from pathlib import Path

from django.conf import settings
from django.http import HttpRequest
from ninja import File, Form
from ninja.errors import HttpError
from ninja.files import UploadedFile

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Claim, Role


@api.post("/admin/restore", auth=session_auth)
def restore_export(request: HttpRequest, file: UploadedFile = File(...), confirm: str = Form("")):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may restore an export")
    if confirm.strip().upper() != "RESTORE":
        raise HttpError(400, 'Type RESTORE to confirm')
    if Claim.objects.exists():
        raise HttpError(409, "This installation already holds claims; a restore is only for a fresh one")
    name = (file.name or "").lower()
    if not name.endswith((".json", ".json.gz")):
        raise HttpError(400, "Upload the .json or .json.gz file made by dumpdata")
    raw = file.read()
    if len(raw) > 90 * 1024 * 1024:
        raise HttpError(400, "File too large (max 90 MB)")

    imports_dir = Path(settings.MEDIA_ROOT) / "imports"
    imports_dir.mkdir(parents=True, exist_ok=True)
    saved = imports_dir / f"{uuid_lib.uuid4().hex}{'.json.gz' if name.endswith('.gz') else '.json'}"
    saved.write_bytes(raw)

    from django_q.tasks import async_task

    job_id = async_task("core.tasks.run_restore", str(saved), user.id)
    AuditLog.objects.create(
        actor=user,
        action="RESTORE_QUEUED",
        entity="Export",
        detail_json=json.dumps({"filename": file.name, "bytes": len(raw), "job_id": job_id}),
    )
    return {"ok": True, "queued": True, "job_id": job_id}


__all__ = ["restore_export"]
