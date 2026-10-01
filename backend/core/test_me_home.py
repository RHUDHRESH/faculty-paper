"""/api/me/home: the faculty Home's record, and it agrees with My papers."""
from datetime import date

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, PaidLedger, Publication, Role, User


class MyHomeTests(TestCase):
    def setUp(self):
        cache.clear()
        self.me = User.objects.create_user(
            email="me@x.edu", password="p", name="Asha Rao", role=Role.FACULTY,
            staff_id="S1", department="Physics",
        )
        self.c = Client()
        self.c.force_login(self.me)

    def _pub(self, title, year, **kw):
        p = Publication.objects.create(title=title, normalized_title=title.lower(), year=year,
                                       date=date(year, 3, 1), **kw)
        Authorship.objects.create(publication=p, user=self.me, position=1, display_name=self.me.name,
                                  author_key=f"u:{self.me.id}", is_college=True)
        return p

    def test_needs_sign_in(self):
        self.assertIn(Client().get("/api/me/home").status_code, (401, 403))

    def test_empty_record_says_none_not_zero_unfiled(self):
        body = self.c.get("/api/me/home").json()
        self.assertEqual(body["papers"], 0)
        self.assertIsNone(body["citations"])
        self.assertIsNone(body["unfiled"])

    def test_counts_agree_with_my_papers_and_the_summary(self):
        self._pub("Filed already", 2024, citations=4)
        self._pub("Not filed yet", 2025, citations=6)
        self._pub("Paid before this app", 2022)
        PaidLedger.objects.create(staff_id="s1", paper_title="Paid before this app",
                                  payout_month=date(2023, 3, 1), amount=1000)
        filed = Publication.objects.get(title="Filed already")
        claim = Claim.objects.create(owner=self.me, status=ClaimStatus.SUBMITTED, paper_title="Filed already")
        filed.claims.add(claim)

        home = self.c.get("/api/me/home").json()
        summary = self.c.get("/api/me/summary").json()
        mine = self.c.get("/api/me/publications").json()

        self.assertEqual(home["papers"], summary["papers"])
        self.assertEqual(home["papers"], mine["count"])
        self.assertEqual(home["unfiled"]["count"], mine["unclaimed"])
        self.assertEqual(home["unfiled"]["count"], summary["unclaimed"])
        self.assertEqual((home["citations"], home["h_index"]), (summary["citations"], summary["h_index"]))
        self.assertEqual([i["title"] for i in home["unfiled"]["items"]], ["Not filed yet"])

    def test_a_paper_held_twice_is_offered_once_but_still_counted_like_my_papers(self):
        self._pub("Same title twice", 2026)
        self._pub("Same title twice", 2026, doi="10.1/second")
        self._pub("Another", 2025)
        home = self.c.get("/api/me/home").json()
        mine = self.c.get("/api/me/publications").json()
        self.assertEqual(home["unfiled"]["count"], mine["unclaimed"])
        self.assertEqual([i["title"] for i in home["unfiled"]["items"]], ["Same title twice", "Another"])

    def test_names_at_most_three_papers(self):
        for i in range(6):
            self._pub(f"Paper {i}", 2020 + i)
        home = self.c.get("/api/me/home").json()
        self.assertEqual(home["unfiled"]["count"], 6)
        self.assertEqual(len(home["unfiled"]["items"]), 3)
        self.assertEqual(home["unfiled"]["items"][0]["title"], "Paper 5")
