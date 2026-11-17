"""Bring your own API keys: storage, resolution, isolation, every reader, the endpoints.

No real key appears here. Every value is an obvious placeholder, and the network
is replaced wherever a test would otherwise leave the machine.
"""
from __future__ import annotations

import json
import threading
from unittest import mock

import httpx
from django.core.cache import cache
from django.test import Client, TestCase, override_settings

from core.models import AIUsage, AuditLog, Role, SystemSetting, User, UserApiKey
from core.services import ai, ai_harness, integration_checks, integrations, openai_compat, user_keys

COLLEGE = "college-key-0123456789-AAAA"
ALICE = "alice-key-0123456789-ZZ11"
BOB = "bob-key-0123456789-ZZ22"
TOKEN = "inst-token-0123456789-TTTT"
GROQ = "https://api.groq.com/openai/v1"

COLLEGE_AI = dict(
    AI_PROVIDER="", AI_API_KEY=COLLEGE, AI_BASE_URL="https://college-ai.example.test/v1", AI_MODEL="college-model",
    AI_FAST_MODEL="", ANTHROPIC_API_KEY="", SCOPUS_API_KEY=COLLEGE, SCOPUS_INST_TOKEN="college-inst-token-9999",
    OPENALEX_API_KEY="college-openalex-key", SEARCH_CONTACT_EMAIL="college@example.test",
)


def make(email, name, role=Role.FACULTY):
    return User.objects.create_user(email=email, password=None, name=name, role=role)


def put(client, provider, body):
    return client.put(f"/api/me/keys/{provider}", data=json.dumps(body), content_type="application/json")


class Base(TestCase):
    def setUp(self):
        cache.clear()
        integrations.invalidate()
        user_keys.invalidate_policy()
        self.alice = make("alice@x.edu", "Alice")
        self.bob = make("bob@x.edu", "Bob")
        self.admin = make("sa@x.edu", "Admin", Role.SUPER_ADMIN)

    def own(self, user, provider, **data):
        data.setdefault("value", ALICE if user is self.alice else BOB)
        if provider == "ai":
            data.setdefault("kind", "openai")
            data.setdefault("base_url", GROQ)
        return user_keys.save(user, provider, data)

    def policy(self, provider, value):
        user_keys.set_policy(provider, value, self.admin)


@override_settings(**COLLEGE_AI)
class StorageTests(Base):
    def test_encrypted_at_rest_and_no_plaintext_anywhere(self):
        self.own(self.alice, "scopus", inst_token=TOKEN)
        row = UserApiKey.objects.get(user=self.alice, provider="scopus")
        for stored in (row.secret, row.secret_extra, json.dumps(row.options), row.label):
            self.assertNotIn(ALICE, stored)
            self.assertNotIn(TOKEN, stored)
        self.assertEqual(integrations.decrypt(row.secret), ALICE)
        dump = json.dumps(list(UserApiKey.objects.values()), default=str)
        self.assertNotIn(ALICE, dump)
        self.assertNotIn(TOKEN, dump)

    def test_a_key_saved_under_a_lost_server_key_is_reported_not_used(self):
        with override_settings(INTEGRATIONS_KEY="the-key-we-had-before-xxxxxxxx"):
            self.own(self.alice, "scopus")
        with override_settings(INTEGRATIONS_KEY="the-key-we-have-now-yyyyyyyyyy"):
            self.assertEqual(integrations.get("scopus.api_key", user=self.alice), COLLEGE)
            state = next(s for s in user_keys.states_for(self.alice) if s["provider"] == "scopus")
        self.assertFalse(state["has_own_key"])
        self.assertIn("Add it again", state["problem"])

    def test_states_never_carry_a_secret(self):
        self.own(self.alice, "scopus", inst_token=TOKEN)
        raw = json.dumps(user_keys.states_for(self.alice))
        self.assertNotIn(ALICE, raw)
        self.assertNotIn(TOKEN, raw)
        state = next(s for s in user_keys.states_for(self.alice) if s["provider"] == "scopus")
        self.assertEqual(state["masked"], "••••ZZ11")
        self.assertTrue(state["has_inst_token"])


