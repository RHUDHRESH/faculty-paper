"""Claude provider and research scout, with the SDK client mocked. No network, no key."""

from __future__ import annotations

import json
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch

import anthropic
import httpx
from django.test import Client, SimpleTestCase, TestCase, override_settings

from core.models import Authorship, Publication, Role, ScoutRun, User
from core.services import ai, anthropic_provider, scout

KEY = "sk-ant-test-secret-123"
CLAUDE = dict(AI_PROVIDER="", AI_API_KEY="", ANTHROPIC_API_KEY=KEY, AI_MODEL="", AI_FAST_MODEL="")


def _msg(text: str, **extra):
    return NS(content=[NS(type="text", text=text, citations=None)], stop_reason="end_turn",
              usage=NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=0, server_tool_use=None),
              **extra)


def _status_error(cls, code: int):
    req = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(f"boom {KEY}", response=httpx.Response(code, request=req), body=None)


@override_settings(**CLAUDE)
class ProviderTests(SimpleTestCase):
    def test_selected_by_key_and_default_model(self):
        self.assertEqual(ai.provider_name(), "anthropic")
        self.assertEqual(ai.model_name(), "claude-haiku-4-5")
        self.assertTrue(ai.is_hosted())

    @override_settings(AI_PROVIDER="anthropic", ANTHROPIC_API_KEY="")
    def test_missing_key_is_misconfigured(self):
        self.assertEqual(ai.health()["code"], "misconfigured")
        with self.assertRaises(ai.AIError) as ctx:
            ai.ask_json("x")
        self.assertEqual(ctx.exception.code, "misconfigured")

    def test_health_ready_without_network(self):
        with patch.object(anthropic_provider, "_client") as c:
            h = ai.health()
        c.assert_not_called()
        self.assertTrue(h["ready"])
        self.assertEqual(h["host"], "api.anthropic.com")

    def test_ask_json_structured_output_and_cached_system(self):
        client = MagicMock()
        client.messages.create.return_value = _msg('{"a": 1}')
        schema = {"type": "object", "properties": {"a": {"type": "integer"}},
                  "required": ["a"], "additionalProperties": False}
        with patch.object(anthropic_provider, "_client", return_value=client):
            self.assertEqual(ai.ask_json("q", schema=schema), {"a": 1})
        kw = client.messages.create.call_args.kwargs
        self.assertEqual(kw["model"], "claude-haiku-4-5")
        self.assertEqual(kw["output_config"]["format"]["schema"], schema)
        self.assertNotIn("thinking", kw)
        self.assertEqual(kw["system"][0]["cache_control"], {"type": "ephemeral"})

    def test_loose_schema_is_described_not_enforced(self):
        client = MagicMock()
        client.messages.create.return_value = _msg('```json\n{"b": 2}\n```')
        with patch.object(anthropic_provider, "_client", return_value=client):
            self.assertEqual(ai.ask_json("q", schema={"type": "object"}), {"b": 2})
        kw = client.messages.create.call_args.kwargs
        self.assertNotIn("output_config", kw)
        self.assertIn("JSON", kw["system"][-1]["text"])

    def test_errors_are_mapped_and_key_never_echoed(self):
        cases = [
            (_status_error(anthropic.RateLimitError, 429), "rate_limited"),
            (_status_error(anthropic.AuthenticationError, 401), "rejected"),
            (_status_error(anthropic.InternalServerError, 500), "rejected"),
            (anthropic.APIConnectionError(request=httpx.Request("POST", "https://x")), "unreachable"),
        ]
        for exc, code in cases:
            client = MagicMock()
            client.messages.create.side_effect = exc
            with patch.object(anthropic_provider, "_client", return_value=client):
                with self.assertRaises(ai.AIError) as ctx:
                    ai.ask_json("q")
            self.assertEqual(ctx.exception.code, code)
            self.assertNotIn(KEY, str(ctx.exception))

    def test_streaming_goes_through_progress(self):
        stream = MagicMock()
        stream.__enter__.return_value = NS(text_stream=iter(['{"x"', ": 3}"]))
        client = MagicMock()
        client.messages.stream.return_value = stream
        events = []
        with patch.object(anthropic_provider, "_client", return_value=client):
            with ai.progress_to(ai.Progress(emit=events.append)):
                self.assertEqual(ai.ask_json("q"), {"x": 3})
        self.assertEqual(events[0]["phase"], "connecting")

    def test_research_collects_sources_and_usage(self):
        client = MagicMock()
        client.messages.create.return_value = NS(
            content=[
                NS(type="server_tool_use"),
                NS(type="web_search_tool_result",
                   content=[NS(url="https://a.org/call", title="A call")]),
                NS(type="text", text='{"summary":"s"}', citations=None),
            ],
            stop_reason="end_turn",
            usage=NS(input_tokens=100, output_tokens=50, cache_read_input_tokens=0,
                     server_tool_use=NS(web_search_requests=2)),
        )
        with patch.object(anthropic_provider, "_client", return_value=client):
            out = anthropic_provider.research("q")
        tools = client.messages.create.call_args.kwargs["tools"]
        self.assertEqual(tools[0]["type"], "web_search_20250305")
        self.assertEqual(out["sources"], [{"url": "https://a.org/call", "title": "A call"}])
        self.assertEqual(out["usage"]["web_search_requests"], 2)


