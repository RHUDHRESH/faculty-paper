"""Past cases, claim-number search and bulk hold (docs/ux/21, section C)."""
from __future__ import annotations

from datetime import timedelta

from django.utils import timezone

from core.models import (
    AuditLog,
    Claim,
    ClaimAction,
    ClaimStatus,
    PaidLedger,
    Role,
    User,
)
from core.services import claim_numbers
from core.test_chain_rules import ChainBase


class ClaimNumberForms(ChainBase):
    def test_typed_forms_become_the_full_number(self):
        self.assertEqual(claim_numbers.canonical("fp 2026 123"), "FP-2026-000123")
        self.assertEqual(claim_numbers.canonical("FP-2026-000123"), "FP-2026-000123")
        self.assertEqual(claim_numbers.canonical("fp2026000123"), "FP-2026-000123")
        self.assertIsNone(claim_numbers.canonical("ERP-PROCESSED-120"))
        self.assertEqual(claim_numbers.variants("erp processed 120"), ["ERP-PROCESSED-120"])

    def test_what_looks_like_a_claim_number(self):
        for text in ("FP-2026-0001", "fp", "ERP-PROC", "erp-processed-120"):
            self.assertTrue(claim_numbers.looks_like_claim_number(text), text)
        for text in ("fuzzy control", "a", "10.1/abc"):
            self.assertFalse(claim_numbers.looks_like_claim_number(text), text)


class PastCasesTests(ChainBase):
    def setUp(self):
        super().setUp()
        self.other = User.objects.create_user(
            email="co@test.edu", password=None, name="Nila Coauthor", role=Role.FACULTY, department="ECE"
        )
        self.under_review = self._claim(ticket="FP-2026-000010", doi="10.1/shared", journal_title="Nature")
        self.earlier_sent_back = self._claim(
            status=ClaimStatus.REJECTED, ticket="FP-2025-000004", journal_title="Other Journal",
        )
        ClaimAction.objects.create(
            claim=self.earlier_sent_back, actor=self.cell, from_status=ClaimStatus.SUBMITTED,
            to_status=ClaimStatus.REJECTED, action="REJECT", note="The college name is missing from the byline",
        )
        self.earlier_paid = self._claim(status=ClaimStatus.PAID, ticket="FP-2025-000003")
        Claim.objects.filter(pk=self.earlier_paid.pk).update(remuneration=9000)
        self.co_claim = self._claim(
            ticket="ERP-PROCESSED-120", owner=self.other, doi="10.1/shared", status=ClaimStatus.PAID,
            remuneration=7000,
        )
        self.same_journal = self._claim(ticket="FP-2026-000011", owner=self.other, journal_title="Nature")
        self.others_draft = self._claim(status=ClaimStatus.DRAFT, ticket=None, owner=self.other, journal_title="Nature")

    def get(self, user, claim=None, status=200):
        r = self._as(user).get(f"/api/claims/{(claim or self.under_review).id}/context")
        self.assertEqual(r.status_code, status, r.content)
        return r.json()

    def test_faculty_and_heads_never_get_past_cases(self):
        self.get(self.faculty, status=403)
        self.get(self.hod, status=403)
        r = self.client.get(f"/api/claims/{self.under_review.id}/context")
        self.assertIn(r.status_code, (401, 403))

    def test_the_research_cell_sees_all_four_groups(self):
        body = self.get(self.cell)
        ids = {c["id"] for c in body["previous_claims"]}
        self.assertEqual(ids, {self.earlier_sent_back.id, self.earlier_paid.id})
        self.assertNotIn(self.under_review.id, ids)
        back = next(c for c in body["previous_claims"] if c["id"] == self.earlier_sent_back.id)
        self.assertEqual(back["outcome"], {"key": "sent_back", "label": "Sent back"})
        self.assertEqual(back["send_backs"][0]["reason"], "The college name is missing from the byline")
        paid = next(c for c in body["previous_claims"] if c["id"] == self.earlier_paid.id)
        self.assertEqual(paid["remuneration"], 9000)
        self.assertEqual([c["id"] for c in body["co_author_claims"]], [self.co_claim.id])
        self.assertEqual(body["co_author_claims"][0]["owner_name"], "Nila Coauthor")
        self.assertEqual(body["journal"]["title"], "Nature")
        recent = {c["id"] for c in body["journal"]["recent"]}
        self.assertIn(self.same_journal.id, recent)
        self.assertNotIn(self.others_draft.id, recent)
        self.assertGreaterEqual(body["journal"]["tally"]["total"], 3)
        self.assertTrue(body["can_see_flags"])
        self.assertIn("matches", body)
        self.assertEqual(body["claimant"]["name"], "Asha Faculty")

    def test_duplicate_and_ledger_matches_for_the_desks_that_judge(self):
        PaidLedger.objects.create(
            payout_month=timezone.now().date(), faculty_name="Asha Faculty",
            paper_title=self.under_review.paper_title, amount=5000, voucher_number="V-1",
        )
        body = self.get(self.principal)
        self.assertTrue(body["can_see_flags"])
        self.assertEqual(body["matches"]["ledger"][0]["voucher_number"], "V-1")
        self.assertTrue(any(m["id"] == self.co_claim.id for m in body["matches"]["duplicates"]))

    def test_director_and_finance_get_money_but_no_flags_or_matches(self):
        for who in (self.director, self.finance):
            body = self.get(who)
            self.assertFalse(body["can_see_flags"], who.role)
            self.assertNotIn("matches", body)
            self.assertNotIn("duplicate_matches", str(body))
            paid = next(c for c in body["previous_claims"] if c["id"] == self.earlier_paid.id)
            self.assertEqual(paid["remuneration"], 9000)

    def test_nobody_reads_the_context_of_their_own_claim(self):
        own = self._claim(ticket="FP-2026-000020", owner=self.principal, status=ClaimStatus.CLEARED)
        body = self.get(self.principal, own)
        self.assertTrue(body["own_claim"])
        self.assertEqual(body["previous_claims"], [])
        self.assertEqual(body["co_author_claims"], [])

    def test_someone_elses_draft_is_not_found(self):
        self.get(self.cell, self.others_draft, status=404)

    def test_reading_it_writes_nothing(self):
        before = (Claim.objects.count(), ClaimAction.objects.count(), AuditLog.objects.count())
        self.get(self.cell)
        self.assertEqual(before, (Claim.objects.count(), ClaimAction.objects.count(), AuditLog.objects.count()))


