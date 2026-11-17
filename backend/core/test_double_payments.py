"""A paper paid twice to the same person is recorded and flagged, never hidden.

Every person, paper, file and amount here is made up in the test.
"""
from __future__ import annotations

import datetime as dt
import json

import openpyxl
from django.test import Client, TestCase

from core.models import AuditLog, ImportConflict, PaidLedger, PriorPayment, Role
from core.services import double_payments
from core.services import import_conflicts as svc
from core.services import top5
from core.services.settled_claims_import import import_settled_claims, read_settled_claims
from core.test_imports import AUG, SC_HEAD, SEP, mk, sc_row, save

JUL = dt.datetime(2026, 7, 1)


def book(*rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(SC_HEAD)
    for r in rows:
        ws.append(r)
    return save(wb)


def run(*rows, dry_run=False, actor=None):
    return import_settled_claims(read_settled_claims(book(*rows)), dry_run=dry_run, actor=actor)


class Base(TestCase):
    def setUp(self):
        self.p1 = mk("Person One", "p1@x.edu", staff_id="TS001", department="CSE")
        self.p2 = mk("Person Two", "p2@x.edu", staff_id="TS002", department="CSE")
        self.admin = mk("Super", "super@x.edu", role=Role.SUPER_ADMIN)

    def ledger(self, title="Twice Paper", staff="TS001"):
        return PaidLedger.objects.filter(staff_id=staff, paper_title__iexact=title)


class TwoPaymentsTests(Base):
    def test_two_money_rows_for_one_paper_are_both_written_and_flagged(self):
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["new"], r["counts"]["already_recorded"]), (2, 0))
        self.assertEqual(r["new_total_amount"], 1000.0)
        self.assertEqual(self.ledger().count(), 2)
        self.assertEqual(PriorPayment.objects.filter(paper_title="Twice Paper").count(), 2)
        d = r["double_payments"]
        self.assertEqual((d["count"], d["total_amount"]), (1, 1000.0))
        row = d["rows"][0]
        self.assertEqual((row["staff_id"], row["name"], row["title"], row["total"], row["count"]),
                         ("TS001", "Person TS001", "Twice Paper", 1000.0, 2))
        self.assertEqual([(p["month"], p["amount"]) for p in row["payments"]],
                         [("2026-08-01", 500.0), ("2026-09-01", 500.0)])
        c = ImportConflict.objects.get(kind="double_payment")
        self.assertEqual((c.status, c.payload["total"]), ("open", 1000.0))

    def test_the_same_month_and_amount_twice_is_still_two_payments(self):
        r = run(sc_row(SEP, 1, "TS001", "Twice Paper", 100), sc_row(SEP, 2, "TS001", "twice paper", 100), actor=self.p1)
        self.assertEqual(r["counts"]["new"], 2)
        self.assertEqual(self.ledger().count(), 2)
        self.assertEqual(r["double_payments"]["count"], 1)

    def test_rows_with_no_s_no_are_told_apart_by_month_person_paper_and_amount(self):
        a = sc_row(AUG, None, "TS001", "Twice Paper", 500)
        b = sc_row(SEP, None, "TS001", "Twice Paper", 500)
        r = run(a, b, actor=self.p1)
        self.assertEqual(r["counts"]["new"], 2)
        again = run(a, b, actor=self.p1)
        self.assertEqual((again["counts"]["new"], again["counts"]["already_recorded"]), (0, 2))
        self.assertEqual(self.ledger().count(), 2)

    def test_a_check_writes_nothing_and_lists_what_an_import_would_flag(self):
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 700), dry_run=True)
        self.assertEqual(r["counts"]["new"], 2)
        self.assertEqual((r["double_payments"]["count"], r["double_payments"]["rows"][0]["total"]), (1, 1200.0))
        self.assertEqual((PaidLedger.objects.count(), ImportConflict.objects.count()), (0, 0))

    def test_the_same_doi_under_two_spellings_of_the_title_is_one_paper(self):
        r = run(sc_row(AUG, 1, "TS001", "Doi Paper", 500, doi="10.1/x"),
                sc_row(SEP, 2, "TS001", "Doi Paper, revised", 500, doi="https://doi.org/10.1/X"), actor=self.p1)
        self.assertEqual(r["counts"]["new"], 2)
        self.assertEqual(r["double_payments"]["count"], 1)

    def test_a_different_person_with_the_same_paper_is_not_a_double_payment(self):
        r = run(sc_row(AUG, 1, "TS001", "Shared Paper", 500), sc_row(AUG, 2, "TS002", "Shared Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["new"], r["double_payments"]["count"]), (2, 0))

    def test_zero_amount_repeats_are_not_double_payments(self):
        r = run(sc_row(AUG, 1, "TS001", "Zero Paper", 0), sc_row(SEP, 2, "TS001", "Zero Paper", 0),
                sc_row(SEP, 3, "TS001", "One Pay", 400), sc_row(SEP, 4, "TS001", "One Pay", 0), actor=self.p1)
        self.assertEqual(r["double_payments"]["count"], 0)
        self.assertEqual(ImportConflict.objects.filter(kind="double_payment").count(), 0)
        # a paid paper with a zero repeat is one payment on the ledger
        self.assertEqual(self.ledger("One Pay").count(), 1)

    def test_a_second_run_writes_nothing_and_flags_nothing_new(self):
        rows = (sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500))
        run(*rows, actor=self.p1)
        counts = (PaidLedger.objects.count(), PriorPayment.objects.count(), ImportConflict.objects.count())
        again = run(*rows, actor=self.p1)
        self.assertEqual((again["counts"]["new"], again["counts"]["already_recorded"]), (0, 2))
        self.assertEqual(again["new_total_amount"], 0)
        self.assertEqual((PaidLedger.objects.count(), PriorPayment.objects.count(), ImportConflict.objects.count()), counts)
        # still told about it
        self.assertEqual(again["double_payments"]["count"], 1)

    def test_a_later_file_with_one_more_row_adds_only_that_row(self):
        run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500),
                sc_row(dt.datetime(2026, 10, 1), 3, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["new"], r["counts"]["already_recorded"]), (1, 2))
        self.assertEqual(self.ledger().count(), 3)
        c = ImportConflict.objects.get(kind="double_payment")
        self.assertEqual((c.payload["count"], c.payload["total"]), (3, 1500.0))

    def test_a_renumbered_file_does_not_pay_a_row_again(self):
        run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        r = run(sc_row(AUG, 41, "TS001", "Twice Paper", 500), sc_row(SEP, 42, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["new"], r["counts"]["already_recorded"]), (0, 2))
        self.assertEqual(self.ledger().count(), 2)


