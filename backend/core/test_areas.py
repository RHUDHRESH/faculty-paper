"""Subject areas also come from the ERP's own "Subject Area" column.

The areas report read only `subjects_json`, which Scimago fills in for a
journal it recognises. Claims brought across from the ERP carry the
workbook's "Subject Area" in `subject_category`, in the same form, and the
Director's home said "No paper on record carries a subject area yet" over
forty-one papers that did.
"""
from __future__ import annotations

from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, Role, User


class AreasFromErpTests(TestCase):
    def test_a_claim_with_only_the_erp_subject_area_is_classified(self):
        director = User.objects.create_user(email="ar-d@x.edu", password="p", name="D", role=Role.DIRECTOR)
        owner = User.objects.create_user(email="ar-o@x.edu", password="p", name="O", role=Role.FACULTY)
        Claim.objects.create(
            owner=owner, status=ClaimStatus.PAID, paper_title="P",
            subject_category="Computer Networks and Communications (Q4); Control and Systems Engineering (Q1);",
        )
        Claim.objects.create(
            owner=owner, status=ClaimStatus.PAID, paper_title="Q",
            subjects_json="Computer Networks and Communications (Q2)",
            subject_category="Something else (Q3)",
        )
        Claim.objects.create(owner=owner, status=ClaimStatus.PAID, paper_title="R")
        c = Client()
        c.force_login(director)
        body = c.get("/api/reports/areas").json()
        counts = {a["key"]: a["count"] for a in body["areas"]}
        self.assertEqual(counts["Computer Networks and Communications"], 2)
        self.assertEqual(counts["Control and Systems Engineering"], 1)
        # Scimago's classification wins where both exist.
        self.assertNotIn("Something else", counts)
        self.assertEqual((body["coverage"]["classified"], body["coverage"]["total"]), (2, 3))
