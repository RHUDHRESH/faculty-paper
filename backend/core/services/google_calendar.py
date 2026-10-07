"""Connect Google Calendar: a calendar of the person's own, kept in step with this one.

One click on "Connect Google Calendar" sends the person to Google's consent
screen. On the way back we keep an encrypted refresh token, make a secondary
calendar called "Saveetha Publications" in their account and push what they can
see here into it, now and after every change. The scope is
`calendar.app.created`: the app can create and manage calendars it made, and
nothing else; it cannot read the person's other calendars. (`openid` and
`email` ride along only to learn which Google account was connected.)

Everything that touches Google goes through three seams, so tests never call it:
`build_service` (the Calendar client), `_exchange_code` (code for tokens) and
`_verified_email` (the ID-token check).

Sync is idempotent. `GoogleCalendarLink.event_map` remembers, for each thing
sent, Google's event id and a hash of what was sent; a run creates what is new,
patches what changed, deletes what went, and touches nothing else.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import secrets
import time
from datetime import date, datetime, time as clock_time, timedelta
from typing import Any, Iterable, Optional

import requests
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.core import signing
from django.db.models import Q
from django.utils import timezone
from google.auth.exceptions import GoogleAuthError, RefreshError
from google.auth.transport.requests import Request as GoogleRequest
from googleapiclient.errors import HttpError
from ninja.errors import HttpError as ApiError

from core import discussions
from core.models import CalendarEvent, GoogleCalendarLink, User

logger = logging.getLogger(__name__)

SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar.app.created"
#: `openid` and the email scope are only here so the ID token names the account.
SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", SCOPE_CALENDAR]

AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"
REVOKE_URI = "https://oauth2.googleapis.com/revoke"

CALENDAR_NAME = "Saveetha Publications"
CALENDAR_DESCRIPTION = "Deadlines, payouts, seminars and events from the college publications site"

#: The signed `state` is good for ten minutes: long enough to read a consent
#: screen, too short to be worth keeping.
STATE_SALT = "faculty-paper.google-calendar.connect"
STATE_MAX_AGE = 10 * 60
SESSION_KEY = "google_calendar_oauth"

#: What a person's Google calendar holds: today and the next twelve months.
WINDOW_DAYS = 365
#: googleapiclient retries 429 and 5xx (and Google's rate-limit 403s) with
#: backoff on its own; this is how many times.
RETRIES = 4
#: Seconds to wait on any one call to Google. The libraries' own defaults (60
#: for the Calendar client, 120 for the token call) are as long as a web
#: request is allowed to live.
HTTP_TIMEOUT = 30
#: How long a request that syncs inline (the way back from Google, "Sync now")
#: works before it hands the rest to the queue and answers.
INLINE_BUDGET = 40
#: A sync that has held its lock longer than this crashed; the lock is ignored.
LOCK_MINUTES = 10
#: Rounds a running sync makes when asked to go again, so an edit that lands
#: mid-run is not left for tomorrow.
MAX_PASSES = 3

#: Teacher-facing names. A kind the map does not know -- one added after this
#: was written -- reads as "Event" rather than as its code.
KIND_LABELS = {
    "PAYOUT_RUN": "Payment run",
    "SUBMISSION_WINDOW": "Submission window",
    "DEADLINE": "Deadline",
    "MEETING": "Meeting",
    "SEMINAR": "Seminar",
    "WORKSHOP": "Workshop",
    "CONFERENCE": "Conference",
    "FDP": "Faculty development programme",
    "CALL_FOR_PAPERS": "Call for papers",
    "OTHER": "Event",
}

_BUSY_WORDS = ("rate limit", "ratelimit", "usage limit", "quota", "backend error")


# ---------------------------------------------------------------------------
# What can go wrong, in the order a person would care about it
# ---------------------------------------------------------------------------


class ConnectError(Exception):
    """The connect did not complete. The message is for the person, in plain words."""


class StateError(Exception):
    """The `state` came back altered, late, or not at all."""


class NeedsReconnect(Exception):
    """Google will not let this link in any more: revoked, or the token is unreadable."""


class GoogleUnavailable(Exception):
    """Google could not be reached or would not refresh the token. Try again later."""


class GoogleBusy(Exception):
    """Google is rate-limiting or failing. Stop, keep what was done, try later."""


class CalendarGone(Exception):
    """Google has no calendar by that id: the person deleted it."""


def configured() -> bool:
    return bool(
        (getattr(settings, "GOOGLE_OAUTH_CLIENT_ID", "") or "").strip()
        and (getattr(settings, "GOOGLE_OAUTH_CLIENT_SECRET", "") or "").strip()
    )


def local_today() -> date:
    return timezone.localdate()


def _clock() -> float:
    return time.monotonic()


# ---------------------------------------------------------------------------
# The refresh token at rest
# ---------------------------------------------------------------------------


def _fernet() -> Fernet:
    """A key derived from SECRET_KEY, so there is no second secret to look after.

    HKDF with a fixed `info` string keeps this key apart from anything else
    SECRET_KEY is used for. Changing SECRET_KEY makes every stored token
    unreadable, which `decrypt` reports as "connect again" rather than crashing.
    """
    key = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None,
        info=b"faculty-paper/google-calendar/refresh-token/v1",
    ).derive(settings.SECRET_KEY.encode())
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt(stored: str) -> str:
    try:
        return _fernet().decrypt(stored.encode()).decode()
    except (InvalidToken, ValueError, TypeError, AttributeError) as e:
        raise NeedsReconnect("The stored Google token cannot be read") from e


# ---------------------------------------------------------------------------
# Consent: the way out and the way back
# ---------------------------------------------------------------------------


def _base_url(request) -> str:
    """The site people open. Locally there is no public address, so the request's own."""
    configured_base = (getattr(settings, "APP_BASE_URL", "") or "").rstrip("/")
    host = request.get_host()
    local = settings.DEBUG and host.split(":")[0] in ("localhost", "127.0.0.1")
    if configured_base and not local:
        return configured_base
    return f"{request.scheme}://{host}"


