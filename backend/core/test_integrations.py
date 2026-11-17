"""The Integrations page: storage, the accessor, every switched reader, the endpoints.

No real key appears here. Every value below is an obvious placeholder, and the
network is replaced wherever a test would otherwise leave the machine.
"""
from __future__ import annotations

import json
from unittest import mock

import httpx
from django.core.management import call_command
from django.core.management.base import CommandError
from django.core.cache import cache
from django.test import Client, TestCase, override_settings

from core.models import AuditLog, Role, SystemSetting, User
from core.services import integration_checks, integrations

SECRET = "sk-test-0123456789abcdef-WXYZ"
OTHER = "env-test-0123456789abcdef-QRST"


def _fake_get(values: dict[str, str]):
    """A stand-in for integrations.get that answers from a dict."""
    return lambda name: values.get(name, "")


class StorageTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)

    def test_round_trip_and_no_plaintext_in_the_row(self):
        token = integrations.encrypt(SECRET)
        self.assertNotIn(SECRET, token)
        self.assertEqual(integrations.decrypt(token), SECRET)

        integrations.set_value("ai.api_key", SECRET, self.admin)
        row = SystemSetting.objects.get(key="integration.ai.api_key")
        self.assertNotIn(SECRET, json.dumps(row.value))
        self.assertTrue(row.value["enc"])
        self.assertEqual(integrations.get("ai.api_key"), SECRET)

    def test_a_plain_setting_is_not_encrypted_but_a_secret_never_is_plain(self):
        integrations.set_value("ai.model", "some-model", self.admin)
        self.assertEqual(SystemSetting.objects.get(key="integration.ai.model").value, {"v": "some-model"})

    def test_the_key_comes_from_integrations_key_when_set(self):
        with override_settings(INTEGRATIONS_KEY="one-long-random-string-for-tests"):
            token = integrations.encrypt(SECRET)
            self.assertEqual(integrations.decrypt(token), SECRET)
        with override_settings(INTEGRATIONS_KEY="a-different-string-entirely-here"):
            self.assertIsNone(integrations.decrypt(token))
        with override_settings(INTEGRATIONS_KEY="", SECRET_KEY="derived-from-the-secret-key"):
            token2 = integrations.encrypt(SECRET)
        with override_settings(INTEGRATIONS_KEY="", SECRET_KEY="derived-from-the-secret-key"):
            self.assertEqual(integrations.decrypt(token2), SECRET)

    def test_a_secret_saved_under_a_lost_key_is_reported_not_crashed_on(self):
        with override_settings(INTEGRATIONS_KEY="the-key-we-had-before-xxxxxxxx"):
            integrations.set_value("ai.api_key", SECRET, self.admin)
        with override_settings(INTEGRATIONS_KEY="the-key-we-have-now-yyyyyyyyyy", AI_API_KEY=""):
            self.assertEqual(integrations.get("ai.api_key"), "")
            state = integrations.field_state("ai.api_key")
        self.assertFalse(state["configured"])
        self.assertIn("Set it again", state["problem"])

    def test_clear_removes_the_row(self):
        integrations.set_value("scopus.api_key", SECRET, self.admin)
        self.assertEqual(integrations.set_value("scopus.api_key", "", self.admin), "cleared")
        self.assertFalse(SystemSetting.objects.filter(key="integration.scopus.api_key").exists())

    def test_validation(self):
        with self.assertRaises(integrations.Invalid):
            integrations.set_value("ai.base_url", "not-a-url", self.admin)
        with self.assertRaises(integrations.Invalid):
            integrations.set_value("openalex.mailto", "nope", self.admin)
        with self.assertRaises(integrations.Invalid):
            integrations.set_value("ai.provider", "skynet", self.admin)
        with self.assertRaises(integrations.Invalid):
            integrations.set_value("ai.api_key", "has a space in it 1234", self.admin)
        with self.assertRaises(integrations.Invalid):
            integrations.set_value("ai.api_key", "short", self.admin)

    def test_mask_shows_only_the_last_four(self):
        masked = integrations.mask(SECRET)
        self.assertTrue(masked.endswith(SECRET[-4:]))
        self.assertNotIn(SECRET[:-4], masked)
        self.assertNotIn(SECRET[:8], masked)
        self.assertEqual(integrations.mask("short-one"), "••••")
        self.assertEqual(integrations.mask(""), "")


class PrecedenceTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)

    @override_settings(SCOPUS_API_KEY=OTHER)
    def test_app_beats_environment_beats_nothing(self):
        self.assertEqual(integrations.resolve("scopus.api_key"), (OTHER, "environment", False))
        integrations.set_value("scopus.api_key", SECRET, self.admin)
        self.assertEqual(integrations.resolve("scopus.api_key"), (SECRET, "app", False))
        integrations.set_value("scopus.api_key", "", self.admin)
        self.assertEqual(integrations.get("scopus.api_key"), OTHER)

    @override_settings(SCOPUS_API_KEY="")
    def test_nothing_set_is_empty(self):
        self.assertEqual(integrations.resolve("scopus.api_key"), ("", "none", False))

    def test_unknown_name_is_refused(self):
        with self.assertRaises(KeyError):
            integrations.get("scopus.password")

    @override_settings(INTEGRATIONS_CACHE_SECONDS=30)
    def test_a_save_is_seen_at_once_even_with_the_memo_on(self):
        integrations.invalidate()
        self.assertEqual(integrations.get("openalex.api_key"), "")
        integrations.set_value("openalex.api_key", SECRET, self.admin)
        self.assertEqual(integrations.get("openalex.api_key"), SECRET)
        integrations.set_value("openalex.api_key", "", self.admin)
        self.assertEqual(integrations.get("openalex.api_key"), "")
        integrations.invalidate()


