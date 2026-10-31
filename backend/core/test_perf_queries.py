"""Queries that were repeated, or that grew with the page, found by the performance audit.

Every test here pins a query count that must not grow with the data (or must not
repeat inside one request) *and* the answer that comes back, so making a screen
cheaper cannot quietly change what it says.
"""
from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

from django.core.cache import cache
from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext

from core.models import (
    Authorship, DuplicateFinding, FormulaConfig, Publication, Role, ScimagoJournal, SnipSource, User,
)


def _sql(ctx) -> list[str]:
    return [q["sql"] for q in ctx.captured_queries]


def _office(email="office@x.edu") -> User:
    return User.objects.create_user(email=email, password="p", name="Office", role=Role.SUPER_ADMIN)


# --------------------------------------------------------------- author matches --

_FIRST = ["Anil", "Bina", "Chitra", "Deepak", "Esha", "Farid", "Gita", "Harish", "Indira", "Jagan",
          "Kavya", "Lakshmi", "Mohan", "Nalini", "Omkar", "Padma", "Qadir", "Revathi", "Suresh", "Tara"]
_LAST = ["Menon", "Nair", "Pillai", "Rao", "Iyer", "Kumar"]


class AuthorMatchesDoNotGrowWithThePage(TestCase):
    """Each suggested person used to be read again for their email, one query each."""

    def setUp(self):
        cache.clear()
        self.office = _office()
        for i in range(30):
            name = f"{_FIRST[i % 20]} {_LAST[i % 6]}"
            User.objects.create_user(
                email=f"p{i}@x.edu", password=None, name=name, role=Role.FACULTY, department="ECE"
            )
            pub = Publication.objects.create(title=f"Paper {i}", year=2025)
            # The paper's author line is the person's own name, and nobody is linked yet.
            Authorship.objects.create(
                publication=pub, display_name=name, author_key=f"k{i}", is_college=True, position=1
            )
        self.c = Client()
        self.c.force_login(self.office)

    def _get(self, limit):
        return self.c.get(f"/api/admin/author-matches?limit={limit}")

    def test_the_queries_are_the_same_for_ten_rows_and_thirty(self):
        self._get(30)  # builds what is kept between requests
        with CaptureQueriesContext(connection) as ten:
            small = self._get(10)
        with CaptureQueriesContext(connection) as thirty:
            big = self._get(30)
        self.assertEqual((small.status_code, big.status_code), (200, 200))
        self.assertEqual(len(small.json()["items"]), 10)
        self.assertEqual(len(big.json()["items"]), 30)
        self.assertEqual(len(ten.captured_queries), len(thirty.captured_queries), _sql(thirty))

    def test_a_suggestion_still_names_the_person_with_their_email(self):
        item = self._get(30).json()["items"][0]
        suggestion = item["suggestions"][0]
        self.assertGreaterEqual(set(suggestion), {"id", "name", "department", "email", "score"})
        self.assertTrue(suggestion["email"].endswith("@x.edu"))
        self.assertEqual(suggestion["department"], "ECE")


# ------------------------------------------------------------------- the compass --


def _journal(title, issn, year=2025, quartile="Q1"):
    return ScimagoJournal.objects.create(
        title=title, issn=issn, year=year, sjr=1.5,
        categories_json=json.dumps([{"name": "Physics", "quartile": quartile}]),
    )