def redirect_uri(request) -> str:
    return f"{_base_url(request)}/api/calendar/google/callback"


def _flow(request):
    from google_auth_oauthlib.flow import Flow

    config = {"web": {
        "client_id": settings.GOOGLE_OAUTH_CLIENT_ID,
        "client_secret": settings.GOOGLE_OAUTH_CLIENT_SECRET,
        "auth_uri": AUTH_URI,
        "token_uri": TOKEN_URI,
    }}
    return Flow.from_client_config(config, scopes=SCOPES, redirect_uri=redirect_uri(request))


def make_state(user: User, nonce: str) -> str:
    return signing.dumps({"u": str(user.pk), "n": nonce}, salt=STATE_SALT)


def read_state(state: str) -> dict[str, str]:
    try:
        return signing.loads(state, salt=STATE_SALT, max_age=STATE_MAX_AGE)
    except signing.BadSignature as e:  # includes SignatureExpired
        raise StateError("The state is not valid") from e


def begin(request, user: User) -> str:
    """The Google consent URL for this person, and a pending connect in their session.

    The `state` is signed, expires, names the person, and carries a nonce that
    is also kept in the session: a link followed from somebody else's browser,
    or after the session changed, does not match. The PKCE verifier stays in
    the session too -- the browser only ever sees its hash.
    """
    nonce = secrets.token_urlsafe(16)
    flow = _flow(request)
    extra: dict[str, str] = {"prompt": "consent", "access_type": "offline"}
    # A college Google address goes straight to the right account; anything
    # else gets Google's own account chooser rather than a dead end.
    domain = (getattr(settings, "GOOGLE_HOSTED_DOMAIN", "") or "").strip().lower()
    if domain and user.email.lower().endswith("@" + domain):
        extra["login_hint"] = user.email
    url, _ = flow.authorization_url(state=make_state(user, nonce), **extra)
    request.session[SESSION_KEY] = {"n": nonce, "v": flow.code_verifier}
    return url


def _exchange_code(request, code: str, verifier: str) -> dict[str, Any]:
    """Trade the one-time code for tokens: the only call that carries the client secret."""
    # If somebody unticks a box, Google returns fewer scopes than asked for and
    # oauthlib would raise "Scope has changed". We read the list ourselves and
    # say which box was missed.
    os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
    flow = _flow(request)
    flow.code_verifier = verifier
    token = flow.fetch_token(code=code)
    scope = token.get("scope") or ""
    if isinstance(scope, (list, tuple)):
        scope = " ".join(scope)
    return {"refresh_token": token.get("refresh_token"), "id_token": token.get("id_token"), "scope": scope}


