"""A hosted model, over the OpenAI-compatible chat-completions API.

Why this exists. The college deploys to Render's free plan: 512 MB of memory
and a tenth of a CPU. No model worth asking fits on that, and neither the
laptop provider (``ollama``) nor the college's own GPU service (``harness``)
is reachable from it -- so on the live site every AI feature said a daemon on
127.0.0.1 was not answering, which was true and useless. This provider lets
the same features run on a hosted model named by three environment
variables:

    AI_BASE_URL   https://api.groq.com/openai/v1
                  https://generativelanguage.googleapis.com/v1beta/openai
                  https://openrouter.ai/api/v1
                  http://some-other-machine:11434/v1   (a remote Ollama)
    AI_API_KEY    the service's key, sent as a bearer token
    AI_MODEL      the model id as that service spells it

``AI_FAST_MODEL`` optionally names a second, quicker model for the one
interactive caller; without it the one model serves both tiers.

**What this changes about privacy, said plainly.** With this provider a
faculty member's draft title and abstract, and their publication history, are
sent to whichever service ``AI_BASE_URL`` names. The other two providers keep
that text on hardware the college runs. That trade was the owner's call for a
free deployment; the screens say where suggestions come from (``host`` in the
health answer) rather than repeating the "nothing leaves this machine" line
that was true of the laptop.

The module mirrors ``ollama.py`` and ``harness.py`` surface for surface --
``generate``, ``stream``, ``Stopped``, an error with ``kind``/``message``, a
``Health`` with the same fields, the same tier resolution -- so ``ai.py``
dispatches to it on one line and every endpoint keeps its failure vocabulary.
The same insistences apply: every call is bounded, a missing model is a
configuration fact with the sentence that fixes it, and nothing here falls
back to another provider. Two more that are specific to a hosted service:

- **The key is never repeated.** Not in an error, not in a health answer, not
  in a log line. A service that echoes the key back in its error body has
  that body scrubbed before anybody sees it.
- **The model list is not asked for on every page.** A health answer is kept
  for a few minutes (a failure for a few seconds), because every AI screen
  asks before it offers, and a round trip to another continent per page view
  is both slow and a spend against the free tier's request allowance.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterator
from urllib.parse import urlparse

from django.conf import settings

logger = logging.getLogger(__name__)

#: A ceiling, not an expectation. A hosted model answers a nine-journal
#: question in a few seconds; the bound is for a service that has stalled.
DEFAULT_TIMEOUT = int(os.getenv("AI_TIMEOUT_SECONDS", "60"))

#: The model list answers in well under a second when the service is up.
HEALTH_TIMEOUT = 5

#: How long a health answer is reused. A good one for five minutes, a bad
#: one for fifteen seconds: long enough that a page of three AI panels asks
#: once, short enough that a fixed outage is noticed on the next reload.
HEALTH_TTL_OK = 300
HEALTH_TTL_FAILED = 15

#: Said to the model on every JSON request. The word "JSON" is load-bearing:
#: OpenAI-style JSON mode refuses a conversation that never mentions it.
_JSON_INSTRUCTION = "Reply with a single JSON value and nothing else: no prose, no code fences."


class OpenAIError(Exception):
    """Inference did not happen, with a reason worth showing somebody.

    Same ``kind`` words as the other two providers, plus two that only a
    hosted service has: ``rejected`` (the key was refused) and
    ``rate_limited`` (the free allowance is spent for now).
    """

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


class Stopped(Exception):
    """The consumer asked for the stream to end. Not a failure."""


@dataclass(frozen=True)
class Health:
    """What is true about the hosted service right now.

    The same fields as the other providers' ``Health``, plus ``failure``:
    the kind of error that made ``up`` false, because "the key was refused"
    and "nothing answered" are fixed by different people.
    """

    up: bool
    model_present: bool
    model: str
    base_url: str
    version: str | None = None
    models: tuple[str, ...] = ()
    detail: str | None = None
    fast_model: str = ""
    fast_model_present: bool = False
    fast_detail: str | None = None
    failure: str | None = None

    @property
    def ready(self) -> bool:
        return self.up and self.model_present

    @property
    def fast_ready(self) -> bool:
        return self.up and self.fast_model_present

    def as_dict(self) -> dict[str, Any]:
        return {
            "up": self.up,
            "model_present": self.model_present,
            "ready": self.ready,
            "model": self.model,
            "base_url": self.base_url,
            "version": self.version,
            "models": list(self.models),
            "detail": self.detail,
            "fast_model": self.fast_model,
            "fast_model_present": self.fast_model_present,
            "fast_ready": self.fast_ready,
            "fast_detail": self.fast_detail,
        }


# --------------------------------------------------------------------------- #
# Configuration                                                               #
# --------------------------------------------------------------------------- #


def base_url() -> str:
    return (getattr(settings, "AI_BASE_URL", "") or "").strip().rstrip("/")


def api_key() -> str:
    return (getattr(settings, "AI_API_KEY", "") or "").strip()


def model_name() -> str:
    return (getattr(settings, "AI_MODEL", "") or "").strip()


def fast_model_name() -> str:
    """The quicker model, or the one model when no second one is named."""
    return (getattr(settings, "AI_FAST_MODEL", "") or "").strip() or model_name()


def resolve_model(fast: bool = False) -> str:
    return fast_model_name() if fast else model_name()


def host() -> str:
    """The service's host name, for saying on screen where text is sent."""
    return urlparse(base_url()).hostname or ""