class ClaimNumberSearchTests(ChainBase):
    def setUp(self):
        super().setUp()
        self.claim = self._claim(ticket="FP-2026-000123")
        self.erp = self._claim(ticket="ERP-PROCESSED-120", status=ClaimStatus.PAID)
        self.colleague = User.objects.create_user(
            email="c2@test.edu", password=None, name="Other Person", role=Role.FACULTY, department="CSE"
        )
        self.theirs = self._claim(ticket="FP-2026-000124", owner=self.colleague)

    def find(self, user, q):
        r = self._as(user).get("/api/search/claim-number", {"q": q})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_exact_however_it_is_typed(self):
        for typed in ("FP-2026-000123", "fp-2026-000123", "fp 2026 123", "FP2026123"):
            self.assertEqual(self.find(self.cell, typed)["exact"]["id"], self.claim.id, typed)
        self.assertEqual(self.find(self.cell, "erp-processed-120")["exact"]["id"], self.erp.id)

    def test_prefix_lists_the_numbers_that_start_with_it(self):
        body = self.find(self.cell, "FP-2026-0001")
        self.assertEqual([r["meta"]["ticket_number"] for r in body["results"]], ["FP-2026-000123", "FP-2026-000124"])
        self.assertIsNone(body["exact"])
        self.assertEqual([r["id"] for r in self.find(self.cell, "ERP-PROC")["results"]], [self.erp.id])

    def test_a_hit_at_the_askers_desk_opens_the_review(self):
        hit = self.find(self.cell, "FP-2026-000123")["exact"]
        self.assertEqual(hit["review_url"], f"/review/{self.claim.id}?queue=clearing")
        paid = self.find(self.cell, "ERP-PROCESSED-120")["exact"]
        self.assertIsNone(paid["review_url"])
        cleared = self._claim(ticket="FP-2026-000200", status=ClaimStatus.CLEARED)
        self.assertEqual(self.find(self.principal, "FP-2026-000200")["exact"]["review_url"],
                         f"/review/{cleared.id}?queue=approvals")
        self.assertIsNone(self.find(self.cell, "FP-2026-000200")["exact"]["review_url"])

    def test_a_claimant_finds_only_their_own_and_never_a_review_link(self):
        self.assertEqual(self.find(self.faculty, "FP-2026-000123")["exact"]["id"], self.claim.id)
        self.assertIsNone(self.find(self.faculty, "FP-2026-000124")["exact"])
        self.assertEqual(self.find(self.faculty, "FP-2026-0001")["results"][0]["id"], self.claim.id)
        self.assertIsNone(self.find(self.faculty, "FP-2026-000123")["exact"]["review_url"])
        # Nor the desk that holds it.
        self.assertNotIn("SUBMITTED", str(self.find(self.faculty, "FP-2026-000123")))

    def test_a_head_finds_their_department_and_no_money(self):
        body = self.find(self.hod, "FP-2026-000124")
        self.assertEqual(body["exact"]["id"], self.theirs.id)
        self.assertNotIn("remuneration", str(body))

    def test_nobody_finds_another_persons_draft(self):
        self._claim(status=ClaimStatus.DRAFT, ticket="FP-2026-000300", owner=self.colleague)
        self.assertIsNone(self.find(self.cell, "FP-2026-000300")["exact"])

    def test_too_short_finds_nothing(self):
        self.assertEqual(self.find(self.cell, "f"), {"q": "f", "exact": None, "results": []})

    def test_the_command_palette_search_finds_it_the_same_way(self):
        body = self._as(self.cell).get("/api/search/all", {"q": "fp 2026 123", "scope": "papers"}).json()
        self.assertEqual(body["exact"]["id"], self.claim.id)
        self.assertEqual(body["exact"]["url"], f"/review/{self.claim.id}?queue=clearing")
        claims = next(g for g in body["groups"] if g["kind"] == "claim")
        self.assertEqual(claims["items"][0]["id"], self.claim.id)
        part = self._as(self.cell).get("/api/search/all", {"q": "erp-proc", "scope": "papers"}).json()
        self.assertEqual(next(g for g in part["groups"] if g["kind"] == "claim")["items"][0]["id"], self.erp.id)

    def test_the_archive_query_finds_a_loosely_typed_number(self):
        rows = self._as(self.cell).get("/api/archive/claims", {"q": "fp 2026 123"}).json()["results"]
        self.assertEqual([r["id"] for r in rows], [self.claim.id])