@override_settings(**CLAUDE, SCOPUS_API_KEY="")
class ScoutTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(email="me@x.edu", password="pw", name="Me",
                                           role=Role.FACULTY, department="ECE")
        self.other = User.objects.create_user(email="o@x.edu", password="pw", name="Other",
                                              role=Role.FACULTY, department="CSE")
        self.same = User.objects.create_user(email="s@x.edu", password="pw", name="Same",
                                             role=Role.FACULTY, department="ECE")
        for i, (u, topics) in enumerate([
            (self.me, ["Edge Computing", "Brain Tumor Detection"]),
            (self.other, ["Edge Computing", "Blockchain"]),
            (self.same, ["Edge Computing"]),
        ]):
            p = Publication.objects.create(title=f"Paper {i}", year=2024, venue="IEEE Access",
                                           topics_json=json.dumps(topics), citations=3)
            Authorship.objects.create(publication=p, user=u, position=1, is_college=True,
                                      author_key=f"k{i}", display_name=u.name)
        self.web = json.dumps({
            "summary": "Go further.",
            "opportunities": [{"title": "Real call", "kind": "call", "why": "fits",
                               "url": "https://a.org/call"},
                              {"title": "Made up", "kind": "call", "url": "https://fake.example/x"}],
            "directions": [], "external_people": [],
            "colleagues": [{"user_id": self.other.id, "why": "edge + ledger"},
                           {"user_id": "invented", "why": "nope"}],
        })

    def test_candidates_are_cross_department_only(self):
        from core.services import research_picture as picture
        cands = scout.colleague_candidates(self.me, picture._College())
        self.assertEqual([c["user_id"] for c in cands], [self.other.id])
        self.assertEqual(cands[0]["shared_topics"], ["Edge Computing"])
        self.assertEqual(cands[0]["their_topics"], ["Blockchain"])

    def _found(self, *_a, **_k):
        return {"text": self.web, "sources": [{"url": "https://a.org/call", "title": "A"}],
                "usage": {"input_tokens": 1, "output_tokens": 1}}

    def test_scout_keeps_only_seen_urls_and_known_colleagues(self):
        with patch.object(anthropic_provider, "research", side_effect=self._found):
            result, usage = scout.scout(self.me)
        opp = {o["title"]: o["url"] for o in result["web"]["opportunities"]}
        self.assertEqual(opp["Real call"], "https://a.org/call")
        self.assertEqual(opp["Made up"], "")
        self.assertEqual([c["user_id"] for c in result["colleagues"]], [self.other.id])
        self.assertTrue(result["colleagues"][0]["picked"])

    @override_settings(Q_CLUSTER={"name": "t", "sync": True, "orm": "default"})
    def test_endpoint_runs_caches_limits_and_hides_usage(self):
        c = Client()
        c.force_login(self.me)
        with patch.object(anthropic_provider, "research", side_effect=self._found), \
                patch("django_q.tasks.async_task", side_effect=lambda f, rid, **k: scout.execute(rid)):
            first = c.post("/api/scout", "{}", content_type="application/json").json()
            again = c.post("/api/scout", "{}", content_type="application/json").json()
        self.assertEqual(ScoutRun.objects.count(), 1)
        got = c.get("/api/scout").json()
        self.assertEqual(got["status"], "done")
        self.assertEqual(again["id"], first["id"])
        self.assertNotIn("usage", json.dumps(got))
        ScoutRun.objects.bulk_create([ScoutRun(user=self.me, status=ScoutRun.Status.FAILED) for _ in range(scout.DAILY_LIMIT)])
        r = c.post("/api/scout", '{"refresh": true}', content_type="application/json")
        self.assertEqual(r.status_code, 429)
