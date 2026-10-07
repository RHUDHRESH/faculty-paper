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
import re
from datetime import timedelta
from dataclasses import dataclass
from typing import Any, Iterable

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
             "Monday morning, only when there is something in it: your papers' "
             "progress, papers found on your record, your department's pace, or "
             "what is waiting for you to act on. Email is opt-in.",
             _REMINDERS, "updates", IN_APP),
        Kind("nudge_cutoff", "Filing deadline",
             "A few days before this month's filing closes, if you have a draft.",
             _REMINDERS, "updates", EMAIL, "claimant"),
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
        Kind("event", "Seminars and events",
             "When a seminar, workshop, conference, programme or call for papers is "
             "posted for the whole college or for your department. Once per event, "
             "never again when it is edited.",
             "Events", "updates", IN_APP),
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

#: The one button in each kind's email, taking the reader to the exact page.
EMAIL_ACTIONS: dict[str, str] = {
    "claim_approved": "See the paper",
    "claim_paid": "See the payment",
    "claim_sent_back": "Make the changes",
    "claim_not_accepted": "See the reason",
    "claim_status": "See the paper",
    "citation": "See who cited it",
    "digest": "Open this week in the app",
    "nudge_cutoff": "Finish your draft",
    "desk": "Open the queue",
    "follow": "See their profile",
    "comment": "Read the comment",
    "mention": "See where",
    "reaction": "See the post",
    "message": "Read the message",
    "collab": "Open the conversation",
    "endorsement": "See your profile",
    "badge": "See your badges",
    "target": "See the department",
    "event": "See the event",
    "moderation": "See what happened",
    GENERAL: "Open in the app",
}

#: Words that would tell a claimant which desk, or who, is holding their
#: paper. A sentence carrying one is left out of a claimant's email.
DESK_WORDS = ("principal", "director", "finance", "hod", "head of department",
              "research office", "research cell", "coordinator", "supervisor", "clearing", "desk",
              "admin", "officer")
_DESK_RE = re.compile(r"\b(" + "|".join(re.escape(w) for w in DESK_WORDS) + r")\b", re.I)


def claimant_safe(text: str | None) -> str:
    """`text` less every sentence that names a desk or the person at it."""
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    return " ".join(p for p in parts if p and not _DESK_RE.search(p)).strip()


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
        # Only the super admin is shown the mail server and can test it.
        "smtp": smtp_status() if user.role == "SUPER_ADMIN" else None,
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


def _plain(text: str | None) -> str | None:
    from core.social_notify import plain  # social_notify imports this module

    return plain(text) if text else text