class OlderHistoryTests(Base):
    def old(self, month, amount, title="Twice Paper", staff="ts001"):
        return PaidLedger.objects.create(payout_month=month, staff_id=staff, faculty_name="Person One",
                                         paper_title=title, amount=amount)

    def test_an_older_ledger_row_answers_one_row_and_the_extra_one_is_new(self):
        self.old(dt.date(2026, 8, 1), 500)
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["already_recorded"], r["counts"]["new"]), (1, 1))
        self.assertEqual(self.ledger(staff="ts001").count() + self.ledger().count(), 2)
        self.assertEqual(PaidLedger.objects.filter(paper_title="Twice Paper").count(), 2)
        self.assertEqual(r["double_payments"]["count"], 1)
        self.assertEqual(r["new_total_amount"], 500.0)

    def test_the_same_month_answers_first_whatever_the_order_of_the_file(self):
        self.old(dt.date(2026, 9, 1), 500)
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["already_recorded"], r["counts"]["new"]), (1, 1))
        new = PaidLedger.objects.get(paper_title="Twice Paper", idempotency_key__isnull=False)
        self.assertEqual(new.payout_month, dt.date(2026, 8, 1))

    def test_then_the_same_amount(self):
        self.old(dt.date(2026, 1, 1), 700)
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 700), actor=self.p1)
        self.assertEqual((r["counts"]["already_recorded"], r["counts"]["new"], r["counts"]["amount_differs"]), (1, 1, 0))
        new = PaidLedger.objects.get(paper_title="Twice Paper", idempotency_key__isnull=False)
        self.assertEqual(new.amount, 500)

    def test_two_older_rows_answer_two_and_a_third_row_is_new(self):
        self.old(dt.date(2026, 7, 1), 500)
        self.old(dt.date(2026, 8, 1), 500)
        r = run(sc_row(JUL, 1, "TS001", "Twice Paper", 500), sc_row(AUG, 2, "TS001", "Twice Paper", 500),
                sc_row(SEP, 3, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["already_recorded"], r["counts"]["new"]), (2, 1))
        self.assertEqual(PaidLedger.objects.filter(paper_title="Twice Paper").count(), 3)

    def test_the_older_importers_own_rows_answer_one_row_each(self):
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="TS001", paper_title="Twice Paper", amount=500,
                                  idempotency_key="settled-import:TS001:0123456789abcdef0123:2026-08-01",
                                  raw_json='{"source": "settled_claims_import"}')
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["already_recorded"], r["counts"]["new"]), (1, 1))

    def test_a_prior_payment_alone_answers_one_row(self):
        PriorPayment.objects.create(employee_id="TS001", paper_title="Twice Paper", normalized_title="twice paper",
                                    amount_paid=500, paid_at=None, raw_json="{}")
        r = run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        self.assertEqual((r["counts"]["already_recorded"], r["counts"]["new"]), (1, 1))

    def test_a_paper_paid_twice_is_flagged_even_when_it_was_never_in_the_file(self):
        self.old(dt.date(2026, 7, 1), 500)
        self.old(dt.date(2026, 8, 1), 500)
        r = run(sc_row(SEP, 1, "TS001", "Another", 100), actor=self.p1)
        self.assertEqual(r["double_payments"]["count"], 1)

    def test_a_voided_payment_is_not_a_second_payment(self):
        from core.models import Claim, ClaimStatus

        claim = Claim.objects.create(owner=self.p1, status=ClaimStatus.PAID, paper_title="Twice Paper")
        PaidLedger.objects.create(payout_month=dt.date(2026, 7, 1), staff_id="TS001", paper_title="Twice Paper", amount=500,
                                  claim=claim, cycle=1)
        PaidLedger.objects.create(payout_month=dt.date(2026, 7, 1), staff_id="TS001", paper_title="Twice Paper", amount=-500,
                                  claim=claim, cycle=1, kind=PaidLedger.Kind.REVERSAL)
        self.old(dt.date(2026, 8, 1), 500)
        self.assertEqual(double_payments.find(), [])
        self.old(dt.date(2026, 9, 1), 500)
        self.assertEqual(len(double_payments.find()), 1)


