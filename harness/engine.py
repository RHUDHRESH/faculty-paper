"""The Gemma inference engine: two model slots, one generation at a time each.

The harness exists so the college's publication features can ask a model
without sending the college's work to anybody else's computer. This module is
the part that actually holds the weights. It is deliberately small: load a
GGUF, answer a prompt, stream the tokens, stop when asked, let go of memory
when a slot has been idle past its keep-alive.

Design notes that are not obvious from the code:

- **One generation at a time per slot.** llama.cpp decodes into one context;
  two threads sharing it corrupt each other's KV cache. The fast slot has
  its own lock precisely so the interactive tier can answer while a long
  venue search is still running on the considered one -- the same reason the
  backend has two tiers at all.
- **Cancellation is a flag checked between tokens.** A token step is the
  smallest safe checkpoint: the generator yields, the flag is consulted, and
  a cancel is honoured within one step instead of after the whole answer.
  Closing the stream generator also stops decoding, because llama-cpp-python
  decodes lazily -- one token per ``next()`` -- so an abandoned connection
  ends the work with no cancel call at all.
- **Keep-alive is per slot, not global**, for the same asymmetric reason the
  backend sets different values per tier: the fast model is held long
  because its entire value is being warm, the big one is released sooner
  because its reload cost lands on a request that already takes a while.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger("harness.engine")


class EngineError(Exception):
    """Inference did not happen, with a reason the client can act on."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


class RunCancelled(Exception):
    """Somebody asked, through /v1/cancel or a closed connection, to stop."""


#: A generic JSON grammar. Used when the caller asks for JSON without a
#: schema, and as the fallback when a schema cannot be converted -- the
#: backend repairs and re-parses either way, so an unconstrained answer is a
#: quality wrinkle, never a crash.
JSON_GBNF = r"""
root ::= object | array
object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
array ::= "[" ws ( value ("," ws value)* )? "]" ws
value ::= object | array | string | number | boolean | null
string ::= "\"" ( [^"\\] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4}) )* "\"" ws
number ::= "-"? ("0" | [1-9][0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? ws
boolean ::= "true" | "false"
null ::= "null"
ws ::= [ \t\n]*
"""


