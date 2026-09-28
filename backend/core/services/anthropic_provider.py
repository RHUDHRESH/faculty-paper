"""Claude, through the official ``anthropic`` SDK.

The same surface as the other providers (``generate``, ``stream``,
``Stopped``, an error with ``kind``/``message``, ``DEFAULT_TIMEOUT``,
``resolve_model``, ``health``), so ``ai.py`` dispatches to it unchanged.

Selected by ``AI_PROVIDER=anthropic``, or by ``ANTHROPIC_API_KEY`` being set
with no ``AI_PROVIDER``. The model is ``AI_MODEL`` (default
``claude-haiku-4-5``). The key is read from the environment/settings only and
is never put in a message, log line or error.

``research(...)`` is the one extra: a call with the server-side web search
tool, used by the research scout.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from django.conf import settings

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_TIMEOUT = int(os.getenv("AI_TIMEOUT_SECONDS", "60"))

#: Stable across every call, so it is marked for prompt caching.
SYSTEM_PROMPT = (
    "You are the research assistant inside a college's faculty publication app. "
    "You help faculty members with venues, collaborators and research directions. "
    "Be accurate and specific; never invent journals, people, URLs or numbers."
)
_JSON_INSTRUCTION = "Reply with a single JSON value and nothing else: no prose, no code fences."


class AnthropicError(Exception):
    """Same ``kind`` words as the other providers, so ``ai._CODE_MAP`` serves."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


class Stopped(Exception):
    """The consumer asked for the stream to end. Not a failure."""


@dataclass(frozen=True)
class Health:
    up: bool
    model_present: bool
    model: str
    base_url: str = "api.anthropic.com"
    detail: str | None = None
    fast_model: str = ""
    fast_model_present: bool = False
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
            "version": None,
            "models": [],
            "detail": self.detail,
            "fast_model": self.fast_model,
            "fast_model_present": self.fast_model_present,
            "fast_ready": self.fast_ready,
            "fast_detail": self.detail,
        }


def api_key() -> str:
    return (getattr(settings, "ANTHROPIC_API_KEY", "") or "").strip()


def model_name() -> str:
    return (getattr(settings, "AI_MODEL", "") or "").strip() or DEFAULT_MODEL


def resolve_model(fast: bool = False) -> str:
    if fast:
        return (getattr(settings, "AI_FAST_MODEL", "") or "").strip() or model_name()
    return model_name()


def host() -> str:
    return "api.anthropic.com"


def missing_settings() -> list[str]:
    return [] if api_key() else ["ANTHROPIC_API_KEY"]


def health(**_: Any) -> Health:
    """Configured-ness, answered without a network call (a call costs money)."""
    ok = bool(api_key())
    detail = None if ok else "ANTHROPIC_API_KEY is not set."
    return Health(
        up=ok, model_present=ok, model=model_name(), detail=detail,
        fast_model=resolve_model(True), fast_model_present=ok,
        failure=None if ok else "misconfigured",
    )


def _client(timeout: float):
    import anthropic

    return anthropic.Anthropic(api_key=api_key(), timeout=timeout, max_retries=2)


def _scrub(text: str) -> str:
    key = api_key()
    if key:
        text = text.replace(key, "[key]")
    return text.strip()[:300]


def _mapped(exc: Exception) -> AnthropicError:
    """The SDK's typed errors, in the words the app already switches on."""
    import anthropic

    if isinstance(exc, anthropic.RateLimitError):
        return AnthropicError("rate_limited", "The AI service is busy right now. Try again in a minute.")
    if isinstance(exc, anthropic.APITimeoutError):
        return AnthropicError("timeout", "The AI service took too long to answer and was stopped.")
    if isinstance(exc, anthropic.APIConnectionError):
        return AnthropicError("unreachable", "The AI service could not be reached.")
    if isinstance(exc, (anthropic.AuthenticationError, anthropic.PermissionDeniedError)):
        return AnthropicError("rejected", "The AI service refused this server's key.")
    if isinstance(exc, anthropic.NotFoundError):
        return AnthropicError("model_missing", f"The AI service does not offer the model {model_name()!r}.")
    if isinstance(exc, anthropic.BadRequestError):
        return AnthropicError("bad_request", _scrub(getattr(exc, "message", "") or "The AI service refused the request."))
    if isinstance(exc, anthropic.APIStatusError):
        return AnthropicError("service_error", f"The AI service answered with an error ({exc.status_code}).")
    return AnthropicError("service_error", _scrub(str(exc)) or "The AI call failed.")


def _system(system: str | None, fmt: str | dict | None, *, schema_enforced: bool) -> list[dict]:
    blocks: list[dict] = [
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
    ]
    extra = [system] if system else []
    if fmt and not schema_enforced:
        extra.append(_JSON_INSTRUCTION)
        if isinstance(fmt, dict):
            extra.append("It must match this JSON Schema: " + json.dumps(fmt, separators=(",", ":")))
    if extra:
        blocks.append({"type": "text", "text": " ".join(extra)})
    return blocks


