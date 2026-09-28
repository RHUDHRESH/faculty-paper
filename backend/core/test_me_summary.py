"""/api/me/summary (the Home hero) and /api/public/stats (the sign-in line)."""
from datetime import date

from django.core.cache import cache
from django.test import Client, TestCase

from core.api.me_summary import PUBLIC_STATS_KEY, h_index, strip_of
from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.services import impact_card


class HIndexTests(TestCase):
    def test_h_index(self):
        self.assertEqual(h_index([]), 0)
        self.assertEqual(h_index([10, 8, 5, 4, 3]), 4)
        self.assertEqual(h_index([1, 0, 0]), 1)


class MeSummaryTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="me@x.edu", password="p", name="Me", role=Role.FACULTY,
            staff_id="S1", department="Physics",
        )
        self.peer = User.objects.create_user(
            email="p@x.edu", password="p", name="Peer", role=Role.FACULTY,
            staff_id="S2", department="physics",
        )
        self.c = Client()
        self.c.force_login(self.me)

    def _ledger(self, sid, title, month, amount=1000):
        return PaidLedger.objects.create(
            staff_id=sid, paper_title=title, payout_month=month, amount=amount
        )

    def test_counts_match_the_impact_card(self):
        self._ledger("S1", "Alpha", date(2024, 3, 1))
        self._ledger("S1", "Beta", date(2024, 3, 1), amount=0)  # a recorded paper, no money
        self._ledger("S2", "Gamma", date(2023, 1, 1))
        Claim.objects.create(owner=self.me, status=ClaimStatus.SUBMITTED, paper_title="Moving", remuneration=5000)
        Claim.objects.create(owner=self.me, status=ClaimStatus.REJECTED, paper_title="Back")
        Claim.objects.create(owner=self.me, status=ClaimStatus.DRAFT, paper_title="")

        body = self.c.get("/api/me/summary").json()
        card = impact_card.summary(self.me)
        self.assertEqual(body["papers"], card["papers"])
        self.assertEqual(body["papers"], 2)
        self.assertEqual(body["papers_source"], "record")
        self.assertIsNone(body["unclaimed"])
        self.assertEqual(body["dept_rank"]["rank"], card["rank"])
        self.assertEqual(body["dept_rank"]["of"], 2)
        self.assertEqual((body["returned"], body["drafts"], body["on_the_way"]), (1, 1, 1))
        self.assertEqual(body["money"]["to_date"], 1000)
        self.assertEqual(body["money"]["on_the_way"], 5000)
        self.assertIn({"month": "2024-03", "papers": 2}, body["strip"])

    def test_empty_record_is_honest(self):
        body = self.c.get("/api/me/summary").json()
        self.assertEqual(body["papers"], 0)
        self.assertIsNone(body["citations"])
        self.assertIsNone(body["h_index"])
        self.assertIsNone(body["dept_rank"])
        self.assertEqual(body["strip"], [])

    def test_needs_a_session(self):
        self.assertIn(Client().get("/api/me/summary").status_code, (401, 403))

    def test_strip_keeps_only_the_last_ten_years(self):
        class R:
            def __init__(self, d):
                self.filed_on = d
        rows = [R(date(2010, 1, 1)), R(date(2025, 5, 1)), R(date(2025, 5, 9))]
        self.assertEqual(strip_of(rows, date(2026, 9, 24)), [{"month": "2025-05", "papers": 2}])


class PublicStatsTests(TestCase):
    def setUp(self):
        cache.delete(PUBLIC_STATS_KEY)

    def test_anonymous_counts_without_personal_data(self):
        User.objects.create_user(email="a@x.edu", password="p", name="A", role=Role.FACULTY, staff_id="A1", department="ECE")
        User.objects.create_user(email="b@x.edu", password="p", name="B", role=Role.HOD, staff_id="B1", department="ece")
        User.objects.create_user(email="c@x.edu", password="p", name="C", role=Role.FINANCE, department="Accounts")
        PaidLedger.objects.create(staff_id="A1", paper_title="One", payout_month=date(2024, 1, 1), amount=10)
        PaidLedger.objects.create(staff_id="B1", paper_title="One", payout_month=date(2024, 1, 1), amount=10)
        PaidLedger.objects.create(staff_id="ZZ", paper_title="Two", payout_month=date(2024, 1, 1), amount=10)

        r = Client().get("/api/public/stats")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"papers": 2, "faculty": 2, "departments": 1})

    def test_cached_for_an_hour(self):
        Client().get("/api/public/stats")
        User.objects.create_user(email="n@x.edu", password="p", name="N", role=Role.FACULTY)
        self.assertEqual(Client().get("/api/public/stats").json()["faculty"], 0)
