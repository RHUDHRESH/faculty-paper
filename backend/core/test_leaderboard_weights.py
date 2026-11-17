"""The leaderboard's weights: the score maths, who may change them, and what counts.

Synthetic data only. What is pinned, in the order a reader would doubt it:

- the score is weight x percentile, summed, and each person's points from each
  factor add up to the score shown;
- weights are whole numbers 0-100 adding up to 100, with a note;
- the research coordinator and super admin change them; everybody else reads;
- a preview saves nothing; a save keeps history; a reset is a new version;
- only Scopus-linked papers count -- never a claim, a ledger row or a roster
  line -- and SNIP and quartile come from the journal tables;
- no money anywhere, and there is no money factor.
"""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import (
    AuditLog, Claim, ClaimStatus, PaidLedger, Publication, Role, SystemSetting, Team, User,
)
from core.services import honours_board, leaderboard_weights as lw
from core.test_honours_board import on, pub
from core.test_search import money_keys_in

TODAY = date(2026, 9, 24)


class _Base(TestCase):
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
        self.head = mk("head", "CSE", Role.HOD)
        self.coord = mk("coord", "", Role.RESEARCH_COORDINATOR)
        self.admin = mk("admin", "", Role.SUPER_ADMIN)
        self.principal = mk("principal", "", Role.PRINCIPAL)
        self.c = Client()

    def call(self, viewer, method, path, body=None):
        self.c.force_login(viewer)
        kw = {"data": json.dumps(body), "content_type": "application/json"} if body is not None else {}
        return getattr(self.c, method)(f"/api{path}", **kw)

    def board(self, viewer=None, **params):
        self.c.force_login(viewer or self.asha)
        r = self.c.get("/api/leaderboard", {"category": "score", "period": "all", **params})
        self.assertEqual(r.status_code, 200, r.content[:300])
        return r.json()

    def row(self, data, user):
        return next(r for r in data["rows"] if r["person"]["id"] == user.id)

    def only(self, **weights):
        lw.save(self.coord, {k: v for k, v in weights.items()}, "A test weighting")


class ScoreMathTests(TestCase):
    def test_percentile_is_share_at_or_below(self):
        got = lw.percentiles({"a": 5, "b": 3, "c": 3, "d": 0, "e": None})
        self.assertEqual(got, {"a": 100.0, "b": 80.0, "c": 80.0, "d": 0.0, "e": 0.0})

    def test_nothing_is_nothing_even_when_everybody_has_nothing(self):
        self.assertEqual(lw.percentiles({"a": 0, "b": 0}), {"a": 0.0, "b": 0.0})
        self.assertEqual(lw.percentiles({}), {})

    def test_score_is_weight_times_percentile_and_parts_add_up(self):
        figures = {"a": {"papers": 4, "citations": 10}, "b": {"papers": 2, "citations": 40}, "c": {"papers": 0, "citations": 0}}
        got = lw.score_all(figures, {"papers": 60, "citations": 40})
        # a: papers 100% of 3 -> 100 x .6 = 60, citations 2/3 -> 66.67 x .4 = 26.67
        self.assertEqual(got["a"]["parts"], {"papers": 60.0, "citations": 26.67})
        self.assertEqual(got["a"]["score"], 86.67)
        # b: papers 2 of 3 -> 66.67 x .6 = 40, citations top -> 100 x .4 = 40
        self.assertEqual(got["b"]["score"], 80.0)
        self.assertEqual(got["c"]["score"], 0)
        for who in got.values():
            self.assertAlmostEqual(sum(who["parts"].values()), who["score"], places=6)

    def test_units_do_not_matter(self):
        """Percentiles use rank, so one huge figure cannot drown the rest."""
        small = lw.score_all({"a": {"citations": 3}, "b": {"citations": 2}}, {"citations": 100})
        huge = lw.score_all({"a": {"citations": 3_000_000}, "b": {"citations": 2}}, {"citations": 100})
        self.assertEqual(small, huge)

    def test_default_weights_add_up_and_are_documented(self):
        self.assertEqual(sum(lw.DEFAULTS.values()), 100)
        self.assertEqual(set(lw.DEFAULTS), {f.key for f in lw.FACTORS})
        for f in lw.FACTORS:
            self.assertTrue(f.name and f.meaning, f.key)


