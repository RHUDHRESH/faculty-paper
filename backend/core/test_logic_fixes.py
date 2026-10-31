"""Money-path logic fixes from the claim-workflow audit.

One class per finding (F1, F2, ...), each written to fail on the code as it
was and to pass on the fix. Every test drives the real endpoint or function; a
patch appears only where SQLite cannot reproduce the race being guarded
against (`select_for_update` is a no-op there), and says so.
"""
from __future__ import annotations

import json
import math
import types
from datetime import date, datetime, timezone as utc_tz
from unittest import mock

from django.db import IntegrityError
from django.test import SimpleTestCase

from core.api import _apply_calc
from core.models import (
    AuditLog,
    BankExport,
    Claim,
    ClaimStatus,
    FormulaConfig,
    Notification,
    PaidLedger,
    PriorPayment,
    Role,
    User,
)
from core.services.notify import notify
from core.services import payment_guards
from core.services.normalize import normalize_title
from core.services.remuneration import (
    DEFAULT_AUTHOR_POINTS,
    MAX_ELIGIBLE_AUTHORS,
    calculate_remuneration,
    formula_from_model,
    round2,
)
from core.test_chain_rules import ChainBase
from core.tests import _echo_verified, patch_api
from django.utils import timezone


# --------------------------------------------------------------------------- #
# F1. The "paid before" stop is released only by two staff, on purpose         #
# --------------------------------------------------------------------------- #


