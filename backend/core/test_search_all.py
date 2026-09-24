"""/api/search/all: grouped local search, ranked, permission-scoped, money-free."""

from __future__ import annotations

from django.test import Client

from core.models import Claim, ClaimStatus, Role, User
from core.test_publications import _Base
from core.test_search import money_keys_in


class SearchAllTests(_Base):
    def setUp(self):
        super().setUp()
        self.harvest()
        self.client = Client()
        self.client.force_login(self.joyal)
        self.mine = Claim.objects.create(owner=self.joyal, status=ClaimStatus.SUBMITTED, ticket_number="SEC-001",
                                         paper_title="Fuzzy control of a grid", doi="10.1/w1", remuneration=5000)
        self.theirs = Claim.objects.create(owner=self.subha, status=ClaimStatus.PAID, ticket_number="SEC-002",
                                           paper_title="Fuzzy harvesting for Subha", remuneration=9000)

    def get(self, url, status=200):
        r = self.client.get(url)
        self.assertEqual(r.status_code, status, r.content)
        body = r.json()
        self.assertEqual(money_keys_in(body), [])
        return body

    def group(self, body, kind):
        return next(g for g in body["groups"] if g["kind"] == kind)

    def test_groups_across_kinds(self):
        body = self.get("/api/search/all?q=fuzzy")
        kinds = [g["kind"] for g in body["groups"]]
        self.assertEqual(kinds, ["person", "paper", "claim", "journal", "topic", "department"])
        papers = self.group(body, "paper")
        self.assertGreaterEqual(papers["total"], 2)
        self.assertTrue(papers["items"][0]["meta"]["mine"])  # mine first
        self.assertIn("Yours", papers["items"][0]["chips"])

    def test_people_members_and_external(self):
        body = self.get("/api/search/all?q=joyal&scope=people")
        self.assertEqual([g["kind"] for g in body["groups"]], ["person"])
        self.assertEqual(self.group(body, "person")["items"][0]["title"], "Mr. S. Joyal Isac")
        ext = self.get("/api/search/all?q=outsider&scope=people")["groups"][0]["items"]
        self.assertTrue(ext[0]["meta"]["external"])
        self.assertEqual(ext[0]["meta"]["college_coauthors"][0]["name"], "Mr. S. Joyal Isac")

    def test_faculty_sees_only_own_claims_without_desk_status(self):
        items = self.group(self.get("/api/search/all?q=fuzzy&scope=papers"), "claim")["items"]
        self.assertEqual([i["id"] for i in items], [self.mine.id])
        self.assertNotIn("SUBMITTED", items[0]["chips"])

    def test_desk_sees_college_claims(self):
        desk = User.objects.create_user(email="rc@x.edu", password=None, name="Cell", role=Role.RESEARCH_CELL)
        self.client.force_login(desk)
        items = self.group(self.get("/api/search/all?q=fuzzy&scope=papers"), "claim")["items"]
        self.assertEqual({i["id"] for i in items}, {self.mine.id, self.theirs.id})

    def test_exact_doi_and_ticket(self):
        self.assertEqual(self.get("/api/search/all?q=10.1/w1")["exact"]["id"], self.mine.id)
        self.assertEqual(self.get("/api/search/all?q=sec-001")["exact"]["id"], self.mine.id)
        self.assertIsNone(self.get("/api/search/all?q=SEC-002")["exact"])  # not theirs to see
        self.assertEqual(self.get("/api/search/all?q=10.5555/none")["exact"]["kind"], "doi")

    def test_departments_short_query_and_bad_scope(self):
        deps = self.group(self.get("/api/search/all?q=ece&scope=departments"), "department")
        self.assertEqual(deps["items"][0]["title"], "ECE")
        self.assertEqual(self.get("/api/search/all?q=a")["groups"], [])
        self.get("/api/search/all?q=abc&scope=nope", status=400)

    def test_signed_out(self):
        self.assertIn(Client().get("/api/search/all?q=fuzzy").status_code, (401, 403))
