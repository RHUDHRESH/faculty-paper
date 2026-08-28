"""Local inference, over the loopback interface, with no key to keep.

This talks to an Ollama daemon on 127.0.0.1. That address is the whole
security story: the model runs on the same machine, nothing leaves it, and
there is no account, no key and no quota behind it. A paper's title and
abstract are the college's own unpublished work, and sending them to a third
party to be told what field they are in was never a good trade.

Three things this module insists on, all of them learned from the shape of
the failure they prevent:

- **Every call is bounded.** Ollama will happily generate until it runs out
  of tokens to predict, and a request path with no ceiling is a worker thread
  held open until something else times out and blames the wrong thing.
- **A missing model is not a server error.** Ollama answers 404 with
  ``{"error": "model 'x' not found"}``, which is a configuration fact
  somebody can act on -- pull it, or set OLLAMA_MODEL to what is there. It is
  reported as exactly that rather than as "the AI is broken".
- **It never falls back to anything remote.** If the daemon is down, the
  answer is that the daemon is down. Quietly reaching for a paid API instead
  would mean the one property this module exists to provide -- that the text
  stays on this machine -- silently stops being true.
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

#: A ceiling, not an expectation.
#:
#: Sized from measurement rather than taste. On the machine this was built
#: against -- four cores, no usable GPU -- gemma4:12b generates about 4.5
#: tokens a second, so a nine-journal answer of roughly 450 tokens takes a
#: little under two minutes. 120s cut exactly that request off. The point of
#: the bound is to stop a wedged daemon holding a worker forever, not to
#: enforce a latency the hardware cannot meet.
DEFAULT_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT_SECONDS", "240"))

#: The health probe answers in milliseconds when the daemon is up, so a long
#: timeout here only delays telling somebody it is down.
HEALTH_TIMEOUT = 3

#: Whether to let a reasoning model think before answering. Off, and settable
#: only here rather than per call -- see the note in `generate` for what
#: leaving it on actually does on this hardware.
THINK = False


class OllamaError(Exception):
    """Inference did not happen, with a reason worth showing somebody.

    ``kind`` is what the UI switches on; ``message`` is what it may print.
    """

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


@dataclass(frozen=True)
class Health:
    """What is true about the local model service right now."""

    up: bool
    model_present: bool
    model: str
    base_url: str
    version: str | None = None
    models: tuple[str, ...] = ()
    detail: str | None = None

    @property
    def ready(self) -> bool:
        return self.up and self.model_present

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
        }


def base_url() -> str:
    return (getattr(settings, "OLLAMA_BASE_URL", "") or "http://127.0.0.1:11434").rstrip("/")


def model_name() -> str:
    return (getattr(settings, "OLLAMA_MODEL", "") or "gemma4:12b").strip()


def _request(path: str, payload: dict | None = None, *, timeout: int, stream: bool = False):
    url = f"{base_url()}{path}"
    if payload is None:
        req = urllib.request.Request(url, method="GET")
    else:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="ignore")
        except Exception:  # noqa: BLE001 - the body is a nicety, not the error
            pass
        # The one HTTP error worth telling apart. Everything else is "the
        # service said no", but a missing model is somebody's configuration
        # and is fixed by pulling it or naming a different one.
        if exc.code == 404 and "not found" in body.lower():
            raise OllamaError(
                "model_missing",
                f"The model {model_name()!r} is not installed on this machine.",
            ) from exc
        raise OllamaError("service_error", f"The local model service answered {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        if isinstance(exc, TimeoutError) or "timed out" in str(reason).lower():
            raise OllamaError(
                "timeout", "The local model took too long to answer and was stopped."
            ) from exc
        raise OllamaError(
            "unreachable",
            f"No local model service is answering on {base_url()}.",
        ) from exc


def health(*, timeout: int = HEALTH_TIMEOUT) -> Health:
    """Is the daemon up, and is the configured model actually there?

    Two separate questions with two different remedies -- start the service,
    or pull the model -- so they are answered separately rather than collapsed
    into one "unavailable". A screen that cannot tell them apart cannot tell
    anybody what to do about it.
    """
    want = model_name()
    url = base_url()

    try:
        version = json.load(_request("/api/version", timeout=timeout)).get("version")
    except OllamaError as exc:
        return Health(
            up=False, model_present=False, model=want, base_url=url, detail=exc.message
        )

    try:
        tags = json.load(_request("/api/tags", timeout=timeout))
    except OllamaError as exc:
        return Health(
            up=True, model_present=False, model=want, base_url=url,
            version=version, detail=exc.message,
        )

    names = tuple(m.get("name", "") for m in tags.get("models", []))
    # "gemma4:12b" and a bare "gemma4" both count, because Ollama treats a
    # tagless name as :latest and somebody configuring this by hand will write
    # whichever they saw in the docs.
    present = want in names or any(n.split(":")[0] == want.split(":")[0] for n in names)
    return Health(
        up=True,
        model_present=present,
        model=want,
        base_url=url,
        version=version,
        models=names,
        detail=None if present else f"{want!r} is not among the installed models.",
    )


def generate(
    prompt: str,
    *,
    system: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    max_tokens: int = 512,
    temperature: float = 0.2,
    fmt: str | dict | None = None,
) -> str:
    """One prompt in, the whole answer out.

    ``fmt="json"`` asks Ollama to constrain generation to valid JSON, which is
    worth using wherever the caller is going to parse the result -- a model
    asked politely for JSON in the prompt will still occasionally wrap it in
    prose, and the constrained decoder cannot.
    """
    payload: dict[str, Any] = {
        "model": model_name(),
        "prompt": prompt,
        "stream": False,
        # Gemma 4 reasons before answering, and does it silently: with
        # thinking left on and a modest token ceiling the model spends the
        # entire budget reasoning and returns an EMPTY string with
        # done_reason "length" -- a success as far as HTTP is concerned, and
        # nothing at all on the screen. Measured on this hardware: 20 tokens
        # of budget produced 0 characters with thinking on, and a correct
        # answer in 10 tokens with it off.
        #
        # It is also unaffordable here. Generation runs on the CPU at about
        # 4.5 tokens a second, so reasoning nobody reads is thirty seconds
        # nobody waits for.
        "think": THINK,
        "options": {"temperature": temperature, "num_predict": max_tokens},
    }
    if system:
        payload["system"] = system
    if fmt:
        payload["format"] = fmt

    data = json.load(_request("/api/generate", payload, timeout=timeout))
    return (data.get("response") or "").strip()


def generate_json(
    prompt: str,
    *,
    system: str | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    max_tokens: int = 512,
) -> Any:
    """A prompt whose answer is parsed.

    A local model is smaller than a hosted one and gets this wrong more often,
    so the failure is treated as ordinary rather than exceptional: malformed
    output raises `OllamaError("bad_output")` and the caller decides what to
    show. It is deliberately not "return None and carry on" -- a feature that
    silently produces nothing looks identical to one nobody switched on.
    """
    raw = generate(
        prompt, system=system, timeout=timeout, max_tokens=max_tokens,
        temperature=0.0, fmt="json",
    )
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # Constrained decoding makes this rare; a truncated answer at the
        # token ceiling is the usual cause.
        logger.warning("ollama_bad_json model=%s len=%d", model_name(), len(raw))
        raise OllamaError(
            "bad_output", "The local model returned something that could not be read."
        ) from None


class Stopped(Exception):
    """The consumer asked for the stream to end before the model was done.

    Distinct from every failure in `OllamaError`: nothing went wrong, somebody
    changed their mind. Callers that map failures onto HTTP statuses must let
    this one through rather than reporting a cancelled request as a fault.
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
) -> Iterator[str]:
    """The answer in pieces, as it is produced.

    Worth the extra handling on this hardware. Generation runs on the CPU at a
    few tokens a second, so a complete answer can be half a minute away --
    long enough that a spinner reads as a hang. Streaming turns the same wait
    into something visibly working.

    The generator closes the connection when the consumer stops reading, which
    is what makes cancellation real: a browser that navigates away drops the
    response, this generator is closed, and Ollama stops generating rather
    than finishing an answer nobody will see.

    `should_stop` is the same cancellation from the other side, for a consumer
    that cannot simply stop iterating -- a request handler streaming to a
    browser learns the browser has gone from a different thread than the one
    blocked on the model. It is consulted once per chunk, so on this hardware
    it is answered within about a quarter of a second of a token arriving.

    `fmt` is passed through as Ollama's decoding constraint. Streaming and
    structured output are not alternatives: the decoder still cannot emit a
    token that breaks the schema, and the caller still sees the answer being
    built.
    """
    payload: dict[str, Any] = {
        "model": model_name(),
        "prompt": prompt,
        "stream": True,
        # See `generate`. With thinking on, a stream emits nothing at all
        # until the reasoning finishes, which defeats the reason to stream.
        "think": THINK,
        "options": {"temperature": temperature, "num_predict": max_tokens},
    }
    if system:
        payload["system"] = system
    if fmt:
        payload["format"] = fmt

    response = _request("/api/generate", payload, timeout=timeout, stream=True)
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
            piece = chunk.get("response") or ""
            if piece:
                yield piece
            if chunk.get("done"):
                break
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        # Reading the body has its own failures, and they arrive here rather
        # than in `_request`: the headers came back fine and the daemon died
        # -- or stalled past the socket timeout -- part way through the
        # answer. Mapped to the same kinds so a caller has one vocabulary.
        reason = getattr(exc, "reason", exc)
        if isinstance(exc, TimeoutError) or "timed out" in str(reason).lower():
            raise OllamaError(
                "timeout", "The local model took too long to answer and was stopped."
            ) from exc
        raise OllamaError(
            "unreachable", "The local model service stopped answering part way through."
        ) from exc
    finally:
        response.close()
