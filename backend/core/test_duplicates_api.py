"""The duplicates queue says which payment months the ledger actually recorded."""

from __future__ import annotations

import json

from django.test import Client, TestCase

from core.models import DuplicateFinding, PriorPayment, Role, User


class DuplicateMonthRecordedTests(TestCase):
    def setUp(self):
        self.cell = User.objects.create_user(
            email="cell@test.edu", password=None, name="Cell", role=Role.RESEARCH_CELL
        )
        # "Processed" sheet: no month column, so paid_at is the import's month.
        self.processed = PriorPayment.objects.create(
            faculty_name="A Menon", paper_title="Crop yield", amount_paid=100,
            raw_json=json.dumps({"Title": "Crop yield", "Amount": 100}),
        )
        self.history = PriorPayment.objects.create(
            faculty_name="A Menon", paper_title="Crop yield", amount_paid=100,
            raw_json=json.dumps({"Title": "Crop yield", "Month": "2021-04-01 00:00:00"}),
        )
        rows = [
            {"source": "prior", "id": p.id, "reference": None, "title": "Crop yield", "doi": None,
             "amount": 100, "when": "2026-09", "person": "A Menon", "department": None}
            for p in (self.processed, self.history)
        ]
        DuplicateFinding.objects.create(
            kind="SAME_PERSON", match_key="crop yield", paper_title="Crop yield",
            faculty_name="A Menon", rows_json=json.dumps(rows), payment_count=2,
            total_amount=200, extra_amount=100,
        )

    def test_rows_say_whether_their_month_was_recorded(self):
        c = Client()
        c.force_login(self.cell)
        r = c.get("/api/admin/duplicate-findings?kind=SAME_PERSON&status=OPEN")
        self.assertEqual(r.status_code, 200, r.content)
        rows = {row["id"]: row for row in r.json()["results"][0]["rows"]}
        self.assertFalse(rows[self.processed.id]["month_recorded"])
        self.assertTrue(rows[self.history.id]["month_recorded"])
        # The sheet's month, not the import-stamped one the sweep stored.
        self.assertEqual(rows[self.history.id]["when"], "2021-04")

    def test_history_view_takes_several_statuses(self):
        c = Client()
        c.force_login(self.cell)
        r = c.get("/api/admin/duplicate-findings?status=CONFIRMED,DISMISSED,RECOVERED")
        self.assertEqual(r.json()["total"], 0)