class JournalsAreLookedUpTogether(TestCase):
    def setUp(self):
        self.names = [f"Journal of Compass Studies {chr(65 + i)}" for i in range(8)]
        self.rows = [_journal(n, f"1000-000{i}") for i, n in enumerate(self.names)]
        for i, row in enumerate(self.rows[:6]):
            SnipSource.objects.create(title=row.title, print_issn=row.issn, snip=1.0 + i, year=2025)
        # A second, older SNIP for the first journal: the newest year wins.
        SnipSource.objects.create(title=self.rows[0].title, print_issn=self.rows[0].issn, snip=9.9, year=2020)

    def test_eight_journals_cost_two_queries_not_sixteen(self):
        from core.services import discover

        with CaptureQueriesContext(connection) as ctx:
            found = discover.find_journals(self.names, year=2025)
            described = discover.describe_journals([r for r in found.values() if r])
        self.assertLessEqual(len(ctx.captured_queries), 2, _sql(ctx))
        self.assertEqual({n: r.id for n, r in found.items()}, {r.title: r.id for r in self.rows})
        self.assertEqual(described[self.rows[0].id]["snip"], 1.0)  # not the older 9.9
        self.assertIsNone(described[self.rows[7].id]["snip"])  # no SNIP row for the last two

    def test_each_answer_is_what_looking_the_journal_up_alone_gives(self):
        from core.services import discover

        asked = [
            self.names[0].upper(),                  # case differs
            "  " + self.names[1] + "  ",             # padding
            "Compass Studies C, Journal of",         # words out of order: no exact title, no match
            "A Journal Nobody Has Heard Of",         # nothing
            "",                                       # nothing at all
        ]
        together = discover.find_journals(asked, year=2025)
        for name in asked:
            alone = discover.find_journal(name, year=2025)
            self.assertEqual(getattr(together[name], "id", None), getattr(alone, "id", None), name)

    def test_a_name_that_only_matches_by_its_words_is_still_found(self):
        from core.services import discover

        row = _journal("IEEE Transactions on Quantum Widgets", "2000-0001")
        got = discover.find_journals(["Ieee Transactions on Quantum Widgets."], year=2025)
        self.assertEqual(got["Ieee Transactions on Quantum Widgets."].id, row.id)

    def test_the_description_is_the_one_describe_journal_gives(self):
        from core.services import discover

        for row in self.rows:
            self.assertEqual(discover.describe_journals([row])[row.id], discover.describe_journal(row))

    def test_the_compass_looks_its_journals_up_together(self):
        from core.services import compass

        user = User.objects.create_user(email="me@x.edu", password=None, name="Me", role=Role.FACULTY)
        pubs = {
            f"p{i}": {"venue": name, "type": "article", "quartile": "Q1", "members": {f"colleague{i}"},
                      "keys": frozenset({"physics"}), "topics": ["Physics"]}
            for i, name in enumerate(self.names)
        }
        college = SimpleNamespace(pubs=pubs)
        with CaptureQueriesContext(connection) as ctx:
            out = compass._journals(user, college, [], {"physics"})
        self.assertLessEqual(len(ctx.captured_queries), 4, _sql(ctx))  # latest year, titles, SNIPs
        self.assertEqual(len(out), 4)
        self.assertTrue(all(j["journal_id"] for j in out))


# -------------------------------------------------------------------- readiness --


class DeskChecksAskOnce(TestCase):
    def setUp(self):
        User.objects.create_user(email="p@x.edu", password=None, name="Pria Principal", role=Role.PRINCIPAL)
        for i in range(5):
            User.objects.create_user(
                email=f"c{i}@x.edu", password=None, name=f"Coordinator {chr(65 + i)}",
                role=Role.RESEARCH_COORDINATOR,
            )
        User.objects.create_user(email="gone@x.edu", password=None, name="Gone Finance", role=Role.FINANCE, active=False)

    def test_four_desks_cost_one_query(self):
        from core.services import readiness

        with CaptureQueriesContext(connection) as ctx:
            readiness._desk_checks()
        self.assertEqual(len(ctx.captured_queries), 1, _sql(ctx))

    def test_each_desk_says_what_it_said_before(self):
        from core.services import readiness

        by_key = {c["key"]: c for c in readiness._desk_checks()}
        self.assertEqual(list(by_key), ["desk_clearing", "desk_principal", "desk_director", "desk_finance"])
        self.assertTrue(by_key["desk_clearing"]["ok"])
        self.assertEqual(by_key["desk_clearing"]["detail"], "Coordinator A, Coordinator B, Coordinator C and 2 more")
        self.assertEqual(by_key["desk_clearing"]["to"], "/people?role=RESEARCH_COORDINATOR")
        self.assertEqual(by_key["desk_principal"]["detail"], "Pria Principal")
        self.assertFalse(by_key["desk_director"]["ok"])
        self.assertIn("Nobody holds the Director role", by_key["desk_director"]["detail"])
        self.assertFalse(by_key["desk_finance"]["ok"])  # the only finance account is inactive


# ------------------------------------------------------------------- duplicates --


