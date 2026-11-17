"""The whole leaderboard is Scopus-only: Most improved, Newcomers and the department
table use the same weighted score as the Overall board, and a name-only match to a
person never counts. Synthetic data only (see core.test_leaderboard_weights)."""

from __future__ import annotations

from datetime import date

from core.models import Claim, ClaimStatus, PaidLedger, Publication
from core.services import honours_board
from core.test_honours_board import on, pub
from core.test_leaderboard_weights import _Base


class WholeBoardIsScopusOnlyTests(_Base):
    def board_of(self, category, viewer=None, **params):
        self.c.force_login(viewer or self.asha)
        r = self.c.get("/api/leaderboard", {"category": category, "period": "academic", **params})
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def test_no_claim_ledger_or_unlinked_data_reaches_any_board(self):
        # Everything the college's own records know, and nothing Scopus-linked.
        p = pub("Claim only", date(2026, 7, 1), quartile="Q1", cites=40, linked=False)
        Publication.objects.filter(pk=p.pk).update(quartile="Q1", citations=40)
        on(p, self.asha, 1)
        Claim.objects.create(owner=self.asha, paper_title="Claim only", status=ClaimStatus.PAID, remuneration=9000)
        PaidLedger.objects.create(payout_month=date(2026, 8, 1), staff_id="x", faculty_name="Asha", paper_title="Ledger", amount=500.0)
        for category in honours_board.CATEGORIES:
            d = self.board_of(category)
            self.assertEqual(d["ranked"], 0, category)
            self.assertTrue(all(r["rank"] is None and r["value"] == 0 for r in d["rows"]), category)
            self.assertTrue(all(x["value"] == 0 and x["papers"] == 0 for x in d["departments"]), category)

    def test_department_table_is_the_total_and_average_of_members_weighted_scores(self):
        on(pub("a", date(2026, 7, 1)), self.asha, 1)
        on(pub("a2", date(2026, 7, 2)), self.asha, 1)
        on(pub("r", date(2026, 7, 3)), self.ravi, 1)
        on(pub("m", date(2026, 7, 4)), self.mina, 1)
        self.only(papers=100)
        d = self.board_of("score")
        by = {x["department"]: x for x in d["departments"]}
        scores = {r["person"]["name"]: r["value"] for r in d["rows"]}
        self.assertEqual(by["ECE"]["faculty"], 2)
        self.assertAlmostEqual(by["ECE"]["value"], scores["Asha"] + scores["Ravi"], places=2)
        self.assertAlmostEqual(by["ECE"]["per_faculty"], (scores["Asha"] + scores["Ravi"]) / 2, places=2)
        self.assertAlmostEqual(by["ECE"]["score_per_faculty"], by["ECE"]["per_faculty"], places=2)
        self.assertEqual(by["CSE"]["faculty"], 2)  # Mina and the head
        self.assertAlmostEqual(by["CSE"]["value"], scores["Mina"] + scores["Head"], places=2)
        # Scoped to one department, the table still compares every department the same way.
        scoped = self.board_of("score", department="ECE")
        self.assertEqual({x["department"]: x["value"] for x in scoped["departments"]}, {k: v["value"] for k, v in by.items()})

    def test_department_table_ignores_claims_and_the_ledger(self):
        on(pub("a", date(2026, 7, 1)), self.asha, 1)
        before = self.board_of("score")["departments"]
        ghost = pub("Ghost", date(2026, 7, 2), quartile="Q1", linked=False)
        on(ghost, self.ravi, 1)
        Claim.objects.create(owner=self.ravi, paper_title="Ghost", status=ClaimStatus.PAID, remuneration=1)
        PaidLedger.objects.create(payout_month=date(2026, 8, 1), staff_id="x", paper_title="Ghost", amount=10.0)
        honours_board.forget()
        self.assertEqual(self.board_of("score")["departments"], before)

    def test_most_improved_is_the_change_in_weighted_score_between_academic_years(self):
        self.only(papers=100)
        on(pub("n1", date(2026, 7, 1)), self.asha, 1)
        on(pub("n2", date(2026, 8, 1)), self.asha, 1)
        on(pub("o1", date(2025, 7, 1)), self.mina, 1)
        on(pub("o2", date(2025, 8, 1)), self.mina, 1)
        # A claim-only paper this year changes nothing for Ravi.
        on(pub("claim", date(2026, 7, 5), linked=False), self.ravi, 1)
        d = self.board_of("rising")
        asha, mina, ravi = (self.row(d, u) for u in (self.asha, self.mina, self.ravi))
        this_year = self.board_of("score")
        last_year = self.board_of("score", period="last_academic")
        self.assertEqual(asha["value"], round(self.row(this_year, self.asha)["value"] - self.row(last_year, self.asha)["value"], 2))
        self.assertGreater(asha["value"], 0)
        self.assertEqual(asha["rank"], 1)
        self.assertEqual(mina["value"], round(self.row(this_year, self.mina)["value"] - self.row(last_year, self.mina)["value"], 2))
        self.assertLess(mina["value"], 0)
        self.assertIsNone(mina["rank"])
        self.assertEqual(ravi["value"], 0)
        self.assertIsNone(ravi["rank"])

    def test_most_improved_department_table_is_the_total_change(self):
        self.only(papers=100)
        on(pub("n1", date(2026, 7, 1)), self.asha, 1)
        d = self.board_of("rising")
        ece = next(x for x in d["departments"] if x["department"] == "ECE")
        self.assertAlmostEqual(ece["value"], self.row(d, self.asha)["value"] + self.row(d, self.ravi)["value"], places=2)

    def test_newcomers_are_first_scopus_papers_in_24_months_ranked_by_weighted_score(self):
        self.only(papers=100)
        on(pub("new", date(2026, 7, 1)), self.asha, 1)
        on(pub("old", date(2019, 7, 1)), self.mina, 1)
        on(pub("old2", date(2026, 7, 2)), self.mina, 1)
        # Ravi's only early paper is a claim-only one: he is not a newcomer by it.
        on(pub("claimed", date(2025, 7, 1), linked=False), self.ravi, 1)
        d = self.board_of("newcomer")
        ids = {r["person"]["id"] for r in d["rows"]}
        self.assertIn(self.asha.id, ids)
        self.assertNotIn(self.mina.id, ids)
        self.assertNotIn(self.ravi.id, ids)
        # Ranked by the same college-wide score the Overall board shows.
        overall = self.board_of("score")
        self.assertEqual(self.row(d, self.asha)["value"], self.row(overall, self.asha)["value"])
        self.assertEqual(self.row(d, self.asha)["rank"], 1)

    def test_newcomer_department_table_counts_only_newcomers_scores(self):
        self.only(papers=100)
        on(pub("new", date(2026, 7, 1)), self.asha, 1)
        on(pub("old", date(2019, 7, 1)), self.ravi, 1)
        on(pub("old2", date(2026, 7, 2)), self.ravi, 1)
        d = self.board_of("newcomer")
        ece = next(x for x in d["departments"] if x["department"] == "ECE")
        self.assertEqual(ece["value"], self.row(self.board_of("score"), self.asha)["value"])


class NameOnlyMatchesTests(_Base):
    def papers_of(self, user):
        return self.row(self.board(), user)["papers"]

    def test_a_name_only_match_never_counts(self):
        for i, method in enumerate(("name", "name_dept", "alias", "")):
            on(pub(f"Guessed {method or 'blank'}", date(2026, 7, 1 + i)), self.asha, 1, match=method)
        self.assertEqual(self.papers_of(self.asha), 0)
        self.assertEqual(self.board()["totals"]["papers"], 0)
        self.assertEqual(honours_board.record().papers, [])

    def test_identifier_record_and_confirmed_matches_count(self):
        for i, method in enumerate(honours_board.STRONG_MATCHES):
            on(pub(f"Strong {method}", date(2026, 7, 1 + i)), self.asha, 1, match=method)
        self.assertEqual(self.papers_of(self.asha), len(honours_board.STRONG_MATCHES))

    def test_a_guessed_colleague_is_not_counted_on_a_shared_paper(self):
        p = pub("Shared", date(2026, 7, 1))
        on(p, self.asha, 1)
        on(p, self.ravi, 2, match="name")
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["papers"], 1)
        self.assertEqual(self.row(d, self.ravi)["papers"], 0)
