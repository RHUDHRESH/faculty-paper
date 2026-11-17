"""Accept for count only: a reviewer turns a filed claim into a count-only one.

Synthetic people and papers only. Pinned here:

- who may do it, at which step (the clearing roles at submitted, the Principal
  at cleared, the Director at Principal-approved, a super admin at all three),
  and that nobody does it to their own claim;
- the claim is re-priced to nothing by the calculator, carries the college's
  note with the reason, and keeps its status and its place in the chain;
- it is refused once any money has moved, and a super admin alone can undo it;
- the claimant is told, shown the reason, and the paper still counts.
"""
from __future__ import annotations

import json
from datetime import date

from django.test import override_settings

from core.models import (
    AuditLog,
    Claim,
    ClaimAction,
    ClaimReason,
    ClaimStatus,
    BankExport,
    Notification,
    PaidLedger,
    Role,
    User,
)
from core.services import count_only
from core.services.claim_fixes import NO_PAYMENT_NOTE
from core.test_chain_rules import ChainBase


class CountOnlyBase(ChainBase):
    def _count_only(self, user, claim, reason="student_publication", note=None):
        body = {"reason": reason}
        if note is not None:
            body["note"] = note
        return self._post(user, f"/api/claims/{claim.id}/count-only", body)

    def _undo(self, user, claim):
        return self._post(user, f"/api/claims/{claim.id}/count-only/undo")

    def _at(self, status, ticket="CO-1", **more):
        extra = dict(more)
        if status in (ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED):
            extra.update(cleared_by=self.cell, cleared_at=self._now())
        if status in (ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED):
            extra.update(principal_approved_by=self.principal, principal_approved_at=self._now())
        if status == ClaimStatus.DIRECTOR_APPROVED:
            extra.update(director_approved_by=self.director, director_approved_at=self._now())
        return self._claim(status, ticket=ticket, **extra)

    @staticmethod
    def _now():
        from django.utils import timezone

        return timezone.now()