class BulkHoldTests(ChainBase):
    REASON = "Waiting on the publisher's erratum"

    def hold(self, user, claims, reason=REASON):
        return self._post(user, "/api/desk/bulk-hold", {"claim_ids": [c.id for c in claims], "reason": reason})

    def test_the_research_cell_holds_a_batch_and_each_gets_its_own_step(self):
        a, b = self._claim(ticket="BH-1"), self._claim(ticket="BH-2")
        r = self.hold(self.cell, [a, b])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["held"], 2)
        for c in (a, b):
            c.refresh_from_db()
            self.assertTrue(c.on_hold)
            self.assertEqual(c.hold_reason, self.REASON)
            self.assertEqual(c.status, ClaimStatus.SUBMITTED)
            self.assertTrue(ClaimAction.objects.filter(claim=c, action="HOLD", actor=self.cell).exists())

    def test_skips_are_named_not_fatal(self):
        free = self._claim(ticket="BH-3")
        held = self._claim(ticket="BH-4", on_hold=True, hold_reason="already")
        own = self._claim(ticket="BH-5", owner=self.cell)
        cleared = self._claim(ticket="BH-6", status=ClaimStatus.CLEARED)
        body = self.hold(self.cell, [free, held, own, cleared]).json()
        self.assertEqual(body["held"], 1)
        self.assertEqual({s["id"] for s in body["skipped"]}, {held.id, own.id, cleared.id})
        own.refresh_from_db()
        cleared.refresh_from_db()
        self.assertFalse(own.on_hold)
        self.assertFalse(cleared.on_hold)

    def test_needs_a_reason_and_a_desk(self):
        c = self._claim(ticket="BH-7")
        self.assertEqual(self.hold(self.cell, [c], "short").status_code, 400)
        self.assertEqual(self.hold(self.cell, []).status_code, 400)
        for who in (self.faculty, self.hod, self.director, self.finance):
            self.assertEqual(self.hold(who, [c]).status_code, 403, who.role)
        c.refresh_from_db()
        self.assertFalse(c.on_hold)

    def test_the_principal_holds_only_at_the_principals_desk(self):
        submitted = self._claim(ticket="BH-8")
        cleared = self._claim(ticket="BH-9", status=ClaimStatus.CLEARED)
        body = self.hold(self.principal, [submitted, cleared]).json()
        self.assertEqual(body["held_ids"], [cleared.id])
        self.assertEqual(body["skipped"][0]["id"], submitted.id)

    def test_there_is_no_bulk_send_back(self):
        c = self._claim(ticket="BH-10")
        for path in ("/api/admin/bulk-reject", "/api/admin/bulk-send-back", "/api/desk/bulk-send-back"):
            r = self._post(self.cell, path, {"claim_ids": [c.id], "note": "x"})
            self.assertEqual(r.status_code, 404, path)
        c.refresh_from_db()
        self.assertEqual(c.status, ClaimStatus.SUBMITTED)


class WaitingBuckets(ChainBase):
    def test_context_works_for_a_claim_filed_long_ago(self):
        old = self._claim(ticket="OLD-1", submitted_at=timezone.now() - timedelta(days=40))
        r = self._as(self.cell).get(f"/api/claims/{old.id}/context")
        self.assertEqual(r.status_code, 200)


class QueueSearchTests(ChainBase):
    def test_the_desk_queues_find_a_loosely_typed_number(self):
        principal_claim = self._claim(status=ClaimStatus.CLEARED, ticket="FP-2026-000321")
        director_claim = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, ticket="FP-2026-000322")
        r = self._as(self.principal).get("/api/principal/queue", {"q": "fp 2026 321"})
        self.assertEqual([x["id"] for x in r.json()["results"]], [principal_claim.id])
        r = self._as(self.director).get("/api/director/queue", {"q": "fp2026322"})
        self.assertEqual([x["id"] for x in r.json()["results"]], [director_claim.id])


class StaffSeeWordsNotCodes(ChainBase):
    def test_a_search_hit_says_submitted_not_the_status_code(self):
        self._claim(ticket="FP-2026-000500")
        body = self._as(self.cell).get("/api/search/all", {"q": "FP-2026-000500", "scope": "papers"}).json()
        self.assertEqual(body["exact"]["chips"], ["Submitted"])
        hit = self._as(self.cell).get("/api/search/claim-number", {"q": "FP-2026-000500"}).json()["exact"]
        self.assertEqual(hit["stage"], "Submitted")