class AmountDiffersTests(Base):
    def test_amount_differs_is_reported_as_before(self):
        PaidLedger.objects.create(payout_month=dt.date(2026, 8, 1), staff_id="TS001", paper_title="Beta Paper", amount=600)
        r = run(sc_row(AUG, 2, "TS001", "Beta Paper", 999), actor=self.p1)
        self.assertEqual((r["counts"]["amount_differs"], r["counts"]["new"]), (1, 0))
        self.assertEqual(r["amount_differs"][0]["ledger_amount"], 600)
        self.assertEqual(PaidLedger.objects.get(paper_title="Beta Paper").amount, 600)
        self.assertEqual(r["double_payments"]["count"], 0)

    def test_a_row_written_by_the_import_that_later_differs_is_reported_not_changed(self):
        run(sc_row(AUG, 1, "TS001", "Gamma", 500), actor=self.p1)
        r = run(sc_row(AUG, 1, "TS001", "Gamma", 650), actor=self.p1)
        self.assertEqual((r["counts"]["amount_differs"], r["counts"]["new"]), (1, 0))
        self.assertEqual(PaidLedger.objects.get(paper_title="Gamma").amount, 500)


class DecisionTests(Base):
    def setUp(self):
        super().setUp()
        run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        self.c = ImportConflict.objects.get(kind="double_payment")
        self.before = sorted(PaidLedger.objects.values_list("id", "amount"))

    def post(self, user, action, note="", expect=200):
        c = Client()
        c.force_login(user)
        r = c.post(f"/api/admin/conflicts/{self.c.id}/resolve", {"action": action, "note": note}, content_type="application/json")
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def test_it_is_listed_with_its_payments_and_both_choices(self):
        c = Client()
        c.force_login(self.admin)
        j = c.get("/api/admin/conflicts?kind=double_payment").json()
        self.assertEqual((j["counts"]["open"], j["counts"]["open_double_payment"]), (1, 1))
        row = j["rows"][0]
        self.assertEqual((row["kind"], row["actions"], row["total"], row["staff_id"]), ("double_payment", ["confirmed", "mark_error"], 1000.0, "TS001"))
        self.assertEqual([p["amount"] for p in row["payments"]], [500.0, 500.0])
        self.assertEqual(row["user_id"], self.p1.id)

    def test_confirmed_records_the_note_and_audit_and_changes_no_amount(self):
        j = self.post(self.admin, "confirmed", "Two different journals' fees")
        self.assertEqual((j["ok"], j["changed"]), (True, False))
        self.c.refresh_from_db()
        self.assertEqual((self.c.status, self.c.resolution, self.c.resolution_note, self.c.resolved_by_id),
                         ("resolved", "confirmed", "Two different journals' fees", self.admin.id))
        a = AuditLog.objects.get(action="IMPORT_CONFLICT_RESOLVE")
        d = json.loads(a.detail_json)
        self.assertEqual((d["action"], d["note"], d["total"]), ("confirmed", "Two different journals' fees", 1000.0))
        self.assertEqual(d["before"], d["after"])
        self.assertEqual(sorted(PaidLedger.objects.values_list("id", "amount")), self.before)

    def test_mark_error_needs_a_note_then_records_it_and_changes_no_amount(self):
        self.post(self.admin, "mark_error", "", expect=400)
        self.c.refresh_from_db()
        self.assertEqual(self.c.status, "open")
        self.post(self.admin, "mark_error", "Paid twice by mistake; recover the second")
        self.c.refresh_from_db()
        self.assertEqual((self.c.status, self.c.resolution), ("resolved", "mark_error"))
        self.assertEqual(svc.counts()["to_recover"], 1)
        self.assertEqual(sorted(PaidLedger.objects.values_list("id", "amount")), self.before)

    def test_pressing_it_again_does_nothing_and_the_other_choice_is_refused(self):
        self.post(self.admin, "confirmed")
        j = self.post(self.admin, "confirmed")
        self.assertFalse(j["changed"])
        self.assertEqual(AuditLog.objects.filter(action="IMPORT_CONFLICT_RESOLVE").count(), 1)
        self.post(self.admin, "mark_error", "x", expect=409)

    def test_a_ledger_that_changed_since_it_was_flagged_is_refused(self):
        PaidLedger.objects.filter(amount=500, payout_month=dt.date(2026, 9, 1)).delete()
        self.post(self.admin, "confirmed", expect=409)
        self.c.refresh_from_db()
        self.assertEqual(self.c.status, "open")

    def test_other_actions_are_not_for_this_kind_and_faculty_may_not_decide(self):
        self.post(self.admin, "update_ledger", "x", expect=400)
        self.post(self.p1, "confirmed", expect=403)

    def test_a_decided_one_reopens_when_a_third_payment_arrives(self):
        self.post(self.admin, "confirmed")
        run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500),
            sc_row(dt.datetime(2026, 10, 1), 3, "TS001", "Twice Paper", 500), actor=self.p1)
        self.c.refresh_from_db()
        self.assertEqual((self.c.status, self.c.payload["count"]), ("open", 3))

    def test_a_decided_one_stays_decided_when_the_file_is_imported_again(self):
        self.post(self.admin, "confirmed")
        run(sc_row(AUG, 1, "TS001", "Twice Paper", 500), sc_row(SEP, 2, "TS001", "Twice Paper", 500), actor=self.p1)
        self.c.refresh_from_db()
        self.assertEqual(self.c.status, "resolved")


