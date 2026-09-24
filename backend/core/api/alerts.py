"""Notification settings, the weekly summary, and unsubscribe links.

The bell's own list, count and mark-read endpoints stay where they were
(core/api/calendar.py); they read through core.services.notify so a kind
switched off here disappears from them too.

    GET  /api/notifications/preferences         every kind, its level, the switches
    PUT  /api/notifications/preferences         {levels: {kind: level}, count_my_visits, whatsapp_opt_in}
    GET  /api/notifications/digest              this week's summary for me, as it stands now
    GET  /api/notifications/unsubscribe/{t}     from an email: asks before changing anything
    POST /api/notifications/unsubscribe/{t}     stops that kind's email, keeps it in the app

Profile visits are recorded by the profile page itself (core.social_profile)
and shown back to the person visited only as a count; they raise no alert.
"""
from __future__ import annotations

from typing import Optional

from django.http import HttpRequest, HttpResponse
from django.template.loader import render_to_string
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import User
from core.services import notify as notify_service


class PreferencesIn(Schema):
    levels: Optional[dict[str, str]] = None
    count_my_visits: Optional[bool] = None
    whatsapp_opt_in: Optional[bool] = None


@api.get("/notifications/preferences", auth=session_auth)
def notification_preferences(request: HttpRequest):
    return notify_service.preferences_payload(require_user(request))


@api.put("/notifications/preferences", auth=session_auth)
def put_notification_preferences(request: HttpRequest, payload: PreferencesIn):
    user = require_user(request)
    try:
        notify_service.set_preferences(
            user,
            payload.levels,
            count_my_visits=payload.count_my_visits,
            whatsapp_opt_in=payload.whatsapp_opt_in,
        )
    except ValueError as exc:
        raise HttpError(400, str(exc))
    return notify_service.preferences_payload(user)


@api.get("/notifications/digest", auth=session_auth)
def my_digest(request: HttpRequest):
    """The weekly summary as it would be sent now -- the "This week" tab."""
    from core.services import digest

    return digest.preview_for(require_user(request))


def _unsubscribe_page(token: str, *, apply: bool) -> HttpResponse:
    from core.services import institution

    parsed = notify_service.read_unsubscribe_token(token)
    user = None
    if parsed:
        user = User.objects.filter(pk=parsed[0]).first()
    ctx = {
        "college": institution.get("college_name"),
        "settings_url": notify_service.app_url("/settings/notifications"),
    }
    if parsed is None or user is None:
        return HttpResponse(
            render_to_string("notifications/unsubscribe.html", {**ctx, "error": True}),
            status=400,
        )
    kind = parsed[1]
    if apply and notify_service.level_for(user, kind) == notify_service.EMAIL:
        notify_service.set_preferences(user, {kind: notify_service.IN_APP})
    return HttpResponse(
        render_to_string(
            "notifications/unsubscribe.html",
            {**ctx, "done": apply, "kind_label": notify_service.kind_of(kind).label},
        )
    )


@api.get("/notifications/unsubscribe/{token}", auth=None)
def unsubscribe_page(request: HttpRequest, token: str):
    """Opened from an email. Asks first: mail scanners follow links, and a GET
    that changed a setting would unsubscribe people who never clicked."""
    return _unsubscribe_page(token, apply=False)


@api.post("/notifications/unsubscribe/{token}", auth=None)
def unsubscribe_confirm(request: HttpRequest, token: str):
    """The button on that page, and one-click unsubscribe (RFC 8058) from a
    mail client. The signed token is the authority, so no session is needed."""
    return _unsubscribe_page(token, apply=True)


__all__ = [
    "PreferencesIn",
    "my_digest",
    "notification_preferences",
    "put_notification_preferences",
    "unsubscribe_confirm",
    "unsubscribe_page",
]
