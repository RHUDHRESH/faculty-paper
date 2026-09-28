"""New things to work on: people, journals and topics, counted -- no model.

The suggestions a faculty member sees on Discover must work on a server with
no AI configured at all, which is the free deployment's normal state. So the
three lists here are computed from the college's own record, each entry with
the reason it was suggested, and the tests pin the rules a reader would
check first:

- somebody you have already written with is never suggested as a new
  collaborator -- including when the shared paper is only in the historic
  ledger;
- a colleague in another department ranks above an equally close one in
  your own, and the reason says so;
- a journal is suggested only when it is Q1 or Q2, in your field, somewhere
  colleagues have published, and not somewhere you already publish;
- a topic is an area next to yours that you have not published in yet.

The industry-partner list needs knowledge the college does not hold, so it
is the one AI part; without a model it answers 503 with `not_configured`, and
the page hides it with one line.
"""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.core.cache import cache
from django.test import Client, TestCase, override_settings

from core.models import Claim, ClaimStatus, PaidLedger, ResearchInterest, Role, User
from core.services import openai_compat, paper_facts
from core.test_harness_provider import _Captured, _Response
from core.test_search import money_keys_in

NOTHING = dict(AI_PROVIDER="", AI_API_KEY="", AI_DEFAULT_PROVIDER="none")
GROQ = dict(
    AI_PROVIDER="",
    AI_API_KEY="gsk_test",
    AI_BASE_URL="https://api.groq.com/openai/v1",
    AI_MODEL="llama-3.3-70b-versatile",
    AI_FAST_MODEL="",
)

AI = "Artificial Intelligence"
VISION = "Computer Vision and Pattern Recognition"
ROBOTS = "Control and Systems Engineering"
ONCOLOGY = "Oncology"


class _Suggest(TestCase):
    def setUp(self):
        cache.clear()
        paper_facts.forget()
        openai_compat.forget_health()
        self.me = self._person("me", "ECE", "TSEC001")
        self.client = Client()
        self.client.force_login(self.me)
        self._n = 0

    def _person(self, name, dept, staff_id=None, role=Role.FACULTY):
        return User.objects.create_user(
            email=f"{name}@x.edu", password=None, name=name.title(), role=role,
            department=dept, staff_id=staff_id,
        )

    def _paper(self, owner, *, areas=(AI,), journal="Journal of Things", quartile="Q2",
               doi=None, title=None, year=2025):
        self._n += 1
        return Claim.objects.create(
            owner=owner, status=ClaimStatus.PAID, paper_title=title or f"Paper {self._n}",
            doi=doi, journal_title=journal, quartile=quartile, publication_year=year,
            indexing_level="Scopus", author_position=1,
            subjects_json="; ".join(f"{a} ({quartile})" for a in areas),
            remuneration=77777.0,
        )

    def _next(self):
        res = self.client.get("/api/discover/next")
        self.assertEqual(res.status_code, 200, res.content[:300])
        return res.json()


class PeopleToWorkWith(_Suggest):
    def test_somebody_you_have_already_written_with_is_never_suggested(self):
        partner = self._person("partner", "CSE")
        # One shared paper, filed by both of us...
        self._paper(self.me, doi="10.5/shared", title="Shared work")
        self._paper(partner, doi="10.5/shared", title="Shared work")
        # ...and otherwise the closest colleague there could be.
        for _ in range(3):
            self._paper(partner, journal="Journal of Things", areas=(AI, VISION))
        stranger = self._person("stranger", "MECH")
        self._paper(stranger, areas=(AI,))
        ids = [p["id"] for p in self._next()["people"]]
        self.assertNotIn(partner.id, ids)
        self.assertIn(stranger.id, ids)

    def test_a_paper_shared_only_in_the_historic_ledger_still_makes_a_co_author(self):
        partner = self._person("partner", "CSE", "TSCS001")
        for staff_id in ("TSEC001", "TSCS001"):
            PaidLedger.objects.create(
                payout_month=date(2025, 3, 1), staff_id=staff_id, amount=5000,
                paper_title="Ledger paper",
                raw_json=json.dumps({
                    "SJR Quartile": "Q2", "Publication Date": "2025-01-10",
                    "Subject Area": f"{AI} (Q2)", "DOI": "10.7/ledger",
                }),
            )
        self._paper(partner, areas=(AI,))
        self.assertNotIn(partner.id, [p["id"] for p in self._next()["people"]])

    def test_another_department_ranks_above_an_equally_close_colleague_and_says_why(self):
        self._paper(self.me, areas=(AI,), journal="Journal of Things")
        same = self._person("same", "ECE")
        other = self._person("other", "CSE")
        self._paper(same, areas=(AI,), journal="Journal of Things")
        self._paper(other, areas=(AI,), journal="Journal of Things")
        people = self._next()["people"]
        self.assertEqual([p["id"] for p in people][:2], [other.id, same.id])
        self.assertTrue(people[0]["cross_department"])
        self.assertTrue(any("CSE" in r for r in people[0]["reasons"]))

    def test_the_reasons_name_the_shared_journal_the_shared_area_and_a_strength(self):
        self._paper(self.me, areas=(AI,), journal="Neural Letters", quartile="Q3")
        them = self._person("them", "EEE")
        self._paper(them, areas=(AI,), journal="Neural Letters", quartile="Q1")
        person = self._next()["people"][0]
        text = " ".join(person["reasons"])
        self.assertIn("Neural Letters", text)
        self.assertIn(AI, text)
        self.assertIn("Q1", text)

    def test_people_with_nothing_in_common_are_not_suggested(self):
        self._paper(self.me, areas=(AI,), journal="Neural Letters")
        far = self._person("far", "MED")
        self._paper(far, areas=(ONCOLOGY,), journal="Cancer Journal")
        self.assertEqual(self._next()["people"], [])


