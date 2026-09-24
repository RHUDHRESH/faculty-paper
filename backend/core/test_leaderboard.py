"""The leaderboard: who and which department published, counted honestly.

What is pinned here, in the order a reader of the page would doubt it:

- what counts as a paper (filed and published do; drafts and rejections do
  not), and that the historic ledger -- 3,000 imported rows with no claim
  behind them -- counts too, with the quartile its own row recorded;
- that one paper is one paper however many rows describe it;
- the weighting, which the page prints and this file checks;
- the four periods, cut at 1 June for the academic year;
- that no rupee figure reaches any reader, at any role;
- that the reader can find themselves, and see which way they moved.
"""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.services import leaderboard, paper_facts
from core.test_search import money_keys_in

TODAY = date(2026, 9, 24)  # academic year 2026-27 began on 1 June 2026


def _raw(**cells) -> str:
    base = {
        "Scopus Article Title": cells.pop("title", "A paper"),
        "Source Title": cells.pop("journal", "Journal of Things"),
        "SJR Quartile": cells.pop("quartile", "Q2"),
        "Indexing Status": cells.pop("indexing", "Indexed"),
        "Publication Date": cells.pop("published", "2026-07-10 00:00:00"),
        "DOI": cells.pop("doi", "-"),
        "Subject Area": cells.pop("subjects", "Artificial Intelligence (Q2)"),
        "Amount": cells.pop("amount", "12345.0"),
    }
    base.update(cells)
    return json.dumps(base)


class _Board(TestCase):
    def setUp(self):
        cache.clear()
        paper_facts.forget()
        today = patch("core.services.leaderboard.today", return_value=TODAY)
        today.start()
        self.addCleanup(today.stop)

        self.asha = self._person("asha", "ECE", staff_id="TSEC001")
        self.ravi = self._person("ravi", "ECE", staff_id="TSEC002")
        self.mina = self._person("mina", "CSE", staff_id="TSCS001")
        self.head = self._person("head", "CSE", role=Role.HOD, staff_id="TSCS900")
        self.principal = User.objects.create_user(
            email="principal@x.edu", password=None, name="Principal", role=Role.PRINCIPAL
        )
        self.client = Client()

    def _person(self, name, dept, *, role=Role.FACULTY, staff_id=None, active=True):
        return User.objects.create_user(
            email=f"{name}@x.edu", password=None, name=name.title(), role=role,
            department=dept, staff_id=staff_id, active=active,
        )

    def _claim(self, owner, *, status=ClaimStatus.PAID, title="A claim", doi=None,
               quartile="Q1", year=2026, date_=None, position=1, indexing="Scopus",
               journal="Journal of Things", subjects=None, remuneration=54321.0):
        return Claim.objects.create(
            owner=owner, status=status, paper_title=title, doi=doi, quartile=quartile,
            publication_year=year, publication_date=date_, author_position=position,
            indexing_level=indexing, journal_title=journal, subjects_json=subjects,
            remuneration=remuneration,
        )

    def _ledger(self, staff_id, *, claim=None, month=date(2026, 8, 1), **cells):
        return PaidLedger.objects.create(
            payout_month=month, staff_id=staff_id, claim=claim,
            paper_title=cells.get("title", "A paper"), amount=12345.0,
            raw_json=_raw(**cells),
        )

    def _get(self, viewer, **params):
        self.client.force_login(viewer)
        res = self.client.get("/api/leaderboard", params)
        self.assertEqual(res.status_code, 200, res.content[:300])
        return res.json()

    def _row(self, body, user):
        return next(r for r in body["rows"] if r["id"] == user.id)