def _verified_email(raw_id_token: str) -> str:
    """Which Google account was connected, from an ID token Google signed for us."""
    from core.api.auth import _verified_google_claims  # the sign-in's own check

    try:
        claims = _verified_google_claims(raw_id_token)
    except ApiError as e:
        raise ConnectError("Google could not confirm which account this is. Please try again.") from e
    email = (claims.get("email") or "").strip().lower()
    if not email:
        raise ConnectError("Google did not say which account this is. Please try again.")
    return email


WHY_STATE = "That sign-in took too long or did not start here. Please press Connect again."
WHY_DENIED = "You chose not to allow it, so nothing was connected."
WHY_NO_CALENDAR = "Google did not give permission to add a calendar. Tick the calendar box and try again."
WHY_NO_REFRESH = (
    "Google did not keep the connection open. Remove Saveetha Publications under "
    "your Google Account's third-party access, then connect again."
)
WHY_EXCHANGE = "Google could not finish connecting. Please try again in a moment."


def finish_connection(request, user: User, *, code: Optional[str], state: Optional[str]) -> GoogleCalendarLink:
    """The way back from Google's consent screen. Raises ConnectError with a plain reason."""
    pending = request.session.pop(SESSION_KEY, None)  # once only, whatever happens next
    if not code or not state or not isinstance(pending, dict):
        raise ConnectError(WHY_STATE)
    try:
        data = read_state(state)
    except StateError:
        raise ConnectError(WHY_STATE)
    if data.get("u") != str(user.pk) or not secrets.compare_digest(
        str(data.get("n", "")), str(pending.get("n", ""))
    ):
        raise ConnectError(WHY_STATE)

    try:
        tokens = _exchange_code(request, code, str(pending.get("v") or ""))
    except Exception:  # noqa: BLE001 -- whatever Google or the network did, the person gets one sentence
        logger.warning("google_calendar_exchange_failed", exc_info=True)
        raise ConnectError(WHY_EXCHANGE)
    granted = str(tokens.get("scope") or "").split()
    if SCOPE_CALENDAR not in granted:
        raise ConnectError(WHY_NO_CALENDAR)
    refresh = tokens.get("refresh_token")
    if not refresh:
        raise ConnectError(WHY_NO_REFRESH)
    try:
        email = _verified_email(str(tokens.get("id_token") or ""))
    except ConnectError:
        raise
    except Exception:  # noqa: BLE001
        logger.warning("google_calendar_idtoken_failed", exc_info=True)
        raise ConnectError(WHY_EXCHANGE)

    link = GoogleCalendarLink.objects.filter(user=user).first()
    fields = ["google_email", "refresh_token_enc", "scope", "needs_reconnect", "last_error"]
    if link and link.google_email and link.google_email.lower() != email:
        # A different Google account: the old calendar belongs to the old one.
        teardown(link)
        link.calendar_id, link.event_map = "", {}
        fields += ["calendar_id", "event_map"]
    if link is None:
        link = GoogleCalendarLink(user=user)
    link.google_email = email
    link.refresh_token_enc = encrypt(str(refresh))
    link.scope = " ".join(granted)
    link.needs_reconnect = False
    link.last_error = ""
    if link._state.adding:
        link.save()
    else:
        # Only these columns: a sync may be running on this row, and a whole-row
        # save would put back the event map it had before the sync's last step.
        link.save(update_fields=fields)

    try:
        if sync_link(link, budget=INLINE_BUDGET)["partial"]:
            enqueue_sync([user.pk])  # a big first sync: the rest happens in the background
    except Exception:  # noqa: BLE001 -- connected is connected; "Sync now" can retry
        logger.exception("google_calendar_first_sync_failed")
        link.last_error = "The first sync did not finish. Press Sync now to try again."
        link.save(update_fields=["last_error"])
    return link


# ---------------------------------------------------------------------------
# The Calendar client
# ---------------------------------------------------------------------------


