"""A person's payments come from the ledger, historic rows included."""
from datetime import date

from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.api.my_payments import academic_year_start


class MyPaymentsTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="me@x.edu", password="p", name="Me", role=Role.FACULTY, staff_id="TSEC001"
        )
        self.other = User.objects.create_user(
            email="o@x.edu", password="p", name="Other", role=Role.FACULTY, staff_id="TSEC002"
        )
        self.c = Client()
        self.c.force_login(self.me)

    def _row(self, amount, month, staff_id=None, claim=None):
        return PaidLedger.objects.create(
            payout_month=month, staff_id=staff_id, amount=amount, paper_title="P", claim=claim
        )

    def test_historic_rows_match_by_staff_id_and_own_claims_count(self):
        claim = Claim.objects.create(owner=self.me, status=ClaimStatus.PAID, paper_title="Mine")
        self._row(10000, date(2024, 3, 1), staff_id="tsec001")  # case differs
        self._row(5000, date(2025, 1, 1), claim=claim)
        self._row(7000, date(2024, 3, 1), staff_id="TSEC002")  # somebody else
        other_claim = Claim.objects.create(owner=self.other, status=ClaimStatus.PAID, paper_title="X")
        self._row(9000, date(2024, 3, 1), staff_id="TSEC001", claim=other_claim)  # claim wins
        self._row(0, date(2024, 3, 1), staff_id="TSEC001")  # count-only row
        body = self.c.get("/api/me/payments").json()
        self.assertEqual(body["total"], 15000)
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["latest_month"], "2025-01")

    def test_this_year_starts_on_1_june(self):
        self.assertEqual(academic_year_start(date(2026, 5, 31)), date(2025, 6, 1))
        self.assertEqual(academic_year_start(date(2026, 6, 1)), date(2026, 6, 1))

    def test_no_staff_id_sees_only_own_claims(self):
        self.me.staff_id = None
        self.me.save()
        self._row(10000, date(2024, 3, 1), staff_id=None)
        self.assertEqual(self.c.get("/api/me/payments").json()["total"], 0)


class CollegeLedgerTotalTests(TestCase):
    def test_office_roles_get_the_ledger_total_and_faculty_do_not(self):
        PaidLedger.objects.create(payout_month=date(2024, 1, 1), amount=1000, paper_title="P")
        PaidLedger.objects.create(payout_month=date(2025, 2, 1), amount=500, paper_title="Q")
        principal = User.objects.create_user(email="pr@x.edu", password="p", name="Pr", role=Role.PRINCIPAL)
        faculty = User.objects.create_user(email="f@x.edu", password="p", name="F", role=Role.FACULTY)
        c = Client()
        c.force_login(principal)
        body = c.get("/api/dashboard").json()
        self.assertEqual(body["ledger_total"], 1500)
        self.assertEqual(body["ledger_since"], "2024-01")
        c.force_login(faculty)
        self.assertNotIn("ledger_total", c.get("/api/dashboard").json())


class PaymentStatementTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="s@x.edu", password="p", name="Stmt", role=Role.FACULTY, staff_id="TSEC009"
        )
        self.c = Client()
        self.c.force_login(self.me)
        for amt, m in [(1000, date(2024, 3, 1)), (2000, date(2024, 4, 1)), (3000, date(2025, 3, 1))]:
            PaidLedger.objects.create(payout_month=m, staff_id="TSEC009", amount=amt, paper_title="P")
        PaidLedger.objects.create(payout_month=date(2024, 5, 1), staff_id="OTHER", amount=99, paper_title="X")

    def test_financial_year_runs_april_to_march(self):
        from core.api.my_payments import financial_year_of
        self.assertEqual(financial_year_of(date(2025, 3, 31)), 2024)
        self.assertEqual(financial_year_of(date(2025, 4, 1)), 2025)

    def test_years_and_filter(self):
        body = self.c.get("/api/me/payments/statement").json()
        self.assertEqual([(y["label"], y["total"]) for y in body["years"]], [("2024-25", 5000), ("2023-24", 1000)])
        body = self.c.get("/api/me/payments/statement?fy=2024").json()
        self.assertEqual(body["total"], 5000)
        self.assertEqual(body["count"], 2)

    def test_csv_download(self):
        r = self.c.get("/api/me/payments/statement?fy=2024&format=csv")
        self.assertEqual(r["Content-Type"], "text/csv")
        self.assertIn("payment-statement-2024-25.csv", r["Content-Disposition"])
        text = r.content.decode()
        self.assertIn("Total,,,,,5000", text)
        self.assertNotIn(",99", text)

    def test_needs_sign_in(self):
        self.assertIn(Client().get("/api/me/payments/statement").status_code, (401, 403))
