"""/reports counts money from the ledger and papers from the publication record."""
from __future__ import annotations

from datetime import date

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, PaidLedger, Publication, Role, User


class ReportsFromTheRecordTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            email="rl-admin@test.edu", password="p", name="Admin", role=Role.SUPER_ADMIN)
        self.cse = User.objects.create_user(
            email="rl-cse@test.edu", password="p", name="Cse Person", role=Role.FACULTY,
            department="CSE", staff_id="S1")
        # Paid in the app: the claim and the ledger row it wrote are one payment.
        self.paid = Claim.objects.create(
            owner=self.cse, paper_title="In App Paper", status=ClaimStatus.PAID,
            remuneration=1000.0, publication_year=2026, payout_month=date(2026, 9, 1),
            ticket_number="RL-1")
        PaidLedger.objects.create(claim=self.paid, payout_month=date(2026, 9, 1), amount=1000.0,
                                  department="CSE", paper_title="In App Paper")
        # Paid before the app existed: ledger only.
        PaidLedger.objects.create(payout_month=date(2024, 3, 1), amount=5000.0, department="ECE",
                                  faculty_name="Gone", staff_id="X9", paper_title="Old Paper")
        # Awaiting payment, live.
        Claim.objects.create(owner=self.cse, paper_title="Waiting", status=ClaimStatus.CLEARED,
                             remuneration=300.0, publication_year=2026, ticket_number="RL-2")
        # The record: two college papers and one that is not the college's.
        for i, (title, year) in enumerate([("Record One", 2025), ("Record Two", 2026)]):
            p = Publication.objects.create(title=title, normalized_title=title.lower(), year=year)
            Authorship.objects.create(publication=p, position=1, display_name="C", author_key=f"k{i}",
                                      user=self.cse, is_college=True)
        other = Publication.objects.create(title="Elsewhere", normalized_title="elsewhere", year=2026)
        Authorship.objects.create(publication=other, position=1, display_name="Z", author_key="z")
        self.client = Client()
        self.client.force_login(self.admin)

    def get(self, **q):
        return self.client.get("/api/reports", q).json()

    def test_ledger_only_payments_appear_and_in_app_payment_counts_once(self):
        body = self.get()
        t = body["totals"]
        self.assertEqual(t["paid_amount"], 6000.0)
        self.assertEqual(t["paid_claims"], 2)
        self.assertEqual(t["awaiting_payment"], 1)
        months = {r["key"]: r["amount"] for r in body["by_month"]}
        self.assertEqual(months, {"2024-03": 5000.0, "2026-09": 1000.0})
        self.assertIn("2024-03", body["payout_months"])

    def test_papers_come_from_the_record(self):
        # Two record papers + two recognised claim/ledger papers the record
        # lacks; the non-college publication and the CLEARED claim do not count.
        self.assertEqual(self.get()["totals"]["publications"], 4)

    def test_filters_apply_to_both(self):
        body = self.get(department="ece")
        self.assertEqual(body["totals"]["paid_amount"], 5000.0)
        self.assertEqual(body["totals"]["publications"], 1)
        body = self.get(year=2026)
        self.assertEqual(body["totals"]["paid_amount"], 1000.0)
        self.assertEqual(body["totals"]["publications"], 2)
        depts = {r["key"]: r for r in self.get()["by_department"]}
        self.assertEqual(depts["CSE"]["count"], 3)
        self.assertEqual(depts["ECE"]["amount"], 5000.0)

    def test_builder_department_uses_record_and_ledger(self):
        body = self.client.get("/api/reports/build", {"dimensions": "department"}).json()
        table = body["tables"][0]
        self.assertEqual(table["totals"]["amount"], 6000.0)
        self.assertEqual(table["totals"]["count"], 4)


class UnrecordedMonthTests(TestCase):
    """A "Processed"-sheet row names no month; its stored month is the import's.
    It counts in the total but is not charted under that month."""

    def test_unrecorded_month_is_not_charted(self):
        from datetime import date
        import json
        from django.test import Client
        from core.models import PaidLedger, Role, User
        u = User.objects.create_user(email="p@x.edu", password="p", name="Principal", role=Role.PRINCIPAL)
        PaidLedger.objects.create(payout_month=date(2024, 3, 1), amount=100, staff_id="S1", department="EEE",
                                  raw_json=json.dumps({"Payout Month": "Mar 2024"}))
        PaidLedger.objects.create(payout_month=date(2026, 9, 1), amount=50, staff_id="S2", department="EEE",
                                  raw_json=json.dumps({"Scopus Article Title": "No month here"}))
        c = Client()
        c.force_login(u)
        d = c.get("/api/reports").json()
        self.assertEqual(d["totals"]["paid_amount"], 150)
        self.assertEqual([m["key"] for m in d["by_month"]], ["2024-03"])
        self.assertEqual(d["month_unrecorded"], {"count": 1, "amount": 50})
