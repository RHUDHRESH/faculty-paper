"""Every alert this app sends, and the one place a person's wishes about them live.

Call `notify(user, kind, title, body, href)` and the rest is decided here:

- **Whether it is written at all.** Each kind has a level per person --
  ``email`` (in the app and by email), ``in_app``, or ``off`` -- defaulting to
  the kind's own default below. ``off`` writes nothing and sends nothing. A row
  some older code path wrote directly under a kind that is now off is hidden
  from the bell by `visible_to`, so switching a kind off always works.
- **Whether it is also emailed.** Only when the level is ``email`` *and* the
  deployment has a mail server (``EMAIL_HOST``), and only while the day's
  email cap (``EMAIL_DAILY_CAP``) has room. A failing mail server loses the
  email, never the alert. Every email carries an unsubscribe link for its own
  kind.
- **Whether it joins an existing line.** Pass ``group_key`` and an ``actor``
  with a ``verb``, and alerts with the same key merge while unread: "Asha
  Menon and 2 others liked your post". Joining a group never sends another
  email.
- **WhatsApp**, for the money kinds only, when the college has configured the
  channel and the person has opted in (core.services.whatsapp).

The social layer (core.social_notify) and the rewards (core.services.
achievements) each keep a thin helper of their own, and both delegate here, so
a switch on the settings page is honoured whichever part of the app raised the
alert. The social kinds keep the names that layer gave them -- follow, comment,
mention, reaction, message, collab, endorsement -- so its own switches on the
statistics page read and write the same preferences as the settings page.

A kind this module does not know is filed as ``general`` and logged, rather
than failing the request that raised it. Register a new kind in `KINDS`.

Copy rules that apply to every caller: plain sentence case, no urgency that
is not real, and nothing sent to a claimant names a desk or an officer.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from django.conf import settings
from django.core import signing
from django.core.mail import EmailMultiAlternatives
from django.db import transaction
from django.db.models import Q
from django.template.loader import render_to_string
from django.utils import timezone

from core.models import Notification, NotificationPreference, SocialSettings, User

logger = logging.getLogger("core.notifications")

EMAIL, IN_APP, OFF = "email", "in_app", "off"
LEVELS = (EMAIL, IN_APP, OFF)
LEVEL_LABELS = {EMAIL: "In the app and by email", IN_APP: "In the app only", OFF: "Off"}

GENERAL = "general"
#: How many of the people behind a grouped alert are remembered. The count
#: keeps going past it; only the names stop.
ACTORS_KEPT = 100

_UNSUBSCRIBE_SALT = "core.notify.unsubscribe"


@dataclass(frozen=True)
class Kind:
    key: str
    #: What the settings page calls it.
    label: str
    #: One sentence on the settings page saying when it is sent.
    description: str
    #: The heading it sits under on the settings page.
    group: str
    #: The bell's tab: papers, people, work, or updates.
    section: str
    default: str
    #: Who it is listed for on the settings page: claimant (faculty and heads
    #: of department), research (research faculty), staff, or everyone.
    audience: str = "everyone"
    #: Also sent on WhatsApp when the channel is configured and the person
    #: opted in. Money and status only: it is the one thing worth a ping.
    whatsapp: bool = False
    #: False for what a person must always be told (moderation of their own
    #: post): it can go by email or not, but it cannot be switched off.
    can_turn_off: bool = True


_PAPERS = "Your papers"
_REMINDERS = "Summaries and reminders"
_PEOPLE = "People"

KINDS: dict[str, Kind] = {
    k.key: k
    for k in (
        Kind("claim_approved", "Approved for payment",
             "When a paper of yours is approved for payment.",
             _PAPERS, "papers", EMAIL, "claimant", whatsapp=True),
        Kind("claim_paid", "Paid",
             "When the incentive for a paper of yours is paid, with the amount.",
             _PAPERS, "papers", EMAIL, "claimant", whatsapp=True),
        Kind("claim_sent_back", "Sent back to you",
             "When a paper of yours needs changes, with the reason.",
             _PAPERS, "papers", EMAIL, "claimant", whatsapp=True),
        Kind("claim_not_accepted", "Not accepted",
             "When a paper of yours is not accepted, with the reason.",
             _PAPERS, "papers", EMAIL, "claimant", whatsapp=True),
        Kind("claim_status", "Other changes to your papers",
             "Put on hold, resumed, withdrawn, back to draft, or a payment reversed.",
             _PAPERS, "papers", IN_APP, "claimant"),
        Kind("citation", "New citations",
             "When a paper of yours is cited again. Checked once a day.",
             _PAPERS, "papers", EMAIL, "claimant"),
        Kind("digest", "Weekly summary",
             "Monday morning: where you stand, what your department published, "
             "somebody to write with, and what is waiting on you.",
             _REMINDERS, "updates", EMAIL, "claimant"),
        Kind("nudge_cutoff", "Filing deadline",
             "A few days before this month's filing closes, if you have a draft.",
             _REMINDERS, "updates", EMAIL, "claimant"),
        Kind("nudge_quota", "Research quota",
             "When you are one paper away from your research quota for the year.",
             _REMINDERS, "updates", IN_APP, "research"),
        Kind("desk", "Papers waiting on your desk",
             "When a paper reaches a queue you work from.",
             "Your desk", "work", IN_APP, "staff"),
        Kind("follow", "New followers",
             "When somebody starts following you.",
             _PEOPLE, "people", IN_APP),
        Kind("comment", "Comments",
             "When somebody comments on your post.",
             _PEOPLE, "people", IN_APP),
        Kind("mention", "Mentions",
             "When somebody names you in a post or a comment.",
             _PEOPLE, "people", IN_APP),
        Kind("reaction", "Reactions",
             "When somebody congratulates you, is interested, or wants to "
             "collaborate on a post.",
             _PEOPLE, "people", IN_APP),
        Kind("message", "Direct messages",
             "When somebody sends you a direct message. One line until you read it.",
             _PEOPLE, "people", IN_APP),
        Kind("collab", "Collaboration requests",
             "A collaboration request, or an answer to yours.",
             _PEOPLE, "people", IN_APP),
        Kind("endorsement", "Endorsements",
             "When somebody endorses one of your skills.",
             _PEOPLE, "people", IN_APP),
        Kind("badge", "Badges",
             "When a paper of yours earns a badge.",
             _PAPERS, "papers", IN_APP, "claimant"),
        Kind("target", "Department targets",
             "When a department crosses half, three quarters or all of its target.",
             _REMINDERS, "updates", IN_APP, "principal"),
        Kind("moderation", "Your posts and reports",
             "When a post of yours is hidden, or a report reaches you. "
             "This one cannot be switched off.",
             _PEOPLE, "people", IN_APP, can_turn_off=False),
        Kind(GENERAL, "Other updates",
             "Everything else: work your department hands you, answers to your "
             "account requests.",
             "Other", "updates", IN_APP),
    )
}

SECTIONS = ("papers", "people", "work", "updates")


def kind_of(key: str | None) -> Kind:
    return KINDS.get(key or "") or KINDS[GENERAL]


def applies_to(kind: Kind, user: User) -> bool:
    """Whether `kind` is listed on `user`'s settings page."""
    from core.services import rbac

    claimant = user.role in rbac.CLAIMANT_ROLES
    if kind.audience == "claimant":
        return claimant
    if kind.audience == "research":
        return claimant and user.faculty_type == "RESEARCH"
    if kind.audience == "staff":
        return not claimant
    if kind.audience == "principal":
        return user.role == rbac.Role.PRINCIPAL
    return True


