"""Bring your own keys: a person's own AI, Scopus, OpenAlex and Semantic Scholar accounts.

The college saves one key per service (core/services/integrations.py) and every
feature runs on it. This module lets a person add their own, so the features
*they* use run on their key and their allowance, and the college's allowance
is spent on nobody else's behalf.

Who may, and what then happens, is the super admin's policy per service:

``college``        everyone uses the college key; a saved own key is ignored.
``own_preferred``  the person's key when they have one, else the college's. The default.
``own_required``   the feature is unavailable until the person adds their own
                   (only AI and Scopus: OpenAlex and Semantic Scholar work without a key).

Resolution, for ``integrations.get(name, user)``:

    own key (policy allows)  >  college key set in the app  >  environment  >  empty

Whose key is the one thing that must never go wrong, so it is never a global.
``get`` takes the person, and a web request carries the signed-in person in a
context variable (set once, by ``ActingPersonMiddleware``, and cleared when the
request ends) so the deep readers (the AI providers, the Scopus client) see it
without every function between them growing a parameter. Threads and
background jobs start with nothing in it, which means the college key. Code
that hands work to a thread passes the person across with ``bind``; code run
for a person outside a request (the scout, a bulk check) wraps itself in
``acting_as``.

Storage: ``UserApiKey``. The secret is a Fernet token (the same scheme and the
same server key as the college's saved keys); the model holds no plaintext, and
no function here returns one to a screen. Counts of calls live on the row.
"""

from __future__ import annotations

import contextvars
import functools
import ipaddress
import json
import logging
import socket
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("core.integrations")

#: Marks "no person was named": the person of the request, if there is one.
AMBIENT: Any = object()

POLICIES = ("college", "own_preferred", "own_required")
DEFAULT_POLICY = "own_preferred"
POLICY_KEY = "user_keys.policy"

#: What a person can bring. "anthropic" is not here: a person picks Claude as
#: the kind of their one AI key.
USER_PROVIDERS = ("ai", "scopus", "openalex", "semanticscholar")

#: Services that cannot work without a key, so "own_required" means something.
REQUIRABLE = ("ai", "scopus")

#: The integration names a person's record answers, by provider group.
GROUP_OF = {"ai": "ai", "anthropic": "ai", "scopus": "scopus", "openalex": "openalex", "semanticscholar": "semanticscholar"}

AI_KINDS = ("openai", "anthropic")

#: Services a person is likely to use, by host: no DNS lookup is needed to
#: trust them, and a model is suggested so "model" can stay empty.
PRESET_HOSTS: dict[str, str] = {
    "api.groq.com": "llama-3.3-70b-versatile",
    "api.openai.com": "gpt-4o-mini",
    "generativelanguage.googleapis.com": "gemini-2.0-flash",
    "openrouter.ai": "",
}

BLOCKED_MESSAGE = {
    "ai": "Your college asks everyone to use their own AI key. Add yours in your Profile, under My API keys.",
    "scopus": "Your college asks everyone to use their own Scopus key. Add yours in your Profile, under My API keys.",
}

META: dict[str, dict[str, Any]] = {
    "ai": {
        "label": "AI service",
        "about": "Your own AI key: the app's AI features you use run on your account.",
        "works_without_key": False,
        "fields": [
            {"name": "kind", "label": "Kind of service", "secret": False, "required": True,
             "help": "OpenAI-compatible covers Groq, OpenAI, Gemini and OpenRouter. Or choose Claude (Anthropic)."},
            {"name": "base_url", "label": "Service address", "secret": False, "required": False,
             "help": "For example https://api.groq.com/openai/v1. Not needed for Claude."},
            {"name": "model", "label": "Model", "secret": False, "required": False,
             "help": "Optional for Claude, Groq, OpenAI and Gemini. Needed for other services."},
            {"name": "value", "label": "API key", "secret": True, "required": True, "help": ""},
        ],
    },
    "scopus": {
        "label": "Scopus (Elsevier)",
        "about": "Your own Scopus key: the paper and journal lookups you make use your Elsevier allowance.",
        "works_without_key": False,
        "fields": [
            {"name": "value", "label": "API key", "secret": True, "required": True, "help": ""},
            {"name": "inst_token", "label": "Institution token", "secret": True, "required": False,
             "help": "Optional. Only if Elsevier gave you one."},
        ],
    },
    "openalex": {
        "label": "OpenAlex",
        "about": "Your own OpenAlex details: the citation lookups you trigger go out under your email and key.",
        "works_without_key": True,
        "fields": [
            {"name": "mailto", "label": "Contact email", "secret": False, "required": False,
             "help": "OpenAlex gives faster service to requests that say who sent them."},
            {"name": "value", "label": "API key", "secret": True, "required": False,
             "help": "Optional. Raises your daily allowance."},
        ],
    },
    "semanticscholar": {
        "label": "Semantic Scholar",
        "about": "Your own Semantic Scholar key (optional): kept for lookups that use Semantic Scholar.",
        "works_without_key": True,
        "fields": [
            {"name": "value", "label": "API key", "secret": True, "required": True, "help": ""},
        ],
    },
}