class ValidationTests(_Base):
    def put(self, weights, note="Because"):
        return self.call(self.coord, "put", "/leaderboard/weights", {"weights": weights, "reason": note})

    def test_must_add_up_to_100(self):
        r = self.put({"snip": 50, "papers": 40})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Weights must add up to 100", r.json()["detail"])
        self.assertEqual(self.put({"snip": 60, "papers": 50}).status_code, 400)

    def test_whole_numbers_between_0_and_100(self):
        for bad in ({"snip": 101, "papers": -1}, {"snip": 50.5, "papers": 49.5}, {"snip": "50", "papers": 50}, {"snip": True, "papers": 99}):
            self.assertEqual(self.put(bad).status_code, 400, bad)

    def test_unknown_factor_and_money_factor_are_refused(self):
        self.assertEqual(self.put({"snip": 90, "bogus": 10}).status_code, 400)
        self.assertEqual(self.put({"snip": 90, "incentive": 10}).status_code, 400)

    def test_a_note_is_required(self):
        self.assertEqual(self.put({"snip": 100}, note="").status_code, 400)
        self.assertEqual(self.put({"snip": 100}, note="   ").status_code, 400)
        self.assertEqual(SystemSetting.objects.filter(key=lw.SETTING_KEY).count(), 0)

    def test_a_valid_save_is_accepted(self):
        r = self.put({"snip": 60, "papers": 40})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["current"]["weights"]["snip"], 60)
        self.assertEqual(r.json()["current"]["weights"]["citations"], 0)


class PermissionTests(_Base):
    def test_everybody_signed_in_can_read(self):
        for u in (self.asha, self.head, self.principal, self.coord, self.admin):
            r = self.call(u, "get", "/leaderboard/weights")
            self.assertEqual(r.status_code, 200, u.role)
            d = r.json()
            self.assertEqual(d["can_edit"], u.role in (Role.RESEARCH_COORDINATOR, Role.SUPER_ADMIN))
            self.assertEqual(len(d["catalogue"]), len(lw.FACTORS))
            self.assertEqual(d["current"]["weights"], lw.DEFAULTS)

    def test_signed_out_cannot_read(self):
        self.assertIn(Client().get("/api/leaderboard/weights").status_code, (401, 403))

    def test_only_coordinator_and_super_admin_change_them(self):
        body = {"weights": {"snip": 100}, "reason": "Because"}
        for u in (self.asha, self.head, self.principal):
            self.assertEqual(self.call(u, "put", "/leaderboard/weights", body).status_code, 403, u.role)
            self.assertEqual(self.call(u, "post", "/leaderboard/weights/reset").status_code, 403, u.role)
            self.assertEqual(self.call(u, "post", "/leaderboard/weights/preview", {"weights": {"snip": 100}}).status_code, 403, u.role)
        self.assertEqual(SystemSetting.objects.filter(key=lw.SETTING_KEY).count(), 0)
        for u in (self.coord, self.admin):
            self.assertEqual(self.call(u, "put", "/leaderboard/weights", body).status_code, 200, u.role)