# --------------------------------------------------------------------------- #
# Preferences                                                                  #
# --------------------------------------------------------------------------- #


def levels_for(user: User) -> dict[str, str]:
    """Every kind's level for this person: their choice, or the default."""
    chosen = dict(
        NotificationPreference.objects.filter(user=user).values_list("kind", "level")
    )
    return {key: chosen.get(key, k.default) for key, k in KINDS.items()}


def level_for(user: User, kind: str) -> str:
    row = (
        NotificationPreference.objects.filter(user=user, kind=kind)
        .values_list("level", flat=True)
        .first()
    )
    return row or kind_of(kind).default


def off_kinds(user: User) -> set[str]:
    return {key for key, level in levels_for(user).items() if level == OFF}


def settings_for(user: User) -> SocialSettings:
    """The person-level switches (visits counted, WhatsApp consent)."""
    found = SocialSettings.objects.filter(user=user).first()
    return found or SocialSettings(user=user)


def preferences_payload(user: User) -> dict[str, Any]:
    from core.services import whatsapp

    levels = levels_for(user)
    personal = settings_for(user)
    return {
        "email_available": email_enabled(),
        "whatsapp_available": whatsapp.enabled(),
        "email": user.email,
        "has_phone": bool(whatsapp.normalise_phone(user.phone)),
        "count_my_visits": personal.count_my_visits,
        "whatsapp_opt_in": personal.whatsapp_opt_in,
        "levels": [{"value": v, "label": LEVEL_LABELS[v]} for v in LEVELS],
        "kinds": [
            {
                "key": k.key,
                "label": k.label,
                "description": k.description,
                "group": k.group,
                "level": levels[k.key],
                "default": k.default,
                "whatsapp": k.whatsapp,
                "can_turn_off": k.can_turn_off,
            }
            for k in KINDS.values()
            if applies_to(k, user)
        ],
    }


