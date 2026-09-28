"""Where the record came from, at the top of the audit log.

The college's whole history arrived by import, and the import wrote no audit
rows, so the log's first screen was fifty-three identical "claim flag raise"
lines and nothing about the ninety-four claims and three thousand payments
behind them. These entries are worked out from the rows themselves.
"""
from __future__ import annotations

import json

from django.test import Client, TestCase

from core.models import AuditLog, Claim, ClaimStatus, PriorImport, Role, User


class AuditOriginsTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            email="or-admin@x.edu", password="p", name="Local Admin", role=Role.SUPER_ADMIN
        )
        self.finance = User.objects.create_user(
            email="or-fin@x.edu", password="p", name="Finance", role=Role.FINANCE
        )
        self.faculty = [
            # No password: thirty hashes made this the slowest file in the suite.
            User.objects.create_user(
                email=f"or-f{i}@x.edu", password=None, name=f"F{i}", role=Role.FACULTY
            )
            for i in range(30)
        ]
        PriorImport.objects.create(
            filename="Master_List_Accounts", row_count=2963, mapping_json="{}", imported_by=self.admin
        )
        for i in range(3):
            Claim.objects.create(
                owner=self.faculty[i], status=ClaimStatus.PAID,
                ticket_number=f"ERP-PROCESSED-{i}", paper_title="P",
            )
        Claim.objects.create(
            owner=self.faculty[5], status=ClaimStatus.SUBMITTED, ticket_number="ERP-RAW-9", paper_title="R"
        )
        for i in range(2):
            AuditLog.objects.create(
                actor=None, action="CLAIM_FLAG_RAISE", entity="ClaimFlag",
                detail_json=json.dumps({"kind": "AMOUNT"}),
            )

    def origins(self, user):
        c = Client()
        c.force_login(user)
        r = c.get("/api/admin/audit/origins")
        return r

    def test_the_office_sees_each_import_that_built_the_record(self):
        r = self.origins(self.admin)
        self.assertEqual(r.status_code, 200, r.content)
        text = json.dumps(r.json())
        self.assertIn("2,963 payments", text)
        self.assertIn("3 from the Processed sheet", text)
        self.assertIn("1 from Raw_Data", text)
        self.assertIn("accounts", text)
        self.assertIn("2 flags", text)

    def test_finance_is_never_shown_the_flags(self):
        r = self.origins(self.finance)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertNotIn("flag", json.dumps(r.json()).lower())

    def test_a_claimant_may_not_read_it(self):
        self.assertEqual(self.origins(self.faculty[0]).status_code, 403)
