"""GET /admin/start -> the "Get the college running" checklist (services/go_live.py)."""
from __future__ import annotations

from django.http import HttpRequest
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import Role
from core.services import go_live


@api.get("/admin/start", auth=session_auth)
def admin_start(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Setting the college up is for the super admin.")
    return go_live.summary()


__all__ = ["admin_start"]
