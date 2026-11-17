"""The keys and addresses the app talks to other services with, settable in the app.

Until now the AI key, the Elsevier/Scopus key and the OpenAlex settings lived
only in the host's environment, so changing one meant a redeploy. This module
is the one place that answers "what is the value of X", and every reader of
those settings goes through ``get``:

    value set in the app  >  environment variable (``settings``)  >  empty

Nothing here needs a migration. A value is one row of the existing
``SystemSetting`` key/value table, under ``integration.<name>``. A secret is
encrypted before it is written (Fernet) and the row never holds plaintext; the
key for that comes from ``INTEGRATIONS_KEY``, or, when that is not set, is
derived from ``DJANGO_SECRET_KEY`` with HKDF. Losing the key makes the saved
secrets unreadable, which is reported as "set it again" and falls back to the
environment rather than failing a request.

Usage counts live here too, in ``integration_usage.<provider>`` rows (calls
today, calls this month, the last connection test, and for Scopus the last
quota headers seen). The AI figures are counted from ``AIUsage`` instead,
which already records every model call.
"""

from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from django.conf import settings
from django.db import transaction
from django.utils import timezone

logger = logging.getLogger("core.integrations")

PREFIX = "integration."
USAGE_PREFIX = "integration_usage."


@dataclass(frozen=True)
class Spec:
    provider: str
    label: str
    #: Name of the Django setting the environment variable lands in.
    setting: str
    secret: bool
    help: str = ""


SPECS: dict[str, Spec] = {
    "ai.provider": Spec("ai", "Provider", "AI_PROVIDER", False,
                        "openai, anthropic, harness, ollama or none. Leave empty to let the key decide."),
    "ai.model": Spec("ai", "Model", "AI_MODEL", False, "The model id as the service spells it."),
    "ai.base_url": Spec("ai", "Base URL", "AI_BASE_URL", False, "For example https://api.groq.com/openai/v1"),
    "ai.api_key": Spec("ai", "API key", "AI_API_KEY", True),
    "anthropic.api_key": Spec("anthropic", "API key", "ANTHROPIC_API_KEY", True),
    "scopus.api_key": Spec("scopus", "API key", "SCOPUS_API_KEY", True),
    "scopus.inst_token": Spec("scopus", "Institution token", "SCOPUS_INST_TOKEN", True,
                              "Optional. Needed only when Elsevier gave the college one."),
    "openalex.mailto": Spec("openalex", "Contact email", "SEARCH_CONTACT_EMAIL", False,
                            "Sent to OpenAlex and Crossref so they route us to the faster, polite pool."),
    "openalex.api_key": Spec("openalex", "API key", "OPENALEX_API_KEY", True, "Optional. Raises the daily allowance."),
}

PROVIDERS: dict[str, dict[str, Any]] = {
    "ai": {
        "label": "AI service",
        "about": "Any OpenAI-compatible service (Groq, Gemini, OpenRouter and so on).",
        "primary": "ai.api_key",
    },
    "anthropic": {
        "label": "Claude (Anthropic)",
        "about": "Used by the research scout and when Claude is the chosen provider.",
        "primary": "anthropic.api_key",
    },
    "scopus": {
        "label": "Scopus (Elsevier)",
        "about": "Paper lookups, journal quartiles and the monthly author sync.",
        "primary": "scopus.api_key",
    },
    "openalex": {
        "label": "OpenAlex",
        "about": "Citation counts and paper lookups. Works without a key.",
        "primary": "openalex.api_key",
    },
}


def names_of(provider: str) -> list[str]:
    return [n for n, s in SPECS.items() if s.provider == provider]


# ---------------------------------------------------------------------------
# Encryption at rest
# ---------------------------------------------------------------------------


