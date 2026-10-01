"""Whole-queue figures for the Director and Finance desks, and the ledger position of each row."""
from django.test import TestCase
from django.utils import timezone

from core.models import Claim, ClaimStatus, FormulaConfig, PaidLedger, Role, User


class PaymentsDeskTests(TestCase):
    def setUp(self):
        self.fin = User.objects.create_user(email="pd-fin@t.edu", password="p", name="Fin", role=Role.FINANCE)
        self.dir = User.objects.create_user(email="pd-dir@t.edu", password="p", name="Dir", role=Role.DIRECTOR)
        self.fac = User.objects.create_user(email="pd-fac@t.edu", password="p", name="Asha", role=Role.FACULTY,
                                            department="CSE", staff_id="S1")
        FormulaConfig.objects.create(version=1, active=True, high_value_threshold=50000)
        now = timezone.now()

        def claim(no, amount, absorbed=0.0, status=ClaimStatus.DIRECTOR_APPROVED, **kw):
            return Claim.objects.create(
                owner=self.fac, status=status, remuneration=amount, research_absorbed=absorbed,
                ticket_number=no, paper_title=f"Paper {no}", director_approved_at=now,
                principal_approved_at=now, **kw)

        self.ready = claim("FP-1", 20000)
        self.research = claim("FP-2", 7600, absorbed=10000)
        self.inside = claim("FP-3", 0, absorbed=15620)
        self.big = claim("FP-4", 75000)
        self.waiting = claim("FP-5", 9000, status=ClaimStatus.PRINCIPAL_APPROVED)

    def test_payable_totals_cover_the_whole_queue(self):
        self.client.force_login(self.fin)
        body = self.client.get("/api/admin/payouts", {"status": "DIRECTOR_APPROVED", "limit": 1}).json()
        t = body["totals"]
        self.assertEqual(body["total"], 4)
        self.assertEqual(len(body["results"]), 1)  # a page of one, a total of four
        self.assertEqual(t["count"], 4)
        self.assertEqual(t["amount"], 20000 + 7600 + 0 + 75000)
        self.assertEqual((t["ready_count"], t["ready_amount"]), (3, 27600))
        self.assertEqual((t["held_count"], t["held_amount"]), (1, 75000))
        self.assertEqual(t["zero_count"], 1)
        self.assertEqual((t["held_back_count"], t["held_back"]), (2, 25620))

    def test_each_row_says_what_the_ledger_holds(self):
        PaidLedger.objects.create(claim=self.ready, payout_month=timezone.now().date().replace(day=1), amount=20000)
        self.client.force_login(self.fin)
        rows = {r["ticket_number"]: r for r in self.client.get(
            "/api/admin/payouts", {"status": "DIRECTOR_APPROVED"}).json()["results"]}
        self.assertEqual(rows["FP-1"]["ledger_paid"], 20000)
        self.assertEqual(rows["FP-1"]["ledger_rows"], 1)
        self.assertEqual(rows["FP-2"]["ledger_paid"], 0)

    def test_paid_history_has_its_own_totals(self):
        Claim.objects.filter(pk=self.ready.pk).update(status=ClaimStatus.PAID)
        self.client.force_login(self.fin)
        body = self.client.get("/api/admin/payouts", {"status": "PAID"}).json()
        self.assertEqual(body["totals"], {"count": 1, "amount": 20000.0})

    def test_director_queue_says_what_the_threshold_holds_back(self):
        Claim.objects.filter(pk=self.waiting.pk).update(research_absorbed=4000)
        self.client.force_login(self.dir)
        t = self.client.get("/api/director/queue").json()["totals"]
        self.assertEqual((t["held_back_count"], t["held_back"]), (1, 4000))
        self.assertEqual(t["count"], 1)

    def test_statement_rows_say_what_the_threshold_held_back(self):
        month = timezone.now().date().replace(day=1)
        Claim.objects.filter(pk=self.research.pk).update(status=ClaimStatus.PAID, payout_month=month)
        PaidLedger.objects.create(claim=self.research, payout_month=month, amount=7600, staff_id="S1")
        self.client.force_login(self.fin)
        st = self.client.get("/api/payouts/statement", {"month": month.strftime("%Y-%m")}).json()
        row = next(r for r in st["rows"] if r["claim_id"] == self.research.pk)
        self.assertEqual(row["held_back"], 10000)

    def test_ledger_rows_say_what_the_threshold_held_back(self):
        month = timezone.now().date().replace(day=1)
        PaidLedger.objects.create(claim=self.research, payout_month=month, amount=7600, staff_id="S1")
        PaidLedger.objects.create(claim=self.ready, payout_month=month, amount=20000, staff_id="S1")
        self.client.force_login(self.fin)
        rows = {r["claim_id"]: r for r in self.client.get("/api/admin/ledger").json()["results"]}
        self.assertEqual(rows[self.research.pk]["held_back"], 10000)
        self.assertEqual(rows[self.ready.pk]["held_back"], 0)

    def test_director_and_finance_still_see_no_flag(self):
        Claim.objects.filter(pk=self.ready.pk).update(duplicate_warning=True, contest_note="SECRET-FLAG")
        for who in (self.fin, self.dir):
            self.client.force_login(who)
            path = "/api/admin/payouts?status=DIRECTOR_APPROVED" if who is self.fin else "/api/director/queue"
            self.assertNotIn("SECRET-FLAG", self.client.get(path).content.decode())
