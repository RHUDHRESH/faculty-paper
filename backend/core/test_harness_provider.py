"""The harness provider, through the ai.py seam.

test_inference.py pins the seam's behaviour against the Ollama provider.
These tests pin the same behaviour against the harness provider -- the
college's own inference service -- because the point of the seam is that
the endpoints cannot tell which one answered. If a code, a tier or a
remedy sentence differs between providers, a screen written for one will
lie about the other.

Everything here runs against stubbed HTTP; no weights, no service.
"""

from __future__ import annotations

import json
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from core.services import ai, harness

HARNESS = dict(
    AI_PROVIDER="harness",
    HARNESS_BASE_URL="http://harness.internal:8300",
    HARNESS_MODEL="gemma-3-12b-it-q4_k_m",
    HARNESS_FAST_MODEL="gemma-3-4b-it-q4_k_m",
    HARNESS_TOKEN="",
)

MAIN = "gemma-3-12b-it-q4_k_m"
FAST = "gemma-3-4b-it-q4_k_m"


class _Response:
    """Enough of a urlopen result for json.load and for line iteration."""

    def __init__(self, payload: bytes = b"", lines: list[str] | None = None):
        self._payload = payload
        self._lines = lines or []

    def read(self) -> bytes:
        return self._payload

    def __iter__(self):
        return iter(self._lines)

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _Captured:
    """Records every request so a test can assert what was sent."""

    def __init__(self, responder):
        self.requests: list = []
        self._responder = responder

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        return self._responder(req)


def _health_answer(main_loaded=True, fast_loaded=True):
    def responder(req):
        assert req.full_url.endswith("/health")
        return _Response(
            json.dumps(
                {
                    "ok": True,
                    "version": "1.0.0",
                    "device": "cuda",
                    "slots": {
                        "main": {"name": MAIN, "loaded": main_loaded},
                        "fast": {"name": FAST, "loaded": fast_loaded},
                    },
                }
            ).encode()
        )

    return responder


def _generate_answer(text: str):
    def responder(req):
        assert req.full_url.endswith("/v1/generate")
        return _Response(json.dumps({"text": text, "tokens": 3, "seconds": 0.1}).encode())

    return responder


def _stream_answer(*tokens: str):
    def responder(req):
        assert req.full_url.endswith("/v1/generate-stream")
        lines = [json.dumps({"t": "start", "run_id": "r1"})]
        lines += [json.dumps({"t": "token", "text": t}) for t in tokens]
        lines.append(json.dumps({"t": "done", "tokens": len(tokens), "seconds": 0.2}))
        return _Response(lines=[line + "\n" for line in lines])

    return responder


class TheDefaultProviderIsStillTheLaptop(SimpleTestCase):
    def test_without_settings_the_seam_answers_ollama(self):
        self.assertEqual(ai.provider_name(), "ollama")
        self.assertIn("gemma", ai.model_name())


@override_settings(**HARNESS)
class TheHarnessProviderNamesItsOwnSlots(SimpleTestCase):
    def test_the_seam_reports_the_harness_and_its_models(self):
        self.assertEqual(ai.provider_name(), "harness")
        self.assertEqual(ai.model_name(), MAIN)
        self.assertEqual(ai.model_name(fast=True), FAST)

    def test_the_tiers_are_held_for_the_lengths_the_backend_chose(self):
        self.assertEqual(harness.keep_alive(), "10m")
        self.assertEqual(harness.keep_alive(fast=True), "30m")


@override_settings(**HARNESS)
class HealthIsProviderHonest(SimpleTestCase):
    def test_both_slots_loaded_is_ready_on_both_tiers(self):
        with patch("urllib.request.urlopen", _Captured(_health_answer())):
            state = ai.health()
        self.assertEqual(state["provider"], "harness")
        self.assertEqual(state["code"], "ready")
        self.assertEqual(state["fast_code"], "ready")

    def test_a_missing_fast_slot_is_its_own_state_with_the_harness_remedy(self):
        with patch("urllib.request.urlopen", _Captured(_health_answer(fast_loaded=False))):
            state = ai.health()
        self.assertEqual(state["code"], "ready")
        self.assertEqual(state["fast_code"], "model_missing")
        self.assertIn("not loaded", state["fast_detail"])
        # The laptop remedy would send somebody to run ollama pull on a
        # machine that does not have Ollama.
        self.assertNotIn("ollama", state["fast_detail"])

    def test_a_down_harness_says_which_address_was_tried(self):
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            state = ai.health()
        self.assertEqual(state["code"], "service_down")
        self.assertIn("harness.internal:8300", state["detail"])

    def test_the_shared_secret_rides_along_when_set(self):
        captured = _Captured(_health_answer())
        with override_settings(HARNESS_TOKEN="s3cret"):
            with patch("urllib.request.urlopen", captured):
                ai.health()
        self.assertEqual(captured.requests[0].headers.get("X-harness-token"), "s3cret")


@override_settings(**HARNESS)
class AskJsonWorksThroughTheHarness(SimpleTestCase):
    def test_an_answer_comes_back_parsed_with_the_tier_that_was_asked(self):
        captured = _Captured(_generate_answer('{"venues": [{"name": "J"}]}'))
        with patch("urllib.request.urlopen", captured):
            out = ai.ask_json("suggest venues", fast=True)
        self.assertEqual(out, {"venues": [{"name": "J"}]})
        body = json.loads(captured.requests[0].data.decode())
        self.assertEqual(body["model"], FAST)
        self.assertTrue(body["json"])

    def test_a_down_harness_maps_to_the_codes_the_screens_know(self):
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            with self.assertRaises(ai.AIError) as raised:
                ai.ask_json("suggest venues")
        self.assertEqual(raised.exception.code, "unreachable")

    def test_a_generation_that_never_answers_maps_to_timeout(self):
        def responder(req, timeout=None):
            import socket

            raise socket.timeout("timed out")

        with patch("urllib.request.urlopen", responder):
            with self.assertRaises(ai.AIError) as raised:
                ai.ask_json("suggest venues")
        self.assertEqual(raised.exception.code, "timeout")


@override_settings(**HARNESS)
class TheWatchedPathStreamsThroughTheSameSeam(SimpleTestCase):
    def test_progress_sees_the_pieces_and_the_result_parses(self):
        captured = _Captured(_stream_answer('{"a": ', '1}'))
        with patch("urllib.request.urlopen", captured):
            with ai.progress_to(ai.Progress(emit=lambda ev: None)) as sink:
                out = ai.ask_json("suggest venues", temperature=0.1)
        self.assertEqual(out, {"a": 1})
        body = json.loads(captured.requests[0].data.decode())
        self.assertEqual(body["model"], MAIN)

    def test_a_cancelled_watch_raises_cancelled_not_an_error(self):
        def responder(req):
            return _Response(
                lines=[
                    json.dumps({"t": "start", "run_id": "r1"}) + "\n",
                    json.dumps({"t": "token", "text": "par"}) + "\n",
                ]
            )

        with patch("urllib.request.urlopen", responder):
            with ai.progress_to(
                ai.Progress(emit=lambda ev: None, is_cancelled=lambda: True)
            ):
                with self.assertRaises(ai.Cancelled):
                    ai.ask_json("suggest venues")
