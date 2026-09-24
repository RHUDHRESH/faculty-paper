"""New things to work on: people, journals, topics -- and, with a model, partners.

`/discover/next` is counted from the college's own record and never needs a
model, so it answers on a server with no AI configured. `/discover/partners`
is the one list that needs outside knowledge; without a model it answers 503
with the reason, and the page hides it with one line rather than an error.
"""

from __future__ import annotations

from django.conf import settings
from django.http import HttpRequest
from ninja.errors import HttpError

from core import hod
from core.api.common import api, rate_limit, require_user, session_auth
from core.api.discover import _ai_failure_status
from core.services import ai, suggestions


@api.get("/discover/next", auth=session_auth)
def discover_next(request: HttpRequest):
    """Who to write with, where to aim, and what to try -- each with its reason."""
    user = require_user(request)
    return hod.without_money(suggestions.for_person(user))


@api.get("/discover/partners", auth=session_auth)
def discover_partners(request: HttpRequest):
    """Organisations outside the college worth approaching. Needs a model.

    Checked before the daily AI allowance is spent, so a server with nothing
    configured does not use up anybody's quota answering "not set up".
    """
    user = require_user(request)
    state = ai.health()
    if not state.get("ready"):
        raise HttpError(503, state.get("detail") or ai.NOT_CONFIGURED)
    rate_limit(request, "ai", settings.AI_DAILY_LIMIT, "day", what="the AI suggestions")
    try:
        return hod.without_money(suggestions.industry_partners(user))
    except ai.AIError as exc:
        raise HttpError(_ai_failure_status(exc), str(exc)) from exc


__all__ = ["discover_next", "discover_partners"]