@override_settings(
    AI_PROVIDER="ollama", AI_API_KEY="", AI_BASE_URL="", AI_MODEL="", ANTHROPIC_API_KEY="",
    SCOPUS_API_KEY="", SCOPUS_INST_TOKEN="", OPENALEX_API_KEY="", SEARCH_CONTACT_EMAIL="",
)
class EveryReaderUsesTheAccessorTests(TestCase):
    """Settings say nothing; the accessor says something; the reader must follow the accessor."""

    def test_ai_provider_name(self):
        from core.services import ai

        with mock.patch.object(integrations, "get", _fake_get({"ai.provider": "Anthropic"})):
            self.assertEqual(ai.provider_name(), "anthropic")
        with mock.patch.object(integrations, "get", _fake_get({"ai.api_key": SECRET})):
            self.assertEqual(ai.provider_name(), "openai")
        with mock.patch.object(integrations, "get", _fake_get({"anthropic.api_key": SECRET})):
            self.assertEqual(ai.provider_name(), "anthropic")

    def test_openai_compatible_settings(self):
        from core.services import openai_compat

        values = {"ai.base_url": "https://ai.example.test/v1/", "ai.api_key": SECRET, "ai.model": "m-1"}
        with mock.patch.object(integrations, "get", _fake_get(values)):
            self.assertEqual(openai_compat.base_url(), "https://ai.example.test/v1")
            self.assertEqual(openai_compat.api_key(), SECRET)
            self.assertEqual(openai_compat.model_name(), "m-1")
            self.assertEqual(openai_compat.missing_settings(), [])

    def test_anthropic_settings(self):
        from core.services import anthropic_provider

        with mock.patch.object(integrations, "get", _fake_get({"anthropic.api_key": SECRET, "ai.model": "c-1"})):
            self.assertEqual(anthropic_provider.api_key(), SECRET)
            self.assertEqual(anthropic_provider.model_name(), "c-1")
            self.assertEqual(anthropic_provider.missing_settings(), [])

    def test_scopus_client_key_and_institution_token(self):
        from core.services import scopus

        values = {"scopus.api_key": SECRET, "scopus.inst_token": "inst-token-0123456789"}
        seen = {}

        class FakeClient:
            def __init__(self, *a, **k):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def get(self, url, headers=None):
                seen["headers"] = headers
                return httpx.Response(200, json={"ok": 1}, headers={"X-RateLimit-Remaining": "41"})

        with mock.patch.object(integrations, "get", _fake_get(values)), mock.patch.object(scopus.httpx, "Client", FakeClient):
            self.assertEqual(scopus._api_key(), SECRET)
            self.assertEqual(scopus.scopus_fetch("https://api.elsevier.com/content/x", throttled=True), {"ok": 1})
        self.assertEqual(seen["headers"]["X-ELS-APIKey"], SECRET)
        self.assertEqual(seen["headers"]["X-ELS-Insttoken"], "inst-token-0123456789")
        # With no accessor value the client refuses, whatever else is around.
        with mock.patch.object(integrations, "get", _fake_get({})):
            with self.assertRaises(scopus.ScopusError):
                scopus._api_key()

    def test_scopus_readers(self):
        from core.services import readiness, scout
        from core.services.search import papers

        with mock.patch.object(integrations, "get", _fake_get({"scopus.api_key": SECRET})):
            self.assertTrue(papers.scopus_configured())
            self.assertTrue(readiness._scopus_check()["ok"])
        with mock.patch.object(integrations, "get", _fake_get({})):
            self.assertFalse(papers.scopus_configured())
            self.assertFalse(readiness._scopus_check()["ok"])
            with mock.patch("core.services.scopus.search_candidates") as search:
                self.assertEqual(scout.scopus_recent(["topic"]), [])
            search.assert_not_called()

    def test_the_sync_command_and_endpoint_follow_the_accessor(self):
        with mock.patch.object(integrations, "get", _fake_get({})):
            with self.assertRaises(CommandError):
                call_command("sync_scopus_authors")
            admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
            c = Client()
            c.force_login(admin)
            self.assertEqual(c.post("/api/admin/publications/scopus-sync").status_code, 400)
        with mock.patch.object(integrations, "get", _fake_get({"scopus.api_key": SECRET})), mock.patch(
            "core.management.commands.sync_scopus_authors.sync_scopus_authors", return_value={"synced": 0, "per_user": {}}
        ) as sync:
            call_command("sync_scopus_authors")
            sync.assert_called_once()

    def test_openalex_key_and_contact_everywhere(self):
        from core.services import citations, paper_lookup, publications
        from core.services.search import upstream

        values = {"openalex.api_key": SECRET, "openalex.mailto": "lab@example.test"}
        with mock.patch.object(integrations, "get", _fake_get(values)):
            self.assertEqual(upstream.contact(), "lab@example.test")
            self.assertEqual(paper_lookup._openalex_params()["api_key"], SECRET)
            self.assertEqual(publications._params({})["api_key"], SECRET)
            with mock.patch.object(upstream, "get_json", return_value={"results": []}) as get_json:
                citations.fetch_counts(["10.1/x"])
            sent = get_json.call_args.args[1]
            self.assertEqual(sent["api_key"], SECRET)
            self.assertEqual(sent["mailto"], "lab@example.test")
        with mock.patch.object(integrations, "get", _fake_get({})):
            self.assertNotIn("api_key", paper_lookup._openalex_params())
            self.assertNotIn("api_key", publications._params({}))

    def test_a_key_saved_in_the_app_reaches_a_real_reader_without_patching(self):
        from core.services import openai_compat

        admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        integrations.set_value("ai.api_key", SECRET, admin)
        self.assertEqual(openai_compat.api_key(), SECRET)


class EndpointTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        self.fac = User.objects.create_user(email="f@x.edu", password=None, name="F", role=Role.FACULTY)
        self.fin = User.objects.create_user(email="fin@x.edu", password=None, name="Fin", role=Role.FINANCE)
        self.c = Client()
        self.c.force_login(self.admin)

    def put(self, name, value):
        return self.c.put(f"/api/admin/integrations/{name}", data=json.dumps({"value": value}), content_type="application/json")

    def test_only_a_super_admin_gets_in(self):
        for user in (self.fac, self.fin):
            c = Client()
            c.force_login(user)
            self.assertEqual(c.get("/api/admin/integrations").status_code, 403)
            self.assertEqual(
                c.put("/api/admin/integrations/ai.api_key", data=json.dumps({"value": SECRET}), content_type="application/json").status_code,
                403,
            )
            self.assertEqual(c.post("/api/admin/integrations/scopus/test").status_code, 403)
        self.assertEqual(Client().get("/api/admin/integrations").status_code, 401)
        self.assertFalse(SystemSetting.objects.filter(key__startswith="integration.").exists())

    @override_settings(AI_API_KEY="", SCOPUS_API_KEY=OTHER, OPENALEX_API_KEY="", ANTHROPIC_API_KEY="")
    def test_the_list_is_masked_and_says_where_each_value_comes_from(self):
        self.assertEqual(self.put("ai.api_key", SECRET).status_code, 200)
        body = self.c.get("/api/admin/integrations").json()
        raw = json.dumps(body)
        self.assertNotIn(SECRET, raw)
        self.assertNotIn(OTHER, raw)
        by = {p["provider"]: p for p in body["providers"]}
        self.assertEqual(set(by), {"ai", "anthropic", "scopus", "openalex"})
        self.assertEqual((by["ai"]["configured"], by["ai"]["source"]), (True, "app"))
        self.assertEqual(by["ai"]["masked"][-4:], SECRET[-4:])
        self.assertEqual((by["scopus"]["configured"], by["scopus"]["source"]), (True, "environment"))
        self.assertEqual(by["scopus"]["masked"][-4:], OTHER[-4:])
        self.assertEqual((by["anthropic"]["configured"], by["anthropic"]["source"]), (False, "none"))
        self.assertEqual(by["anthropic"]["masked"], "")
        self.assertEqual(by["ai"]["usage"], {"today": 0, "month": 0})
        self.assertIsNone(by["scopus"]["rate_limit"])
        key_field = next(f for f in by["ai"]["fields"] if f["name"] == "ai.api_key")
        self.assertEqual(key_field["value"], "")

    def test_the_save_response_never_carries_the_value(self):
        r = self.put("ai.api_key", SECRET)
        self.assertNotIn(SECRET, r.content.decode())

    @override_settings(SCOPUS_API_KEY=OTHER)
    def test_empty_clears_and_the_environment_answers_again(self):
        self.put("scopus.api_key", SECRET)
        self.assertEqual(integrations.get("scopus.api_key"), SECRET)
        r = self.put("scopus.api_key", "")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["source"], "environment")
        self.assertEqual(integrations.get("scopus.api_key"), OTHER)

    def test_bad_input_and_unknown_names(self):
        self.assertEqual(self.put("ai.base_url", "ftp://x").status_code, 422)
        self.assertEqual(self.put("nope.thing", "abcdefgh").status_code, 404)
        self.assertEqual(self.c.post("/api/admin/integrations/nope/test").status_code, 404)
        bad = self.c.put("/api/admin/integrations/ai.model", data=json.dumps({"value": "m", "extra": 1}), content_type="application/json")
        self.assertEqual(bad.status_code, 422)

    def test_audit_records_set_clear_and_test_without_the_value(self):
        self.put("ai.api_key", SECRET)
        self.put("ai.api_key", "")
        with mock.patch.object(integration_checks, "_http_get", return_value=httpx.Response(200, json={"data": []})):
            self.put("anthropic.api_key", SECRET)
            self.c.post("/api/admin/integrations/anthropic/test")
        actions = list(AuditLog.objects.filter(entity="integration").order_by("created_at").values_list("action", "entity_id"))
        self.assertEqual(
            actions,
            [("INTEGRATION_SET", "ai.api_key"), ("INTEGRATION_CLEAR", "ai.api_key"),
             ("INTEGRATION_SET", "anthropic.api_key"), ("INTEGRATION_TEST", "anthropic")],
        )
        for row in AuditLog.objects.all():
            self.assertNotIn(SECRET, (row.detail_json or "") + row.action + (row.entity_id or ""))
            self.assertNotIn(SECRET[:12], row.detail_json or "")

    def test_test_endpoint_ok_records_the_result_and_the_quota(self):
        self.put("scopus.api_key", SECRET)
        reply = httpx.Response(200, json={}, headers={"X-RateLimit-Remaining": "17", "X-RateLimit-Limit": "20000", "X-RateLimit-Reset": "1800000000"})
        with mock.patch.object(integration_checks, "_http_get", return_value=reply) as get:
            r = self.c.post("/api/admin/integrations/scopus/test")
        body = r.json()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(body["ok"])
        self.assertIn("latency_ms", body)
        self.assertEqual(get.call_args.kwargs["headers"]["X-ELS-APIKey"], SECRET)
        self.assertNotIn(SECRET, r.content.decode())
        state = body["provider"]
        self.assertTrue(state["last_test_ok"])
        self.assertIsNotNone(state["last_tested_at"])
        self.assertEqual(state["rate_limit"]["remaining"], 17)
        self.assertEqual(state["rate_limit"]["limit"], 20000)
        self.assertEqual(state["usage"], {"today": 1, "month": 1})
        again = self.c.get("/api/admin/integrations").json()
        self.assertTrue(next(p for p in again["providers"] if p["provider"] == "scopus")["last_test_ok"])

    def test_test_endpoint_reports_failures_in_plain_words(self):
        self.put("scopus.api_key", SECRET)
        cases = [
            (httpx.Response(403, text=f"denied for {SECRET}"), "refused the key"),
            (httpx.Response(429), "used up"),
            (httpx.Response(503), "having trouble"),
            (httpx.ConnectError("boom"), "could not be reached"),
            (httpx.ReadTimeout("slow"), "did not answer"),
            (RuntimeError(f"weird {SECRET}"), "could not be completed"),
        ]
        for outcome, words in cases:
            side = {"side_effect": outcome} if isinstance(outcome, Exception) else {"return_value": outcome}
            with mock.patch.object(integration_checks, "_http_get", **side):
                r = self.c.post("/api/admin/integrations/scopus/test")
            self.assertEqual(r.status_code, 200)
            body = r.json()
            self.assertFalse(body["ok"], words)
            self.assertIn(words, body["message"])
            self.assertNotIn(SECRET, r.content.decode())
            self.assertNotIn("Traceback", r.content.decode())
        self.assertFalse(self.c.get("/api/admin/integrations").json()["providers"][2]["last_test_ok"])

    def test_an_unset_provider_is_told_to_set_it_first(self):
        with override_settings(OPENALEX_API_KEY=""), mock.patch.object(integration_checks, "_http_get") as get:
            for provider in ("ai", "anthropic", "scopus"):
                with override_settings(AI_API_KEY="", AI_BASE_URL="", ANTHROPIC_API_KEY="", SCOPUS_API_KEY=""):
                    body = self.c.post(f"/api/admin/integrations/{provider}/test").json()
                self.assertFalse(body["ok"])
                self.assertIn("first", body["message"])
        get.assert_not_called()

    def test_ai_and_openalex_checks(self):
        self.put("ai.base_url", "https://ai.example.test/v1")
        self.put("ai.api_key", SECRET)
        self.put("ai.model", "m-1")
        listing = httpx.Response(200, json={"data": [{"id": "m-1"}, {"id": "m-2"}]})
        with mock.patch.object(integration_checks, "_http_get", return_value=listing) as get:
            body = self.c.post("/api/admin/integrations/ai/test").json()
        self.assertTrue(body["ok"])
        self.assertIn("m-1 is available", body["message"])
        self.assertEqual(get.call_args.args[0], "https://ai.example.test/v1/models")
        self.assertEqual(get.call_args.kwargs["headers"]["Authorization"], f"Bearer {SECRET}")
        with mock.patch.object(integration_checks, "_http_get", return_value=httpx.Response(200, json={"results": []})) as get:
            body = self.c.post("/api/admin/integrations/openalex/test").json()
        self.assertTrue(body["ok"])
        self.assertEqual(get.call_args.kwargs["params"]["per-page"], 1)
        self.assertIn("mailto", get.call_args.kwargs["params"])

    def test_the_test_endpoint_is_rate_limited(self):
        self.put("anthropic.api_key", SECRET)
        with mock.patch.object(integration_checks, "_http_get", return_value=httpx.Response(200, json={})):
            codes = [self.c.post("/api/admin/integrations/anthropic/test").status_code for _ in range(12)]
        self.assertEqual(codes[:10], [200] * 10)
        self.assertEqual(codes[10:], [429, 429])

    def test_openalex_calls_made_by_the_app_are_counted(self):
        from core.services.search import upstream

        with mock.patch.object(upstream.httpx, "Client") as client:
            client.return_value.__enter__.return_value.get.return_value = httpx.Response(
                200, json={}, request=httpx.Request("GET", "https://api.openalex.org/works")
            )
            upstream.get_json("https://api.openalex.org/works", {})
            upstream.get_json("https://api.crossref.org/works", {})
        usage = {p["provider"]: p for p in self.c.get("/api/admin/integrations").json()["providers"]}["openalex"]["usage"]
        self.assertEqual(usage, {"today": 1, "month": 1})