class JournalsToAimFor(_Suggest):
    def test_q1_or_q2_in_my_field_where_colleagues_published_and_not_already_mine(self):
        self._paper(self.me, areas=(AI,), journal="My Usual Journal", quartile="Q2")
        colleague = self._person("colleague", "CSE")
        another = self._person("another", "IT")
        self._paper(colleague, areas=(AI,), journal="Top AI Journal", quartile="Q1")
        self._paper(another, areas=(AI,), journal="Top AI Journal", quartile="Q1")
        self._paper(colleague, areas=(AI,), journal="Lower Journal", quartile="Q3")
        self._paper(colleague, areas=(ONCOLOGY,), journal="Cancer Journal", quartile="Q1")
        self._paper(colleague, areas=(AI,), journal="My Usual Journal", quartile="Q1")
        journals = self._next()["journals"]
        titles = [j["title"] for j in journals]
        self.assertEqual(titles, ["Top AI Journal"])
        top = journals[0]
        self.assertEqual(top["quartile"], "Q1")
        self.assertEqual(top["colleagues"], 2)
        self.assertIn(AI, top["areas"])
        self.assertTrue(top["reason"])


class OpenTopics(_Suggest):
    def test_an_area_next_to_mine_that_i_have_not_published_in(self):
        self._paper(self.me, areas=(AI,))
        a = self._person("a", "CSE")
        b = self._person("b", "IT")
        self._paper(a, areas=(AI, VISION))
        self._paper(b, areas=(AI, VISION))
        self._paper(b, areas=(ONCOLOGY,))
        topics = self._next()["topics"]
        names = [t["area"] for t in topics]
        self.assertIn(VISION, names)
        self.assertNotIn(AI, names)  # already mine
        self.assertNotIn(ONCOLOGY, names)  # never alongside my work
        vision = topics[names.index(VISION)]
        self.assertEqual(vision["alongside"], 2)
        self.assertEqual(vision["people"], 2)
        self.assertTrue(vision["reason"])

    def test_catch_all_and_blank_areas_are_never_offered_as_topics(self):
        self._paper(self.me, areas=(AI,))
        a = self._person("a", "CSE")
        for _ in range(2):
            self._paper(a, areas=(AI, "Engineering (miscellaneous)", "N/A", VISION))
        names = [t["area"] for t in self._next()["topics"]]
        self.assertEqual(names, [VISION])

    def test_an_area_half_the_college_publishes_in_is_too_broad_to_suggest(self):
        self._paper(self.me, areas=(AI,))
        for i in range(12):
            colleague = self._person(f"c{i}", "CSE")
            self._paper(colleague, areas=(AI, "Engineering"))
        few = self._person("few", "IT")
        self._paper(few, areas=(AI, VISION))
        self._paper(few, areas=(AI, VISION))
        names = [t["area"] for t in self._next()["topics"]]
        self.assertIn(VISION, names)
        self.assertNotIn("Engineering", names)

    def test_a_reason_names_the_most_specific_shared_area_first(self):
        # "Computer Science" sorts first by name; the broad area must not win
        # on that account when a narrower one is shared too.
        self._paper(self.me, areas=("Computer Science", VISION))
        for i in range(3):
            self._paper(self._person(f"e{i}", "EEE"), areas=("Computer Science",))
        them = self._person("them", "CSE")
        self._paper(them, areas=("Computer Science", VISION))
        person = next(p for p in self._next()["people"] if p["id"] == them.id)
        self.assertEqual(person["shared_areas"][0], VISION)

    def test_a_catch_all_bucket_is_not_named_beside_a_real_area(self):
        self._paper(self.me, areas=("Engineering (miscellaneous)", VISION))
        them = self._person("them", "CSE")
        self._paper(them, areas=("Engineering (miscellaneous)", VISION))
        person = next(p for p in self._next()["people"] if p["id"] == them.id)
        text = " ".join(person["reasons"])
        self.assertIn(VISION, text)
        self.assertNotIn("(miscellaneous)", text)

    def test_a_miscellaneous_bucket_reads_as_its_field_when_it_is_all_there_is(self):
        # Scimago's "Chemical Engineering (miscellaneous)" is, to a reader,
        # Chemical Engineering.
        self._paper(self.me, areas=("Chemical Engineering (miscellaneous)",))
        them = self._person("them", "CSE")
        self._paper(them, areas=("Chemical Engineering (miscellaneous)",))
        person = next(p for p in self._next()["people"] if p["id"] == them.id)
        text = " ".join(person["reasons"])
        self.assertIn("Works in Chemical Engineering, as you do.", text)
        self.assertNotIn("(miscellaneous)", text)

    def test_stated_interests_ground_a_newcomer_with_no_papers(self):
        ResearchInterest.objects.create(user=self.me, domain=AI)
        a = self._person("a", "CSE")
        self._paper(a, areas=(AI, ROBOTS))
        self._paper(a, areas=(AI, ROBOTS), journal="Other")
        body = self._next()
        self.assertIn(ROBOTS, [t["area"] for t in body["topics"]])
        self.assertIn(a.id, [p["id"] for p in body["people"]])


