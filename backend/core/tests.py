import os
import tempfile

from django.test import TestCase, Client, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.contrib.auth import get_user_model

from core.models import Claim, ClaimAttachment, ClaimStatus, FormulaConfig, Role
from core.services.erp_import import find_existing_claim, map_excel_status, stable_ticket
from core.services.scopus import parse_search_entry
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


class ClaimSubmissionRuleTests(TestCase):
    """Rules the publication claim form imposes before a ticket may be raised."""

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS),
            active=True,
        )
        self.faculty = User.objects.create_user(
            email="rules@test.edu",
            password="pass",
            name="Rules Faculty",
            role=Role.FACULTY,
            department="CSE",
            staff_id="STF-RULES",
            biometric_id="BIO-RULES",
            designation="Professor",
        )
        self.client = Client()

    def _login(self, user):
        self.client.force_login(user)

    def _complete_payload(self, **overrides):
        payload = {
            "paper_title": "A Complete Paper",
            "journal_title": "Journal of Testing",
            "issn": "1234-5678",
            "publication_date": "2026-03-01",
            "indexing_level": "Scopus",
            "yukthi_id": "YK-1",
            "scopus_author_url": "https://scopus.com/authid/detail.uri?authorId=1",
            "sec_refs": "14, 15",
            "proof_url": "/media/claims/paper.pdf",
            "sec_proof_url": "/media/claims/ref.pdf",
            "quartile": "Q1",
            "snip": 1.0,
            "total_authors": 3,
            "author_position": 1,
            "affiliation_ok": True,
            "submit": True,
            "contest_forward": True,
            "contest_note": "Submitting with faculty-provided journal details.",
        }
        payload.update(overrides)
        return payload

    def _post_claim(self, payload):
        return self.client.post(
            "/api/claims", data=json.dumps(payload), content_type="application/json"
        )

    def test_submit_requires_mandatory_form_fields(self):
        self._login(self.faculty)
        r = self._post_claim(self._complete_payload(yukthi_id="", sec_refs=""))
        self.assertEqual(r.status_code, 400, r.content)
        detail = r.json().get("detail", "")
        self.assertIn("Yukthi ID", detail)
        self.assertIn("Reference numbers", detail)

    def test_annexure_indexing_requires_ref_number(self):
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(indexing_level="AU Annexure", indexing_ref="")
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("reference number", r.json().get("detail", ""))

    def test_submit_requires_published_paper_pdf(self):
        self._login(self.faculty)
        r = self._post_claim(self._complete_payload(proof_url=""))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("full-length published paper", r.json().get("detail", ""))

    def test_author_position_cannot_exceed_total_authors(self):
        self._login(self.faculty)
        r = self._post_claim(self._complete_payload(total_authors=2, author_position=5))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Author position", r.json().get("detail", ""))

    def test_count_only_claim_zeroes_snip_and_pays_nothing(self):
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(claim_reason="COUNT_ONLY", snip=4.2, submit=False)
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["claim_reason"], "COUNT_ONLY")
        self.assertEqual(body["snip"], 0.0)
        self.assertTrue(body["is_student_publication"])
        self.assertIn(body["remuneration"], (0, 0.0, None))

    def test_attachments_round_trip_and_cap_at_five_references(self):
        self._login(self.faculty)
        refs = [
            {
                "kind": "SEC_REFERENCE",
                "url": f"/media/claims/ref{i}.pdf",
                "filename": f"ref{i}.pdf",
                "size_bytes": 10,
            }
            for i in range(5)
        ]
        r = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    {
                        "kind": "PUBLISHED_PAPER",
                        "url": "/media/claims/paper.pdf",
                        "filename": "paper.pdf",
                        "size_bytes": 20,
                    },
                    *refs,
                ],
            )
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(len(body["attachments"]), 6)
        self.assertEqual(body["proof_url"], "/media/claims/paper.pdf")

        r2 = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    *refs,
                    {
                        "kind": "SEC_REFERENCE",
                        "url": "/media/claims/ref6.pdf",
                        "filename": "ref6.pdf",
                        "size_bytes": 10,
                    },
                ],
            )
        )
        self.assertEqual(r2.status_code, 400, r2.content)

    def test_attachments_alone_satisfy_the_upload_gate(self):
        """No legacy proof_url — the attachments array must be enough to submit."""
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(
                proof_url="",
                sec_proof_url="",
                attachments=[
                    {"kind": "PUBLISHED_PAPER", "url": "/media/claims/p.pdf",
                     "filename": "p.pdf", "size_bytes": 10},
                    {"kind": "SEC_REFERENCE", "url": "/media/claims/r.pdf",
                     "filename": "r.pdf", "size_bytes": 10},
                ],
            )
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["ticket_number"])

    def test_rejected_attachment_set_leaves_no_claim_behind(self):
        """The cap used to fire after the ticket was issued and HoDs notified."""
        self._login(self.faculty)
        before = Claim.objects.count()
        r = self._post_claim(
            self._complete_payload(
                attachments=[
                    {"kind": "SEC_REFERENCE", "url": f"/media/claims/r{i}.pdf"}
                    for i in range(6)
                ],
            )
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Claim.objects.count(), before)

    def test_attachment_url_outside_media_is_rejected(self):
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    {"kind": "PUBLISHED_PAPER", "url": "https://evil.example/x.pdf"},
                ],
            )
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["attachments"], [])