class Invalid(ValueError):
    """What was sent cannot be saved. The message is for the person."""


# ---------------------------------------------------------------------------
# Whose request is this
# ---------------------------------------------------------------------------


class _Scope:
    """The person on whose behalf code is running, resolved lazily and once."""

    __slots__ = ("_make", "_person", "_done", "records", "policy_snapshot")

    def __init__(self, make: Callable[[], Any] | None = None, person: Any = None, *, done: bool = False):
        self._make = make
        self._person = person
        self._done = done or make is None
        self.records: dict[tuple[Any, str], Any] = {}
        #: Set for a scope handed to another thread, so that thread reads no database to resolve a key.
        self.policy_snapshot: dict[str, str] | None = None

    def person(self):
        if not self._done:
            try:
                self._person = self._make() if self._make else None
            except Exception:  # noqa: BLE001 - never let a lookup of "who" break a request
                logger.exception("acting person could not be resolved")
                self._person = None
            self._done = True
        return self._person


_SCOPE: contextvars.ContextVar[_Scope | None] = contextvars.ContextVar("acting_person", default=None)


def _saved_person(user: Any):
    """The user if it is a real, active, signed-in person; otherwise None."""
    if user is None or not getattr(user, "is_authenticated", False):
        return None
    if getattr(user, "pk", None) is None or getattr(user, "active", True) is False:
        return None
    return user


@contextmanager
def acting_as(user: Any) -> Iterator[None]:
    """Run the block on behalf of ``user`` (``None``: no person, the college key)."""
    token = _SCOPE.set(_Scope(person=_saved_person(user), done=True))
    try:
        yield
    finally:
        _SCOPE.reset(token)


@contextmanager
def acting_if_own(user: Any, provider: str) -> Iterator[None]:
    """Run as ``user`` if they brought their own key for this service; otherwise on the college's.

    For a college-wide job that touches one person's record at a time (the
    Scopus author sync): a person's own key spares the college's allowance,
    and a person without one is never left out because of the policy.
    """
    person = _saved_person(user)
    use = person if person is not None and own_in_use(provider, person) else None
    with acting_as(use):
        yield


@contextmanager
def request_scope(request: Any) -> Iterator[None]:
    """Whoever is signed in on this request, looked up only if something asks."""

    def make():
        user = getattr(request, "user", None)
        session = getattr(request, "session", None)
        # Viewing as somebody is for seeing: it must never spend their key.
        if session is not None and session.get("impersonator_id"):
            return None
        return _saved_person(user)

    token = _SCOPE.set(_Scope(make))
    try:
        yield
    finally:
        _SCOPE.reset(token)