class ReportsShowBothTests(Base):
    def setUp(self):
        super().setUp()
        run(sc_row(AUG, 1, "TS001", "Twice Paper", 500, doi=None), sc_row(SEP, 2, "TS001", "Twice Paper", 700),
            sc_row(SEP, 3, "TS001", "Once Paper", 100), actor=self.p1)

    def test_the_payments_list_has_both_rows(self):
        self.assertEqual(sorted(self.ledger().values_list("amount", flat=True)), [500, 700])

    def test_top_five_counts_the_paper_once_and_the_money_twice(self):
        everyone = top5.people(dt.date(2026, 11, 17))
        me = next(p for p in everyone if p["user_id"] == self.p1.id)
        self.assertEqual(me["count"], 2)               # Twice Paper, Once Paper
        self.assertEqual(me["remuneration"], 1300.0)    # 500 + 700 + 100
        self.assertEqual(me["paid_more_than_once"], 1)

    def test_my_payments_marks_the_repeat(self):
        c = Client()
        c.force_login(self.p1)
        j = c.get("/api/me/payments").json()
        self.assertEqual(j["total"], 1300.0)
        flags = {(r["paper_title"], r["amount"]): r["paid_again"] for r in j["rows"]}
        self.assertEqual(flags, {("Twice Paper", 500.0): True, ("Twice Paper", 700.0): True, ("Once Paper", 100.0): False})


