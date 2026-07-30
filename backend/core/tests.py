from django.test import TestCase, Client
from django.contrib.auth import get_user_model

from core.models import Claim, ClaimStatus, FormulaConfig, Role
from core.services.tickets import next_ticket_number
from core.services.remuneration import DEFAULT_AUTHOR_POINTS
import json


User = get_user_model()


class TicketHierarchyTests(TestCase):
    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
            active=True,
        )
        self.faculty = User.objects.create_user(
            email="f@test.edu",
            password="pass",
            name="Fac",
            role=Role.FACULTY,
            department="CSE",
            staff_id="STF-T1",
        )
        self.hod = User.objects.create_user(
            email="h@test.edu",
            password="pass",
            name="Hod",
            role=Role.HOD,
            department="CSE",
        )
        self.principal = User.objects.create_user(
            email="p@test.edu",
            password="pass",
            name="Prin",
            role=Role.PRINCIPAL,
        )
        self.finance = User.objects.create_user(
            email="fin@test.edu",
            password="pass",
            name="Fin",
            role=Role.FINANCE,
        )
        self.client = Client()

    def _login(self, user):
        self.client.force_login(user)

    def test_ticket_number_format(self):
        t = next_ticket_number()
        self.assertTrue(t.startswith("FP-"))
        self.assertEqual(len(t.split("-")), 3)

    def test_hierarchy_approve_to_paid(self):
        claim = Claim.objects.create(
            owner=self.faculty,
            paper_title="Test Paper Hierarchy",
            journal_title="Nature",
            quartile="Q1",
            snip=1.0,
            scimago_verified=True,
            status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000001",
            total_authors=1,
            author_position=1,
            remuneration=1000,
            verification_ok=True,
        )

        self._login(self.hod)
        r = self.client.post(
            f"/api/claims/{claim.id}/hod-approve",
            data=json.dumps({"note": "ok"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.HOD_APPROVED)

        self._login(self.principal)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"note": "ok"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

        self._login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V1", "note": "paid"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)

    def test_hod_cannot_see_other_dept(self):
        other = User.objects.create_user(
            email="o@test.edu",
            password="pass",
            name="Other",
            role=Role.FACULTY,
            department="ECE",
        )
        Claim.objects.create(
            owner=other,
            paper_title="ECE Paper",
            status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000002",
            quartile="Q2",
        )
        self._login(self.hod)
        r = self.client.get("/api/claims?status=SUBMITTED")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(len(data), 0)

    def test_cannot_spoof_scimago_verified_or_staff_id(self):
        self._login(self.faculty)
        r = self.client.post(
            "/api/claims",
            data=json.dumps(
                {
                    "paper_title": "Spoof Paper Title Here",
                    "journal_title": "Test Journal",
                    "quartile": "Q1",
                    "snip": 1.2,
                    "scimago_verified": True,
                    "override_duplicate": True,
                    "staff_id": "HACKED-ID",
                    "submit": False,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        claim = Claim.objects.get(pk=data["id"])
        self.assertFalse(claim.scimago_verified)
        self.assertFalse(claim.override_duplicate)
        self.assertEqual(claim.staff_id, self.faculty.staff_id)

    def test_snip_cap_rejects_absurd_values(self):
        from core.services.remuneration import calculate_remuneration

        bad = calculate_remuneration(999, "Q1", 1, 1)
        self.assertIsNotNone(bad.error)
        self.assertIsNone(bad.remuneration)

    def test_finance_cannot_double_pay(self):
        claim = Claim.objects.create(
            owner=self.faculty,
            paper_title="Pay Once",
            journal_title="Nature",
            quartile="Q1",
            snip=1.0,
            status=ClaimStatus.PRINCIPAL_APPROVED,
            ticket_number="FP-2026-000099",
            total_authors=1,
            author_position=1,
            remuneration=5000,
        )
        self._login(self.finance)
        r1 = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V1", "note": "paid"}),
            content_type="application/json",
        )
        self.assertEqual(r1.status_code, 200, r1.content)
        r2 = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V2", "note": "again"}),
            content_type="application/json",
        )
        self.assertEqual(r2.status_code, 400)