class DuplicateSummaryIsOneAggregate(TestCase):
    def setUp(self):
        self.office = _office()
        spec = [("OPEN", 100.0, None), ("OPEN", 50.0, None), ("CONFIRMED", 30.0, None),
                ("DISMISSED", 20.0, None), ("RECOVERED", 10.0, 7.5), ("RECOVERED", 5.0, 2.25)]
        for i, (status, extra, recovered) in enumerate(spec):
            DuplicateFinding.objects.create(
                kind="SAME_PERSON", status=status, match_key=f"k{i}", faculty_name=f"F{i}",
                rows_json="[]", payment_count=2, total_amount=extra * 2, extra_amount=extra,
                recovered_amount=recovered,
            )
        DuplicateFinding.objects.create(  # another kind: never counted here
            kind="CROSS_PERSON", status="OPEN", match_key="x", faculty_name="X", rows_json="[]",
            extra_amount=999.0,
        )
        self.c = Client()
        self.c.force_login(self.office)

    def test_the_summary_numbers_are_unchanged(self):
        body = self.c.get("/api/admin/duplicate-findings?kind=SAME_PERSON&status=OPEN").json()
        s = body["summary"]
        self.assertEqual(
            (s["open"], s["confirmed"], s["dismissed"], s["recovered"]), (2, 1, 1, 2)
        )
        self.assertEqual(s["at_issue"], 180.0)  # open and confirmed
        self.assertEqual(s["recovered_amount"], 9.75)
        self.assertEqual(body["total"], 2)

    def test_the_summary_with_nothing_in_it_is_zeros(self):
        DuplicateFinding.objects.all().delete()
        s = self.c.get("/api/admin/duplicate-findings?kind=SAME_PERSON").json()["summary"]
        self.assertEqual((s["open"], s["confirmed"], s["dismissed"], s["recovered"]), (0, 0, 0, 0))
        self.assertEqual((s["at_issue"], s["recovered_amount"]), (0, 0))

    def test_the_counts_come_from_one_query(self):
        self.c.get("/api/admin/duplicate-findings")  # session and the like
        with CaptureQueriesContext(connection) as ctx:
            res = self.c.get("/api/admin/duplicate-findings?kind=SAME_PERSON&status=OPEN")
        self.assertEqual(res.status_code, 200)
        summary = [
            s for s in _sql(ctx)
            if "core_duplicatefinding" in s and ("COUNT(" in s.upper() or "SUM(" in s.upper())
            and "GROUP BY" not in s.upper()
        ]
        # The page's own total, one aggregate for every figure of the summary, and
        # the open findings' split between current and legacy. It was eight.
        self.assertLessEqual(len(summary), 3, summary)
        self.assertEqual(sum("FILTER" in s.upper() for s in summary), 1, summary)


# ------------------------------------------------------------------ leaderboard --


class TheResearchYearIsReadOnceAndNeverKept(TestCase):
    def setUp(self):
        cache.clear()
        FormulaConfig.objects.create(active=True, version=1, research_year_start_month=4)
        self.fac = User.objects.create_user(
            email="f@x.edu", password=None, name="Dr Priya", role=Role.FACULTY, department="ECE"
        )
        self.c = Client()
        self.c.force_login(self.fac)

    def _formula_reads(self, path):
        with CaptureQueriesContext(connection) as ctx:
            res = self.c.get(path)
        self.assertEqual(res.status_code, 200, res.content[:200])
        return [s for s in _sql(ctx) if "core_formulaconfig" in s]

    def test_the_leaderboard_reads_the_policy_once(self):
        self.c.get("/api/leaderboard")
        self.assertEqual(len(self._formula_reads("/api/leaderboard")), 1)

    def test_the_period_labels_still_follow_the_policy(self):
        from core.services import research_threshold as rt

        self.assertEqual(rt.year_start_month(), 4)
        FormulaConfig.objects.all().update(active=False)
        FormulaConfig.objects.create(active=True, version=2, research_year_start_month=9)
        # Outside a request nothing is kept...
        self.assertEqual(rt.year_start_month(), 9)

    def test_a_policy_change_is_seen_by_the_next_request(self):
        # In mid-May a year starting in April has begun and one starting in
        # September has not, so the academic year's label differs between them.
        with patch("core.services.leaderboard.today", return_value=date(2026, 5, 15)):
            first = self.c.get("/api/leaderboard").json()["period"]["label"]
            FormulaConfig.objects.all().update(active=False)
            FormulaConfig.objects.create(active=True, version=2, research_year_start_month=9)
            second = self.c.get("/api/leaderboard").json()["period"]["label"]
        self.assertNotEqual(first, second)
