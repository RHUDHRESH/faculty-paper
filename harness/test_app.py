"""The harness's own tests. They run with no weights and no GPU.

The engine is the one thing that needs gigabytes, so these tests inject a
fake one that streams canned tokens through the real app: the protocol, the
auth, the cancellation and the error vocabulary are what get exercised,
because those are the contract the Django client depends on.

Run:  python -m pytest test_app.py -q
"""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app as app_module  # noqa: E402
from engine import Engine, EngineError, RunCancelled  # noqa: E402


class FakeSlot:
    def __init__(self, name: str):
        self.name = name
        self.loaded = True
        self.keep_alive = None


class FakeEngine:
    """The Engine's surface, minus the weights.

    chat() streams three tokens, honours the cancel flag like the real one
    does (checked between tokens), and raises the same EngineError kinds the
    real engine raises for a missing model.
    """

    device = "cpu"

    def __init__(self):
        self.slots = {
            "main": FakeSlot("gemma-3-12b-it-q4_k_m"),
            "fast": FakeSlot("gemma-3-4b-it-q4_k_m"),
        }
        self._runs: dict[str, threading.Event] = {}
        self.cancelled: list[str] = []

    def slot_for(self, model: str) -> FakeSlot:
        for slot in self.slots.values():
            if slot.name == model:
                return slot
        raise EngineError("model_missing", f"model '{model}' is not loaded")

    def register_run(self, run_id: str) -> threading.Event:
        self._runs[run_id] = threading.Event()
        return self._runs[run_id]

    def cancel(self, run_id: str) -> bool:
        self.cancelled.append(run_id)
        return bool(self._runs.get(run_id))

    def finish_run(self, run_id: str) -> None:
        self._runs.pop(run_id, None)

    def chat(self, **kwargs) -> ...:
        model = kwargs["model"]
        self.slot_for(model)  # raises model_missing for an unknown slot
        flag = self._runs.get(kwargs.get("run_id")) if kwargs.get("run_id") else None
        for token in ("Hel", "lo ", "world"):
            if flag is not None and flag.is_set():
                raise RunCancelled()
            yield token


class CancelMidway(FakeEngine):
    """Same surface, but a cancel lands after the first token."""

    def chat(self, **kwargs) -> ...:
        self.slot_for(kwargs["model"])
        flag = self._runs.get(kwargs.get("run_id")) if kwargs.get("run_id") else None
        for i, token in enumerate(("Hel", "lo ", "world")):
            if i == 1 and flag is not None:
                flag.set()  # the /v1/cancel call arriving mid-generation
            if flag is not None and flag.is_set():
                raise RunCancelled()
            yield token


@pytest.fixture()
def client(monkeypatch):
    app_module.engine = FakeEngine()
    monkeypatch.delenv("HARNESS_TOKEN", raising=False)
    return TestClient(app_module.app)


def test_health_reports_both_slots(client):
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["slots"]["main"]["name"] == "gemma-3-12b-it-q4_k_m"
    assert body["slots"]["fast"]["loaded"] is True


def test_generate_returns_the_whole_answer_and_counts(client):
    body = client.post(
        "/v1/generate",
        json={"model": "gemma-3-4b-it-q4_k_m", "prompt": "hi"},
    ).json()
    assert body["text"] == "Hello world"
    assert body["tokens"] == 3
    assert "seconds" in body


def test_generate_names_the_missing_model(client):
    response = client.post(
        "/v1/generate", json={"model": "gemma-2-27b", "prompt": "hi"}
    )
    assert response.status_code == 404
    assert response.json()["detail"]["error"]["kind"] == "model_missing"
    assert "gemma-2-27b" in response.json()["detail"]["error"]["message"]


def test_stream_emits_start_tokens_done_in_order(client):
    lines = [
        line
        for line in client.post(
            "/v1/generate-stream",
            json={"model": "gemma-3-12b-it-q4_k_m", "prompt": "hi"},
        ).iter_lines()
        if line.strip()
    ]
    import json as jsonlib

    parsed = [jsonlib.loads(line) for line in lines]
    assert parsed[0]["t"] == "start" and parsed[0]["run_id"]
    assert [p["text"] for p in parsed[1:4]] == ["Hel", "lo ", "world"]
    assert parsed[-1]["t"] == "done" and parsed[-1]["tokens"] == 3


def test_cancel_ends_a_running_stream(client):
    """A cancel that lands mid-generation ends the stream, marked stopped.

    The line is {"t":"done","stopped":true}, not an error -- a cancelled
    run is not a failure, and the Django client depends on that distinction
    to keep a reader's cancel button from painting a red panel.
    """
    import json as jsonlib

    app_module.engine = CancelMidway()
    cancelling = TestClient(app_module.app)
    response = cancelling.post(
        "/v1/generate-stream",
        json={"model": "gemma-3-4b-it-q4_k_m", "prompt": "hi"},
    )
    assert response.status_code == 200
    parsed = [jsonlib.loads(line) for line in response.iter_lines() if line.strip()]
    assert parsed[-1] == {"t": "done", "stopped": True, "tokens": 1}


def test_a_token_is_required_when_one_is_configured(monkeypatch):
    monkeypatch.setenv("HARNESS_TOKEN", "s3cret")
    app_module.engine = FakeEngine()
    fresh = TestClient(app_module.app)
    assert fresh.get("/health").status_code == 403
    assert (
        fresh.get("/health", headers={"X-Harness-Token": "wrong"}).status_code == 403
    )
    assert fresh.get("/health", headers={"X-Harness-Token": "s3cret"}).status_code == 200


def test_parse_duration_understands_the_ollama_vocabulary():
    from engine import parse_duration

    assert parse_duration("30m") == 1800
    assert parse_duration("0") == 0
    assert parse_duration("-1") is None
    with pytest.raises(EngineError):
        parse_duration("soon")


def test_engine_boots_with_no_slots_configured(monkeypatch):
    """No weights anywhere: the engine still starts, and refuses by slot.

    The harness container starts before its weights arrive -- health must
    answer, and a generation must say the model is missing rather than
    crash the process.
    """
    monkeypatch.setenv("HARNESS_WEIGHTS_DIR", "/nonexistent")
    for var in ("HARNESS_MAIN_MODEL", "HARNESS_FAST_MODEL"):
        monkeypatch.setenv(var, "gemma-3-4b-it-q4_k_m" if var.endswith("FAST_MODEL") else "gemma-3-12b-it-q4_k_m")
    real = Engine()
    assert real.device == "cpu"
    slot = real.slot_for("gemma-3-12b-it-q4_k_m")
    try:
        slot.acquire()  # no weights on disk and no bucket to pull from
        raise AssertionError("expected model_missing")
    except EngineError as exc:
        assert exc.kind == "model_missing"
        assert "gemma-3-12b-it-q4_k_m" in exc.message
