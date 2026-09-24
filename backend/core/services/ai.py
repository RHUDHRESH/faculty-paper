"""The one seam every AI feature goes through.

Three providers, and an honest "none":

- ``ollama`` -- a daemon on the developer's own machine. The laptop case.
- ``harness`` -- the college's own inference service for the Gemma models,
  deployed on Google Cloud beside the API and reached over a private
  address.
- ``openai`` -- a hosted model over the OpenAI-compatible chat-completions
  API (Groq, Gemini's compatibility endpoint, OpenRouter, a remote Ollama),
  named by ``AI_BASE_URL``, ``AI_API_KEY`` and ``AI_MODEL``. The free Render
  deployment's case: nothing else fits on 512 MB and a tenth of a CPU.
- ``none`` -- nothing is configured. Every AI screen falls back to what it
  can count without a model, and says so in one line.

How one is chosen (`provider_name`): an explicit ``AI_PROVIDER`` always wins;
otherwise a set ``AI_API_KEY`` means ``openai``; otherwise
``AI_DEFAULT_PROVIDER`` decides, which settings make ``ollama`` on a
developer machine (DEBUG) and ``none`` in production -- so a production site
with no key says "not set up" instead of sending somebody to start a daemon
on a machine that has never had one.

The first two keep a faculty member's unpublished title and abstract on
hardware the college runs; the third sends them to the service it names.
That difference is surfaced rather than hidden: `health` reports ``hosted``
and ``host`` so a screen can say where suggestions come from. An unknown
``AI_PROVIDER`` is still refused rather than quietly resolved -- a typo in a
deployment variable should stop the feature, not silently change where the
text goes -- and **nothing here ever falls back to another provider.** If the
configured one is down, the answer is that it is down.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from django.conf import settings

from core.services import harness, ollama, openai_compat

logger = logging.getLogger(__name__)

#: The providers this understands. ``none`` is a provider in the sense that
#: it is a configured answer -- "not set up" -- rather than an unknown name.
PROVIDERS = ("ollama", "harness", "openai", "none")

#: Said wherever nothing is configured. One sentence, no remedy for a reader
#: who cannot apply one: the operator's remedy is in DEPLOY.md.
NOT_CONFIGURED = "AI suggestions are not set up on this server."

#: How often a running generation reports itself. Every token would be a
#: hundred writes down a socket for an answer nobody reads token by token;
#: twice a second is enough for a counter to look alive and cheap enough to
#: ignore.
PROGRESS_EVERY = 0.5

#: What a nine-journal answer costs on the machine this was measured on:
#: about 450 tokens at roughly 4.5 a second. Published so a screen can draw a
#: bar against something real rather than inventing a percentage.
EXPECTED_TOKENS = 450
EXPECTED_SECONDS = 95

#: The same two numbers for the fast tier, measured the same way on the same
#: machine: about 130 tokens at roughly 14 a second, plus a second of reading
#: the prompt. Kept as separate constants rather than a ratio, because the two
#: models are not one model scaled -- measured here, generation is 3.3x faster
#: on the small one but reading the prompt is closer to 4x, and loading it off
#: disk is 3.1s against 6.4s. A screen drawing a bar against a single guessed
#: ratio would be wrong in the first few seconds, which is the part somebody
#: actually watches.
FAST_EXPECTED_TOKENS = 130
FAST_EXPECTED_SECONDS = 10


class AIError(Exception):
    """Inference did not happen, with a reason worth showing somebody.

    ``code`` is what a screen switches on. The old Gemini module carried the
    same idea and nothing ever read it; here the two discovery endpoints map
    it to distinct HTTP statuses, because "the model is not installed" and
    "the model is thinking too slowly" need different sentences and different
    remedies.
    """

    def __init__(self, message: str, *, code: str = "error"):
        super().__init__(message)
        self.code = code


class Cancelled(Exception):
    """Somebody stopped waiting.

    Not a failure and never reported as one. A request that was cancelled has
    no error to show, no retry to offer and nothing to log at warning level --
    conflating it with "the model broke" produces a red panel for an action
    the reader themselves took.
    """


@dataclass
class Progress:
    """Where a long generation says what it is doing, and how it is stopped.

    Both halves matter and they are the same object on purpose. On this
    hardware an answer is a minute and a half away, so a caller needs to be
    told the wait is moving *and* needs a way to end it; handing those out
    separately is how a screen ends up with a cancel button that stops the
    spinner and leaves the model running.

    `emit` receives one dict per report. `is_cancelled` is consulted once per
    chunk of the answer, so on this hardware a cancellation is acted on within
    about a quarter of a second.
    """

    emit: Callable[[dict[str, Any]], None]
    is_cancelled: Callable[[], bool] = field(default=lambda: False)

    def check(self) -> None:
        if self.is_cancelled():
            raise Cancelled()

    def note(self, phase: str, **fields: Any) -> None:
        """Report a phase. Phases are named here; the words are not.

        `connecting`, `generating` and `reading` say what the model is doing,
        with counts attached. Deliberately no sentences: what "reading" means
        to somebody watching depends on the feature -- one is checking journal
        names against our own tables, the other is not -- and a service that
        writes UI copy for callers it cannot see writes it wrong for one of
        them.
        """
        self.check()
        self.emit({"phase": phase, **fields})


#: The progress sink for the call in flight, if anything is watching.
#:
#: A context variable rather than an argument because the caller that wants
#: the progress and the call that produces it are not adjacent: the request
#: handler streams to the browser, and four frames below it a feature module
#: -- which has no business knowing about HTTP -- asks the model a question.
#: Threading a parameter through would mean every feature grew a progress
#: argument it only forwards.
_SINK: ContextVar[Progress | None] = ContextVar("ai_progress", default=None)


@contextmanager
def progress_to(sink: Progress):
    """Watch whatever inference happens inside this block."""
    token = _SINK.set(sink)
    try:
        yield sink
    finally:
        _SINK.reset(token)


def current_progress() -> Progress | None:
    return _SINK.get()


def provider_name() -> str:
    """Which provider answers, from what is and is not configured.

    An explicit ``AI_PROVIDER`` wins; a key on its own means the hosted
    provider; with neither, ``AI_DEFAULT_PROVIDER`` -- Ollama on a laptop,
    "none" in production (see settings).
    """
    configured = (getattr(settings, "AI_PROVIDER", "") or "").strip().lower()
    if configured:
        return configured
    if (getattr(settings, "AI_API_KEY", "") or "").strip():
        return "openai"
    return (getattr(settings, "AI_DEFAULT_PROVIDER", "") or "ollama").strip().lower()


def _backend():
    """The inference module for the configured provider.

    All three modules expose the same surface -- generate, stream, Stopped,
    an *Error with kind/message, DEFAULT_TIMEOUT, resolve_model, health -- so
    everything below dispatches on this one call.
    """
    name = provider_name()
    if name == "harness":
        return harness
    if name == "openai":
        return openai_compat
    return ollama


def model_name(fast: bool = False) -> str:
    """Which model a call at this tier would actually go to.

    The default argument is the considered model, so callers that ask without
    naming a tier get the same answer they always got.
    """
    name = provider_name()
    if name == "harness":
        return harness.resolve_model(fast)
    if name == "ollama":
        return ollama.resolve_model(fast)
    if name == "openai":
        return openai_compat.resolve_model(fast)
    return ""


def is_hosted() -> bool:
    """Whether a question leaves hardware the college runs."""
    return provider_name() == "openai"


def _off(code: str, detail: str) -> dict[str, Any]:
    """A health answer for a provider that cannot run at all, on both tiers."""
    return {
        "provider": provider_name(),
        "ready": False,
        "code": code,
        "detail": detail,
        "model": "",
        "fast_ready": False,
        "fast_code": code,
        "fast_detail": detail,
        "fast_model": "",
        "hosted": False,
        "host": "",
    }


def health() -> dict[str, Any]:
    """Everything a screen needs to explain itself, in one call.

    Deliberately more than a boolean. "Off" covers three different situations
    -- no service, service but no model, or a provider name nobody recognises
    -- and they have three different remedies. A page that cannot tell them
    apart can only shrug.
    """
    name = provider_name()
    if name not in PROVIDERS:
        return _off(
            "misconfigured",
            f"AI_PROVIDER is set to {name!r}, which this server does not "
            f"recognise. Known providers: {', '.join(PROVIDERS)}.",
        )
    if name == "none":
        # Answered without touching the network: there is nothing to ask.
        return _off("not_configured", NOT_CONFIGURED)
    if name == "openai" and openai_compat.missing_settings():
        missing = openai_compat.missing_settings()
        return _off(
            "misconfigured",
            f"The hosted AI provider needs {', '.join(missing)} set as well. "
            "See DEPLOY.md for the values.",
        )

    backend = _backend()
    state = backend.health()
    out = state.as_dict()
    out["provider"] = name
    out["hosted"] = name == "openai"
    out["host"] = openai_compat.host() if name == "openai" else ""
    failure = getattr(state, "failure", None)
    if failure in ("rejected", "rate_limited"):
        # A refused key and a spent allowance are not a service that is
        # down, and neither is fixed at AI_BASE_URL. Both tiers share the
        # key, so both are in the same state; the provider's own sentence
        # (which says how long to wait) is the one to show.
        out["code"] = out["fast_code"] = failure
        out["detail"] = out["fast_detail"] = state.detail
        return out
    out["code"], out["detail"] = _verdict(state.up, state.model_present, state)
    # Answered separately, because the two tiers fail separately and the
    # remedies are different commands. A server with the considered slot
    # loaded and the fast one missing is `ready` and `fast_model_missing` at
    # once: the venue search works, the thread assistant does not, and a
    # screen told only "ready" would be lying to whoever is waiting for a
    # reply.
    out["fast_code"], out["fast_detail"] = _verdict(
        state.up, state.fast_model_present, state, fast=True
    )
    return out


def _verdict(up: bool, present: bool, state, *, fast: bool = False):
    """One tier's code and the sentence that says what to do about it.

    The remedy names the provider's own fix -- on a laptop that is an
    ``ollama pull``, on the harness it is loading the slot's weights -- so
    the sentence somebody reads is the command they can actually run.
    """
    want = state.fast_model if fast else state.model
    on_harness = provider_name() == "harness"
    if up and present:
        return "ready", None
    if provider_name() == "openai":
        where = openai_compat.host() or state.base_url
        if not up:
            # Nothing answering at all gets the address to check; anything
            # else (a stall, a page that is not JSON, a 5xx) keeps the
            # provider's own sentence, which says what actually happened.
            if getattr(state, "failure", None) not in (None, "unreachable") and state.detail:
                return "service_down", state.detail
            return "service_down", (
                f"Nothing is answering at {where}. Check AI_BASE_URL, and that the "
                "service is up."
            )
        return "model_missing", (
            f"{where} does not offer the model {want!r}. Set "
            f"{'AI_FAST_MODEL' if fast and want != state.model else 'AI_MODEL'} "
            "to a model it lists."
        )
    if not up:
        if on_harness:
            return "service_down", (
                f"No inference harness is answering on {state.base_url}. "
                "Check the harness deployment and reload."
            )
        return "service_down", (
            f"No local model service is answering on {state.base_url}. "
            "Start Ollama and reload."
        )
    if on_harness:
        return "model_missing", (
            f"The harness is up but {want!r} is not loaded on it. "
            "See harness/README.md for loading a slot."
        )
    return "model_missing", (
        f"The local service is running but {want!r} is not installed. "
        f"Run: ollama pull {want}"
    )


def available(fast: bool = False) -> bool:
    """Whether a request at this tier would have something to talk to.

    Kept as the same cheap boolean the endpoints already call, so the shape of
    the call sites does not change. It costs a loopback round trip rather than
    reading a settings string, which is the honest answer to the question --
    a configured key never meant a working model either.

    ``fast=True`` asks about the small model instead, which is a genuinely
    different answer: a caller on the fast tier must not be told the feature
    is available because some other model is installed.
    """
    key = "fast_ready" if fast else "ready"
    try:
        return bool(health().get(key))
    except Exception:  # noqa: BLE001 - never let a health probe break a page
        logger.exception("ai_health_probe_failed")
        return False


def _extract_json(text: str) -> Any:
    """Get a JSON value out of whatever the model actually said.

    Kept from the Gemini module and still needed. Ollama's ``format`` option
    constrains decoding to valid JSON, which removes most of this -- but a
    local model at this size still occasionally stops mid-object when it hits
    the token ceiling, and a fenced block remains the commonest shape when the
    constraint is off.
    """
    if not text or not text.strip():
        raise AIError("The model returned nothing", code="empty")

    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue

    raise AIError("The model did not answer in the shape we asked for", code="unparsable")


def ask_json(
    prompt: str,
    *,
    schema: dict[str, Any] | None = None,
    temperature: float = 0.4,
    timeout: float | None = None,
    fast: bool = False,
) -> Any:
    """Ask for a JSON answer and return it parsed.

    Signature-compatible with the Gemini module this replaces, so the callers
    did not have to change shape to move off a hosted API.

    `schema` is passed to Ollama as a structured-output constraint, which is
    stronger than the hosted equivalent was: the decoder cannot produce
    non-conforming tokens, rather than being asked nicely in the prompt and
    usually complying.

    `fast` chooses the tier. It is a keyword with a default rather than a new
    positional, so nothing that already calls this changes meaning: every
    existing caller keeps going to the considered model. Pass ``fast=True``
    where somebody is waiting with the page open and a right answer in ninety
    seconds is worth less than a good one in eight -- and do not pass it where
    the answer carries money or a venue somebody will submit to, because the
    smaller model is measurably worse at holding a schema and the argument
    that saves that feature is the database check underneath it, not the
    model.

    The choice is the caller's on purpose. Nothing here infers a tier from
    prompt length or time of day: which features can afford which wait is a
    product judgement, and a heuristic that got it wrong would silently
    downgrade the one answer that had a rupee figure attached.
    """
    name = provider_name()
    if name not in PROVIDERS:
        raise AIError(
            f"AI_PROVIDER is set to {name!r}, which this server does not recognise.",
            code="misconfigured",
        )
    if name == "none":
        raise AIError(NOT_CONFIGURED, code="not_configured")
    if name == "openai" and openai_compat.missing_settings():
        raise AIError(
            f"The hosted AI provider needs {', '.join(openai_compat.missing_settings())} set.",
            code="misconfigured",
        )

    backend = _backend()
    sink = _SINK.get()
    seconds = int(timeout or backend.DEFAULT_TIMEOUT)
    try:
        if sink is None:
            raw = backend.generate(
                prompt,
                timeout=seconds,
                max_tokens=_MAX_OUTPUT_TOKENS,
                temperature=temperature,
                fmt=schema or "json",
                fast=fast,
            )
        else:
            raw = _generate_watched(
                prompt,
                sink,
                backend=backend,
                timeout=seconds,
                temperature=temperature,
                fmt=schema or "json",
                fast=fast,
            )
    except (ollama.OllamaError, harness.HarnessError, openai_compat.OpenAIError) as exc:
        # Mapped rather than re-raised, so the endpoints answer the same
        # statuses they always did and a screen written against the old codes
        # keeps working. Every provider raises errors with the same
        # kind/message shape, so one table serves all of them.
        raise AIError(exc.message, code=_CODE_MAP.get(exc.kind, "error")) from exc

    if sink is not None:
        # The model is finished; whatever the caller does with the answer
        # comes next. For the venue search that is resolving every name it
        # produced against our own Scimago and SNIP rows, which is the part
        # worth naming on screen.
        sink.note("reading", chars=len(raw))

    return _extract_json(raw)


def _generate_watched(
    prompt: str,
    sink: Progress,
    *,
    backend,
    timeout: int,
    temperature: float,
    fmt: str | dict,
    fast: bool = False,
) -> str:
    """The same answer as `backend.generate`, assembled where it can be watched.

    Identical output and identical constraint -- the schema is still enforced
    by the decoder -- so the caller parses exactly what it always parsed. The
    only difference is that the wait stops being opaque: the first token says
    the model has finished loading and started answering, and the count says
    it is still going.

    The pieces are collected rather than forwarded because both features here
    parse a whole JSON document at the end. Half of one is not worth showing
    to anybody, and showing it would put a journal name on screen before it
    had been checked against our own tables.
    """
    started = time.monotonic()
    pieces: list[str] = []
    chars = 0
    last_report = 0.0

    # Said before the first token, because the first token is the slow one:
    # a cold model spends about eight seconds coming off disk and more
    # reading the prompt, and silence during that is the whole complaint.
    sink.note("connecting")

    try:
        for piece in backend.stream(
            prompt,
            timeout=timeout,
            max_tokens=_MAX_OUTPUT_TOKENS,
            temperature=temperature,
            fmt=fmt,
            should_stop=sink.is_cancelled,
            fast=fast,
        ):
            pieces.append(piece)
            chars += len(piece)
            now = time.monotonic()
            if now - last_report >= PROGRESS_EVERY:
                last_report = now
                sink.note(
                    "generating",
                    tokens=len(pieces),
                    chars=chars,
                    seconds=round(now - started, 1),
                )
    except (ollama.Stopped, harness.Stopped, openai_compat.Stopped) as exc:
        raise Cancelled() from exc

    sink.note(
        "generating",
        tokens=len(pieces),
        chars=chars,
        seconds=round(time.monotonic() - started, 1),
    )
    return "".join(pieces).strip()


#: How often a run says something even when it has nothing to say. Loading a
#: seven-gigabyte model off disk is eight silent seconds, and a reader is owed
#: a clock that moves through them.
_HEARTBEAT = 1.0

#: Runs in flight in this process, by the token their caller named them with.
#:
#: There has to be a way to stop a run that is not "notice the reader's
#: connection has dropped", because that turns out not to be dependable.
#: Measured here: a browser closing a streaming connection mid-answer was
#: never noticed by the server at all -- the writes into the dead socket kept
#: succeeding, and the model spent another eighty-eight seconds finishing an
#: answer with nowhere to go, with the next request queued behind it. So a
#: cancel is a thing somebody sends, not a thing we infer.
#:
#: Process-local, which is the honest limit of it: with more than one worker
#: process a cancel can land on a worker that has never heard of the token,
#: and `stop` says so rather than pretending. The abandoned run still ends at
#: `OLLAMA_TIMEOUT_SECONDS`, which is what that bound is for.
_RUNS: dict[str, threading.Event] = {}
_RUNS_LOCK = threading.Lock()


def stop(token: str) -> bool:
    """End a run somebody is no longer waiting for. True if it was here."""
    with _RUNS_LOCK:
        flag = _RUNS.get(token)
    if flag is None:
        return False
    flag.set()
    return True


def run_with_progress(
    fn: Callable[..., Any],
    kwargs: dict[str, Any] | None = None,
    *,
    token: str | None = None,
) -> Iterator[tuple[str, Any]]:
    """Run a call that asks the model, and report on it while it runs.

    Yields (kind, value) pairs:

        ("step", {...})     the model reported a phase, with counts
        ("tick", None)      nothing has changed, said so it can be seen
        ("result", value)   the call returned
        ("error", AIError)  it failed in a way somebody can be told about
        ("cancelled", None) somebody stopped waiting

    A cancelled run is its own kind rather than an error, because it is not
    one and must not be shown as one.

    The point of it living here rather than in a request handler: the feature
    modules stay written as ordinary blocking functions -- `suggest_venues`
    reads top to bottom and knows nothing about streaming -- and this is the
    one place that knows a local generation takes ninety seconds and somebody
    is watching it.

    Cancellation is the reason for the thread. The work blocks on a socket for
    a minute and a half, and whatever ends it -- `stop(token)`, or the
    consumer simply abandoning this iterator -- happens somewhere else while
    it does. Either way the flag is set, the generation loop sees it within a
    chunk, and the connection to Ollama closes rather than finishing an answer
    nobody will read.
    """
    outbox: queue.Queue[tuple[str, Any]] = queue.Queue()
    stop_flag = threading.Event()
    sink = Progress(emit=lambda ev: outbox.put(("step", ev)), is_cancelled=stop_flag.is_set)
    if token:
        with _RUNS_LOCK:
            _RUNS[token] = stop_flag
    kwargs = kwargs or {}

    def work() -> None:
        try:
            with progress_to(sink):
                outbox.put(("result", fn(**kwargs)))
        except Cancelled:
            outbox.put(("cancelled", None))
        except AIError as exc:
            outbox.put(("error", exc))
        except Exception as exc:  # noqa: BLE001 - it must reach the consumer
            logger.exception("ai_run_failed fn=%s", getattr(fn, "__name__", fn))
            outbox.put(("error", AIError(str(exc) or "The suggestion failed.", code="error")))
        finally:
            # This ran off the request's thread, so it opened its own database
            # connection. Nobody else will close it.
            from django.db import connections

            connections.close_all()
            outbox.put(("done", None))

    worker = threading.Thread(target=work, name="ai-run", daemon=True)
    worker.start()
    try:
        while True:
            try:
                kind, value = outbox.get(timeout=_HEARTBEAT)
            except queue.Empty:
                # Nothing to say, said anyway: a reader watching a counter
                # that has not moved for eight seconds -- which is what
                # loading the model off disk looks like -- needs to see that
                # the connection is still there.
                yield ("tick", None)
                continue
            if kind == "done":
                return
            yield (kind, value)
            if kind in ("result", "error", "cancelled"):
                return
    finally:
        # Reached on GeneratorExit too, so a consumer that simply stops
        # reading also ends the run -- second line of defence behind an
        # explicit `stop`, and the only one on a server that does notice a
        # dropped connection.
        stop_flag.set()
        if token:
            with _RUNS_LOCK:
                _RUNS.pop(token, None)


#: Generous, because a truncated answer is the main way structured output
#: fails on a local model -- it stops mid-object and the parse throws.
_MAX_OUTPUT_TOKENS = 2048

#: The providers' failure kinds to the codes the endpoints and screens
#: already use. One table for all three, because all three raise these kinds;
#: the last three only a hosted service produces.
_CODE_MAP = {
    "unreachable": "unreachable",
    "timeout": "timeout",
    "model_missing": "model_missing",
    "service_error": "rejected",
    "bad_output": "unparsable",
    "bad_request": "rejected",
    "rejected": "rejected",
    "rate_limited": "rate_limited",
}