@override_settings(**COLLEGE_AI)
class ResolutionTests(Base):
    def test_default_is_own_preferred(self):
        self.assertEqual(user_keys.policy("scopus"), "own_preferred")

    def test_own_preferred_uses_own_else_college(self):
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), COLLEGE)
        self.own(self.alice, "scopus")
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), ALICE)
        self.assertEqual(integrations.get("scopus.api_key", user=self.bob), COLLEGE)
        self.assertEqual(integrations.get("scopus.api_key", user=None), COLLEGE)
        self.assertEqual(integrations.get("scopus.api_key"), COLLEGE)

    def test_app_value_beats_environment_for_the_college_fallback(self):
        integrations.set_value("scopus.api_key", "app-value-0123456789", self.admin)
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), "app-value-0123456789")
        self.own(self.alice, "scopus")
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), ALICE)

    def test_college_policy_ignores_an_own_key(self):
        self.own(self.alice, "scopus")
        self.policy("scopus", "college")
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), COLLEGE)
        self.assertFalse(user_keys.own_in_use("scopus", self.alice))
        state = next(s for s in user_keys.states_for(self.alice) if s["provider"] == "scopus")
        self.assertTrue(state["ignored"])
        self.assertEqual(state["source"], "college")

    def test_own_required_without_a_key_gives_nothing_and_with_one_gives_theirs(self):
        self.policy("scopus", "own_required")
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), "")
        self.assertTrue(user_keys.blocked("scopus", self.alice))
        self.assertEqual(integrations.get("scopus.api_key", user=None), COLLEGE)  # no person: the college
        self.own(self.alice, "scopus")
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), ALICE)
        self.assertFalse(user_keys.blocked("scopus", self.alice))
        self.assertTrue(user_keys.blocked("scopus", self.bob))

    def test_only_ai_and_scopus_can_be_required(self):
        with self.assertRaises(user_keys.Invalid):
            self.policy("openalex", "own_required")
        with self.assertRaises(user_keys.Invalid):
            self.policy("scopus", "nonsense")

    def test_the_college_institution_token_never_rides_with_a_persons_key(self):
        self.own(self.alice, "scopus")
        self.assertEqual(integrations.get("scopus.inst_token", user=self.alice), "")
        self.assertEqual(integrations.get("scopus.inst_token", user=None), "college-inst-token-9999")
        self.own(self.alice, "scopus", inst_token=TOKEN)
        self.assertEqual(integrations.get("scopus.inst_token", user=self.alice), TOKEN)

    def test_openalex_own_key_and_contact(self):
        self.own(self.alice, "openalex", value="", mailto="alice@lab.example.test")
        self.assertEqual(integrations.get("openalex.mailto", user=self.alice), "alice@lab.example.test")
        self.assertEqual(integrations.get("openalex.api_key", user=self.alice), "")  # never the college's key
        self.own(self.bob, "openalex")
        self.assertEqual(integrations.get("openalex.mailto", user=self.bob), "college@example.test")
        self.assertEqual(integrations.get("openalex.api_key", user=self.bob), BOB)

    def test_ai_openai_compatible_takes_every_field_from_the_person(self):
        self.own(self.alice, "ai", model="llama-x")
        get = lambda n: integrations.get(n, user=self.alice)  # noqa: E731
        self.assertEqual(get("ai.provider"), "openai")
        self.assertEqual(get("ai.api_key"), ALICE)
        self.assertEqual(get("ai.base_url"), GROQ)
        self.assertEqual(get("ai.model"), "llama-x")
        self.assertEqual(get("anthropic.api_key"), "")
        self.assertEqual(integrations.get("ai.base_url", user=self.bob), "https://college-ai.example.test/v1")

    def test_ai_a_known_service_needs_no_model_and_claude_needs_no_address(self):
        self.own(self.alice, "ai")
        self.assertEqual(integrations.get("ai.model", user=self.alice), "llama-3.3-70b-versatile")
        self.own(self.bob, "ai", kind="anthropic", base_url="")
        get = lambda n: integrations.get(n, user=self.bob)  # noqa: E731
        self.assertEqual(get("ai.provider"), "anthropic")
        self.assertEqual(get("anthropic.api_key"), BOB)
        self.assertEqual(get("ai.api_key"), "")
        self.assertEqual(get("ai.model"), "")  # not the college's model, which is another service's

    def test_the_request_scope_names_the_person_and_ends_with_the_request(self):
        self.own(self.alice, "scopus")
        with user_keys.acting_as(self.alice):
            self.assertEqual(integrations.get("scopus.api_key"), ALICE)
            with user_keys.acting_as(None):
                self.assertEqual(integrations.get("scopus.api_key"), COLLEGE)
            self.assertEqual(integrations.get("scopus.api_key"), ALICE)
        self.assertEqual(integrations.get("scopus.api_key"), COLLEGE)

    def test_a_plain_thread_and_a_bound_one(self):
        self.own(self.alice, "scopus")
        seen: dict[str, str] = {}

        def read(tag):
            seen[tag] = integrations.get("scopus.api_key")

        with user_keys.acting_as(self.alice):
            plain = threading.Thread(target=read, args=("plain",))
            bound = threading.Thread(target=user_keys.bind(read), args=("bound",))
            for t in (plain, bound):
                t.start()
                t.join()
        self.assertEqual(seen["plain"], COLLEGE)  # nothing crosses a thread by itself
        self.assertEqual(seen["bound"], ALICE)

    def test_no_scope_means_nothing_is_carried_into_bind(self):
        seen = {}
        t = threading.Thread(target=user_keys.bind(lambda: seen.update(k=integrations.get("scopus.api_key"))))
        t.start()
        t.join()
        self.assertEqual(seen["k"], COLLEGE)


class FakeScopus:
    """Stands in for httpx.Client in the Scopus client and records who was asking."""

    seen: list[dict] = []

    def __init__(self, *a, **k):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, headers=None):
        FakeScopus.seen.append(dict(headers or {}))
        return httpx.Response(200, json={"search-results": {"entry": []}}, headers={"X-RateLimit-Remaining": "7"})


