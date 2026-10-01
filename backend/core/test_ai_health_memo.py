"""The model-service health probe is remembered briefly (a11y/speed audit).

`/trends/me` and `/discover/status` probed the model service on every page
load, and a busy service made that probe the whole of the wait (3.6 s and
1.2 s measured on seeded data). `ai._probe` remembers the answer for
`AI_HEALTH_TTL_SECONDS`.
"""

from __future__ import annotations

from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from core.services import ai, ollama


class HealthMemoTests(SimpleTestCase):
    def setUp(self):
        ai._PROBES.clear()
        self.addCleanup(ai._PROBES.clear)

    def _state(self):
        return ollama.Health(
            up=True, model_present=True, model="m", base_url="http://x",
            fast_model="m", fast_model_present=True,
        )

    @override_settings(AI_PROVIDER="ollama", AI_HEALTH_TTL_SECONDS=20)
    def test_second_call_inside_ttl_does_not_probe_again(self):
        with patch.object(ollama, "health", return_value=self._state()) as probe:
            first = ai.health()
            second = ai.health()
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(first["code"], second["code"])

    @override_settings(AI_PROVIDER="ollama", AI_HEALTH_TTL_SECONDS=20)
    def test_expired_entry_probes_again(self):
        with patch.object(ollama, "health", return_value=self._state()) as probe, patch.object(
            ai.time, "monotonic", side_effect=[100.0, 100.0 + 21]
        ):
            ai.health()
            ai.health()
        self.assertEqual(probe.call_count, 2)

    @override_settings(AI_PROVIDER="ollama", AI_HEALTH_TTL_SECONDS=20)
    def test_a_service_known_to_be_down_is_not_waited_for_again(self):
        # A down service is the slow probe (the connection runs to its
        # timeout). Past the TTL the page gets the last answer at once and the
        # look happens in the background (final sweep: 2 s every 20 s).
        down = ollama.Health(
            up=False, model_present=False, model="m", base_url="http://x",
            fast_model="m", fast_model_present=False,
        )
        with patch.object(ollama, "health", return_value=down) as probe, patch.object(
            ai.time, "monotonic", side_effect=[100.0, 100.0 + 21]
        ), patch.object(ai, "_refresh_in_background") as refresh:
            first = ai.health()
            second = ai.health()
        self.assertEqual(probe.call_count, 1)
        refresh.assert_called_once()
        self.assertEqual(first["code"], second["code"])

    @override_settings(AI_PROVIDER="ollama", AI_HEALTH_TTL_SECONDS=0)
    def test_zero_ttl_always_probes(self):
        with patch.object(ollama, "health", return_value=self._state()) as probe:
            ai.health()
            ai.health()
        self.assertEqual(probe.call_count, 2)

    @override_settings(AI_PROVIDER="ollama", AI_HEALTH_TTL_SECONDS=20)
    def test_a_different_probe_function_is_never_answered_from_the_memo(self):
        with patch.object(ollama, "health", return_value=self._state()):
            ai.health()
        with patch.object(ollama, "health", return_value=self._state()) as fresh:
            ai.health()
        self.assertEqual(fresh.call_count, 1)
