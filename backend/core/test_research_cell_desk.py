"""The research cell's desk tools: journal watch-list, monthly processing
report, and the scheme rules (research threshold, FYP) carried on every queue row."""
from __future__ import annotations

from datetime import date

from core.models import ClaimAction, ClaimStatus, JournalWatch, ResearchThreshold, Role, User
from core.test_chain_rules import ChainBase


class WatchListTests(ChainBase):
    def test_only_the_desk_can_keep_the_list(self):
        r = self._post(self.faculty, "/api/admin/journal-watch", {"issn": "1234-5678", "reason": "x"})
        self.assertEqual(r.status_code, 403)

    def test_reason_and_journal_are_required(self):
        self.assertEqual(self._post(self.cell, "/api/admin/journal-watch", {"reason": "x"}).status_code, 400)
        self.assertEqual(self._post(self.cell, "/api/admin/journal-watch", {"title": "Nature", "reason": " "}).status_code, 400)

    def test_watched_journal_rides_on_the_queue_row_and_blocks_bulk_clear(self):
        claim = self._claim(ticket="W-1")
        r = self._post(self.cell, "/api/admin/journal-watch", {"title": "nature", "reason": "Cloned title seen"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["waiting"], 1)

        rows = self._as(self.cell).get("/api/admin/clearing-queue?status=SUBMITTED").json()
        row = next(x for x in rows if x["id"] == claim.id)
        self.assertEqual(row["journal_watch"]["reason"], "Cloned title seen")

        res = self._post(self.cell, "/api/admin/bulk-clear", {"claim_ids": [claim.id]}).json()
        self.assertEqual(res["cleared"], 0)
        self.assertIn("watch-list", res["skipped"][0]["reason"])
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_removed_entry_stops_matching(self):
        claim = self._claim(ticket="W-2")
        w = self._post(self.cell, "/api/admin/journal-watch", {"title": "Nature", "reason": "r"}).json()
        self.assertEqual(self._as(self.cell).delete(f"/api/admin/journal-watch/{w['id']}").status_code, 200)
        self.assertFalse(JournalWatch.objects.exists())
        res = self._post(self.cell, "/api/admin/bulk-clear", {"claim_ids": [claim.id]}).json()
        self.assertEqual(res["cleared"], 1)


class ClearingReportTests(ChainBase):
    def test_counts_what_left_the_desk_this_month(self):
        a = self._claim(ticket="R-1")
        b = self._claim(ticket="R-2")
        self._claim(ticket="R-3")
        self._post(self.cell, "/api/admin/bulk-clear", {"claim_ids": [a.id]})
        ClaimAction.objects.create(
            claim=b, actor=self.cell, from_status=ClaimStatus.SUBMITTED,
            to_status=ClaimStatus.REJECTED, action="REJECT", note="Affiliation missing",
        )
        body = self._as(self.cell).get("/api/admin/clearing-report").json()
        self.assertEqual(body["received"], 3)
        self.assertEqual(body["cleared"], 1)
        self.assertEqual(body["sent_back"], 1)
        self.assertEqual(body["waiting_now"], 2)
        self.assertEqual(body["by_person"][0]["name"], "Ravi Cellperson")
        self.assertEqual(sum(x["count"] for x in body["ageing"]), 2)

        csv = self._as(self.cell).get("/api/admin/clearing-report?format=csv")
        self.assertEqual(csv["Content-Type"], "text/csv; charset=utf-8")
        self.assertIn("Affiliation missing", csv.content.decode())

    def test_closed_to_faculty_and_bad_month(self):
        self.assertEqual(self._as(self.faculty).get("/api/admin/clearing-report").status_code, 403)
        self.assertEqual(self._as(self.cell).get("/api/admin/clearing-report?month=soon").status_code, 400)


class SchemeRulesOnRowTests(ChainBase):
    def test_the_research_threshold_is_visible_to_the_desk(self):
        rf = User.objects.create_user(
            email="rf@test.edu", password=None, name="Research Person", role=Role.FACULTY,
            faculty_type="RESEARCH",
        )
        ResearchThreshold.objects.create(user=rf, amount=10_000_000, effective_from=date(2020, 6, 1))
        self._claim(ticket="Q-1", owner=rf, publication_year=2026)
        rows = self._as(self.cell).get("/api/admin/clearing-queue?status=SUBMITTED").json()
        row = next(x for x in rows if x["ticket_number"] == "Q-1")
        self.assertEqual(row["owner_research_threshold"], 10_000_000)
        self.assertEqual(row["owner_faculty_type"], "RESEARCH")
        self.assertTrue(row["quota_applied"])
        self.assertEqual(row["remuneration"], 0)
        self.assertGreater(row["threshold_absorbed"], 0)
        self.assertIn("Inside your research threshold", row["threshold_note"])

    def test_own_claim_never_in_own_queue(self):
        self._claim(ticket="OWN-1", owner=self.cell)
        rows = self._as(self.cell).get("/api/admin/clearing-queue?status=SUBMITTED").json()
        self.assertNotIn("OWN-1", [x["ticket_number"] for x in rows])
