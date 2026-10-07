"""The research compass: who you are, what you could be, and the next steps.

Pinned here, against stubbed HTTP (no key, no network; `urllib.request.urlopen`
is replaced in every test, and a test with AI off asserts nothing was asked):

- `facts_for` counts a person's record: papers, citations, h-index, quartiles,
  first-author and journal shares, topics, co-authors by where they sit, and
  the candidates (journals, people, topics, goals) a model may cite;
- with AI off every step still answers, counted, and says so (`counted`);
- a model may cite only candidate ids, and the numbers on a path are worked
  out in code whatever the model says;
- a deadline only ever comes from the person's own Claude scout run;
- choosing a path makes a plan whose ticks are kept, and progress follows;
- the topics step writes the person's research interests;
- asking is limited per day and every turn is logged, the question cut at 200
  characters;
- the super admin is refused, as on the research helper;
- the scout, without Claude, points to the compass instead of a 503.
"""

from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch

from django.core.cache import cache
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from core.models import (
    AuditLog,
    Authorship,
    CompassState,
    Post,
    Publication,
    ResearchInterest,
    Role,
    ScimagoJournal,
    ScoutRun,
    SnipSource,
    Thread,
    User,
)
from core.services import compass, openai_compat, research_helper
from core.services import research_picture as picture
from core.test_harness_provider import _Captured, _Response
from core.test_search import money_keys_in

NOTHING = dict(AI_PROVIDER="", AI_API_KEY="", AI_DEFAULT_PROVIDER="none")
GROQ = dict(
    AI_PROVIDER="",
    AI_API_KEY="gsk_test",
    AI_BASE_URL="https://api.groq.com/openai/v1",
    AI_MODEL="llama-3.3-70b-versatile",
    AI_FAST_MODEL="llama-3.1-8b-instant",
)


def _journal(title: str, issn: str, quartile: str, snip: float) -> ScimagoJournal:
    row = ScimagoJournal.objects.create(
        title=title, issn=issn, year=2025, sjr=1.5,
        categories_json=json.dumps([{"category": "Renewable Energy", "quartile": quartile}]),
    )
    SnipSource.objects.create(title=title, print_issn=issn, snip=snip, year=2025)
    return row


