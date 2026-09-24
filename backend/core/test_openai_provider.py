"""The hosted provider, and how the seam chooses between providers.

The free Render instance the college deploys to has 512 MB and a tenth of a
CPU: no local model fits on it. So production AI is a hosted model reached
over the OpenAI-compatible chat-completions API -- Groq, Google Gemini's
compatibility endpoint, OpenRouter, or an Ollama somewhere else -- chosen by
three environment variables. These tests pin three things:

- which provider the seam picks, from what is and is not configured;
- that "nothing configured" is a clean, named state that never touches the
  network (no sentence about a daemon on 127.0.0.1 that was never going to
  be there);
- that the hosted provider speaks the wire format and fails in the same
  vocabulary as the other two, so no screen can tell which one answered.

Everything runs against stubbed HTTP; no key, no network.
"""

from __future__ import annotations

import io
import json
import urllib.error
from unittest.mock import patch

from django.test import Client, SimpleTestCase, TestCase, override_settings

from core.models import Role, User
from core.services import ai, openai_compat
from core.test_harness_provider import _Captured, _Response

KEY = "gsk_test_secret_value_123"

GROQ = dict(
    AI_PROVIDER="",
    AI_API_KEY=KEY,
    AI_BASE_URL="https://api.groq.com/openai/v1",
    AI_MODEL="llama-3.3-70b-versatile",
    AI_FAST_MODEL="llama-3.1-8b-instant",
)

NOTHING = dict(AI_PROVIDER="", AI_API_KEY="", AI_DEFAULT_PROVIDER="none")


def _http_error(url: str, code: int, body: dict | str, headers: dict | None = None):
    raw = body if isinstance(body, str) else json.dumps(body)
    return urllib.error.HTTPError(url, code, "error", headers or {}, io.BytesIO(raw.encode()))


def _models(*ids: str):
    def responder(req):
        assert req.full_url.endswith("/models"), req.full_url
        return _Response(json.dumps({"object": "list", "data": [{"id": i} for i in ids]}).encode())

    return responder


def _completion(text: str):
    def responder(req):
        assert req.full_url.endswith("/chat/completions"), req.full_url
        return _Response(
            json.dumps(
                {"choices": [{"index": 0, "message": {"role": "assistant", "content": text}}]}
            ).encode()
        )

    return responder


def _sse(*pieces: str):
    def responder(req):
        assert req.full_url.endswith("/chat/completions"), req.full_url
        lines = [": keep-alive\n", "\n"]
        for piece in pieces:
            chunk = {"choices": [{"index": 0, "delta": {"content": piece}}]}
            lines += [f"data: {json.dumps(chunk)}\n", "\n"]
        lines.append("data: [DONE]\n")
        return _Response(lines=[line.encode() for line in lines])

    return responder


class _Fresh(SimpleTestCase):
    """Every test starts without a remembered health answer."""

    def setUp(self):
        openai_compat.forget_health()


# --------------------------------------------------------------------------- #
# Which provider                                                              #
# --------------------------------------------------------------------------- #


class TheSeamChoosesAProviderFromWhatIsConfigured(_Fresh):
    @override_settings(**GROQ)
    def test_a_key_alone_selects_the_hosted_provider(self):
        self.assertEqual(ai.provider_name(), "openai")

    @override_settings(**{**GROQ, "AI_PROVIDER": "ollama"})
    def test_an_explicit_provider_wins_over_a_key(self):
        self.assertEqual(ai.provider_name(), "ollama")

    @override_settings(AI_PROVIDER="", AI_API_KEY="", AI_DEFAULT_PROVIDER="ollama")
    def test_a_laptop_with_nothing_set_still_uses_ollama(self):
        self.assertEqual(ai.provider_name(), "ollama")

    @override_settings(**NOTHING)
    def test_production_with_nothing_set_is_not_configured(self):
        self.assertEqual(ai.provider_name(), "none")

    @override_settings(AI_PROVIDER="gemini-direct")
    def test_an_unknown_provider_is_still_refused(self):
        self.assertEqual(ai.health()["code"], "misconfigured")


@override_settings(**NOTHING)
class NotConfiguredIsACleanStateThatNeverTouchesTheNetwork(_Fresh):
    def test_health_says_not_configured_on_both_tiers_without_a_request(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("no request")):
            state = ai.health()
        self.assertFalse(state["ready"])
        self.assertFalse(state["fast_ready"])
        self.assertEqual(state["code"], "not_configured")
        self.assertEqual(state["fast_code"], "not_configured")
        # The owner's complaint, pinned: a production screen must not send
        # anybody to start a daemon on a machine that has none.
        self.assertNotIn("ollama", json.dumps(state).lower())
        self.assertNotIn("127.0.0.1", json.dumps(state))

    def test_available_is_false_and_asking_raises_the_same_code(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("no request")):
            self.assertFalse(ai.available())
            self.assertFalse(ai.available(fast=True))
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "not_configured")

    def test_an_explicit_off_switch_means_the_same(self):
        with override_settings(AI_PROVIDER="none", AI_API_KEY=KEY):
            self.assertEqual(ai.health()["code"], "not_configured")