class WhatCountsAsAPaper(_Board):
    def test_filed_and_published_count_but_drafts_and_rejections_do_not(self):
        self._claim(self.asha, status=ClaimStatus.PAID, title="Paid one")
        self._claim(self.asha, status=ClaimStatus.SUBMITTED, title="Under review")
        self._claim(self.asha, status=ClaimStatus.DRAFT, title="A draft")
        self._claim(self.asha, status=ClaimStatus.REJECTED, title="Rejected")
        body = self._get(self.asha, period="all")
        self.assertEqual(self._row(body, self.asha)["papers"], 2)

    def test_a_historic_ledger_row_counts_for_its_staff_id_with_its_own_quartile(self):
        self._ledger("tsec002", title="Old one", quartile="Q1")  # case differs
        body = self._get(self.asha, period="all")
        ravi = self._row(body, self.ravi)
        self.assertEqual(ravi["papers"], 1)
        self.assertEqual(ravi["q1"], 1)
        self.assertEqual(ravi["score"], 4)

    def test_one_paper_is_counted_once_however_many_rows_describe_it(self):
        claim = self._claim(self.asha, title="Deep nets", doi="10.1/abc")
        # The ledger row paid for the claim, and a claim-less copy of the
        # same paper arrived with the historic import under another spelling.
        self._ledger("TSEC001", claim=claim, title="Deep nets")
        self._ledger("TSEC001", title="DEEP NETS.", doi="https://doi.org/10.1/ABC")
        body = self._get(self.asha, period="all")
        self.assertEqual(self._row(body, self.asha)["papers"], 1)

    def test_rows_for_people_no_longer_on_the_roster_are_left_out_and_said_so(self):
        self._ledger("GONE-01", title="By somebody who left")
        body = self._get(self.asha, period="all")
        self.assertEqual(body["totals"]["papers"], 0)
        self.assertEqual(body["method"]["left_out"], 1)

    def test_only_faculty_and_heads_are_ranked(self):
        body = self._get(self.principal, period="all")
        ids = {r["id"] for r in body["rows"]}
        self.assertEqual(ids, {self.asha.id, self.ravi.id, self.mina.id, self.head.id})
        self.assertIsNone(body["me"])


class TheWeighting(_Board):
    def test_q1_to_q4_weigh_four_to_one_and_other_indexed_papers_one(self):
        for i, q in enumerate(["Q1", "Q2", "Q3", "Q4", "Others", None]):
            self._claim(self.asha, title=f"Paper {i}", quartile=q)
        self._claim(self.asha, title="Not indexed", quartile=None, indexing=None)
        row = self._row(self._get(self.asha, period="all"), self.asha)
        self.assertEqual(row["papers"], 7)
        self.assertEqual(row["q1"], 1)
        self.assertEqual(row["score"], 4 + 3 + 2 + 1 + 1 + 1 + 0)

    def test_the_page_is_told_the_weights_it_prints(self):
        body = self._get(self.asha, period="all")
        self.assertEqual(
            body["method"]["weights"], {"Q1": 4, "Q2": 3, "Q3": 2, "Q4": 1, "other_indexed": 1}
        )

    def test_first_author_comes_from_claims_because_the_ledger_never_recorded_it(self):
        self._claim(self.asha, title="First", position=1)
        self._claim(self.asha, title="Third", position=3)
        self._ledger("TSEC001", title="Historic")
        row = self._row(self._get(self.asha, period="all"), self.asha)
        self.assertEqual(row["first_author"], 1)
        self.assertEqual(row["papers"], 3)


class ThePeriods(_Board):
    def test_the_academic_year_starts_on_1_june(self):
        self._claim(self.asha, title="May", date_="2026-05-31")
        self._claim(self.asha, title="June", date_="2026-06-01")
        this_year = self._row(self._get(self.asha, period="academic"), self.asha)
        last_year = self._row(self._get(self.asha, period="last_academic"), self.asha)
        self.assertEqual((this_year["papers"], last_year["papers"]), (1, 1))

    def test_calendar_year_and_all_time(self):
        self._claim(self.asha, title="Jan this year", date_="2026-01-15")
        self._claim(self.asha, title="Last year", date_="2025-12-31")
        self.assertEqual(self._row(self._get(self.asha, period="calendar"), self.asha)["papers"], 1)
        self.assertEqual(self._row(self._get(self.asha, period="all"), self.asha)["papers"], 2)

    def test_a_year_on_its_own_counts_from_1_january(self):
        self._claim(self.asha, title="Year only", year=2026, date_=None)
        self.assertEqual(self._row(self._get(self.asha, period="academic"), self.asha)["papers"], 0)
        self.assertEqual(self._row(self._get(self.asha, period="last_academic"), self.asha)["papers"], 1)

    def test_a_ledger_date_stored_as_an_excel_serial_is_read(self):
        # 46218 is 2026-07-15.
        self._ledger("TSEC001", title="Serial", published="46218.0")
        self.assertEqual(self._row(self._get(self.asha, period="academic"), self.asha)["papers"], 1)

    def test_the_period_is_described_with_its_dates(self):
        period = self._get(self.asha, period="academic")["period"]
        self.assertEqual((period["from"], period["to"]), ("2026-06-01", "2027-05-31"))
        self.assertEqual(period["compared_with"]["from"], "2025-06-01")

    def test_an_unknown_period_or_board_is_refused(self):
        self.client.force_login(self.asha)
        self.assertEqual(self.client.get("/api/leaderboard", {"period": "decade"}).status_code, 400)
        self.assertEqual(self.client.get("/api/leaderboard", {"board": "moon"}).status_code, 400)
        self.assertEqual(self.client.get("/api/leaderboard", {"sort": "money"}).status_code, 400)