class _Fixture(TestCase):
    """A small college, and a stand-in for the model service.

    `self.answers` is what the stub model replies, by feature ("portrait",
    "paths", "plan", "ask", "draft"); `self.calls` records every prompt.
    """

    def setUp(self):
        cache.clear()
        picture._SHARED.update(sig=None, college=None)
        openai_compat.forget_health()
        self.calls: list[tuple[str, str]] = []
        self.answers: dict = {}
        self.stub = _Captured(self._respond)
        patcher = patch("urllib.request.urlopen", self.stub)
        patcher.start()
        self.addCleanup(patcher.stop)

        mk = lambda e, n, d, role=Role.FACULTY: User.objects.create_user(  # noqa: E731
            email=e, password=None, name=n, role=role, staff_id=e[:4], department=d
        )
        self.me = mk("me@x.edu", "Dr Me Author", "EEE")
        self.a = mk("a@x.edu", "Dr Anita Solar", "EEE")
        self.b = mk("b@x.edu", "Dr Bala Converter", "ECE")
        self.far = mk("far@x.edu", "Dr Far Biosensor", "BME")
        self.head = mk("head@x.edu", "Dr Head", "EEE", Role.HOD)
        self.admin = mk("admin@x.edu", "The Admin", None, Role.SUPER_ADMIN)

        today = timezone.localdate()
        self.p1 = self._pub("Photovoltaic tracking in my own lab", ["Photovoltaic System Control"],
                            "Solar Test Journal", [self.me, self.a], 2024, quartile="Q1", citations=12)
        self.p2 = self._pub("Shaded arrays and how to track them",
                            ["Photovoltaic System Control", "Maximum Power Point Tracking"],
                            "Solar Test Journal", [self.a, self.me], 2025, quartile="Q1", citations=5)
        self.p3 = self._pub("Converter control at a conference", ["DC-DC Converters"], "Power Electronics Conference",
                            [self.me], 2023, kind="proceedings-article", citations=1, outside="IIT Madras")
        self.p4 = self._pub("An inverter study", ["Photovoltaic System Control"], "Energy Letters", [self.me], 2022,
                            quartile="Q2", citations=2)
        # A topic rising next to mine: two recent papers that also carry my topic.
        for days in (30, 60):
            on = today - timedelta(days=days)
            self._pub(f"Batteries beside the arrays {days}", ["Photovoltaic System Control", "Battery Management"],
                      "Power Conv Journal", [self.b], on.year, quartile="Q1", on=on)
        self._pub("Quantum dots for a biosensing immunoassay", ["Biosensors"], "Bio Journal", [self.far], 2024)

        self.solar = _journal("Solar Test Journal", "11112222", "Q1", 1.77)
        self.conv = _journal("Power Conv Journal", "55556666", "Q1", 2.1)

        self.client = Client()
        self.client.force_login(self.me)

    # -- the stand-in model service ---------------------------------------

    def _respond(self, req):
        if req.full_url.endswith("/models"):
            return _Response(json.dumps({"data": [{"id": "llama-3.3-70b-versatile"},
                                                  {"id": "llama-3.1-8b-instant"}]}).encode())
        messages = json.loads(req.data.decode())["messages"]
        prompt = messages[-1]["content"]
        system = " ".join(m["content"] for m in messages if m["role"] == "system")
        markers = (
            ("draft", research_helper.DRAFT.system[:60]),
            ("portrait", compass.PORTRAIT.system[:60]),
            ("paths", compass.PATHS.system[:60]),
            ("plan", compass.PLAN.system[:60]),
            ("ask", compass.ASK.system[:60]),
        )
        kind = next(k for k, marker in markers if marker in system)
        self.calls.append((kind, prompt))
        if kind not in self.answers:
            raise AssertionError(f"the model was asked for a {kind} nobody stubbed")
        answer = self.answers[kind]
        return _Response(json.dumps({"choices": [{"message": {"content": json.dumps(answer)}}]}).encode())

    def assertNoNetwork(self):
        self.assertEqual(self.stub.requests, [], "something reached for the network")

    # -- helpers -----------------------------------------------------------

    def _pub(self, title, topics, venue, users, year, *, quartile="", citations=0, kind="article", on=None,
             outside=None):
        p = Publication.objects.create(
            title=title, year=year, date=on, venue=venue, type=kind, quartile=quartile,
            topics_json=json.dumps(topics), citations=citations,
        )
        for pos, u in enumerate(users, start=1):
            Authorship.objects.create(publication=p, user=u, position=pos, display_name=u.name,
                                      author_key=f"u:{u.id}", is_college=True)
        if outside:
            Authorship.objects.create(publication=p, position=len(users) + 1, display_name="Dr Outside Person",
                                      author_key="A999", institution_name=outside, is_college=False)
        return p

    def post(self, path, body=None, client=None):
        return (client or self.client).post(path, data=json.dumps(body or {}), content_type="application/json")

    def facts(self):
        return compass.facts_for(self.me)


class TheFactsAreCounted(_Fixture):
    @override_settings(**NOTHING)
    def test_the_record_is_counted_once_and_the_same_way_as_my_research(self):
        f = self.facts()
        m = f["metrics"]
        self.assertEqual((m["papers"], m["citations"], m["h_index"], m["q1"]), (4, 20, 2, 2))
        self.assertEqual((m["first_author"], m["first_author_share"]), (3, 75))
        self.assertEqual((m["journal_papers"], m["journal_share"]), (3, 75))
        self.assertEqual(m["quartiles"], {"Q1": 2, "Q2": 1, "Q3": 0, "Q4": 0, "none": 1})
        self.assertEqual(
            (m["coauthors_in_department"], m["coauthors_other_departments"], m["coauthors_outside"]), (1, 0, 1))
        self.assertEqual((m["rank"], m["rank_of"]), (1, 2))
        self.assertEqual((f["person"]["name"], f["person"]["department"]), ("Dr Me Author", "EEE"))
        self.assertEqual((f["topics"][0]["name"], f["topics"][0]["papers"]), ("Photovoltaic System Control", 3))
        self.assertEqual({p["id"] for p in f["papers"]}, {self.p1.id, self.p2.id, self.p3.id, self.p4.id})

    @override_settings(**NOTHING)
    def test_the_candidates_are_what_a_model_may_cite(self):
        c = self.facts()["candidates"]
        people = {p["id"]: p for p in c["people"]}
        self.assertEqual(set(people), {self.a.id, self.b.id})  # not the biosensor colleague, not me
        self.assertEqual(people[self.a.id]["relation"], "coauthor")
        self.assertEqual((people[self.b.id]["relation"], people[self.b.id]["dept"]), ("colleague", "ECE"))
        self.assertIn("Photovoltaic System Control", people[self.b.id]["shared_topics"])
        journals = {j["name"]: j for j in c["journals"]}
        self.assertEqual((journals["Power Conv Journal"]["quartile"], journals["Power Conv Journal"]["snip"]),
                         ("Q1", 2.1))
        self.assertEqual(journals["Power Conv Journal"]["colleagues"], 1)
        self.assertEqual(journals["Power Conv Journal"]["journal_id"], self.conv.id)
        self.assertIn("Solar Test Journal", journals)
        self.assertNotIn("Power Electronics Conference", journals)  # a conference is not a journal to aim at
        topics = {t["name"]: t for t in c["topics"]}
        self.assertEqual(topics["Battery Management"]["kind"], "rising")
        self.assertEqual(topics["Photovoltaic System Control"]["kind"], "mine")
        self.assertNotIn("Biosensors", topics)
        self.assertEqual({g["metric"] for g in c["goals"]}, {"PAPERS", "Q1", "FIRST_AUTHOR", "CITATIONS"})
        ids = compass.allowed_ids(self.facts())
        self.assertTrue({self.p1.id, self.a.id, self.b.id, "h_index"} <= ids)
        self.assertNotIn(self.far.id, ids)

    @override_settings(**NOTHING)
    def test_the_hash_is_stable_and_moves_with_the_record(self):
        first = self.facts()["facts_hash"]
        self.assertEqual(first, self.facts()["facts_hash"])
        self._pub("A fifth paper", ["Photovoltaic System Control"], "Solar Test Journal", [self.me], 2026,
                  quartile="Q1")
        compass.forget_facts(self.me)
        self.assertNotEqual(first, self.facts()["facts_hash"])


