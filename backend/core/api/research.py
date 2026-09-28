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
from core.services.dismissals import dismissed_keys, without_dismissed
from core.models import DiscoverDismissal
from ninja import Schema
from ninja.errors import HttpError


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
    gone = dismissed_keys(user)
    body = picture.for_you(user, without_dismissed(suggestions.for_person(user), gone))
    body["items"] = [i for i in body.get("items", []) if i.get("id") not in gone]
    return hod.without_money(body)


class DismissIn(Schema):
    kind: str
    id: str
    undo: bool = False


@api.post("/discover/dismiss", auth=session_auth)
def discover_dismiss(request: HttpRequest, payload: DismissIn):
    """"Not interested" in one Discover item (`id` is the feed id, e.g.
    `topic:ml`); `undo: true` brings it back. Hidden from For you and
    /discover/next for this person only."""
    user = require_user(request)
    key = (payload.id or "").strip()[:300]
    if not key:
        raise HttpError(400, "Say which item.")
    if payload.undo:
        DiscoverDismissal.objects.filter(user=user, key=key).delete()
        return {"id": key, "dismissed": False}
    DiscoverDismissal.objects.get_or_create(user=user, key=key, defaults={"kind": (payload.kind or "")[:24]})
    return {"id": key, "dismissed": True}


__all__ = ["my_research", "college_research", "discover_for_you", "discover_dismiss"]