class NoMoneyReachesAnybody(_Board):
    def test_no_money_key_or_figure_in_either_board_at_any_role(self):
        self._claim(self.asha, title="Paid", remuneration=54321.0)
        self._ledger("TSEC002", title="Historic")  # amount 12345.0
        for viewer in (self.asha, self.head, self.principal):
            for board in ("people", "departments"):
                self.client.force_login(viewer)
                res = self.client.get("/api/leaderboard", {"board": board, "period": "all"})
                self.assertEqual(res.status_code, 200)
                text = res.content.decode()
                self.assertEqual(money_keys_in(res.json()), [], f"{viewer.role} {board}")
                for figure in ("54321", "12345", "₹", "remuneration"):
                    self.assertNotIn(figure, text, f"{viewer.role} {board}")


class FindingYourself(_Board):
    def test_the_viewer_is_told_their_place_and_marked_in_the_rows(self):
        self._claim(self.ravi, title="R1", quartile="Q1")
        self._claim(self.ravi, title="R2", quartile="Q1")
        self._claim(self.asha, title="A1", quartile="Q2")
        body = self._get(self.asha, period="all")
        self.assertEqual(body["me"]["rank"], 2)
        self.assertEqual(body["me"]["of"], 4)
        self.assertTrue(self._row(body, self.asha)["me"])
        self.assertFalse(self._row(body, self.ravi)["me"])

    def test_equal_scores_share_a_place(self):
        self._claim(self.asha, title="A1", quartile="Q1")
        self._claim(self.ravi, title="R1", quartile="Q1")
        body = self._get(self.asha, period="all")
        self.assertEqual(self._row(body, self.asha)["rank"], 1)
        self.assertEqual(self._row(body, self.ravi)["rank"], 1)
        self.assertTrue(body["me"]["joint"])
        self.assertEqual(self._row(body, self.mina)["rank"], 3)

    def test_movement_is_against_the_period_before(self):
        # Last academic year Ravi led; this year Asha does, and Ravi is second.
        self._claim(self.ravi, title="R old", date_="2025-09-01", quartile="Q1")
        self._claim(self.ravi, title="R new", date_="2026-07-01", quartile="Q4")
        self._claim(self.asha, title="A new", date_="2026-07-01", quartile="Q1")
        body = self._get(self.asha, period="academic")
        self.assertEqual(self._row(body, self.asha)["movement"], 1)
        self.assertEqual(self._row(body, self.ravi)["movement"], -1)
        self.assertIsNone(self._row(body, self.mina)["movement"])

    def test_nothing_this_period_claims_no_movement(self):
        # Found on the real data: a head with papers last year and none yet
        # this year was shown "up 21 places", because everybody with nothing
        # shares the bottom place and few have published this early in the
        # year. A place earned by having nothing is not a move.
        for i in range(3):
            self._claim(self.ravi, title=f"R old {i}", date_="2025-09-01", quartile="Q1")
        self._claim(self.mina, title="M old", date_="2025-09-01", quartile="Q4")
        self._claim(self.asha, title="A new", date_="2026-07-01", quartile="Q1")
        body = self._get(self.asha, period="academic")
        self.assertIsNone(self._row(body, self.mina)["movement"])
        self.assertIsNone(self._row(body, self.ravi)["movement"])
        board = self._get(self.asha, period="academic", board="departments")
        cse = next(r for r in board["rows"] if r["department"] == "CSE")
        self.assertIsNone(cse["movement"])

    def test_a_department_filter_ranks_within_it(self):
        self._claim(self.mina, title="M1", quartile="Q1")
        self._claim(self.asha, title="A1", quartile="Q4")
        body = self._get(self.asha, period="all", department="ECE")
        self.assertEqual({r["id"] for r in body["rows"]}, {self.asha.id, self.ravi.id})
        self.assertEqual(body["me"], {**body["me"], "rank": 1, "of": 2})
        self.assertIn("CSE", body["departments"])