class WithAIOff(_Fixture):
    @override_settings(**NOTHING)
    def test_every_step_answers_counted_and_nothing_reaches_a_network(self):
        p = self.post("/api/compass/portrait").json()
        self.assertTrue(p["counted"])
        self.assertTrue(p["headline"].startswith("You publish mostly on Photovoltaic System Control and "))
        self.assertIn("4 papers, h-index 2, 2 in Q1 journals.", p["headline"])
        self.assertLessEqual(len(p["headline"].split()), 30)
        self.assertEqual(len(p["strengths"]), 3)
        for s in p["strengths"]:
            self.assertTrue(s["text"])
            for e in s["evidence"]:
                self.assertIn(e["kind"], ("paper", "journal", "person", "metric"))
                self.assertTrue(e["label"])
        self.assertEqual(p["topics"][0], {"name": "Photovoltaic System Control", "papers": 3})
        self.assertIn("1 of 2", p["standing"])

        paths = self.post("/api/compass/paths").json()
        self.assertTrue(paths["counted"])
        # The largest gaps: no co-author in another department, half the papers in Q1, an h-index of 2.
        self.assertEqual([x["key"] for x in paths["paths"]], ["cross_dept", "q1_author", "citations"])
        by = {x["key"]: x for x in paths["paths"]}
        self.assertEqual([(m["now"], m["target"]) for m in by["q1_author"]["metrics"]], [(2, 4)])
        self.assertEqual([(m["now"], m["target"]) for m in by["cross_dept"]["metrics"]], [(0, 2)])
        self.assertEqual(by["cross_dept"]["peers"], [{"id": self.b.id, "name": "Dr Bala Converter", "dept": "ECE"}])
        for x in paths["paths"]:
            self.assertTrue(x["name"] and x["why"])

        plan = self.post("/api/compass/choose", {"path": "q1_author"}).json()
        self.assertTrue(plan["counted"])
        self.assertTrue(4 <= len(plan["plan"]) <= 6, plan["plan"])
        kinds = [a["kind"] for a in plan["plan"]]
        self.assertLessEqual(set(kinds), {"journal", "person", "topic", "goal"})
        goal = next(a for a in plan["plan"] if a["kind"] == "goal")
        self.assertEqual(goal["ref"]["metric"], "Q1")
        self.assertEqual(set(goal["ref"]), {"metric", "target", "year"})
        journal = next(a for a in plan["plan"] if a["kind"] == "journal")
        self.assertEqual(set(journal["ref"]), {"journal_id", "name", "quartile", "snip"})
        self.assertFalse(any(a["done"] for a in plan["plan"]))
        self.assertNoNetwork()

        body = self.client.get("/api/compass").json()
        self.assertFalse(body["ai"])
        self.assertEqual(body["portrait"]["headline"], p["headline"])
        self.assertEqual([x["key"] for x in body["paths"]], ["cross_dept", "q1_author", "citations"])
        self.assertEqual((body["chosen_path"], body["plan"]), ("q1_author", plan["plan"]))
        f = body["facts"]
        self.assertEqual((f["papers"], f["citations"], f["h_index"], f["rank"], f["q1"]), (4, 20, 2, 1, 2))
        self.assertEqual((f["first_author_share"], f["journal_share"]), (75, 75))
        self.assertEqual(f["topics"][0], {"name": "Photovoltaic System Control", "papers": 3})

    @override_settings(**NOTHING)
    def test_a_first_visit_has_facts_and_nothing_else(self):
        body = self.client.get("/api/compass").json()
        self.assertEqual((body["portrait"], body["paths"], body["chosen_path"], body["plan"]), (None, None, None, None))
        self.assertEqual(self.client.get("/api/compass/summary").json(),
                         {"headline": None, "path_name": None, "progress": None, "next_action": None})
        self.assertFalse(CompassState.objects.exists())  # reading writes nothing

    @override_settings(**NOTHING)
    def test_a_portrait_made_before_the_record_changed_is_not_shown_as_current(self):
        self.post("/api/compass/portrait")
        self._pub("A fifth paper", ["Photovoltaic System Control"], "Solar Test Journal", [self.me], 2026)
        compass.forget_facts(self.me)
        self.assertIsNone(self.client.get("/api/compass").json()["portrait"])
        self.assertIn("5 papers", self.post("/api/compass/portrait").json()["headline"])


