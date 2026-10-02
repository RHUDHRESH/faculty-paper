"""Paying twice, and the people allowed to pay.

One class per risk in docs/ops/safeguards.md, so a row of that table points at
a test by name. SQLite has no row lock (`select_for_update` is a no-op there),
so the race tests assert the layer that *does* hold on SQLite, the database's
own unique index, by letting the second request through every check that
would normally stop it. The threaded test at the bottom runs only on
PostgreSQL, where the row lock is real.
"""
from __future__ import annotations

import threading
from datetime import date

from django.db import IntegrityError, connection, transaction
from unittest import skipUnless

from django.test import TransactionTestCase
from django.utils import timezone

from core.models import (
    AuditLog,
    Claim,
    ClaimAction,
    ClaimStatus,
    Notification,
    PaidLedger,
    PriorPayment,
    Role,
    User,
)
from core.services import payment_guards
from core.test_chain_rules import ChainBase


class SgBase(ChainBase):
    def _authorised(self, ticket="SG-1", **extra):
        claim = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket=ticket,
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            second_approved_by=self.principal, second_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
            **extra,
        )
        full = round((claim.remuneration or 0) + (claim.research_absorbed or 0), 2)
        Claim.objects.filter(pk=claim.pk).update(authorised_amount=full)
        claim.refresh_from_db()
        return claim

    def pay(self, who, claim, **body):
        body.setdefault("expected_amount", claim.remuneration)
        return self._post(who, f"/api/claims/{claim.id}/mark-paid", body)

    def payments(self, claim):
        return claim.ledger_rows.filter(kind="PAYMENT")


class DoubleClickAndRetry(SgBase):
    """Risk: the Pay button pressed twice, or pressed again after a timeout."""

    def test_a_second_pay_of_a_paid_claim_is_refused_in_words(self):
        claim = self._authorised()
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)
        again = self.pay(self.finance, claim)
        self.assertEqual(again.status_code, 400, again.content)
        self.assertEqual(again.json()["code"], "already_paid")
        self.assertIn("Already paid", again.json()["detail"])
        self.assertEqual(self.payments(claim).count(), 1)

    def test_a_retry_with_the_same_key_gets_the_first_answer_and_pays_nothing_more(self):
        claim = self._authorised()
        first = self.pay(self.finance, claim, idempotency_key="dialog-1")
        self.assertEqual(first.status_code, 200, first.content)
        self.assertFalse(first.json()["replayed"])
        # The client never saw the answer (timeout) and asks again, same key.
        retry = self.pay(self.finance, claim, idempotency_key="dialog-1")
        self.assertEqual(retry.status_code, 200, retry.content)
        self.assertTrue(retry.json()["replayed"])
        self.assertEqual(retry.json()["status"], ClaimStatus.PAID)
        self.assertEqual(self.payments(claim).count(), 1)
        self.assertEqual(PaidLedger.objects.get(claim=claim).idempotency_key, "dialog-1")

    def test_a_key_cannot_be_reused_for_a_different_claim(self):
        one, two = self._authorised("SG-K1"), self._authorised("SG-K2")
        self.assertEqual(self.pay(self.finance, one, idempotency_key="shared").status_code, 200)
        r = self.pay(self.finance, two, idempotency_key="shared")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "key_reused")
        two.refresh_from_db()
        self.assertEqual(two.status, ClaimStatus.DIRECTOR_APPROVED)

    def test_the_idempotency_key_is_unique_in_the_database(self):
        claim = self._authorised()
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=1, idempotency_key="k")
        other = self._authorised("SG-K3")
        with self.assertRaises(IntegrityError), transaction.atomic():
            PaidLedger.objects.create(claim=other, payout_month=date(2026, 9, 1), amount=1, idempotency_key="k")


class TwoSessionsAtOnce(SgBase):
    """Risk: two Finance sessions pay the same claim in the same instant."""

    def test_the_database_refuses_a_second_payment_in_the_same_cycle(self):
        claim = self._authorised()
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=10)
        with self.assertRaises(IntegrityError), transaction.atomic():
            PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=10)
        self.assertEqual(self.payments(claim).count(), 1)

    def test_a_request_that_passed_every_check_still_cannot_pay_twice(self):
        """Session B read the claim before session A committed, so it sees an
        authorised, unpaid claim and every check passes. The index catches it."""
        claim = self._authorised()
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)
        # Put the claim back as session B's stale read had it.
        Claim.objects.filter(pk=claim.pk).update(status=ClaimStatus.DIRECTOR_APPROVED)
        from unittest.mock import patch

        with patch.object(payment_guards, "already_paid_answer", return_value=None), \
                patch.object(payment_guards, "earlier_payment", return_value=None):
            r = self.pay(self.finance, claim)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(r.json()["code"], "already_paid")
        self.assertEqual(self.payments(claim).count(), 1, "exactly one payment on the ledger")
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED, "the refused request wrote nothing")


