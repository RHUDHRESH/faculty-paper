"""The research threshold: a rupee amount per year that research faculty are not paid.

A claim wholly inside what is left of the threshold pays nothing, the claim
that crosses it pays only the part above, and every claim after that pays in
full. Regular faculty are untouched, an unset threshold means "treat as
regular and warn", and only the research coordinator and a super admin can set
one.
"""
import json
from datetime import date, timedelta

from django.test import Client, TestCase
from django.utils import timezone

from core import api as api_module
from core.models import (
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAttachment,
    ClaimReason,
    ClaimStatus,
    FormulaConfig,
    PaidLedger,
    ResearchThreshold,
    Role,
    User,
)
from core.services import research_threshold as rt
from core.services.remuneration import DEFAULT_AUTHOR_POINTS


def _policy():
    return FormulaConfig.objects.create(
        author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
        snip_multiplier=55000, qf_q1=50000,
    )


class ThresholdBase(TestCase):
    def setUp(self):
        _policy()
        self.researcher = User.objects.create_user(
            email="rt-res@test.edu", password="p", name="Research Faculty",
            role=Role.FACULTY, department="EEE", faculty_type="RESEARCH",
        )
        self.regular = User.objects.create_user(
            email="rt-reg@test.edu", password="p", name="Regular Faculty",
            role=Role.FACULTY, department="EEE",
        )
        self.coordinator = User.objects.create_user(
            email="rt-coord@test.edu", password="p", name="Coordinator", role=Role.RESEARCH_COORDINATOR,
        )
        self.finance = User.objects.create_user(
            email="rt-fin@test.edu", password="p", name="Finance", role=Role.FINANCE,
        )
        self.n = 0
        # What one paper is worth under this policy, for a regular member.
        self.full = self._paper(self.regular).remuneration
        assert self.full and self.full > 0

    def _paper(self, owner, status=ClaimStatus.SUBMITTED, **extra):
        self.n += 1
        claim = Claim.objects.create(
            owner=owner, status=status, ticket_number=f"RT-{self.n}",
            paper_title=f"Threshold {self.n}", publication_year=2026,
            quartile="Q1", quartile_source="SCIMAGO", snip=1.0, snip_source="SCOPUS",
            total_authors=1, author_position=1, indexing_level="Scopus",
            publication_type="Journal", engineering_class="Engineering",
            submitted_at=timezone.now() + timedelta(seconds=self.n), **extra,
        )
        for k in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'q' * 31}{k[-1]}.pdf", ref_number=k,
            )
        api_module._apply_calc(claim)
        claim.save()
        return claim

    def _threshold(self, amount, when=None, user=None, by=None):
        return ResearchThreshold.objects.create(
            user=user or self.researcher, amount=amount,
            effective_from=when or (rt.today() - timedelta(days=1)), set_by=by or self.coordinator,
        )

    def _amounts(self, claims):
        return [Claim.objects.get(pk=c.pk).remuneration for c in claims]

    def _pay(self, claim):
        """Move a claim through the real payment path."""
        claim = Claim.objects.get(pk=claim.pk)
        claim.status = ClaimStatus.DIRECTOR_APPROVED
        claim.director_approved_at = timezone.now()
        claim.cleared_by = self.coordinator
        claim.save()
        shown = Claim.objects.get(pk=claim.pk).remuneration
        return api_module._mark_one_paid(
            claim.id, self.finance, voucher_number=None, note="paid",
            expected_amount=shown, skip_external=True,
        )