def serialize(n: Notification) -> dict[str, Any]:
    return {
        "id": n.id,
        "title": n.title,
        # Rows written before mention codes were flattened still read cleanly.
        "body": _plain(n.body),
        "href": n.href,
        "read": n.read,
        "created_at": n.created_at.isoformat(),
        "kind": n.kind,
        "section": kind_of(n.kind).section,
        "count": n.group_count,
        "actors": [a.get("name") for a in (n.actors or []) if a.get("name")][:3],
        # The face beside the line: the latest actor, filled with photo_url by
        # core.faces on the way out.
        "actor": next(
            ({"user_id": str(a["id"]), "name": a["name"]} for a in (n.actors or []) if a.get("id") and a.get("name")),
            None,
        ),
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


def notify_many(
    users: Iterable[User],
    kind: str,
    title: str | None = None,
    body: str | None = "",
    href: str | None = None,
    *,
    actor: User | None = None,
) -> int:
    """`notify` for a whole group at once: a department, or the college.

    The same rules, in a few queries rather than three per person -- told one
    at a time, a college-wide seminar held its request open for seconds on the
    free host. Somebody who switched the kind off, or whose account is closed,
    is left out. Somebody who asked for email (or a kind that also goes by
    WhatsApp) is handed to `notify`, which knows how; everybody else gets their
    alert in one batch insert. Returns how many were told.
    """
    people = [u for u in users if getattr(u, "active", True)]
    if not people:
        return 0
    if kind not in KINDS:
        logger.warning("notify_many: unknown kind %r, filed as general", kind)
        kind = GENERAL
    spec = KINDS[kind]
    chosen = dict(
        NotificationPreference.objects.filter(kind=kind, user__in=people).values_list("user_id", "level")
    )
    entry = _actor_entry(actor)
    title = (title or spec.label)[:255]
    rows: list[Notification] = []
    told = 0
    for person in people:
        level = chosen.get(person.pk, spec.default)
        if level == OFF:
            continue
        if level == EMAIL or spec.whatsapp:
            told += notify(person, kind, title, body, href, actor=actor) is not None
            continue
        rows.append(
            Notification(
                user=person, kind=kind, title=title, body=body or None, href=href,
                actors=[entry] if entry else [],
            )
        )
    Notification.objects.bulk_create(rows, batch_size=500)
    return told + len(rows)


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


# --------------------------------------------------------------------------- #
# Hourly batching                                                              #
# --------------------------------------------------------------------------- #
#
# Nobody is sent more than EMAIL_HOURLY_PER_PERSON emails in an hour. Past
# that, an alert stays in the app with no email, and the hourly job
# (`flush_held_emails`, schedule "email-batch") sends everything held as one
# email. Alerts sent together share one emailed_at, so an email is counted
# once however many alerts it carried.

#: How far back the hourly job looks for alerts it still owes an email.
HELD_WINDOW = timedelta(hours=6)


def hourly_limit() -> int:
    return int(getattr(settings, "EMAIL_HOURLY_PER_PERSON", 4) or 0)


def emails_this_hour(user: User, now=None) -> int:
    now = now or timezone.now()
    return (
        Notification.objects.filter(user=user, emailed_at__gte=now - timedelta(hours=1))
        .values("emailed_at")
        .distinct()
        .count()
    )


def _hour_is_full(user: User) -> bool:
    limit = hourly_limit()
    return limit > 0 and emails_this_hour(user) >= limit


def _is_claimant(user: User) -> bool:
    from core.services import rbac

    return user.role in rbac.CLAIMANT_ROLES


def _deliver(user: User, subject: str, ctx: dict[str, Any], template: str,
             unsubscribe: str | None, connection: Any = None) -> bool:
    html = render_to_string(template, ctx)
    text = render_to_string("notifications/email.txt", ctx)
    headers = {}
    if unsubscribe:
        headers = {
            "List-Unsubscribe": f"<{unsubscribe}>",
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
    msg = EmailMultiAlternatives(
        subject=subject,
        body=text,
        from_email=getattr(settings, "DEFAULT_FROM_EMAIL", None),
        to=[user.email],
        headers=headers,
        connection=connection,
    )
    msg.attach_alternative(html, "text/html")
    msg.send()
    return True


def _base_context(user: User) -> dict[str, Any]:
    from core.services import institution

    return {
        "college": institution.get("college_name"),
        "settings_url": app_url("/settings/notifications"),
        "app_base": getattr(settings, "APP_BASE_URL", "") or "",
        "name": user.name or user.email,
    }


def email_context(note: Notification, user: User, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """What one alert's email says. A claimant's never names a desk."""
    spec = kind_of(note.kind)
    title, body = note.title, note.body or ""
    if _is_claimant(user):
        title = claimant_safe(title) or spec.label
        body = claimant_safe(body)
    return {
        **_base_context(user),
        "subject": title,
        "title": title,
        "body": body,
        "action_url": app_url(note.href) if note.href else app_url("/notifications"),
        "action_label": EMAIL_ACTIONS.get(spec.key, "Open in the app"),
        "kind_label": spec.label,
        "unsubscribe_url": app_url(f"/api/notifications/unsubscribe/{unsubscribe_token(user, spec.key)}"),
        **(extra or {}),
    }


def send_email(
    note: Notification,
    user: User,
    *,
    template: str = "notifications/email.html",
    context: dict[str, Any] | None = None,
    connection: Any = None,
) -> bool:
    """Email one alert. Returns whether it went. Never raises.

    Held back (False) when this person's hour is full: the hourly job sends
    it with the rest, as one email.
    """
    if not email_enabled() or not user.email:
        return False
    room = email_room_today()
    if room is not None and room <= 0:
        logger.warning("email_cap_reached kind=%s user=%s", note.kind, user.pk)
        return False
    if _hour_is_full(user):
        logger.info("email_held kind=%s user=%s", note.kind, user.pk)
        return False
    ctx = email_context(note, user, context)
    try:
        _deliver(user, ctx["subject"], ctx, template, ctx["unsubscribe_url"], connection)
    except Exception:
        logger.exception("email_failed kind=%s user=%s", note.kind, user.pk)
        return False
    now = timezone.now()
    Notification.objects.filter(pk=note.pk).update(emailed_at=now)
    note.emailed_at = now
    return True


def held_for(user: User, now=None) -> list[Notification]:
    """Unread alerts of the last few hours this person wanted by email and
    was not sent, because their hour was full."""
    now = now or timezone.now()
    wanted = [k for k, level in levels_for(user).items() if level == EMAIL]
    return list(
        Notification.objects.filter(
            user=user, kind__in=wanted, emailed_at__isnull=True, read=False,
            created_at__gte=now - HELD_WINDOW,
        ).order_by("created_at")
    )


def flush_held_emails(now=None) -> dict[str, int]:
    """The hourly job: one email per person carrying everything held back."""
    now = now or timezone.now()
    summary = {"people": 0, "alerts": 0}
    if not email_enabled():
        return summary
    people = User.objects.filter(
        active=True,
        notifications__emailed_at__isnull=True,
        notifications__read=False,
        notifications__created_at__gte=now - HELD_WINDOW,
    ).exclude(email="").distinct()
    for user in people:
        notes = held_for(user, now)
        if not notes or _hour_is_full(user):
            continue
        room = email_room_today()
        if room is not None and room <= 0:
            break
        claimant = _is_claimant(user)
        items = []
        for n in notes:
            title = (claimant_safe(n.title) or kind_of(n.kind).label) if claimant else n.title
            items.append({"title": title, "href": app_url(n.href or "/notifications")})
        count = len(items)
        subject = f"{count} update{'s' if count != 1 else ''} while you were away"
        ctx = {
            **_base_context(user),
            "subject": subject,
            "title": subject,
            "body": "These came in faster than one email an hour, so here they are together.",
            "batch": items,
            "text_sections": "\n".join(f"- {i['title']}: {i['href']}" for i in items),
            "action_url": app_url("/notifications"),
            "action_label": "Open your notifications",
            "kind_label": "",
            "unsubscribe_url": None,
        }
        try:
            _deliver(user, subject, ctx, "notifications/batch_email.html", None)
        except Exception:
            logger.exception("email_batch_failed user=%s", user.pk)
            continue
        stamp = timezone.now()
        Notification.objects.filter(pk__in=[n.pk for n in notes]).update(emailed_at=stamp)
        summary["people"] += 1
        summary["alerts"] += count
    return summary


# --------------------------------------------------------------------------- #
# Mail server status and the test email                                        #
# --------------------------------------------------------------------------- #


def smtp_status() -> dict[str, Any]:
    """What the settings page says about the mail server. Never the password."""
    host = getattr(settings, "EMAIL_HOST", "") or ""
    configured = email_enabled()
    if host:
        line = (f"Email goes out through {host}, port {getattr(settings, 'EMAIL_PORT', '')}, "
                f"from {getattr(settings, 'DEFAULT_FROM_EMAIL', '')}.")
    elif configured:
        line = "Email is switched on without a mail server; it is written to the server log."
    else:
        line = ("The mail server (SMTP) is not set up, so nothing is emailed yet. "
                "Set EMAIL_HOST and the other EMAIL_ variables on the server.")
    return {
        "configured": configured,
        "host": host,
        "port": getattr(settings, "EMAIL_PORT", None) if host else None,
        "from_email": getattr(settings, "DEFAULT_FROM_EMAIL", ""),
        "line": line,
    }


def send_test_email(user: User) -> tuple[bool, str]:
    """Email `user` a test message. Returns (sent, what to show them)."""
    if not email_enabled():
        return False, smtp_status()["line"]
    if not user.email:
        return False, "Your account has no email address."
    ctx = {
        **_base_context(user),
        "subject": "Test email",
        "title": "Test email",
        "body": "If you can read this, the mail server is working.",
        "action_url": app_url("/settings/notifications"),
        "action_label": "Back to notification settings",
        "kind_label": "",
        "unsubscribe_url": None,
    }
    try:
        _deliver(user, "Test email", ctx, "notifications/email.html", None)
    except Exception as exc:
        logger.exception("email_test_failed user=%s", user.pk)
        return False, f"The mail server refused it: {exc.__class__.__name__}. Check the EMAIL_ settings."
    return True, f"Sent to {user.email}. It can take a minute to arrive."