class ActingPersonMiddleware:
    """Puts the signed-in person where the readers of keys can find them, and takes them away after."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        with request_scope(request):
            return self.get_response(request)


def in_scope() -> bool:
    """Whether something (a request, ``acting_as``) has already said whose work this is."""
    return _SCOPE.get() is not None


def current_person():
    scope = _SCOPE.get()
    return scope.person() if scope is not None else None


def _person_of(user: Any):
    return current_person() if user is AMBIENT else _saved_person(user)


def bind(fn: Callable[..., Any]) -> Callable[..., Any]:
    """``fn`` that, wherever it runs (another thread), acts as the person who called ``bind``."""
    scope = _SCOPE.get()
    if scope is None:
        return fn  # nothing said whose work this is, so the thread starts with nothing too
    person = scope.person()
    # Everything the thread needs to decide whose key to use is read here, on
    # this thread's database connection: a thread that opened its own would
    # leave it open, and in a test would not see the data at all.
    carried = _Scope(person=person, done=True)
    carried.policy_snapshot = policies()
    if person is not None:
        for group in USER_PROVIDERS:
            own_record(person, group)
        carried.records = dict(scope.records)

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        token = _SCOPE.set(carried)
        try:
            return fn(*args, **kwargs)
        finally:
            _SCOPE.reset(token)

    return wrapper


def scoped(user: Any, stream: Iterator[Any]) -> Iterator[Any]:
    """``stream`` (a streamed response body) with each step run as ``user``.

    A streamed body is read after the view returned, when the request's own
    scope is already gone, and possibly on another thread; so the person is
    set around every step rather than once around the whole.
    """
    it = iter(stream)
    while True:
        with acting_as(user):
            try:
                item = next(it)
            except StopIteration:
                return
        yield item


def scope_tag(group: str | None = None, user: Any = AMBIENT) -> str:
    """A short word for cache keys: empty on the college key, ``u<id>`` on a person's own.

    With a service named, only that service's key counts; without, any of them.
    """
    person = _person_of(user)
    if person is None:
        return ""
    groups = (group,) if group else USER_PROVIDERS
    if any(own_in_use(g, person) for g in groups):
        return f"u{person.pk}"
    return ""


def forget_scope() -> None:
    scope = _SCOPE.get()
    if scope is not None:
        scope.records.clear()


# ---------------------------------------------------------------------------
# Policy (the super admin's choice, per service)
# ---------------------------------------------------------------------------

_policy_memo: dict[str, Any] = {"at": 0.0, "rows": {}}


def _ttl() -> float:
    from core.services import integrations

    return integrations._ttl()


def invalidate_policy() -> None:
    _policy_memo["at"] = 0.0
    _policy_memo["rows"] = {}


def policies() -> dict[str, str]:
    scope = _SCOPE.get()
    if scope is not None and scope.policy_snapshot is not None:
        return scope.policy_snapshot
    ttl = _ttl()
    if ttl and _policy_memo["at"] and time.monotonic() - _policy_memo["at"] < ttl:
        rows = _policy_memo["rows"]
    else:
        from core.models import SystemSetting

        try:
            row = SystemSetting.objects.filter(key=POLICY_KEY).first()
            rows = row.value if row and isinstance(row.value, dict) else {}
        except Exception:  # noqa: BLE001 - before migrate: the default answers
            return {p: DEFAULT_POLICY for p in USER_PROVIDERS}
        if ttl:
            _policy_memo["at"], _policy_memo["rows"] = time.monotonic(), rows
    return {p: (rows.get(p) if rows.get(p) in POLICIES else DEFAULT_POLICY) for p in USER_PROVIDERS}


def policy(provider: str) -> str:
    return policies().get(GROUP_OF.get(provider, provider), DEFAULT_POLICY)


def set_policy(provider: str, value: str, actor: Any) -> str:
    from core.models import SystemSetting

    if provider not in USER_PROVIDERS:
        raise KeyError(provider)
    if value not in POLICIES:
        raise Invalid("Choose one of: everyone uses the college key, own key preferred, own key required.")
    if value == "own_required" and provider not in REQUIRABLE:
        raise Invalid("This service works without a key, so it cannot be made required.")
    row = SystemSetting.objects.filter(key=POLICY_KEY).first()
    data = dict(row.value) if row and isinstance(row.value, dict) else {}
    data[provider] = value
    SystemSetting.objects.update_or_create(key=POLICY_KEY, defaults={"value": data, "updated_by": actor})
    invalidate_policy()
    return value


# ---------------------------------------------------------------------------
# A person's record
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Own:
    """A person's saved key, decrypted for use. Never serialised."""

    pk: str
    provider: str
    key: str
    extra: dict[str, str]
    options: dict[str, Any]

    @property
    def kind(self) -> str:
        return self.options.get("kind") if self.options.get("kind") in AI_KINDS else "openai"

    def usable(self) -> bool:
        if self.provider == "openalex":
            return bool(self.key or self.options.get("mailto"))
        return bool(self.key)