# ------------------------------------------------ what the college sheet says was paid


def paid_claim(owner, title, remuneration=0.0, *, ledger=None, month=dt.date(2026, 9, 1), ticket="FP-2026-000001", snip=None):
    from core.models import Claim, ClaimStatus

    claim = Claim.objects.create(owner=owner, status=ClaimStatus.PAID, paper_title=title, remuneration=remuneration,
                                 ticket_number=ticket, payout_month=month, snip=snip)
    if ledger is not None:
        PaidLedger.objects.create(claim=claim, kind="PAYMENT", cycle=1, payout_month=month, staff_id=owner.staff_id,
                                  faculty_name=owner.name, paper_title=title, amount=ledger)
    return claim


class ClaimAtZeroTests(Base):
    def test_a_claim_paid_at_zero_gets_the_sheets_payment_as_its_own(self):
        claim = paid_claim(self.p1, "Claimed Paper", 0, ledger=0)
        r = run(sc_row(JUL, 1, "TS001", "Claimed Paper", 800, name="Person One"), actor=self.admin)
        self.assertEqual((r["counts"]["claim_at_zero"], r["counts"]["new"], r["counts"]["already_recorded"]), (1, 0, 0))
        self.assertEqual(r["new_total_amount"], 800.0)
        out = r["claim_payments_from_sheet"]
        self.assertEqual((out["count"], out["total_amount"]), (1, 800.0))
        self.assertEqual((out["rows"][0]["ticket"], out["rows"][0]["staff_id"], out["rows"][0]["amount"]),
                         ("FP-2026-000001", "TS001", 800.0))
        rows = PaidLedger.objects.filter(claim=claim).order_by("payout_month")
        self.assertEqual([(x.kind, x.cycle, x.amount, x.payout_month) for x in rows],
                         [("ADJUSTMENT", 1, 800.0, dt.date(2026, 7, 1)), ("PAYMENT", 1, 0.0, dt.date(2026, 9, 1))])
        # a second run adds nothing
        again = run(sc_row(JUL, 1, "TS001", "Claimed Paper", 800, name="Person One"), actor=self.admin)
        self.assertEqual((again["counts"]["claim_at_zero"], again["counts"]["already_recorded"]), (0, 1))
        self.assertEqual(PaidLedger.objects.filter(claim=claim).count(), 2)

    def test_a_claim_paid_with_nothing_on_the_ledger_gets_a_payment_row(self):
        claim = paid_claim(self.p1, "Claimed Paper", 0, ledger=None)
        run(sc_row(JUL, 1, "TS001", "Claimed Paper", 800), actor=self.admin)
        row = PaidLedger.objects.get(claim=claim)
        self.assertEqual((row.kind, row.amount, row.cycle), ("PAYMENT", 800.0, 1))

    def test_the_top_five_counts_the_sheets_money_and_snip_for_it(self):
        claim = paid_claim(self.p1, "Claimed Paper", 0, ledger=0)
        row = sc_row(JUL, 1, "TS001", "Claimed Paper", 800)
        row[10] = 0.672  # SNIP Value
        run(row, actor=self.admin)
        me = next(p for p in top5.people(dt.date(2026, 11, 17)) if p["user_id"] == self.p1.id)
        self.assertEqual((me["count"], me["remuneration"], me["snip"]), (1, 800.0, 0.67))
        self.assertTrue(claim.pk)

    def test_a_claim_with_a_real_payment_is_never_paid_twice(self):
        claim = paid_claim(self.p1, "Claimed Paper", 800, ledger=800)
        r = run(sc_row(JUL, 1, "TS001", "Claimed Paper", 800), actor=self.admin)
        self.assertEqual((r["counts"]["already_recorded"], r["counts"]["claim_at_zero"], r["counts"]["new"]), (1, 0, 0))
        self.assertEqual(PaidLedger.objects.filter(claim=claim).count(), 1)

    def test_a_second_sheet_row_for_the_paper_is_a_further_payment(self):
        paid_claim(self.p1, "Claimed Paper", 0, ledger=0)
        r = run(sc_row(JUL, 1, "TS001", "Claimed Paper", 800), sc_row(AUG, 2, "TS001", "Claimed Paper", 800), actor=self.admin)
        self.assertEqual((r["counts"]["claim_at_zero"], r["counts"]["new"]), (1, 1))
        self.assertEqual(r["double_payments"]["count"], 1)