class HistoryTests(_Base):
    def test_save_keeps_every_version_with_who_when_and_why(self):
        self.call(self.coord, "put", "/leaderboard/weights", {"weights": {"snip": 100}, "reason": "SNIP first"})
        r = self.call(self.admin, "put", "/leaderboard/weights", {"weights": {"papers": 50, "citations": 50}, "reason": "Papers and citations"})
        d = r.json()
        self.assertEqual([h["version"] for h in d["history"]], [2, 1])
        self.assertEqual(d["current"]["version"], 2)
        newest, oldest = d["history"]
        self.assertEqual(newest["reason"], "Papers and citations")
        self.assertEqual(newest["saved_by"]["name"], "Admin")
        self.assertEqual(oldest["saved_by"]["name"], "Coord")
        self.assertEqual(oldest["weights"]["snip"], 100)
        self.assertTrue(newest["saved_at"] and newest["applies_from"] == newest["saved_at"])

    def test_reset_is_a_new_version_at_the_default_and_history_stays(self):
        self.call(self.coord, "put", "/leaderboard/weights", {"weights": {"snip": 100}, "reason": "SNIP only"})
        r = self.call(self.coord, "post", "/leaderboard/weights/reset")
        d = r.json()
        self.assertEqual(d["current"]["weights"], lw.DEFAULTS)
        self.assertEqual(d["current"]["version"], 2)
        self.assertEqual(len(d["history"]), 2)
        self.assertEqual(d["history"][1]["weights"]["snip"], 100)

    def test_audit_log_has_the_version_and_weights_but_not_the_note(self):
        self.call(self.coord, "put", "/leaderboard/weights", {"weights": {"snip": 100}, "reason": "Private reasoning here"})
        self.call(self.coord, "post", "/leaderboard/weights/reset")
        rows = list(AuditLog.objects.filter(entity="leaderboard_weights").order_by("created_at"))
        self.assertEqual([r.action for r in rows], ["LEADERBOARD_WEIGHTS_SAVE", "LEADERBOARD_WEIGHTS_RESET"])
        self.assertEqual(rows[0].actor_id, self.coord.id)
        self.assertNotIn("Private reasoning", rows[0].detail_json or "")
        self.assertEqual(json.loads(rows[0].detail_json)["version"], 1)

    def test_a_broken_stored_row_falls_back_to_the_default(self):
        SystemSetting.objects.create(key=lw.SETTING_KEY, value={"versions": [{"version": 3, "weights": {"snip": 7}}]})
        self.assertEqual(lw.current()["weights"], lw.DEFAULTS)


