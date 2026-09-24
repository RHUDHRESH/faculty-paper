"""Every notification the social layer sends goes through `notify` here.

One door, for two reasons. Each kind can be switched off by the person who
would receive it (`SocialSettings.muted_json`), and a switch that only some
call sites consult is a switch that does not work. And a college-wide
notification service with its own per-kind preferences is being built; when
it lands, this function is the one line that changes.

Nothing here is a dark pattern: no kind is on that cannot be turned off, and
none of them is sent to get somebody back into the app -- each one is about
something a named colleague did that concerns them.
"""
from __future__ import annotations

import json

from core.models import Notification, SocialSettings, User

#: The kinds, in the order the settings list them, with the sentence the
#: switch is labelled with.
KINDS: dict[str, str] = {
    "follow": "Somebody starts following you",
    "comment": "Somebody comments on your post",
    "mention": "Somebody names you in a post or a comment",
    "reaction": "Somebody congratulates you, is interested, or wants to collaborate on a post",
    "message": "Somebody sends you a direct message",
    "collab": "A collaboration request, or an answer to yours",
    "endorsement": "Somebody endorses one of your skills",
}


def settings_for(user: User | str) -> SocialSettings:
    """The person's switches, or the defaults (everything on) when they have never changed one."""
    user_id = user if isinstance(user, str) else user.pk
    found = SocialSettings.objects.filter(user_id=user_id).first()
    return found or SocialSettings(user_id=user_id)


def muted_kinds(user: User | str) -> set[str]:
    try:
        return set(json.loads(settings_for(user).muted_json or "[]"))
    except ValueError:
        return set()


def counts_visits(user: User) -> bool:
    """Whether this person's visits may be recorded in anybody's statistics."""
    return settings_for(user).count_my_visits


def notify(user_id: str, kind: str, title: str, body: str | None, href: str, *,
           coalesce: bool = False, once: bool = False) -> bool:
    """Tell one person something, unless they switched this kind off.

    `coalesce` holds back a second notification while an earlier unread one
    for the same place is still waiting -- five messages in a row are one
    thing to come back to, not five. `once` sends a given title about a given
    place only ever once, so taking a reaction back and giving it again does
    not ring twice. Returns whether a row was written.
    """
    if kind not in KINDS:
        raise ValueError(f"Unknown social notification kind: {kind}")
    if kind in muted_kinds(user_id):
        return False
    title = title[:255]
    if coalesce and Notification.objects.filter(user_id=user_id, href=href, read=False).exists():
        return False
    if once and Notification.objects.filter(user_id=user_id, href=href, title=title).exists():
        return False
    Notification.objects.create(
        user_id=user_id, title=title[:255], body=(body or "")[:300], href=href
    )
    return True