class PerPersonTests(Base):
    def test_a_co_authors_claim_never_answers_the_other_authors_row(self):
        paid_claim(self.p2, "Shared Paper", 900, ledger=900)
        r = run(sc_row(JUL, 1, "TS001", "Shared Paper", 700, doi="10.1/shared"), actor=self.admin)
        self.assertEqual((r["counts"]["new"], r["counts"]["already_recorded"]), (1, 0))
        row = PaidLedger.objects.get(staff_id="TS001", paper_title="Shared Paper")
        self.assertEqual(row.amount, 700)

    def test_a_ledger_row_with_no_person_does_not_answer_a_named_person_by_doi(self):
        PaidLedger.objects.create(payout_month=dt.date(2026, 7, 1), paper_title="Shared Paper", amount=900,
                                  raw_json='{"DOI": "10.1/shared"}')
        r = run(sc_row(JUL, 1, "TS001", "A Different Spelling", 700, doi="10.1/shared"), actor=self.admin)
        self.assertEqual((r["counts"]["new"], r["counts"]["already_recorded"]), (1, 0))


class BlankAmountTests(Base):
    def test_a_blank_amount_is_a_settled_paper_at_nothing_and_is_listed(self):
        r = run(sc_row(JUL, 1, "TS001", "Blank Paper", None), sc_row(JUL, 2, "TS001", "Text Paper", "N/A"), actor=self.admin)
        self.assertEqual(r["blank_amounts"]["count"], 2)
        self.assertEqual(r["blank_amounts"]["rows"][0]["staff_id"], "TS001")
        self.assertEqual(sorted(PaidLedger.objects.values_list("paper_title", "amount")), [("Blank Paper", 0), ("Text Paper", 0)])
        me = next(p for p in top5.people(dt.date(2026, 11, 17)) if p["user_id"] == self.p1.id)
        self.assertEqual((me["count"], me["remuneration"]), (2, 0))
        again = run(sc_row(JUL, 1, "TS001", "Blank Paper", None), sc_row(JUL, 2, "TS001", "Text Paper", "N/A"), actor=self.admin)
        self.assertEqual(again["counts"]["new"], 0)
        self.assertEqual(PaidLedger.objects.count(), 2)