def _timed_request():
    """google-auth's own Request, asking for HTTP_TIMEOUT rather than its two-minute default."""
    inner = GoogleRequest()

    def request(url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        return inner(url, method=method, body=body, headers=headers, timeout=HTTP_TIMEOUT, **kwargs)

    return request


def build_service(link: GoogleCalendarLink):
    """A Calendar v3 client for this person, with a fresh access token.

    The refresh happens here, up front, so a revoked connection is found at one
    place: `invalid_grant` means the person (or Google) ended it.
    """
    import google_auth_httplib2
    import httplib2
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = Credentials(
        token=None,
        refresh_token=decrypt(link.refresh_token_enc),
        token_uri=TOKEN_URI,
        client_id=settings.GOOGLE_OAUTH_CLIENT_ID,
        client_secret=settings.GOOGLE_OAUTH_CLIENT_SECRET,
        scopes=[SCOPE_CALENDAR],
    )
    try:
        creds.refresh(_timed_request())
    except RefreshError as e:
        if "invalid_grant" in str(e).lower():
            raise NeedsReconnect("Google no longer accepts this connection") from e
        logger.warning("google_calendar_refresh_failed: %s", e)
        raise GoogleUnavailable("Google would not refresh the token") from e
    except GoogleAuthError as e:
        raise GoogleUnavailable("Could not reach Google") from e
    http = google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http(timeout=HTTP_TIMEOUT))
    return build("calendar", "v3", http=http, cache_discovery=False)


def _status(e: HttpError) -> int:
    try:
        return int(getattr(e.resp, "status", 0) or 0)
    except (TypeError, ValueError):
        return 0


def _execute(request):
    """Run one Calendar request, turning Google's refusals into what they mean here.

    404 and 410 are passed through as HttpError: whether "gone" matters depends
    on the call. Everything else that is not the request's own fault is typed.
    """
    try:
        return request.execute(num_retries=RETRIES)
    except HttpError as e:
        status = _status(e)
        if status == 401:
            raise NeedsReconnect("Google rejected the credentials") from e
        if status == 429 or status >= 500 or (status == 403 and any(w in str(e).lower() for w in _BUSY_WORDS)):
            raise GoogleBusy("Google is busy") from e
        if status == 403:
            raise NeedsReconnect("Google says this connection may not do that") from e
        raise


# ---------------------------------------------------------------------------
# What goes to Google
# ---------------------------------------------------------------------------


def kind_label(kind: Optional[str]) -> str:
    return KIND_LABELS.get(kind or "", "Event")


def site_url() -> str:
    return (getattr(settings, "APP_BASE_URL", "") or "").rstrip("/")


def _plain_payment(kind: str, text: str) -> str:
    """The college says "payout"; a lecturer reads "payment" (the page does the same)."""
    if kind not in ("PAYOUT", "CUTOFF"):
        return text

    def swap(m: re.Match) -> str:
        word = "payments" if m.group(0).lower().endswith("s") else "payment"
        return word.capitalize() if m.group(0)[0].isupper() else word

    return re.sub(r"payouts?", swap, text, flags=re.IGNORECASE)


def _day(d: date) -> dict[str, str]:
    return {"date": d.isoformat()}


def _local(d: date, t: clock_time) -> dict[str, str]:
    return {"dateTime": datetime.combine(d, t).isoformat(), "timeZone": settings.TIME_ZONE}


def _body(summary: str, start: dict, end: dict, label: str, link: str, *notes: Optional[str]) -> dict[str, Any]:
    parts = [n.strip() for n in notes if n and n.strip()]
    parts.append(f"{label} on the college publications site: {link}")
    return {
        "summary": summary,
        "description": "\n\n".join(parts),
        "start": start,
        "end": end,
        "source": {"title": CALENDAR_NAME, "url": link},
    }


