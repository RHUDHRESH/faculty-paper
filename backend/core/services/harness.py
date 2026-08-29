"""The college's own inference harness, over the network it controls.

This is the production provider: a purpose-built service for the Gemma
models, deployed on Google Cloud beside the API (Cloud Run with a GPU, or a
GCE VM), reached at ``HARNESS_BASE_URL``. Its server lives in ``harness/`` at
the repo root and is ours end to end -- there is no third-party inference
vendor in this arrangement, which is the whole point. Google Cloud and
Vercel are the only outside services this system uses.

The privacy property carries over from the laptop provider unchanged: a
faculty member's unpublished title and abstract go to hardware the college
runs, and to nothing else. What changes is who runs the hardware -- the
harness answers the API's production deployment, not a developer's laptop --
so the features stop being invisible the moment the app leaves localhost.

This module mirrors ``ollama.py`` surface for surface -- ``generate``,
``stream``, ``Stopped``, an ``*Error`` with ``kind``/``message``, a
``Health`` with the same fields, the same tier resolution -- so ``ai.py``
can dispatch between the two on one line and every endpoint keeps the
failure vocabulary it was written against.

The same three insistences apply:

- **Every call is bounded.** ``HARNESS_TIMEOUT_SECONDS`` is a ceiling that
  stops a wedged generation holding a request worker forever.
- **A missing model is a configuration fact**, reported as ``model_missing``
  with the sentence that fixes it, not as "the AI is broken".
- **It never falls back to anything else.** If the harness is down, the
  answer is that the harness is down.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from django.conf import settings

logger = logging.getLogger(__name__)

#: A ceiling, not an expectation. The harness on an L4 generates the same
#: nine-journal answer in a fraction of the laptop's two minutes, but the
#: bound exists for the wedged case, not the measured one, and a cold slot
#: (weights being read into memory) sits inside it too.
DEFAULT_TIMEOUT = int(os.getenv("HARNESS_TIMEOUT_SECONDS", "240"))

#: The health probe answers in milliseconds when the harness is up.
HEALTH_TIMEOUT = 3


class HarnessError(Exception):
    """Inference did not happen, with a reason worth showing somebody.

    ``kind`` is what the UI switches on; ``message`` is what it may print.
    The kinds are the same words ``ollama.OllamaError`` uses, so the mapping
    in ``ai.py`` is one table for both providers.
    """

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


@dataclass(frozen=True)
class Health:
    """What is true about the harness right now.

    Same shape as ``ollama.Health`` on purpose -- the screens and the verdict
    logic were written against those fields, and a provider that renamed them
    would be a provider the truth table could not see. The two slots are
    reported separately because they fail separately and their remedies are
    different commands.
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


def base_url() -> str:
    return (getattr(settings, "HARNESS_BASE_URL", "") or "http://127.0.0.1:8300").rstrip("/")


def model_name() -> str:
    """The considered slot. This is the default tier."""
    return (getattr(settings, "HARNESS_MODEL", "") or "gemma-3-12b-it-q4_k_m").strip()


def fast_model_name() -> str:
    """The interactive slot -- the model that answers while somebody watches."""
    return (getattr(settings, "HARNESS_FAST_MODEL", "") or "gemma-3-4b-it-q4_k_m").strip()


def resolve_model(fast: bool = False) -> str:
    """Which slot a call should go to. One place, so callers name a tier."""
    return fast_model_name() if fast else model_name()


def keep_alive(fast: bool = False) -> str:
    """How long the harness holds this slot in memory after answering.

    Same asymmetric two-tier reasoning as the Ollama setting; the harness
    parses durations the same way ("30m", "0" to unload now, "-1" to pin).
    """
    if fast:
        return str(getattr(settings, "HARNESS_FAST_KEEP_ALIVE", "") or "30m").strip()
    return str(getattr(settings, "HARNESS_KEEP_ALIVE", "") or "10m").strip()


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    token = str(getattr(settings, "HARNESS_TOKEN", "") or "").strip()
    if token:
        headers["X-Harness-Token"] = token
    return headers