class ChoosingAndTicking(_Fixture):
    @override_settings(**NOTHING)
    def test_ticking_a_step_is_kept_and_progress_follows(self):
        self.post("/api/compass/paths")
        plan = self.post("/api/compass/choose", {"path": "cross_dept"}).json()["plan"]
        total = len(plan)
        r = self.post(f"/api/compass/actions/{plan[0]['id']}", {"done": True})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"ok": True, "done": True, "progress": {"done": 1, "total": total}})
        self.assertTrue(self.client.get("/api/compass").json()["plan"][0]["done"])
        summary = self.client.get("/api/compass/summary").json()
        self.assertEqual(summary["progress"], {"done": 1, "total": total})
        self.assertEqual(summary["next_action"]["id"], plan[1]["id"])
        self.assertEqual(summary["path_name"], self.client.get("/api/compass").json()["paths"][0]["name"])
        # Choosing the same path again keeps the ticks.
        again = self.post("/api/compass/choose", {"path": "cross_dept"}).json()["plan"]
        self.assertTrue(again[0]["done"])
        untick = self.post(f"/api/compass/actions/{plan[0]['id']}", {"done": False}).json()
        self.assertEqual(untick["progress"], {"done": 0, "total": total})

    @override_settings(**NOTHING)
    def test_bad_input_is_a_400_and_an_unknown_step_a_404(self):
        self.assertEqual(self.post("/api/compass/choose", {"path": "astronaut"}).status_code, 400)
        self.assertEqual(self.post("/api/compass/actions/nope", {"done": True}).status_code, 404)
        self.post("/api/compass/choose", {"path": "citations"})
        self.assertEqual(self.post("/api/compass/actions/nope", {"done": True}).status_code, 404)
        self.assertEqual(self.post("/api/compass/ask", {"question": "   "}).status_code, 400)
        self.assertEqual(self.post("/api/compass/ask", {"question": "x" * 501}).status_code, 400)

    @override_settings(**NOTHING)
    def test_another_path_starts_a_new_plan(self):
        first = self.post("/api/compass/choose", {"path": "cross_dept"}).json()["plan"]
        self.post(f"/api/compass/actions/{first[0]['id']}", {"done": True})
        other = self.post("/api/compass/choose", {"path": "q1_author"}).json()["plan"]
        self.assertFalse(any(a["done"] for a in other))
        self.assertEqual(self.client.get("/api/compass").json()["chosen_path"], "q1_author")


class TheTopicsStep(_Fixture):
    @override_settings(**NOTHING)
    def test_the_topics_step_replaces_the_research_interests(self):
        ResearchInterest.objects.create(user=self.me, domain="Old Topic")
        r = self.post("/api/compass/topics", {"topics": ["Photovoltaic System Control", " Battery Management ",
                                                         "Photovoltaic System Control", ""]})
        self.assertEqual(r.json(), {"ok": True, "topics": ["Photovoltaic System Control", "Battery Management"]})
        mine = sorted(ResearchInterest.objects.filter(user=self.me).values_list("domain", flat=True))
        self.assertEqual(mine, ["Battery Management", "Photovoltaic System Control"])
        # The same rows /me/interests reads.
        self.assertEqual(sorted(self.client.get("/api/me/interests").json()["domains"]), mine)

    @override_settings(**NOTHING)
    def test_naming_topics_keeps_the_portrait_and_paths_already_made(self):
        portrait = self.post("/api/compass/portrait").json()
        paths = self.post("/api/compass/paths").json()
        before = self.facts()["facts_hash"]
        self.post("/api/compass/topics", {"topics": ["Battery Management"]})
        self.assertNotEqual(self.facts()["facts_hash"], before)  # the plan's candidates did change
        body = self.client.get("/api/compass").json()
        self.assertEqual(body["portrait"], portrait | {})
        self.assertEqual(body["paths"], paths["paths"])


