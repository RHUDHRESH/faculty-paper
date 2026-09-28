"""Budget "paid out" is what the ledger paid, not only what this app's claims paid.

The ledger holds every payment the college made before this system -- 2,963
rows with no claim behind them -- and the budget summed claims alone, so a
year of payouts read as a few lakh, or nothing.
"""
from __future__ import annotations

from datetime import date

from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, PaidLedger, Role, User


class BudgetFromLedgerTests(TestCase):
    def setUp(self):
        self.finance = User.objects.create_user(
            email="bud-fin@x.edu", password="p", name="Finance", role=Role.FINANCE
        )
        self.owner = User.objects.create_user(
            email="bud-o@x.edu", password="p", name="Owner", role=Role.FACULTY, department="ECE"
        )
        self.c = Client()
        self.c.force_login(self.finance)

    def status(self):
        r = self.c.get("/api/budgets?financial_year=2025-26")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        return body["college"], {d["department"]: d for d in body["departments"]}

    def test_historic_payments_count_towards_the_year(self):
        PaidLedger.objects.create(payout_month=date(2025, 5, 1), department="ECE", amount=21979, paper_title="P")
        PaidLedger.objects.create(payout_month=date(2025, 11, 1), department="MECH", amount=1000, paper_title="Q")
        PaidLedger.objects.create(payout_month=date(2024, 11, 1), department="ECE", amount=5000, paper_title="old")
        college, depts = self.status()
        self.assertEqual(college["spent"], 22979)
        self.assertEqual(depts["ECE"]["spent"], 21979)

    def test_a_paid_claim_is_counted_once_whether_or_not_it_has_its_ledger_row(self):
        with_row = Claim.objects.create(
            owner=self.owner, status=ClaimStatus.PAID, paper_title="A",
            remuneration=3000, payout_month=date(2025, 6, 1),
        )
        PaidLedger.objects.create(
            claim=with_row, payout_month=date(2025, 6, 1), department="ECE", amount=3000, paper_title="A"
        )
        Claim.objects.create(
            owner=self.owner, status=ClaimStatus.PAID, paper_title="B",
            remuneration=2000, payout_month=date(2025, 7, 1),
        )
        college, depts = self.status()
        self.assertEqual(college["spent"], 5000)
        self.assertEqual(depts["ECE"]["spent"], 5000)