def event_body(e: CalendarEvent) -> dict[str, Any]:
    """A calendar entry as Google's Events resource.

    All-day events end the day *after* their last day, as Google counts them.
    A timed event with no end lasts an hour (the same rule as the ICS feed).
    """
    last = e.ends_on or e.starts_on
    if e.starts_at is None:
        start, end = _day(e.starts_on), _day(last + timedelta(days=1))
    else:
        if e.ends_at is not None:
            end_time, end_day = e.ends_at, last
        else:
            end_time = (datetime.combine(date.min, e.starts_at) + timedelta(hours=1)).time()
            end_day = last + timedelta(days=1) if end_time < e.starts_at else last
        start, end = _local(e.starts_on, e.starts_at), _local(end_day, end_time)
    claim_id = getattr(e, "claim_id", None)
    link = f"{site_url()}/papers/{claim_id}" if claim_id else f"{site_url()}/calendar?date={e.starts_on.isoformat()}"
    body = _body(e.title, start, end, kind_label(e.kind), link, e.description)
    venue = (getattr(e, "venue", "") or "").strip()
    if venue:
        body["location"] = venue
    return body


def record_body(r: dict[str, Any]) -> dict[str, Any]:
    """A date the record already holds: its title and day, never an amount."""
    kind = r.get("kind", "")
    first = date.fromisoformat(r["starts_on"])
    last = first
    if r.get("whole_month"):
        last = (first.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    claim_id = r.get("claim_id")
    link = f"{site_url()}/papers/{claim_id}" if claim_id else f"{site_url()}/calendar?date={first.isoformat()}"
    label = _plain_payment(kind, r.get("kind_label") or "Event")
    outside = str(r["url"]) if str(r.get("url") or "").startswith(("http://", "https://")) else None
    return _body(
        _plain_payment(kind, r["title"]), _day(first), _day(last + timedelta(days=1)), label, link,
        f"Open the call: {outside}" if outside else None,
    )


def content_hash(body: dict[str, Any]) -> str:
    raw = json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


def desired_bodies(user: User, first: date, last: date) -> dict[str, dict[str, Any]]:
    """Everything this person sees on their calendar page, keyed by our own id.

    The same two sources as the page and the ICS feed: events the visibility
    rules let them see, and the dates the record already holds.
    """
    # Here, not at the top: that module registers the API's routes on import.
    from core.api import calendar as calendar_api

    out: dict[str, dict[str, Any]] = {}
    for e in calendar_api._events_in_window(user, first, last):
        out[e.id] = event_body(e)
    for r in calendar_api._record(user, first, last):
        out[r["id"]] = record_body(r)
    return out


# ---------------------------------------------------------------------------
# The sync
# ---------------------------------------------------------------------------

_SAVED = ["calendar_id", "event_map", "last_synced_at", "last_error", "needs_reconnect"]


def _ensure_calendar(service, link: GoogleCalendarLink) -> None:
    """The calendar exists on Google's side, or a fresh one stands in for it."""
    if link.calendar_id:
        try:
            _execute(service.calendars().get(calendarId=link.calendar_id))
            return
        except HttpError as e:
            if _status(e) not in (404, 410):
                raise
        # Deleted on Google's side: whatever we thought was in it is gone too.
        link.event_map = {}
    created = _execute(service.calendars().insert(body={
        "summary": CALENDAR_NAME,
        "description": CALENDAR_DESCRIPTION,
        "timeZone": settings.TIME_ZONE,
    }))
    link.calendar_id = created["id"]
    link.save(update_fields=["calendar_id", "event_map"])


def _insert(service, link: GoogleCalendarLink, body: dict[str, Any]) -> str:
    try:
        return _execute(service.events().insert(calendarId=link.calendar_id, body=body))["id"]
    except HttpError as e:
        if _status(e) in (404, 410):
            raise CalendarGone() from e
        raise


def _out_of_time(deadline: Optional[float], result: dict[str, Any]) -> bool:
    if deadline is not None and _clock() > deadline:
        result["partial"] = True
        return True
    return False


def _run(
    service, link: GoogleCalendarLink, today: date, result: dict[str, Any], deadline: Optional[float] = None
) -> None:
    desired = desired_bodies(link.user, today, today + timedelta(days=WINDOW_DAYS))
    _ensure_calendar(service, link)
    known: dict[str, dict[str, str]] = dict(link.event_map or {})

    def remember() -> None:
        # After every change, not at the end: a run that dies halfway must not
        # forget what it already sent, or the next one sends it twice.
        link.event_map = known
        link.save(update_fields=["event_map"])

    for key, body in desired.items():
        digest = content_hash(body)
        entry = known.get(key)
        if entry and entry.get("hash") == digest:
            continue
        if _out_of_time(deadline, result):
            return
        try:
            if entry:
                try:
                    _execute(service.events().patch(calendarId=link.calendar_id, eventId=entry["id"], body=body))
                    known[key] = {"id": entry["id"], "hash": digest}
                    result["updated"] += 1
                except HttpError as e:
                    if _status(e) not in (404, 410):
                        raise
                    known[key] = {"id": _insert(service, link, body), "hash": digest}
                    result["created"] += 1
            else:
                known[key] = {"id": _insert(service, link, body), "hash": digest}
                result["created"] += 1
        except HttpError:
            logger.warning("google_calendar_event_refused key=%s", key, exc_info=True)
            result["failed"] += 1
            continue
        remember()

    for key in [k for k in known if k not in desired]:
        if _out_of_time(deadline, result):
            return
        try:
            _execute(service.events().delete(calendarId=link.calendar_id, eventId=known[key]["id"]))
        except HttpError as e:
            if _status(e) not in (404, 410):
                logger.warning("google_calendar_delete_refused key=%s", key, exc_info=True)
                result["failed"] += 1
                continue
        known.pop(key)
        result["deleted"] += 1
        remember()


def _mark(link: GoogleCalendarLink, result: dict[str, Any], message: str, *, reconnect: bool = False) -> None:
    link.last_error = message
    link.needs_reconnect = reconnect
    link.save(update_fields=["last_error", "needs_reconnect"])
    result["error"] = message
    result["needs_reconnect"] = reconnect


MSG_RECONNECT = "Google no longer lets us in. Connect again to carry on."
MSG_BUSY = "Google is busy at the moment. We will try again soon."
MSG_UNREACHABLE = "We could not reach Google just now. We will try again soon."


def _one_pass(link: GoogleCalendarLink, today: date, result: dict[str, Any], deadline: Optional[float]) -> bool:
    """One look at both calendars and whatever it takes to make them agree.

    False when it could not finish (Google refused, or the time was up), with
    the reason on the link; True when it ran to the end.
    """
    try:
        service = build_service(link)
        for attempt in (1, 2):
            try:
                _run(service, link, today, result, deadline)
                break
            except CalendarGone:
                if attempt == 2:
                    raise GoogleBusy("The calendar keeps disappearing")
                link.calendar_id, link.event_map = "", {}
    except NeedsReconnect:
        _mark(link, result, MSG_RECONNECT, reconnect=True)
        return False
    except GoogleBusy:
        _mark(link, result, MSG_BUSY)
        return False
    except GoogleUnavailable:
        _mark(link, result, MSG_UNREACHABLE)
        return False
    if result["partial"]:
        return False  # not "synced": the page must not claim it is up to date

    n = result["failed"]
    link.last_error = (
        f"{n} {'event' if n == 1 else 'events'} could not be sent to Google. We will try again at the next sync."
        if n else ""
    )
    link.needs_reconnect = False
    link.last_synced_at = timezone.now()
    link.save(update_fields=_SAVED)
    return True


def _take_lock(link: GoogleCalendarLink) -> bool:
    """One UPDATE that either takes the lock or finds somebody holding it."""
    stale = timezone.now() - timedelta(minutes=LOCK_MINUTES)
    taken = (
        GoogleCalendarLink.objects.filter(pk=link.pk)
        .filter(Q(sync_started_at__isnull=True) | Q(sync_started_at__lt=stale))
        .update(sync_started_at=timezone.now())
    )
    return bool(taken)


def sync_link(
    link: GoogleCalendarLink, *, today: Optional[date] = None, budget: Optional[float] = None
) -> dict[str, Any]:
    """Bring this person's Google calendar in line with what they see here.

    Returns counts. Google's refusals are recorded on the link and returned,
    never raised; a bug of our own is raised after the progress so far has been
    saved, for the caller to log.

    `budget` is for a web request: after that many seconds it stops where it
    is, answers `partial`, and the rest is for the queue. The background run
    has none.

    Only one sync per person runs at a time. One that finds another running
    does nothing but leave a note to go round again, so the run in progress
    picks up whatever changed after it started looking; two at once would each
    send the same new event, and Google would hold both.
    """
    today = today or local_today()
    result: dict[str, Any] = {
        "created": 0, "updated": 0, "deleted": 0, "failed": 0,
        "partial": False, "busy": False, "error": None, "needs_reconnect": False,
    }
    if not _take_lock(link):
        GoogleCalendarLink.objects.filter(pk=link.pk).update(resync=True)
        result["busy"] = True
        return result
    deadline = _clock() + budget if budget is not None else None
    try:
        for _ in range(MAX_PASSES):
            GoogleCalendarLink.objects.filter(pk=link.pk).update(resync=False)
            if not _one_pass(link, today, result, deadline):
                break
            if not GoogleCalendarLink.objects.filter(pk=link.pk, resync=True).exists():
                break
    finally:
        GoogleCalendarLink.objects.filter(pk=link.pk).update(sync_started_at=None)
    return result


def sync_all(user_ids: Optional[Iterable[str]] = None) -> dict[str, int]:
    """Every connected person (or just these), one after another; one failing never stops the rest.

    Links waiting for a reconnect are left alone: they would only be refused
    again. A person whose sync is already running is left to it.
    """
    links = GoogleCalendarLink.objects.filter(needs_reconnect=False, user__active=True).select_related("user")
    if user_ids is not None:
        links = links.filter(user_id__in=list(user_ids))
    summary = {"synced": 0, "failed": 0, "running": 0}
    for link in links:
        try:
            result = sync_link(link)
        except Exception:  # noqa: BLE001 -- one person's bad day is not everyone's
            logger.exception("google_calendar_sync_failed user=%s", link.user_id)
            summary["failed"] += 1
        else:
            summary["running" if result["busy"] else "synced"] += 1
    return summary


# ---------------------------------------------------------------------------
# Leaving
# ---------------------------------------------------------------------------


def teardown(link: GoogleCalendarLink) -> bool:
    """Delete the calendar we made and revoke the token. Best effort, and says whether the calendar went.

    Disconnecting must always work: Google being down, or the token already
    dead, is no reason to keep somebody linked.
    """
    removed = not link.calendar_id
    if link.calendar_id:
        try:
            service = build_service(link)
            try:
                _execute(service.calendars().delete(calendarId=link.calendar_id))
                removed = True
            except HttpError as e:
                removed = _status(e) in (404, 410)
        except (NeedsReconnect, GoogleUnavailable, GoogleBusy, HttpError):
            logger.info("google_calendar_teardown_calendar_left user=%s", link.user_id)
    try:
        requests.post(
            REVOKE_URI, data={"token": decrypt(link.refresh_token_enc)},
            headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=10,
        )
    except Exception:  # noqa: BLE001 -- unreadable token, or no network: nothing more to do
        logger.info("google_calendar_teardown_revoke_skipped user=%s", link.user_id)
    return removed


# ---------------------------------------------------------------------------
# Keeping it fresh
# ---------------------------------------------------------------------------


def may_see(user: User, event: CalendarEvent) -> bool:
    """`core.api.calendar._visible_events` for one person and one event, without a query.

    A test holds the two together over every audience and role.
    """
    if event.visibility == "PUBLIC":
        return True
    if event.visibility == "PRIVATE":
        return event.created_by_id == user.id
    office = discussions.is_office(user.role)
    if event.visibility == "DEPARTMENT":
        department = (getattr(user, "department", "") or "").strip().lower()
        return office or bool(department and department == (event.department or "").lower())
    if event.visibility == "OFFICE":
        return office or event.created_by_id == user.id
    return False


def linked_audience(event: CalendarEvent) -> list[str]:
    """Ids of the connected people who can see this event: one query, no more."""
    links = GoogleCalendarLink.objects.filter(needs_reconnect=False, user__active=True).select_related("user")
    return [link.user_id for link in links if may_see(link.user, event)]


def enqueue_sync(user_ids: list[str]) -> None:
    """Queue a sync for these people. Never raises: a queue that is down must not undo an edit."""
    if not user_ids:
        return
    try:
        from django_q.tasks import async_task

        async_task("core.tasks.sync_google_calendars", list(user_ids))
    except Exception:  # noqa: BLE001
        logger.exception("google_calendar_enqueue_failed")


def event_changed(event: CalendarEvent) -> None:
    enqueue_sync(linked_audience(event))
