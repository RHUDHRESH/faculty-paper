"""Super-admin: the data-health audit and full backups.

GET  /admin/data-health               last stored report (?fresh=1 runs it now)
POST /admin/data-health/fix/{key}     one of the safe, audited fixes
GET  /admin/backups                   stored backups, newest first
POST /admin/backups                   queue a backup now (poll /admin/jobs/{id})
GET  /admin/backups/download?name=    stream one stored backup
"""
from __future__ import annotations

import json

from django.http import HttpRequest, StreamingHttpResponse
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Role
from core.services import backup, integrity


def _super(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can see data health and backups")
    return user


@api.get("/admin/data-health", auth=session_auth)
def data_health(request: HttpRequest, fresh: bool = False):
    _super(request)
    report = integrity.run_and_store() if fresh else integrity.last_report()
    fixes = {k: label for k, (label, _) in integrity.FIXES.items()}
    return {"report": report, "fixes": fixes, "backups": backup.stored()}


@api.post("/admin/data-health/fix/{key}", auth=session_auth)
def data_health_fix(request: HttpRequest, key: str):
    user = _super(request)
    if key not in integrity.FIXES:
        raise HttpError(404, "No such fix")
    changed = integrity.apply_fix(key, user)
    report = integrity.run_and_store()
    return {"ok": True, "changed": changed, "report": report}


@api.get("/admin/backups", auth=session_auth)
def list_backups(request: HttpRequest):
    _super(request)
    return {"backups": backup.stored(), "keep": backup.KEEP, "max_bytes": backup.MAX_STORED_BYTES}


@api.post("/admin/backups", auth=session_auth)
def queue_backup(request: HttpRequest):
    user = _super(request)
    from django_q.tasks import async_task

    job_id = async_task("core.tasks.run_stored_backup", "manual")
    AuditLog.objects.create(actor=user, action="BACKUP_QUEUED", entity="Backup", detail_json=json.dumps({"job_id": job_id}))
    return {"queued": True, "job_id": job_id}


@api.get("/admin/backups/download", auth=session_auth)
def download_backup(request: HttpRequest, name: str):
    user = _super(request)
    data = backup.read_stored(name)
    if data is None:
        raise HttpError(404, "No such backup")
    AuditLog.objects.create(actor=user, action="BACKUP_DOWNLOADED", entity="Backup", entity_id=name[:64])

    def chunks(size=256 * 1024):
        for i in range(0, len(data), size):
            yield data[i:i + size]

    resp = StreamingHttpResponse(chunks(), content_type="application/gzip")
    resp["Content-Disposition"] = f'attachment; filename="{name.rsplit("/", 1)[-1]}"'
    resp["Content-Length"] = str(len(data))
    return resp


__all__ = ["data_health", "data_health_fix", "list_backups", "queue_backup", "download_backup"]
