"""The report-grade leaderboard (docs/ux/07) and the wall's congratulations.

Pinned on a small fixture where every figure can be worked out by hand:
each category's winner and value, zeros left unranked (no "=54"), ties,
per-faculty department figures, filters, the reader's own place, and that
no money key reaches any role.
"""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Authorship, PaidLedger, Publication, Role, User
from core.services import honours_board
from core.test_search import money_keys_in

TODAY = date(2026, 9, 24)  # academic year 2026-27 from 1 June 2026


def pub(title, when, *, quartile="", cites=0, venue="Journal A", topics=("Power systems",)):
    return Publication.objects.create(
        title=title, year=when.year if when else None, date=when, quartile=quartile, citations=cites,
        venue=venue, topics_json=json.dumps(list(topics)), source="record",
    )


def on(p, user=None, position=None, name="Outside", country=""):
    return Authorship.objects.create(
        publication=p, user=user, position=position, display_name=user.name if user else name,
        author_key=f"u:{user.id}" if user else f"n:{name.lower()}", is_college=user is not None,
        institution_country=country,
    )


class HonoursBoardTests(TestCase):
    def setUp(self):
        cache.clear()
        honours_board.forget()
        for target in ("core.services.honours_board.today", "core.services.leaderboard.today"):
            p = patch(target, return_value=TODAY)
            p.start()
            self.addCleanup(p.stop)
        mk = lambda n, d, role=Role.FACULTY: User.objects.create_user(  # noqa: E731
            email=f"{n}@x.edu", password=None, name=n.title(), role=role, department=d)
        self.asha, self.ravi, self.mina = mk("asha", "ECE"), mk("ravi", "ECE"), mk("mina", "CSE")
        self.zero = mk("zero", "CSE")
        self.head = mk("head", "CSE", Role.HOD)
        self.principal = mk("principal", "", Role.PRINCIPAL)

        # This academic year (from 1 June 2026).
        a = pub("Q1 grid", date(2026, 7, 1), quartile="Q1", cites=10, venue="Energy Q1", topics=("Solar",))
        on(a, self.asha, 1)
        on(a, self.mina, 2)          # cross-department for both
        on(a, name="Prof Abroad", country="DE", position=3)
        b = pub("Q2 ece", date(2026, 8, 1), quartile="Q2", cites=3)
        on(b, self.asha, 2)
        on(b, self.ravi, 1)
        c = pub("Unranked", date(2026, 9, 1), cites=1)
        on(c, self.ravi, 1)
        # Last academic year: Mina had 3 Q1 papers, so she fell; Asha was quiet.
        for i in range(3):
            on(pub(f"Old {i}", date(2025, 9, 1), quartile="Q1", cites=5), self.mina, 1)
        # An undated paper: all time only.
        on(pub("Undated", None), self.head, 1)
        # The ledger's money must never surface.
        PaidLedger.objects.create(payout_month=date(2026, 8, 1), staff_id="x", paper_title="Q1 grid", amount=99999.0)
        self.c = Client()

    def get(self, viewer, **params):
        self.c.force_login(viewer)
        r = self.c.get("/api/leaderboard", params)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def row(self, data, user):
        return next(r for r in data["rows"] if r["person"]["id"] == user.id)

    def test_score_board_values_and_podium(self):
        d = self.get(self.asha, category="score", period="academic")
        # Asha: Q1 (4) + Q2 (3) = 7. Ravi: Q2 (3) + other (1) = 4. Mina: Q1 = 4.
        self.assertEqual([(r["person"]["name"], r["value"]) for r in d["podium"]], [("Asha", 7), ("Mina", 4), ("Ravi", 4)])
        self.assertEqual((self.row(d, self.ravi)["rank"], self.row(d, self.ravi)["joint"]), (2, True))
        self.assertEqual(self.row(d, self.asha)["breakdown"], {"q1": 1, "q2": 1, "q3": 0, "q4": 0, "other": 0})
        self.assertEqual(d["ranked"], 3)
        self.assertEqual(d["me"]["rank"], 1)
        self.assertEqual(d["me"]["dept_rank"], 1)
        self.assertEqual(d["me"]["percentile"], 34)

    def test_zero_is_unranked_not_tied(self):
        d = self.get(self.zero, category="score", period="academic")
        mine = self.row(d, self.zero)
        self.assertIsNone(mine["rank"])
        self.assertIsNone(d["me"]["rank"])
        self.assertEqual(d["me"]["value"], 0)
        # Nobody with nothing takes a place.
        self.assertTrue(all(r["value"] > 0 for r in d["rows"] if r["rank"] is not None))

    def test_every_category(self):
        want = {
            "papers": (self.asha, 2),  # Asha 2, Ravi 2 -> joint first
            "q1": (self.asha, 1),
            "first": (self.ravi, 2),
            "cited": (self.asha, 13),
            "h_index": (self.asha, 2),
            "collab": (self.asha, 3),  # Mina, Ravi, the German co-author
            "cross_dept": (self.asha, 1),
            "international": (self.asha, 1),
        }
        for cat, (who, value) in want.items():
            d = self.get(self.asha, category=cat, period="academic")
            self.assertEqual(self.row(d, who)["value"], value, cat)
            self.assertEqual(self.row(d, who)["rank"], 1, cat)
            self.assertEqual(d["measure"], cat)

    def test_rising_compares_with_last_year(self):
        d = self.get(self.asha, category="rising", period="academic")
        self.assertEqual(self.row(d, self.asha)["value"], 7)
        self.assertEqual(self.row(d, self.mina)["value"], 4 - 12)
        self.assertIsNone(self.row(d, self.mina)["rank"])

    def test_newcomers_are_recent_first_papers(self):
        d = self.get(self.asha, category="newcomer", period="all")
        ids = {r["person"]["id"] for r in d["rows"]}
        self.assertIn(self.asha.id, ids)
        self.assertNotIn(self.head.id, ids)  # undated, never placed as new

    def test_undated_counts_in_all_time_only(self):
        self.assertIsNone(self.row(self.get(self.head, category="papers", period="academic"), self.head)["rank"])
        self.assertEqual(self.row(self.get(self.head, category="papers", period="all"), self.head)["value"], 1)

    def test_departments_count_each_paper_once_and_per_faculty(self):
        d = self.get(self.asha, category="papers", period="academic")
        ece = next(x for x in d["departments"] if x["department"] == "ECE")
        cse = next(x for x in d["departments"] if x["department"] == "CSE")
        self.assertEqual((ece["papers"], ece["faculty"], ece["per_faculty"]), (3, 2, 1.5))
        self.assertEqual((cse["papers"], cse["faculty"]), (1, 3))
        self.assertEqual(len(ece["trend"]), 5)

    def test_scope_and_filters(self):
        d = self.get(self.asha, category="papers", period="academic", department="cse")
        self.assertEqual({r["person"]["id"] for r in d["rows"]}, {self.mina.id, self.zero.id, self.head.id})
        d = self.get(self.asha, category="papers", period="academic", topic="Solar")
        self.assertEqual(self.row(d, self.asha)["value"], 1)
        self.assertIsNone(self.row(d, self.ravi)["rank"])
        d = self.get(self.asha, category="papers", period="academic", journal="energy q1")
        self.assertEqual(d["totals"]["papers"], 1)

    def test_distribution_and_trend(self):
        d = self.get(self.asha, category="score", period="academic")
        self.assertEqual(sum(b["count"] for b in d["distribution"]), d["population"])
        self.assertEqual(d["distribution"][0]["count"], 2)  # zero and head
        self.assertEqual(len(d["college_trend"]), 10)

    def test_no_money_at_any_role(self):
        for viewer in (self.asha, self.head, self.principal):
            for cat in honours_board.CATEGORIES:
                d = self.get(viewer, category=cat, period="all")
                self.assertEqual(money_keys_in(d), [], (viewer.role, cat))
                self.assertNotIn("99999", json.dumps(d))

    def test_bad_inputs(self):
        self.c.force_login(self.asha)
        self.assertEqual(self.c.get("/api/leaderboard", {"category": "money"}).status_code, 400)
        self.assertEqual(self.c.get("/api/leaderboard", {"category": "score", "period": "ever"}).status_code, 400)

    def test_zero_viewer_hears_their_all_time_rank(self):
        d = self.get(self.head, category="papers", period="academic")
        self.assertIsNone(d["me"]["rank"])
        self.assertIsNotNone(d["me"]["alltime_rank"])


