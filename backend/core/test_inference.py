"""Two models, and the ways a caller picks between them.

There is one model for work somebody starts and waits for, and one for work
somebody watches. That is the whole change these tests cover: that both are
configured, that a caller can name a tier, that the two are reported healthy
or missing independently, and that a missing fast model takes nothing else
down with it.

As with the rest of the inference tests, **no daemon is required**. The
transport is stubbed at `urllib.request.urlopen`, which is the boundary
between our code and Ollama, and what is under test is our reading of its
answers. A suite that needed a seven-gigabyte model resident to run is a suite
that does not run.
"""

import io
import json
from unittest.mock import patch

from django.test import TestCase, override_settings

from core.services import ai, ollama


def _reply(payload):
    """Stand in for one urlopen call returning a JSON body."""
    return io.BytesIO(json.dumps(payload).encode())


def _tags(*names):
    """The two calls `health` makes, in the order it makes them."""
    return [
        _reply({"version": "0.33.1"}),
        _reply({"models": [{"name": n} for n in names]}),
    ]


class _Captured:
    """A urlopen stand-in that keeps the request bodies it was given.

    The assertion that matters most here is about what we *sent* -- which
    model, which keep_alive, thinking off -- and that is only visible in the
    request. A stub that returned the right answer while asking the wrong
    model would pass every test written against the return value.
    """

    def __init__(self, response=None):
        self.response = response or {"response": '{"ok": true}'}
        self.payloads: list[dict] = []

    def __call__(self, req, timeout=None):
        body = req.data
        if body:
            self.payloads.append(json.loads(body.decode()))
        return _reply(self.response)

    @property
    def last(self) -> dict:
        return self.payloads[-1]


class TwoModelsAreConfigured(TestCase):
    """Both tiers exist, both have working defaults, both are overridable."""

    def test_both_models_have_defaults_so_an_unconfigured_server_works(self):
        self.assertEqual(ollama.model_name(), "gemma4:12b")
        self.assertEqual(ollama.fast_model_name(), "gemma3:4b")

    def test_the_two_defaults_are_not_the_same_model(self):
        """The point of the pair is that they are different sizes. Defaulting
        both to the same tag would leave the fast path as slow as the slow one
        while looking, from every screen, as though it had been fixed."""
        self.assertNotEqual(ollama.model_name(), ollama.fast_model_name())

    @override_settings(OLLAMA_MODEL="gemma4:26b", OLLAMA_FAST_MODEL="qwen2.5-coder:1.5b")
    def test_each_is_configured_independently(self):
        self.assertEqual(ollama.model_name(), "gemma4:26b")
        self.assertEqual(ollama.fast_model_name(), "qwen2.5-coder:1.5b")

    def test_resolve_model_defaults_to_the_considered_one(self):
        """`fast` defaults to False everywhere, which is what keeps every
        caller written before this change on exactly the tag it was on."""
        self.assertEqual(ollama.resolve_model(), ollama.model_name())
        self.assertEqual(ollama.resolve_model(fast=True), ollama.fast_model_name())

    @override_settings(OLLAMA_KEEP_ALIVE="2m", OLLAMA_FAST_KEEP_ALIVE="30m")
    def test_the_two_tiers_are_held_in_memory_for_different_lengths(self):
        """Both models resident is 11.78 GB on the machine this was measured
        on, leaving 7.5 GB free -- it fits, but not so comfortably that both
        should be pinned. So they are not weighted equally: the small one is
        held because being warm is its entire value, and the large one is let
        go sooner because its 6.4s reload lands on a request that already
        takes a minute and a half."""
        self.assertEqual(ollama.keep_alive(fast=False), "2m")
        self.assertEqual(ollama.keep_alive(fast=True), "30m")
        self.assertNotEqual(ollama.keep_alive(False), ollama.keep_alive(True))