def _decode(row) -> Own | None:
    from core.services import integrations

    key = ""
    if row.secret:
        plain = integrations.decrypt(row.secret)
        if plain is None:
            return None
        key = plain
    extra: dict[str, str] = {}
    if row.secret_extra:
        plain = integrations.decrypt(row.secret_extra)
        if plain is None:
            return None
        try:
            loaded = json.loads(plain)
            extra = {k: str(v) for k, v in loaded.items()} if isinstance(loaded, dict) else {}
        except ValueError:
            extra = {}
    options = row.options if isinstance(row.options, dict) else {}
    return Own(str(row.pk), row.provider, key, extra, options)


def own_record(person: Any, group: str) -> Own | None:
    """The person's usable key for this service, whatever the policy says."""
    if person is None or group not in USER_PROVIDERS:
        return None
    scope = _SCOPE.get()
    memo_key = (person.pk, group)
    if scope is not None and memo_key in scope.records:
        return scope.records[memo_key]
    from core.models import UserApiKey

    try:
        row = UserApiKey.objects.filter(user_id=person.pk, provider=group).first()
    except Exception:  # noqa: BLE001 - before migrate, or no database: no own key
        return None
    found = _decode(row) if row else None
    if found is not None and not found.usable():
        found = None
    if scope is not None:
        scope.records[memo_key] = found
    return found


def own_in_use(provider: str, user: Any = AMBIENT) -> bool:
    """Whether this person's own key is the one answering for this service right now."""
    group = GROUP_OF.get(provider, provider)
    person = _person_of(user)
    if person is None or policy(group) == "college":
        return False
    return own_record(person, group) is not None


def blocked(provider: str, user: Any = AMBIENT) -> bool:
    """Own key required, and this person has none."""
    group = GROUP_OF.get(provider, provider)
    person = _person_of(user)
    if person is None or group not in REQUIRABLE or policy(group) != "own_required":
        return False
    return own_record(person, group) is None


def blocked_message(provider: str) -> str:
    return BLOCKED_MESSAGE.get(GROUP_OF.get(provider, provider), BLOCKED_MESSAGE["ai"])


# ---------------------------------------------------------------------------
# What a person's record means for each setting the app reads
# ---------------------------------------------------------------------------

_HOST_OK: dict[str, tuple[float, bool]] = {}


def public_address_problem(url: str) -> str | None:
    """Why this is not an address the server may call on a person's behalf, or None.

    A person types the AI service's address, and the server then calls it, so
    an address that points inside the college's own network (or the cloud
    host's metadata service) would let them read what only the server can.
    Only https, only the standard port, no credentials in it, and the name
    must resolve to public addresses.
    """
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        port = parsed.port
    except ValueError:
        return "That is not a web address."
    if parsed.scheme != "https":
        return "The address must start with https://"
    if not host or parsed.username or parsed.password:
        return "That is not a web address that can be used."
    if port not in (None, 443):
        return "Use the standard https address, without a port number."
    if host in PRESET_HOSTS:
        return None
    now = time.monotonic()
    hit = _HOST_OK.get(host)
    if hit and hit[0] > now:
        return None if hit[1] else "That address is not a public web address."
    ok = True
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return "That address could not be found. Check it for typing mistakes."
    for info in infos:
        try:
            if not ipaddress.ip_address(info[4][0].split("%")[0]).is_global:
                ok = False
        except ValueError:
            ok = False
    _HOST_OK[host] = (now + 300, ok)
    return None if ok else "That address is not a public web address."


def default_model(base_url: str) -> str:
    return PRESET_HOSTS.get((urlparse(base_url).hostname or "").lower(), "")