class PayoutRuleTests(ThresholdBase):
    def test_a_claim_inside_the_threshold_pays_nothing(self):
        self._threshold(self.full * 2.5)
        claim = self._paper(self.researcher)
        claim.refresh_from_db()
        self.assertEqual(claim.remuneration, 0.0)
        self.assertEqual(claim.research_absorbed, self.full)
        self.assertTrue(claim.quota_applied)
        self.assertIn("Inside your research threshold", claim.quota_note)
        # It still shows what the paper was worth.
        self.assertGreater(claim.base_amount, 0)

    def test_inside_then_crossing_then_after(self):
        self._threshold(self.full * 2.5)
        made = [self._paper(self.researcher) for _ in range(4)]
        first, second, third, fourth = [Claim.objects.get(pk=c.pk) for c in made]
        self.assertEqual([first.remuneration, second.remuneration], [0.0, 0.0])
        # The claim that crosses pays only the part above the threshold.
        self.assertAlmostEqual(third.remuneration, self.full * 0.5, places=2)
        self.assertAlmostEqual(third.research_absorbed, self.full * 0.5, places=2)
        self.assertIn("crosses your research threshold", third.quota_note)
        # After it, in full, and it says the threshold is used up.
        self.assertEqual(fourth.remuneration, self.full)
        self.assertEqual(fourth.research_absorbed, 0)
        self.assertFalse(fourth.quota_applied)
        self.assertIn("used up", fourth.quota_note)

    def test_claims_are_taken_in_the_order_they_are_paid(self):
        """The claim furthest along uses the threshold first, so it does not
        matter which was filed first."""
        self._threshold(self.full * 1.0)
        early = self._paper(self.researcher)
        late = self._paper(self.researcher)
        Claim.objects.filter(pk=late.pk).update(status=ClaimStatus.PRINCIPAL_APPROVED)
        rt.refresh_open_claims(self.researcher)
        early.refresh_from_db()
        late.refresh_from_db()
        self.assertEqual(late.remuneration, 0.0, "the one further along spends the threshold")
        self.assertEqual(early.remuneration, self.full)

    def test_paid_claims_settle_and_later_ones_take_what_is_left(self):
        self._threshold(self.full * 1.5)
        a = self._paper(self.researcher)
        b = self._paper(self.researcher)
        paid = self._pay(a)
        self.assertEqual(paid.remuneration, 0.0)
        ledger = PaidLedger.objects.get(claim=a)
        self.assertEqual(ledger.amount, 0.0)
        b.refresh_from_db()
        self.assertAlmostEqual(b.remuneration, self.full * 0.5, places=2)
        paid_b = self._pay(b)
        self.assertAlmostEqual(PaidLedger.objects.get(claim=b).amount, self.full * 0.5, places=2)
        # A third is now paid in full and the ledger says so.
        c = self._paper(self.researcher)
        self.assertEqual(Claim.objects.get(pk=c.pk).remuneration, self.full)
        self._pay(c)
        self.assertEqual(PaidLedger.objects.get(claim=c).amount, self.full)
        # The paid ones did not move.
        self.assertEqual(Claim.objects.get(pk=a.pk).remuneration, 0.0)
        self.assertEqual(Claim.objects.get(pk=paid_b.pk).research_absorbed, paid_b.research_absorbed)

    def test_a_claim_cannot_be_paid_ahead_of_the_ones_in_front_of_it(self):
        """Paying from the back of the line used to pay the person twice.

        Threshold of one paper: the first claim absorbs it, the second is paid
        in full. Paying the second first kept it at that figure, then the
        first, re-decided against what was now "left", absorbed the threshold
        again and ... a second claim was paid in full too.
        """
        from ninja.errors import HttpError

        self._threshold(self.full * 1.0)
        a = self._paper(self.researcher)
        b = self._paper(self.researcher)
        self.assertEqual(self._amounts([a, b]), [0.0, self.full])
        for c in (a, b):
            Claim.objects.filter(pk=c.pk).update(
                status=ClaimStatus.DIRECTOR_APPROVED, director_approved_at=timezone.now()
            )
        self.assertEqual(rt.claim_ahead_in_line(Claim.objects.get(pk=b.pk)).pk, a.pk)
        self.assertIsNone(rt.claim_ahead_in_line(Claim.objects.get(pk=a.pk)))
        with self.assertRaises(HttpError) as refused:
            api_module._mark_one_paid(
                b.id, self.finance, voucher_number=None, note="paid",
                expected_amount=self.full, skip_external=True,
            )
        self.assertEqual(refused.exception.status_code, 409)
        self.assertIn(a.ticket_number, str(refused.exception))
        self.assertEqual(Claim.objects.get(pk=b.pk).status, ClaimStatus.DIRECTOR_APPROVED)
        # In line order it goes through, and the person is paid for one paper.
        api_module._mark_one_paid(
            a.id, self.finance, voucher_number=None, note="paid",
            expected_amount=0.0, skip_external=True,
        )
        api_module._mark_one_paid(
            b.id, self.finance, voucher_number=None, note="paid",
            expected_amount=self.full, skip_external=True,
        )
        paid = sum(r.amount for r in PaidLedger.objects.filter(claim__in=[a, b]))
        self.assertAlmostEqual(paid, self.full, places=2)

    def test_a_batch_is_paid_in_line_order_whatever_order_it_was_ticked_in(self):
        self._threshold(self.full * 1.0)
        a = self._paper(self.researcher)
        b = self._paper(self.researcher)
        self.assertEqual(rt.in_line_order([b.id, a.id]), [a.id, b.id])
        self.assertEqual(rt.in_line_order([b.id, "missing", a.id]), [a.id, b.id, "missing"])

    def test_regular_faculty_are_unaffected(self):
        self._threshold(self.full * 10, user=self.regular)  # a stray row decides nothing
        claim = self._paper(self.regular)
        self.assertEqual(claim.remuneration, self.full)
        self.assertEqual(claim.research_absorbed, 0)
        self.assertFalse(claim.quota_applied)

    def test_a_threshold_not_set_treats_them_as_regular_and_warns(self):
        claim = self._paper(self.researcher)
        self.assertEqual(claim.remuneration, self.full)
        self.assertFalse(claim.quota_applied)
        s = rt.summary(self.researcher)
        self.assertTrue(s["unset"])
        self.assertIsNone(s["threshold"])
        self.assertIn("has not set your research threshold", s["message"])
        c = Client()
        c.force_login(self.coordinator)
        body = c.get("/api/research-faculty").json()
        self.assertEqual(body["unset_count"], 1)
        self.assertTrue(body["rows"][0]["unset"])

    def test_a_threshold_changed_mid_year_takes_effect_for_what_is_still_open(self):
        self._threshold(self.full * 1.0, when=rt.today() - timedelta(days=30))
        a = self._paper(self.researcher)
        b = self._paper(self.researcher)
        self._pay(a)   # settled inside the old threshold: paid nothing, forever
        self.assertEqual(Claim.objects.get(pk=b.pk).remuneration, self.full)
        # Raised to two and a half papers' worth from today.
        self._threshold(self.full * 2.5, when=rt.today())
        rt.refresh_open_claims(self.researcher)
        self.assertEqual(Claim.objects.get(pk=a.pk).remuneration, 0.0)
        self.assertEqual(PaidLedger.objects.get(claim=a).amount, 0.0)
        # One paper's worth is used; 1.5 is left, so b is inside.
        self.assertEqual(Claim.objects.get(pk=b.pk).remuneration, 0.0)
        # And lowered again below what is used: nothing left, new claims pay.
        self._threshold(self.full * 0.5, when=rt.today())
        rt.refresh_open_claims(self.researcher)
        self.assertEqual(Claim.objects.get(pk=b.pk).remuneration, self.full)
        self.assertEqual(Claim.objects.get(pk=a.pk).remuneration, 0.0, "settled money is never repriced")

    def test_a_past_year_keeps_its_own_threshold(self):
        old = self._threshold(500000, when=date(2020, 6, 1))
        self._threshold(300000, when=date(2026, 6, 1))
        rows = rt.history(self.researcher.id)
        self.assertEqual(rt.threshold_on(rows, date(2021, 1, 1)), 500000)
        self.assertEqual(rt.threshold_on(rows, date(2026, 9, 1)), 300000)
        self.assertIsNone(rt.threshold_on(rows, date(2019, 1, 1)))
        self.assertTrue(old.pk)

    def test_count_only_and_student_projects_do_not_spend_it(self):
        self._threshold(self.full * 1.0)
        for reason in (ClaimReason.COUNT_ONLY, ClaimReason.STUDENT_PROJECT):
            c = self._paper(self.researcher, claim_reason=reason)
            self.assertFalse(Claim.objects.get(pk=c.pk).quota_applied)
        after = self._paper(self.researcher)
        self.assertEqual(Claim.objects.get(pk=after.pk).remuneration, 0.0, "the threshold is still whole")

    def test_ticking_regular_gives_the_open_claims_their_money_back(self):
        self._threshold(self.full * 5)
        claim = self._paper(self.researcher)
        self.assertEqual(Claim.objects.get(pk=claim.pk).remuneration, 0.0)
        self.researcher.faculty_type = "REGULAR"
        self.researcher.save()
        rt.refresh_open_claims(self.researcher)
        claim.refresh_from_db()
        self.assertEqual(claim.remuneration, self.full)
        self.assertEqual(claim.research_absorbed, 0)

    def test_the_old_paper_count_quota_decides_nothing(self):
        self.researcher.research_quota = 3
        self.researcher.save()
        claim = self._paper(self.researcher)
        self.assertEqual(claim.remuneration, self.full)
        s = rt.summary(self.researcher)
        self.assertTrue(s["needs_rupee_threshold"], "shown as the old rule")

    def test_the_year_is_one_policy_setting(self):
        FormulaConfig.objects.update(research_year_start_month=4)
        start, end = rt.year_bounds(date(2026, 2, 10))
        self.assertEqual((start, end), (date(2025, 4, 1), date(2026, 4, 1)))
        FormulaConfig.objects.update(research_year_start_month=6)
        self.assertEqual(rt.year_bounds(date(2026, 9, 30))[0], date(2026, 6, 1))
        self.assertEqual(rt.year_label(date(2026, 6, 1)), "2026-27")