class NotInTheSheetTests(Base):
    def test_a_paid_claim_with_money_the_sheet_leaves_out_is_listed_and_nothing_changes(self):
        paid_claim(self.p1, "Left Out Paper", 500, ledger=500, ticket="FP-2026-000009", month=dt.date(2026, 7, 1))
        paid_claim(self.p1, "Listed Paper", 500, ledger=500, ticket="FP-2026-000010", month=dt.date(2026, 7, 1))
        paid_claim(self.p1, "Later Paper", 500, ledger=500, ticket="FP-2026-000011", month=dt.date(2026, 12, 1))
        paid_claim(self.p1, "Zero Paper", 0, ledger=0, ticket="FP-2026-000012", month=dt.date(2026, 7, 1))
        before = PaidLedger.objects.count()
        r = run(sc_row(JUL, 1, "TS001", "Listed Paper", 500), sc_row(JUL, 2, "TS002", "Left Out Paper", 500), actor=self.admin)
        n = r["paid_in_app_not_in_sheet"]
        # the one with money, and the one paid at nothing: both are for the office to look at
        self.assertEqual((n["count"], n["total_amount"]), (2, 500.0))
        self.assertEqual([(x["ticket"], x["listed_under"]) for x in n["rows"]],
                         [("FP-2026-000009", ["TS002"]), ("FP-2026-000012", [])])
        self.assertEqual(PaidLedger.objects.count(), before + 1)  # only TS002's own row


class ClaimSnipTests(Base):
    def test_a_claim_paid_through_the_ledger_keeps_its_own_snip_in_the_top_five(self):
        paid_claim(self.p1, "Claimed Paper", 800, ledger=800, snip=0.206)
        me = next(p for p in top5.people(dt.date(2026, 11, 17)) if p["user_id"] == self.p1.id)
        self.assertEqual((me["count"], me["snip"]), (1, 0.21))


class BlankKeptOnlyAsANoteTests(Base):
    def test_a_blank_amount_an_earlier_import_kept_only_as_a_note_is_recorded_now(self):
        PriorPayment.objects.create(employee_id="TS001", paper_title="Blank Paper", normalized_title="blank paper",
                                    amount_paid=None, raw_json='{"source": "settled_claims_import"}')
        r = run(sc_row(JUL, 1, "TS001", "Blank Paper", None), actor=self.admin)
        self.assertEqual(r["blank_amounts"]["count"], 1)
        self.assertEqual(PaidLedger.objects.get(paper_title="Blank Paper").amount, 0)
        self.assertEqual(PriorPayment.objects.filter(paper_title="Blank Paper").count(), 1)


