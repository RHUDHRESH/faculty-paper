"""Monthly payout statement: totals from the ledger, reconciliation, files, access, no flags."""
from datetime import date

from django.test import TestCase
from django.utils import timezone

from core.models import Budget, Claim, ClaimFlag, ClaimStatus, PaidLedger, Role, User
from core.services import college_totals
from core.services.payout_statement import inr, rupees_in_words


class WordsAndFiguresTests(TestCase):
    def test_indian_grouping(self):
        self.assertEqual(inr(315370), "₹3,15,370")
        self.assertEqual(inr(12345678.5), "₹1,23,45,678.50")
        self.assertEqual(inr(999), "₹999")
        self.assertEqual(inr(-3000), "-₹3,000")

    def test_words(self):
        self.assertEqual(rupees_in_words(315370),
                         "Rupees Three Lakh Fifteen Thousand Three Hundred Seventy only")
        self.assertEqual(rupees_in_words(12500000), "Rupees One Crore Twenty Five Lakh only")
        self.assertEqual(rupees_in_words(0), "Rupees Zero only")
        self.assertEqual(rupees_in_words(1001.5), "Rupees One Thousand One and Fifty Paise only")


class StatementTests(TestCase):
    def setUp(self):
        self.fin = User.objects.create_user(email="ps-fin@t.edu", password="p", name="Fin Officer",
                                            role=Role.FINANCE)
        self.dir = User.objects.create_user(email="ps-dir@t.edu", password="p", name="Dir",
                                            role=Role.DIRECTOR)
        self.fac = User.objects.create_user(email="ps-fac@t.edu", password="p", name="Priya Raman",
                                            role=Role.FACULTY, department="CSE", staff_id="S1")
        aug = date(2026, 8, 1)
        now = timezone.now()
        self.paid = Claim.objects.create(owner=self.fac, status=ClaimStatus.PAID, remuneration=40000,
                                         payout_month=aug, ticket_number="FP-2026-000001",
                                         paper_title="Nets", director_approved_at=now, paid_at=now,
                                         duplicate_warning=True, contest_note="SECRET-FLAG")
        ClaimFlag.objects.create(claim=self.paid, kind="DUPLICATE", note="SECRET-FLAG")
        PaidLedger.objects.create(claim=self.paid, payout_month=aug, amount=40000, department="CSE",
                                  faculty_name="Priya Raman", staff_id="S1", voucher_number="V1")
        # An ERP import row and a reversal pair for a voided ticket.
        PaidLedger.objects.create(payout_month=aug, amount=15000, department="ECE",
                                  faculty_name="Arun K", staff_id="S2", raw_json='{"Month": "Aug 2026"}')
        voided = Claim.objects.create(owner=self.fac, status=ClaimStatus.DIRECTOR_APPROVED,
                                      remuneration=9000, payout_month=aug, ticket_number="FP-2026-000002")
        PaidLedger.objects.create(claim=voided, payout_month=aug, amount=9000, department="CSE")
        PaidLedger.objects.create(claim=voided, payout_month=aug, amount=-9000, department="CSE")
        # A paid ticket with no ledger row at all.
        Claim.objects.create(owner=self.fac, status=ClaimStatus.PAID, remuneration=5000,
                             payout_month=aug, ticket_number="FP-2026-000003")
        # Another month, which must not leak into August.
        PaidLedger.objects.create(payout_month=date(2026, 7, 1), amount=7000, department="CSE")
        Budget.objects.create(financial_year="2026-27", amount=1000000)

    def test_total_is_the_ledgers_figure(self):
        self.client.force_login(self.fin)
        st = self.client.get("/api/payouts/statement", {"month": "2026-08"}).json()
        expected = sum(p["amount"] for p in college_totals.payments(month="2026-08"))
        self.assertEqual(st["total"], expected)
        self.assertEqual(st["total"], 40000 + 15000 + 5000)
        self.assertEqual(st["ledger_total"], st["total"])
        # Counted the way Reports counts payments: the void's reversing row
        # cancels the payment it reverses (40,000 + 15,000 + 5,000 = three).
        self.assertEqual(st["count"], 3)
        dept = {d["department"]: d["amount"] for d in st["by_department"]}
        self.assertEqual(dept, {"CSE": 45000, "ECE": 15000})

    def test_a_zero_rupee_quota_paper_is_not_a_payment(self):
        """Settled at ₹0 inside a research quota: on the statement's list, but
        not a payment -- the bank file leaves it out and Reports does not count
        it, so the headline must not either."""
        quota = User.objects.create_user(email="ps-q@t.edu", password="p", name="Quota Person",
                                         role=Role.FACULTY, department="CSE", staff_id="S9")
        z = Claim.objects.create(owner=quota, status=ClaimStatus.PAID, remuneration=0,
                                 payout_month=date(2026, 8, 1), ticket_number="FP-2026-000009")
        PaidLedger.objects.create(claim=z, payout_month=date(2026, 8, 1), amount=0, department="CSE",
                                  faculty_name="Quota Person", staff_id="S9", voucher_number="V9")
        self.client.force_login(self.fin)
        st = self.client.get("/api/payouts/statement", {"month": "2026-08"}).json()
        reports = self.client.get("/api/reports", {"month": "2026-08"}).json()
        self.assertEqual(st["count"], reports["totals"]["paid_claims"])
        self.assertNotIn("FP-2026-000009", self.client.get(
            "/api/payouts/statement.csv", {"month": "2026-08"}).content.decode())
        # Nobody was paid anything, so they are not one of the people paid.
        self.assertEqual(st["people"], 2)
        self.assertIn("FP-2026-000009", [r["ticket"] for r in st["rows"]])

    def test_reconciliation(self):
        self.client.force_login(self.dir)
        rec = self.client.get("/api/payouts/statement", {"month": "2026-08"}).json()["reconciliation"]
        self.assertEqual(rec["matched"], 1)
        self.assertEqual(rec["imported"], {"count": 1, "amount": 15000})
        self.assertEqual(rec["reversals"], {"count": 1, "amount": -9000})
        self.assertFalse(rec["balanced"])
        self.assertEqual([i["ticket"] for i in rec["issues"]], ["FP-2026-000003"])

    def test_no_flag_reaches_director_or_finance(self):
        for u in (self.fin, self.dir):
            self.client.force_login(u)
            for path in ("/api/payouts/statement", "/api/payouts/statement.csv"):
                body = self.client.get(path, {"month": "2026-08"}).content.decode("utf-8")
                self.assertNotIn("SECRET-FLAG", body)
                self.assertNotIn("duplicate", body.lower())

    def test_bank_csv_and_pdf(self):
        self.client.force_login(self.fin)
        r = self.client.get("/api/payouts/statement.csv", {"month": "2026-08"})
        self.assertEqual(r.status_code, 200)
        lines = r.content.decode("utf-8-sig").strip().splitlines()
        self.assertTrue(lines[0].startswith("Sl No,Payment type,Beneficiary name"))
        self.assertEqual(len([l for l in lines[1:] if l and l[0].isdigit()]), 3)  # voided pair left out
        self.assertIn("60000.00", lines[-1])
        self.assertIn("Research incentive August 2026 FP-2026-000001", r.content.decode("utf-8"))
        p = self.client.get("/api/payouts/statement.pdf", {"month": "2026-08"})
        self.assertEqual(p.status_code, 200)
        self.assertTrue(p.content.startswith(b"%PDF"))

    def test_months_and_financial_year(self):
        self.client.force_login(self.fin)
        months = {m["month"]: m["amount"] for m in self.client.get("/api/payouts/months").json()["months"]}
        self.assertEqual(months["2026-08"], 60000)
        self.assertEqual(months["2026-07"], 7000)
        fy = self.client.get("/api/payouts/financial-year", {"financial_year": "2026-27"}).json()
        self.assertEqual(fy["allocation"], 1000000)
        self.assertEqual(fy["paid"], 67000)
        self.assertEqual(fy["months"][0]["month"], "2026-04")
        self.assertEqual(fy["months"][4]["cumulative"], 67000)
        self.assertEqual(fy["committed"], 9000)

    def test_access(self):
        self.client.force_login(self.fac)
        self.assertEqual(self.client.get("/api/payouts/statement", {"month": "2026-08"}).status_code, 403)
        self.client.force_login(self.fin)
        self.assertEqual(self.client.get("/api/payouts/statement", {"month": "08-2026"}).status_code, 400)
