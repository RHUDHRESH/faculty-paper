"""The college website, imported: office upload and department profiles."""
from __future__ import annotations

import json
import zipfile

from django.http import HttpRequest
from ninja import File, Form, UploadedFile
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import AuditLog
from core.services import rbac
from core.services.college_site import ZipSource, department_profile, import_site, reclean_imported_bios

MAX_ZIP = 200 * 1024 * 1024


@api.post("/admin/college-site/import", auth=session_auth)
def college_site_import(request: HttpRequest, file: UploadedFile = File(...), dry_run: bool = Form(False)):
    """A zip of the college-site scrape: fills empty photos, bios, designations.

    Production has no shell, so this is the management command's twin. It
    never overwrites what a person set, and fills each field for a person once.
    """
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read()
    if len(content) > MAX_ZIP:
        raise HttpError(400, "That zip is over 200 MB.")
    try:
        report = import_site(ZipSource(content), actor=user, dry_run=dry_run).as_dict()
    except zipfile.BadZipFile as exc:
        raise HttpError(400, "That is not a zip file.") from exc
    except ValueError as exc:
        raise HttpError(400, str(exc)) from exc
    if not dry_run:
        AuditLog.objects.create(
            actor=user,
            action="COLLEGE_SITE_IMPORT",
            entity="User",
            detail_json=json.dumps({k: v for k, v in report.items() if not isinstance(v, list)}),
        )
    return report


@api.post("/admin/college-site/reclean-bios", auth=session_auth)
def college_site_reclean_bios(request: HttpRequest, dry_run: bool = False):
    """Re-clean bios the import filled (never ones a person wrote)."""
    user = require_user(request)
    if not rbac.can_import_prior(user.role):
        raise HttpError(403, "Forbidden")
    report = reclean_imported_bios(dry_run=dry_run)
    if not dry_run and report["changed"]:
        AuditLog.objects.create(
            actor=user, action="COLLEGE_SITE_RECLEAN_BIOS", entity="User",
            detail_json=json.dumps({"checked": report["checked"], "changed": report["changed"]}),
        )
    return report


@api.get("/departments/{code}/profile", auth=session_auth)
def department_site_profile(request: HttpRequest, code: str):
    """What the college website says about a department, when it was imported."""
    require_user(request)
    return {"profile": department_profile(code)}
