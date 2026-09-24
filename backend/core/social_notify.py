"""Every notification the social layer sends goes through `notify` here.

One door, and behind it the college-wide one (core.services.notify): each
social kind is a kind of alert there, under the same name, so a person's
switch for it -- on the statistics page or on the notification settings page,
which read and write the same preference -- is honoured wherever the alert was
raised, and a person who wants mentions by email can have them.

Nothing here is a dark pattern: no kind is on that cannot be turned off, and
none of them is sent to get somebody back into the app -- each one is about
something a named colleague did that concerns them.
"""
from __future__ import annotations

from core.models import Notification, SocialSettings, User
from core.services import notify as notify_service

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
    """The person's switches, or the defaults when they have never changed one."""
    user_id = user if isinstance(user, str) else user.pk
    found = SocialSettings.objects.filter(user_id=user_id).first()
    return found or SocialSettings(user_id=user_id)


def _user(user: User | str) -> User | None:
    return user if isinstance(user, User) else User.objects.filter(pk=user).first()


def muted_kinds(user: User | str) -> set[str]:
    """The social kinds this person has switched off."""
    person = _user(user)
    if person is None:
        return set()
    levels = notify_service.levels_for(person)
    return {k for k in KINDS if levels.get(k) == notify_service.OFF}


def set_muted(user: User, muted: set[str]) -> None:
    """Switch these social kinds off and the rest back on.

    A kind switched back on returns to how it was before it was switched off
    only as far as "on" goes: its default level (in the app). A kind already
    on is left alone, so somebody who asked for mentions by email keeps that.
    """
    levels = notify_service.levels_for(user)
    changes = {}
    for kind in KINDS:
        if kind in muted:
            changes[kind] = notify_service.OFF
        elif levels.get(kind) == notify_service.OFF:
            changes[kind] = notify_service.kind_of(kind).default
    if changes:
        notify_service.set_preferences(user, changes)


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
    title = title[:255]
    if coalesce and Notification.objects.filter(user_id=user_id, href=href, read=False).exists():
        return False
    if once and Notification.objects.filter(user_id=user_id, href=href, title=title).exists():
        return False
    person = _user(user_id)
    note = notify_service.notify(person, kind, title, (body or "")[:300], href)
    return note is not None