def raw_value(rec: Own, name: str) -> str | None:
    """What this record says for an integration setting, or None to leave it to the college."""
    if rec.provider == "ai":
        base = str(rec.options.get("base_url") or "")
        model = str(rec.options.get("model") or "")
        if rec.kind == "anthropic":
            return {
                "ai.provider": "anthropic", "ai.api_key": "", "ai.base_url": "",
                "ai.model": model, "anthropic.api_key": rec.key,
            }.get(name)
        return {
            "ai.provider": "openai", "ai.api_key": rec.key,
            "ai.base_url": base if base and public_address_problem(base) is None else "",
            "ai.model": model or default_model(base), "anthropic.api_key": "",
        }.get(name)
    if rec.provider == "scopus":
        return {"scopus.api_key": rec.key, "scopus.inst_token": rec.extra.get("inst_token", "")}.get(name)
    if rec.provider == "openalex":
        if name == "openalex.api_key":
            return rec.key
        if name == "openalex.mailto":
            return str(rec.options.get("mailto") or "") or None
        return None
    if rec.provider == "semanticscholar" and name == "semanticscholar.api_key":
        return rec.key
    return None


def override(name: str, user: Any = AMBIENT) -> str | None:
    """The person's own value for a setting, ``""`` when blocked, or None to use the college's."""
    person = _person_of(user)
    if person is None:
        return None
    from core.services import integrations

    spec = integrations.SPECS.get(name)
    if spec is None:
        return None
    group = GROUP_OF.get(spec.provider)
    if group is None:
        return None
    mode = policy(group)
    if mode == "college":
        return None
    rec = own_record(person, group)
    if rec is None:
        return "" if mode == "own_required" and group in REQUIRABLE else None
    return raw_value(rec, name)


# ---------------------------------------------------------------------------
# Counting
# ---------------------------------------------------------------------------


def record_use(person: Any, group: str) -> None:
    """Count one call on this person's key. Never raises: counting must not break a call."""
    from core.models import UserApiKey

    if person is None:
        return
    try:
        with transaction.atomic():
            row = UserApiKey.objects.select_for_update().filter(user_id=person.pk, provider=group).first()
            if row is None:
                return
            now = timezone.localtime()
            day, month = now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")
            if row.usage_day != day:
                row.usage_day, row.day_calls = day, 0
            if row.usage_month != month:
                row.usage_month, row.month_calls = month, 0
            row.day_calls += 1
            row.month_calls += 1
            row.last_used_at = timezone.now()
            row.save(update_fields=["usage_day", "day_calls", "usage_month", "month_calls", "last_used_at"])
    except Exception:  # noqa: BLE001
        logger.debug("own-key usage not recorded for %s", group, exc_info=True)


def record_call(provider: str, user: Any = AMBIENT) -> bool:
    """Count a call against the person's key if it is the one in use. True if it was theirs."""
    group = GROUP_OF.get(provider, provider)
    if not own_in_use(group, user):
        return False
    record_use(_person_of(user), group)
    return True


# ---------------------------------------------------------------------------
# Saving, clearing, showing
# ---------------------------------------------------------------------------


def _clean_secret(value: str, what: str = "key") -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) > 600:
        raise Invalid("That is too long to be right.")
    if any(ch.isspace() for ch in value):
        raise Invalid(f"A {what} has no spaces in it. Check what was pasted.")
    if len(value) < 8:
        raise Invalid(f"That is too short to be a {what}.")
    return value


