"""A ticket's history says what the record knows, and never the import's moment as an event.

Every claim brought across from the ERP carries the import's moment as its
filing and payment time. The ticket page printed "You filed it yesterday" and
"Paid on 23 Sept 2026" for papers paid a year earlier.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

from django.test import Client, TestCase

from core.models import Claim, ClaimAction, ClaimStatus, PaidLedger, Role, User


class ClaimRecordTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="rec-me@x.edu", password="p", name="Me", role=Role.FACULTY, staff_id="TS1"
        )
        self.c = Client()
        self.c.force_login(self.me)

    def record(self, claim):
        r = self.c.get(f"/api/claims/{claim.id}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["record"]

    def test_a_processed_row_says_it_was_brought_across_and_invents_no_dates(self):
        claim = Claim.objects.create(
            owner=self.me, status=ClaimStatus.PAID, ticket_number="ERP-PROCESSED-650",
            paper_title="P", status_note="Processed for Remuneration",
        )
        Claim.objects.filter(pk=claim.pk).update(submitted_at=claim.created_at, paid_at=claim.created_at)
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 9, 1), amount=0, paper_title="P",
            raw_json=json.dumps({"S.No": "65.0", "Amount": "0"}),
        )
        rec = self.record(claim)
        self.assertTrue(rec["imported"])
        self.assertEqual(rec["source"], "Processed")
        self.assertIsNone(rec["filed_at"])
        self.assertIsNone(rec["paid_month"])
        self.assertEqual(rec["erp_status"], "Processed for Remuneration")
        self.assertIsNotNone(rec["imported_at"])

    def test_a_google_form_row_keeps_the_forms_own_filing_time(self):
        claim = Claim.objects.create(
            owner=self.me, status=ClaimStatus.SUBMITTED, ticket_number="ERP-RAW-65", paper_title="P"
        )
        filed = claim.created_at - timedelta(days=70)
        Claim.objects.filter(pk=claim.pk).update(submitted_at=filed)
        rec = self.record(claim)
        self.assertEqual(rec["source"], "Raw_Data")
        self.assertEqual(rec["filed_at"][:10], filed.date().isoformat())

    def test_a_paper_filed_and_paid_here_is_not_called_imported(self):
        claim = Claim.objects.create(owner=self.me, status=ClaimStatus.PAID, ticket_number="SEC-1", paper_title="P")
        ClaimAction.objects.create(claim=claim, actor=self.me, action="SUBMIT")
        Claim.objects.filter(pk=claim.pk).update(submitted_at=claim.created_at)
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 3, 1), amount=5000, paper_title="P")
        rec = self.record(claim)
        self.assertFalse(rec["imported"])
        self.assertIsNotNone(rec["filed_at"])
        self.assertEqual(rec["paid_month"], "2026-03")