class WallCheerTests(TestCase):
    def setUp(self):
        cache.clear()
        self.a = User.objects.create_user(email="a@x.edu", password=None, name="A", role=Role.FACULTY, department="ECE")
        self.b = User.objects.create_user(email="b@x.edu", password=None, name="B", role=Role.FACULTY, department="ECE")
        self.c = Client()

    def test_cheer_once_per_person(self):
        with patch("core.api.rewards._papers", return_value={"paper-key": []}):
            self.c.force_login(self.a)
            r1 = self.c.post("/api/wall/cheer", {"key": "paper-key"}, content_type="application/json").json()
            r2 = self.c.post("/api/wall/cheer", {"key": "paper-key"}, content_type="application/json").json()
            self.assertEqual((r1["reaction_count"], r2["reaction_count"], r2["me_reacted"]), (1, 1, True))
            self.c.force_login(self.b)
            r3 = self.c.post("/api/wall/cheer", {"key": "paper-key"}, content_type="application/json").json()
            self.assertEqual(r3["reaction_count"], 2)
            r4 = self.c.delete("/api/wall/cheer?key=paper-key").json()
            self.assertEqual((r4["reaction_count"], r4["me_reacted"]), (1, False))
            self.assertEqual(
                self.c.post("/api/wall/cheer", {"key": "nope"}, content_type="application/json").status_code, 404
            )