class TheFastPathSelectsTheFastTag(TestCase):
    """`fast=True` changes which model is asked, and nothing else."""

    def test_ask_json_defaults_to_the_considered_model(self):
        stub = _Captured()
        with patch("urllib.request.urlopen", stub):
            ai.ask_json("classify this")
        self.assertEqual(stub.last["model"], "gemma4:12b")

    def test_ask_json_fast_asks_the_small_model(self):
        stub = _Captured()
        with patch("urllib.request.urlopen", stub):
            ai.ask_json("answer this thread", fast=True)
        self.assertEqual(stub.last["model"], "gemma3:4b")

    def test_the_existing_signature_keeps_its_meaning(self):
        """The seam every feature goes through gained a keyword with a
        default. A caller written before this change must still send the same
        request: same model, same schema, same temperature."""
        schema = {"type": "object", "properties": {"answer": {"type": "string"}}}
        stub = _Captured()
        with patch("urllib.request.urlopen", stub):
            ai.ask_json("anything", schema=schema, temperature=0.3)
        sent = stub.last
        self.assertEqual(sent["model"], "gemma4:12b")
        self.assertEqual(sent["format"], schema)
        self.assertEqual(sent["options"]["temperature"], 0.3)

    def test_the_fast_call_still_returns_parsed_json(self):
        """Choosing a tier changes the model, not the contract. A caller must
        not have to parse differently depending on which one answered."""
        stub = _Captured({"response": '{"answer": "Ask the department office."}'})
        with patch("urllib.request.urlopen", stub):
            out = ai.ask_json("who signs this?", fast=True)
        self.assertEqual(out, {"answer": "Ask the department office."})

    def test_the_fast_tier_carries_its_own_keep_alive(self):
        stub = _Captured()
        with patch("urllib.request.urlopen", stub):
            ai.ask_json("slow one")
            slow = stub.last["keep_alive"]
            ai.ask_json("fast one", fast=True)
            fast = stub.last["keep_alive"]
        self.assertEqual(slow, ollama.keep_alive(False))
        self.assertEqual(fast, ollama.keep_alive(True))

    def test_streaming_honours_the_tier_too(self):
        """The watched path -- the one a progress bar reads from -- is a
        different function with its own payload. A tier that applied only to
        the unwatched call would send the venue search's model to every
        feature that happens to show a spinner."""
        stub = _Captured({"response": "x", "done": True})
        with patch("urllib.request.urlopen", stub):
            list(ollama.stream("hello", fast=True))
        self.assertEqual(stub.last["model"], "gemma3:4b")
        self.assertTrue(stub.last["stream"])

    def test_model_name_reports_the_tier_it_was_asked_about(self):
        self.assertEqual(ai.model_name(), "gemma4:12b")
        self.assertEqual(ai.model_name(fast=True), "gemma3:4b")


class HealthCoversBothModels(TestCase):
    """Each model is present or missing on its own, with its own remedy."""

    def test_both_installed_is_ready_on_both_tiers(self):
        with patch("urllib.request.urlopen", side_effect=_tags("gemma4:12b", "gemma3:4b")):
            state = ai.health()
        self.assertTrue(state["ready"])
        self.assertEqual(state["code"], "ready")
        self.assertTrue(state["fast_ready"])
        self.assertEqual(state["fast_code"], "ready")
        self.assertEqual(state["fast_model"], "gemma3:4b")

    def test_the_fast_model_missing_is_its_own_state_with_its_own_command(self):
        """The real state this was built for. The venue search works; the
        thread assistant does not; one `ollama pull` fixes it. A screen told
        only "ready" would be lying to whoever is waiting for a reply."""
        with patch("urllib.request.urlopen", side_effect=_tags("gemma4:12b")):
            state = ai.health()
        self.assertTrue(state["ready"])
        self.assertEqual(state["code"], "ready")
        self.assertFalse(state["fast_ready"])
        self.assertEqual(state["fast_code"], "model_missing")
        self.assertIn("ollama pull gemma3:4b", state["fast_detail"])

    def test_the_considered_model_missing_leaves_the_fast_one_ready(self):
        """The other way round, and it has to be reported the other way round
        too -- naming the wrong tag sends somebody to pull a model they have."""
        with patch("urllib.request.urlopen", side_effect=_tags("gemma3:4b")):
            state = ai.health()
        self.assertFalse(state["ready"])
        self.assertEqual(state["code"], "model_missing")
        self.assertIn("ollama pull gemma4:12b", state["detail"])
        self.assertTrue(state["fast_ready"])
        self.assertEqual(state["fast_code"], "ready")

    def test_a_dead_service_takes_down_both_tiers_and_says_so_once(self):
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            state = ai.health()
        self.assertEqual(state["code"], "service_down")
        self.assertEqual(state["fast_code"], "service_down")
        self.assertIn("Start Ollama", state["fast_detail"])

    def test_available_asks_about_the_tier_it_was_given(self):
        """`available(fast=True)` must not be satisfied by some other model
        being installed, or a caller on the fast tier is told the feature
        works and then meets a 404."""
        with patch("urllib.request.urlopen", side_effect=_tags("gemma4:12b")):
            self.assertTrue(ai.available())
        with patch("urllib.request.urlopen", side_effect=_tags("gemma4:12b")):
            self.assertFalse(ai.available(fast=True))

    @override_settings(OLLAMA_FAST_MODEL="gemma3")
    def test_a_tagless_fast_name_matches_its_tagged_install(self):
        """Same latitude the single-model version gave: Ollama reads a bare
        name as :latest, and somebody configuring this by hand writes
        whichever form they saw in the docs."""
        with patch("urllib.request.urlopen", side_effect=_tags("gemma4:12b", "gemma3:4b")):
            state = ai.health()
        self.assertTrue(state["fast_ready"])

    @override_settings(AI_PROVIDER="olama")
    def test_an_unknown_provider_is_refused_on_both_tiers(self):
        state = ai.health()
        self.assertEqual(state["code"], "misconfigured")
        self.assertEqual(state["fast_code"], "misconfigured")
        self.assertFalse(state["fast_ready"])
        with self.assertRaises(ai.AIError) as caught:
            ai.ask_json("anything", fast=True)
        self.assertEqual(caught.exception.code, "misconfigured")


