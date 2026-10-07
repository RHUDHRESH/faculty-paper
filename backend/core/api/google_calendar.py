"""Connect Google Calendar: status, connect, the way back, sync and disconnect.

The logic is in core/services/google_calendar.py; this is the HTTP edge. Every
route is for the signed-in person's own link, and nothing here ever returns a
token.
"""

from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import urlencode

from django.http import HttpRequest, HttpResponseRedirect
from ninja.errors import HttpError

from core.api.calendar import _feed_for, _feed_links
from core.api.common import IMPERSONATOR_KEY, api, require_user, session_auth
from core.models import GoogleCalendarLink, User
from core.services import google_calendar as gc

logger = logging.getLogger(__name__)

NOT_SWITCHED_ON = (
    "Connecting to Google Calendar is not switched on yet. "
    "You can still add the calendar to Google with the link on this page."
)
VIEWING_AS = "You are viewing as somebody else. Stop viewing as them before connecting a calendar."
SIGN_IN_AGAIN = "Please sign in again, then connect Google Calendar."


def _status(request: HttpRequest, user: User) -> dict:
    link = GoogleCalendarLink.objects.filter(user=user).first()
    return {
        "configured": gc.configured(),
        "connected": link is not None,
        "google_email": (link.google_email or None) if link else None,
        "calendar_name": gc.CALENDAR_NAME if link else None,
        "last_synced": link.last_synced_at.isoformat() if link and link.last_synced_at else None,
        "error": (link.last_error or None) if link else None,
        "needs_reconnect": bool(link and link.needs_reconnect),
        # The no-setup path: Google's own "add by URL" page, filled in.
        "subscribe_url": _feed_links(request, _feed_for(user))["google_subscribe_url"],
    }


@api.get("/calendar/google/status", auth=session_auth)
def google_status(request: HttpRequest):
    return _status(request, require_user(request))


@api.get("/calendar/google/connect", auth=session_auth)
def google_connect(request: HttpRequest):
    """The Google consent address for the person's browser to go to."""
    user = require_user(request)
    if not gc.configured():
        raise HttpError(409, NOT_SWITCHED_ON)
    # A view-as request writes nothing here, so a calendar made on Google would
    # be orphaned: refuse before anything leaves.
    if request.session.get(IMPERSONATOR_KEY):
        raise HttpError(403, VIEWING_AS)
    return {"url": gc.begin(request, user)}


def _back(result: str, why: Optional[str] = None) -> HttpResponseRedirect:
    query = {"google": result}
    if why:
        query["why"] = why
    return HttpResponseRedirect("/calendar?" + urlencode(query))


@api.get("/calendar/google/callback", auth=None)
def google_callback(
    request: HttpRequest,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
):
    """Where Google sends the browser back to.

    A page, not an API call, so every outcome is a redirect to the calendar with
    a plain sentence, never a JSON error. The session cookie is the sign-in; the
    signed state, checked against the session, is what makes the request ours.
    """
    try:
        user = require_user(request)
    except HttpError as e:
        return _back("failed", SIGN_IN_AGAIN if e.status_code == 401 else e.message)
    if request.session.get(IMPERSONATOR_KEY):
        return _back("failed", VIEWING_AS)
    if not gc.configured():
        return _back("failed", NOT_SWITCHED_ON)
    if error:
        request.session.pop(gc.SESSION_KEY, None)
        return _back("failed", gc.WHY_DENIED if error == "access_denied" else gc.WHY_EXCHANGE)
    try:
        gc.finish_connection(request, user, code=code, state=state)
    except gc.ConnectError as e:
        return _back("failed", str(e))
    return _back("connected")


@api.post("/calendar/google/sync", auth=session_auth)
def google_sync(request: HttpRequest):
    """"Sync now": the same pass the daily job runs, for this person."""
    user = require_user(request)
    link = GoogleCalendarLink.objects.filter(user=user).first()
    if link is None:
        raise HttpError(409, "Google Calendar is not connected yet.")
    if link.needs_reconnect:
        raise HttpError(409, gc.MSG_RECONNECT)
    try:
        result = gc.sync_link(link, budget=gc.INLINE_BUDGET)
    except Exception:  # noqa: BLE001 -- a bug of ours; the person gets a sentence, the log gets the trace
        logger.exception("google_calendar_sync_now_failed user=%s", user.pk)
        raise HttpError(502, "Could not sync just now. Please try again in a moment.")
    if result["partial"]:
        gc.enqueue_sync([user.pk])  # a very long list: the rest is done in the background
    return {
        "created": result["created"],
        "updated": result["updated"],
        "deleted": result["deleted"],
        "failed": result["failed"],
        # `partial`: time ran out and the rest is queued. `busy`: another sync
        # of theirs was already running and will pick up anything new.
        "partial": result["partial"],
        "busy": result["busy"],
        "status": _status(request, user),
    }


@api.post("/calendar/google/disconnect", auth=session_auth)
def google_disconnect(request: HttpRequest):
    """Take the calendar we made off their Google account, revoke the token, forget the link."""
    user = require_user(request)
    link = GoogleCalendarLink.objects.filter(user=user).first()
    if link is None:
        return {"ok": True, "calendar_removed": False}
    removed = gc.teardown(link)
    link.delete()
    return {"ok": True, "calendar_removed": removed}


__all__ = [
    "google_callback",
    "google_connect",
    "google_disconnect",
    "google_status",
    "google_sync",
]