def set_preferences(
    user: User,
    levels: dict[str, str] | None = None,
    *,
    count_my_visits: bool | None = None,
    whatsapp_opt_in: bool | None = None,
) -> None:
    """Save a person's choices. Raises ValueError, naming the bad entry."""
    levels = levels or {}
    for kind, level in levels.items():
        if kind not in KINDS:
            raise ValueError(f"There is no kind of alert called {kind!r}.")
        if level not in LEVELS:
            raise ValueError(f"{level!r} is not a setting; use email, in_app or off.")
        if level == OFF and not KINDS[kind].can_turn_off:
            raise ValueError(f"{KINDS[kind].label} cannot be switched off.")
    with transaction.atomic():
        for kind, level in levels.items():
            NotificationPreference.objects.update_or_create(
                user=user, kind=kind, defaults={"level": level}
            )
        if count_my_visits is not None or whatsapp_opt_in is not None:
            personal, _ = SocialSettings.objects.get_or_create(user=user)
            if count_my_visits is not None:
                personal.count_my_visits = bool(count_my_visits)
            if whatsapp_opt_in is not None:
                personal.whatsapp_opt_in = bool(whatsapp_opt_in)
            personal.save()


# --------------------------------------------------------------------------- #
# Reading the bell                                                             #
# --------------------------------------------------------------------------- #


def visible_to(user: User):
    """This person's alerts, less every kind they switched off."""
    qs = Notification.objects.filter(user=user)
    off = off_kinds(user)
    if off:
        qs = qs.exclude(kind__in=off)
        if GENERAL in off:
            # A kind nobody registered reads as general, so it goes with it.
            qs = qs.filter(kind__in=list(KINDS))
    return qs


def in_section(qs, section: str):
    keys = [k.key for k in KINDS.values() if k.section == section]
    if section == kind_of(GENERAL).section:
        return qs.filter(Q(kind__in=keys) | ~Q(kind__in=list(KINDS)))
    return qs.filter(kind__in=keys)


def serialize(n: Notification) -> dict[str, Any]:
    return {
        "id": n.id,
        "title": n.title,
        "body": n.body,
        "href": n.href,
        "read": n.read,
        "created_at": n.created_at.isoformat(),
        "kind": n.kind,
        "section": kind_of(n.kind).section,
        "count": n.group_count,
        "actors": [a.get("name") for a in (n.actors or []) if a.get("name")][:3],
        "emailed": n.emailed_at is not None,
    }


# --------------------------------------------------------------------------- #
# Sending                                                                      #
# --------------------------------------------------------------------------- #


def email_enabled() -> bool:
    """A mail server is configured. EMAIL_NOTIFICATIONS is the older switch
    for a backend that needs no host (a console or file backend)."""
    return bool(getattr(settings, "EMAIL_HOST", "")) or bool(
        getattr(settings, "EMAIL_NOTIFICATIONS", False)
    )


def app_url(path: str | None) -> str:
    base = getattr(settings, "APP_BASE_URL", "") or ""
    if not path:
        return base or "/"
    if path.startswith("http://") or path.startswith("https://"):
        return path
    return f"{base}{path if path.startswith('/') else '/' + path}"


def unsubscribe_token(user: User, kind: str) -> str:
    return signing.dumps({"u": user.pk, "k": kind}, salt=_UNSUBSCRIBE_SALT)


def read_unsubscribe_token(token: str) -> tuple[str, str] | None:
    try:
        data = signing.loads(token, salt=_UNSUBSCRIBE_SALT)
    except signing.BadSignature:
        return None
    if not isinstance(data, dict) or data.get("k") not in KINDS:
        return None
    return str(data.get("u")), data["k"]


def _who(actors: list[dict[str, Any]], count: int) -> str:
    names = [a.get("name") or "Somebody" for a in actors] or ["Somebody"]
    if count <= 1:
        return names[0]
    if count == 2 and len(names) >= 2:
        return f"{names[0]} and {names[1]}"
    others = count - 1
    return f"{names[0]} and {others} other{'' if others == 1 else 's'}"


def _actor_entry(actor: User | None) -> dict[str, Any] | None:
    if actor is None:
        return None
    return {"id": actor.pk, "name": actor.name or actor.email}


