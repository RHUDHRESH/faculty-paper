"""Viewing as somebody writes nothing.

`require_user` refuses every non-GET while a super admin is viewing as another
user. That left the GETs that write as a side effect: an export's audit row
(recorded as the person being viewed), a scout run marked failed, a thread's
read-marker, a post's view count. Guarding each is the "we forgot that one"
failure again, so the rule is held here instead: while a session is viewing as
somebody, every safe-method request runs inside a transaction that is rolled
back once the response is built. The session itself is saved by
SessionMiddleware, outside this one, so the view-as state survives.
"""
from __future__ import annotations

from django.db import transaction

SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


def is_viewing_as(request) -> bool:
    from core.api.common import IMPERSONATOR_KEY

    session = getattr(request, "session", None)
    return bool(session is not None and session.get(IMPERSONATOR_KEY))


class ViewAsReadOnlyMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method not in SAFE_METHODS or not is_viewing_as(request):
            return self.get_response(request)
        with transaction.atomic():
            response = self.get_response(request)
            transaction.set_rollback(True)
        return response