class AKeyWithoutItsAddressIsMisconfigured(_Fresh):
    @override_settings(**{**GROQ, "AI_BASE_URL": "", "AI_MODEL": ""})
    def test_the_missing_variables_are_named(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("no request")):
            state = ai.health()
        self.assertEqual(state["code"], "misconfigured")
        self.assertIn("AI_BASE_URL", state["detail"])
        self.assertIn("AI_MODEL", state["detail"])
        self.assertNotIn(KEY, json.dumps(state))


# --------------------------------------------------------------------------- #
# Health, from the service's own model list                                   #
# --------------------------------------------------------------------------- #


@override_settings(**GROQ)
class HealthReadsTheModelList(_Fresh):
    def test_both_models_listed_is_ready_and_the_key_is_sent_as_a_bearer(self):
        captured = _Captured(_models("llama-3.3-70b-versatile", "llama-3.1-8b-instant"))
        with patch("urllib.request.urlopen", captured):
            state = ai.health()
        self.assertEqual(state["provider"], "openai")
        self.assertEqual(state["code"], "ready")
        self.assertEqual(state["fast_code"], "ready")
        self.assertEqual(state["model"], "llama-3.3-70b-versatile")
        self.assertTrue(state["hosted"])
        self.assertEqual(state["host"], "api.groq.com")
        req = captured.requests[0]
        self.assertEqual(req.full_url, "https://api.groq.com/openai/v1/models")
        self.assertEqual(req.headers.get("Authorization"), f"Bearer {KEY}")

    def test_the_key_never_appears_in_what_a_screen_is_given(self):
        with patch("urllib.request.urlopen", _Captured(_models("llama-3.3-70b-versatile"))):
            state = ai.health()
        self.assertNotIn(KEY, json.dumps(state))

    def test_a_model_the_service_does_not_offer_is_model_missing_with_the_remedy(self):
        with patch("urllib.request.urlopen", _Captured(_models("llama-3.1-8b-instant"))):
            state = ai.health()
        self.assertEqual(state["code"], "model_missing")
        self.assertIn("AI_MODEL", state["detail"])
        self.assertEqual(state["fast_code"], "ready")

    @override_settings(
        AI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai/",
        AI_MODEL="gemini-3.5-flash",
        AI_FAST_MODEL="",
    )
    def test_gemini_ids_with_a_models_prefix_still_match(self):
        with patch("urllib.request.urlopen", _Captured(_models("models/gemini-3.5-flash"))):
            state = ai.health()
        self.assertEqual(state["code"], "ready")
        # No fast model named means the one model serves both tiers.
        self.assertEqual(state["fast_model"], "gemini-3.5-flash")
        self.assertEqual(state["fast_code"], "ready")

    def test_a_refused_key_is_its_own_state(self):
        err = _http_error(
            "https://api.groq.com/openai/v1/models", 401, {"error": {"message": "Invalid API Key"}}
        )
        with patch("urllib.request.urlopen", side_effect=err):
            state = ai.health()
        self.assertEqual(state["code"], "rejected")
        self.assertIn("AI_API_KEY", state["detail"])
        self.assertNotIn(KEY, json.dumps(state))

    def test_an_unreachable_service_is_service_down_naming_the_host(self):
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            state = ai.health()
        self.assertEqual(state["code"], "service_down")
        self.assertIn("api.groq.com", state["detail"])
        self.assertNotIn("ollama", state["detail"].lower())

    def test_a_health_answer_is_reused_rather_than_asked_on_every_page(self):
        captured = _Captured(_models("llama-3.3-70b-versatile", "llama-3.1-8b-instant"))
        with patch("urllib.request.urlopen", captured):
            ai.health()
            ai.health()
            ai.available(fast=True)
        self.assertEqual(len(captured.requests), 1)


# --------------------------------------------------------------------------- #
# Asking                                                                      #
# --------------------------------------------------------------------------- #


