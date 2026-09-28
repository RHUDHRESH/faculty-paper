"""Authenticated delivery of uploaded claim documents.

Media used to be served only when DEBUG was true, which meant every proof PDF
returned 404 in production while working fine locally. This view serves them in
both environments so the two behave the same, and adds the access check that
static file serving never had.
"""
from __future__ import annotations

import re

from django.conf import settings
from django.core.files.storage import default_storage
from django.db.models import Q
from django.http import FileResponse, Http404, HttpRequest, HttpResponse, JsonResponse

from core.models import Claim, Role
from core.services import rbac
from core.services.uploads import kind_for_stored_name

# Uploads are written as uuid4().hex + a sniffed extension (core/api.py).
# Anything else is either a traversal attempt or a file this app did not create.
_SAFE_NAME = re.compile(r"^[0-9a-f]{32}\.[a-z0-9]{2,5}$")


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
        return rbac.can_issue_claims(user.role)
    if rbac.can_view_college_wide(user.role):
        return True
    return qs.filter(owner=user).exists()


def claim_media(request: HttpRequest, filename: str) -> HttpResponse:
    if not request.user.is_authenticated or not getattr(request.user, "active", False):
        return JsonResponse({"detail": "Unauthorized"}, status=401)

    if not _SAFE_NAME.match(filename):
        raise Http404

    # Serving every file as application/pdf meant an uploaded scan or photo
    # arrived as a PDF the browser could not render.
    kind = kind_for_stored_name(filename)
    if kind is None:
        raise Http404

    # _SAFE_NAME above already rejects anything but a 32-hex uuid plus a short
    # extension, so the joined key cannot escape the claims/ prefix.
    name = f"claims/{filename}"
    if not default_storage.exists(name):
        raise Http404

    if not _may_read(request.user, f"{settings.MEDIA_URL}claims/{filename}"):
        return JsonResponse({"detail": "Forbidden"}, status=403)

    # Streamed through this view rather than handed out as a bucket URL: the
    # access check above is the only thing standing between a proof PDF and
    # anyone who guesses at it, so the file must never be publicly readable.
    response = FileResponse(default_storage.open(name, "rb"), content_type=kind.content_type)
    disposition = "inline" if kind.inline else "attachment"
    # The claimant's original name lives on the attachment row; the file on disk
    # is a uuid, which is what a download should be named to stay unambiguous.
    response["Content-Disposition"] = f'{disposition}; filename="{filename}"'
    response["X-Content-Type-Options"] = "nosniff"
    return response


def _stream(name: str, filename: str, content_type: str) -> HttpResponse:
    response = FileResponse(default_storage.open(name, "rb"), content_type=content_type)
    response["Content-Disposition"] = f'inline; filename="{filename}"'
    response["X-Content-Type-Options"] = "nosniff"
    # The name is a fresh uuid for every upload, so a copy can be kept a
    # while -- but only by this browser, never by a shared cache.
    response["Cache-Control"] = "private, max-age=86400"
    return response


def avatar_media(request: HttpRequest, filename: str) -> HttpResponse:
    """A profile photo. Anybody signed in may see it: it is on a profile anybody can open."""
    if not request.user.is_authenticated or not getattr(request.user, "active", False):
        return JsonResponse({"detail": "Unauthorized"}, status=401)
    if not _SAFE_NAME.match(filename):
        raise Http404
    kind = kind_for_stored_name(filename)
    if kind is None or not kind.content_type.startswith("image/"):
        raise Http404
    name = f"avatars/{filename}"
    if not default_storage.exists(name):
        raise Http404
    return _stream(name, filename, kind.content_type)


def feed_media(request: HttpRequest, filename: str) -> HttpResponse:
    """A picture or PDF shared in a post, to whoever may read that post and nobody else.

    A post the reader cannot see answers 404, as the post itself does: the
    attachment of a department-only post is part of the post.
    """
    from core import social
    from core.models import FeedPost

    if not request.user.is_authenticated or not getattr(request.user, "active", False):
        return JsonResponse({"detail": "Unauthorized"}, status=401)
    if not _SAFE_NAME.match(filename):
        raise Http404
    kind = kind_for_stored_name(filename)
    if kind is None:
        raise Http404
    name = f"feed/{filename}"
    post = FeedPost.objects.filter(attachment_name=name).first()
    if post is None or not social.may_read_post(request.user, post):
        raise Http404
    if not default_storage.exists(name):
        raise Http404
    return _stream(name, filename, kind.content_type)
