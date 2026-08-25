"""Talking to Gemini, for the two places this app asks a model anything.

The rule that shapes this file: **the model proposes and the database
disposes.** Nothing a model says is shown to a claimant as fact. It suggests
journal names; those names are then looked up in our own 32,000-row Scimago and
SNIP tables, and only what resolves to a real record is shown — with the real
quartile, the real SNIP, and the amount our own formula computes. A journal the
model invented, or misremembered, or that simply is not in the dataset, is
dropped or shown plainly as unverified.

That is not fussiness. This is a payment system. A plausible-sounding journal
name that somebody submits a paper to, and then files a claim against, costs
that person months. The model is allowed to be a source of ideas here and
nothing else.

No key configured means every caller gets `available() == False` and the
features that use it say so, rather than erroring. That is the normal state on
a developer machine and must not break anything.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx
from django.conf import settings

logger = logging.getLogger(__name__)

#: Kept small on purpose. These calls sit in front of a person waiting for a
#: page, not in a batch job.
TIMEOUT_SECONDS = 20.0
MAX_OUTPUT_TOKENS = 2048

_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class GeminiError(RuntimeError):
    """The model could not be reached, or did not answer usefully."""

    def __init__(self, message: str, *, code: str = "error"):
        super().__init__(message)
        self.code = code


def api_key() -> str:
    return (getattr(settings, "GEMINI_API_KEY", "") or "").strip()


def model_name() -> str:
    return (getattr(settings, "GEMINI_MODEL", "") or "gemini-2.5-flash").strip()


def available() -> bool:
    """Whether asking is even possible. Check this before offering a feature."""
    return bool(api_key())


def _extract_json(text: str) -> Any:
    """Pull the JSON out of a reply that may be wrapped in prose or a fence.

    `responseMimeType` usually makes this unnecessary, but "usually" is not a
    guarantee, and a single stray sentence before the opening brace should not
    lose the whole answer.
    """
    text = (text or "").strip()
    if not text:
        raise GeminiError("The model returned nothing", code="empty")

    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Fall back to the outermost bracketed span.
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue

    raise GeminiError("The model did not answer in the shape we asked for", code="unparsable")


def ask_json(
    prompt: str,
    *,
    schema: dict[str, Any] | None = None,
    temperature: float = 0.4,
    timeout: float = TIMEOUT_SECONDS,
) -> Any:
    """Ask for JSON and get parsed JSON, or raise `GeminiError`.

    `schema` is passed as `responseSchema`, which makes the model return the
    shape rather than being asked nicely to. Callers should still validate what
    comes back — a schema constrains the structure, not the truthfulness of
    what is inside it.
    """
    key = api_key()
    if not key:
        raise GeminiError("No Gemini API key is configured", code="unconfigured")

    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "responseMimeType": "application/json",
        },
    }
    if schema:
        body["generationConfig"]["responseSchema"] = schema

    url = _ENDPOINT.format(model=model_name())
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(url, params={"key": key}, json=body)
    except httpx.TimeoutException as exc:
        raise GeminiError("The model took too long to answer", code="timeout") from exc
    except httpx.HTTPError as exc:
        raise GeminiError("Could not reach the model", code="unreachable") from exc

    if response.status_code == 429:
        raise GeminiError("The model is rate limited right now", code="rate_limited")
    if response.status_code in (401, 403):
        raise GeminiError("The Gemini key was rejected", code="unauthorized")
    if response.status_code >= 400:
        # The body carries the reason and no user content, so it is safe and
        # useful to log. Without it, a 400 from a schema mistake is invisible.
        logger.warning("Gemini %s: %s", response.status_code, response.text[:500])
        raise GeminiError("The model refused the request", code="rejected")

    payload = response.json()

    candidates = payload.get("candidates") or []
    if not candidates:
        # Usually a safety block. Say which, because "nothing happened" sends
        # somebody looking for a bug that is not there.
        reason = (payload.get("promptFeedback") or {}).get("blockReason")
        raise GeminiError(
            f"The model declined to answer ({reason})" if reason else "The model returned nothing",
            code="blocked",
        )

    parts = (candidates[0].get("content") or {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts)
    return _extract_json(text)