@override_settings(**COLLEGE_AI)
class ReaderTests(Base):
    """Each reader runs on the asking person's key: checked on what leaves the server."""

    def setUp(self):
        super().setUp()
        FakeScopus.seen = []

    def client_for(self, user):
        c = Client()
        c.force_login(user)
        return c

    # --- Scopus -----------------------------------------------------------

    def test_scopus_lookup_in_a_request_uses_the_requesting_persons_key(self):
        from core.services import scopus

        self.own(self.alice, "scopus", inst_token=TOKEN)
        with mock.patch.object(scopus.httpx, "Client", FakeScopus):
            a = self.client_for(self.alice).post("/api/lookup/scopus", data=json.dumps({"doi": "10.1/x"}), content_type="application/json")
            b = self.client_for(self.bob).post("/api/lookup/scopus", data=json.dumps({"doi": "10.1/x"}), content_type="application/json")
        self.assertLess(a.status_code, 500)
        self.assertLess(b.status_code, 500)
        keys = [h["X-ELS-APIKey"] for h in FakeScopus.seen]
        self.assertIn(ALICE, keys)
        self.assertIn(COLLEGE, keys)
        for headers in FakeScopus.seen:
            if headers["X-ELS-APIKey"] == ALICE:
                self.assertEqual(headers.get("X-ELS-Insttoken"), TOKEN)
            else:
                self.assertEqual(headers.get("X-ELS-Insttoken"), "college-inst-token-9999")
        # Alice's key is never in a call made as Bob.
        self.assertEqual(keys.count(ALICE) + keys.count(COLLEGE), len(keys))

    def test_the_scope_is_cleared_after_a_request_so_the_next_job_is_the_colleges(self):
        from core.services import scopus

        self.own(self.alice, "scopus")
        with mock.patch.object(scopus.httpx, "Client", FakeScopus):
            self.client_for(self.alice).post("/api/lookup/scopus", data=json.dumps({"doi": "10.1/x"}), content_type="application/json")
        self.assertEqual(integrations.get("scopus.api_key"), COLLEGE)
        self.assertIsNone(user_keys.current_person())

    def test_scopus_call_is_counted_on_the_persons_key_only(self):
        from core.services import scopus

        self.own(self.alice, "scopus")
        self.own(self.bob, "scopus")
        with mock.patch.object(scopus.httpx, "Client", FakeScopus), user_keys.acting_as(self.alice):
            scopus.scopus_fetch("https://api.elsevier.com/content/x", throttled=True)
            scopus.scopus_fetch("https://api.elsevier.com/content/x", throttled=True)
        a = UserApiKey.objects.get(user=self.alice, provider="scopus")
        b = UserApiKey.objects.get(user=self.bob, provider="scopus")
        self.assertEqual((a.day_calls, a.month_calls), (2, 2))
        self.assertEqual((b.day_calls, b.month_calls), (0, 0))
        self.assertIsNotNone(a.last_used_at)
        self.assertFalse(SystemSetting.objects.filter(key="integration_usage.scopus").exists())
        with mock.patch.object(scopus.httpx, "Client", FakeScopus):
            scopus.scopus_fetch("https://api.elsevier.com/content/x", throttled=True)  # no person
        self.assertEqual(SystemSetting.objects.get(key="integration_usage.scopus").value["day_calls"], 1)
        self.assertEqual(UserApiKey.objects.get(pk=a.pk).day_calls, 2)

    def test_own_required_blocks_scopus_with_the_message_and_a_key_unblocks(self):
        from core.services import scopus

        self.policy("scopus", "own_required")
        with user_keys.acting_as(self.alice):
            with self.assertRaises(scopus.ScopusError) as caught:
                scopus.scopus_fetch("https://api.elsevier.com/content/x", throttled=True)
        self.assertEqual(caught.exception.code, "own_key_required")
        self.assertIn("My API keys", str(caught.exception))
        c = self.client_for(self.alice)
        body = c.post("/api/lookup/candidates", data=json.dumps({"title": "A long enough title about things"}), content_type="application/json")
        self.assertEqual(body.status_code, 200, body.content)
        self.assertEqual(body.json().get("scopus_status"), "own_key_required")
        # A job with no person is not blocked.
        with mock.patch.object(scopus.httpx, "Client", FakeScopus):
            scopus.scopus_fetch("https://api.elsevier.com/content/x", throttled=True)
        self.assertEqual(FakeScopus.seen[-1]["X-ELS-APIKey"], COLLEGE)

    def test_a_person_with_their_own_key_gets_their_own_rate_window(self):
        from core.services import scopus

        self.own(self.alice, "scopus")
        windows = []
        with mock.patch.object(scopus, "_check_rate_limit", side_effect=lambda key="scopus": windows.append(key)), \
                mock.patch.object(scopus.httpx, "Client", FakeScopus):
            with user_keys.acting_as(self.alice):
                scopus.scopus_fetch("https://api.elsevier.com/content/x")
            scopus.scopus_fetch("https://api.elsevier.com/content/x")
        self.assertEqual(windows, [f"scopus:u{self.alice.pk}", "scopus"])

    def test_scout_runs_on_the_scouts_person_not_the_request(self):
        from core.services import scout

        self.own(self.alice, "scopus")
        seen = {}

        def capture(user):
            seen["scopus"] = integrations.get("scopus.api_key")
            seen["blocked"] = user_keys.blocked("ai")
            return {}, {}

        with mock.patch.object(scout, "_scout", side_effect=capture):
            scout.scout(self.alice)
            self.assertEqual(seen["scopus"], ALICE)
            scout.scout(self.bob)
            self.assertEqual(seen["scopus"], COLLEGE)
        with mock.patch.object(scout.integrations, "get", return_value="") as get, \
                mock.patch("core.services.scopus.search_candidates") as search:
            self.assertEqual(scout.scopus_recent(["x"]), [])
        search.assert_not_called()
        self.assertTrue(get.called)

    def test_scout_literature_is_skipped_for_someone_blocked_from_scopus(self):
        from core.services import scout

        self.policy("scopus", "own_required")
        with user_keys.acting_as(self.alice), mock.patch("core.services.scopus._search") as search:
            self.assertEqual(scout.scopus_recent(["topic"]), [])
        search.assert_not_called()

    def test_a_bulk_check_runs_on_the_officers_key(self):
        from core import tasks

        self.own(self.alice, "scopus")
        seen = []
        with mock.patch("core.api._verify_claim", side_effect=lambda claim: seen.append(integrations.get("scopus.api_key"))), \
                mock.patch("core.models.Claim.objects") as claims:
            claims.filter.return_value.first.return_value = mock.Mock(id="c1")
            with mock.patch("core.services.rbac.is_own_claim", return_value=False), \
                    mock.patch("core.models.ClaimAction.objects.create"):
                tasks.run_bulk_verify(["c1"], self.alice.pk)
                tasks.run_bulk_verify(["c1"], self.bob.pk)
                tasks.run_bulk_verify(["c1"], None)
        self.assertEqual(seen, [ALICE, COLLEGE, COLLEGE])

    def test_the_author_sync_uses_their_key_only_when_they_have_one(self):
        from core.services import scopus_sync

        self.own(self.alice, "scopus")
        self.policy("scopus", "own_required")
        got = []
        for user in (self.alice, self.bob):
            user.scopus_author_id = "5700000000"
            user.save(update_fields=["scopus_author_id"])

            def search(query, start, _got=got):
                _got.append(integrations.get("scopus.api_key"))
                return {"search-results": {"entry": [], "opensearch:totalResults": "0"}}

            scopus_sync.sync_user(user, search=search)
        # Bob has none and the college requires one, yet the college's own job is not blocked.
        self.assertEqual(got, [ALICE, COLLEGE])

    # --- OpenAlex ---------------------------------------------------------

    def test_openalex_lookup_params_carry_the_persons_email_and_key(self):
        from core.services import paper_lookup, publications

        self.own(self.alice, "openalex", mailto="alice@lab.example.test")
        with user_keys.acting_as(self.alice):
            params = paper_lookup._openalex_params()
            self.assertEqual(params["mailto"], "alice@lab.example.test")
            self.assertEqual(params["api_key"], ALICE)
            self.assertEqual(publications._params({})["api_key"], ALICE)
        with user_keys.acting_as(self.bob):
            self.assertEqual(paper_lookup._openalex_params()["mailto"], "college@example.test")
            self.assertEqual(paper_lookup._openalex_params()["api_key"], "college-openalex-key")
        self.assertEqual(paper_lookup._openalex_params()["api_key"], "college-openalex-key")

    def test_the_search_fan_out_carries_the_person_into_its_threads(self):
        from core.services.search import upstream

        self.own(self.alice, "openalex", mailto="alice@lab.example.test")
        with user_keys.acting_as(self.alice):
            results, errors = upstream.fan_out({"a": lambda: upstream.contact(), "b": lambda: integrations.get("openalex.api_key")})
        self.assertEqual(errors, {})
        self.assertEqual(results, {"a": "alice@lab.example.test", "b": ALICE})
        results, _ = upstream.fan_out({"a": lambda: upstream.contact()})
        self.assertEqual(results, {"a": "college@example.test"})

    def test_the_scopus_search_cache_is_not_shared_across_keys(self):
        from core.services.search import papers

        self.own(self.alice, "scopus")
        calls = []

        def fake(title=None, limit=10, **_):
            calls.append(integrations.get("scopus.api_key"))
            return []

        with mock.patch("core.services.scopus.search_candidates", side_effect=fake):
            with user_keys.acting_as(self.alice):
                papers.fetch_scopus("graph networks", 5)
                papers.fetch_scopus("graph networks", 5)
            with user_keys.acting_as(self.bob):
                papers.fetch_scopus("graph networks", 5)
        self.assertEqual(calls, [ALICE, COLLEGE])  # Alice's repeat hit her cache; Bob did not get hers

    # --- AI ---------------------------------------------------------------

    def _ai_answer(self, seen):
        def opener(req, timeout):
            seen.append({"auth": req.get_header("Authorization"), "url": req.full_url, "body": json.loads(req.data or b"{}")})

            class Reply:
                def read(self):
                    return json.dumps({"choices": [{"message": {"content": '{"ok": true}'}}],
                                       "usage": {"prompt_tokens": 5, "completion_tokens": 2}}).encode()

                def close(self):
                    pass

            return Reply()

        return opener

    def run_ai(self, user):
        return ai_harness.run("test_feature", system="Answer in JSON.", user=user, model="considered")

    def test_the_ai_harness_calls_the_persons_service_with_their_key_and_model(self):
        seen = []
        self.own(self.alice, "ai", model="llama-x")
        with mock.patch.object(openai_compat, "_open", self._ai_answer(seen)):
            a = self.run_ai(self.alice)
            b = self.run_ai(self.bob)
        self.assertTrue(a.ok, getattr(a, "message", ""))
        self.assertTrue(b.ok)
        self.assertEqual(seen[0]["auth"], f"Bearer {ALICE}")
        self.assertTrue(seen[0]["url"].startswith(GROQ))
        self.assertEqual(seen[0]["body"]["model"], "llama-x")
        self.assertEqual(seen[1]["auth"], f"Bearer {COLLEGE}")
        self.assertTrue(seen[1]["url"].startswith("https://college-ai.example.test/v1"))
        self.assertEqual(seen[1]["body"]["model"], "college-model")

    def test_a_request_inside_the_web_scope_uses_that_scope(self):
        # Viewing as somebody: the harness's user is the viewed person, but the scope says nobody.
        seen = []
        self.own(self.alice, "ai", model="llama-x")
        with mock.patch.object(openai_compat, "_open", self._ai_answer(seen)), user_keys.acting_as(None):
            self.run_ai(self.alice)
        self.assertEqual(seen[0]["auth"], f"Bearer {COLLEGE}")

    def test_an_own_ai_call_is_counted_on_their_key_and_off_the_colleges_ledger(self):
        seen = []
        self.own(self.alice, "ai", model="llama-x")
        with mock.patch.object(openai_compat, "_open", self._ai_answer(seen)):
            self.run_ai(self.alice)
            self.run_ai(self.bob)
        row = UserApiKey.objects.get(user=self.alice, provider="ai")
        self.assertEqual((row.day_calls, row.month_calls), (1, 1))
        flags = {u.user_id: u.own_key for u in AIUsage.objects.filter(outcome="ok")}
        self.assertTrue(flags[self.alice.pk])
        self.assertFalse(flags[self.bob.pk])
        self.assertEqual(integrations._ai_usage()["month"], 1)  # the college's figure leaves Alice's call out

    @override_settings(AI_COLLEGE_MONTHLY_CALLS=1)
    def test_the_college_cap_does_not_stop_or_count_an_own_key(self):
        seen = []
        self.own(self.alice, "ai", model="llama-x")
        with mock.patch.object(openai_compat, "_open", self._ai_answer(seen)):
            self.assertTrue(self.run_ai(self.bob).ok)
            self.assertFalse(self.run_ai(self.bob).ok)  # the college's one call is spent
            self.assertTrue(self.run_ai(self.alice).ok)
            self.assertTrue(self.run_ai(self.alice).ok)

    def test_claude_as_the_persons_kind(self):
        self.own(self.alice, "ai", kind="anthropic", base_url="", model="")
        built = []

        class FakeMessages:
            def create(self, **kwargs):
                block = mock.Mock(type="text", text='{"ok": true}')
                return mock.Mock(content=[block], usage=mock.Mock(input_tokens=1, output_tokens=1), stop_reason="end_turn")

        def fake_client(key=None, **kw):
            built.append(key)
            return mock.Mock(messages=FakeMessages())

        with mock.patch("anthropic.Anthropic", side_effect=lambda api_key=None, **kw: fake_client(api_key)):
            with user_keys.acting_as(self.alice):
                self.assertEqual(ai.provider_name(), "anthropic")
                self.run_ai(self.alice)
        self.assertEqual(set(built), {ALICE})

    def test_own_required_stops_every_ai_path_with_one_message(self):
        self.policy("ai", "own_required")
        with user_keys.acting_as(self.alice):
            health = ai.health()
            self.assertEqual(health["code"], "own_key_required")
            self.assertFalse(ai.available())
            self.assertIn("My API keys", health["detail"])
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("hello")
            self.assertEqual(caught.exception.code, "own_key_required")
            failed = self.run_ai(self.alice)
        self.assertEqual(failed.code, "own_key_required")
        self.assertIn("My API keys", failed.message)
        # Background work with nobody asking is not blocked.
        self.assertNotEqual(ai.health()["code"], "own_key_required")
        self.own(self.alice, "ai", model="m")
        with user_keys.acting_as(self.alice):
            self.assertNotEqual(ai.health().get("code"), "own_key_required")

    def test_health_is_remembered_per_key_not_across_people(self):
        self.own(self.alice, "ai", model="m")
        calls = []

        class State:
            up = True

            def __init__(self, key):
                self.key = key

            def as_dict(self):
                return {"ready": True, "fast_ready": True, "model": "m", "fast_model": "m", "key_seen": self.key}

            model_present = fast_model_present = True
            failure = None
            detail = None
            model = fast_model = "m"
            base_url = ""

        def fake_health(**_):
            key = integrations.get("ai.api_key")
            calls.append(key)
            return State(key)

        with mock.patch.object(openai_compat, "health", fake_health), override_settings(AI_HEALTH_TTL_SECONDS=60):
            with user_keys.acting_as(self.alice):
                one = ai.health()
            with user_keys.acting_as(self.bob):
                two = ai.health()
        self.assertEqual(one["key_seen"], ALICE)
        self.assertEqual(two["key_seen"], COLLEGE)
        self.assertEqual(calls, [ALICE, COLLEGE])

    def test_the_progress_worker_thread_acts_as_the_person(self):
        self.own(self.alice, "ai", model="m")
        seen = []
        with user_keys.acting_as(self.alice):
            out = list(ai.run_with_progress(lambda: seen.append(integrations.get("ai.api_key")) or "done"))
        self.assertIn(("result", "done"), out)
        self.assertEqual(seen, [ALICE])

    def test_a_streamed_answer_runs_each_step_as_the_person(self):
        self.own(self.alice, "ai", model="m")
        seen = []

        def body():
            for _ in range(2):
                seen.append(integrations.get("ai.api_key"))
                yield b"x"

        # Outside any request scope, as a streamed body is.
        self.assertEqual(list(user_keys.scoped(self.alice, body())), [b"x", b"x"])
        self.assertEqual(seen, [ALICE, ALICE])
        self.assertEqual(integrations.get("ai.api_key"), COLLEGE)

    def test_a_service_address_that_points_inside_is_refused(self):
        for bad in ("http://api.groq.com/v1", "https://127.0.0.1/v1", "https://user:pw@api.groq.com/v1",
                    "https://api.groq.com:8443/v1", "ftp://x.example.test"):
            with self.assertRaises(user_keys.Invalid, msg=bad):
                user_keys.save(self.alice, "ai", {"value": ALICE, "kind": "openai", "base_url": bad, "model": "m"})
        with mock.patch("core.services.user_keys.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("10.0.0.5", 443))]):
            with self.assertRaises(user_keys.Invalid):
                user_keys.save(self.alice, "ai", {"value": ALICE, "kind": "openai", "base_url": "https://ai.internal.example.test/v1", "model": "m"})
        with mock.patch("core.services.user_keys.socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 443))]):
            user_keys.save(self.alice, "ai", {"value": ALICE, "kind": "openai", "base_url": "https://ai.public.example.test/v1", "model": "m"})
        self.assertFalse(UserApiKey.objects.filter(user=self.bob).exists())


@override_settings(**COLLEGE_AI)
class EndpointTests(Base):
    def setUp(self):
        super().setUp()
        self.ca, self.cb, self.cs = Client(), Client(), Client()
        self.ca.force_login(self.alice)
        self.cb.force_login(self.bob)
        self.cs.force_login(self.admin)

    def provider(self, client, name):
        body = client.get("/api/me/keys").json()
        return next(p for p in body["providers"] if p["provider"] == name)

    def test_sign_in_is_required_and_everyone_signed_in_may_use_it(self):
        self.assertEqual(Client().get("/api/me/keys").status_code, 401)
        self.assertEqual(Client().put("/api/me/keys/scopus", data="{}", content_type="application/json").status_code, 401)
        for user in (self.alice, self.admin):
            c = Client()
            c.force_login(user)
            self.assertEqual(c.get("/api/me/keys").status_code, 200)

    def test_status_before_and_after_adding_a_key(self):
        before = self.provider(self.ca, "scopus")
        self.assertFalse(before["has_own_key"])
        self.assertEqual(before["source"], "college")
        self.assertEqual(before["policy"], "own_preferred")
        r = put(self.ca, "scopus", {"value": ALICE})
        self.assertEqual(r.status_code, 200, r.content)
        after = self.provider(self.ca, "scopus")
        self.assertTrue(after["has_own_key"])
        self.assertEqual(after["source"], "yours")
        self.assertEqual(after["masked"], "••••ZZ11")
        self.assertNotIn(ALICE, json.dumps(r.json()))
        self.assertNotIn(ALICE, json.dumps(self.ca.get("/api/me/keys").json()))
        self.assertFalse(self.provider(self.cb, "scopus")["has_own_key"])  # Bob sees nothing of Alice's

    def test_validation(self):
        self.assertEqual(put(self.ca, "scopus", {}).status_code, 422)  # nothing to save
        self.assertEqual(put(self.ca, "scopus", {"value": "short"}).status_code, 422)
        self.assertEqual(put(self.ca, "scopus", {"value": "has a space in it 123"}).status_code, 422)
        self.assertEqual(put(self.ca, "ai", {"value": ALICE, "kind": "openai"}).status_code, 422)  # needs an address
        self.assertEqual(put(self.ca, "ai", {"value": ALICE, "kind": "openai", "base_url": "https://ai.unknown-host.test/v1"}).status_code, 422)
        self.assertEqual(put(self.ca, "openalex", {"mailto": "nope"}).status_code, 422)
        self.assertEqual(put(self.ca, "nothing", {"value": ALICE}).status_code, 404)
        self.assertEqual(put(self.ca, "scopus", {"value": ALICE, "extra": 1}).status_code, 422)
        self.assertEqual(self.ca.delete("/api/me/keys/nothing").status_code, 404)

    def test_a_blank_secret_keeps_the_saved_one_and_a_new_one_replaces_it(self):
        put(self.ca, "ai", {"value": ALICE, "kind": "openai", "base_url": GROQ, "model": "one"})
        r = put(self.ca, "ai", {"model": "two"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(integrations.get("ai.api_key", user=self.alice), ALICE)
        self.assertEqual(integrations.get("ai.model", user=self.alice), "two")
        put(self.ca, "ai", {"value": "replacement-key-0123456789"})
        self.assertEqual(integrations.get("ai.api_key", user=self.alice), "replacement-key-0123456789")
        self.assertEqual(UserApiKey.objects.filter(user=self.alice).count(), 1)

    def test_remove(self):
        put(self.ca, "scopus", {"value": ALICE})
        r = self.ca.delete("/api/me/keys/scopus")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["has_own_key"])
        self.assertEqual(integrations.get("scopus.api_key", user=self.alice), COLLEGE)
        self.assertFalse(UserApiKey.objects.filter(user=self.alice).exists())

    def test_own_required_status_says_so_and_a_key_changes_it(self):
        self.policy("scopus", "own_required")
        s = self.provider(self.ca, "scopus")
        self.assertEqual(s["source"], "none")
        self.assertIn("My API keys", s["blocked_message"])
        put(self.ca, "scopus", {"value": ALICE})
        self.assertEqual(self.provider(self.ca, "scopus")["source"], "yours")

    def test_viewing_as_somebody_cannot_change_their_keys(self):
        r = self.cs.post(f"/api/admin/impersonate/{self.alice.id}", "{}", content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(put(self.cs, "scopus", {"value": ALICE}).status_code, 403)
        self.assertEqual(self.cs.delete("/api/me/keys/scopus").status_code, 403)
        self.assertFalse(UserApiKey.objects.exists())

    def test_viewing_as_never_spends_their_key(self):
        self.own(self.alice, "scopus")
        self.cs.post(f"/api/admin/impersonate/{self.alice.id}", "{}", content_type="application/json")
        seen = []

        from core.services import user_keys as uk

        request = mock.Mock(user=self.alice, session={"impersonator_id": self.admin.id})
        with uk.request_scope(request):
            seen.append(integrations.get("scopus.api_key"))
        self.assertEqual(seen, [COLLEGE])

    # --- test endpoint ------------------------------------------------------

    def fake_get(self, status=200, text="", headers=None, calls=None):
        def _get(url, *, headers=None, params=None):
            if calls is not None:
                calls.append({"url": url, "headers": headers, "params": params})
            return httpx.Response(status, text=text or "{}", headers={"X-RateLimit-Remaining": "9"})

        return _get

    def test_the_test_call_uses_their_key_and_records_ok(self):
        put(self.ca, "scopus", {"value": ALICE, "inst_token": TOKEN})
        calls = []
        with mock.patch.object(integration_checks, "_http_get", self.fake_get(calls=calls)):
            r = self.ca.post("/api/me/keys/scopus/test")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertIn("latency_ms", body)
        self.assertEqual(calls[0]["headers"]["X-ELS-APIKey"], ALICE)
        self.assertEqual(calls[0]["headers"]["X-ELS-Insttoken"], TOKEN)
        state = body["provider"]
        self.assertTrue(state["last_test"]["ok"])
        self.assertEqual(state["usage"]["today"], 1)
        row = UserApiKey.objects.get(user=self.alice, provider="scopus")
        self.assertTrue(row.last_test_ok)
        # The college's counters and test record are untouched by a person's test.
        self.assertFalse(SystemSetting.objects.filter(key="integration_usage.scopus").exists())

    def test_a_failed_test_says_why_without_the_key(self):
        put(self.ca, "scopus", {"value": ALICE})
        with mock.patch.object(integration_checks, "_http_get", self.fake_get(status=401, text=f"bad key {ALICE}")):
            r = self.ca.post("/api/me/keys/scopus/test")
        body = r.json()
        self.assertFalse(body["ok"])
        self.assertIn("refused the key", body["message"])
        self.assertNotIn(ALICE, json.dumps(body))
        self.assertFalse(UserApiKey.objects.get(user=self.alice, provider="scopus").last_test_ok)

    def test_each_service_has_a_test(self):
        put(self.ca, "ai", {"value": ALICE, "kind": "openai", "base_url": GROQ, "model": "m"})
        put(self.ca, "openalex", {"mailto": "a@lab.example.test", "value": ALICE})
        put(self.ca, "semanticscholar", {"value": ALICE})
        listing = json.dumps({"data": [{"id": "m"}]})
        calls = []
        with mock.patch.object(integration_checks, "_http_get", self.fake_get(text=listing, calls=calls)):
            for name in ("ai", "openalex", "semanticscholar"):
                r = self.ca.post(f"/api/me/keys/{name}/test")
                self.assertTrue(r.json()["ok"], (name, r.content))
        self.assertEqual(calls[0]["headers"]["Authorization"], f"Bearer {ALICE}")
        self.assertTrue(calls[0]["url"].startswith(GROQ))
        self.assertEqual(calls[1]["params"]["mailto"], "a@lab.example.test")
        self.assertEqual(calls[1]["params"]["api_key"], ALICE)
        self.assertEqual(calls[2]["headers"]["x-api-key"], ALICE)

    def test_a_test_with_nothing_saved_is_not_found(self):
        self.assertEqual(self.ca.post("/api/me/keys/scopus/test").status_code, 404)

    def test_tests_are_limited_to_ten_a_minute(self):
        put(self.ca, "scopus", {"value": ALICE})
        with mock.patch.object(integration_checks, "_http_get", self.fake_get()):
            codes = [self.ca.post("/api/me/keys/scopus/test").status_code for _ in range(11)]
        self.assertEqual(codes[:10], [200] * 10)
        self.assertEqual(codes[10], 429)

    # --- super admin ----------------------------------------------------------

    def test_policy_and_overview_are_for_the_super_admin_only(self):
        self.assertEqual(self.ca.get("/api/admin/keys/overview").status_code, 403)
        r = self.ca.put("/api/admin/keys/policy/scopus", data=json.dumps({"policy": "college"}), content_type="application/json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(Client().get("/api/admin/keys/overview").status_code, 401)
        self.assertEqual(user_keys.policy("scopus"), "own_preferred")

    def test_the_overview_has_names_and_counts_and_never_a_value(self):
        put(self.ca, "scopus", {"value": ALICE, "inst_token": TOKEN})
        put(self.cb, "ai", {"value": BOB, "kind": "openai", "base_url": GROQ})
        UserApiKey.objects.filter(user=self.alice, provider="scopus").update(
            usage_day=user_keys.timezone.localtime().strftime("%Y-%m-%d"), day_calls=3,
            usage_month=user_keys.timezone.localtime().strftime("%Y-%m"), month_calls=12)
        r = self.cs.get("/api/admin/keys/overview")
        self.assertEqual(r.status_code, 200)
        raw = json.dumps(r.json())
        for secret in (ALICE, BOB, TOKEN):
            self.assertNotIn(secret, raw)
        by = {p["provider"]: p for p in r.json()["providers"]}
        self.assertEqual(by["scopus"]["people_with_own_key"], 1)
        self.assertEqual(by["scopus"]["people"][0]["name"], "Alice")
        self.assertEqual((by["scopus"]["people"][0]["calls_today"], by["scopus"]["people"][0]["calls_month"]), (3, 12))
        self.assertEqual(by["ai"]["people"][0]["name"], "Bob")
        self.assertEqual(by["openalex"]["people_with_own_key"], 0)
        self.assertTrue(by["scopus"]["can_require"])
        self.assertFalse(by["openalex"]["can_require"])

    def test_the_policy_is_set_and_validated(self):
        def set_policy(provider, value):
            return self.cs.put(f"/api/admin/keys/policy/{provider}", data=json.dumps({"policy": value}), content_type="application/json")

        self.assertEqual(set_policy("scopus", "own_required").status_code, 200)
        self.assertEqual(user_keys.policy("scopus"), "own_required")
        self.assertEqual(set_policy("openalex", "own_required").status_code, 422)
        self.assertEqual(set_policy("scopus", "whatever").status_code, 422)
        self.assertEqual(set_policy("nothing", "college").status_code, 404)
        self.assertEqual(user_keys.policy("scopus"), "own_required")

    # --- audit ------------------------------------------------------------------

    def test_the_audit_log_records_what_happened_without_any_value(self):
        put(self.ca, "scopus", {"value": ALICE, "inst_token": TOKEN})
        put(self.ca, "scopus", {"value": "replacement-key-0123456789"})
        with mock.patch.object(integration_checks, "_http_get", self.fake_get()):
            self.ca.post("/api/me/keys/scopus/test")
        self.ca.delete("/api/me/keys/scopus")
        self.cs.put("/api/admin/keys/policy/scopus", data=json.dumps({"policy": "college"}), content_type="application/json")
        rows = list(AuditLog.objects.filter(entity="user_key").order_by("created_at"))
        self.assertEqual(
            [r.action for r in rows],
            ["USER_KEY_SET", "USER_KEY_SET", "USER_KEY_TEST", "USER_KEY_CLEAR", "USER_KEY_POLICY"],
        )
        self.assertEqual(rows[0].actor_id, self.alice.pk)
        self.assertEqual(rows[4].actor_id, self.admin.pk)
        self.assertTrue(json.loads(rows[1].detail_json)["replaced"])
        self.assertTrue(json.loads(rows[2].detail_json)["ok"])
        everything = json.dumps(list(AuditLog.objects.values()), default=str)
        for secret in (ALICE, TOKEN, "replacement-key-0123456789"):
            self.assertNotIn(secret, everything)
        # Nor in any stored setting.
        self.assertNotIn(ALICE, json.dumps(list(SystemSetting.objects.values()), default=str))


@override_settings(**COLLEGE_AI)
class OwnRequiredScreensTests(Base):
    """Wherever AI or Scopus is unavailable because the college wants your own key, the person is told so."""

    def setUp(self):
        super().setUp()
        self.policy("ai", "own_required")
        self.policy("scopus", "own_required")
        self.c = Client()
        self.c.force_login(self.alice)

    def test_the_discover_status_says_so(self):
        body = self.c.get("/api/discover/status").json()
        self.assertFalse(body["available"])
        self.assertEqual(body["code"], "own_key_required")
        self.assertIn("My API keys", body["detail"])

    def test_a_venue_search_is_refused_with_the_sentence(self):
        r = self.c.post("/api/discover/venues", data=json.dumps({"title": "A study of graph neural networks"}), content_type="application/json")
        self.assertEqual(r.status_code, 503)
        self.assertIn("My API keys", r.json()["detail"])

    def test_the_research_helper_precheck_batch_check_and_report_studio_say_so(self):
        from core.services import ai_precheck, batch_check_ai, report_ai, research_helper

        with user_keys.acting_as(self.alice):
            health = ai.health()
            self.assertIn("My API keys", research_helper.ai_block(health, self.alice)["detail"])
            self.assertIn("My API keys", batch_check_ai.status()["message"])
            err = ai_precheck._unavailable(health)
            self.assertEqual((err.status, err.code), (403, "own_key_required"))
            with self.assertRaises(report_ai.Refused) as refused:
                report_ai.ask(self.alice, "papers by department")
        self.assertEqual(refused.exception.status, 403)
        self.assertIn("My API keys", refused.exception.message)

    def test_ask_the_data_keeps_working_and_says_why_the_ai_is_off(self):
        from core.services import insights

        with user_keys.acting_as(self.alice):
            self.assertFalse(insights._ai_ready())

    def test_the_paper_finder_names_the_missing_key(self):
        r = self.c.post("/api/lookup/verify", data=json.dumps({"title": "A long enough title about graphs"}), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["scopus_status"], "own_key_required")

    def test_the_person_with_a_key_gets_the_feature_back(self):
        self.own(self.alice, "ai", model="m")
        body = self.c.get("/api/discover/status").json()
        self.assertNotEqual(body["code"], "own_key_required")


class MigrationAndDefaultsTests(TestCase):
    def test_no_policy_row_means_own_preferred_for_everything(self):
        user_keys.invalidate_policy()
        self.assertEqual(user_keys.policies(), {p: "own_preferred" for p in user_keys.USER_PROVIDERS})

    def test_a_setting_without_a_known_provider_is_left_alone(self):
        self.assertIsNone(user_keys.override("nonsense.thing", user_keys.AMBIENT))
