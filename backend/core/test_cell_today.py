"""/api/cell/today: what the first desk does first today."""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from core.models import ClaimAction, ClaimFlag, ClaimStatus, JournalWatch
from core.test_chain_rules import ChainBase


def _old(claim, days):
    claim.submitted_at = timezone.now() - timedelta(days=days)
    claim.save(update_fields=["submitted_at"])


class JournalWatchViewTests(ChainBase):
    def test_an_entry_says_why_and_which_claims_it_touches(self):
        w = JournalWatch.objects.create(title="Nature", reason="Cloned title seen", added_by=self.coordinator)
        waiting = self._claim(ticket="J-1")
        paid = self._claim(ticket="J-2", status=ClaimStatus.PAID)
        self._claim(ticket="J-3", journal_title="Science")
        own = self._claim(ticket="J-OWN", owner=self.cell)
        body = self._as(self.cell).get("/api/admin/journal-watch").json()
        self.assertEqual(len(body), 1)
        row = body[0]
        self.assertEqual(row["id"], w.id)
        self.assertEqual(row["reason"], "Cloned title seen")
        self.assertEqual(row["added_by_name"], self.coordinator.name)
        # Waiting counts every claim at the desk; the list of them leaves out the viewer's own.
        self.assertEqual((row["waiting"], row["claims_total"], row["claims_paid"]), (2, 3, 1))
        self.assertEqual([c["ticket_number"] for c in row["waiting_claims"]], ["J-1"])
        self.assertEqual(row["journal_titles"], ["Nature"])
        self.assertNotIn(paid.id, [c["id"] for c in row["waiting_claims"]])
        self.assertNotIn(own.id, [c["id"] for c in row["waiting_claims"]])
        self.assertEqual(waiting.ticket_number, "J-1")

    def test_a_journal_page_can_ask_whether_it_is_watched(self):
        JournalWatch.objects.create(title="Nature", reason="Cloned title seen")
        hit = self._as(self.cell).get("/api/admin/journal-watch/for?title=nature").json()
        self.assertEqual(hit["reason"], "Cloned title seen")
        self.assertIsNone(self._as(self.cell).get("/api/admin/journal-watch/for?title=Science").json())
        self.assertEqual(self._as(self.faculty).get("/api/admin/journal-watch/for?title=nature").status_code, 403)


class CellTodayTests(ChainBase):
    def get(self, user):
        return self._as(user).get("/api/cell/today")

    def test_only_the_desk_may_open_it(self):
        self.assertEqual(self.get(self.faculty).status_code, 403)
        self.assertEqual(self.get(self.principal).status_code, 403)
        self.assertEqual(self.get(self.cell).status_code, 200)
        self.assertEqual(self.get(self.coordinator).status_code, 200)

    def test_counts_match_the_coordination_overview(self):
        a = self._claim(ticket="T-1")
        b = self._claim(ticket="T-2")
        self._claim(ticket="T-3")
        _old(a, 30)
        _old(b, 20)
        today = self.get(self.cell).json()
        overview = self._as(self.cell).get("/api/coordination/overview").json()
        self.assertEqual(today["desk_open"], overview["desk_open"])
        self.assertEqual(today["past_sla"], overview["breaches"]["count"])
        self.assertEqual(today["unassigned"], overview["unassigned"])
        self.assertEqual(today["past_sla"], 2)
        # Oldest first, and the target is the claims past the limit.
        self.assertEqual([r["ticket_number"] for r in today["rest"]], ["T-1", "T-2", "T-3"])
        self.assertEqual(today["target"]["due"], 2)

    def test_mine_come_first_and_never_the_viewers_own_claim(self):
        mine = self._claim(ticket="M-1")
        other = self._claim(ticket="M-2")
        _old(other, 40)
        own = self._claim(ticket="M-OWN", owner=self.cell)
        self._post(self.coordinator, "/api/coordination/assign", {"claim_ids": [mine.id], "assignee_id": self.cell.id})
        today = self.get(self.cell).json()
        self.assertEqual([r["ticket_number"] for r in today["mine"]], ["M-1"])
        self.assertEqual(today["mine_count"], 1)
        all_ids = [r["id"] for r in today["mine"] + today["rest"]]
        self.assertNotIn(own.id, all_ids)
        self.assertNotIn(mine.id, [r["id"] for r in today["rest"]])

    def test_decisions_today_are_counted_for_me_and_for_the_desk(self):
        a = self._claim(ticket="D-1")
        self._claim(ticket="D-2")
        self._post(self.cell, "/api/admin/bulk-clear", {"claim_ids": [a.id]})
        mine = self.get(self.cell).json()["target"]
        theirs = self.get(self.coordinator).json()["target"]
        self.assertEqual((mine["decided_by_me"], mine["decided_by_desk"]), (1, 1))
        self.assertEqual((theirs["decided_by_me"], theirs["decided_by_desk"]), (0, 1))

    def test_a_fix_and_a_principal_return_are_shown_apart(self):
        fixed = self._claim(ticket="B-1")
        back = self._claim(ticket="B-2")
        plain = self._claim(ticket="B-3")
        sent = ClaimAction.objects.create(
            claim=fixed, actor=self.principal, from_status=ClaimStatus.SUBMITTED,
            to_status=ClaimStatus.REJECTED, action="SEND_BACK", note="Attach the first page",
        )
        # A send-back and its fix never share an instant; created in the same
        # one here, their order fell to the random ids and the test flickered.
        ClaimAction.objects.filter(pk=sent.pk).update(created_at=timezone.now() - timedelta(hours=1))
        ClaimAction.objects.create(
            claim=fixed, actor=self.faculty, from_status=ClaimStatus.REJECTED,
            to_status=ClaimStatus.SUBMITTED, action="RESUBMIT",
        )
        ClaimAction.objects.create(
            claim=back, actor=self.principal, from_status=ClaimStatus.CLEARED,
            to_status=ClaimStatus.SUBMITTED, action="PRINCIPAL_SEND_BACK", note="Quartile is Q3",
        )
        today = self.get(self.cell).json()
        by = {r["ticket_number"]: r for r in today["came_back"]}
        self.assertEqual(set(by), {"B-1", "B-2"})
        self.assertNotIn(plain.ticket_number, by)
        self.assertEqual(by["B-1"]["kind"], "fixed")
        self.assertEqual(by["B-1"]["note"], "Attach the first page")
        self.assertEqual(by["B-2"]["kind"], "returned")
        self.assertEqual(by["B-2"]["by_name"], self.principal.name)
        self.assertEqual(today["came_back_count"], 2)

    def test_watched_journal_and_imported_number_are_marked(self):
        JournalWatch.objects.create(title="Nature", reason="Cloned title seen")
        self._claim(ticket="ERP-RAW-9")
        row = self.get(self.cell).json()["rest"][0]
        self.assertEqual(row["watched_reason"], "Cloned title seen")
        self.assertEqual(row["origin"], "Imported from the ERP, Raw data sheet")
        self.assertEqual(self.get(self.cell).json()["watched_waiting"], 1)

    def test_open_flags_leave_out_the_viewers_own_claims(self):
        theirs = self._claim(ticket="F-1")
        own = self._claim(ticket="F-2", owner=self.cell)
        ClaimFlag.objects.create(claim=theirs, kind="OTHER", note="A question about this")
        ClaimFlag.objects.create(claim=own, kind="OTHER", note="About my own paper")
        self.assertEqual(self.get(self.cell).json()["flags"]["open"], 1)