class TheDepartmentBoard(_Board):
    def test_a_paper_two_colleagues_share_counts_once_for_the_department(self):
        self._claim(self.asha, title="Shared", doi="10.9/shared", quartile="Q1")
        self._claim(self.ravi, title="Shared", doi="10.9/shared", quartile="Q1", position=2)
        self._claim(self.mina, title="Solo", quartile="Q3")
        body = self._get(self.asha, board="departments", period="all")
        ece = next(r for r in body["rows"] if r["department"] == "ECE")
        cse = next(r for r in body["rows"] if r["department"] == "CSE")
        self.assertEqual((ece["papers"], ece["q1"], ece["score"], ece["first_author"]), (1, 1, 4, 1))
        self.assertEqual(ece["people"], 2)
        self.assertEqual(ece["per_head"]["score"], 2.0)
        self.assertEqual((cse["papers"], cse["people"]), (1, 2))
        self.assertEqual(body["me"]["rank"], 1)
        self.assertEqual(body["me"]["department"], "ECE")

    def test_somebody_who_is_not_ranked_has_no_department_on_the_board(self):
        # Found on the real data: the principal's account carries a
        # department, and was told "Your department is 12th of 22".
        self.principal.department = "CSE"
        self.principal.save()
        body = self._get(self.principal, board="departments", period="all")
        self.assertIsNone(body["me"])
        self.assertFalse(any(r["me"] for r in body["rows"]))

    def test_ranking_per_head_is_a_different_order(self):
        # ECE: two Q3 papers (score 4) across two people, 2.0 each.
        # CSE: one Q2 paper (score 3) across one person once the head is
        # switched off, 3.0 each. Totals put ECE first; per head, CSE.
        self.head.active = False
        self.head.save()
        self._claim(self.asha, title="E1", quartile="Q3")
        self._claim(self.ravi, title="E2", quartile="Q3")
        self._claim(self.mina, title="C1", quartile="Q2")
        by_total = self._get(self.asha, board="departments", period="all")
        by_head = self._get(self.asha, board="departments", period="all", per_head="true")
        self.assertEqual(by_total["rows"][0]["department"], "ECE")  # 4 vs 3
        self.assertEqual(by_head["rows"][0]["department"], "CSE")  # 3.0 vs 2.0


class TheFactsAreComputedOnceAndReused(_Board):
    def test_a_second_read_within_the_window_asks_the_database_nothing(self):
        self._claim(self.asha, title="A1")
        paper_facts.load()
        with self.assertNumQueries(0):
            paper_facts.load()

    def test_the_whole_build_is_three_queries(self):
        self._claim(self.asha, title="A1")
        self._ledger("TSEC002", title="Historic")
        paper_facts.forget()
        with self.assertNumQueries(3):
            paper_facts.load()

    def test_an_area_cut_off_at_the_ledgers_100_characters_is_dropped(self):
        # Measured on the live ledger: 1,068 "Subject Area" cells are exactly
        # 100 characters, ending in fragments like "Signal Processing (" --
        # which surfaced on Discover as a topic called "Materials Science (misc".
        cut = "Artificial Intelligence (Q1); Computer Vision and Pattern Recognition (Q1); Materials Science (misc"
        cut = cut + "x" * (100 - len(cut)) if len(cut) < 100 else cut[:100]
        whole = "Artificial Intelligence (Q1); Signal Processing (Q2)"
        self._ledger("TSEC001", title="Cut", subjects=cut)
        self._ledger("TSEC001", title="Whole", subjects=whole)
        facts = {f.title: f.subjects for f in paper_facts.load().facts}
        self.assertEqual(
            facts["Cut"], ("Artificial Intelligence", "Computer Vision and Pattern Recognition")
        )
        self.assertEqual(facts["Whole"], ("Artificial Intelligence", "Signal Processing"))

    def test_a_blank_subject_spelling_is_not_an_area(self):
        self._ledger("TSEC001", title="Blank areas", subjects="N/A; -; Artificial Intelligence (Q2)")
        facts = paper_facts.load()
        self.assertEqual([f.subjects for f in facts.facts], [("Artificial Intelligence",)])

    def test_the_board_itself_is_pure_arithmetic_over_the_facts(self):
        facts = paper_facts.load()
        board = leaderboard.people_board(facts, period="all", sort="score", viewer=self.asha)
        self.assertEqual(len(board["rows"]), 4)