def parse_duration(text: str) -> float | None:
    """Ollama-style keep-alive: "30m", "0", "-1". Seconds, or None to pin.

    Unparsable values are refused rather than guessed -- a typo in a
    deployment variable should stop the slot from being misconfigured
    quietly, which is the same rule the backend's settings apply.
    """
    text = (text or "").strip()
    if text == "-1":
        return None
    match = re.fullmatch(r"(\d+)(ms|s|m|h)?", text)
    if not match:
        raise EngineError("service_error", f"cannot parse keep_alive {text!r}")
    amount, unit = int(match.group(1)), match.group(2) or "s"
    return amount * {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[unit]


@dataclass
class Slot:
    """One model, its weights, its lock, and how long to hold it."""

    name: str
    keep_alive: float | None
    weights_dir: Path
    n_ctx: int
    n_gpu_layers: int
    _llm: Any = None
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _last_used: float = 0.0

    @property
    def loaded(self) -> bool:
        return self._llm is not None

    def weights_path(self) -> Path:
        return self.weights_dir / f"{self.name}.gguf"

    def acquire(self) -> Any:
        """The model, loaded and locked for one generation.

        Loads on first use (and again after an idle unload) rather than at
        startup, so the container starts in seconds and a slot nobody calls
        costs nothing -- which is also what makes Cloud Run scale-to-zero
        affordable.
        """
        self._lock.acquire()
        try:
            if self._llm is None:
                self._load()
            self._last_used = time.monotonic()
            return self
        except Exception:
            self._lock.release()
            raise

    def release(self) -> None:
        self._lock.release()

    def _load(self) -> None:
        path = self.weights_path()
        if not path.exists():
            self._fetch_from_gcs()
        if not path.exists():
            raise EngineError(
                "model_missing",
                f"model '{self.name}' is not loaded: no weights at {path}",
            )
        started = time.monotonic()
        from llama_cpp import Llama

        self._llm = Llama(
            model_path=str(path),
            n_ctx=self.n_ctx,
            n_gpu_layers=self.n_gpu_layers,
            verbose=False,
        )
        logger.info(
            "slot_loaded model=%s seconds=%.1f", self.name, time.monotonic() - started
        )

    def _fetch_from_gcs(self) -> None:
        """Pull this slot's weights from the college's own bucket.

        The weights are fetched once and kept on the instance disk; a Cloud
        Run container keeps its disk for the lifetime of the instance, so
        this runs on cold start of a new instance, not on every request.
        """
        bucket_name = (os.getenv("HARNESS_GCS_BUCKET") or "").strip()
        if not bucket_name:
            return
        try:
            from google.cloud import storage
        except ImportError:
            logger.warning("gcs_client_missing model=%s", self.name)
            return
        client = storage.Client()
        blob = client.bucket(bucket_name).blob(f"models/{self.name}.gguf")
        self.weights_dir.mkdir(parents=True, exist_ok=True)
        logger.info("weights_fetch model=%s bucket=%s", self.name, bucket_name)
        blob.download_to_filename(str(self.weights_path()))

    def unload(self) -> None:
        with self._lock:
            if self._llm is not None:
                self._llm = None
                logger.info("slot_unloaded model=%s", self.name)

    def idle_seconds(self) -> float:
        if self.loaded:
            return time.monotonic() - self._last_used
        return 0.0


class Engine:
    """The two slots and everything that runs against them."""

    def __init__(self) -> None:
        weights_dir = Path(os.getenv("HARNESS_WEIGHTS_DIR", "/models"))
        self.device = "cuda" if _cuda_available() else "cpu"
        # All layers offloaded when a GPU is built in; 0 keeps it on the CPU,
        # which is the right answer on a small VM and still fast enough for
        # the fast tier.
        n_gpu_layers = int(os.getenv("HARNESS_N_GPU_LAYERS", "-1" if self.device == "cuda" else "0"))
        n_ctx = int(os.getenv("HARNESS_N_CTX", "8192"))
        self.slots: dict[str, Slot] = {}
        for slot_name, env_name, env_keep in (
            ("main", "HARNESS_MAIN_MODEL", "HARNESS_MAIN_KEEP_ALIVE"),
            ("fast", "HARNESS_FAST_MODEL", "HARNESS_FAST_KEEP_ALIVE"),
        ):
            name = (os.getenv(env_name) or "").strip()
            if not name:
                continue
            keep = parse_duration(os.getenv(env_keep, "10m" if slot_name == "main" else "30m"))
            self.slots[slot_name] = Slot(
                name=name,
                keep_alive=keep,
                weights_dir=weights_dir,
                n_ctx=n_ctx,
                n_gpu_layers=n_gpu_layers,
            )
        self._runs: dict[str, threading.Event] = {}
        self._runs_lock = threading.Lock()
        self._reaper = threading.Thread(target=self._reap, name="harness-reaper", daemon=True)
        self._reaper.start()

    def slot_for(self, model: str) -> Slot:
        for slot in self.slots.values():
            if slot.name == model:
                return slot
        raise EngineError("model_missing", f"model '{model}' is not loaded")

    def register_run(self, run_id: str) -> threading.Event:
        flag = threading.Event()
        with self._runs_lock:
            self._runs[run_id] = flag
        return flag

    def cancel(self, run_id: str) -> bool:
        with self._runs_lock:
            flag = self._runs.get(run_id)
        if flag is None:
            return False
        flag.set()
        return True

    def finish_run(self, run_id: str) -> None:
        with self._runs_lock:
            self._runs.pop(run_id, None)

    def chat(
        self,
        *,
        model: str,
        prompt: str,
        system: str | None = None,
        max_tokens: int = 512,
        temperature: float = 0.2,
        fmt: str | dict | None = None,
        keep_alive: str | None = None,
        deadline: float | None = None,
        run_id: str | None = None,
    ) -> Iterator[str]:
        """One answer, in pieces. The only path to the weights."""
        slot = self.slot_for(model)
        if keep_alive:
            # The backend sends its two-tier policy on every call, so the
            # slot's hold-in-memory always matches the tier that is talking.
            slot.keep_alive = parse_duration(keep_alive)
        stop_flag = self._runs.get(run_id) if run_id else None
        grammar = _grammar(fmt)
        slot.acquire()
        try:
            messages = ([{"role": "system", "content": system}] if system else []) + [
                {"role": "user", "content": prompt}
            ]
            stream = slot._llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True,
                grammar=grammar,
            )
            for chunk in stream:
                if stop_flag is not None and stop_flag.is_set():
                    raise RunCancelled()
                if deadline is not None and time.monotonic() > deadline:
                    raise EngineError(
                        "timeout", "The generation ran past its deadline and was stopped."
                    )
                delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                piece = delta.get("content")
                if piece:
                    yield piece
        finally:
            slot.release()

    def _reap(self) -> None:
        """Unload slots idle past their keep-alive.

        None means pinned; 0 means the slot lets go after every answer. The
        reaper is why "0" works at all: there is no hook at the end of a
        generation, only this sweep.
        """
        while True:
            time.sleep(30)
            for slot in self.slots.values():
                if slot.keep_alive is not None and slot.loaded and slot.idle_seconds() > slot.keep_alive:
                    slot.unload()


def _grammar(fmt: str | dict | None):
    """The sampler constraint for a call, or None for free decoding."""
    if not fmt:
        return None
    try:
        from llama_cpp import LlamaGrammar

        if isinstance(fmt, dict) and hasattr(LlamaGrammar, "from_json_schema"):
            return LlamaGrammar.from_json_schema(json.dumps(fmt))
        return LlamaGrammar.from_string(JSON_GBNF)
    except Exception:  # noqa: BLE001 - unconstrained beats broken
        logger.warning("grammar_build_failed fmt=%s", type(fmt).__name__)
        return None


def _cuda_available() -> bool:
    try:
        import llama_cpp

        return bool(getattr(llama_cpp, "llama_supports_gpu_offload", lambda: False)())
    except Exception:  # noqa: BLE001 - no llama_cpp in tests
        return False