class TheModelOnlyChoosesAndExplains(_Fixture):
    @override_settings(**GROQ)
    def test_a_portrait_keeps_only_evidence_the_server_supplied(self):
        self.answers["portrait"] = {
            "headline": "You build photovoltaic control, mostly in Q1 journals.",
            "strengths": [
                {"text": "Your Q1 work on arrays is your strongest card.",
                 "evidence": [{"kind": "paper", "id": self.p1.id}, {"kind": "paper", "id": "invented-paper"},
                              {"kind": "person", "id": self.far.id},
                              # A real id under the wrong kind: the guard lets it by, the facts do not.
                              {"kind": "journal", "id": self.p2.id}]},
                {"text": "You have written 99 papers on arrays.", "evidence": []},
                {"text": "You lead most of your papers.", "evidence": [{"kind": "metric", "id": "first_author_share"}]},
            ],
            "standing": "You are 1 of 2 in EEE by quartile-weighted papers.",
            "topics": [{"name": "Invented Topic", "papers": 50}],
        }
        p = self.post("/api/compass/portrait").json()
        self.assertFalse(p["counted"])
        self.assertEqual(p["headline"], "You build photovoltaic control, mostly in Q1 journals.")
        self.assertEqual(p["strengths"][0]["evidence"],
                         [{"kind": "paper", "id": self.p1.id, "label": "Photovoltaic tracking in my own lab"}])
        self.assertEqual(len(p["strengths"]), 3)
        self.assertEqual(p["strengths"][2]["evidence"][0]["kind"], "metric")
        self.assertEqual(p["topics"][0], {"name": "Photovoltaic System Control", "papers": 3})
        text = json.dumps(p)
        for invented in ("99 papers", "invented-paper", self.far.id, "Invented Topic"):
            self.assertNotIn(invented, text)
        # The facts went to the model fenced, and with no money in them.
        kind, prompt = self.calls[0]
        self.assertEqual(kind, "portrait")
        self.assertRegex(prompt, r"<<DATA-\w{12} [^>]*facts")
        self.assertNotIn("remuneration", prompt)
        # A second visit is answered from what was kept: no second call.
        self.post("/api/compass/portrait")
        self.assertEqual(len(self.calls), 1)

    @override_settings(**GROQ)
    def test_path_numbers_come_from_code_whatever_the_model_says(self):
        self.answers["paths"] = {"paths": [
            {"key": "q1_author", "name": "Q1 regular", "why": "Two of your papers are already in Q1 journals.",
             "metrics": [{"label": "Q1 papers", "now": 50, "target": 99, "unit": "papers"}],
             "peers": [{"id": self.b.id}, {"id": "ghost-user"}, {"id": self.far.id}],
             "evidence": [{"kind": "metric", "id": "q1"}]},
            {"key": "focus_topic", "name": "Photovoltaic specialist", "why": "Most of your work is here.",
             "peers": [], "evidence": []},
            {"key": "astronaut", "name": "Go to space", "why": "Why not."},
            {"key": "first_author", "name": "Lead author", "why": "Aim for 777 first-author papers.", "peers": []},
        ]}
        body = self.post("/api/compass/paths").json()
        self.assertFalse(body["counted"])
        self.assertEqual([p["key"] for p in body["paths"]], ["q1_author", "focus_topic", "first_author"])
        q1 = body["paths"][0]
        self.assertEqual(q1["name"], "Q1 regular")
        self.assertEqual([(m["now"], m["target"], m["unit"]) for m in q1["metrics"]], [(2, 4, "papers")])
        self.assertEqual([x["id"] for x in q1["peers"]], [self.b.id])
        self.assertEqual(q1["evidence"][0]["id"], "q1")
        focus = body["paths"][1]
        self.assertEqual([(m["now"], m["target"]) for m in focus["metrics"]], [(3, 6)])
        self.assertTrue(focus["peers"])  # the model chose none, so the counted ones stand in
        self.assertNotIn("777", body["paths"][2]["why"])  # a number the facts do not hold: the counted sentence
        self.assertTrue(body["paths"][2]["why"])
        text = json.dumps(body)
        for invented in ("ghost-user", self.far.id, "astronaut", "Go to space"):
            self.assertNotIn(invented, text)

    @override_settings(**GROQ)
    def test_a_plan_cites_only_candidates_and_its_refs_come_from_the_record(self):
        f = self.facts()
        jid = next(j["id"] for j in f["candidates"]["journals"] if j["name"] == "Power Conv Journal")
        tid = next(t["id"] for t in f["candidates"]["topics"] if t["name"] == "Battery Management")
        self.answers["plan"] = {"actions": [
            {"kind": "journal", "id": jid, "title": "Send your next paper to Power Conv Journal",
             "why": "Colleagues publish Q1 work there."},
            {"kind": "journal", "id": "j-invented", "title": "Try Nature", "why": "Big."},
            {"kind": "person", "id": self.b.id, "title": "Talk to Dr Bala Converter",
             "why": "He writes on batteries beside arrays."},
            {"kind": "deadline", "id": "x", "title": "Apply by 1 March", "why": "A call closes."},
            {"kind": "topic", "id": tid, "title": "Read up on battery management", "why": "It is rising here."},
            {"kind": "goal", "id": "g:Q1", "title": "Set a goal of 999 Q1 papers", "why": "Aim high."},
        ]}
        body = self.post("/api/compass/choose", {"path": "q1_author"}).json()
        self.assertFalse(body["counted"])
        by = {a["kind"]: a for a in body["plan"]}
        self.assertEqual(by["journal"]["ref"], {"journal_id": self.conv.id, "name": "Power Conv Journal",
                                                "quartile": "Q1", "snip": 2.1})
        person = by["person"]["ref"]  # the renderer adds the face (photo_url, initials) to every person
        self.assertEqual({k: person[k] for k in ("user_id", "name", "dept")},
                         {"user_id": self.b.id, "name": "Dr Bala Converter", "dept": "ECE"})
        self.assertEqual(by["topic"]["ref"], {"name": "Battery Management"})
        goal = next(g for g in f["candidates"]["goals"] if g["metric"] == "Q1")
        self.assertEqual(by["goal"]["ref"], {"metric": "Q1", "target": goal["target"], "year": goal["year"]})
        self.assertNotIn("deadline", by)
        self.assertNotIn("999", by["goal"]["title"])
        self.assertEqual(by["journal"]["title"], "Send your next paper to Power Conv Journal")
        text = json.dumps(body)
        for invented in ("Nature", "1 March"):
            self.assertNotIn(invented, text)
        self.assertTrue(4 <= len(body["plan"]) <= 6)

    @override_settings(**NOTHING)
    def test_a_goal_step_is_one_the_goals_page_accepts_as_it_stands(self):
        for key in compass.ARCHETYPES:
            plan = self.post("/api/compass/choose", {"path": key}).json()["plan"]
            ref = next(a["ref"] for a in plan if a["kind"] == "goal")
            r = self.client.put("/api/me/goals", data=json.dumps(
                {"year": ref["year"], "goals": [{"metric": ref["metric"], "target": ref["target"]}]}),
                content_type="application/json")
            self.assertEqual(r.status_code, 200, (key, ref, r.content))
        self.assertTrue(self.client.get("/api/me/goals").json())