class FacultyCreateContractTests(TestCase):
    """The shape the browser actually posts — the endpoint tests alone missed a 403 here."""

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.faculty = User.objects.create_user(
            email="contract@test.edu",
            password="pass",
            name="Contract Faculty",
            role=Role.FACULTY,
            department="CSE",
            staff_id="STF-CONTRACT",
        )
        self.client = Client()

    def test_faculty_create_without_owner_id_succeeds(self):
        """buildClaimPayload must omit owner_id in faculty mode; this is the server half."""
        self.client.force_login(self.faculty)
        r = self.client.post(
            "/api/claims",
            data=json.dumps({"paper_title": "A Faculty Filed Paper", "submit": False}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["owner_id"], self.faculty.id)

    def test_faculty_create_with_own_owner_id_is_still_refused(self):
        """Guards the fix: resending your own id must not quietly become allowed."""
        self.client.force_login(self.faculty)
        r = self.client.post(
            "/api/claims",
            data=json.dumps(
                {"paper_title": "X", "submit": False, "owner_id": self.faculty.id}
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)


class MoneyIntegrityTests(TestCase):
    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="money-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.faculty = User.objects.create_user(
            email="money-faculty@test.edu", password="pass", name="Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def _formula_payload(self, **over):
        payload = {
            "snip_multiplier": 55000, "snip_cap": 30,
            "qf_q1": 50000, "qf_q2": 30000, "qf_q3": 15000, "qf_q4": 5000,
            "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS),
        }
        payload.update(over)
        return payload

    def test_invalid_date_does_not_deactivate_the_live_policy(self):
        self.client.force_login(self.admin)
        r = self.client.put(
            "/api/admin/formula",
            data=json.dumps(self._formula_payload(effective_from="not-a-date")),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        # The live policy must survive a rejected save, or every claim silently
        # falls back to hard-coded defaults and the version counter restarts.
        active = FormulaConfig.objects.filter(active=True)
        self.assertEqual(active.count(), 1)
        self.assertEqual(active.first().version, 1)

    def test_negative_amount_is_rejected(self):
        self.client.force_login(self.admin)
        r = self.client.put(
            "/api/admin/formula",
            data=json.dumps(self._formula_payload(qf_q1=-1)),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(FormulaConfig.objects.filter(active=True).count(), 1)

    def test_valid_save_still_versions_up(self):
        self.client.force_login(self.admin)
        r = self.client.put(
            "/api/admin/formula",
            data=json.dumps(self._formula_payload(qf_q1=60000)),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["version"], 2)
        self.assertEqual(FormulaConfig.objects.filter(active=True).count(), 1)

    def test_paid_claim_cannot_be_reverified(self):
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID,
            ticket_number="FP-2026-000777", paper_title="Settled Paper",
            remuneration=5000,
        )
        self.client.force_login(self.admin)
        r = self.client.post(f"/api/claims/{claim.id}/verify")
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.remuneration, 5000)


class RejectionReasonTests(TestCase):
    """Faculty must write 10 characters to contest a failed check; approvers were
    able to send a ticket back with nothing at all."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="rej-faculty@test.edu", password="pass", name="F",
            role=Role.FACULTY, department="CSE",
        )
        self.hod = User.objects.create_user(
            email="rej-hod@test.edu", password="pass", name="H",
            role=Role.HOD, department="CSE",
        )
        self.claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000555", paper_title="Returned Paper",
        )
        self.client = Client()

    def _reject(self, note):
        self.client.force_login(self.hod)
        return self.client.post(
            f"/api/claims/{self.claim.id}/reject",
            data=json.dumps({"note": note}),
            content_type="application/json",
        )

    def test_reject_without_a_reason_is_refused(self):
        r = self._reject("")
        self.assertEqual(r.status_code, 400, r.content)
        self.claim.refresh_from_db()
        self.assertEqual(self.claim.status, ClaimStatus.SUBMITTED)

    def test_reject_with_a_token_reason_is_refused(self):
        self.assertEqual(self._reject("no").status_code, 400)

    def test_reject_with_a_real_reason_succeeds_and_reaches_the_owner(self):
        from core.models import Notification

        r = self._reject("ISSN does not match the journal named on the paper")
        self.assertEqual(r.status_code, 200, r.content)
        self.claim.refresh_from_db()
        self.assertEqual(self.claim.status, ClaimStatus.REJECTED)
        self.assertIn("ISSN", self.claim.status_note)
        note = Notification.objects.filter(user=self.faculty).first()
        self.assertIsNotNone(note)
        self.assertIn("ISSN", note.body)


class IdentityBoundaryTests(TestCase):
    """staff_id / biometric_id / department decide who gets paid and who approves,
    so the claimant must not be able to edit them."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="identity@test.edu", password="pass", name="Identity Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-REAL",
            biometric_id="BIO-REAL", designation="Assistant Professor",
        )
        self.client = Client()

    def test_profile_cannot_change_payment_identity(self):
        self.client.force_login(self.faculty)
        r = self.client.patch(
            "/api/auth/profile",
            data=json.dumps({
                "name": "New Name",
                "staff_id": "STF-HACKED",
                "biometric_id": "BIO-HACKED",
                "department": "ECE",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.name, "New Name")       # allowed
        self.assertEqual(self.faculty.staff_id, "STF-REAL")   # rejected
        self.assertEqual(self.faculty.biometric_id, "BIO-REAL")
        self.assertEqual(self.faculty.department, "CSE")

    def test_profile_update_is_audited(self):
        from core.models import AuditLog

        self.client.force_login(self.faculty)
        self.client.patch(
            "/api/auth/profile",
            data=json.dumps({"designation": "Professor"}),
            content_type="application/json",
        )
        self.assertTrue(AuditLog.objects.filter(action="PROFILE_UPDATE").exists())


class MustChangePasswordTests(TestCase):
    """The flag was returned to the client and enforced only by the frontend."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="forced@test.edu", password="pass", name="Forced",
            role=Role.FACULTY, department="CSE", must_change_password=True,
        )
        self.client = Client()
        self.client.force_login(self.user)

    def test_other_endpoints_are_blocked(self):
        r = self.client.get("/api/claims")
        self.assertEqual(r.status_code, 403, r.content)

    def test_me_and_change_password_still_work(self):
        self.assertEqual(self.client.get("/api/auth/me").status_code, 200)
        r = self.client.post(
            "/api/auth/change-password",
            data=json.dumps({"current_password": "pass", "new_password": "a-long-new-one"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.client.get("/api/claims").status_code, 200)


class SeedSafetyTests(TestCase):
    def test_seed_does_not_revert_a_changed_password_or_reactivate(self):
        from django.core.management import call_command

        call_command("seed", force=True, verbosity=0)
        u = User.objects.get(email="faculty@college.edu")
        u.set_password("a-real-password-set-after-deploy")
        u.active = False
        u.save()

        call_command("seed", force=True, verbosity=0)

        u.refresh_from_db()
        self.assertTrue(u.check_password("a-real-password-set-after-deploy"))
        self.assertFalse(u.check_password("faculty123"))
        self.assertFalse(u.active)


class ClaimMediaTests(TestCase):
    """Uploaded proofs must be served in every environment, and only to people
    entitled to see the claim they belong to."""

    def setUp(self):
        self.owner = User.objects.create_user(
            email="media-owner@test.edu", password="pass", name="Owner",
            role=Role.FACULTY, department="CSE",
        )
        self.other = User.objects.create_user(
            email="media-other@test.edu", password="pass", name="Other",
            role=Role.FACULTY, department="CSE",
        )
        self.hod_ece = User.objects.create_user(
            email="media-hod-ece@test.edu", password="pass", name="ECE HoD",
            role=Role.HOD, department="ECE",
        )
        self.name = "a" * 32 + ".pdf"
        self.claim = Claim.objects.create(owner=self.owner, paper_title="Media Paper")
        ClaimAttachment.objects.create(
            claim=self.claim, kind="PUBLISHED_PAPER", url=f"/media/claims/{self.name}"
        )

    def _serve(self, tmpdir):
        path = os.path.join(tmpdir, "claims")
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, self.name), "wb") as f:
            f.write(b"%PDF-1.4 test")
        return f"/media/claims/{self.name}"

    def test_media_is_served_when_debug_is_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            url = self._serve(tmp)
            with override_settings(MEDIA_ROOT=tmp, DEBUG=False):
                self.client.force_login(self.owner)
                r = self.client.get(url)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r["Content-Type"], "application/pdf")
                self.assertEqual(b"".join(r.streaming_content), b"%PDF-1.4 test")
                r.close()  # FileResponse holds the handle; Windows won't rmtree otherwise

    def test_media_requires_authentication(self):
        with tempfile.TemporaryDirectory() as tmp:
            url = self._serve(tmp)
            with override_settings(MEDIA_ROOT=tmp, DEBUG=False):
                self.assertEqual(self.client.get(url).status_code, 401)

    def test_media_hidden_from_unrelated_faculty(self):
        with tempfile.TemporaryDirectory() as tmp:
            url = self._serve(tmp)
            with override_settings(MEDIA_ROOT=tmp, DEBUG=False):
                self.client.force_login(self.other)
                self.assertEqual(self.client.get(url).status_code, 403)

    def test_media_hidden_from_other_department_hod(self):
        with tempfile.TemporaryDirectory() as tmp:
            url = self._serve(tmp)
            with override_settings(MEDIA_ROOT=tmp, DEBUG=False):
                self.client.force_login(self.hod_ece)
                self.assertEqual(self.client.get(url).status_code, 403)

    def test_media_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._serve(tmp)
            with override_settings(MEDIA_ROOT=tmp, DEBUG=False):
                self.client.force_login(self.owner)
                r = self.client.get("/media/claims/..%2f..%2fsettings.py")
                self.assertIn(r.status_code, (404, 400))


class ScopusParseTests(TestCase):
    def test_parse_search_entry_extracts_autofill_fields(self):
        paper = parse_search_entry(
            {
                "dc:title": "A Sample Article",
                "prism:doi": "10.1000/xyz",
                "prism:issn": "12345678",
                "prism:publicationName": "Nature",
                "prism:coverDate": "2024-03-15",
                "prism:aggregationType": "Journal",
                "author-count": {"$": "4", "@total": "4"},
                "eid": "2-s2.0-abc",
            }
        )
        self.assertEqual(paper["title"], "A Sample Article")
        self.assertEqual(paper["issn"], "1234-5678")
        self.assertEqual(paper["cover_date"], "2024-03-15")
        self.assertEqual(paper["publication_year"], 2024)
        self.assertEqual(paper["author_count"], 4)
        self.assertEqual(paper["aggregation_type"], "Journal")


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
