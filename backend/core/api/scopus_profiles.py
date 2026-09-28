"""Scopus author profiles: the office's import, its verification list, and
the signed-in person's own profile.

Registered last in core/api/__init__.py; none of these paths overlaps an
earlier one, so its place in the route order does not matter.
"""

from __future__ import annotations

from core.api.common import api, require_user, session_auth
from core.api.lookups import MAX_UPLOAD_BYTES
from core.api.teams import _require_office

import io
from django.http import HttpRequest
from ninja import File, UploadedFile
from ninja.errors import HttpError
from core.services.scopus_profiles import (
    ProfileWorkbookError,
    ids_for,
    import_profiles,
    profile_dict,
    profile_for,
    read_profiles,
    verification_report,
)


@api.post("/admin/scopus-profiles/import", auth=session_auth)
def import_scopus_profiles(request: HttpRequest, file: UploadedFile = File(...)):
    """Load the Scopus profile workbook -- the same importer as
    `manage.py import_scopus_profiles`."""
    user = _require_office(request)
    if file.size and file.size > MAX_UPLOAD_BYTES:
        raise HttpError(400, "That file is too large to be the Scopus profile workbook.")
    try:
        profiles = read_profiles(io.BytesIO(file.read()))
    except ProfileWorkbookError as exc:
        raise HttpError(400, str(exc)) from exc
    return import_profiles(profiles, actor=user, source_file=file.name)


@api.get("/admin/scopus-profiles/verification", auth=session_auth)
def scopus_profiles_verification(request: HttpRequest):
    """Profiles no account claims, faculty with no Scopus id, and accounts
    whose id differs from the sheet named after them -- the office's list."""
    _require_office(request)
    return verification_report()


@api.get("/me/scopus", auth=session_auth)
def my_scopus_profile(request: HttpRequest):
    """The signed-in person's Scopus profile, if the office has imported one.

    `profile` is null rather than a row of zeros when there is none: "no
    profile loaded" and "no citations" are different things to be told.
    """
    user = require_user(request)
    return {"scopus_ids": sorted(ids_for(user)), "profile": profile_dict(profile_for(user))}


__all__ = [
    'import_scopus_profiles',
    'my_scopus_profile',
    'scopus_profiles_verification',
]
