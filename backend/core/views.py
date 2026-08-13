"""Authenticated delivery of uploaded claim documents.

Media used to be served only when DEBUG was true, which meant every proof PDF
returned 404 in production while working fine locally. This view serves them in
both environments so the two behave the same, and adds the access check that
static file serving never had.
"""
from __future__ import annotations

import re
from pathlib import Path

from django.conf import settings
from django.db.models import Q
from django.http import FileResponse, Http404, HttpRequest, HttpResponse, JsonResponse

from core.models import Claim, Role
from core.services import rbac

# Uploads are written as uuid4().hex + ".pdf" (core/api.py). Anything else is
# either a traversal attempt or a file this app did not create.
_SAFE_NAME = re.compile(r"^[0-9a-f]{32}\.pdf$")


def _claims_referencing(url: str):
    return Claim.objects.filter(
        Q(attachments__url=url) | Q(proof_url=url) | Q(sec_proof_url=url)
    ).distinct()


def _may_read(user, url: str) -> bool:
    qs = _claims_referencing(url)
    if not qs.exists():
        # Freshly uploaded and not yet attached to a saved claim. The form links to
        # it before the claim exists, so let the roles that can upload read it back.
        # The name carries 128 bits of entropy, so it is not enumerable.
        return user.role in (Role.FACULTY, Role.SUPER_ADMIN, Role.RESEARCH_CELL)
    if rbac.can_view_college_wide(user.role):
        return True
    if user.role == Role.HOD:
        if not user.department:
            return False
        return qs.filter(owner__department__iexact=user.department).exists()
    return qs.filter(owner=user).exists()


def claim_media(request: HttpRequest, filename: str) -> HttpResponse:
    if not request.user.is_authenticated or not getattr(request.user, "active", False):
        return JsonResponse({"detail": "Unauthorized"}, status=401)

    if not _SAFE_NAME.match(filename):
        raise Http404

    root = (Path(settings.MEDIA_ROOT) / "claims").resolve()
    path = (root / filename).resolve()
    if not str(path).startswith(str(root)) or not path.is_file():
        raise Http404

    if not _may_read(request.user, f"{settings.MEDIA_URL}claims/{filename}"):
        return JsonResponse({"detail": "Forbidden"}, status=403)

    response = FileResponse(open(path, "rb"), content_type="application/pdf")
    response["Content-Disposition"] = f'inline; filename="{filename}"'
    response["X-Content-Type-Options"] = "nosniff"
    return response