@override_settings(**GROQ)
class AskJsonSpeaksChatCompletions(_Fresh):
    def test_the_request_is_a_chat_completion_in_json_mode_and_the_answer_parses(self):
        captured = _Captured(_completion('{"journals": [{"title": "IEEE Access"}]}'))
        with patch("urllib.request.urlopen", captured):
            out = ai.ask_json("suggest venues", schema={"type": "object"})
        self.assertEqual(out, {"journals": [{"title": "IEEE Access"}]})
        req = captured.requests[0]
        self.assertEqual(req.full_url, "https://api.groq.com/openai/v1/chat/completions")
        self.assertEqual(req.headers.get("Authorization"), f"Bearer {KEY}")
        body = json.loads(req.data.decode())
        self.assertEqual(body["model"], "llama-3.3-70b-versatile")
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertFalse(body.get("stream"))
        self.assertEqual(body["messages"][-1], {"role": "user", "content": "suggest venues"})
        # JSON mode on OpenAI-style services refuses a conversation that never
        # mentions JSON, so the instruction is always there.
        self.assertIn("JSON", body["messages"][0]["content"])

    def test_the_fast_tier_goes_to_the_fast_model(self):
        captured = _Captured(_completion('{"a": 1}'))
        with patch("urllib.request.urlopen", captured):
            ai.ask_json("quick", fast=True)
        self.assertEqual(json.loads(captured.requests[0].data.decode())["model"], "llama-3.1-8b-instant")

    def test_a_service_that_refuses_json_mode_is_asked_again_without_it(self):
        calls = []

        def responder(req, timeout=None):
            body = json.loads(req.data.decode())
            calls.append(body)
            if "response_format" in body:
                raise _http_error(
                    req.full_url, 400,
                    {"error": {"message": "response_format json_object is not supported by this model"}},
                )
            return _completion('{"ok": true}')(req)

        with patch("urllib.request.urlopen", responder):
            out = ai.ask_json("anything")
        self.assertEqual(out, {"ok": True})
        self.assertEqual(len(calls), 2)
        self.assertNotIn("response_format", calls[1])

    def test_a_rate_limit_is_its_own_code_and_says_to_wait(self):
        err = _http_error(
            "https://api.groq.com/openai/v1/chat/completions", 429,
            {"error": {"message": "Rate limit reached"}}, headers={"retry-after": "7"},
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "rate_limited")
        self.assertIn("7", str(caught.exception))

    def test_an_unknown_model_is_model_missing_naming_it(self):
        err = _http_error(
            "https://api.groq.com/openai/v1/chat/completions", 404,
            {"error": {"message": "The model `llama-9` does not exist", "code": "model_not_found"}},
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "model_missing")
        self.assertIn("llama-3.3-70b-versatile", str(caught.exception))

    def test_a_refused_key_never_repeats_the_key(self):
        err = _http_error(
            "https://api.groq.com/openai/v1/chat/completions", 401,
            {"error": {"message": f"Invalid API Key {KEY}"}},
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "rejected")
        self.assertNotIn(KEY, str(caught.exception))

    def test_a_timeout_and_an_outage_map_to_the_codes_the_screens_know(self):
        import socket

        with patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "timeout")
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "unreachable")


class _Body:
    """A response whose body cannot be read, or is not JSON."""

    def __init__(self, raises=None, payload: bytes = b""):
        self._raises = raises
        self._payload = payload
        self.closed = False

    def read(self, *args):
        if self._raises:
            raise self._raises
        return self._payload

    def close(self):
        self.closed = True

    def __iter__(self):
        return iter([])


@override_settings(**GROQ)
class FailuresReadingTheBodyAreStillProviderFailures(_Fresh):
    """Found in review: the body is read after `_request`'s error mapping, so
    a stall mid-body or a login page answering 200 escaped as a raw 500."""

    def test_a_stall_while_reading_the_answer_is_a_timeout(self):
        import socket

        with patch("urllib.request.urlopen", return_value=_Body(raises=socket.timeout("timed out"))):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "timeout")

    def test_a_page_that_is_not_json_is_an_unreadable_answer(self):
        with patch("urllib.request.urlopen", return_value=_Body(payload=b"<html>Sign in</html>")):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "unparsable")

    def test_a_stall_while_reading_the_model_list_is_a_state_not_a_crash(self):
        with patch("urllib.request.urlopen", return_value=_Body(raises=TimeoutError("timed out"))):
            state = ai.health()
        self.assertFalse(state["ready"])
        self.assertEqual(state["code"], "service_down")

    def test_the_response_is_closed_after_reading(self):
        body = _Body(payload=json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode())
        with patch("urllib.request.urlopen", return_value=body):
            ai.ask_json("anything")
        self.assertTrue(body.closed)

    def test_a_rate_limited_model_list_says_so_rather_than_nothing_answering(self):
        err = _http_error(
            "https://api.groq.com/openai/v1/models", 429, {"error": {"message": "slow down"}},
            headers={"retry-after": "12"},
        )
        with patch("urllib.request.urlopen", side_effect=err):
            state = ai.health()
        self.assertEqual(state["code"], "rate_limited")
        self.assertIn("12", state["detail"])
        self.assertNotIn("Nothing is answering", state["detail"])