class ScopusOnlyTests(_Base):
    """Papers are Scopus-linked papers; everything else is invisible to the board."""

    def test_a_claim_only_paper_never_counts(self):
        p = pub("Claim only", date(2026, 7, 1), quartile="Q1", cites=50, linked=False)
        on(p, self.asha, 1)
        Claim.objects.create(owner=self.asha, paper_title="Claim only", status=ClaimStatus.PAID, remuneration=9000)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["papers"], 0)
        self.assertIsNone(self.row(d, self.asha)["rank"])
        self.assertEqual(d["totals"]["papers"], 0)

    def test_a_ledger_only_paper_never_counts(self):
        PaidLedger.objects.create(payout_month=date(2026, 8, 1), staff_id="x", faculty_name="Asha", paper_title="Ledger paper", amount=1234.0)
        d = self.board()
        self.assertEqual(d["totals"]["papers"], 0)
        self.assertTrue(all(r["papers"] == 0 for r in d["rows"]))

    def test_a_scopus_linked_paper_counts(self):
        on(pub("Linked", date(2026, 7, 1), quartile="Q2", cites=4), self.asha, 1)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["papers"], 1)
        self.assertEqual(self.row(d, self.asha)["rank"], 1)

    def test_an_eid_alone_links_a_paper_and_so_does_the_sync_flag(self):
        a = pub("Eid only", date(2026, 7, 1))
        Publication.objects.filter(pk=a.pk).update(scopus_indexed=False)
        b = pub("Flag only", date(2026, 7, 2))
        Publication.objects.filter(pk=b.pk).update(eid=None)
        on(a, self.asha, 1)
        on(b, self.asha, 2)
        self.assertEqual(self.row(self.board(), self.asha)["papers"], 2)

    def test_quartile_comes_from_the_journal_table_not_from_the_paper(self):
        # The college's own record says Q1; the journal table says Q4.
        p = pub("Disputed", date(2026, 7, 1), quartile="Q4")
        Publication.objects.filter(pk=p.pk).update(quartile="Q1")
        on(p, self.asha, 1)
        q = pub("Real Q1", date(2026, 7, 2), quartile="Q1")
        on(q, self.ravi, 1)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["breakdown"]["q4"], 1)
        self.assertEqual(self.row(d, self.asha)["q1"], 0)
        self.assertEqual(self.row(d, self.ravi)["q1"], 1)

    def test_snip_comes_from_the_journal_tables(self):
        on(pub("Big journal", date(2026, 7, 1), snip=4.0), self.asha, 1)
        on(pub("Small journal", date(2026, 7, 2), snip=1.0), self.ravi, 1)
        on(pub("Unlisted journal", date(2026, 7, 3)), self.mina, 1)  # in neither table
        self.only(snip=100)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["contributions"], [{"factor": "snip", "points": self.row(d, self.asha)["value"]}])
        self.assertEqual([self.row(d, u)["rank"] for u in (self.asha, self.ravi)], [1, 2])
        # Mina's paper is counted but her journal has no SNIP: nothing on this factor.
        self.assertIsNone(self.row(d, self.mina)["rank"])

    def test_snip_uses_the_table_year_nearest_the_paper(self):
        from core.models import SnipSource

        p = pub("Old paper", date(2020, 3, 1), snip=1.0)
        issn = p.issn
        SnipSource.objects.create(title="J", print_issn=issn, snip=9.0, year=2026)
        on(p, self.asha, 1)
        q = pub("New paper", date(2026, 3, 1), snip=5.0)
        on(q, self.ravi, 1)
        self.only(snip=100)
        d = self.board()
        # Asha's 2020 paper reads the 2020 row (1.0), not 2026's 9.0: Ravi's 5.0 is higher.
        self.assertEqual(self.row(d, self.ravi)["rank"], 1)

    def test_roster_articles_count_only_when_their_eid_matches_a_linked_paper(self):
        linked = pub("Student paper", date(2026, 7, 1))
        on(linked, self.ravi, 1)
        unlinked = pub("Claim only student paper", date(2026, 7, 2), linked=False)
        Team.objects.create(code="T1", mentor=self.asha, active=True, publications=[
            {"article_title": "Student paper", "scopus_eid": linked.eid},
            {"article_title": "Claim only student paper", "scopus_eid": "2-s2.0-000"},
            {"article_title": "No EID at all"},
        ])
        self.only(fyp=100)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["rank"], 1)
        self.assertEqual(self.row(d, self.asha)["value"], 100)
        self.assertIsNone(self.row(d, self.ravi)["rank"])  # an author, not the mentor
        self.assertIsNotNone(unlinked)

    def test_the_page_says_where_the_figures_come_from_and_the_last_sync(self):
        from django.utils import timezone

        stamp = timezone.now()
        User.objects.filter(pk=self.asha.pk).update(scopus_synced_at=stamp)
        d = self.board()
        self.assertEqual(d["method"]["source"], "Counted from Scopus-linked papers only")
        self.assertEqual(d["method"]["scopus_synced_at"][:10], stamp.date().isoformat())

    def test_no_sync_yet_says_so_with_none(self):
        self.assertIsNone(self.board()["method"]["scopus_synced_at"])