class DeadlinesOnlyFromTheScout(_Fixture):
    def _scout_run(self):
        later = (timezone.localdate() + timedelta(days=40)).isoformat()
        gone = (timezone.localdate() - timedelta(days=3)).isoformat()
        ScoutRun.objects.create(user=self.me, status=ScoutRun.Status.DONE, result_json=json.dumps({"web": {
            "opportunities": [
                {"title": "Special issue on photovoltaic control", "kind": "special_issue", "why": "Fits.",
                 "deadline": later, "url": "https://journal.example/si"},
                {"title": "A call that has closed", "kind": "call", "deadline": gone, "url": "https://x.example/c"},
                {"title": "A call with no link", "kind": "call", "deadline": later, "url": ""},
            ]}}))
        return later

    @override_settings(ANTHROPIC_API_KEY="", **NOTHING)
    def test_with_claude_a_scouted_deadline_joins_the_plan(self):
        later = self._scout_run()
        with patch("core.services.ai.provider_name", return_value="anthropic"):
            plan = self.post("/api/compass/choose", {"path": "q1_author"}).json()["plan"]
        deadlines = [a for a in plan if a["kind"] == "deadline"]
        self.assertEqual([a["ref"] for a in deadlines], [
            {"date": later, "url": "https://journal.example/si", "title": "Special issue on photovoltaic control"}])
        self.assertLessEqual(len(plan), 6)
        # The screen saves it to the calendar as it stands.
        ref = deadlines[0]["ref"]
        r = self.post("/api/calendar", {"title": ref["title"], "kind": "DEADLINE", "starts_on": ref["date"]})
        self.assertIn(r.status_code, (200, 201), r.content)

    @override_settings(**NOTHING)
    def test_without_claude_there_is_never_a_deadline(self):
        self._scout_run()
        plan = self.post("/api/compass/choose", {"path": "q1_author"}).json()["plan"]
        self.assertFalse([a for a in plan if a["kind"] == "deadline"])


