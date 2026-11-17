"""One cheap, real call to each outside service, to answer "does this key work".

Every check returns ``{"ok", "latency_ms", "message"}``. A failure to connect, a
timeout, a refused key: all of them are an ``ok: False`` with a plain sentence.
Nothing here raises to the caller, and no message ever contains a key (the
text of an upstream error is scrubbed of every value this module sent).
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from core.services import integrations

logger = logging.getLogger("core.integrations")

TIMEOUT = httpx.Timeout(10.0, connect=5.0)
ANTHROPIC_MODELS = "https://api.anthropic.com/v1/models"
#: The Scopus Search API, the one this app already uses; the query is an author-name search.
SCOPUS_AUTHOR_SEARCH = "https://api.elsevier.com/content/search/scopus"
OPENALEX_WORKS = "https://api.openalex.org/works"
#: A name from the history of physics: it returns an answer for any working key
#: and names nobody at the college.
SCOPUS_SAFE_QUERY = "AUTHLASTNAME(Einstein) AND AUTHFIRST(Albert)"


def _http_get(url: str, *, headers: dict[str, str] | None = None, params: dict[str, Any] | None = None) -> httpx.Response:
    """The one place a check touches the network (tests replace this)."""
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False) as client:
        return client.get(url, headers=headers, params=params)


def _result(ok: bool, started: float, message: str) -> dict[str, Any]:
    return {"ok": ok, "latency_ms": int((time.monotonic() - started) * 1000), "message": message}


def _scrub(text: str, secrets: list[str]) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[key]")
    return " ".join(text.split())[:200]


def _status_message(res: httpx.Response, who: str, secrets: list[str]) -> str:
    code = res.status_code
    if code in (401, 403):
        return f"{who} refused the key ({code}). Check it was pasted whole and has not expired."
    if code == 429:
        return f"{who} says the allowance is used up for now (429). Try again later."
    if code == 404:
        return f"{who} has nothing at that address (404). Check the base URL."
    if 300 <= code < 400:
        return f"{who} redirected the request. Check the address."
    if code >= 500:
        return f"{who} is having trouble itself ({code}). Try again later."
    return f"{who} answered {code}. {_scrub(res.text, secrets)[:120]}".strip()


def _guarded(who: str, secrets: list[str], call) -> dict[str, Any]:
    started = time.monotonic()
    try:
        return call(started)
    except httpx.TimeoutException:
        return _result(False, started, f"{who} did not answer within 10 seconds.")
    except httpx.InvalidURL:
        return _result(False, started, "That address is not a web address that can be called.")
    except httpx.HTTPError as exc:
        logger.info("integration check failed who=%s kind=%s", who, type(exc).__name__)
        return _result(False, started, f"{who} could not be reached from this server.")
    except Exception as exc:  # noqa: BLE001 - a check never raises to the page
        logger.warning("integration check crashed who=%s kind=%s", who, type(exc).__name__)
        return _result(False, started, f"The check could not be completed ({type(exc).__name__}).")


# ---------------------------------------------------------------------------


def check_ai() -> dict[str, Any]:
    base, key, model = integrations.get("ai.base_url"), integrations.get("ai.api_key"), integrations.get("ai.model")
    if not (base and key):
        return _result(False, time.monotonic(), "Set the base URL and the API key first.")

    def call(started: float) -> dict[str, Any]:
        res = _http_get(f"{base.rstrip('/')}/models", headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
        if res.status_code != 200:
            return _result(False, started, _status_message(res, "The AI service", [key]))
        listed: list[str] = []
        try:
            data = res.json()
            items = data.get("data") if isinstance(data, dict) else data
            listed = [str(m.get("id", "")) for m in (items or []) if isinstance(m, dict)]
        except ValueError:
            return _result(False, started, "The AI service answered, but not with a list of models. Check the base URL.")
        note = f"The key works and the service lists {len(listed)} models."
        if model and listed:
            bare = {m.split("/")[-1] for m in listed} | set(listed)
            note += (
                f" The model {model} is available." if model in bare
                else f" The model {model} is not in that list."
            )
        return _result(True, started, note)

    return _guarded("The AI service", [key], call)


def check_anthropic() -> dict[str, Any]:
    key = integrations.get("anthropic.api_key")
    if not key:
        return _result(False, time.monotonic(), "Set the API key first.")

    def call(started: float) -> dict[str, Any]:
        res = _http_get(
            ANTHROPIC_MODELS, params={"limit": 1},
            headers={"x-api-key": key, "anthropic-version": "2023-06-01", "Accept": "application/json"},
        )
        if res.status_code != 200:
            return _result(False, started, _status_message(res, "Anthropic", [key]))
        return _result(True, started, "The key works.")

    return _guarded("Anthropic", [key], call)


def check_scopus() -> dict[str, Any]:
    key, token = integrations.get("scopus.api_key"), integrations.get("scopus.inst_token")
    if not key:
        return _result(False, time.monotonic(), "Set the API key first.")

    def call(started: float) -> dict[str, Any]:
        headers = {"X-ELS-APIKey": key, "Accept": "application/json"}
        if token:
            headers["X-ELS-Insttoken"] = token
        res = _http_get(SCOPUS_AUTHOR_SEARCH, headers=headers, params={"query": SCOPUS_SAFE_QUERY, "count": 1})
        integrations.record_call("scopus", headers=res.headers)
        if res.status_code != 200:
            return _result(False, started, _status_message(res, "Scopus", [key, token]))
        message = "The key works."
        remaining = res.headers.get("X-RateLimit-Remaining")
        if remaining:
            message += f" {remaining} calls are left in this window."
        return _result(True, started, message)

    return _guarded("Scopus", [key, token], call)


def check_openalex() -> dict[str, Any]:
    from core.services.search import upstream

    key = integrations.get("openalex.api_key")

    def call(started: float) -> dict[str, Any]:
        params: dict[str, Any] = {"per-page": 1, "mailto": upstream.contact()}
        if key:
            params["api_key"] = key
        res = _http_get(OPENALEX_WORKS, params=params, headers={"Accept": "application/json", "User-Agent": "SECPublicationPortal/1.0"})
        integrations.record_call("openalex")
        if res.status_code != 200:
            return _result(False, started, _status_message(res, "OpenAlex", [key]))
        note = "OpenAlex answered" + (" and accepted the key." if key else ". No key is set, which is fine.")
        return _result(True, started, note)

    return _guarded("OpenAlex", [key], call)


CHECKS = {
    "ai": check_ai,
    "anthropic": check_anthropic,
    "scopus": check_scopus,
    "openalex": check_openalex,
}


def run(provider: str) -> dict[str, Any]:
    result = CHECKS[provider]()
    integrations.record_test(provider, result["ok"], result["message"])
    return result


__all__ = ["CHECKS", "run"]