class BulkImportMonthTests(Base):
    """The old bulk ERP import stamped its claims September; the sheet says when they were paid."""

    def standing(self, period, month=None):
        from core.services.aggregate_cache import bump

        bump()
        rec = top5.record()
        sp = top5.span(period, dt.date(2026, 11, 17), month=month, latest=rec.latest)
        return {p["user_id"]: p for p in top5.cards(rec, sp)}.get(self.p1.id)

    def test_a_bulk_imported_claim_takes_the_sheets_month(self):
        claim = paid_claim(self.p1, "Bulk Paper", 800, ledger=800, ticket="ERP-PROCESSED-12", month=dt.date(2026, 9, 1))
        self.assertEqual(self.standing("month", "2026-09")["remuneration"], 800)
        r = run(sc_row(JUL, 1, "TS001", "Bulk Paper", 800), actor=self.admin)
        out = r["payment_months_corrected"]
        self.assertEqual(out["count"], 1)
        self.assertEqual((out["rows"][0]["ticket"], out["rows"][0]["from_month"], out["rows"][0]["to_month"]),
                         ("ERP-PROCESSED-12", "2026-09-01", "2026-07-01"))
        claim.refresh_from_db()
        self.assertEqual(claim.payout_month, dt.date(2026, 7, 1))
        from django.utils import timezone
        self.assertEqual(timezone.localtime(claim.paid_at).date(), dt.date(2026, 7, 1))
        row = PaidLedger.objects.get(claim=claim)
        self.assertEqual((row.payout_month, row.amount), (dt.date(2026, 7, 1), 800))
        self.assertEqual(json.loads(row.raw_json)["month_history"][0]["from"], "2026-09-01")
        log = json.loads(AuditLog.objects.get(action="CLAIM_PAID_MONTH_CORRECTED").detail_json)
        self.assertEqual((log["before"]["payout_month"], log["after"]["payout_month"]), ("2026-09-01", "2026-07-01"))
        # the boards read the payout month, so September no longer holds it and July does
        self.assertIsNone(self.standing("month", "2026-09"))
        self.assertEqual(self.standing("month", "2026-07")["remuneration"], 800)
        self.assertEqual(self.standing("all")["remuneration"], 800)

    def test_a_claim_paid_through_the_app_is_never_touched(self):
        claim = paid_claim(self.p1, "Live Paper", 800, ledger=800, ticket="FP-2026-000044", month=dt.date(2026, 9, 1))
        r = run(sc_row(JUL, 1, "TS001", "Live Paper", 800), actor=self.admin)
        self.assertEqual(r["payment_months_corrected"]["count"], 0)
        claim.refresh_from_db()
        self.assertEqual(claim.payout_month, dt.date(2026, 9, 1))
        self.assertEqual(PaidLedger.objects.get(claim=claim).payout_month, dt.date(2026, 9, 1))
        self.assertFalse(AuditLog.objects.filter(action="CLAIM_PAID_MONTH_CORRECTED").exists())

    def test_a_check_lists_the_correction_and_writes_nothing(self):
        claim = paid_claim(self.p1, "Bulk Paper", 800, ledger=800, ticket="ERP-PROCESSED-12")
        r = run(sc_row(JUL, 1, "TS001", "Bulk Paper", 800), dry_run=True)
        self.assertEqual(r["payment_months_corrected"]["count"], 1)
        claim.refresh_from_db()
        self.assertEqual(claim.payout_month, dt.date(2026, 9, 1))

    def test_the_sheets_payment_for_a_bulk_claim_at_nothing_lands_in_the_sheets_month(self):
        claim = paid_claim(self.p1, "Bulk Paper", 0, ledger=0, ticket="ERP-PROCESSED-12")
        run(sc_row(JUL, 1, "TS001", "Bulk Paper", 800), actor=self.admin)
        self.assertEqual(sorted(PaidLedger.objects.filter(claim=claim).values_list("payout_month", "amount")),
                         [(dt.date(2026, 7, 1), 0.0), (dt.date(2026, 7, 1), 800.0)])
        self.assertEqual(self.standing("month", "2026-07")["remuneration"], 800)
        self.assertIsNone(self.standing("month", "2026-09"))

    def test_running_it_again_changes_nothing(self):
        claim = paid_claim(self.p1, "Bulk Paper", 800, ledger=800, ticket="ERP-PROCESSED-12")
        run(sc_row(JUL, 1, "TS001", "Bulk Paper", 800), actor=self.admin)
        again = run(sc_row(JUL, 1, "TS001", "Bulk Paper", 800), actor=self.admin)
        self.assertEqual(again["payment_months_corrected"]["count"], 0)
        self.assertEqual((again["counts"]["already_recorded"], again["counts"]["new"]), (1, 0))
        self.assertEqual(AuditLog.objects.filter(action="CLAIM_PAID_MONTH_CORRECTED").count(), 1)
        self.assertEqual(PaidLedger.objects.filter(claim=claim).count(), 1)

    def test_a_bulk_claim_beside_the_older_ledger_history_of_the_same_paper_moves_too(self):
        claim = paid_claim(self.p1, "Bulk Paper", 0, ledger=0, ticket="ERP-PROCESSED-12")
        PaidLedger.objects.create(payout_month=dt.date(2026, 7, 1), staff_id="TS001", paper_title="Bulk Paper", amount=800)
        r = run(sc_row(JUL, 1, "TS001", "Bulk Paper", 800), actor=self.admin)
        self.assertEqual((r["counts"]["already_recorded"], r["payment_months_corrected"]["count"]), (1, 1))
        claim.refresh_from_db()
        self.assertEqual(claim.payout_month, dt.date(2026, 7, 1))
        self.assertIsNone(self.standing("month", "2026-09"))
        self.assertEqual(self.standing("month", "2026-07")["count"], 1)