def _request(
    path: str,
    payload: dict | None = None,
    *,
    timeout: int,
    stream: bool = False,
    model: str | None = None,
):
    url = f"{base_url()}{path}"
    if payload is None:
        req = urllib.request.Request(url, method="GET", headers=_headers())
    else:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"),
            headers=_headers(), method="POST",
        )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="ignore")
        except Exception:  # noqa: BLE001 - the body is a nicety, not the error
            pass
        # The one HTTP error worth telling apart: the harness answers 404
        # with {"error": "model 'x' is not loaded"} when a slot's weights are
        # not on the machine it runs on. That is somebody's configuration and
        # is fixed by loading the weights or naming a slot that exists.
        if exc.code in (404, 409) and "not loaded" in body.lower():
            missing = model or model_name()
            raise HarnessError(
                "model_missing",
                f"The harness does not have the model {missing!r} loaded.",
            ) from exc
        if exc.code == 403:
            raise HarnessError(
                "rejected",
                "The harness refused this server's credentials.",
            ) from exc
        raise HarnessError(
            "service_error", f"The inference harness answered {exc.code}."
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(exc, TimeoutError) or "timed out" in str(reason).lower():
            raise HarnessError(
                "timeout", "The model took too long to answer and was stopped."
            ) from exc
        raise HarnessError(
            "unreachable",
            f"No inference harness is answering on {base_url()}.",
        ) from exc


def health(*, timeout: int = HEALTH_TIMEOUT) -> Health:
    """Is the harness up, and is each configured slot actually loaded?

    Three questions, three remedies -- the service is down, the considered
    slot's weights are missing, the fast slot's weights are missing -- kept
    separate because they are fixed by different people doing different
    things.
    """
    want = model_name()
    want_fast = fast_model_name()
    url = base_url()

    try:
        data = json.load(_request("/health", timeout=timeout))
    except HarnessError as exc:
        return Health(
            up=False, model_present=False, model=want, base_url=url, detail=exc.message,
            fast_model=want_fast, fast_model_present=False, fast_detail=exc.message,
        )

    slots = data.get("slots") or {}
    main = slots.get("main") or {}
    fast = slots.get("fast") or {}
    present = bool(main.get("loaded")) and (
        not main.get("name") or main.get("name") == want
    )
    fast_present = bool(fast.get("loaded")) and (
        not fast.get("name") or fast.get("name") == want_fast
    )
    names = tuple(
        s.get("name") for s in (main, fast) if s.get("name")
    )
    return Health(
        up=bool(data.get("ok")),
        model_present=present,
        model=want,
        base_url=url,
        version=data.get("version"),
        models=names,
        detail=None if present else (
            f"The harness is up but {want!r} is not loaded on it."
        ),
        fast_model=want_fast,
        fast_model_present=fast_present,
        fast_detail=(
            None if fast_present else f"The harness is up but {want_fast!r} is not loaded."
        ),
    )


def _grammar(fmt: str | dict | None) -> dict[str, Any] | None:
    """The decoding constraint, in the harness's vocabulary.

    ``"json"`` becomes the any-JSON grammar flag; a schema dict is passed
    through and the harness converts it with llama.cpp's schema converter,
    falling back to the any-JSON grammar if that import is unavailable --
    the caller's JSON repair path exists either way.
    """
    if not fmt:
        return None
    if fmt == "json":
        return {"json": True}
    if isinstance(fmt, dict):
        return {"json_schema": fmt}
    return None


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

    Mirrors ``ollama.generate`` argument for argument. ``fmt="json"`` and a
    schema dict become a decoding constraint the harness enforces in the
    sampler, so a model asked for JSON cannot answer in prose -- the same
    guarantee Ollama's ``format`` gave, from our own service.
    """
    model = resolve_model(fast)
    payload: dict[str, Any] = {
        "model": model,
        "keep_alive": keep_alive(fast),
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if system:
        payload["system"] = system
    constraint = _grammar(fmt)
    if constraint:
        payload.update(constraint)

    data = json.load(_request("/v1/generate", payload, timeout=timeout, model=model))
    if data.get("error"):
        raise HarnessError(
            data["error"].get("kind", "service_error"),
            data["error"].get("message", "The harness could not answer."),
        )
    return (data.get("text") or "").strip()


class Stopped(Exception):
    """The consumer asked for the stream to end before the model was done.

    Not a failure. Callers that map errors onto HTTP statuses must let this
    through -- a cancelled request is somebody changing their mind, and
    reporting it as a fault produces a red panel for an action the reader
    themselves took.
    """


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
    """The answer in pieces, as it is produced.

    Same contract as ``ollama.stream``: closing the generator closes the
    connection, which is half of cancellation; ``should_stop`` is the other
    half, for a consumer that learns about abandonment from a different
    thread. The harness is told the run id on the way in so an explicit
    cancel (``ai.stop`` -> the endpoint -> ``/v1/cancel``) can end a
    generation server-side too.

    ``fmt`` carries the decoding constraint through; streaming and
    structured output are not alternatives here either.
    """
    model = resolve_model(fast)
    payload: dict[str, Any] = {
        "model": model,
        "keep_alive": keep_alive(fast),
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
    }
    if system:
        payload["system"] = system
    constraint = _grammar(fmt)
    if constraint:
        payload.update(constraint)

    response = _request(
        "/v1/generate-stream", payload, timeout=timeout, stream=True, model=model
    )
    try:
        for line in response:
            if should_stop is not None and should_stop():
                raise Stopped()
            if not line.strip():
                continue
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            if chunk.get("error"):
                raise HarnessError(
                    chunk["error"].get("kind", "service_error"),
                    chunk["error"].get("message", "The harness stopped answering."),
                )
            piece = chunk.get("text") or ""
            if piece:
                yield piece
            if chunk.get("t") == "done" or chunk.get("done"):
                break
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(exc, TimeoutError) or "timed out" in str(reason).lower():
            raise HarnessError(
                "timeout", "The model took too long to answer and was stopped."
            ) from exc
        raise HarnessError(
            "unreachable", "The inference harness stopped answering part way through."
        ) from exc
    finally:
        response.close()