def save(user: Any, provider: str, data: dict[str, Any]) -> Any:
    """Add or replace a person's key. A blank secret keeps the one already saved."""
    from core.models import UserApiKey
    from core.services import integrations

    if provider not in USER_PROVIDERS:
        raise KeyError(provider)
    row = UserApiKey.objects.filter(user=user, provider=provider).first()
    current = _decode(row) if row else None

    def text(name: str) -> str:
        return str(data.get(name) or "").strip()

    secret = _clean_secret(data.get("value", ""))
    options: dict[str, Any] = dict(row.options) if row and isinstance(row.options, dict) else {}
    extra: dict[str, str] = dict(current.extra) if current else {}
    keep_secret = current.key if current else ""

    if provider == "ai":
        kind = text("kind").lower() or options.get("kind") or "openai"
        if kind not in AI_KINDS:
            raise Invalid("Choose OpenAI-compatible or Claude (Anthropic).")
        base = text("base_url").rstrip("/") if "base_url" in data else str(options.get("base_url") or "")
        model = text("model") if "model" in data else str(options.get("model") or "")
        if len(model) > 120 or len(base) > 300:
            raise Invalid("That is too long to be right.")
        if kind == "openai":
            if not base:
                raise Invalid("Add the service address, for example https://api.groq.com/openai/v1")
            problem = public_address_problem(base)
            if problem:
                raise Invalid(problem)
            if not model and not default_model(base):
                raise Invalid("Add the model name this service should use.")
        else:
            base = ""
        options = {"kind": kind, "base_url": base, "model": model}
    elif provider == "openalex":
        mailto = text("mailto") if "mailto" in data else str(options.get("mailto") or "")
        if mailto and ("@" not in mailto or "." not in mailto.rsplit("@", 1)[-1] or len(mailto) > 200 or " " in mailto):
            raise Invalid("That does not look like an email address.")
        options = {"mailto": mailto}
    elif provider == "scopus":
        token = _clean_secret(data.get("inst_token", ""), "token")
        if token:
            extra["inst_token"] = token

    final = secret or keep_secret
    if provider == "openalex":
        if not final and not options.get("mailto"):
            raise Invalid("Add an email address or an API key.")
    elif not final:
        raise Invalid("Paste your key to save it.")

    values: dict[str, Any] = {
        "secret": integrations.encrypt(final) if final else "",
        "secret_extra": integrations.encrypt(json.dumps(extra)) if extra else "",
        "options": options,
    }
    if "label" in data:
        values["label"] = text("label")[:80]
    if row is None:
        row = UserApiKey.objects.create(user=user, provider=provider, **values)
    else:
        for field, value in values.items():
            setattr(row, field, value)
        if secret or (provider == "scopus" and data.get("inst_token")):
            row.last_test_at, row.last_test_ok, row.last_test_message = None, None, ""
        row.save()
    forget_scope()
    _forget_ai_probes()
    return row


def clear(user: Any, provider: str) -> bool:
    from core.models import UserApiKey

    if provider not in USER_PROVIDERS:
        raise KeyError(provider)
    deleted, _ = UserApiKey.objects.filter(user=user, provider=provider).delete()
    forget_scope()
    _forget_ai_probes()
    return bool(deleted)


def _forget_ai_probes() -> None:
    try:
        from core.services import ai

        with ai._PROBES_LOCK:
            ai._PROBES.clear()
    except Exception:  # noqa: BLE001
        pass


def _college_configured(provider: str) -> bool:
    """Whether the college's own setting would answer for this service."""
    from core.services import integrations

    def has(name: str) -> bool:
        return bool(integrations.get(name, user=None))

    if provider == "ai":
        from core.services import ai

        with acting_as(None):
            return ai.provider_name() not in ("none", "") and (
                has("ai.api_key") or has("anthropic.api_key") or ai.provider_name() in ("harness", "ollama")
            )
    if provider == "scopus":
        return has("scopus.api_key")
    if provider == "openalex":
        return True
    return has("semanticscholar.api_key")


def _usage_of(row: Any) -> dict[str, int]:
    now = timezone.localtime()
    day, month = now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")
    return {
        "today": int(row.day_calls) if row.usage_day == day else 0,
        "month": int(row.month_calls) if row.usage_month == month else 0,
    }