class F1DuplicateSettlement(ChainBase):
    TITLE = "Settlement Rules For An Old Paper"

    def setUp(self):
        super().setUp()
        # What the college already paid this person for this paper.
        PriorPayment.objects.create(
            employee_id=self.faculty.staff_id, faculty_name=self.faculty.name,
            paper_title=self.TITLE, normalized_title=normalize_title(self.TITLE),
            amount_paid=40000, claim_ref="ERP-OLD-1", raw_json="{}",
        )
        self.third = User.objects.create_user(
            email="f1-third@test.edu", password=None, name="Third Admin", role=Role.SUPER_ADMIN,
        )

        # Re-verifying at clearing asks the payment-history question again;
        # the shared stub always answers "no warning", which would quietly
        # erase the thing under test.
        def keeps_warning(*args, **kwargs):
            out = _echo_verified(*args, **kwargs)
            out["paid"] = {"warning": True, "matches": []}
            return out

        verify = patch_api("verify_publication", side_effect=keeps_warning)
        verify.start()
        self.addCleanup(verify.stop)

    def _dup(self, status=ClaimStatus.CLEARED, ticket="F1-1", **extra):
        fields = dict(paper_title=self.TITLE, duplicate_warning=True, contest_forward=True)
        if status != ClaimStatus.SUBMITTED:
            fields.update(cleared_by=self.coordinator, cleared_at=timezone.now())
        fields.update(extra)
        return self._claim(status, ticket=ticket, **fields)

    def _run_chain(self, claim):
        amt = claim.remuneration
        for who, path in ((self.principal, "principal-approve"), (self.director, "director-approve")):
            r = self._post(who, f"/api/claims/{claim.id}/{path}", {"expected_amount": amt})
            self.assertEqual(r.status_code, 200, r.content)

    def _pay(self, claim):
        return self._post(self.finance, f"/api/claims/{claim.id}/mark-paid",
                          {"expected_amount": claim.remuneration})

    # -- the flaw: a claimant-set override plus routine approvals released it --

    def test_routine_approvals_do_not_release_a_paid_before_block(self):
        # The state the old claimant path left behind: the claimant "set the
        # warning aside" themselves.
        claim = self._dup(override_duplicate=True, override_by=self.faculty, override_at=timezone.now(),
                          override_reason="This is a different paper")
        self._run_chain(claim)
        claim.refresh_from_db()
        self.assertIsNone(claim.second_approved_by_id,
                          "the Principal's and Director's routine clicks are not a second sign-off")
        r = self._pay(claim)
        self.assertIn(r.status_code, (400, 409), r.content)
        self.assertEqual(r.json().get("code"), "paid_before", r.content)
        self.assertEqual(claim.ledger_rows.count(), 0)

    def test_routine_approval_does_not_auto_second_a_duplicate_flagged_claim_in_bulk(self):
        claim = self._dup()
        r = self._post(self.principal, "/api/principal/bulk-approve", {"claim_ids": [claim.id]})
        self.assertEqual(r.json()["approved"], 1, r.content)
        claim.refresh_from_db()
        self.assertIsNone(claim.second_approved_by_id)
        r = self._post(self.director, "/api/director/bulk-approve", {"claim_ids": [claim.id]})
        self.assertEqual(r.json()["approved"], 1, r.content)
        claim.refresh_from_db()
        self.assertIsNone(claim.second_approved_by_id)

    def test_an_ordinary_high_value_claim_is_still_seconded_by_the_principal(self):
        """Unchanged: the auto-second is for a claim with no duplicate warning."""
        FormulaConfig.objects.filter(active=True).update(high_value_threshold=1)
        claim = self._dup(duplicate_warning=False, contest_forward=False, ticket="F1-OK")
        self._run_chain(claim)
        claim.refresh_from_db()
        self.assertEqual(claim.second_approved_by_id, self.principal.id)

    # -- the explicit route: a decision by one staff member, a second by another --

    def test_an_explicit_decision_and_an_explicit_second_approval_settle_it(self):
        claim = self._dup(ClaimStatus.SUBMITTED)
        r = self._post(self.cell, f"/api/claims/{claim.id}/set-aside-duplicate",
                       {"note": "A different paper by the same title, checked with the publisher"})
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertTrue(claim.override_duplicate)
        self.assertEqual(claim.override_by_id, self.cell.id)

        r = self._post(self.coordinator, f"/api/claims/{claim.id}/clear",
                       {"expected_amount": claim.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        self._run_chain(claim)
        claim.refresh_from_db()
        self.assertIsNone(claim.second_approved_by_id)

        self.assertIn(self._pay(claim).status_code, (400, 409))
        self.assertEqual(claim.ledger_rows.count(), 0)

        r = self._post(self.third, f"/api/claims/{claim.id}/second-approve", {"note": "Agreed"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._pay(claim)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(claim.ledger_rows.count(), 1)

    def test_second_approval_of_a_duplicate_needs_no_high_value_threshold(self):
        FormulaConfig.objects.filter(active=True).update(high_value_threshold=10_000_000)
        claim = self._dup(override_duplicate=True, override_by=self.cell, override_at=timezone.now())
        r = self._post(self.third, f"/api/claims/{claim.id}/second-approve", {"note": "Agreed"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_person_who_set_it_aside_cannot_also_second_it(self):
        claim = self._dup(override_duplicate=True, override_by=self.cell, override_at=timezone.now())
        r = self._post(self.cell, f"/api/claims/{claim.id}/second-approve", {"note": "Me again"})
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertIsNone(claim.second_approved_by_id)

    def test_only_the_office_can_set_a_warning_aside_and_not_the_claimant(self):
        claim = self._dup(ClaimStatus.SUBMITTED)
        for who in (self.faculty, self.finance, self.director):
            r = self._post(who, f"/api/claims/{claim.id}/set-aside-duplicate", {"note": "It is a new paper"})
            self.assertEqual(r.status_code, 403, (who.role, r.content))
        claim.refresh_from_db()
        self.assertFalse(claim.override_duplicate)

    def test_setting_aside_needs_a_reason_and_a_warning(self):
        claim = self._dup(ClaimStatus.SUBMITTED)
        r = self._post(self.cell, f"/api/claims/{claim.id}/set-aside-duplicate", {"note": "short"})
        self.assertEqual(r.status_code, 400, r.content)
        clean = self._claim(ClaimStatus.SUBMITTED, ticket="F1-CLEAN")
        r = self._post(self.cell, f"/api/claims/{clean.id}/set-aside-duplicate",
                       {"note": "A reason that is long enough"})
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_fresh_decision_replaces_a_claimants_and_clears_a_routine_second(self):
        """An in-flight claim the old path left 'settled' by the claimant and
        the Principal's click needs the staff decision afresh."""
        claim = self._dup(override_duplicate=True, override_by=self.faculty, override_at=timezone.now(),
                          second_approved_by=self.principal, second_approved_at=timezone.now())
        r = self._post(self.cell, f"/api/claims/{claim.id}/set-aside-duplicate",
                       {"note": "Checked: a different paper"})
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.override_by_id, self.cell.id)
        self.assertIsNone(claim.second_approved_by_id)

    # -- the rule itself -----------------------------------------------------

    def test_history_match_is_settled_needs_two_staff_who_are_not_the_claimant(self):
        base = dict(duplicate_warning=True, override_duplicate=True, override_by=self.cell,
                    second_approved_by=self.third)
        settled = self._dup(**base)
        self.assertTrue(payment_guards.history_match_is_settled(settled))

        def with_(**kw):
            c = Claim(**{**base, "owner": self.faculty, "cleared_by": self.coordinator, **kw})
            return payment_guards.history_match_is_settled(c)

        self.assertFalse(with_(override_by=self.faculty), "the claimant's own decision")
        self.assertFalse(with_(override_by=None), "nobody named")
        self.assertFalse(with_(second_approved_by=self.cell), "one person twice")
        self.assertFalse(with_(second_approved_by=self.coordinator), "the clearer as the second")
        self.assertFalse(with_(second_approved_by=self.faculty), "the claimant as the second")
        self.assertFalse(with_(second_approved_by=None))
        self.assertFalse(with_(override_duplicate=False))
        self.assertFalse(with_(duplicate_warning=False))


# --------------------------------------------------------------------------- #
# F2. A rate of zero is a rate of zero                                         #
# --------------------------------------------------------------------------- #


class F2ZeroRateStaysZero(SimpleTestCase):
    def _cfg(self, **over):
        fields = dict(
            snip_multiplier=55000, qf_q1=50000, qf_q2=30000, qf_q3=15000, qf_q4=7000,
            qf_no_snip=0, qf_snip_only=0, author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
        )
        fields.update(over)
        return formula_from_model(types.SimpleNamespace(**fields))

    def test_zero_fixed_rates_are_kept(self):
        cfg = self._cfg(fixed_journal_no_snip=0, fixed_other_no_snip=0, fixed_web_of_science=0)
        self.assertEqual(
            (cfg.fixed_journal_no_snip, cfg.fixed_other_no_snip, cfg.fixed_web_of_science), (0, 0, 0),
        )

    def test_a_suspended_category_pays_nothing(self):
        cfg = self._cfg(fixed_journal_no_snip=0)
        r = calculate_remuneration(
            None, None, 1, 1, cfg, publication_type="Journal", indexing_level="Scopus", sec_reference_count=2,
        )
        self.assertEqual(r.remuneration, 0)

    def test_a_missing_or_null_rate_still_takes_the_default(self):
        for cfg in (self._cfg(), self._cfg(fixed_journal_no_snip=None, fixed_other_no_snip=None,
                                           fixed_web_of_science=None)):
            self.assertEqual(
                (cfg.fixed_journal_no_snip, cfg.fixed_other_no_snip, cfg.fixed_web_of_science),
                (5000, 4000, 5000),
            )

    def test_other_rates_are_kept_as_set(self):
        cfg = self._cfg(fixed_journal_no_snip=1234.5, fixed_other_no_snip=2, fixed_web_of_science=3)
        self.assertEqual(
            (cfg.fixed_journal_no_snip, cfg.fixed_other_no_snip, cfg.fixed_web_of_science), (1234.5, 2, 3),
        )

    def test_a_zero_cap_or_author_limit_is_not_a_rate(self):
        """The calculator reads 0 as 'unset' for these two, so the loader keeps
        the default and the saved snapshot says what was applied."""
        cfg = self._cfg(snip_cap=0, max_authors=0)
        self.assertEqual((cfg.snip_cap, cfg.max_authors), (30, MAX_ELIGIBLE_AUTHORS))


# --------------------------------------------------------------------------- #
# F3. Email and WhatsApp leave only for a payment that was committed           #
# --------------------------------------------------------------------------- #


class LogicBase(ChainBase):
    """A claim the Director authorised, and the ways to pay and settle it."""

    def _authorised(self, ticket="LB-1", **extra):
        return self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket=ticket,
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            second_approved_by=self.principal, second_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
            **extra,
        )

    def _pay(self, claim):
        return self._post(self.finance, f"/api/claims/{claim.id}/mark-paid",
                          {"expected_amount": claim.remuneration})

    def _paid(self, ticket="LB-P", month=date(2026, 9, 1), payout_month=None):
        """A claim paid in `month`, with its one ledger row."""
        claim = self._authorised(ticket)
        claim.status = ClaimStatus.PAID
        claim.paid_at = timezone.now()
        claim.payout_month = payout_month
        claim.save()
        row = PaidLedger.objects.create(
            claim=claim, kind=PaidLedger.Kind.PAYMENT, cycle=1, payout_month=month,
            amount=claim.remuneration, faculty_name=self.faculty.name, voucher_number="V-LB",
        )
        return claim, row


class F3SendAfterCommit(LogicBase):
    def test_nothing_is_sent_for_a_payment_that_rolls_back(self):
        claim = self._authorised()
        # The ledger insert is the last write; losing a race on it rolls the
        # payment back after the claimant was already told "Paid".
        with mock.patch("core.services.notify.send_email") as email, \
                mock.patch("core.services.whatsapp.send_alert") as whatsapp, \
                mock.patch("core.api.director.PaidLedger.objects.create", side_effect=IntegrityError):
            with self.captureOnCommitCallbacks(execute=True):
                r = self._pay(claim)
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)
        self.assertEqual(Notification.objects.filter(user=self.faculty, kind="claim_paid").count(), 0)
        email.assert_not_called()
        whatsapp.assert_not_called()

    def test_a_committed_payment_still_tells_the_claimant(self):
        claim = self._authorised()
        with mock.patch("core.services.notify.send_email") as email, \
                mock.patch("core.services.whatsapp.send_alert") as whatsapp:
            with self.captureOnCommitCallbacks(execute=True):
                r = self._pay(claim)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Notification.objects.filter(user=self.faculty, kind="claim_paid").count(), 1)
        email.assert_called_once()
        whatsapp.assert_called_once()

    def test_the_in_app_alert_is_written_in_the_callers_transaction(self):
        """Only the outward sends wait for the commit; the bell entry is a row
        in the same transaction as the payment, so it rolls back with it."""
        with mock.patch("core.services.notify.send_email") as email, \
                mock.patch("core.services.whatsapp.send_alert") as whatsapp:
            with self.captureOnCommitCallbacks(execute=False) as callbacks:
                note = notify(self.faculty, "claim_paid", "Paid", "Your claim was paid")
            self.assertIsNotNone(Notification.objects.filter(pk=note.pk).first())
            email.assert_not_called()
            whatsapp.assert_not_called()
            self.assertEqual(len(callbacks), 1)
            callbacks[0]()
        email.assert_called_once()
        whatsapp.assert_called_once()

    def test_a_kind_with_no_outward_channel_registers_nothing(self):
        with self.captureOnCommitCallbacks(execute=False) as callbacks:
            notify(self.faculty, "desk", "Waiting", "A ticket is waiting")
        self.assertEqual(callbacks, [])


# --------------------------------------------------------------------------- #
# F4. Money periods are decided on the college's calendar, not UTC's           #
# --------------------------------------------------------------------------- #


def at_utc(*args):
    """Freeze the clock at a UTC instant. 20:30 UTC is 02:00 the next day in India."""
    return mock.patch("django.utils.timezone.now", return_value=datetime(*args, tzinfo=utc_tz.utc))


#: 02:00 IST on Sunday 1 November 2026, which is still 31 October in UTC.
NOV_1_2AM_IST = (2026, 10, 31, 20, 30)


class F4LocalDate(LogicBase):
    def setUp(self):
        super().setUp()
        self.nov = date(2026, 11, 1)

    def test_a_payment_at_2am_on_the_1st_belongs_to_that_month(self):
        claim = self._authorised("F4-PAY")
        with at_utc(*NOV_1_2AM_IST):
            r = self._pay(claim)
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.payout_month, self.nov)
        self.assertEqual(claim.ledger_rows.get().payout_month, self.nov)

    def test_a_void_at_2am_on_the_1st_is_booked_to_that_month(self):
        claim, _ = self._paid("F4-VOID", month=date(2026, 10, 1))
        with at_utc(*NOV_1_2AM_IST):
            r = self._post(self.admin, f"/api/claims/{claim.id}/void-payment", {"note": "Paid on the wrong voucher"})
        self.assertEqual(r.status_code, 200, r.content)
        reversal = claim.ledger_rows.get(kind=PaidLedger.Kind.REVERSAL)
        self.assertEqual(reversal.payout_month, self.nov)

    def test_a_missing_ledger_row_added_at_2am_on_the_1st_lands_in_that_month(self):
        from core.services import ledger_checks

        claim = self._claim(ClaimStatus.PAID, ticket="F4-ADD")
        Claim.objects.filter(pk=claim.pk).update(remuneration=5000, payout_month=None, paid_at=timezone.now())
        with at_utc(*NOV_1_2AM_IST):
            ledger_checks.add_missing(self.admin, claim.id, "Imported without its ledger row")
        self.assertEqual(claim.ledger_rows.get().payout_month, self.nov)

    def test_a_data_fix_amount_at_2am_on_the_1st_lands_in_that_month(self):
        from core.services import claim_fixes

        claim = self._claim(ClaimStatus.PAID, ticket="F4-FIX")
        Claim.objects.filter(pk=claim.pk).update(remuneration=0, payout_month=None, paid_at=timezone.now())
        with at_utc(*NOV_1_2AM_IST):
            claim_fixes.apply_fix(self.admin, claim.id, amount=3000, reason="From the accounts register")
        self.assertEqual(claim.ledger_rows.get().payout_month, self.nov)

    def test_a_super_admin_amount_correction_at_2am_on_the_1st_lands_in_that_month(self):
        claim = self._claim(ClaimStatus.PAID, ticket="F4-EDIT")
        Claim.objects.filter(pk=claim.pk).update(remuneration=1000, payout_month=None, paid_at=timezone.now())
        with at_utc(*NOV_1_2AM_IST):
            r = self._post(self.admin, f"/api/admin/claims/{claim.id}/edit",
                           {"fields": {"remuneration": 4000}, "reason": "Corrected from the register"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(claim.ledger_rows.get().payout_month, self.nov)

    def test_a_policy_saved_at_2am_on_the_1st_takes_effect_that_day(self):
        body = {
            "snip_multiplier": 55000, "snip_cap": 30, "qf_q1": 50000, "qf_q2": 30000, "qf_q3": 15000,
            "qf_q4": 7000, "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS),
        }
        with at_utc(*NOV_1_2AM_IST):
            r = self._as(self.admin).put("/api/admin/formula", data=json.dumps(body),
                                         content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(FormulaConfig.objects.get(active=True).effective_from, self.nov)

    def test_the_financial_year_turns_over_at_midnight_in_india(self):
        from core.services import payout_statement

        april_1_2am_ist = (2027, 3, 31, 20, 30)
        with at_utc(*april_1_2am_ist):
            shown = self._as(self.admin).get("/api/budgets").json()
            statement = payout_statement.financial_year()
        self.assertEqual(shown["financial_year"], "2027-28")
        self.assertEqual(statement["financial_year"], "2027-28")

    def test_the_research_year_turns_over_at_midnight_in_india(self):
        from core.api.my_payments import academic_year_start

        june_1_2am_ist = (2027, 5, 31, 20, 30)
        with at_utc(*june_1_2am_ist):
            self.assertEqual(academic_year_start(), date(2027, 6, 1))


# --------------------------------------------------------------------------- #
# F5. A slow outside check never writes over what happened while it ran        #
# --------------------------------------------------------------------------- #


class F5StaleCheck(LogicBase):
    """`select_for_update` is a no-op on SQLite, so the race is staged: the
    outside call (patched) changes the claim in the database while it runs,
    which is what a concurrent request does on PostgreSQL once the lock is
    not held across the call."""

    def _during_the_check(self, claim, **changes):
        def check(*args, **kwargs):
            Claim.objects.filter(pk=claim.pk).update(**changes)
            return _echo_verified(*args, **kwargs)

        patcher = patch_api("verify_publication", side_effect=check)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_verify_does_not_revert_a_payment_made_meanwhile(self):
        claim = self._authorised("F5-V")
        paid_at = timezone.now()
        self._during_the_check(claim, status=ClaimStatus.PAID, paid_at=paid_at)
        r = self._post(self.cell, f"/api/claims/{claim.id}/verify")
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertEqual(claim.paid_at, paid_at)

    def test_recalculate_does_not_revert_a_payment_made_meanwhile(self):
        claim = self._authorised("F5-R")
        paid_at = timezone.now()
        self._during_the_check(claim, status=ClaimStatus.PAID, paid_at=paid_at)
        r = self._post(self.cell, f"/api/claims/{claim.id}/recalculate")
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertEqual(claim.paid_at, paid_at)

    def test_set_verified_does_not_revert_a_payment_made_meanwhile(self):
        claim = self._authorised("F5-S")
        paid_at = timezone.now()
        real_calc = _apply_calc

        def calc_while_paid(c):
            Claim.objects.filter(pk=claim.pk).update(status=ClaimStatus.PAID, paid_at=paid_at)
            return real_calc(c)

        with mock.patch("core.api.director._apply_calc", side_effect=calc_while_paid):
            r = self._post(self.cell, f"/api/admin/claims/{claim.id}/set-verified",
                           {"snip": 2.0, "note": "From the SNIP dump, row 14"})
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertEqual(claim.paid_at, paid_at)

    def test_a_status_that_moved_on_is_not_overwritten_even_if_not_paid(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="F5-M")
        self._during_the_check(claim, status=ClaimStatus.REJECTED)
        r = self._post(self.cell, f"/api/claims/{claim.id}/verify")
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.REJECTED)

    def test_only_the_verified_columns_are_written(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="F5-C", snip=1.0)
        self._during_the_check(claim, on_hold=True, hold_reason="Waiting on the publisher")
        r = self._post(self.cell, f"/api/claims/{claim.id}/recalculate")
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertTrue(claim.on_hold, "a hold placed while the check ran must survive it")
        self.assertEqual(claim.hold_reason, "Waiting on the publisher")

    def test_a_quiet_check_still_saves_its_findings(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="F5-OK")
        Claim.objects.filter(pk=claim.pk).update(remuneration=1.0)
        r = self._post(self.cell, f"/api/claims/{claim.id}/verify")
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertGreater(claim.remuneration, 1.0, "the recomputed amount was saved")
        self.assertTrue(claim.actions.filter(action="VERIFY").exists())


# --------------------------------------------------------------------------- #
# F7. A void respects the bank file and leaves no old month behind            #
# --------------------------------------------------------------------------- #


class F7Void(LogicBase):
    NOTE = "Paid on the wrong voucher"

    def _void(self, claim, **extra):
        return self._post(self.admin, f"/api/claims/{claim.id}/void-payment", {"note": self.NOTE, **extra})

    def _exported(self, row):
        row.bank_export = BankExport.objects.create(month="2026-09", row_count=1, total_amount=row.amount)
        row.save(update_fields=["bank_export"])

    def test_a_payment_already_in_a_bank_file_is_not_voided_without_a_recall(self):
        claim, row = self._paid("F7-B", payout_month=date(2026, 9, 1))
        self._exported(row)
        r = self._void(claim)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("bank", r.json()["detail"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertEqual(claim.ledger_rows.filter(kind=PaidLedger.Kind.REVERSAL).count(), 0)

    def test_a_bank_recall_reference_lets_it_through_and_is_kept(self):
        claim, row = self._paid("F7-BR", payout_month=date(2026, 9, 1))
        self._exported(row)
        r = self._void(claim, bank_recall_ref="Bank recall BR-2026-77, confirmed by phone")
        self.assertEqual(r.status_code, 200, r.content)
        reversal = claim.ledger_rows.get(kind=PaidLedger.Kind.REVERSAL)
        self.assertIn("BR-2026-77", reversal.raw_json)
        logged = AuditLog.objects.get(action="LEDGER_REVERSAL", entity_id=reversal.id)
        self.assertIn("BR-2026-77", logged.detail_json)

    def test_a_payment_not_yet_sent_to_the_bank_is_voided_as_before(self):
        claim, _ = self._paid("F7-N", payout_month=date(2026, 9, 1))
        r = self._void(claim)
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_void_clears_the_month_and_voucher_it_was_paid_under(self):
        claim, _ = self._paid("F7-C", payout_month=date(2026, 9, 1))
        Claim.objects.filter(pk=claim.pk).update(voucher_number="V-OLD")
        r = self._void(claim)
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertIsNone(claim.payout_month)
        self.assertIsNone(claim.voucher_number)
        reversal = claim.ledger_rows.get(kind=PaidLedger.Kind.REVERSAL)
        self.assertEqual(reversal.payout_month, date(2026, 9, 1), "the reversal belongs to the month it undoes")
        self.assertTrue(reversal.voucher_number.startswith("V-OLD"))

    def test_a_repayment_after_a_void_lands_in_the_month_it_is_made(self):
        claim, _ = self._paid("F7-R", payout_month=date(2026, 9, 1))
        self.assertEqual(self._void(claim).status_code, 200)
        amt = {"expected_amount": claim.remuneration}
        with at_utc(2026, 12, 15, 10, 0):
            for who, step in ((self.principal, "principal-approve"), (self.director, "director-approve")):
                r = self._post(who, f"/api/claims/{claim.id}/{step}", amt)
                self.assertEqual(r.status_code, 200, r.content)
            r = self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", amt)
        self.assertEqual(r.status_code, 200, r.content)
        second = claim.ledger_rows.get(kind=PaidLedger.Kind.PAYMENT, cycle=2)
        self.assertEqual(second.payout_month, date(2026, 12, 1))


# --------------------------------------------------------------------------- #
# F8. A claim the calculator could not price is not cleared, approved or paid  #
# --------------------------------------------------------------------------- #


class F8Unpriced(LogicBase):
    #: Twelve authors: over the nine the policy covers, so there is no amount.
    UNPRICED = dict(total_authors=12, author_position=1)

    def _unpriced(self, status, ticket, **extra):
        claim = self._claim(status, ticket=ticket, **self.UNPRICED, **extra)
        self.assertTrue(claim.calc_error, "the fixture must be unpriced")
        self.assertIsNone(claim.remuneration)
        return claim

    def _assert_refused(self, r, claim, status):
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("could not price", r.json()["detail"])
        claim.refresh_from_db()
        self.assertEqual(claim.status, status)

    def test_clear_refuses_it(self):
        claim = self._unpriced(ClaimStatus.SUBMITTED, "F8-C")
        r = self._post(self.cell, f"/api/claims/{claim.id}/clear", {"expected_amount": 0})
        self._assert_refused(r, claim, ClaimStatus.SUBMITTED)

    def test_principal_approval_refuses_it(self):
        claim = self._unpriced(ClaimStatus.CLEARED, "F8-P", cleared_by=self.cell, cleared_at=timezone.now())
        r = self._post(self.principal, f"/api/claims/{claim.id}/principal-approve", {"expected_amount": 0})
        self._assert_refused(r, claim, ClaimStatus.CLEARED)

    def test_director_authorisation_refuses_it(self):
        claim = self._unpriced(
            ClaimStatus.PRINCIPAL_APPROVED, "F8-D", cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
        )
        r = self._post(self.director, f"/api/claims/{claim.id}/director-approve", {"expected_amount": 0})
        self._assert_refused(r, claim, ClaimStatus.PRINCIPAL_APPROVED)

    def test_payment_refuses_it(self):
        claim = self._unpriced(
            ClaimStatus.DIRECTOR_APPROVED, "F8-PAY", cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
        )
        r = self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", {"expected_amount": 0})
        self._assert_refused(r, claim, ClaimStatus.DIRECTOR_APPROVED)
        self.assertEqual(claim.ledger_rows.count(), 0)

    def test_the_bulk_routes_skip_it(self):
        submitted = self._unpriced(ClaimStatus.SUBMITTED, "F8-BC")
        r = self._post(self.cell, "/api/admin/bulk-clear", {"claim_ids": [submitted.id]})
        self.assertEqual(r.json().get("cleared", 0), 0, r.content)
        self.assertTrue(any("could not price" in s["reason"] for s in r.json()["skipped"]), r.content)
        submitted.refresh_from_db()
        self.assertEqual(submitted.status, ClaimStatus.SUBMITTED)

        cleared = self._unpriced(ClaimStatus.CLEARED, "F8-BP", cleared_by=self.cell, cleared_at=timezone.now())
        r = self._post(self.principal, "/api/principal/bulk-approve", {"claim_ids": [cleared.id]})
        self.assertEqual(r.json()["approved"], 0, r.content)
        self.assertTrue(any("could not price" in s["reason"] for s in r.json()["skipped"]), r.content)

        approved = self._unpriced(
            ClaimStatus.PRINCIPAL_APPROVED, "F8-BD", cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
        )
        r = self._post(self.director, "/api/director/bulk-approve", {"claim_ids": [approved.id]})
        self.assertEqual(r.json()["approved"], 0, r.content)
        self.assertTrue(any("could not price" in s["reason"] for s in r.json()["skipped"]), r.content)

    def test_a_priced_claim_is_untouched(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="F8-OK")
        r = self._post(self.cell, f"/api/claims/{claim.id}/clear", {"expected_amount": claim.remuneration})
        self.assertEqual(r.status_code, 200, r.content)


# --------------------------------------------------------------------------- #
# F9. A second signature does not outlive the approval it was given to         #
# --------------------------------------------------------------------------- #


class F9SecondSignatureWithdrawn(LogicBase):
    def _signed(self, status, ticket, **extra):
        """A claim carrying a set-aside warning and a second signature."""
        return self._claim(
            status, ticket=ticket, cleared_by=self.coordinator, cleared_at=timezone.now(),
            duplicate_warning=True, override_duplicate=True, override_by=self.cell,
            override_at=timezone.now(), override_reason="Checked: a different paper",
            second_approved_by=self.admin, second_approved_at=timezone.now(), **extra,
        )

    def _assert_unsigned(self, claim):
        claim.refresh_from_db()
        self.assertIsNone(claim.second_approved_by_id)
        self.assertIsNone(claim.second_approved_at)
        self.assertFalse(claim.override_duplicate)
        self.assertIsNone(claim.override_by_id)
        self.assertIsNone(claim.override_at)
        self.assertIsNone(claim.override_reason)

    def test_sending_it_back_to_the_claimant_withdraws_the_signature(self):
        claim = self._signed(ClaimStatus.CLEARED, "F9-S")
        r = self._post(self.principal, f"/api/claims/{claim.id}/return-to-faculty",
                       {"note": "Attach the published version"})
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_unsigned(claim)

    def test_rejecting_it_withdraws_the_signature(self):
        claim = self._signed(ClaimStatus.SUBMITTED, "F9-R")
        r = self._post(self.cell, f"/api/claims/{claim.id}/reject-outright",
                       {"note": "The venue is not an indexed journal"})
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_unsigned(claim)

    def test_the_principals_one_step_return_withdraws_the_signature(self):
        claim = self._signed(ClaimStatus.CLEARED, "F9-P")
        r = self._post(self.principal, f"/api/claims/{claim.id}/principal-reject", {"note": "Look again"})
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_unsigned(claim)

    def test_a_super_admins_send_back_from_the_director_stage_withdraws_it(self):
        claim = self._signed(
            ClaimStatus.PRINCIPAL_APPROVED, "F9-D",
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
        )
        r = self._post(self.admin, f"/api/claims/{claim.id}/director-reject", {"note": "Wrong budget head"})
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_unsigned(claim)

    def test_a_payment_that_drifted_back_to_cleared_withdraws_it(self):
        claim = self._signed(
            ClaimStatus.DIRECTOR_APPROVED, "F9-A",
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
            authorised_amount=1.0,
        )
        r = self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", {"expected_amount": claim.remuneration})
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self._assert_unsigned(claim)

    def test_a_void_withdraws_the_signature(self):
        claim, _ = self._paid("F9-V", payout_month=date(2026, 9, 1))
        Claim.objects.filter(pk=claim.pk).update(
            duplicate_warning=True, override_duplicate=True, override_by=self.cell,
            override_at=timezone.now(), override_reason="Checked: a different paper",
            second_approved_by=self.admin, second_approved_at=timezone.now(),
        )
        r = self._post(self.admin, f"/api/claims/{claim.id}/void-payment", {"note": "Paid on the wrong voucher"})
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_unsigned(claim)

    def test_the_warning_itself_stays_so_a_repayment_still_needs_a_fresh_decision(self):
        claim = self._signed(ClaimStatus.CLEARED, "F9-W")
        self._post(self.principal, f"/api/claims/{claim.id}/principal-reject", {"note": "Look again"})
        claim.refresh_from_db()
        self.assertTrue(claim.duplicate_warning)
        self.assertFalse(payment_guards.history_match_is_settled(claim))


# --------------------------------------------------------------------------- #
# F12. A payee with no staff id is still checked against the payment history   #
# --------------------------------------------------------------------------- #


class F12NoStaffId(LogicBase):
    TITLE = "Payment History For Somebody Without An Id"

    def setUp(self):
        super().setUp()
        self.nobody = User.objects.create_user(
            email="f12-nostaff@test.edu", password=None, name="Nandini Noid", role=Role.FACULTY, department="CSE",
        )
        self.assertFalse((self.nobody.staff_id or "").strip())

    def _prior(self, name="Nandini Noid", employee_id=None):
        return PriorPayment.objects.create(
            employee_id=employee_id, faculty_name=name, paper_title=self.TITLE,
            normalized_title=normalize_title(self.TITLE), amount_paid=40000, claim_ref="ERP-F12", raw_json="{}",
        )

    def _claim_for(self, owner, ticket="F12-1"):
        return self._authorised(ticket, owner=owner, paper_title=self.TITLE)

    def test_the_same_name_and_title_is_found(self):
        self._prior()
        found = payment_guards.earlier_payment(self._claim_for(self.nobody))
        self.assertIsNotNone(found)
        self.assertEqual(found["code"], "paid_before")

    def test_it_stops_the_payment(self):
        self._prior()
        claim = self._claim_for(self.nobody)
        r = self._pay(claim)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "paid_before")
        self.assertEqual(claim.ledger_rows.count(), 0)

    def test_the_name_is_matched_without_regard_to_case(self):
        self._prior(name="NANDINI NOID")
        self.assertIsNotNone(payment_guards.earlier_payment(self._claim_for(self.nobody)))

    def test_another_persons_payment_for_the_paper_is_not_a_match(self):
        self._prior(name="Somebody Else")
        self.assertIsNone(payment_guards.earlier_payment(self._claim_for(self.nobody)))

    def test_a_different_paper_by_the_same_name_is_not_a_match(self):
        self._prior()
        claim = self._authorised("F12-2", owner=self.nobody, paper_title="A Completely Different Paper Title")
        self.assertIsNone(payment_guards.earlier_payment(claim))

    def test_a_payee_with_a_staff_id_is_still_matched_on_it_alone(self):
        """Unchanged: where there is an id the name is not consulted."""
        self._prior(name=self.faculty.name, employee_id="SOMEONE-ELSE")
        claim = self._authorised("F12-3", paper_title=self.TITLE)
        self.assertIsNone(payment_guards.earlier_payment(claim))


# --------------------------------------------------------------------------- #
# F15 (cheap part). Money rounds half-up, on the decimal figure written down   #
# --------------------------------------------------------------------------- #


class Round2HalfUp(SimpleTestCase):
    def test_a_half_rounds_up_where_binary_floats_rounded_it_down(self):
        self.assertEqual(round2(0.125), 0.13)   # round(12.5) is 12
        self.assertEqual(round2(2.675), 2.68)   # the float is 2.67499999...
        self.assertEqual(round2(1.005), 1.01)   # the float is 1.00499999...
        self.assertEqual(round2(0.145), 0.15)

    def test_negative_values_round_away_from_zero(self):
        self.assertEqual(round2(-0.125), -0.13)
        self.assertEqual(round2(-2.675), -2.68)
        self.assertEqual(round2(-0.124), -0.12)

    def test_large_values(self):
        self.assertEqual(round2(123456789012.345), 123456789012.35)
        self.assertEqual(round2(1_000_000.0), 1_000_000.0)
        self.assertEqual(round2(26_320_144.725), 26_320_144.73)

    def test_values_already_at_two_places_are_unchanged(self):
        for value in (0, 0.0, 1, 12.5, 69600.0, 3783.38, 0.01, 99999.99):
            self.assertEqual(round2(value), float(value))

    def test_it_still_returns_a_float_and_never_a_negative_zero(self):
        self.assertIsInstance(round2(5), float)
        self.assertEqual(math.copysign(1, round2(-0.001)), 1.0)

    def test_a_value_that_is_not_a_number_still_raises(self):
        for bad in (float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                round2(bad)

    def test_the_share_allocator_still_sums_to_the_paper_total(self):
        from core.services.remuneration import _author_point_row, allocate_shares, FormulaConfigInput

        for authors in range(1, 10):
            row = _author_point_row(authors, FormulaConfigInput())
            for base in (55.0, 12345.67, 7000.01, 0.125):
                self.assertAlmostEqual(sum(allocate_shares(base, row)), round2(base * sum(row)), places=2)