@skipUnless(connection.vendor == "postgresql", "needs a real row lock")
class TwoSessionsOnPostgres(TransactionTestCase):
    def test_two_threads_pay_one_claim_once(self):
        from django.test import Client

        from core.api import _apply_calc  # noqa: F401
        from core.models import FormulaConfig

        FormulaConfig.objects.create(active=True)
        fac = User.objects.create_user(email="pg-fac@t.edu", password="p", name="F", role=Role.FACULTY, staff_id="PG1")
        fin = User.objects.create_user(email="pg-fin@t.edu", password="p", name="Fin", role=Role.FINANCE)
        claim = Claim.objects.create(owner=fac, status=ClaimStatus.DIRECTOR_APPROVED, remuneration=5000,
                                     director_approved_at=timezone.now(), paper_title="Concurrent paper title")
        results: list[int] = []

        def go():
            c = Client()
            c.force_login(fin)
            r = c.post(f"/api/claims/{claim.id}/mark-paid", data='{"expected_amount": 5000}',
                       content_type="application/json")
            results.append(r.status_code)

        threads = [threading.Thread(target=go) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(PaidLedger.objects.filter(claim=claim, kind="PAYMENT").count(), 1, results)


class BulkReplay(SgBase):
    """Risk: a bulk pay run again, by a retry or a second tab."""

    def test_replaying_the_same_batch_pays_nothing_twice_and_says_so(self):
        a, b = self._authorised("SG-B1"), self._authorised("SG-B2")
        body = {"items": [{"claim_id": a.id, "expected_amount": a.remuneration},
                          {"claim_id": b.id, "expected_amount": b.remuneration}],
                "idempotency_key": "batch-7"}
        first = self._post(self.finance, "/api/admin/bulk-mark-paid", body).json()
        self.assertEqual((first["paid"], first["replayed"]), (2, 0))
        again = self._post(self.finance, "/api/admin/bulk-mark-paid", body).json()
        self.assertEqual((again["paid"], again["replayed"]), (2, 2))
        self.assertEqual(PaidLedger.objects.filter(kind="PAYMENT").count(), 2)

    def test_a_second_batch_with_a_new_key_skips_what_is_paid_with_the_reason(self):
        a = self._authorised("SG-B3")
        body = {"items": [{"claim_id": a.id, "expected_amount": a.remuneration}]}
        self.assertEqual(self._post(self.finance, "/api/admin/bulk-mark-paid", body).json()["paid"], 1)
        again = self._post(self.finance, "/api/admin/bulk-mark-paid", body).json()
        self.assertEqual(again["paid"], 0)
        self.assertEqual(again["skipped"][0]["code"], "already_paid")
        self.assertEqual(self.payments(a).count(), 1)


class RePayAfterVoid(SgBase):
    """Risk: re-paying a voided claim twice, or voiding one payment twice."""

    def _voided(self):
        claim = self._authorised("SG-V1")
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)
        r = self._post(self.admin, f"/api/claims/{claim.id}/void-payment", {"note": "Paid against the wrong voucher"})
        self.assertEqual(r.status_code, 200, r.content)
        return claim

    def test_a_voided_claim_can_be_paid_again_once(self):
        claim = self._voided()
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        rows = list(claim.ledger_rows.order_by("created_at").values_list("kind", "cycle", "amount"))
        self.assertEqual([r[:2] for r in rows], [("PAYMENT", 1), ("REVERSAL", 1)])
        # Back through the chain, then paid: the second payment is cycle 2.
        Claim.objects.filter(pk=claim.pk).update(status=ClaimStatus.DIRECTOR_APPROVED, director_approved_at=timezone.now(),
                                                 authorised_amount=claim.remuneration)
        claim.refresh_from_db()
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)
        self.assertEqual([(r.kind, r.cycle) for r in claim.ledger_rows.order_by("created_at")],
                         [("PAYMENT", 1), ("REVERSAL", 1), ("PAYMENT", 2)])
        self.assertEqual(self.pay(self.finance, claim).status_code, 400, "and only once")
        self.assertEqual(sum(r.amount for r in claim.ledger_rows.all()), claim.remuneration)

    def test_the_database_refuses_two_reversals_of_one_payment(self):
        claim = self._voided()
        with self.assertRaises(IntegrityError), transaction.atomic():
            PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=-1, kind="REVERSAL", cycle=1)

    def test_voiding_twice_is_refused(self):
        claim = self._voided()
        r = self._post(self.admin, f"/api/claims/{claim.id}/void-payment", {"note": "Trying to void it again"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(claim.ledger_rows.filter(kind="REVERSAL").count(), 1)

    def test_a_void_needs_a_reason_and_a_super_admin(self):
        claim = self._authorised("SG-V2")
        self.pay(self.finance, claim)
        short = self._post(self.admin, f"/api/claims/{claim.id}/void-payment", {"note": "oops"})
        self.assertEqual(short.status_code, 400)
        for who in (self.finance, self.director, self.principal, self.cell, self.coordinator):
            r = self._post(who, f"/api/claims/{claim.id}/void-payment", {"note": "A perfectly good reason"})
            self.assertEqual(r.status_code, 403, who.role)
        self.assertEqual(claim.ledger_rows.filter(kind="REVERSAL").count(), 0)


class AmountLockedAtAuthorisation(SgBase):
    """Risk: paying a claim whose amount changed after the Director signed."""

    def test_the_director_authorising_records_the_amount(self):
        claim = self._claim(
            ClaimStatus.PRINCIPAL_APPROVED, ticket="SG-AUTH", cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
        )
        r = self._post(self.director, f"/api/claims/{claim.id}/director-approve", {"expected_amount": claim.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.authorised_amount, round((claim.remuneration or 0) + (claim.research_absorbed or 0), 2))

    def test_a_changed_amount_sends_the_claim_back_with_an_audit_row_and_pays_nothing(self):
        claim = self._authorised("SG-DRIFT")
        authorised = claim.authorised_amount
        # Something the price depends on moved after the Director signed: the
        # paper turned out to have more authors, so the first author's share fell.
        Claim.objects.filter(pk=claim.pk).update(author_position=1, total_authors=4)
        r = self.pay(self.finance, claim, expected_amount=authorised)
        self.assertEqual(r.status_code, 409, r.content)
        self.assertEqual(r.json()["code"], "amount_changed")
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self.assertIsNone(claim.director_approved_at)
        self.assertIsNone(claim.authorised_amount)
        self.assertEqual(claim.ledger_rows.count(), 0, "nothing was paid")
        audit = AuditLog.objects.get(action="PAYMENT_BLOCKED_AMOUNT_CHANGED", entity_id=claim.id)
        self.assertIn(str(authorised), audit.detail_json)
        self.assertTrue(ClaimAction.objects.filter(claim=claim, action="AMOUNT_CHANGED_SEND_BACK").exists())
        self.assertTrue(Notification.objects.filter(user=self.principal, claim_id=claim.id).exists(),
                        "the Principal is told it is waiting again")

    def test_an_unchanged_amount_pays(self):
        claim = self._authorised("SG-SAME")
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)

    def test_a_claim_authorised_before_the_column_existed_is_not_locked(self):
        claim = self._authorised("SG-OLD")
        Claim.objects.filter(pk=claim.pk).update(authorised_amount=None)
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)

    def test_the_pay_check_says_so_before_the_click(self):
        claim = self._authorised("SG-CHK")
        Claim.objects.filter(pk=claim.pk).update(authorised_amount=(claim.authorised_amount or 0) + 1000)
        body = self._as(self.finance).get(f"/api/claims/{claim.id}/pay-check").json()
        self.assertFalse(body["blocked"], "a changed amount sends it back, it does not block the screen")
        self.assertEqual([p["code"] for p in body["problems"]], ["amount_changed"])


class InactiveAndSeparation(SgBase):
    """Risks: paying somebody whose account is off; the authoriser also paying."""

    def test_finance_cannot_pay_a_person_whose_account_is_switched_off(self):
        claim = self._authorised("SG-OFF")
        User.objects.filter(pk=claim.owner_id).update(active=False)
        r = self.pay(self.finance, claim)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(r.json()["code"], "owner_inactive")
        self.assertEqual(claim.ledger_rows.count(), 0)

    def test_a_super_admin_pays_them_only_with_a_reason_on_the_record(self):
        claim = self._authorised("SG-OFF2")
        User.objects.filter(pk=claim.owner_id).update(active=False)
        no_reason = self.pay(self.admin, claim)
        self.assertEqual((no_reason.status_code, no_reason.json()["code"]), (400, "reason_needed"))
        ok = self.pay(self.admin, claim, note="Left in March; the money is owed to them")
        self.assertEqual(ok.status_code, 200, ok.content)
        detail = AuditLog.objects.get(action="LEDGER_PAYMENT", entity_id=PaidLedger.objects.get(claim=claim).id).detail_json
        self.assertIn("switched off", detail)
        self.assertIn("Left in March", detail)

    def test_the_person_who_authorised_cannot_also_pay_unless_a_super_admin_says_why(self):
        claim = self._authorised("SG-SELF")
        Claim.objects.filter(pk=claim.pk).update(director_approved_by=self.admin)
        refused = self.pay(self.admin, claim)
        self.assertEqual((refused.status_code, refused.json()["code"]), (400, "reason_needed"))
        done = self.pay(self.admin, claim, note="Finance is on leave and this is due today")
        self.assertEqual(done.status_code, 200, done.content)

    def test_finance_who_somehow_authorised_may_not_pay_at_all(self):
        claim = self._authorised("SG-SELF2")
        Claim.objects.filter(pk=claim.pk).update(director_approved_by=self.finance)
        r = self.pay(self.finance, claim, note="I authorised it and I am paying it")
        self.assertEqual((r.status_code, r.json()["code"]), (403, "own_authorisation"))

    def test_nobody_pays_their_own_claim_and_the_pay_check_says_so(self):
        claim = self._authorised("SG-OWN", owner=self.finance)
        self.assertEqual(self.pay(self.finance, claim).status_code, 403)
        body = self._as(self.finance).get(f"/api/claims/{claim.id}/pay-check").json()
        self.assertTrue(body["blocked"])
        self.assertEqual(body["problems"][0]["code"], "own_claim")

    def test_only_finance_and_super_admin_may_ask_the_pay_check(self):
        claim = self._authorised("SG-ACL")
        for who in (self.faculty, self.director, self.principal, self.cell):
            self.assertEqual(self._as(who).get(f"/api/claims/{claim.id}/pay-check").status_code, 403, who.role)


class AlreadyOnTheLedger(SgBase):
    """Risk: a ledger row with no claim that is the same paper, same person."""

    DOI = "10.1000/already-paid-1"

    def _claim_for_pay(self, ticket, **extra):
        return self._authorised(ticket, doi=self.DOI, paper_title="A Long Enough Title For An Exact Match", **extra)

    def _workbook_payment(self, staff="STF-CH1", doi=DOI, month="2025-03"):
        return PriorPayment.objects.create(
            faculty_name="Asha Faculty", employee_id=staff, paper_title="A Long Enough Title For An Exact Match",
            normalized_title="a long enough title for an exact match", doi=doi, amount_paid=400,
            claim_ref="ERP-OLD-1", raw_json='{"Month": "%s-01"}' % month,
        )

    def test_finance_is_stopped_and_told_when_the_same_person_was_paid_for_the_paper(self):
        claim = self._claim_for_pay("SG-HIST")
        self._workbook_payment()
        r = self.pay(self.finance, claim)
        self.assertEqual(r.status_code, 409, r.content)
        body = r.json()
        self.assertEqual(body["code"], "paid_before")
        self.assertIn("already on the payment ledger", body["detail"])
        self.assertIn("March 2025", body["detail"])
        self.assertEqual(claim.ledger_rows.count(), 0)
        # It says nothing about warnings or who set one aside.
        self.assertNotIn("warning", body["detail"].lower())
        check = self._as(self.finance).get(f"/api/claims/{claim.id}/pay-check").json()
        self.assertTrue(check["blocked"])

    def test_a_co_authors_payment_for_the_same_paper_does_not_stop_this_one(self):
        claim = self._claim_for_pay("SG-CO")
        self._workbook_payment(staff="STF-OTHER")
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)

    def test_it_may_go_ahead_only_when_the_warning_was_set_aside_and_a_second_person_agreed(self):
        claim = self._claim_for_pay("SG-OVR")
        self._workbook_payment()
        Claim.objects.filter(pk=claim.pk).update(duplicate_warning=True, override_duplicate=True,
                                                 override_by=self.cell, override_at=timezone.now(),
                                                 cleared_by=self.cell, second_approved_by=self.principal)
        claim.refresh_from_db()
        self.assertEqual(self.pay(self.finance, claim).status_code, 200)

    def test_another_paid_claim_of_the_same_person_for_the_paper_also_stops_it(self):
        claim = self._claim_for_pay("SG-TWIN")
        # The constraint is for filed claims; an imported twin is history.
        twin = self._claim(ClaimStatus.PAID, ticket="ERP-TWIN-1", doi=self.DOI, paper_title=claim.paper_title,
                           owner=self.faculty, status_note="old", payout_month=date(2025, 5, 1))
        r = self.pay(self.finance, claim)
        self.assertEqual((r.status_code, r.json()["code"]), (409, "paid_before"))


class HalfWrittenState(SgBase):
    def test_money_on_the_ledger_for_an_unpaid_claim_is_never_paid_on_top_of(self):
        claim = self._authorised("SG-HALF")
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=claim.remuneration)
        r = self.pay(self.finance, claim)
        self.assertEqual((r.status_code, r.json()["code"]), (400, "already_paid"))
        self.assertEqual(self.payments(claim).count(), 1)