def missing_settings() -> list[str]:
    """The variables a key needs beside it, and which of them are unset."""
    return [
        name
        for name, value in (
            ("AI_API_KEY", api_key()),
            ("AI_BASE_URL", base_url()),
            ("AI_MODEL", model_name()),
        )
        if not value
    ]


# --------------------------------------------------------------------------- #
# Transport                                                                   #
# --------------------------------------------------------------------------- #


def _scrub(text: str) -> str:
    """A service's error text with the key taken out, and kept short."""
    key = api_key()
    if key:
        text = text.replace(key, "[key]")
    return text.strip()[:300]


def _error_text(body: str) -> str:
    try:
        data = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return _scrub(body or "")
    err = data.get("error") if isinstance(data, dict) else None
    if isinstance(err, dict):
        return _scrub(str(err.get("message") or ""))
    if isinstance(data, list) and data and isinstance(data[0], dict):
        # Google's compatibility layer sometimes answers a list of errors.
        inner = data[0].get("error") or {}
        return _scrub(str(inner.get("message") or ""))
    return _scrub(str(err or ""))


def _headers() -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key()}",
    }


def _request(path: str, payload: dict | None = None, *, timeout: int, model: str | None = None):
    url = f"{base_url()}{path}"
    if payload is None:
        req = urllib.request.Request(url, method="GET", headers=_headers())
    else:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), headers=_headers(), method="POST"
        )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="ignore")
        except Exception:  # noqa: BLE001 - the body is a nicety, not the error
            pass
        said = _error_text(body)
        if exc.code in (401, 403):
            raise OpenAIError(
                "rejected",
                f"{host() or 'The AI service'} refused the API key. Check AI_API_KEY.",
            ) from exc
        if exc.code == 429:
            headers = exc.headers or {}
            wait = headers.get("retry-after") or headers.get("Retry-After")
            raise OpenAIError(
                "rate_limited",
                "The AI service is busy, or this key's free allowance is used up for now. "
                + (f"Try again in {wait} seconds." if wait else "Try again in a minute."),
            ) from exc
        if exc.code == 404 and payload is not None:
            wanted = model or model_name()
            raise OpenAIError(
                "model_missing",
                f"{host() or 'The AI service'} does not offer the model {wanted!r}. "
                "Set AI_MODEL to a model it lists.",
            ) from exc
        if exc.code == 400:
            raise OpenAIError("bad_request", said or "The AI service refused the request.") from exc
        raise OpenAIError(
            "service_error", f"The AI service answered {exc.code}." + (f" {said}" if said else "")
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(exc, TimeoutError) or "timed out" in str(reason).lower():
            raise OpenAIError("timeout", "The AI service took too long to answer and was stopped.") from exc
        raise OpenAIError("unreachable", f"Nothing is answering at {host() or base_url()}.") from exc


# --------------------------------------------------------------------------- #
# Health                                                                      #
# --------------------------------------------------------------------------- #

_HEALTH: dict[tuple, tuple[float, Health]] = {}
_HEALTH_LOCK = threading.Lock()


def forget_health() -> None:
    """Drop the remembered answer, so the next `health()` asks again."""
    with _HEALTH_LOCK:
        _HEALTH.clear()


def _bare(model_id: str) -> str:
    """"models/gemini-3.5-flash" and "gemini-3.5-flash" are one model."""
    text = (model_id or "").strip()
    return text[len("models/"):] if text.startswith("models/") else text


def health(*, timeout: int = HEALTH_TIMEOUT) -> Health:
    """Is the service answering this key, and does it offer both models?

    Asked of the service's own model list, which every compatible API has at
    ``GET /models`` and which costs no generation. A service whose list is
    empty is trusted to have the model -- some proxies list nothing -- rather
    than being reported as missing a model it may well serve.
    """
    want, want_fast, url = model_name(), fast_model_name(), base_url()
    # The key's length and ends, not the key: enough that rotating it asks
    # again, not enough to be worth reading out of a memory dump.
    key = api_key()
    fingerprint = (len(key), key[:3], key[-3:])
    cache_key = (url, want, want_fast, fingerprint)
    now = time.monotonic()
    with _HEALTH_LOCK:
        hit = _HEALTH.get(cache_key)
    if hit and hit[0] > now:
        return hit[1]

    state = _probe(want, want_fast, url, timeout)
    ttl = HEALTH_TTL_OK if state.up else HEALTH_TTL_FAILED
    with _HEALTH_LOCK:
        _HEALTH[cache_key] = (now + ttl, state)
    return state


def _probe(want: str, want_fast: str, url: str, timeout: int) -> Health:
    try:
        data = json.load(_request("/models", timeout=timeout))
    except OpenAIError as exc:
        return Health(
            up=False, model_present=False, model=want, base_url=url, detail=exc.message,
            fast_model=want_fast, fast_model_present=False, fast_detail=exc.message,
            failure=exc.kind,
        )
    except (json.JSONDecodeError, ValueError) as exc:
        detail = "The AI service answered, but not with a model list. Check AI_BASE_URL."
        logger.warning("openai_compat_health_unreadable host=%s err=%s", host(), exc)
        return Health(
            up=False, model_present=False, model=want, base_url=url, detail=detail,
            fast_model=want_fast, fast_model_present=False, fast_detail=detail,
            failure="service_error",
        )

    rows = data.get("data") if isinstance(data, dict) else data
    names = tuple(
        _bare(str(r.get("id") or r.get("name") or ""))
        for r in (rows or [])
        if isinstance(r, dict)
    )
    listed = set(names)
    present = not listed or _bare(want) in listed
    fast_present = not listed or _bare(want_fast) in listed
    return Health(
        up=True,
        model_present=present,
        model=want,
        base_url=url,
        models=names[:50],
        detail=None if present else f"{host()} does not list {want!r}.",
        fast_model=want_fast,
        fast_model_present=fast_present,
        fast_detail=None if fast_present else f"{host()} does not list {want_fast!r}.",
    )


# --------------------------------------------------------------------------- #
# Generation                                                                  #
# --------------------------------------------------------------------------- #


def _messages(prompt: str, system: str | None, fmt: str | dict | None) -> list[dict[str, str]]:
    parts = [system] if system else []
    if fmt:
        parts.append(_JSON_INSTRUCTION)
        if isinstance(fmt, dict):
            # Described rather than enforced. Strict schema modes differ per
            # service and several refuse to stream with one; the caller's own
            # checks and the JSON repair in `ai.py` are the enforcement.
            parts.append("It must match this JSON Schema: " + json.dumps(fmt, separators=(",", ":")))
    out = [{"role": "system", "content": " ".join(parts)}] if parts else []
    out.append({"role": "user", "content": prompt})
    return out


def _refuses_json_mode(exc: OpenAIError) -> bool:
    text = exc.message.lower()
    return exc.kind == "bad_request" and ("response_format" in text or "json" in text)


def generate(
    prompt: str,
    *,
    system: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    max_tokens: int = 512,
    temperature: float = 0.2,
    fmt: str | dict | None = None,
    fast: bool = False,
) -> str:
    """One prompt in, the whole answer out.

    With ``fmt`` set, JSON mode is asked for. Not every model behind every
    compatible API supports it, and the ones that do not answer 400 -- so a
    refusal that names the response format is asked once more without it,
    leaning on the instruction in the system message and the JSON repair in
    ``ai.py``. Any other 400 is reported as it came.
    """
    model = resolve_model(fast)
    payload: dict[str, Any] = {
        "model": model,
        "messages": _messages(prompt, system, fmt),
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if fmt:
        payload["response_format"] = {"type": "json_object"}
    try:
        data = json.load(_request("/chat/completions", payload, timeout=timeout, model=model))
    except OpenAIError as exc:
        if not (fmt and _refuses_json_mode(exc)):
            raise
        logger.info("openai_compat_json_mode_refused host=%s model=%s", host(), model)
        payload.pop("response_format", None)
        data = json.load(_request("/chat/completions", payload, timeout=timeout, model=model))
    return _content_of(data)


def _content_of(data: Any) -> str:
    try:
        message = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise OpenAIError("bad_output", "The AI service answered in an unexpected shape.") from None
    return str(message.get("content") or "").strip()


def stream(
    prompt: str,
    *,
    system: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    max_tokens: int = 512,
    temperature: float = 0.2,
    fmt: str | dict | None = None,
    should_stop: Callable[[], bool] | None = None,
    fast: bool = False,
) -> Iterator[str]:
    """The answer in pieces, read from the service's server-sent events.

    JSON mode is deliberately not asked for here: some services refuse to
    stream with a response format, and the instruction plus the repair in
    ``ai.py`` already carry a streamed answer to a parsed one. Closing the
    generator closes the connection; ``should_stop`` is checked per line.
    """
    model = resolve_model(fast)
    payload: dict[str, Any] = {
        "model": model,
        "messages": _messages(prompt, system, fmt),
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    response = _request("/chat/completions", payload, timeout=timeout, model=model)
    try:
        for raw in response:
            if should_stop is not None and should_stop():
                raise Stopped()
            line = raw.decode("utf-8", errors="ignore") if isinstance(raw, bytes) else str(raw)
            line = line.strip()
            if not line.startswith("data:"):
                continue  # blank separators and ": keep-alive" comments
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk, dict) and chunk.get("error"):
                raise OpenAIError(
                    "service_error",
                    _scrub(str((chunk["error"] or {}).get("message") or "The AI service stopped answering.")),
                )
            try:
                piece = chunk["choices"][0].get("delta", {}).get("content") or ""
            except (KeyError, IndexError, TypeError, AttributeError):
                continue
            if piece:
                yield piece
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(exc, TimeoutError) or "timed out" in str(reason).lower():
            raise OpenAIError("timeout", "The AI service took too long to answer and was stopped.") from exc
        raise OpenAIError("unreachable", "The AI service stopped answering part way through.") from exc
    finally:
        response.close()
