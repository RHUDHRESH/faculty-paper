from django.test import TestCase, Client
from django.core.files.uploadedfile import SimpleUploadedFile
from django.contrib.auth import get_user_model

from core.models import Claim, ClaimStatus, FormulaConfig, Role
from core.services.erp_import import find_existing_claim, map_excel_status, stable_ticket
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


class AdminProxyAndUploadTests(TestCase):
    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
            active=True,
        )
        self.faculty = User.objects.create_user(
            email="faculty-proxy@test.edu",
            password="pass",
            name="Proxy Faculty",
            role=Role.FACULTY,
            department="CSE",
            staff_id="STF-PROXY",
            biometric_id="BIO-1",
            designation="Professor",
        )
        self.admin = User.objects.create_user(
            email="admin-proxy@test.edu",
            password="pass",
            name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()

    def _login(self, user):
        self.client.force_login(user)

    def test_admin_creates_claim_with_owner_id(self):
        self._login(self.admin)
        r = self.client.post(
            "/api/claims",
            data=json.dumps(
                {
                    "owner_id": str(self.faculty.id),
                    "paper_title": "Admin Proxy Paper Title",
                    "journal_title": "Test Journal",
                    "quartile": "Q2",
                    "snip": 1.1,
                    "submit": False,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        data = r.json()
        claim = Claim.objects.get(pk=data["id"])
        self.assertEqual(claim.owner_id, self.faculty.id)
        self.assertEqual(claim.staff_id, self.faculty.staff_id)
        self.assertEqual(claim.biometric_id, self.faculty.biometric_id)
        self.assertEqual(claim.designation, self.faculty.designation)
        action = claim.actions.filter(action="ADMIN_CREATE").first()
        self.assertIsNotNone(action)
        self.assertIn("admin-proxy@test.edu", action.note or "")

    def test_faculty_cannot_set_owner_id(self):
        other = User.objects.create_user(
            email="other-fac@test.edu",
            password="pass",
            name="Other",
            role=Role.FACULTY,
            department="ECE",
            staff_id="STF-OTHER",
        )
        self._login(self.faculty)
        r = self.client.post(
            "/api/claims",
            data=json.dumps(
                {
                    "owner_id": str(other.id),
                    "paper_title": "Spoof Owner Paper Title",
                    "journal_title": "Journal",
                    "quartile": "Q1",
                    "snip": 1.0,
                    "submit": False,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)

    def test_upload_rejects_non_pdf(self):
        self._login(self.faculty)
        r = self.client.post(
            "/api/claims/upload",
            data={"file": SimpleUploadedFile("proof.txt", b"not a pdf", content_type="text/plain")},
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_health_reports_db(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body.get("ok"))
        self.assertTrue(body.get("db"))


class ErpImportHelperTests(TestCase):
    def test_map_excel_status_variants(self):
        self.assertEqual(map_excel_status("Paid"), ClaimStatus.PAID)
        self.assertEqual(map_excel_status("Payment Done"), ClaimStatus.PAID)
        self.assertEqual(map_excel_status(None, force_paid=True), ClaimStatus.PAID)
        self.assertEqual(map_excel_status("Rejected by HoD"), ClaimStatus.REJECTED)
        self.assertEqual(map_excel_status("Principal Approved"), ClaimStatus.PRINCIPAL_APPROVED)
        self.assertEqual(map_excel_status("HoD Approved"), ClaimStatus.HOD_APPROVED)
        self.assertEqual(map_excel_status("Under Review"), ClaimStatus.SUBMITTED)
        self.assertEqual(map_excel_status(None), ClaimStatus.SUBMITTED)

    def test_stable_ticket_and_dedupe(self):
        self.assertEqual(stable_ticket("Processed", 42), "ERP-PROCESSED-42")
        fac = User.objects.create_user(
            email="erp-dedupe@test.edu",
            password="pass",
            name="Fac",
            role=Role.FACULTY,
            staff_id="STF-ERP",
        )
        Claim.objects.create(
            owner=fac,
            paper_title="Deep Learning for Power Grids",
            staff_id="STF-ERP",
            doi="10.1000/erp.dedupe",
            status=ClaimStatus.SUBMITTED,
            ticket_number="ERP-TEST-1",
        )
        by_doi = find_existing_claim(doi="https://doi.org/10.1000/erp.dedupe", staff_id="STF-ERP", title="other")
        self.assertIsNotNone(by_doi)
        by_title = find_existing_claim(
            doi=None,
            staff_id="STF-ERP",
            title="Deep Learning for Power Grids",
        )
        self.assertIsNotNone(by_title)
        self.assertIsNone(
            find_existing_claim(doi=None, staff_id="STF-ERP", title="Completely Different Paper")
        )