def _fernet() -> Fernet:
    material = (getattr(settings, "INTEGRATIONS_KEY", "") or "").strip() or settings.SECRET_KEY
    key = HKDF(
        algorithm=hashes.SHA256(), length=32, salt=None,
        info=b"faculty-paper/integrations/v1",
    ).derive(material.encode())
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt(stored: str) -> str | None:
    """The plaintext, or None when the token is not readable with today's key."""
    try:
        return _fernet().decrypt(stored.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# The accessor
# ---------------------------------------------------------------------------

#: name -> stored value dict, loaded in one query and held for a few seconds.
#: Zero while tests run, so a rolled-back test never leaks into the next.
_memo: dict[str, Any] = {"at": 0.0, "rows": {}}


def _ttl() -> float:
    return float(getattr(settings, "INTEGRATIONS_CACHE_SECONDS", 5) or 0)


def invalidate() -> None:
    _memo["at"] = 0.0
    _memo["rows"] = {}


def _rows() -> dict[str, dict[str, Any]]:
    ttl = _ttl()
    if ttl and _memo["at"] and time.monotonic() - _memo["at"] < ttl:
        return _memo["rows"]
    from core.models import SystemSetting

    try:
        rows = {
            row.key[len(PREFIX):]: row.value
            for row in SystemSetting.objects.filter(key__startswith=PREFIX)
            if isinstance(row.value, dict)
        }
    except Exception:  # noqa: BLE001 - before migrate, or the database is away (or a test forbids it): the environment still answers
        return {}
    if ttl:
        _memo["at"], _memo["rows"] = time.monotonic(), rows
    return rows


def _from_app(name: str) -> tuple[str, bool]:
    """(value, unreadable). Unreadable: a secret saved under a key we no longer have."""
    stored = _rows().get(name)
    if not stored:
        return "", False
    raw = stored.get("v")
    if not isinstance(raw, str) or not raw:
        return "", False
    if stored.get("enc"):
        plain = decrypt(raw)
        if plain is None:
            return "", True
        return plain.strip(), False
    return raw.strip(), False


def _from_env(name: str) -> str:
    return (getattr(settings, SPECS[name].setting, "") or "").strip()


def resolve(name: str) -> tuple[str, str, bool]:
    """(value, source, unreadable) where source is "app", "environment" or "none"."""
    if name not in SPECS:
        raise KeyError(f"unknown integration setting {name!r}")
    app, unreadable = _from_app(name)
    if app:
        return app, "app", False
    env = _from_env(name)
    if env:
        return env, "environment", unreadable
    return "", "none", unreadable


def get(name: str) -> str:
    """The value in force: set in the app, else the environment, else empty."""
    return resolve(name)[0]


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


class Invalid(ValueError):
    pass


def clean(name: str, value: str) -> str:
    if name not in SPECS:
        raise KeyError(name)
    spec = SPECS[name]
    value = (value or "").strip()
    if not value:
        return ""
    if len(value) > 600:
        raise Invalid("That is too long to be right.")
    if any(ch.isspace() for ch in value) and name != "ai.model":
        raise Invalid("This value has no spaces in it. Check what was pasted.")
    if name == "ai.provider":
        from core.services import ai

        value = value.lower()
        if value not in ai.PROVIDERS:
            raise Invalid(f"Choose one of: {', '.join(ai.PROVIDERS)}.")
    elif name == "ai.base_url":
        if not value.lower().startswith(("https://", "http://")):
            raise Invalid("The address starts with https://")
        value = value.rstrip("/")
    elif name == "openalex.mailto":
        if "@" not in value or "." not in value.rsplit("@", 1)[-1]:
            raise Invalid("That does not look like an email address.")
    elif spec.secret and len(value) < 8:
        raise Invalid("That is too short to be a key.")
    return value


def set_value(name: str, value: str, actor) -> str:
    """Save (or, when empty, clear) the app's value. Returns "set" or "cleared"."""
    from core.models import SystemSetting

    value = clean(name, value)
    key = PREFIX + name
    if not value:
        SystemSetting.objects.filter(key=key).delete()
        outcome = "cleared"
    else:
        spec = SPECS[name]
        stored = {"v": encrypt(value), "enc": 1} if spec.secret else {"v": value}
        SystemSetting.objects.update_or_create(key=key, defaults={"value": stored, "updated_by": actor})
        outcome = "set"
    invalidate()
    _forget_probes()
    return outcome


def _forget_probes() -> None:
    """The AI health answer is remembered for a few seconds; a new key must not wait for it."""
    try:
        from core.services import ai

        with ai._PROBES_LOCK:
            ai._PROBES.clear()
    except Exception:  # noqa: BLE001 - a nicety, never a reason to fail a save
        pass


# ---------------------------------------------------------------------------
# What a screen may show
# ---------------------------------------------------------------------------


def mask(value: str) -> str:
    """Dots and the last four characters; just dots when four would give too much away."""
    if not value:
        return ""
    if len(value) < 12:
        return "••••"
    return "••••" + value[-4:]


def field_state(name: str) -> dict[str, Any]:
    spec = SPECS[name]
    value, source, unreadable = resolve(name)
    out: dict[str, Any] = {
        "name": name,
        "label": spec.label,
        "help": spec.help,
        "secret": spec.secret,
        "configured": bool(value),
        "source": source,
        # A secret is only ever shown as its last four characters. The rest
        # (a model id, an address) is not secret and is shown whole.
        "masked": mask(value) if spec.secret else "",
        "value": "" if spec.secret else value,
    }
    if unreadable:
        out["problem"] = "The saved value can no longer be read on this server. Set it again."
    return out


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------


def _usage_key(provider: str) -> str:
    return USAGE_PREFIX + provider


def _stamp() -> tuple[str, str]:
    now = timezone.localtime()
    return now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")


def _update_usage(provider: str, change) -> None:
    """Read-modify-write one usage row. Never raises: counting must not break a call."""
    from core.models import SystemSetting

    try:
        with transaction.atomic():
            row, _ = SystemSetting.objects.select_for_update().get_or_create(
                key=_usage_key(provider), defaults={"value": {}}
            )
            data = row.value if isinstance(row.value, dict) else {}
            day, month = _stamp()
            if data.get("day") != day:
                data["day"], data["day_calls"] = day, 0
            if data.get("month") != month:
                data["month"], data["month_calls"] = month, 0
            change(data)
            row.value = data
            row.save(update_fields=["value", "updated_at"])
    except Exception:  # noqa: BLE001
        logger.debug("usage not recorded for %s", provider, exc_info=True)


def record_call(provider: str, *, headers: Any = None) -> None:
    """Count one outbound call, and note Scopus's quota headers when it sent them."""

    def change(data: dict[str, Any]) -> None:
        data["day_calls"] = int(data.get("day_calls", 0)) + 1
        data["month_calls"] = int(data.get("month_calls", 0)) + 1
        if provider == "scopus" and headers is not None:
            rate = _scopus_rate(headers)
            if rate:
                data["rate"] = rate

    _update_usage(provider, change)


def _scopus_rate(headers: Any) -> dict[str, Any] | None:
    def num(name: str) -> int | None:
        try:
            return int(str(headers.get(name)).strip())
        except (AttributeError, TypeError, ValueError):
            return None

    remaining, limit, reset = num("X-RateLimit-Remaining"), num("X-RateLimit-Limit"), num("X-RateLimit-Reset")
    if remaining is None and limit is None and reset is None:
        return None
    return {"remaining": remaining, "limit": limit, "reset": reset, "seen_at": timezone.now().isoformat()}


def record_test(provider: str, ok: bool, message: str) -> None:
    def change(data: dict[str, Any]) -> None:
        data["tested_at"] = timezone.now().isoformat()
        data["test_ok"] = bool(ok)
        data["test_message"] = message[:300]

    _update_usage(provider, change)


def _usage_row(provider: str) -> dict[str, Any]:
    from core.models import SystemSetting

    row = SystemSetting.objects.filter(key=_usage_key(provider)).first()
    return row.value if row and isinstance(row.value, dict) else {}


def _ai_usage() -> dict[str, int]:
    from core.models import AIUsage
    from core.services.ai_harness import _BILLABLE, _day_start, _month_start

    rows = AIUsage.objects.filter(outcome__in=_BILLABLE)
    return {
        "today": rows.filter(created_at__gte=_day_start()).count(),
        "month": rows.filter(created_at__gte=_month_start()).count(),
    }


def provider_state(provider: str) -> dict[str, Any]:
    from core.services import ai

    meta = PROVIDERS[provider]
    primary = field_state(meta["primary"])
    row = _usage_row(provider)
    day, month = _stamp()
    if provider in ("ai", "anthropic"):
        # The model-call ledger counts every call, whichever key made it. Show it
        # on the row of the provider that is actually answering.
        answering = {"openai": "ai", "anthropic": "anthropic"}.get(ai.provider_name())
        usage = _ai_usage() if answering == provider else {"today": 0, "month": 0}
    else:
        usage = {
            "today": int(row.get("day_calls", 0)) if row.get("day") == day else 0,
            "month": int(row.get("month_calls", 0)) if row.get("month") == month else 0,
        }
    rate = row.get("rate") if provider == "scopus" and isinstance(row.get("rate"), dict) else None
    return {
        "provider": provider,
        "label": meta["label"],
        "about": meta["about"],
        "configured": primary["configured"],
        "source": primary["source"],
        "masked": primary["masked"],
        "last_tested_at": row.get("tested_at"),
        "last_test_ok": row.get("test_ok"),
        "last_test_message": row.get("test_message", ""),
        "usage": usage,
        "rate_limit": rate,
        "fields": [field_state(n) for n in names_of(provider)],
    }


def all_states() -> list[dict[str, Any]]:
    return [provider_state(p) for p in PROVIDERS]