@override_settings(**GROQ)
class TheWatchedPathReadsServerSentEvents(_Fresh):
    def test_an_error_sent_as_a_bare_string_mid_stream_is_a_provider_error(self):
        def responder(req):
            return _Response(lines=[b'data: {"error": "Rate limit exceeded"}\n'])

        with patch("urllib.request.urlopen", _Captured(responder)):
            with ai.progress_to(ai.Progress(emit=lambda ev: None)):
                with self.assertRaises(ai.AIError) as caught:
                    ai.ask_json("suggest venues")
        self.assertIn("Rate limit exceeded", str(caught.exception))

    def test_progress_sees_the_pieces_and_the_result_parses(self):
        captured = _Captured(_sse('{"a": ', "1}"))
        seen = []
        with patch("urllib.request.urlopen", captured):
            with ai.progress_to(ai.Progress(emit=seen.append)):
                out = ai.ask_json("suggest venues")
        self.assertEqual(out, {"a": 1})
        body = json.loads(captured.requests[0].data.decode())
        self.assertTrue(body["stream"])
        self.assertIn("generating", [e["phase"] for e in seen])

    def test_a_cancelled_watch_raises_cancelled_not_an_error(self):
        with patch("urllib.request.urlopen", _Captured(_sse("par", "tial"))):
            with ai.progress_to(ai.Progress(emit=lambda ev: None, is_cancelled=lambda: True)):
                with self.assertRaises(ai.Cancelled):
                    ai.ask_json("suggest venues")


# --------------------------------------------------------------------------- #
# The thread assistant says where its answer came from                        #
# --------------------------------------------------------------------------- #


class TheAssistantDoesNotClaimAHostedAnswerStayedHere(TestCase):
    def setUp(self):
        openai_compat.forget_health()
        self.user = User.objects.create_user(
            email="ta@x.edu", password=None, name="TA", role=Role.FACULTY, department="CSE"
        )

    def _answer(self):
        from core.services import thread_agent

        with patch.object(ai, "available", return_value=True), patch.object(
            ai, "ask_json", return_value={"answer": "That builds on your scheduling work.", "journals": []}
        ):
            return thread_agent._answer_with_model("would that suit me?", [], self.user)

    @override_settings(**GROQ)
    def test_a_hosted_answer_names_the_service_it_came_from(self):
        said = self._answer()
        self.assertIn("api.groq.com", said)
        self.assertNotIn("on this machine", said)

    @override_settings(AI_PROVIDER="ollama")
    def test_a_local_answer_still_says_it_stayed_on_this_machine(self):
        self.assertIn("on this machine", self._answer())

    @override_settings(**GROQ)
    def test_the_help_text_does_not_promise_nothing_leaves_the_server(self):
        from core.services import thread_agent

        text = thread_agent.help_text()
        self.assertNotIn("nothing leaving the server", text)
        self.assertIn("api.groq.com", text)

    @override_settings(AI_PROVIDER="ollama")
    def test_the_local_help_text_is_unchanged(self):
        from core.services import thread_agent

        self.assertEqual(thread_agent.help_text(), thread_agent.HELP)


# --------------------------------------------------------------------------- #
# What a screen is told                                                       #
# --------------------------------------------------------------------------- #


class TheStatusEndpointIsHonestAboutWhereTextGoes(TestCase):
    def setUp(self):
        openai_compat.forget_health()
        self.user = User.objects.create_user(
            email="f@x.edu", password=None, name="F", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.user)

    @override_settings(**NOTHING)
    def test_nothing_configured_is_a_quiet_200_not_a_daemon_to_start(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("no request")):
            res = self.client.get("/api/discover/status")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertFalse(body["available"])
        self.assertEqual(body["code"], "not_configured")
        self.assertNotIn("127.0.0.1", res.content.decode())

    @override_settings(**GROQ)
    def test_a_hosted_model_says_it_is_hosted_and_where(self):
        with patch("urllib.request.urlopen", _Captured(_models("llama-3.3-70b-versatile"))):
            body = self.client.get("/api/discover/status").json()
        self.assertTrue(body["available"])
        self.assertTrue(body["hosted"])
        self.assertEqual(body["host"], "api.groq.com")
        self.assertNotIn(KEY, json.dumps(body))

    @override_settings(**GROQ)
    def test_the_research_page_is_told_the_same_about_where_text_goes(self):
        from core.services import trends

        with patch("urllib.request.urlopen", _Captured(_models("llama-3.3-70b-versatile"))):
            state = trends.status()
        self.assertEqual((state["hosted"], state["host"]), (True, "api.groq.com"))
        with override_settings(**NOTHING):
            state = trends.status()
        self.assertEqual((state["code"], state["hosted"]), ("not_configured", False))

    @override_settings(**NOTHING)
    def test_an_ai_endpoint_refuses_with_503_rather_than_a_gateway_error(self):
        res = self.client.get("/api/discover/directions")
        self.assertEqual(res.status_code, 503)
