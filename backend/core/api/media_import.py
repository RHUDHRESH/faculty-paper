"""Put the photos and files back from a zip (core/services/media_import.py).

The restore brings the rows; the files they name stay on the machine the college
was run from. The owner picks the media zip on the "Get the college running"
page and this files each entry under its own name, through the same storage the
uploads use.

POST /admin/media-import   multipart: file (the zip), overwrite (default false)

It runs inside the request, not on the job queue: the zip is read once and
written a batch at a time (a few statements for the whole college on the
database storage), which is well inside the host's two-minute limit.
"""
from __future__ import annotations

import json

from django.http import HttpRequest
from ninja import File, Form
from ninja.errors import HttpError
from ninja.files import UploadedFile

from core.api.common import api, session_auth
from core.api.restore import _super_admin
from core.models import AuditLog
from core.services import media_import as svc


@api.post("/admin/media-import", auth=session_auth)
def media_import_zip(request: HttpRequest, file: UploadedFile = File(...), overwrite: bool = Form(False)):
    user = _super_admin(request, "load photos and files")
    try:
        report = svc.import_zip(file, overwrite=overwrite)
    except svc.MediaImportError as exc:
        raise HttpError(400, str(exc)) from exc
    AuditLog.objects.create(
        actor=user,
        action="MEDIA_IMPORTED",
        entity="Media",
        # Counts only: the names in the zip stay out of the log.
        detail_json=json.dumps({
            "added": report["added"],
            "replaced": report["replaced"],
            "skipped": report["skipped"],
            "rejected": report["rejected_count"],
            "bytes": report["bytes"],
            "overwrite": overwrite,
        }),
    )
    return report


__all__ = ["media_import_zip"]
