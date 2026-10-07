"""Load a full export into a fresh installation.

The one way to move an existing college onto a host with no shell (Render's
free plan): export with `manage.py dumpdata` where the data lives (the exact
command is in docs/ops/move-host.md), then upload the file here as the first
super admin of the new installation. It runs on the job queue
(core/services/restore.py): streamed, a batch at a time, with its place saved
after each batch.

POST /admin/restore          upload (.jsonl, .jsonl.gz, .json, .json.gz) and queue
GET  /admin/restore/status   progress of the current or last restore
POST /admin/restore/resume   carry on an interrupted one from the file kept on the server

It refuses once the installation holds any claim -- a restore merges rows by
primary key, and doing that over live data would be a silent overwrite --
except to continue an interrupted restore of the very same file (matched by
SHA-256), which is exactly what a restart of the free host makes necessary.
"""
from __future__ import annotations

import hashlib
import json
import os
import uuid as uuid_lib
from pathlib import Path

from django.conf import settings
from django.http import HttpRequest
from ninja import File, Form
from ninja.errors import HttpError
from ninja.files import UploadedFile

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Role
from core.services import restore as svc

MAX_BYTES = 90 * 1024 * 1024  # the real export is ~28 MB gzipped


def _super_admin(request: HttpRequest, what: str = "restore an export"):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, f"Only a super admin may {what}")
    return user


@api.post("/admin/restore", auth=session_auth)
def restore_export(request: HttpRequest, file: UploadedFile = File(...), confirm: str = Form("")):
    user = _super_admin(request)
    if confirm.strip().upper() != "RESTORE":
        raise HttpError(400, 'Type RESTORE to confirm')
    name = (file.name or "").lower()
    if not name.endswith(svc.ACCEPTED):
        raise HttpError(400, "Upload the .jsonl.gz (or .jsonl, .json, .json.gz) file made by dumpdata")
    if file.size is not None and file.size > MAX_BYTES:
        raise HttpError(400, "File too large (max 90 MB); compress it (.gz)")

    imports_dir = Path(settings.MEDIA_ROOT) / "imports"
    imports_dir.mkdir(parents=True, exist_ok=True)
    ext = ".gz" if name.endswith(".gz") else ""
    saved = imports_dir / f"{uuid_lib.uuid4().hex}.{'jsonl' if '.jsonl' in name else 'json'}{ext}"
    sha, size = hashlib.sha256(), 0
    try:
        with open(saved, "wb") as out:  # a chunk at a time: the upload is never held whole
            for chunk in file.chunks():
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HttpError(400, "File too large (max 90 MB); compress it (.gz)")
                sha.update(chunk)
                out.write(chunk)
        digest = sha.hexdigest()
        try:
            mode = svc.check_can_start(digest)
            svc.sniff(str(saved))
        except svc.Refused as exc:
            raise HttpError(exc.status, exc.message)
        except svc.RestoreError as exc:
            raise HttpError(400, str(exc))
    except BaseException:
        saved.unlink(missing_ok=True)
        raise

    previous = svc.get_run()
    if mode == "resume" and previous:
        # Same file again: keep the checkpoint, point it at the fresh copy.
        old = previous.get("saved_path")
        run = dict(previous, saved_path=str(saved), status="queued", error="")
        if old and old != str(saved) and os.path.exists(old):
            os.remove(old)
    else:
        run = svc.new_run(digest, file.name or saved.name, size, str(saved), user.id)
    svc.save_run(run)

    from django_q.tasks import async_task

    job_id = async_task("core.tasks.run_restore", str(saved), user.id)
    AuditLog.objects.create(
        actor=user,
        action="RESTORE_QUEUED",
        entity="Export",
        detail_json=json.dumps({"filename": file.name, "bytes": size, "job_id": job_id, "mode": mode,
                                "from_object": run.get("done", 0)}),
    )
    return {"ok": True, "queued": True, "job_id": job_id, "resumed": mode == "resume"}


@api.get("/admin/restore/status", auth=session_auth)
def restore_status(request: HttpRequest):
    _super_admin(request)
    return {"run": svc.public(svc.get_run())}


@api.post("/admin/restore/resume", auth=session_auth)
def restore_resume(request: HttpRequest):
    user = _super_admin(request)
    run = svc.get_run()
    if not run or run["status"] == "done":
        raise HttpError(404, "There is no unfinished restore to continue")
    if run["status"] in ("queued", "running") and not svc.is_stalled(run):
        raise HttpError(409, "The restore is still running")
    path = run.get("saved_path")
    if not path or not os.path.exists(path):
        raise HttpError(410, "The uploaded file is no longer on the server (the host restarted). "
                             "Upload the same file again to continue from where it stopped.")
    run.update(status="queued", error="")
    svc.save_run(run)
    from django_q.tasks import async_task

    job_id = async_task("core.tasks.run_restore", path, user.id)
    AuditLog.objects.create(actor=user, action="RESTORE_QUEUED", entity="Export",
                            detail_json=json.dumps({"job_id": job_id, "mode": "resume", "from_object": run["done"]}))
    return {"ok": True, "queued": True, "job_id": job_id, "resumed": True}


__all__ = ["restore_export", "restore_status", "restore_resume"]