class SettingTests(ThresholdBase):
    def _put(self, user, target, body):
        c = Client()
        c.force_login(user)
        return c.put(
            f"/api/research-faculty/{target.id}/threshold",
            data=json.dumps(body), content_type="application/json",
        )

    def test_coordinator_and_super_admin_can_set_it(self):
        admin = User.objects.create_user(email="rt-sa@test.edu", password="p", name="Root", role=Role.SUPER_ADMIN)
        for who in (self.coordinator, admin):
            r = self._put(who, self.researcher, {"amount": 300000, "note": "Agreed at appointment"})
            self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(ResearchThreshold.objects.filter(user=self.researcher).count(), 2)
        row = ResearchThreshold.objects.filter(user=self.researcher).latest("created_at")
        self.assertEqual((row.amount, row.note, row.set_by_id), (300000, "Agreed at appointment", admin.id))
        self.assertTrue(AuditLog.objects.filter(action="RESEARCH_THRESHOLD_SET").exists())

    def test_everyone_else_is_refused(self):
        cell = User.objects.create_user(email="rt-cell@test.edu", password="p", name="Cell", role=Role.RESEARCH_CELL)
        principal = User.objects.create_user(email="rt-pr@test.edu", password="p", name="Pr", role=Role.PRINCIPAL)
        for who in (self.researcher, self.regular, cell, principal, self.finance):
            self.assertEqual(self._put(who, self.researcher, {"amount": 100}).status_code, 403, who.role)
            c = Client()
            c.force_login(who)
            self.assertEqual(c.get("/api/research-faculty").status_code, 403, who.role)
        self.assertFalse(ResearchThreshold.objects.exists())

    def test_it_needs_research_faculty_and_a_sane_number(self):
        self.assertEqual(self._put(self.coordinator, self.regular, {"amount": 1000}).status_code, 400)
        self.assertEqual(self._put(self.coordinator, self.researcher, {"amount": -1}).status_code, 400)
        self.assertEqual(self._put(self.coordinator, self.researcher, {"amount": 9e12}).status_code, 400)

    def test_setting_it_reprices_open_claims_and_keeps_history(self):
        claim = self._paper(self.researcher)
        self.assertEqual(Claim.objects.get(pk=claim.pk).remuneration, self.full)
        r = self._put(self.coordinator, self.researcher, {"amount": self.full * 3})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Claim.objects.get(pk=claim.pk).remuneration, 0.0)
        r = self._put(self.coordinator, self.researcher, {"amount": None, "note": "Post ended"})
        self.assertEqual(Claim.objects.get(pk=claim.pk).remuneration, self.full)
        self.assertEqual(len(r.json()["history"]), 2)

    def test_the_person_sees_their_own_and_not_who_set_it(self):
        self._put(self.coordinator, self.researcher, {"amount": 300000, "note": "n"})
        c = Client()
        c.force_login(self.researcher)
        body = c.get("/api/me/research-threshold").json()
        self.assertEqual(body["threshold"], 300000)
        self.assertEqual(body["left"], 300000)
        self.assertIn("Your threshold this year is ₹3,00,000", body["message"])
        self.assertNotIn("set_by", json.dumps(body))
        c.force_login(self.regular)
        self.assertEqual(c.get("/api/me/research-threshold").json(), {"research": False})

    def test_used_and_left_count_what_is_approved_or_paid(self):
        self._threshold(300000)
        claim = self._paper(self.researcher)   # submitted: not yet counted as used
        s = rt.summary(self.researcher)
        self.assertEqual(s["used"], 0)
        self.assertEqual(s["on_the_way"], claim.research_absorbed)
        Claim.objects.filter(pk=claim.pk).update(status=ClaimStatus.PRINCIPAL_APPROVED)
        s = rt.summary(self.researcher)
        self.assertEqual(s["used"], self.full)
        self.assertEqual(s["left"], 300000 - self.full)
        self.assertEqual(s["on_the_way"], 0)

    def test_used_never_includes_unapproved_claims_and_on_the_way_is_separate(self):
        # Threshold is 1.5 papers. One paper is approved, two are still with the office.
        self._threshold(self.full * 1.5)
        approved = self._paper(self.researcher)
        self._paper(self.researcher)
        self._paper(self.researcher)
        Claim.objects.filter(pk=approved.pk).update(status=ClaimStatus.PRINCIPAL_APPROVED)
        rt.refresh_open_claims(self.researcher)
        s = rt.summary(self.researcher)
        self.assertEqual(s["used"], self.full, "only the approved claim is used")
        self.assertAlmostEqual(s["left"], self.full * 0.5, places=2)
        # The two waiting claims would use the remaining half and be paid above it.
        self.assertAlmostEqual(s["on_the_way"], self.full * 0.5, places=2)
        self.assertAlmostEqual(s["on_the_way_above"], self.full * 1.5, places=2)
        self.assertIn(f"Used so far: {rt.inr(self.full)}.", s["message"])
        self.assertIn("Claims on the way would use", s["message"])
        self.assertIn("above it would be paid", s["message"])
        # Nothing approved at all: used is zero however much is waiting.
        Claim.objects.filter(pk=approved.pk).update(status=ClaimStatus.SUBMITTED)
        rt.refresh_open_claims(self.researcher)
        s = rt.summary(self.researcher)
        self.assertEqual(s["used"], 0)
        self.assertAlmostEqual(s["on_the_way"], self.full * 1.5, places=2)
        self.assertAlmostEqual(s["on_the_way_above"], self.full * 1.5, places=2)
        self.assertIn("Used so far: ₹0.", s["message"])

    def test_the_retired_quota_can_no_longer_be_written(self):
        c = Client()
        c.force_login(self.coordinator)
        r = c.patch(
            f"/api/admin/users/{self.researcher.id}",
            data=json.dumps({"faculty_type": "RESEARCH", "research_quota": 4}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("rupee threshold", r.json()["detail"])

    def test_the_claim_carries_the_effect_for_reviewers(self):
        self._threshold(self.full * 1.5)
        a = self._paper(self.researcher)
        b = self._paper(self.researcher)
        admin = User.objects.create_user(email="rt-cell2@test.edu", password="p", name="Cell", role=Role.RESEARCH_CELL)
        c = Client()
        c.force_login(admin)
        got = c.get(f"/api/claims/{b.id}").json()
        self.assertAlmostEqual(got["threshold_absorbed"], self.full * 0.5, places=2)
        self.assertAlmostEqual(got["threshold_full_amount"], self.full, places=2)
        self.assertIn("crosses your research threshold", got["threshold_note"])
        self.assertEqual(got["owner_research_threshold"], self.full * 1.5)
        self.assertFalse(got["owner_threshold_unset"])
        self.assertTrue(a.pk)

    def test_the_policy_preview_agrees_with_the_claims(self):
        self._threshold(self.full * 1.5)
        for _ in range(3):
            self._paper(self.researcher)
        live = FormulaConfig.objects.get(active=True)
        body = {
            "author_point_json": live.author_point_json, "snip_multiplier": live.snip_multiplier,
            "snip_cap": live.snip_cap, "qf_q1": live.qf_q1, "qf_q2": live.qf_q2, "qf_q3": live.qf_q3,
            "qf_q4": live.qf_q4,
        }
        admin = User.objects.create_user(email="rt-sa2@test.edu", password="p", name="Root", role=Role.SUPER_ADMIN)
        c = Client()
        c.force_login(admin)
        r = c.post("/api/admin/formula/preview", data=json.dumps(body), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()
        stored = sum(Claim.objects.filter(owner=self.researcher).values_list("remuneration", flat=True))
        regular = Claim.objects.get(owner=self.regular).remuneration
        self.assertAlmostEqual(out["before_total"], stored + regular, places=2)
        self.assertEqual(out["threshold"][0]["name"], "Research Faculty")
        self.assertAlmostEqual(out["threshold"][0]["absorbed_before"], self.full * 1.5, places=2)

    def test_home_payments_and_statement_carry_the_threshold(self):
        self._threshold(self.full * 1.5)
        a = self._paper(self.researcher)
        b = self._paper(self.researcher)
        self._pay(a)
        self._pay(b)
        c = Client()
        c.force_login(self.researcher)
        pay = c.get("/api/me/payments").json()
        self.assertTrue(pay["research"]["research"])
        self.assertEqual(pay["research"]["threshold"], self.full * 1.5)
        self.assertEqual(pay["research"]["left"], 0)
        self.assertIn("since", pay)
        st = c.get("/api/me/payments/statement").json()
        self.assertAlmostEqual(st["held_back"], self.full * 1.5, places=2)
        # Only the claim that crossed is a payment, and it says how much was held back.
        self.assertEqual(len(st["rows"]), 1)
        self.assertAlmostEqual(st["rows"][0]["held_back"], self.full * 0.5, places=2)
        c.force_login(self.regular)
        self.assertNotIn("research", c.get("/api/me/payments").json())