class WorksWithNoModelAndNoMoney(_Suggest):
    @override_settings(**NOTHING)
    def test_the_whole_list_answers_with_ai_switched_off_and_touches_no_network(self):
        self._paper(self.me, areas=(AI,))
        colleague = self._person("colleague", "CSE")
        # Two papers, because a topic needs two to be a neighbourhood.
        self._paper(colleague, areas=(AI, VISION), journal="Top", quartile="Q1")
        self._paper(colleague, areas=(AI, VISION), journal="Top", quartile="Q1")
        with patch("urllib.request.urlopen", side_effect=AssertionError("no network")):
            body = self._next()
        self.assertTrue(body["people"])
        self.assertTrue(body["journals"])
        self.assertTrue(body["topics"])

    def test_nobody_is_told_an_amount(self):
        self._paper(self.me, areas=(AI,))
        colleague = self._person("colleague", "CSE")
        self._paper(colleague, areas=(AI, VISION), journal="Top", quartile="Q1")
        res = self.client.get("/api/discover/next")
        self.assertEqual(money_keys_in(res.json()), [])
        self.assertNotIn("77777", res.content.decode())

    def test_somebody_we_know_nothing_about_is_told_why_it_is_empty(self):
        body = self._next()
        self.assertEqual((body["people"], body["journals"], body["topics"]), ([], [], []))
        self.assertTrue(body["why_empty"])


class IndustryPartnersNeedAModel(_Suggest):
    @override_settings(**NOTHING)
    def test_without_a_model_it_is_503_not_configured(self):
        res = self.client.get("/api/discover/partners")
        self.assertEqual(res.status_code, 503)

    @override_settings(**GROQ)
    def test_somebody_with_nothing_to_build_on_is_told_why_without_asking_the_model(self):
        # Found in review: the explanation was keyed `note`, which the
        # money filter strips, so the page showed a misleading fallback.
        def responder(req):
            assert req.full_url.endswith("/models"), "no completion may be asked for"
            return _Response(json.dumps({"data": [{"id": "llama-3.3-70b-versatile"}]}).encode())

        with patch("urllib.request.urlopen", _Captured(responder)):
            res = self.client.get("/api/discover/partners")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["partners"], [])
        self.assertIn("nothing of yours to build on", res.json()["why_empty"])

    @override_settings(**GROQ)
    def test_with_a_model_the_names_come_back_marked_as_suggestions(self):
        self._paper(self.me, areas=(AI,), title="Edge inference for crop disease")

        def responder(req):
            if req.full_url.endswith("/models"):
                return _Response(json.dumps({"data": [{"id": "llama-3.3-70b-versatile"}]}).encode())
            answer = {
                "partners": [
                    {"name": "Acme Agritech", "kind": "company", "why": "Builds farm sensors.",
                     "first_step": "Write to their research lead."},
                    {"name": "", "why": "nameless"},
                ]
            }
            return _Response(json.dumps(
                {"choices": [{"message": {"content": json.dumps(answer)}}]}
            ).encode())

        captured = _Captured(responder)
        with patch("urllib.request.urlopen", captured):
            res = self.client.get("/api/discover/partners")
        self.assertEqual(res.status_code, 200, res.content[:300])
        body = res.json()
        self.assertEqual([p["name"] for p in body["partners"]], ["Acme Agritech"])
        self.assertTrue(body["unverified"])
        self.assertEqual(body["model"], "llama-3.3-70b-versatile")
        prompt = json.loads(captured.requests[-1].data.decode())["messages"][-1]["content"]
        self.assertIn(AI, prompt)