class FactorTests(_Base):
    """One factor at a time, weighted 100, on figures worked out by hand."""

    def test_papers_q1q2_citations_and_h_index(self):
        on(pub("a1", date(2026, 7, 1), quartile="Q1", cites=10), self.asha, 1)
        on(pub("a2", date(2026, 7, 2), quartile="Q2", cites=9), self.asha, 1)
        on(pub("r1", date(2026, 7, 3), quartile="Q3", cites=1), self.ravi, 1)
        for key, first in (("papers", self.asha), ("q1q2", self.asha), ("citations", self.asha), ("h_index", self.asha)):
            self.only(**{key: 100})
            d = self.board()
            self.assertEqual(self.row(d, first)["rank"], 1, key)
            self.assertEqual(self.row(d, first)["value"], 100, key)

    def test_publishing_span_consistency_and_recent(self):
        on(pub("old", date(2018, 1, 1)), self.asha, 1)
        on(pub("new", date(2026, 8, 1)), self.asha, 1)
        on(pub("only", date(2026, 8, 5)), self.ravi, 1)
        self.only(span=100)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["rank"], 1)
        self.assertIsNone(self.row(d, self.ravi)["rank"])  # one paper: no span
        # Consistency: months with a paper in the last 24, so Asha's 2018 paper adds nothing.
        self.only(consistency=100)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["value"], self.row(d, self.ravi)["value"])
        # Recent: papers in the last 12 months.
        self.only(recent=100)
        d = self.board()
        self.assertEqual(self.row(d, self.asha)["value"], self.row(d, self.ravi)["value"])
        on(pub("newer", date(2026, 9, 1)), self.asha, 1)
        d = self.board()
        self.assertGreater(self.row(d, self.asha)["value"], self.row(d, self.ravi)["value"])

    def test_first_or_corresponding_share_leaves_out_papers_with_no_author_order(self):
        on(pub("f1", date(2026, 7, 1)), self.asha, 1)
        on(pub("f2", date(2026, 7, 2)), self.asha, 4)
        on(pub("f3", date(2026, 7, 3)), self.asha, None)  # unknown: left out
        on(pub("r1", date(2026, 7, 4)), self.ravi, 3)
        on(pub("r2", date(2026, 7, 5)), self.ravi, 5, corresponding=True)
        on(pub("m1", date(2026, 7, 6)), self.mina, None)  # nothing known at all
        self.only(author_role=100)
        d = self.board()
        # Asha 1 of 2 known = .5; Ravi 1 of 2 (corresponding) = .5; Mina nothing.
        self.assertEqual(self.row(d, self.asha)["value"], self.row(d, self.ravi)["value"])
        self.assertIsNone(self.row(d, self.mina)["rank"])

    def test_a_department_board_ranks_within_the_department(self):
        on(pub("a", date(2026, 7, 1)), self.asha, 1)
        on(pub("m", date(2026, 7, 2)), self.mina, 1)
        self.only(papers=100)
        college = self.board()
        ece = self.board(department="ECE")
        self.assertEqual(self.row(college, self.asha)["value"], 100)
        self.assertEqual(self.row(ece, self.asha)["value"], 100)  # top of ECE
        self.assertNotIn(self.mina.id, {r["person"]["id"] for r in ece["rows"]})


class BoardPayloadTests(_Base):
    def setUp(self):
        super().setUp()
        on(pub("a1", date(2026, 7, 1), quartile="Q1", cites=12, snip=3.0), self.asha, 1)
        on(pub("a2", date(2026, 8, 1), quartile="Q2", cites=4, snip=2.0), self.asha, 2, corresponding=True)
        on(pub("r1", date(2026, 7, 10), quartile="Q3", cites=2, snip=1.0), self.ravi, 1)
        on(pub("m1", date(2025, 7, 10), quartile="Q4", cites=9, snip=0.5), self.mina, 3)

    def test_default_weights_rank_the_strongest_record_first(self):
        d = self.board()
        order = [r["person"]["name"] for r in d["rows"] if r["rank"] is not None]
        self.assertEqual(order, ["Asha", "Ravi", "Mina"])
        self.assertEqual(d["method"]["scoring"]["weights"][0]["key"], "snip")
        self.assertEqual(sum(w["weight"] for w in d["method"]["scoring"]["weights"]), 100)

    def test_each_persons_points_add_up_to_their_score(self):
        for weights in (lw.DEFAULTS, {"snip": 30, "papers": 20, "span": 25, "fyp": 5, "recent": 20}):
            lw.save(self.coord, weights, "Try these")
            for period in ("all", "academic", "last12"):
                d = self.board(period=period)
                for r in d["rows"]:
                    total = sum(c["points"] for c in r["contributions"])
                    self.assertAlmostEqual(total, r["value"], places=6, msg=(period, r["person"]["name"]))
                    self.assertLessEqual(r["value"], 100)
                    self.assertTrue(all(c["points"] >= 0 for c in r["contributions"]))

    def test_only_the_factors_with_a_weight_carry_points(self):
        self.only(snip=70, papers=30)
        r = self.row(self.board(), self.asha)
        self.assertEqual([c["factor"] for c in r["contributions"]], ["snip", "papers"])

    def test_changing_the_weights_changes_the_board_at_once(self):
        self.only(papers=100)
        first = self.board()
        self.assertEqual(first["rows"][0]["person"]["name"], "Asha")
        self.only(snip=100)
        self.assertEqual(self.board()["method"]["scoring"]["weights"][0]["key"], "snip")

    def test_no_money_at_any_role_and_no_incentive_factor(self):
        PaidLedger.objects.create(payout_month=date(2026, 8, 1), staff_id="x", paper_title="a1", amount=99999.0)
        for viewer in (self.asha, self.head, self.principal, self.coord):
            d = self.board(viewer)
            self.assertEqual(money_keys_in(d), [], viewer.role)
            self.assertNotIn("99999", json.dumps(d))
            self.assertNotIn("incentive", json.dumps(d).lower())
        w = self.call(self.head, "get", "/leaderboard/weights").json()
        self.assertNotIn("incentive", json.dumps(w).lower())
        self.assertNotIn("99999", json.dumps(w))

    def test_csv_still_downloads_with_the_score(self):
        self.c.force_login(self.asha)
        r = self.c.get("/api/leaderboard", {"category": "score", "period": "all", "fmt": "csv"})
        self.assertEqual(r.status_code, 200)
        self.assertIn("Asha", r.content.decode("utf-8-sig"))