class AMissingFastModelDoesNotBreakTheMainPath(TestCase):
    """The failure stays where it happened."""

    def test_the_considered_model_still_answers(self):
        stub = _Captured({"response": '{"journals": ["IEEE Access"]}'})
        with patch("urllib.request.urlopen", stub):
            out = ai.ask_json("suggest venues")
        self.assertEqual(out, {"journals": ["IEEE Access"]})

    def test_a_404_on_the_fast_tag_names_the_fast_tag(self):
        """A missing-model error that printed the configured default would
        tell somebody to pull the 12b model they already have, and the actual
        remedy would go unsaid."""
        import urllib.error

        err = urllib.error.HTTPError(
            "http://127.0.0.1:11434/api/generate", 404, "Not Found", {},
            io.BytesIO(b'{"error": "model \'gemma3:4b\' not found"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything", fast=True)
        self.assertEqual(caught.exception.code, "model_missing")
        self.assertIn("gemma3:4b", str(caught.exception))
        self.assertNotIn("gemma4:12b", str(caught.exception))

    def test_a_fast_failure_is_one_call_not_a_provider_outage(self):
        """A 404 on the fast tag must not leave anything sticky behind: the
        next considered call goes out normally."""
        import urllib.error

        err = urllib.error.HTTPError(
            "http://127.0.0.1:11434/api/generate", 404, "Not Found", {},
            io.BytesIO(b'{"error": "model \'gemma3:4b\' not found"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(ai.AIError):
                ai.ask_json("anything", fast=True)

        stub = _Captured({"response": '{"ok": true}'})
        with patch("urllib.request.urlopen", stub):
            self.assertEqual(ai.ask_json("anything"), {"ok": True})
        self.assertEqual(stub.last["model"], "gemma4:12b")

    def test_it_never_silently_falls_back_to_the_other_model(self):
        """The tier a caller asked for is the tier that answers. Quietly
        retrying a failed fast call on the 12b tag would turn an eight-second
        feature into a ninety-second one with nothing on screen to explain the
        wait -- and quietly retrying the other way would put a smaller model's
        answer where a rupee figure gets attached."""
        import urllib.error

        err = urllib.error.HTTPError(
            "http://127.0.0.1:11434/api/generate", 404, "Not Found", {},
            io.BytesIO(b'{"error": "model \'gemma3:4b\' not found"}'),
        )
        calls = []

        def counting(req, timeout=None):
            calls.append(json.loads(req.data.decode())["model"])
            raise err

        with patch("urllib.request.urlopen", counting):
            with self.assertRaises(ai.AIError):
                ai.ask_json("anything", fast=True)
        self.assertEqual(calls, ["gemma3:4b"])


class ThinkingStaysOff(TestCase):
    """The setting that decides whether an HTTP 200 carries anything at all.

    Gemma 4 reasons silently. With thinking on and a token ceiling it spends
    the whole budget reasoning and returns an empty string with
    `done_reason: "length"` -- a success as far as HTTP is concerned, and
    nothing on the screen. It is off, and it is off on both tiers.
    """

    def test_the_flag_is_off(self):
        self.assertFalse(ollama.THINK)

    def test_the_considered_call_sends_thinking_off(self):
        stub = _Captured()
        with patch("urllib.request.urlopen", stub):
            ai.ask_json("anything")
        self.assertIs(stub.last["think"], False)

    def test_the_fast_call_sends_thinking_off_too(self):
        """A second model is a second place for this to be left on, and the
        symptom -- a blank reply from a healthy server -- is the same one that
        took a long time to diagnose the first time."""
        stub = _Captured()
        with patch("urllib.request.urlopen", stub):
            ai.ask_json("anything", fast=True)
        self.assertIs(stub.last["think"], False)

    def test_streaming_sends_thinking_off_on_both_tiers(self):
        stub = _Captured({"response": "x", "done": True})
        with patch("urllib.request.urlopen", stub):
            list(ollama.stream("hello"))
            self.assertIs(stub.last["think"], False)
            list(ollama.stream("hello", fast=True))
            self.assertIs(stub.last["think"], False)

    def test_an_empty_answer_is_an_error_not_an_empty_result(self):
        """This is what the flag prevents, and it must not read as success if
        it ever happens anyway -- a feature that silently produces nothing
        looks identical to one nobody switched on."""
        stub = _Captured({"response": "", "done_reason": "length"})
        with patch("urllib.request.urlopen", stub):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything", fast=True)
        self.assertEqual(caught.exception.code, "empty")

    def test_every_call_is_still_bounded(self):
        """Unchanged, and re-checked per tier: a request with no token ceiling
        is a worker held open until something else times out and blames the
        wrong thing."""
        stub = _Captured()
        with patch("urllib.request.urlopen", stub):
            ai.ask_json("anything", fast=True)
        self.assertGreater(stub.last["options"]["num_predict"], 0)