class WhoMayTests(CountOnlyBase):
    def test_each_role_at_each_step(self):
        S, C, P = ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED
        matrix = [
            # (who, status, allowed)
            (self.cell, S, True),
            (self.coordinator, S, True),
            (self.admin, S, True),
            (self.principal, C, True),
            (self.admin, C, True),
            (self.director, P, True),
            (self.admin, P, True),
            # the wrong desk
            (self.principal, S, False),
            (self.director, S, False),
            (self.cell, C, False),
            (self.director, C, False),
            (self.cell, P, False),
            (self.principal, P, False),
            # never
            (self.finance, S, False),
            (self.finance, C, False),
            (self.finance, P, False),
            (self.faculty, S, False),
            (self.hod, S, False),
            (self.hod, C, False),
        ]
        for n, (who, status, allowed) in enumerate(matrix):
            claim = self._at(status, ticket=f"CO-M{n}")
            r = self._count_only(who, claim)
            if allowed:
                self.assertEqual(r.status_code, 200, f"{who.role} at {status}: {r.content}")
                claim.refresh_from_db()
                self.assertEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)
                self.assertEqual(claim.status, status, "the claim stays where it is")
            else:
                self.assertEqual(r.status_code, 403, f"{who.role} at {status}: {r.content}")
                claim.refresh_from_db()
                self.assertNotEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)

    def test_nobody_decides_their_own_claim(self):
        for n, (who, status) in enumerate([
            (self.cell, ClaimStatus.SUBMITTED),
            (self.admin, ClaimStatus.SUBMITTED),
            (self.principal, ClaimStatus.CLEARED),
            (self.director, ClaimStatus.PRINCIPAL_APPROVED),
        ]):
            claim = self._at(status, ticket=f"CO-O{n}")
            claim.owner = who
            claim.save()
            r = self._count_only(who, claim)
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")
            claim.refresh_from_db()
            self.assertNotEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)

    def test_the_claimant_cannot_do_it_to_their_own_claim(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        r = self._count_only(self.faculty, claim)
        self.assertEqual(r.status_code, 403, r.content)

    def test_a_draft_and_a_paid_claim_are_not_open_to_it(self):
        draft = self._claim(ClaimStatus.DRAFT, ticket="CO-D")
        self.assertEqual(self._count_only(self.admin, draft).status_code, 400)

    def test_signed_out_is_refused(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        r = self.client.post(
            f"/api/claims/{claim.id}/count-only", data=json.dumps({"reason": "student_publication"}),
            content_type="application/json",
        )
        self.assertIn(r.status_code, (401, 403))


class WhatItDoesTests(CountOnlyBase):
    def test_it_prices_the_claim_at_nothing_and_says_why(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        self.assertGreater(claim.remuneration, 0, "an incentive claim before")
        r = self._count_only(self.cell, claim, "student_publication")
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.remuneration, 0)
        self.assertEqual(claim.base_amount, 0)
        self.assertTrue(claim.is_student_publication, "the flag the calculator prices nothing on")
        self.assertEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)
        self.assertIn("Recorded for publication count only", claim.remuneration_note)
        self.assertEqual(claim.status_note, f"{NO_PAYMENT_NOTE} Student publication.")
        body = r.json()
        self.assertEqual(body["remuneration"], 0)
        self.assertEqual(body["count_only_reason"], "Student publication")

    def test_the_other_two_reasons(self):
        a = self._at(ClaimStatus.SUBMITTED, "CO-A")
        self._count_only(self.cell, a, "no_sec_citation")
        a.refresh_from_db()
        self.assertFalse(a.is_student_publication, "not a student publication, but still priced at nothing")
        self.assertEqual(a.status_note, f"{NO_PAYMENT_NOTE} Does not cite SEC-affiliated articles.")
        self.assertEqual(a.remuneration, 0)

        b = self._at(ClaimStatus.SUBMITTED, "CO-B")
        r = self._count_only(self.cell, b, "other", "Conference abstract only")
        self.assertEqual(r.status_code, 200, r.content)
        b.refresh_from_db()
        self.assertFalse(b.is_student_publication)
        self.assertEqual(b.status_note, f"{NO_PAYMENT_NOTE} Conference abstract only.")
        self.assertEqual(r.json()["count_only_reason"], "Conference abstract only")

    def test_a_note_is_required_for_other_and_ignored_otherwise(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        for bad in (None, "", "   "):
            r = self._count_only(self.cell, claim, "other", bad)
            self.assertEqual(r.status_code, 400, r.content)
        r = self._count_only(self.cell, claim, "other", "x" * 201)
        self.assertEqual(r.status_code, 400, r.content)
        r = self._count_only(self.cell, claim, "nonsense")
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertNotEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)
        self.assertEqual(self._count_only(self.cell, claim, "student_publication", "ignored").status_code, 200)
        claim.refresh_from_db()
        self.assertNotIn("ignored", claim.status_note)

    def test_it_keeps_the_claim_in_the_chain_it_was_in(self):
        claim = self._at(ClaimStatus.CLEARED)
        self.assertEqual(self._count_only(self.principal, claim).status_code, 200)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self.assertEqual(claim.cleared_by, self.cell, "the signature already given stays")
        r = self._post(self.principal, f"/api/claims/{claim.id}/principal-approve", {"expected_amount": 0})
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_held_claim_can_still_be_counted_only(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        claim.on_hold, claim.hold_reason = True, "Waiting on the publisher"
        claim.save()
        self.assertEqual(self._count_only(self.cell, claim).status_code, 200)
        claim.refresh_from_db()
        self.assertTrue(claim.on_hold)

    def test_a_claim_that_is_already_count_only_is_refused(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        claim.claim_reason = ClaimReason.COUNT_ONLY
        claim.save()
        r = self._count_only(self.cell, claim)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("already count only", r.json()["detail"])

    def test_it_is_all_or_nothing_when_the_policy_still_pays(self):
        from core.models import FormulaConfig

        FormulaConfig.objects.filter(active=True).update(student_remuneration_zero=False)
        claim = self._at(ClaimStatus.SUBMITTED)
        r = self._count_only(self.cell, claim)
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertNotEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)
        self.assertFalse(AuditLog.objects.filter(action=count_only.ACCEPT_AUDIT).exists())


class AuditAndTellingTests(CountOnlyBase):
    def test_the_audit_row_holds_before_and_after(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        was = claim.remuneration
        self._count_only(self.cell, claim, "no_sec_citation")
        row = AuditLog.objects.get(action=count_only.ACCEPT_AUDIT, entity_id=claim.id)
        self.assertEqual(row.actor, self.cell)
        d = json.loads(row.detail_json)
        self.assertEqual(d["reason"], "no_sec_citation")
        self.assertEqual(d["before"]["claim_reason"], ClaimReason.INCENTIVE)
        self.assertEqual(d["before"]["remuneration"], was)
        self.assertEqual(d["after"]["claim_reason"], ClaimReason.COUNT_ONLY)
        self.assertEqual(d["after"]["remuneration"], 0)
        act = ClaimAction.objects.get(claim=claim, action="COUNT_ONLY")
        self.assertEqual(act.note, "Does not cite SEC-affiliated articles")
        self.assertEqual(act.from_status, act.to_status)

    def test_the_claimant_is_told_with_the_reason_and_nobody_else_is(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        Notification.objects.all().delete()
        self._count_only(self.cell, claim, "other", "Review article")
        got = Notification.objects.filter(user=self.faculty)
        self.assertEqual(got.count(), 1)
        n = got.get()
        self.assertIn("No incentive is paid", n.body)
        self.assertIn("Review article", n.body)
        self.assertNotIn("Ravi", n.body + n.title)
        self.assertFalse(Notification.objects.exclude(user=self.faculty).exists())

    def test_the_claimant_sees_the_reason_on_their_own_claim(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        self._count_only(self.cell, claim, "student_publication")
        body = self._as(self.faculty).get(f"/api/claims/{claim.id}").json()
        self.assertEqual(body["claim_reason"], ClaimReason.COUNT_ONLY)
        self.assertEqual(body["count_only_reason"], "Student publication")
        self.assertEqual(body["remuneration"], 0)

    def test_a_faculty_filed_count_only_claim_gives_no_reason(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        claim.claim_reason = ClaimReason.COUNT_ONLY
        claim.save()
        body = self._as(self.admin).get(f"/api/claims/{claim.id}").json()
        self.assertIsNone(body["count_only_reason"])


class MoneyMovedTests(CountOnlyBase):
    def _ledger(self, claim, **extra):
        return PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 9, 1), amount=1000,
            faculty_name=self.faculty.name, **extra,
        )

    def test_a_paid_claim_is_refused(self):
        claim = self._at(ClaimStatus.DIRECTOR_APPROVED)
        claim.status = ClaimStatus.PAID
        claim.save()
        self._ledger(claim)
        for who in (self.admin, self.cell, self.principal, self.director):
            r = self._count_only(who, claim)
            self.assertEqual(r.status_code, 409, r.content)
            self.assertIn("already paid", r.json()["detail"])

    def test_a_claim_in_a_bank_file_is_refused_whatever_its_status(self):
        claim = self._at(ClaimStatus.PRINCIPAL_APPROVED)
        export = BankExport.objects.create(month="2026-09", created_by=self.finance, row_count=1, total_amount=1000)
        self._ledger(claim, bank_export=export)
        r = self._count_only(self.admin, claim)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("bank file", r.json()["detail"])
        claim.refresh_from_db()
        self.assertNotEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)

    def test_a_recorded_payment_is_refused(self):
        claim = self._at(ClaimStatus.CLEARED)
        self._ledger(claim)
        r = self._count_only(self.admin, claim)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("payment", r.json()["detail"])

    def test_an_authorised_claim_is_refused(self):
        claim = self._at(ClaimStatus.DIRECTOR_APPROVED)
        for who in (self.admin, self.director, self.finance):
            self.assertIn(self._count_only(who, claim).status_code, (403, 409))
        claim.refresh_from_db()
        self.assertNotEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)


class UndoTests(CountOnlyBase):
    def test_only_a_super_admin_undoes_it(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        was = claim.remuneration
        self._count_only(self.cell, claim, "student_publication")
        for who in (self.cell, self.coordinator, self.principal, self.director, self.finance, self.faculty):
            self.assertEqual(self._undo(who, claim).status_code, 403, who.role)
        claim.refresh_from_db()
        self.assertEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)

        r = self._undo(self.admin, claim)
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.claim_reason, ClaimReason.INCENTIVE)
        self.assertFalse(claim.is_student_publication)
        self.assertEqual(claim.remuneration, was)
        self.assertIsNone(claim.status_note)
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        row = AuditLog.objects.get(action=count_only.UNDO_AUDIT, entity_id=claim.id)
        self.assertEqual(json.loads(row.detail_json)["after"]["remuneration"], was)
        self.assertTrue(Notification.objects.filter(user=self.faculty, body__icontains="undone").exists())

    def test_undo_restores_the_previous_reason(self):
        claim = self._at(ClaimStatus.SUBMITTED, "CO-U", claim_reason=ClaimReason.STUDENT_PROJECT)
        self._count_only(self.cell, claim)
        claim.refresh_from_db()
        self.assertEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)
        self.assertEqual(self._undo(self.admin, claim).status_code, 200)
        claim.refresh_from_db()
        self.assertEqual(claim.claim_reason, ClaimReason.STUDENT_PROJECT)

    def test_nothing_to_undo_and_no_undoing_twice(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        self.assertEqual(self._undo(self.admin, claim).status_code, 409)
        self._count_only(self.cell, claim)
        self.assertEqual(self._undo(self.admin, claim).status_code, 200)
        self.assertEqual(self._undo(self.admin, claim).status_code, 409)

    def test_a_claim_the_faculty_filed_as_count_only_cannot_be_undone(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        claim.claim_reason = ClaimReason.COUNT_ONLY
        claim.save()
        self.assertEqual(self._undo(self.admin, claim).status_code, 409)

    def test_not_after_payment(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        self._count_only(self.cell, claim)
        claim.refresh_from_db()
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=0, faculty_name="x")
        r = self._undo(self.admin, claim)
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)

    def test_a_super_admin_cannot_undo_their_own_claim(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        self._count_only(self.cell, claim)
        claim.owner = self.admin
        claim.save()
        self.assertEqual(self._undo(self.admin, claim).status_code, 403)


class StillCountedTests(CountOnlyBase):
    def _walk_to_paid(self, claim):
        self.assertEqual(self._count_only(self.cell, claim).status_code, 200)
        zero = {"expected_amount": 0}
        for who, step in (
            (self.cell, "clear"),
            (self.principal, "principal-approve"),
            (self.director, "director-approve"),
            (self.finance, "mark-paid"),
        ):
            r = self._post(who, f"/api/claims/{claim.id}/{step}", zero)
            self.assertEqual(r.status_code, 200, f"{step}: {r.content}")
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertEqual(claim.remuneration, 0)

    def test_it_walks_the_rest_of_the_chain_at_nothing_and_is_still_counted(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        before = self._as(self.admin).get("/api/reports").json()["totals"]["count_only"]
        self._walk_to_paid(claim)
        totals = self._as(self.admin).get("/api/reports").json()["totals"]
        self.assertEqual(totals["count_only"], before + 1)
        self.assertGreaterEqual(totals["publications"], 1)

    def test_it_is_in_the_top_five_paper_count(self):
        from unittest.mock import patch

        claim = self._at(ClaimStatus.SUBMITTED)
        self._walk_to_paid(claim)
        with patch("core.services.top5.today", return_value=date.today()):
            body = self._as(self.admin).get("/api/dashboard/top5").json()
        counted = json.dumps(body)
        self.assertIn(self.faculty.name, counted)
        count_rows = body["count"]
        self.assertTrue(
            any(r.get("name") == self.faculty.name and r.get("value") == 1 for r in count_rows),
            counted[:600],
        )


class StudentFlagTests(CountOnlyBase):
    """The student flag is for student publications only; the zero price rests on the reason."""

    def test_no_sec_citation_is_priced_nothing_and_is_not_a_student_publication(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        self.assertEqual(self._count_only(self.cell, claim, "no_sec_citation").status_code, 200)
        claim.refresh_from_db()
        self.assertEqual(claim.remuneration, 0)
        self.assertFalse(claim.is_student_publication)
        self.assertEqual(claim.claim_reason, ClaimReason.COUNT_ONLY)

    def test_student_publication_is_both(self):
        claim = self._at(ClaimStatus.SUBMITTED)
        self._count_only(self.cell, claim, "student_publication")
        claim.refresh_from_db()
        self.assertEqual(claim.remuneration, 0)
        self.assertTrue(claim.is_student_publication)

    def test_the_calculator_prices_count_only_nothing_without_the_student_flag(self):
        from core.api.common import _apply_calc

        claim = self._at(ClaimStatus.SUBMITTED)
        self.assertGreater(claim.remuneration, 0)
        claim.claim_reason = ClaimReason.COUNT_ONLY
        claim.is_student_publication = False
        _apply_calc(claim)
        self.assertEqual(claim.remuneration, 0)
        self.assertIn("Recorded for publication count only", claim.remuneration_note)

    def test_the_dashboard_counts_each_kind_once(self):
        a = self._at(ClaimStatus.SUBMITTED, "CO-S1")
        b = self._at(ClaimStatus.SUBMITTED, "CO-S2")
        before = self._as(self.admin).get("/api/reports").json()["totals"]["count_only"]
        self._count_only(self.cell, a, "no_sec_citation")
        self._count_only(self.cell, b, "student_publication")
        after = self._as(self.admin).get("/api/reports").json()["totals"]["count_only"]
        self.assertEqual(after, before + 2)