class AskingIsLimitedAndLogged(_Fixture):
    def ask(self, question, client=None):
        return self.post("/api/compass/ask", {"question": question}, client=client)

    @override_settings(**NOTHING)
    def test_with_ai_off_the_answer_is_a_counted_fact_and_the_turn_is_logged(self):
        question = "How many citations do I have so far? " + "Tell me more. " * 30
        body = self.ask(question[:480]).json()
        self.assertTrue(body["counted"])
        self.assertIn("AI is off", body["answer"])
        self.assertIn("20 citations", body["answer"])
        self.assertEqual(body["evidence"][0]["id"], "citations")
        row = AuditLog.objects.get(action="COMPASS_ASK")
        self.assertEqual(row.actor_id, self.me.id)
        self.assertEqual(len(json.loads(row.detail_json)["question"]), 200)
        self.assertNoNetwork()

    @override_settings(COMPASS_ASK_DAILY_LIMIT=2, **NOTHING)
    def test_the_daily_limit_is_a_429_with_a_plain_message(self):
        self.assertEqual(self.ask("What is my h-index?").status_code, 200)
        self.assertEqual(self.ask("What is my h-index now?").status_code, 200)
        r = self.ask("And now?")
        self.assertEqual(r.status_code, 429)
        self.assertIn("tomorrow", r.json()["detail"])
        self.assertEqual(AuditLog.objects.filter(action="COMPASS_ASK").count(), 2)
        other = Client()
        other.force_login(self.a)
        self.assertEqual(self.ask("What is my h-index?", client=other).status_code, 200)

    @override_settings(**GROQ)
    def test_the_model_answers_from_the_record_and_cites_only_what_it_was_given(self):
        self.answers["ask"] = {"answer": "Your most cited paper has 12 citations.", "on_topic": True,
                               "evidence": [{"kind": "paper", "id": self.p1.id}, {"kind": "paper", "id": "nope"}]}
        body = self.ask("Which of my papers is cited most?").json()
        self.assertFalse(body["counted"])
        self.assertEqual(body["answer"], "Your most cited paper has 12 citations.")
        self.assertEqual([e["id"] for e in body["evidence"]], [self.p1.id])
        kind, prompt = self.calls[0]
        self.assertEqual(kind, "ask")
        self.assertRegex(prompt, r"<<DATA-\w{12} the question>>\nWhich of my papers is cited most\?")

    @override_settings(**GROQ)
    def test_an_off_topic_question_is_politely_refused(self):
        self.answers["ask"] = {"answer": "Here is a recipe for dosa.", "evidence": [], "on_topic": False}
        body = self.ask("How do I make dosa?").json()
        self.assertNotIn("dosa", body["answer"].lower())
        self.assertIn("research", body["answer"])

    @override_settings(**GROQ)
    def test_a_number_the_record_does_not_hold_is_not_passed_on(self):
        self.answers["ask"] = {"answer": "You have 4321 citations.", "evidence": [], "on_topic": True}
        body = self.ask("How many citations do I have?").json()
        self.assertTrue(body["counted"])
        self.assertNotIn("4321", body["answer"])
        self.assertIn("20 citations", body["answer"])

    @override_settings(**GROQ)
    def test_drafting_a_note_reuses_the_research_helpers_draft_and_sends_nothing(self):
        message = ("Hello Dr Bala Converter,\n\nI work on photovoltaic system control and read your paper on batteries "
                   "beside the arrays. Would you be open to a short conversation about writing something together?"
                   "\n\nThank you,\nDr Me Author")
        self.answers["draft"] = {"message": message}
        before = (Thread.objects.count(), Post.objects.count())
        body = self.ask("Draft an email to Dr Bala Converter about batteries beside the arrays").json()
        self.assertEqual(body["answer"], message)
        self.assertFalse(body["counted"])
        self.assertEqual(body["evidence"], [{"kind": "person", "id": self.b.id, "label": "Dr Bala Converter"}])
        self.assertEqual([k for k, _ in self.calls], ["draft"])
        self.assertEqual((Thread.objects.count(), Post.objects.count()), before)
        self.assertEqual(json.loads(AuditLog.objects.get(action="COMPASS_ASK").detail_json)["kind"], "draft")

    @override_settings(**NOTHING)
    def test_a_question_that_only_mentions_a_message_is_answered_not_drafted(self):
        body = self.ask("What message does my record send about Q1 journals?").json()
        self.assertNotIn("draft a first note", body["answer"])
        self.assertEqual(body["evidence"][0]["id"], "q1")
        self.assertEqual(json.loads(AuditLog.objects.get(action="COMPASS_ASK").detail_json)["kind"], "off")

    @override_settings(**NOTHING)
    def test_drafting_with_ai_off_is_the_plain_template(self):
        body = self.ask("Write a message to Dr Anita Solar").json()
        self.assertTrue(body["counted"])
        self.assertIn("Hello Dr Anita Solar", body["answer"])
        self.assertTrue(body["answer"].rstrip().endswith("Dr Me Author"))
        self.assertNoNetwork()


