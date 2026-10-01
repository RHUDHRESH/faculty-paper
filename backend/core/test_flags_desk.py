"""The Flags page's server side: questions grouped by what they ask, and one
answer given to a batch."""
from __future__ import annotations

from core.models import AuditLog, Claim, ClaimFlag, ClaimStatus
from core.test_chain_rules import ChainBase


class FlagGroupTests(ChainBase):
    def _flag(self, claim, kind="AMOUNT", source="AUTO", key=None, note="Paid nothing on the ERP import."):
        return ClaimFlag.objects.create(claim=claim, kind=kind, source=source, note=note, auto_key=key)

    def test_open_flags_are_grouped_by_the_question_they_ask(self):
        paid = self._claim(status=ClaimStatus.PAID, ticket="ERP-PROCESSED-1")
        chain = self._claim(ticket="G-2")
        self._flag(paid, key="import:paid-zero")
        self._flag(self._claim(status=ClaimStatus.PAID, ticket="ERP-PROCESSED-2"), key="import:paid-zero")
        self._flag(paid, kind="OTHER", key="import:paid-rejected")
        self._flag(chain, kind="AUTHOR", source="MANUAL", note="Position is not the first author")
        body = self._as(self.cell).get("/api/flags").json()
        groups = {g["rule"]: g for g in body["summary"]["groups"]}
        self.assertEqual(groups["import:paid-zero"]["open"], 2)
        self.assertEqual(groups["import:paid-zero"]["open_on_paid"], 2)
        self.assertEqual(groups["import:paid-rejected"]["open"], 1)
        self.assertEqual(groups["manual:AUTHOR"]["open_on_paid"], 0)
        self.assertEqual(groups["manual:AUTHOR"]["headline"], "The author or position looks wrong")
        # Most money-at-risk first.
        self.assertEqual(body["summary"]["groups"][0]["rule"], "import:paid-zero")

    def test_rule_narrows_the_list_and_a_flag_carries_its_headline(self):
        paid = self._claim(status=ClaimStatus.PAID, ticket="ERP-PROCESSED-3")
        self._flag(paid, key="import:paid-zero")
        self._flag(paid, kind="OTHER", key="import:paid-rejected")
        body = self._as(self.cell).get("/api/flags?rule=import:paid-rejected").json()
        self.assertEqual(body["total"], 1)
        row = body["results"][0]
        self.assertEqual(row["headline"], "Paid, but the old ERP says it was rejected")
        self.assertEqual(row["claim"]["origin"], "Imported from the ERP, Processed sheet")
        self.assertEqual(self._as(self.cell).get("/api/flags?rule=nonsense").status_code, 400)

    def test_findings_hidden_from_finance_and_faculty(self):
        self.assertEqual(self._as(self.finance).get("/api/flags").status_code, 403)
        self.assertEqual(self._post(self.finance, "/api/flags/resolve-many", {"flag_ids": ["x"], "note": "Checked the sheet"}).status_code, 403)
        self.assertEqual(self._post(self.faculty, "/api/flags/resolve-many", {"flag_ids": ["x"], "note": "Checked the sheet"}).status_code, 403)


class ArchiveSummaryTests(ChainBase):
    def test_summary_says_how_the_record_stands_and_ignores_status_and_flag_filters(self):
        self._claim(status=ClaimStatus.PAID, ticket="A-1", doi="10.1/abc")
        self._claim(status=ClaimStatus.PAID, ticket="A-2", doi="10.1/abc")
        self._claim(status=ClaimStatus.REJECTED, ticket="A-3", rejected_outright=True)
        self._claim(status=ClaimStatus.REJECTED, ticket="A-4")
        self._claim(ticket="A-5")
        ClaimFlag.objects.create(claim=Claim.objects.get(ticket_number="A-5"), kind="OTHER", note="A question here")
        # A claim the viewer filed is not part of the record they judge.
        self._claim(ticket="A-OWN", owner=self.cell)
        body = self._as(self.cell).get("/api/archive/claims?status=PAID").json()
        self.assertEqual(body["total"], 2)
        s = body["summary"]
        self.assertEqual((s["all"], s["paid"], s["sent_back"], s["not_accepted"], s["moving"], s["with_open_flags"]), (5, 2, 1, 1, 1, 1))

    def test_rows_say_when_the_same_doi_is_on_another_claim_and_how_it_ended(self):
        self._claim(status=ClaimStatus.PAID, ticket="B-1", doi="10.1/same")
        self._claim(status=ClaimStatus.PAID, ticket="B-2", doi="10.1/same")
        self._claim(status=ClaimStatus.REJECTED, ticket="B-3", rejected_outright=True, doi="10.1/alone")
        rows = {r["ticket_number"]: r for r in self._as(self.cell).get("/api/archive/claims").json()["results"]}
        self.assertEqual(rows["B-1"]["same_doi_others"], 1)
        self.assertEqual(rows["B-3"]["same_doi_others"], 0)
        self.assertTrue(rows["B-3"]["rejected_outright"])


class ResolveManyTests(ChainBase):
    def _open(self, claim, n=1):
        return [ClaimFlag.objects.create(claim=claim, kind="AMOUNT", source="AUTO", note="Q", auto_key=f"import:paid-zero:{i}") for i in range(n)]

    def test_one_answer_for_a_batch_and_each_is_audited(self):
        c = self._claim(status=ClaimStatus.PAID, ticket="ERP-PROCESSED-9")
        flags = self._open(c, 3)
        r = self._post(self.cell, "/api/flags/resolve-many", {"flag_ids": [f.id for f in flags], "note": "Checked the accounts sheet: paid as shown"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["resolved"], 3)
        for f in flags:
            f.refresh_from_db()
            self.assertFalse(f.is_open)
            self.assertEqual(f.resolved_by_id, self.cell.id)
            self.assertEqual(f.resolution_note, "Checked the accounts sheet: paid as shown")
        self.assertEqual(AuditLog.objects.filter(action="CLAIM_FLAG_RESOLVE").count(), 3)

    def test_needs_a_real_reason_and_skips_own_and_answered(self):
        theirs = self._open(self._claim(ticket="R-1"))[0]
        own = self._open(self._claim(ticket="R-2", owner=self.cell))[0]
        done = self._open(self._claim(ticket="R-3"))[0]
        self.assertEqual(self._post(self.cell, "/api/flags/resolve-many", {"flag_ids": [theirs.id], "note": "ok"}).status_code, 400)
        self.assertEqual(self._post(self.cell, "/api/flags/resolve-many", {"flag_ids": [], "note": "Checked the sheet"}).status_code, 400)
        self._post(self.cell, f"/api/flags/{done.id}/resolve", {"note": "Answered earlier by hand"})
        r = self._post(self.cell, "/api/flags/resolve-many", {"flag_ids": [theirs.id, own.id, done.id, "missing"], "note": "Checked the sheet"}).json()
        self.assertEqual(r["resolved"], 1)
        reasons = {s["reason"] for s in r["skipped"]}
        self.assertIn("Already resolved.", reasons)
        self.assertIn("No such flag.", reasons)
        self.assertTrue(any("own claim" in x for x in reasons))
        own.refresh_from_db()
        self.assertTrue(own.is_open)