class PreviewTests(_Base):
    def setUp(self):
        super().setUp()
        on(pub("a1", date(2026, 7, 1), cites=1, snip=1.0), self.asha, 1)
        on(pub("a2", date(2026, 7, 2), cites=1, snip=1.0), self.asha, 1)
        on(pub("r1", date(2026, 7, 3), cites=50, snip=6.0), self.ravi, 1)

    def preview(self, weights, user=None):
        return self.call(user or self.coord, "post", "/leaderboard/weights/preview", {"weights": weights, "period": "all"})

    def test_preview_shows_both_top_lists_with_rank_changes_and_saves_nothing(self):
        self.only(papers=100)  # Asha first (2 papers), Ravi second
        before = SystemSetting.objects.get(key=lw.SETTING_KEY).value
        audits = AuditLog.objects.count()
        r = self.preview({"citations": 60, "snip": 40})
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertFalse(d["saved"])
        self.assertEqual([p["person"]["name"] for p in d["current"]], ["Asha", "Ravi"])
        self.assertEqual([p["person"]["name"] for p in d["proposed"]], ["Ravi", "Asha"])
        ravi_now = next(p for p in d["current"] if p["person"]["name"] == "Ravi")
        ravi_then = next(p for p in d["proposed"] if p["person"]["name"] == "Ravi")
        self.assertEqual((ravi_now["rank"], ravi_now["becomes"], ravi_now["change"]), (2, 1, 1))
        self.assertEqual((ravi_then["rank"], ravi_then["was"], ravi_then["change"]), (1, 2, 1))
        asha_then = next(p for p in d["proposed"] if p["person"]["name"] == "Asha")
        self.assertEqual(asha_then["change"], -1)
        # Nothing was saved, logged or cached as the current weights.
        self.assertEqual(SystemSetting.objects.get(key=lw.SETTING_KEY).value, before)
        self.assertEqual(AuditLog.objects.count(), audits)
        self.assertEqual(self.board()["method"]["scoring"]["weights"][0]["key"], "papers")

    def test_preview_is_at_most_twenty(self):
        for i in range(25):
            u = User.objects.create_user(email=f"p{i}@x.edu", password=None, name=f"P{i:02d}", role=Role.FACULTY, department="ECE")
            on(pub(f"p{i}", date(2026, 7, 1), cites=i + 1), u, 1)
        d = self.preview({"citations": 100}).json()
        self.assertEqual(len(d["current"]), 20)
        self.assertEqual(len(d["proposed"]), 20)

    def test_preview_checks_the_weights_like_a_save_but_needs_no_note(self):
        self.assertEqual(self.preview({"snip": 50}).status_code, 400)
        self.assertEqual(self.preview({"snip": 100}).status_code, 200)

    def test_preview_can_be_scoped_to_a_department(self):
        on(pub("m1", date(2026, 7, 4), cites=99), self.mina, 1)
        d = self.call(self.coord, "post", "/leaderboard/weights/preview", {"weights": {"citations": 100}, "period": "all", "department": "ECE"}).json()
        self.assertEqual(d["scope"], "ECE")
        self.assertNotIn("Mina", [p["person"]["name"] for p in d["proposed"]])