def provider_state(user: Any, provider: str, row: Any = None, *, loaded: bool = False) -> dict[str, Any]:
    """Everything the My API keys screen shows for one service. No secret leaves here."""
    from core.models import UserApiKey
    from core.services import integrations

    meta = META[provider]
    if not loaded:
        row = UserApiKey.objects.filter(user=user, provider=provider).first()
    rec = _decode(row) if row else None
    mode = policy(provider)
    readable = rec is not None
    has_key = bool(row) and readable and rec.usable()
    if mode == "college":
        source = "college" if _college_configured(provider) else "none"
    elif has_key:
        source = "yours"
    elif mode == "own_required":
        source = "none"
    elif _college_configured(provider):
        source = "college"
    else:
        source = "none"
    options = (rec.options if rec else {}) or {}
    shown: dict[str, Any] = {}
    if provider == "ai":
        shown = {"kind": rec.kind if rec else "openai", "base_url": options.get("base_url", ""), "model": options.get("model", "")}
    elif provider == "openalex":
        shown = {"mailto": options.get("mailto", "")}
    out: dict[str, Any] = {
        "provider": provider,
        "label": meta["label"],
        "about": meta["about"],
        "works_without_key": meta["works_without_key"],
        "fields": meta["fields"],
        "policy": mode,
        "has_own_key": has_key,
        "masked": integrations.mask(rec.key) if has_key and rec.key else "",
        "has_inst_token": bool(rec and rec.extra.get("inst_token")),
        "values": shown,
        "key_label": row.label if row else "",
        "source": source,
        "ignored": bool(has_key and mode == "college"),
        "usage": _usage_of(row) if row else {"today": 0, "month": 0},
        "last_used_at": row.last_used_at.isoformat() if row and row.last_used_at else None,
        "last_test": None,
        "problem": "" if (row is None or readable) else "The saved key can no longer be read on this server. Add it again.",
    }
    if row and row.last_test_at:
        out["last_test"] = {"at": row.last_test_at.isoformat(), "ok": row.last_test_ok, "message": row.last_test_message}
    if mode == "own_required" and not has_key:
        out["blocked_message"] = BLOCKED_MESSAGE.get(provider, "")
    return out


def states_for(user: Any) -> list[dict[str, Any]]:
    from core.models import UserApiKey

    rows = {r.provider: r for r in UserApiKey.objects.filter(user=user)}
    return [provider_state(user, p, rows.get(p), loaded=True) for p in USER_PROVIDERS]


def overview() -> dict[str, Any]:
    """For the super admin: who has brought a key, and how much they used. Never a value."""
    from core.models import UserApiKey

    chosen = policies()
    rows = list(UserApiKey.objects.select_related("user").order_by("-month_calls", "user__name"))
    out = []
    for provider in USER_PROVIDERS:
        mine = [r for r in rows if r.provider == provider]
        people = []
        for r in mine:
            use = _usage_of(r)
            people.append({
                "user_id": r.user_id,
                "name": r.user.name,
                "department": r.user.department or "",
                "calls_today": use["today"],
                "calls_month": use["month"],
                "last_used_at": r.last_used_at.isoformat() if r.last_used_at else None,
            })
        out.append({
            "provider": provider,
            "label": META[provider]["label"],
            "policy": chosen[provider],
            "can_require": provider in REQUIRABLE,
            "people_with_own_key": len(people),
            "calls_today": sum(p["calls_today"] for p in people),
            "calls_month": sum(p["calls_month"] for p in people),
            "people": people[:200],
        })
    return {"providers": out}


# ---------------------------------------------------------------------------
# Testing a saved key
# ---------------------------------------------------------------------------


def run_test(user: Any, provider: str) -> dict[str, Any]:
    """One cheap real call on the person's saved key. Records the answer on the row."""
    from core.models import UserApiKey
    from core.services import integration_checks

    row = UserApiKey.objects.filter(user=user, provider=provider).first()
    rec = _decode(row) if row else None
    if row is None:
        raise LookupError("There is no key saved to test.")
    if rec is None:
        result = {"ok": False, "latency_ms": 0, "message": "The saved key can no longer be read on this server. Add it again."}
    else:
        result = integration_checks.run_with(
            provider,
            get=lambda name: raw_value(rec, name) or "",
            count=lambda _name, _headers=None: record_use(user, provider),
        )
    row.last_test_at = timezone.now()
    row.last_test_ok = bool(result["ok"])
    row.last_test_message = str(result["message"])[:300]
    row.save(update_fields=["last_test_at", "last_test_ok", "last_test_message"])
    return result


__all__ = [
    "AMBIENT", "ActingPersonMiddleware", "Invalid", "POLICIES", "USER_PROVIDERS",
    "acting_as", "bind", "blocked", "clear", "current_person", "override", "overview",
    "own_in_use", "policy", "record_call", "run_test", "save", "set_policy", "states_for",
]
