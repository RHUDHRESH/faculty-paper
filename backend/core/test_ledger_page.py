"""The ledger screen: search, month and department totals, faces, markers."""

from datetime import date

from django.test import TestCase

from core.models import DuplicateFinding, PaidLedger, Role, User


class LedgerPageTests(TestCase):
    def setUp(self):
        self.finance = User.objects.create_user(
            email="lp-fin@test.edu", password="pass", name="Lp Fin", role=Role.FINANCE
        )
        self.hod = User.objects.create_user(
            email="lp-hod@test.edu", password="pass", name="Lp Hod", role=Role.HOD
        )
        User.objects.create_user(
            email="lp-fac@test.edu", password="pass", name="Priya Raman", staff_id="S100",
            photo="faces/priya.jpg",
        )
        PaidLedger.objects.create(
            payout_month=date(2024, 1, 1), amount=5000, faculty_name="Priya Raman",
            staff_id="S100", department="CSE", paper_title="Deep Nets", voucher_number="V-77",
        )
        PaidLedger.objects.create(
            payout_month=date(2024, 2, 1), amount=3000, faculty_name="Arun K",
            staff_id="S200", department="ECE", paper_title="Antennas",
        )
        PaidLedger.objects.create(
            payout_month=date(2024, 2, 1), amount=-3000, faculty_name="Arun K",
            staff_id="S200", department="ECE", paper_title="Antennas",
        )
        DuplicateFinding.objects.create(
            kind="SAME_PERSON", match_key="deepnets", paper_title="Deep Nets", rows_json="[]"
        )

    def get(self, **params):
        self.client.force_login(self.finance)
        return self.client.get("/api/admin/ledger", params).json()

    def test_search_matches_name_staff_id_and_voucher(self):
        self.assertEqual(self.get(q="priya")["total"], 1)
        self.assertEqual(self.get(q="S200")["total"], 2)
        self.assertEqual(self.get(q="V-77")["total"], 1)
        self.assertEqual(self.get(q="priya antennas")["total"], 0)

    def test_totals_by_month_ignore_the_month_filter(self):
        body = self.get(month="2024-02")
        self.assertEqual(body["total"], 2)
        self.assertEqual(body["total_amount"], 0)
        self.assertEqual([m["month"] for m in body["by_month"]], ["2024-01", "2024-02"])
        self.assertEqual(body["by_department"][0]["department"], "ECE")

    def test_a_row_without_a_recorded_month_stays_out_of_the_bars(self):
        PaidLedger.objects.create(
            payout_month=date(2024, 2, 1), amount=700, faculty_name="Arun K",
            raw_json='{"Faculty Name": "Arun K"}',
        )
        body = self.get()
        feb = [m for m in body["by_month"] if m["month"] == "2024-02"][0]
        self.assertEqual(feb["count"], 2)
        self.assertEqual(body["no_month"], {"amount": 700, "count": 1})
        self.assertEqual(body["total_amount"], 5700)

    def test_rows_carry_a_face_and_markers(self):
        rows = {r["amount"]: r for r in self.get()["results"]}
        self.assertTrue(rows[5000]["photo_url"].endswith("faces/priya.jpg"))
        self.assertIn("DUPLICATE", rows[5000]["markers"])
        self.assertIn("REVERSAL", rows[-3000]["markers"])
        self.assertIsNone(rows[3000]["photo_url"])

    def test_export_follows_the_search(self):
        self.client.force_login(self.finance)
        csv = self.client.get("/api/admin/ledger/export", {"q": "priya"}).content.decode()
        self.assertEqual(len(csv.strip().splitlines()), 2)

    def test_money_is_closed_to_a_head_of_department(self):
        self.client.force_login(self.hod)
        self.assertEqual(self.client.get("/api/admin/ledger").status_code, 403)