class WhoMayUseIt(_Fixture):
    @override_settings(**NOTHING)
    def test_the_super_admin_is_refused_and_signed_out_visitors_too(self):
        c = Client()
        self.assertEqual(c.get("/api/compass").status_code, 401)
        c.force_login(self.admin)
        for method, path in (("get", "/api/compass"), ("get", "/api/compass/summary"),
                             ("post", "/api/compass/portrait"), ("post", "/api/compass/paths"),
                             ("post", "/api/compass/ask")):
            r = c.get(path) if method == "get" else self.post(path, {"question": "hi"}, client=c)
            self.assertEqual(r.status_code, 403, path)

    @override_settings(**NOTHING)
    def test_a_head_may_use_it_and_is_sent_no_money(self):
        c = Client()
        c.force_login(self.head)
        r = c.get("/api/compass")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(money_keys_in(r.json()), [])
        self.assertEqual(self.post("/api/compass/portrait", client=c).status_code, 200)


class TheScoutPointsToTheCompass(_Fixture):
    @override_settings(**GROQ)
    def test_without_claude_the_scout_says_where_it_went(self):
        for r in (self.client.get("/api/scout"), self.post("/api/scout")):
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json(), {"available": False, "moved_to": "/compass"})
        self.assertFalse(ScoutRun.objects.exists())


class TheCountedWordsReadWell(TestCase):
    """Found walking the real record: a title cut mid-word, "1 Q1 papers", and a
    colleague named on a path they are not on."""

    def test_a_long_title_is_cut_at_a_word_with_an_ellipsis(self):
        title = "Constructing an AI-Assisted Pronunciation Correction Tool Using Speech Recognition and Phonetic Analysis"
        clipped = compass._clip(title, 90)
        self.assertTrue(clipped.endswith("…"))
        self.assertTrue(title.startswith(clipped[:-1]))
        self.assertTrue(title[len(clipped) - 1] == " ", clipped)
        self.assertEqual(compass._clip("Short title", 90), "Short title")

    def test_a_goal_of_one_is_singular(self):
        step = compass._step("q1_author", "goal", {"id": "g1", "metric": "Q1", "target": 1, "year": 2027, "rule": "r"})
        self.assertEqual(step["title"], "Set a goal: 1 Q1 paper in 2027")
        step = compass._step("q1_author", "goal", {"id": "g2", "metric": "Q1", "target": 3, "year": 2027, "rule": "r"})
        self.assertEqual(step["title"], "Set a goal: 3 Q1 papers in 2027")

    def test_nobody_is_named_on_a_topic_path_they_do_not_share(self):
        facts = {"topics": [{"name": "EFL teaching", "papers": 4}],
                 "candidates": {"people": [
                     {"id": "u1", "name": "A", "dept": "AI&ML", "other_department": True, "q1_papers": 0,
                      "shared_topics": ["Robotics"], "relation": "colleague"}]}}
        with patch.object(compass, "_top_topic", return_value={"name": "EFL teaching", "papers": 4}):
            self.assertEqual(compass._peers_for("focus_topic", facts), [])
        self.assertEqual(compass._peers_for("q1_author", facts), [])