def _text_of(message: Any) -> str:
    return "".join(
        getattr(b, "text", "") for b in (message.content or []) if getattr(b, "type", "") == "text"
    ).strip()


def _strict_ok(schema: Any) -> bool:
    """Structured outputs need closed objects; loose caller schemas are described instead."""
    if isinstance(schema, dict):
        if schema.get("type") == "object" and schema.get("additionalProperties") is not False:
            return False
        return all(_strict_ok(v) for v in schema.values())
    if isinstance(schema, list):
        return all(_strict_ok(v) for v in schema)
    return True


def generate(
    prompt: str,
    *,
    system: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    max_tokens: int = 4000,
    temperature: float = 0.2,
    fmt: str | dict | None = None,
    fast: bool = False,
) -> str:
    enforce = isinstance(fmt, dict) and _strict_ok(fmt)
    kwargs: dict[str, Any] = {
        "model": resolve_model(fast),
        "max_tokens": max(max_tokens, 4000) if fmt else max_tokens,
        "temperature": temperature,
        "system": _system(system, fmt, schema_enforced=enforce),
        "messages": [{"role": "user", "content": prompt}],
    }
    if enforce:
        kwargs["output_config"] = {"format": {"type": "json_schema", "schema": fmt}}
    try:
        message = _client(timeout).messages.create(**kwargs)
    except Exception as exc:  # noqa: BLE001 - mapped to typed kinds
        err = _mapped(exc)
        if not (enforce and err.kind == "bad_request"):
            raise err from exc
        # The schema used a feature structured outputs refuses: describe it instead.
        kwargs.pop("output_config")
        kwargs["system"] = _system(system, fmt, schema_enforced=False)
        try:
            message = _client(timeout).messages.create(**kwargs)
        except Exception as exc2:  # noqa: BLE001
            raise _mapped(exc2) from exc2
    return _text_of(message)


def stream(
    prompt: str,
    *,
    system: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    max_tokens: int = 4000,
    temperature: float = 0.2,
    fmt: str | dict | None = None,
    should_stop: Callable[[], bool] | None = None,
    fast: bool = False,
) -> Iterator[str]:
    """The answer in pieces. The schema is described (not enforced) when streaming."""
    try:
        with _client(timeout).messages.stream(
            model=resolve_model(fast),
            max_tokens=max(max_tokens, 4000) if fmt else max_tokens,
            temperature=temperature,
            system=_system(system, fmt, schema_enforced=False),
            messages=[{"role": "user", "content": prompt}],
        ) as events:
            for piece in events.text_stream:
                if should_stop is not None and should_stop():
                    raise Stopped()
                if piece:
                    yield piece
    except (Stopped, GeneratorExit):
        raise
    except AnthropicError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _mapped(exc) from exc


def research(
    prompt: str,
    *,
    system: str | None = None,
    max_searches: int = 5,
    max_tokens: int = 8000,
    timeout: int = 180,
) -> dict[str, Any]:
    """One question answered with Claude's server-side web search.

    Returns ``{"text", "sources", "usage"}``: the final text, every URL the
    search tool returned or a citation pointed at, and token/search counts.
    """
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": max_searches}]
    sources: dict[str, str] = {}
    texts: list[str] = []
    usage = {"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "web_search_requests": 0}
    client = _client(timeout)
    for _ in range(3):  # pause_turn continuations
        try:
            message = client.messages.create(
                model=model_name(),
                max_tokens=max_tokens,
                system=_system(system, None, schema_enforced=False),
                tools=tools,
                messages=messages,
            )
        except Exception as exc:  # noqa: BLE001
            raise _mapped(exc) from exc
        u = message.usage
        usage["input_tokens"] += getattr(u, "input_tokens", 0) or 0
        usage["output_tokens"] += getattr(u, "output_tokens", 0) or 0
        usage["cache_read_input_tokens"] += getattr(u, "cache_read_input_tokens", 0) or 0
        stu = getattr(u, "server_tool_use", None)
        usage["web_search_requests"] += getattr(stu, "web_search_requests", 0) or 0
        for block in message.content or []:
            kind = getattr(block, "type", "")
            if kind == "web_search_tool_result":
                for r in getattr(block, "content", None) or []:
                    url = getattr(r, "url", None)
                    if url:
                        sources.setdefault(url, getattr(r, "title", "") or url)
            elif kind == "text":
                texts.append(block.text)
                for c in getattr(block, "citations", None) or []:
                    url = getattr(c, "url", None)
                    if url:
                        sources.setdefault(url, getattr(c, "title", "") or url)
        if message.stop_reason != "pause_turn":
            break
        messages = [
            {"role": "user", "content": prompt},
            {"role": "assistant", "content": message.content},
        ]
    return {
        "text": "".join(texts).strip(),
        "sources": [{"url": u, "title": t} for u, t in sources.items()],
        "usage": usage,
    }