def notify(
    user: User | None,
    kind: str,
    title: str | None = None,
    body: str | None = "",
    href: str | None = None,
    *,
    claim_id: str | None = None,
    actor: User | None = None,
    verb: str | None = None,
    group_key: str | None = None,
    email_template: str | None = None,
    email_context: dict[str, Any] | None = None,
    email_connection: Any = None,
    at=None,
) -> Notification | None:
    """Tell `user` something, as they asked to be told. See the module notes.

    `at` stamps the alert with a scheduled job's own clock, which is what the
    job's "once a week" checks compare against.

    Returns the alert, or None when this person has this kind switched off
    (or has no active account).
    """
    if user is None or not getattr(user, "active", True):
        return None
    if kind not in KINDS:
        logger.warning("notify: unknown kind %r, filed as general", kind)
        kind = GENERAL
    spec = KINDS[kind]
    level = level_for(user, kind)
    if level == OFF:
        return None
    entry = _actor_entry(actor)
    if verb and not title:
        title = f"{entry['name'] if entry else 'Somebody'} {verb}"
    title = (title or spec.label)[:255]

    note, created = None, True
    if group_key:
        note, created = _join_group(user, kind, group_key, entry, verb, title, body, href)
    if note is None:
        note = Notification.objects.create(
            user=user,
            kind=kind,
            title=title,
            body=body or None,
            href=href,
            claim_id=claim_id,
            group_key=group_key,
            actors=[entry] if entry else [],
        )
    if not created:
        return note
    if at is not None:
        # auto_now_add ignores a value passed to create(), so it is set after.
        Notification.objects.filter(pk=note.pk).update(created_at=at)
        note.created_at = at

    if level == EMAIL:
        send_email(
            note,
            user,
            template=email_template or "notifications/email.html",
            context=email_context or {},
            connection=email_connection,
        )
    if spec.whatsapp:
        from core.services import whatsapp

        whatsapp.send_alert(user, note.title, note.body or "")
    return note


def _join_group(user, kind, group_key, entry, verb, title, body, href):
    """Fold this alert into an unread one with the same key, if there is one.

    Returns (alert, created): (None, True) when there is nothing to join.
    """
    with transaction.atomic():
        existing = (
            Notification.objects.select_for_update()
            .filter(user=user, group_key=group_key, read=False)
            .order_by("-created_at")
            .first()
        )
        if existing is None:
            return None, True
        actors = list(existing.actors or [])
        if entry is not None:
            is_new = all(a.get("id") != entry["id"] for a in actors)
            actors = [entry] + [a for a in actors if a.get("id") != entry["id"]]
            if is_new:
                existing.group_count += 1
        else:
            existing.group_count += 1
        existing.actors = actors[:ACTORS_KEPT]
        if verb:
            existing.title = f"{_who(existing.actors, existing.group_count)} {verb}"[:255]
        else:
            existing.title = title
        if body:
            existing.body = body
        if href:
            existing.href = href
        existing.kind = kind
        # Back to the top of the bell: something new happened to it.
        existing.created_at = timezone.now()
        existing.save()
        return existing, False


def emails_sent_today() -> int:
    start = timezone.localtime().replace(hour=0, minute=0, second=0, microsecond=0)
    return Notification.objects.filter(emailed_at__gte=start).count()


def email_room_today() -> int | None:
    """How many more emails today's cap allows; None when there is no cap."""
    cap = int(getattr(settings, "EMAIL_DAILY_CAP", 0) or 0)
    if cap <= 0:
        return None
    return max(0, cap - emails_sent_today())


def send_email(
    note: Notification,
    user: User,
    *,
    template: str = "notifications/email.html",
    context: dict[str, Any] | None = None,
    connection: Any = None,
) -> bool:
    """Email one alert. Returns whether it went. Never raises."""
    if not email_enabled() or not user.email:
        return False
    room = email_room_today()
    if room is not None and room <= 0:
        logger.warning("email_cap_reached kind=%s user=%s", note.kind, user.pk)
        return False
    from core.services import institution

    spec = kind_of(note.kind)
    unsubscribe = app_url(f"/api/notifications/unsubscribe/{unsubscribe_token(user, spec.key)}")
    ctx = {
        "college": institution.get("college_name"),
        "title": note.title,
        "body": note.body or "",
        "action_url": app_url(note.href) if note.href else None,
        "action_label": "Open in the app",
        "kind_label": spec.label,
        "unsubscribe_url": unsubscribe,
        "settings_url": app_url("/settings/notifications"),
        "app_base": getattr(settings, "APP_BASE_URL", "") or "",
        "name": user.name or user.email,
        **(context or {}),
    }
    try:
        html = render_to_string(template, ctx)
        text = render_to_string("notifications/email.txt", ctx)
        msg = EmailMultiAlternatives(
            subject=note.title,
            body=text,
            from_email=getattr(settings, "DEFAULT_FROM_EMAIL", None),
            to=[user.email],
            headers={
                "List-Unsubscribe": f"<{unsubscribe}>",
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
            connection=connection,
        )
        msg.attach_alternative(html, "text/html")
        msg.send()
    except Exception:
        logger.exception("email_failed kind=%s user=%s", note.kind, user.pk)
        return False
    now = timezone.now()
    Notification.objects.filter(pk=note.pk).update(emailed_at=now)
    note.emailed_at = now
    return True
