"""My research, the college's picture, and Discover's For-you feed.

Counted from the publication record; no model and no money (every payload
leaves through `hod.without_money`). See core.services.research_picture.
"""

from __future__ import annotations

from django.http import HttpRequest

from core import hod
from core.api.common import api, require_user, session_auth
from core.services import research_picture as picture
from core.services import suggestions


@api.get("/me/research", auth=session_auth)
def my_research(request: HttpRequest):
    """Past (record, timeline, citations), present (topics, venues, co-authors,
    this year) and future (counted ideas, each with its reason)."""
    user = require_user(request)
    return hod.without_money(picture.my_research(user))


@api.get("/college/research", auth=session_auth)
def college_research(request: HttpRequest):
    """The college's topics, departments x topics, rising topics, and who
    works near the reader's topics."""
    user = require_user(request)
    return hod.without_money(picture.college_research(user))


@api.get("/discover/for-you", auth=session_auth)
def discover_for_you(request: HttpRequest):
    """Directions, venues, people and fresh papers in one feed, in the
    rhythm feature, venue, three people/papers. Needs no model."""
    user = require_user(request)
    return hod.without_money(picture.for_you(user, suggestions.for_person(user)))


__all__ = ["my_research", "college_research", "discover_for_you"]
