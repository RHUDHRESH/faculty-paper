import os
from datetime import date, timedelta
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase, Client, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from django.contrib.auth import get_user_model
from django.utils import timezone

from core.api import ATTACHMENT_LIMITS
from core.models import (
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAttachment,
    ClaimStatus,
    FacultyMaster,
    FormulaConfig,
    Notification,
    Role,
    ScimagoJournal,
)
from core.models import PaidLedger, PriorPayment
from core.services import rbac
from core.services.erp_import import find_existing_claim, map_excel_status, stable_ticket
from core.services.normalize import normalize_title
from core.services.verify import apply_verify_to_claim, check_already_paid
import httpx

from core.services.scimago_sync import (
    ScimagoSyncError,
    download_dump,
    import_csv_text,
    parse_decimal,
)
from core.services.scopus import parse_search_entry, search_candidates
from core.services.uploads import sniff
from core.services.tickets import next_ticket_number
from core.services.remuneration import DEFAULT_AUTHOR_POINTS
import json


User = get_user_model()


def _echo_verified(*args, exclude_claim_id=None, **kwargs):
    """Replay the claim's stored SNIP/quartile so money-movement tests stay deterministic."""
    claim = Claim.objects.filter(pk=exclude_claim_id).first() if exclude_claim_id else None
    if claim is None:
        return {
            "ok": True,
            "scopus": {"indexed": False, "linked": False, "message": "miss"},
            "scimago": {"found": False, "quartile": None, "message": None},
            "paid": {"warning": False, "matches": []},
            "paper": None,
            "snip": None,
            "engineering_class": None,
        }
    return {
        "ok": True,
        "scopus": {"indexed": True, "linked": True, "message": "ok"},
        "scimago": {
            "found": bool(claim.quartile),
            "quartile": claim.quartile,
            "message": None,
        },
        "paid": {"warning": False, "matches": []},
        "paper": {"journal_title": claim.journal_title} if claim.journal_title else None,
        "snip": claim.snip,
        "snip_source": claim.snip_source or "SCOPUS",
        "engineering_class": claim.engineering_class,
    }


def _verify_hit(*, snip=1.0, quartile="Q2"):
    return {
        "ok": True,
        "scopus": {"indexed": True, "linked": True, "message": "ok"},
        "scimago": {"found": True, "quartile": quartile, "message": None},
        "paid": {"warning": False, "matches": []},
        "paper": {"journal_title": "Nature"},
        "snip": snip,
        "snip_source": "SCOPUS",
        "engineering_class": "Engineering",
    }


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
        self.admin = User.objects.create_user(
            email="adm@test.edu",
            password="pass",
            name="Adm",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()
        verify_patch = patch("core.api.verify_publication", side_effect=_echo_verified)
        verify_patch.start()
        self.addCleanup(verify_patch.stop)

    def _login(self, user):
        self.client.force_login(user)

    def test_ticket_number_format(self):
        t = next_ticket_number()
        self.assertTrue(t.startswith("FP-"))
        self.assertEqual(len(t.split("-")), 3)

    def _submitted_claim(self, ticket="FP-2026-000001"):
        # Verified values + evidenced SEC references, so the amount recomputes
        # deterministically: (1.0 × 55000 + 30000) × point 1.0 = 85000 — kept
        # below the second-approval threshold, which has its own tests.
        claim = Claim.objects.create(
            owner=self.faculty,
            paper_title="Test Paper Hierarchy",
            journal_title="Nature",
            quartile="Q2",
            quartile_source="SCIMAGO",
            snip=1.0,
            snip_source="SCOPUS",
            scimago_verified=True,
            status=ClaimStatus.SUBMITTED,
            ticket_number=ticket,
            publication_type="Journal",
            indexing_level="Scopus",
            engineering_class="Engineering",
            total_authors=1,
            author_position=1,
            remuneration=85000.0,
            verification_ok=True,
        )
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'d' * 31}{n[-1]}.pdf", ref_number=n,
            )
        return claim

    def test_submitted_is_cleared_by_admin_then_paid_by_finance(self):
        claim = self._submitted_claim()

        self._login(self.admin)
        # Money only moves at a confirmed amount now.
        r = self.client.post(
            f"/api/claims/{claim.id}/clear",
            data=json.dumps({"note": "ok"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 409, "clearing without a confirmed amount must refuse")

        r = self.client.post(
            f"/api/claims/{claim.id}/clear",
            data=json.dumps({"note": "ok", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self.assertEqual(claim.cleared_by, self.admin)
        # Finance is told there is money to move.
        self.assertTrue(
            Notification.objects.filter(user=self.finance, claim_id=claim.id).exists()
        )

        self._login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps(
                {"voucher_number": "V1", "note": "paid", "expected_amount": 85000.0}
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)

    def test_finance_cannot_pay_a_ticket_that_was_never_cleared(self):
        claim = self._submitted_claim("FP-2026-000009")
        self._login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V2"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_hod_and_principal_can_no_longer_approve(self):
        claim = self._submitted_claim("FP-2026-000010")
        for user, endpoint in ((self.hod, "hod-approve"), (self.principal, "principal-approve")):
            self._login(user)
            r = self.client.post(
                f"/api/claims/{claim.id}/{endpoint}",
                data=json.dumps({"note": "ok"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_a_ticket_on_the_old_chain_must_be_cleared_before_payment(self):
        """Paying one of these skipped clearing altogether.

        No re-verification, no recomputed amount, no confirmation guard -- it
        paid whatever figure the spreadsheet carried. A super admin moves it to
        Cleared first, which is a deliberate act and leaves a record.
        """
        claim = self._submitted_claim("FP-2026-000011")
        claim.status = ClaimStatus.PRINCIPAL_APPROVED
        claim.save(update_fields=["status"])
        self._login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("retired approval status", r.json()["detail"])
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

    def test_only_admins_can_clear(self):
        claim = self._submitted_claim("FP-2026-000012")
        for user in (self.faculty, self.hod, self.principal, self.finance):
            self._login(user)
            r = self.client.post(
                f"/api/claims/{claim.id}/clear",
                data=json.dumps({"note": "ok"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 403, f"{user.role} should not clear")
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_a_ticket_number_collision_does_not_lose_the_claim(self):
        """The live path used to call next_ticket_number and save directly, so a
        number taken between the two raised IntegrityError and dropped the claim."""
        from core.services.tickets import assign_ticket_number

        taken = Claim.objects.create(
            owner=self.faculty, paper_title="Holder", ticket_number="FP-2026-000001"
        )
        claim = Claim.objects.create(owner=self.faculty, paper_title="Racer")

        real = next_ticket_number
        calls = {"n": 0}

        def collide():
            # First attempt hands back a number that is already taken.
            calls["n"] += 1
            return taken.ticket_number if calls["n"] == 1 else real()

        with patch("core.services.tickets.next_ticket_number", side_effect=collide):
            assigned = assign_ticket_number(claim)

        self.assertNotEqual(assigned, taken.ticket_number)
        claim.refresh_from_db()
        self.assertEqual(claim.ticket_number, assigned)
        self.assertTrue(assigned.startswith("FP-"))

    def test_nobody_else_sees_an_unsubmitted_draft(self):
        """A draft is half-typed work its author has not shown to anyone.

        The oversight portals list whole pipelines, so without this the HoD and
        Principal screens quietly published everyone's unfinished claims."""
        Claim.objects.create(
            owner=self.faculty, paper_title="Half-written idea", status=ClaimStatus.DRAFT
        )
        for viewer in (self.hod, self.principal, self.finance, self.admin):
            self._login(viewer)
            titles = [c["paper_title"] for c in self.client.get("/api/claims").json()["results"]]
            self.assertNotIn("Half-written idea", titles, f"{viewer.role} saw a draft")

        # The author still sees their own.
        self._login(self.faculty)
        titles = [c["paper_title"] for c in self.client.get("/api/claims").json()["results"]]
        self.assertIn("Half-written idea", titles)

    def test_a_leftover_hod_account_has_only_faculty_rights(self):
        """The role was removed. Any account still carrying it must not keep
        department-wide visibility it is no longer entitled to."""
        other = User.objects.create_user(
            email="o@test.edu",
            password="pass",
            name="Other",
            role=Role.FACULTY,
            department="CSE",  # same department the old HoD used to oversee
        )
        Claim.objects.create(
            owner=other,
            paper_title="CSE Paper",
            status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000002",
            quartile="Q2",
        )
        self._login(self.hod)
        data = self.client.get("/api/claims").json()
        self.assertEqual(data["results"], [], "a retired HoD account still saw the department")
        self.assertEqual(data["total"], 0)
        self.assertEqual(rbac.portal_for_role(Role.HOD), "faculty")

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
            status=ClaimStatus.CLEARED,
            ticket_number="FP-2026-000099",
            total_authors=1,
            author_position=1,
            indexing_level="Scopus",
            publication_type="Journal",
            engineering_class="Engineering",
            remuneration=105000,
        )
        # Two cited SEC references, or the policy prices it at nothing and the
        # amount guard refuses the payment before we get to the double-pay check.
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'d' * 31}{n[-1]}.pdf", ref_number=n,
            )
        self._login(self.finance)
        r1 = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"note": "paid", "expected_amount": 105000}),
            content_type="application/json",
        )
        self.assertEqual(r1.status_code, 200, r1.content)
        r2 = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"note": "again", "expected_amount": 105000}),
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

    def test_faculty_options_filters_in_the_database(self):
        FacultyMaster.objects.create(
            staff_id="STF-A1", name="Anita Kumar", department="CSE", email="anita@test.edu"
        )
        FacultyMaster.objects.create(
            staff_id="STF-B2", name="Bala Raj", department="ECE", email="bala@test.edu"
        )
        self._login(self.admin)
        r = self.client.get("/api/admin/faculty-options?q=anita")
        self.assertEqual(r.status_code, 200)
        names = [row["name"] for row in r.json()]
        self.assertIn("Anita Kumar", names)
        self.assertNotIn("Bala Raj", names)
        # A master row linked to a user account by staff id keeps the link.
        FacultyMaster.objects.create(
            staff_id="STF-PROXY", name="Proxy Faculty", department="CSE",
            email="faculty-proxy@test.edu",
        )
        r = self.client.get("/api/admin/faculty-options?q=proxy")
        rows = [row for row in r.json() if row["staff_id"] == "STF-PROXY"]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["has_user_account"])
        self.assertEqual(rows[0]["owner_id"], str(self.faculty.id))

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
        self.assertIn("git", body)


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
            "proof_url": "/media/claims/a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0.pdf",
            "sec_proof_url": "/media/claims/a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1.pdf",
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

    def test_count_only_claim_keeps_its_metrics_and_pays_nothing(self):
        """The zero comes from the student-publication flag, not from erasing
        the journal's SNIP -- the publication count keeps the figures."""
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(claim_reason="COUNT_ONLY", snip=4.2, submit=False)
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["claim_reason"], "COUNT_ONLY")
        self.assertEqual(body["self_reported_snip"], 4.2)
        self.assertTrue(body["is_student_publication"])
        self.assertIn(body["remuneration"], (0, 0.0, None))

    def test_attachments_round_trip_and_cap_at_the_abuse_ceiling(self):
        """A paper can cite many SEC references — the cap is an abuse ceiling."""
        self._login(self.faculty)
        refs = [
            {
                "kind": "SEC_REFERENCE",
                "url": f"/media/claims/{i:032x}.pdf",
                "filename": f"ref{i}.pdf",
                "size_bytes": 10,
            }
            for i in range(ATTACHMENT_LIMITS[AttachmentKind.SEC_REFERENCE])
        ]
        r = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    {
                        "kind": "PUBLISHED_PAPER",
                        "url": "/media/claims/a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0.pdf",
                        "filename": "paper.pdf",
                        "size_bytes": 20,
                    },
                    *refs,
                ],
            )
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(len(body["attachments"]), len(refs) + 1)
        self.assertEqual(body["proof_url"], "/media/claims/a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0.pdf")
        # Order is how the claimant dropped them, not upload completion order.
        self.assertEqual(
            [a["filename"] for a in body["attachments"] if a["kind"] == "SEC_REFERENCE"],
            [r["filename"] for r in refs],
        )

        r2 = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    *refs,
                    {
                        "kind": "SEC_REFERENCE",
                        "url": "/media/claims/a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2.pdf",
                        "filename": "one-too-many.pdf",
                        "size_bytes": 10,
                    },
                ],
            )
        )
        self.assertEqual(r2.status_code, 400, r2.content)

    def test_ten_published_paper_files_are_accepted(self):
        """A split article or one with supplementary material is still one claim."""
        self._login(self.faculty)
        papers = [
            {"kind": "PUBLISHED_PAPER", "url": f"/media/claims/{i + 200:032x}.pdf",
             "filename": f"part{i}.pdf", "size_bytes": 10}
            for i in range(10)
        ]
        r = self._post_claim(self._complete_payload(submit=False, attachments=papers))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(len(r.json()["attachments"]), 10)

    def test_the_same_file_listed_twice_is_stored_once(self):
        """A double-submitted URL would read to an approver as two references."""
        self._login(self.faculty)
        dupe = {"kind": "SEC_REFERENCE", "url": "/media/claims/a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3.pdf",
                "filename": "same.pdf", "size_bytes": 10}
        r = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    {"kind": "PUBLISHED_PAPER", "url": "/media/claims/a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4.pdf"},
                    dupe,
                    dict(dupe),
                    dict(dupe),
                ],
            )
        )
        self.assertEqual(r.status_code, 200, r.content)
        refs = [a for a in r.json()["attachments"] if a["kind"] == "SEC_REFERENCE"]
        self.assertEqual(len(refs), 1)

    def test_attachments_alone_satisfy_the_upload_gate(self):
        """No legacy proof_url — the attachments array must be enough to submit."""
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(
                proof_url="",
                sec_proof_url="",
                attachments=[
                    {"kind": "PUBLISHED_PAPER", "url": "/media/claims/a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4.pdf",
                     "filename": "p.pdf", "size_bytes": 10},
                    {"kind": "SEC_REFERENCE", "url": "/media/claims/a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5.pdf",
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
        over = ATTACHMENT_LIMITS[AttachmentKind.SEC_REFERENCE] + 1
        r = self._post_claim(
            self._complete_payload(
                attachments=[
                    {"kind": "SEC_REFERENCE", "url": f"/media/claims/{i + 400:032x}.pdf"}
                    for i in range(over)
                ],
            )
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Claim.objects.count(), before)

    def test_a_citation_carries_its_number_and_title_on_the_file(self):
        """Number, title and file are one thing. They used to be three parallel
        fields, so nothing said which file proved which reference."""
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(
                submit=False,
                sec_refs=None,
                attachments=[
                    {"kind": "PUBLISHED_PAPER", "url": "/media/claims/" + "e" * 32 + ".pdf"},
                    {
                        "kind": "SEC_REFERENCE",
                        "url": "/media/claims/" + "f" * 32 + ".pdf",
                        "ref_number": "14",
                        "ref_title": "A cited SEC paper",
                    },
                    {
                        "kind": "SEC_REFERENCE",
                        "url": "/media/claims/" + "0" * 32 + ".pdf",
                        "ref_number": "57",
                        "ref_title": "Another cited SEC paper",
                    },
                ],
            )
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        refs = [a for a in body["attachments"] if a["kind"] == "SEC_REFERENCE"]
        self.assertEqual([a["ref_number"] for a in refs], ["14", "57"])
        # The ERP columns are derived, so they cannot drift from the citations.
        self.assertEqual(body["sec_refs"], "14, 57")
        self.assertEqual(
            body["reference_articles"], "A cited SEC paper\nAnother cited SEC paper"
        )

    def test_a_published_paper_never_carries_citation_fields(self):
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    {
                        "kind": "PUBLISHED_PAPER",
                        "url": "/media/claims/" + "e" * 32 + ".pdf",
                        "ref_number": "99",
                        "ref_title": "not a citation",
                    }
                ],
            )
        )
        paper = r.json()["attachments"][0]
        self.assertIsNone(paper["ref_number"])
        self.assertIsNone(paper["ref_title"])

    def test_several_indexes_can_be_recorded_at_once(self):
        """A journal is often in Scopus and an annexure at the same time."""
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(indexing_level="Scopus, UGC Care", submit=True)
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("UGC Care", r.json()["detail"])

        r2 = self._post_claim(
            self._complete_payload(
                indexing_level="Scopus, UGC Care", ugc_care_ref="NA", submit=True
            )
        )
        self.assertEqual(r2.status_code, 200, r2.content)
        self.assertEqual(r2.json()["indexing_level"], "Scopus, UGC Care")

    def test_each_annexure_keeps_its_own_reference_number(self):
        """AU Annexure and UGC Care are separate registers; one shared box could
        only ever carry one of the two numbers."""
        self._login(self.faculty)
        # Both selected, only one number supplied — the missing one is named.
        r = self._post_claim(
            self._complete_payload(
                indexing_level="AU Annexure, UGC Care",
                au_annexure_ref="AU-77",
                submit=True,
            )
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("UGC Care", r.json()["detail"])

        r2 = self._post_claim(
            self._complete_payload(
                indexing_level="AU Annexure, UGC Care",
                au_annexure_ref="AU-77",
                ugc_care_ref="UGC-12",
                submit=True,
            )
        )
        self.assertEqual(r2.status_code, 200, r2.content)
        body = r2.json()
        self.assertEqual(body["au_annexure_ref"], "AU-77")
        self.assertEqual(body["ugc_care_ref"], "UGC-12")
        # The ERP's single column keeps both, labelled.
        self.assertEqual(body["indexing_ref"], "AU Annexure AU-77; UGC Care UGC-12")

    def test_affiliation_must_be_affirmed_not_assumed(self):
        """The toggle starts off; a claim cannot be submitted until it is set."""
        self.assertFalse(Claim().affiliation_ok)
        self._login(self.faculty)
        payload = self._complete_payload(submit=True)
        payload.pop("affiliation_ok", None)
        r = self._post_claim(payload)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Saveetha Engineering College", r.json()["detail"])

    def test_the_best_qualifying_publication_type_sets_the_multiplier(self):
        from core.services.remuneration import FormulaConfigInput, _pub_multiplier

        cfg = FormulaConfigInput(
            author_points={},
            publication_type_multipliers={"Journal": 1.0, "Book Series": 0.5},
        )
        self.assertEqual(_pub_multiplier("Book Series", cfg), 0.5)
        # Filing it under both must not cost the claimant the better rate.
        self.assertEqual(_pub_multiplier("Book Series, Journal", cfg), 1.0)

    def test_a_traversal_shaped_attachment_url_is_rejected(self):
        """"/media/../../../etc/passwd" satisfies a startswith check on MEDIA_URL,
        and the client picks this string — it ends up in an href and an iframe."""
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(
                submit=False,
                attachments=[
                    {"kind": "PUBLISHED_PAPER", "url": "/media/../../../etc/passwd"},
                    {"kind": "SEC_REFERENCE", "url": "/media/claims/../../secrets.env"},
                    {"kind": "SEC_REFERENCE", "url": "/media/claims/not-a-uuid.pdf"},
                    {"kind": "SEC_REFERENCE", "url": "/media/claims/" + "a" * 32 + ".pdf"},
                ],
            )
        )
        self.assertEqual(r.status_code, 200, r.content)
        kept = [a["url"] for a in r.json()["attachments"]]
        # Only the one shaped like something upload_claim_file actually minted.
        self.assertEqual(kept, ["/media/claims/" + "a" * 32 + ".pdf"])

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


_VERIFY_MISS = {
    "ok": True,
    "scopus": {"indexed": False, "linked": False, "message": "Not yet indexed in Scopus"},
    "scimago": {"found": False, "quartile": None, "message": None},
    "paid": {"warning": False, "matches": []},
    "paper": None,
    "snip": None,
    "engineering_class": None,
}


class TrustBoundaryTests(TestCase):
    """The payout is computed only from server-verified values.

    Every money-determining field a claimant types lands in a self_reported_*
    column; the verified columns are written by Scopus/Scimago or by an admin's
    audited manual entry, never by the claim form.
    """

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.faculty = User.objects.create_user(
            email="trust-fac@test.edu", password="pass", name="Trust Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-TRUST",
        )
        self.admin = User.objects.create_user(
            email="trust-admin@test.edu", password="pass", name="Trust Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()

    def test_faculty_declarations_go_to_self_reported_columns(self):
        self.client.force_login(self.faculty)
        r = self.client.post(
            "/api/claims",
            data=json.dumps(
                {
                    "paper_title": "Trusted Boundary Paper",
                    "snip": 30.0,
                    "quartile": "Q1",
                    "eid": "2-s2.0-INJECTED",
                    "scopus_url": "https://scopus.com/injected",
                    "cover_date": "2026-01-01",
                    "aggregation_type": "Journal",
                    "engineering_class": "Engineering",
                    "submit": False,
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["self_reported_snip"], 30.0)
        self.assertEqual(body["self_reported_quartile"], "Q1")
        # The verified columns must be untouched by anything the client sent.
        self.assertIsNone(body["snip"])
        self.assertIsNone(body["quartile"])
        self.assertIsNone(body["eid"])
        self.assertIsNone(body["scopus_url"])
        self.assertIsNone(body["cover_date"])
        self.assertIsNone(body["aggregation_type"])
        self.assertIsNone(body["engineering_class"])
        self.assertTrue(body["remuneration_is_estimate"])

    def test_submission_never_pays_from_a_self_declared_snip(self):
        """The old hole: self-declared SNIP=30 survived a Scopus miss and one
        clear made ₹16.5L payable."""
        self.client.force_login(self.faculty)
        payload = {
            "paper_title": "A Self Declared Snip Paper",
            "journal_title": "Journal of Testing",
            "issn": "1234-5678",
            "publication_date": "2026-03-01",
            "indexing_level": "Scopus",
            "yukthi_id": "YK-1",
            "scopus_author_url": "https://scopus.com/authid/detail.uri?authorId=1",
            "sec_refs": "14, 15",
            "proof_url": "/media/claims/b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0.pdf",
            "sec_proof_url": "/media/claims/b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1.pdf",
            "snip": 30.0,
            "quartile": "Q1",
            "total_authors": 1,
            "author_position": 1,
            "affiliation_ok": True,
            "submit": True,
            "contest_forward": True,
            "contest_note": "Submitting with faculty-provided journal details.",
        }
        with patch("core.api.verify_publication", return_value=dict(_VERIFY_MISS)):
            r = self.client.post(
                "/api/claims", data=json.dumps(payload), content_type="application/json"
            )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["status"], "SUBMITTED")
        self.assertIsNone(body["snip"], "self-declared SNIP must not become the verified value")
        self.assertEqual(body["self_reported_snip"], 30.0)
        self.assertIn(body["remuneration"], (0, 0.0, None), "no money from unverified declarations")

    def test_manual_verification_sets_source_and_recalculates(self):
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000801", paper_title="Manually Verified Paper",
            publication_type="Journal", indexing_level="Scopus",
            total_authors=1, author_position=1,
            self_reported_snip=30.0, self_reported_quartile="Q1",
        )
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'c' * 31}{n[-1]}.pdf", ref_number=n,
            )
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/set-verified",
            data=json.dumps(
                {
                    "snip": 2.0,
                    "quartile": "Q2",
                    "engineering_class": "Engineering",
                    "note": "SNIP from Scopus source page, quartile from Scimago 2025.",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["snip"], 2.0)
        self.assertEqual(body["snip_source"], "MANUAL")
        self.assertEqual(body["quartile"], "Q2")
        self.assertEqual(body["quartile_source"], "MANUAL")
        # (2 × 55000 + 30000) × author point 1.0 — from the verified values,
        # not the claimant's 30/Q1 declaration.
        self.assertEqual(body["remuneration"], 140000.0)
        log = AuditLog.objects.filter(action="CLAIM_MANUAL_VERIFY", entity_id=claim.id).first()
        self.assertIsNotNone(log)
        detail = json.loads(log.detail_json)
        self.assertIn("before", detail)
        self.assertIn("after", detail)

    def test_manual_verification_requires_a_source_note(self):
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000802", paper_title="Unnoted Paper",
        )
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/set-verified",
            data=json.dumps({"snip": 2.0, "note": "short"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        # Faculty cannot reach the lane at all.
        self.client.force_login(self.faculty)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/set-verified",
            data=json.dumps({"snip": 2.0, "note": "A perfectly valid source note."}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)

    def test_manual_verification_refuses_settled_claims(self):
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID,
            ticket_number="FP-2026-000803", paper_title="Settled Paper", remuneration=5000,
        )
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/set-verified",
            data=json.dumps({"snip": 2.0, "note": "A perfectly valid source note."}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_reverify_clears_stale_values_but_preserves_manual_ones(self):
        stale = Claim.objects.create(
            owner=self.faculty, paper_title="Stale Paper",
            snip=5.0, snip_source="SCOPUS", quartile="Q1", quartile_source="SCIMAGO",
            scimago_verified=True,
        )
        apply_verify_to_claim(stale, dict(_VERIFY_MISS))
        self.assertIsNone(stale.snip)
        self.assertIsNone(stale.snip_source)
        self.assertIsNone(stale.quartile)
        self.assertFalse(stale.scimago_verified)

        manual = Claim.objects.create(
            owner=self.faculty, paper_title="Manual Paper",
            snip=2.0, snip_source="MANUAL", quartile="Q2", quartile_source="MANUAL",
        )
        apply_verify_to_claim(manual, dict(_VERIFY_MISS))
        self.assertEqual(manual.snip, 2.0)
        self.assertEqual(manual.snip_source, "MANUAL")
        self.assertEqual(manual.quartile, "Q2")
        self.assertEqual(manual.quartile_source, "MANUAL")


class DuplicateDetectionTests(TestCase):
    """Duplicate checks are database lookups, not truncated Python scans."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="dup-fac@test.edu", password="pass", name="Dup Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-DUP",
        )

    def _prior(self, title, **kw):
        kw.setdefault("normalized_title", normalize_title(title))
        return PriorPayment.objects.create(
            paper_title=title, raw_json="{}", amount_paid=5000, **kw
        )

    def test_exact_doi_match(self):
        self._prior("Some Paid Paper", doi="10.1000/xyz123")
        out = check_already_paid(title=None, doi="https://doi.org/10.1000/XYZ123")
        self.assertTrue(out["warning"])

    def test_prior_payment_beyond_the_old_scan_window_still_matches(self):
        """The old code scanned only the first 400 rows in Python."""
        for i in range(430):
            self._prior(f"Unrelated Filler Publication Number {i}")
        self._prior("Deep Learning For Rice Disease Detection")
        out = check_already_paid(title="Deep Learning for Rice Disease Detection")
        self.assertTrue(out["warning"], "a duplicate past row 400 must still warn")

    def test_rough_title_match_via_db_candidates(self):
        self._prior("Deep Learning for Rice Disease Detection in Tamil Nadu")
        out = check_already_paid(
            title="Deep learning for rice disease detection in Tamil Nadu region"
        )
        self.assertTrue(out["warning"])

    def test_paid_claim_title_matches_regardless_of_staff_id(self):
        other = User.objects.create_user(
            email="dup-other@test.edu", password="pass", name="Other",
            role=Role.FACULTY, staff_id="STF-OTHER",
        )
        Claim.objects.create(
            owner=other, status=ClaimStatus.PAID, staff_id="STF-OTHER",
            ticket_number="FP-2026-000900", paper_title="A Shared Duplicate Paper",
            normalized_title=normalize_title("A Shared Duplicate Paper"),
            remuneration=9000,
        )
        out = check_already_paid(title="A Shared Duplicate Paper", staff_id="STF-DUP")
        self.assertTrue(
            out["warning"],
            "the same paper paid to a different staff id must still warn",
        )


class PolicyRobustnessTests(TestCase):
    """The payout policy must not be able to price a valid paper at nothing,
    or be saved in a shape that breaks every calculation."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="pol-admin@test.edu", password="pass", name="Policy Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()

    def test_author_points_fall_back_to_a_default_share(self):
        """The live policy covers 1-5 explicitly and leaves the rest to
        "default". Without the fallback every 6-9 author paper priced at zero
        and could not be cleared."""
        from core.services.remuneration import FormulaConfigInput, author_point

        cfg = FormulaConfigInput(
            author_points={"1": 1, "2": [0.7, 0.3], "default": 0.5}
        )
        for total in (6, 7, 8, 9):
            point, err = author_point(total, total, cfg)
            self.assertIsNone(err, f"{total} authors should price via default: {err}")
            self.assertEqual(point, 0.5)
        # The explicit rules still win.
        self.assertEqual(author_point(1, 1, cfg), (1.0, None))
        self.assertEqual(author_point(2, 2, cfg), (0.3, None))
        # And the eligibility ceiling is still enforced above it.
        point, err = author_point(10, 1, cfg)
        self.assertIsNone(point)
        self.assertIn("not eligible", err)

    def test_a_valid_six_author_paper_is_priced(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps({"1": 1, "default": 0.5}), active=True
        )
        self.client.force_login(self.admin)
        r = self.client.post(
            "/api/calculate",
            data=json.dumps({
                "snip": 1.5, "quartile": "Q1", "total_authors": 6,
                "author_position": 3, "indexing_level": "Scopus",
                "publication_type": "Journal", "engineering_class": "Engineering",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertIsNone(body.get("error"))
        self.assertGreater(body["remuneration"], 0)

    def _formula(self, **over):
        payload = {
            "snip_multiplier": 55000, "snip_cap": 30,
            "qf_q1": 50000, "qf_q2": 30000, "qf_q3": 15000, "qf_q4": 7000,
            "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS),
        }
        payload.update(over)
        return payload

    def test_a_wrongly_shaped_policy_is_refused(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True, version=1
        )
        self.client.force_login(self.admin)
        bad = [
            {"author_point_json": json.dumps([1, 2])},
            {"author_point_json": json.dumps("nonsense")},
            {"author_point_json": json.dumps({"1": "one"})},
            {"author_point_json": json.dumps({"1": []})},
            {"author_point_json": json.dumps({"first": 1})},
            {"publication_type_multipliers_json": json.dumps([1, 2])},
            {"publication_type_multipliers_json": json.dumps({"Journal": "x"})},
        ]
        for over in bad:
            r = self.client.put(
                "/api/admin/formula",
                data=json.dumps(self._formula(**over)),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400, f"{over} should be refused: {r.content}")
        # The live policy survived every rejection.
        self.assertEqual(FormulaConfig.objects.filter(active=True).count(), 1)
        self.assertEqual(FormulaConfig.objects.get(active=True).version, 1)

    def test_saving_a_policy_keeps_the_rates_it_was_given(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.client.force_login(self.admin)
        r = self.client.put(
            "/api/admin/formula",
            data=json.dumps(self._formula(
                fixed_journal_no_snip=6000, fixed_other_no_snip=4500,
                fixed_web_of_science=5500, max_authors=8, min_sec_references=3,
            )),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        cfg = FormulaConfig.objects.get(active=True)
        self.assertEqual(cfg.fixed_journal_no_snip, 6000)
        self.assertEqual(cfg.fixed_other_no_snip, 4500)
        self.assertEqual(cfg.fixed_web_of_science, 5500)
        self.assertEqual(cfg.max_authors, 8)
        self.assertEqual(cfg.min_sec_references, 3)
        # And they come back out, so the editor can show what is in force.
        body = self.client.get("/api/admin/formula").json()
        self.assertEqual(body["max_authors"], 8)
        self.assertEqual(body["min_sec_references"], 3)
        self.assertEqual(body["fixed_journal_no_snip"], 6000)


class PaymentLifecycleTests(TestCase):
    """Void, override, withdraw, and the second signature on big amounts."""

    def setUp(self):
        from core.api import _invalidate_threshold_cache

        # The second-approval rule is opt-in (it needs two admin accounts), so
        # these tests switch it on explicitly.
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            high_value_threshold=100000,
        )
        _invalidate_threshold_cache()
        self.addCleanup(_invalidate_threshold_cache)
        self.faculty = User.objects.create_user(
            email="life-fac@test.edu", password="pass", name="Life Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-LIFE",
        )
        self.admin = User.objects.create_user(
            email="life-admin@test.edu", password="pass", name="Life Admin",
            role=Role.SUPER_ADMIN,
        )
        self.admin2 = User.objects.create_user(
            email="life-admin2@test.edu", password="pass", name="Second Admin",
            role=Role.SUPER_ADMIN,
        )
        self.finance = User.objects.create_user(
            email="life-fin@test.edu", password="pass", name="Life Fin", role=Role.FINANCE
        )
        self.client = Client()
        verify_patch = patch("core.api.verify_publication", side_effect=_echo_verified)
        verify_patch.start()
        self.addCleanup(verify_patch.stop)

    def _claim(self, *, status, remuneration, ticket, **kw):
        """A claim whose amount recomputes to exactly `remuneration`.

        snip = (remuneration/point − QFA)/55000 is fiddly; instead build from a
        chosen snip: remuneration = snip × 55000 + qf(quartile).
        """
        claim = Claim.objects.create(
            owner=self.faculty, status=status, ticket_number=ticket,
            paper_title=f"Lifecycle {ticket}", publication_type="Journal",
            indexing_level="Scopus", engineering_class="Engineering",
            quartile=kw.pop("quartile", "Q2"), quartile_source="SCIMAGO",
            snip=kw.pop("snip", 1.0), snip_source="SCOPUS",
            total_authors=1, author_position=1,
            remuneration=remuneration, **kw,
        )
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'e' * 31}{n[-1]}.pdf", ref_number=n,
            )
        return claim

    # ---- amount guard ----

    def test_clear_refuses_when_the_amount_drifted(self):
        # Stored figure says 85000 but the verified values recompute to it too —
        # confirming a *different* number must refuse.
        claim = self._claim(status=ClaimStatus.SUBMITTED, remuneration=85000.0, ticket="LC-1")
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/claims/{claim.id}/clear",
            data=json.dumps({"expected_amount": 12345.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_mark_paid_requires_the_confirmed_amount_on_live_claims(self):
        claim = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-2")
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V9"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 409, r.content)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V9", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_recalculate_refreshes_from_scopus(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, remuneration=85000.0, ticket="LC-RC")
        self.client.force_login(self.admin)
        with patch("core.api.verify_publication", return_value=_verify_hit(snip=2.0, quartile="Q1")):
            r = self.client.post(
                f"/api/claims/{claim.id}/recalculate",
                data=json.dumps({}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["remuneration"], 160000.0)
        self.assertEqual(body["previous"], 85000.0)

    def test_recalculate_skip_external_is_super_admin_only(self):
        claim = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-SKIP")
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/recalculate",
            data=json.dumps({"skip_external": True}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/claims/{claim.id}/recalculate",
            data=json.dumps({"skip_external": True}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["changed"])

    def test_clear_refuses_when_reverify_changes_the_amount(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, remuneration=85000.0, ticket="LC-RV")
        self.client.force_login(self.admin)
        with patch("core.api.verify_publication", return_value=_verify_hit(snip=2.0, quartile="Q1")):
            r = self.client.post(
                f"/api/claims/{claim.id}/clear",
                data=json.dumps({"expected_amount": 85000.0}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertEqual(claim.snip, 1.0)

    def test_mark_paid_refuses_when_the_stored_values_recompute_differently(self):
        """The amount guard still bites — it just no longer calls Scopus to do it.

        The stored remuneration says 85,000 while the verified columns price to
        something else, so confirming 85,000 must be refused.
        """
        claim = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0,
                            ticket="LC-PV", snip=1.0, quartile="Q2")
        Claim.objects.filter(pk=claim.id).update(remuneration=85000.0, snip=2.0)
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

    def test_clear_scopus_down_leaves_status_untouched(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, remuneration=85000.0, ticket="LC-502")
        self.client.force_login(self.admin)
        with patch("core.api.verify_publication", return_value={"ok": False}):
            r = self.client.post(
                f"/api/claims/{claim.id}/clear",
                data=json.dumps({"expected_amount": 85000.0}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 502, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertEqual(claim.remuneration, 85000.0)

    def test_mark_paid_does_not_depend_on_scopus(self):
        """Payment recomputes from stored verified values, so an outage cannot
        stop Finance paying a claim that clearing already verified.

        This used to answer 502. `skip_external` is super-admin only, so a
        Finance user had no way through — while bulk mark-paid, which has never
        called out, paid the very same claim. A guard that bulk skips is not a
        guard, and clearing is where external re-verification belongs.
        """
        claim = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-P502")
        self.client.force_login(self.finance)
        with patch("core.api.verify_publication", return_value={"ok": False}) as called:
            r = self.client.post(
                f"/api/claims/{claim.id}/mark-paid",
                data=json.dumps({"expected_amount": 85000.0}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        called.assert_not_called()
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)

    # ---- second signature ----

    def _high_value_cleared(self, ticket="LC-HV"):
        # snip 2.0 × 55000 + Q1 50000 = 160000, above the 100000 default.
        return self._claim(
            status=ClaimStatus.CLEARED, remuneration=160000.0, ticket=ticket,
            snip=2.0, quartile="Q1", cleared_by=self.admin,
        )

    def test_high_value_needs_a_distinct_second_approver(self):
        claim = self._high_value_cleared()
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 160000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("second approver", r.json()["detail"])

        # The person who cleared it cannot be the second signature.
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/claims/{claim.id}/second-approve",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

        self.client.force_login(self.admin2)
        r = self.client.post(
            f"/api/claims/{claim.id}/second-approve",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["second_approved_by_name"], "Second Admin")

        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 160000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_second_approval_is_off_when_the_threshold_is_zero(self):
        """It takes two admins to satisfy. With one admin an always-on rule
        jammed every large claim with nobody able to release it."""
        from core.api import _invalidate_threshold_cache

        FormulaConfig.objects.filter(active=True).update(high_value_threshold=0)
        _invalidate_threshold_cache()
        claim = self._high_value_cleared("LC-OFF")
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 160000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["needs_second_approval"])

    def test_principal_cannot_second_approve(self):
        """The Principal observes and reports; it holds no money action."""
        principal = User.objects.create_user(
            email="life-principal@test.edu", password="pass", name="Principal",
            role=Role.PRINCIPAL,
        )
        claim = self._high_value_cleared("LC-PRIN")
        self.client.force_login(principal)
        r = self.client.post(
            f"/api/claims/{claim.id}/second-approve",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)

    def test_second_approval_refused_below_the_threshold(self):
        claim = self._claim(
            status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-LOW",
            cleared_by=self.admin,
        )
        self.client.force_login(self.admin2)
        r = self.client.post(
            f"/api/claims/{claim.id}/second-approve",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    # ---- void ----

    def _paid_claim(self, ticket="LC-PAID"):
        claim = self._claim(status=ClaimStatus.PAID, remuneration=85000.0, ticket=ticket)
        claim.voucher_number = "V100"
        claim.save(update_fields=["voucher_number"])
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 8, 1), amount=85000.0,
            faculty_name=self.faculty.name, voucher_number="V100",
        )
        return claim

    def test_void_writes_a_reversing_ledger_row_and_returns_to_cleared(self):
        claim = self._paid_claim()
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/void-payment",
            data=json.dumps({"note": "Paid against the wrong voucher"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self.assertIsNone(claim.paid_at)
        rows = list(claim.ledger_rows.order_by("created_at"))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1].amount, -85000.0)
        self.assertIn("VOID", rows[1].voucher_number)
        # The ledger is append-only: nothing was deleted.
        self.assertEqual(sum(r.amount for r in rows), 0.0)

    def test_a_zero_value_payment_can_still_be_voided(self):
        """Count-only filings and claims short of the SEC-reference minimum are
        recorded as PAID carrying nothing. Requiring a positive ledger total to
        void left those stuck in PAID with no way back."""
        claim = self._claim(
            status=ClaimStatus.PAID, remuneration=0.0, ticket="LC-ZERO",
        )
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 8, 1), amount=0.0,
            faculty_name=self.faculty.name, voucher_number="V-ZERO",
        )
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/void-payment",
            data=json.dumps({"note": "Paid at zero against the wrong ticket"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self.assertEqual(claim.ledger_rows.count(), 2, "the reversal is still recorded")

    def test_research_cell_can_override_a_stranded_status(self):
        """RESEARCH_CELL is folded into the admin role everywhere else, and the
        research cell's own login still carries it."""
        cell = User.objects.create_user(
            email="life-cell@test.edu", password="pass", name="Research Cell",
            role=Role.RESEARCH_CELL,
        )
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.HOD_APPROVED,
            ticket_number="ERP-CELL-1", paper_title="Stranded For The Cell",
        )
        self.client.force_login(cell)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/override-status",
            data=json.dumps({"to_status": "SUBMITTED", "note": "Rescue stranded import"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_void_requires_a_reason_and_a_paid_claim(self):
        claim = self._paid_claim("LC-PAID2")
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/void-payment",
            data=json.dumps({"note": "oops"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        cleared = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-NP")
        r = self.client.post(
            f"/api/claims/{cleared.id}/void-payment",
            data=json.dumps({"note": "A long enough reason here"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_void_then_repay_is_allowed(self):
        claim = self._paid_claim("LC-PAID3")
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/void-payment",
            data=json.dumps({"note": "Wrong amount was disbursed"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V101", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)

    # ---- override & withdraw ----

    def test_override_rescues_a_stranded_erp_status(self):
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.HOD_APPROVED,
            ticket_number="ERP-RAW-77", paper_title="Stranded ERP Claim",
        )
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/override-status",
            data=json.dumps({"to_status": "SUBMITTED", "note": "Rescue stranded import"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, "override is super-admin only")
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/override-status",
            data=json.dumps({"to_status": "SUBMITTED", "note": "Rescue stranded import"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertTrue(
            AuditLog.objects.filter(action="STATUS_OVERRIDE", entity_id=claim.id).exists()
        )

    def test_override_refuses_paid_and_bad_targets(self):
        claim = self._paid_claim("LC-PAID4")
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/admin/claims/{claim.id}/override-status",
            data=json.dumps({"to_status": "CLEARED", "note": "Trying to unsettle a payment"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        other = self._claim(status=ClaimStatus.SUBMITTED, remuneration=None, ticket="LC-OV2")
        r = self.client.post(
            f"/api/admin/claims/{other.id}/override-status",
            data=json.dumps({"to_status": "PAID", "note": "Trying to skip finance"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    # ---- bulk mark-paid ----

    def test_bulk_mark_paid_writes_a_ledger_row_per_claim(self):
        a = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-BP1")
        b = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-BP2")
        self.client.force_login(self.finance)
        r = self.client.post(
            "/api/admin/bulk-mark-paid",
            data=json.dumps(
                {
                    "items": [
                        {"claim_id": a.id, "voucher_number": "V-A", "expected_amount": 85000.0},
                        {"claim_id": b.id, "voucher_number": "V-B", "expected_amount": 85000.0},
                    ],
                    "note": "August batch",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["paid"], 2)
        self.assertEqual(body["skipped"], [])
        for claim, voucher in ((a, "V-A"), (b, "V-B")):
            claim.refresh_from_db()
            self.assertEqual(claim.status, ClaimStatus.PAID)
            self.assertEqual(claim.voucher_number, voucher)
            self.assertEqual(claim.ledger_rows.count(), 1)
            self.assertEqual(claim.ledger_rows.first().voucher_number, voucher)

    def test_bulk_mark_paid_skips_bad_rows_with_reasons(self):
        good = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-BP3")
        drifted = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-BP4")
        high = self._high_value_cleared("LC-BP5")
        self.client.force_login(self.finance)
        r = self.client.post(
            "/api/admin/bulk-mark-paid",
            data=json.dumps(
                {
                    "items": [
                        {"claim_id": good.id, "expected_amount": 85000.0},
                        # Confirms a number the recomputation will not produce.
                        {"claim_id": drifted.id, "expected_amount": 12345.0},
                        # High-value with no second approver.
                        {"claim_id": high.id, "expected_amount": 160000.0},
                        {"claim_id": "no-such-id", "expected_amount": 1.0},
                    ]
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["paid"], 1)
        reasons = {s["id"]: s["reason"] for s in body["skipped"]}
        self.assertIn(drifted.id, reasons)
        self.assertIn("second approver", reasons[high.id])
        self.assertIn("no-such-id", reasons)
        drifted.refresh_from_db()
        self.assertEqual(drifted.status, ClaimStatus.CLEARED, "a skipped row is untouched")
        high.refresh_from_db()
        self.assertEqual(high.status, ClaimStatus.CLEARED)

    def test_bulk_mark_paid_is_finance_only(self):
        claim = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="LC-BP6")
        self.client.force_login(self.faculty)
        r = self.client.post(
            "/api/admin/bulk-mark-paid",
            data=json.dumps({"items": [{"claim_id": claim.id, "expected_amount": 85000.0}]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403)

    def test_withdraw_is_owner_only_and_submitted_only(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, remuneration=None, ticket="LC-WD")
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/claims/{claim.id}/withdraw",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 404, "only the owner can withdraw")
        self.client.force_login(self.faculty)
        r = self.client.post(
            f"/api/claims/{claim.id}/withdraw",
            data=json.dumps({}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DRAFT)
        self.assertEqual(claim.ticket_number, "LC-WD", "the ticket number survives withdrawal")


class PaginationTests(TestCase):
    """The claim lists paginate instead of silently truncating at 200 rows."""

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.faculty = User.objects.create_user(
            email="page-fac@test.edu", password="pass", name="Page Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()
        for i in range(7):
            Claim.objects.create(
                owner=self.faculty, status=ClaimStatus.SUBMITTED,
                ticket_number=f"PG-{i}", paper_title=f"Paged Paper {i}",
            )

    def test_envelope_and_offset(self):
        self.client.force_login(self.faculty)
        body = self.client.get("/api/claims?limit=3").json()
        self.assertEqual(body["total"], 7)
        self.assertEqual(body["limit"], 3)
        self.assertEqual(len(body["results"]), 3)
        page2 = self.client.get("/api/claims?limit=3&offset=3").json()
        self.assertEqual(len(page2["results"]), 3)
        page3 = self.client.get("/api/claims?limit=3&offset=6").json()
        self.assertEqual(len(page3["results"]), 1)
        ids = {c["id"] for c in body["results"]} | {c["id"] for c in page2["results"]} | {
            c["id"] for c in page3["results"]
        }
        self.assertEqual(len(ids), 7, "pages must not overlap or drop rows")

    def test_limit_is_clamped(self):
        self.client.force_login(self.faculty)
        body = self.client.get("/api/claims?limit=99999").json()
        self.assertEqual(body["limit"], 200)

    def test_sort_by_title(self):
        self.client.force_login(self.faculty)
        body = self.client.get("/api/claims?sort=title&limit=10").json()
        titles = [c["paper_title"] for c in body["results"]]
        self.assertEqual(titles, sorted(titles))

    def test_ledger_is_paginated(self):
        finance = User.objects.create_user(
            email="page-fin@test.edu", password="pass", name="Page Fin", role=Role.FINANCE,
        )
        for i in range(3):
            claim = Claim.objects.create(
                owner=self.faculty, status=ClaimStatus.PAID,
                ticket_number=f"LD-{i}", paper_title=f"Ledger {i}",
            )
            PaidLedger.objects.create(
                claim=claim, payout_month=date(2026, 8, 1), amount=1000 + i,
                faculty_name=self.faculty.name,
            )
        self.client.force_login(finance)
        body = self.client.get("/api/admin/ledger?limit=2").json()
        self.assertEqual(body["total"], 3)
        self.assertEqual(body["limit"], 2)
        self.assertEqual(len(body["results"]), 2)
        page2 = self.client.get("/api/admin/ledger?limit=2&offset=2").json()
        self.assertEqual(len(page2["results"]), 1)


class SuperAdminPowersTests(TestCase):
    """Editing any claim, moving one to its real owner, and viewing as somebody
    else -- each recorded, and impersonation unable to write."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="power-admin@test.edu", password="pass", name="Power Admin",
            role=Role.SUPER_ADMIN,
        )
        self.other_admin = User.objects.create_user(
            email="power-admin2@test.edu", password="pass", name="Other Admin",
            role=Role.SUPER_ADMIN,
        )
        self.alice = User.objects.create_user(
            email="alice@test.edu", password="pass", name="Alice", role=Role.FACULTY,
            department="ECE", staff_id="STF-A", biometric_id="BIO-A",
        )
        self.bob = User.objects.create_user(
            email="bob@test.edu", password="pass", name="Bob", role=Role.FACULTY,
            department="CSE", staff_id="STF-B", biometric_id="BIO-B",
        )
        self.claim = Claim.objects.create(
            owner=self.alice, status=ClaimStatus.PAID, ticket_number="PWR-1",
            paper_title="A paid paper", remuneration=5000, staff_id="STF-A",
            biometric_id="BIO-A",
        )
        PaidLedger.objects.create(
            claim=self.claim, payout_month=date(2026, 1, 1), amount=5000,
            faculty_name="Alice", staff_id="STF-A",
        )
        self.client = Client()

    def post(self, url, body):
        return self.client.post(url, data=json.dumps(body), content_type="application/json")

    # ---- editing ----

    def test_an_edit_needs_a_reason(self):
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/claims/{self.claim.id}/edit",
                      {"fields": {"paper_title": "Corrected"}, "reason": "short"})
        self.assertEqual(r.status_code, 400, r.content)

    def test_an_edit_records_before_and_after(self):
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/claims/{self.claim.id}/edit",
                      {"fields": {"paper_title": "Corrected title"},
                       "reason": "Title was truncated by the ERP import"})
        self.assertEqual(r.status_code, 200, r.content)
        self.claim.refresh_from_db()
        self.assertEqual(self.claim.paper_title, "Corrected title")
        log = AuditLog.objects.filter(action="CLAIM_ADMIN_EDIT").first()
        self.assertIsNotNone(log)
        detail = json.loads(log.detail_json)
        self.assertEqual(detail["before"]["paper_title"], "A paid paper")
        self.assertEqual(detail["after"]["paper_title"], "Corrected title")

    def test_changing_a_settled_amount_keeps_the_ledger_balanced(self):
        """The ledger is append-only, so a correction is a new row -- the
        history keeps both what was paid and what it became."""
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/claims/{self.claim.id}/edit",
                      {"fields": {"remuneration": 7500},
                       "reason": "Contested: SNIP was wrong at the time of payment"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["ledger_adjusted"])
        total = sum(PaidLedger.objects.filter(claim=self.claim).values_list("amount", flat=True))
        self.assertAlmostEqual(total, 7500, places=2)
        self.assertEqual(PaidLedger.objects.filter(claim=self.claim).count(), 2)

    def test_only_a_super_admin_may_edit(self):
        self.client.force_login(self.alice)
        r = self.post(f"/api/admin/claims/{self.claim.id}/edit",
                      {"fields": {"remuneration": 999999}, "reason": "trying it on"})
        self.assertEqual(r.status_code, 403)

    # ---- reassignment ----

    def test_reassigning_moves_the_claim_and_its_ledger(self):
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/claims/{self.claim.id}/reassign",
                      {"owner_email": "bob@test.edu",
                       "reason": "Imported against the wrong staff id"})
        self.assertEqual(r.status_code, 200, r.content)
        self.claim.refresh_from_db()
        self.assertEqual(self.claim.owner, self.bob)
        self.assertEqual(self.claim.staff_id, "STF-B")
        row = PaidLedger.objects.get(claim=self.claim)
        self.assertEqual(row.staff_id, "STF-B")
        self.assertEqual(row.faculty_name, "Bob")

    # ---- impersonation ----

    def test_impersonation_can_read_but_not_write(self):
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/impersonate/{self.alice.id}", {})
        self.assertEqual(r.status_code, 200, r.content)

        me = self.client.get("/api/auth/me").json()
        self.assertEqual(me["email"], "alice@test.edu")
        self.assertTrue(me["read_only"])
        self.assertEqual(me["impersonated_by"]["email"], "power-admin@test.edu")

        # Reading is fine.
        self.assertEqual(self.client.get("/api/claims").status_code, 200)
        # Writing is not, whatever the endpoint.
        blocked = self.post("/api/claims", {"paper_title": "Filed as Alice"})
        self.assertEqual(blocked.status_code, 403)
        self.assertIn("Stop impersonating", blocked.json()["detail"])

    def test_stopping_returns_the_admin_to_themselves(self):
        self.client.force_login(self.admin)
        self.post(f"/api/admin/impersonate/{self.alice.id}", {})
        r = self.post("/api/admin/stop-impersonating", {})
        self.assertEqual(r.status_code, 200, r.content)
        me = self.client.get("/api/auth/me").json()
        self.assertEqual(me["email"], "power-admin@test.edu")
        self.assertNotIn("impersonated_by", me)
        self.assertTrue(AuditLog.objects.filter(action="IMPERSONATE_START").exists())
        self.assertTrue(AuditLog.objects.filter(action="IMPERSONATE_STOP").exists())

    def test_a_super_admin_cannot_be_impersonated(self):
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/impersonate/{self.other_admin.id}", {})
        self.assertEqual(r.status_code, 403)

    def test_faculty_cannot_impersonate(self):
        self.client.force_login(self.alice)
        r = self.post(f"/api/admin/impersonate/{self.bob.id}", {})
        self.assertEqual(r.status_code, 403)


class FaultsReportTests(TestCase):
    """The operations screen: each finding was a query somebody ran once by hand."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="faults-admin@test.edu", password="pass", name="Faults Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def faults(self):
        r = self.client.get("/api/admin/faults")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        return {f["key"]: f for g in body["groups"] for f in g["faults"]}, body

    def test_a_faculty_without_a_biometric_id_is_flagged_as_blocking(self):
        User.objects.create_user(
            email="nobio@test.edu", password="p", name="No Bio", role=Role.FACULTY,
        )
        found, _ = self.faults()
        self.assertEqual(found["no_biometric"]["count"], 1)
        # They cannot submit at all, so this is not merely "needs attention".
        self.assertEqual(found["no_biometric"]["severity"], "critical")

    def test_a_claim_stuck_in_review_is_flagged_with_its_ticket(self):
        fac = User.objects.create_user(
            email="stuck@test.edu", password="p", name="Stuck", role=Role.FACULTY,
            biometric_id="BIO-1", department="ECE", scopus_author_id="1",
        )
        old = timezone.now() - timedelta(days=40)
        c = Claim.objects.create(
            owner=fac, status=ClaimStatus.SUBMITTED, ticket_number="STUCK-1",
            paper_title="Waiting a long time",
        )
        Claim.objects.filter(pk=c.pk).update(updated_at=old)
        found, _ = self.faults()
        self.assertEqual(found["stale_submitted"]["count"], 1)
        self.assertIn("STUCK-1", found["stale_submitted"]["sample"])

    def test_a_payment_with_no_amount_is_reported(self):
        fac = User.objects.create_user(
            email="zero@test.edu", password="p", name="Zero", role=Role.FACULTY,
            biometric_id="BIO-2", department="ECE", scopus_author_id="2",
        )
        Claim.objects.create(
            owner=fac, status=ClaimStatus.PAID, ticket_number="ZERO-1",
            paper_title="Paid nothing", remuneration=0,
        )
        found, _ = self.faults()
        self.assertEqual(found["paid_zero"]["count"], 1)

    def test_a_clean_database_reports_nothing(self):
        found, body = self.faults()
        self.assertEqual(body["total"], 0)
        self.assertEqual(body["urgent"], 0)

    def test_only_a_user_manager_may_read_it(self):
        fac = User.objects.create_user(
            email="nosy@test.edu", password="p", name="Nosy", role=Role.FACULTY,
        )
        c = Client()
        c.force_login(fac)
        self.assertEqual(c.get("/api/admin/faults").status_code, 403)


class DatabaseUrlParsingTests(TestCase):
    """Cloud SQL is reached over a unix socket, which libpq spells as a query
    parameter rather than a hostname."""

    def parse(self, url):
        from config.settings import _database_from_url

        return _database_from_url(url)

    def test_a_unix_socket_url_becomes_the_host(self):
        d = self.parse("postgres://u:p@/appdb?host=/cloudsql/proj:asia-south1:inst")
        self.assertEqual(d["HOST"], "/cloudsql/proj:asia-south1:inst")
        self.assertEqual(d["NAME"], "appdb")
        self.assertEqual(d["USER"], "u")
        # A socket has no port; sending one makes libpq try TCP and fail.
        self.assertEqual(d["PORT"], "")

    def test_a_tcp_url_is_unchanged(self):
        d = self.parse("postgres://u:p@db.example.com:6543/appdb?sslmode=require")
        self.assertEqual(d["HOST"], "db.example.com")
        self.assertEqual(d["PORT"], "6543")
        self.assertEqual(d["OPTIONS"]["sslmode"], "require")

    def test_a_password_with_url_characters_survives(self):
        d = self.parse("postgres://u:p%40ss%2Fword@host/appdb")
        self.assertEqual(d["PASSWORD"], "p@ss/word")


class CountOnlyKeepsItsMetricsTests(TestCase):
    """A count-only filing pays nothing, but it is still the institution's
    record of the publication -- so it keeps SNIP, quartile and the rest."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="count-only@test.edu", password="pass", name="Count Only",
            role=Role.FACULTY, department="ECE", staff_id="STF-CO",
            biometric_id="BIO-CO",
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def _file(self, **extra):
        payload = {
            "paper_title": "A paper counted but not paid",
            "journal_title": "Journal of Counting",
            "claim_reason": "COUNT_ONLY",
            "snip": 2.4,
            "quartile": "Q1",
            "total_authors": 2,
            "author_position": 1,
            "indexing_levels": ["Scopus"],
            "publication_types": ["Regular Research Article"],
            **extra,
        }
        r = self.client.post(
            "/api/claims", data=json.dumps(payload), content_type="application/json"
        )
        self.assertIn(r.status_code, (200, 201), r.content)
        return Claim.objects.get(pk=r.json()["id"])

    def test_declared_snip_survives_a_count_only_filing(self):
        """It used to be overwritten with 0, which threw away a real fact about
        the journal to achieve a zero the student flag already guarantees."""
        claim = self._file()
        self.assertEqual(claim.claim_reason, "COUNT_ONLY")
        self.assertTrue(claim.is_student_publication)
        self.assertEqual(claim.self_reported_snip, 2.4)

    def test_it_still_pays_nothing(self):
        claim = self._file()
        self.assertEqual(claim.remuneration, 0)

    def test_the_quartile_is_kept_too(self):
        claim = self._file()
        self.assertEqual(claim.self_reported_quartile, "Q1")

    def test_switching_to_an_incentive_claim_prices_the_kept_figures(self):
        claim = self._file()
        r = self.client.patch(
            f"/api/claims/{claim.id}",
            data=json.dumps({"claim_reason": "INCENTIVE"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertFalse(claim.is_student_publication)
        # The declared SNIP is still there to price a draft estimate from.
        self.assertEqual(claim.self_reported_snip, 2.4)


class ReportGroupingTests(TestCase):
    """One idea, one bar. The report grouped on the raw column, so the ways a
    blank can be spelt each got a row of their own."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="rep-admin@test.edu", password="pass", name="Rep Admin",
            role=Role.SUPER_ADMIN,
        )
        fac = User.objects.create_user(
            email="rep-fac@test.edu", password="pass", name="Rep Faculty",
            role=Role.FACULTY, department="ECE",
        )
        # The same "no quartile" idea, written four different ways.
        for i, q in enumerate(["No quartile", "no quartile", "-", "", None]):
            Claim.objects.create(
                owner=fac, status=ClaimStatus.PAID, ticket_number=f"RG-{i}",
                paper_title=f"Report grouping {i}", quartile=q, remuneration=100,
            )
        Claim.objects.create(
            owner=fac, status=ClaimStatus.PAID, ticket_number="RG-Q1",
            paper_title="A ranked one", quartile="Q1", remuneration=500,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def test_blank_spellings_fold_into_one_row(self):
        body = self.client.get("/api/reports").json()
        rows = {r["key"]: r for r in body["by_quartile"]}
        self.assertIn("Q1", rows)
        self.assertEqual(rows["Q1"]["count"], 1)

        blanks = [k for k in rows if k.lower() in ("no quartile", "-", "")]
        self.assertEqual(len(blanks), 1, f"expected one blank bucket, got {blanks}")
        self.assertEqual(rows[blanks[0]]["count"], 5)
        self.assertEqual(rows[blanks[0]]["amount"], 500.0)

    def test_rows_stay_sorted_by_count(self):
        body = self.client.get("/api/reports").json()
        counts = [r["count"] for r in body["by_quartile"]]
        self.assertEqual(counts, sorted(counts, reverse=True))


class ClaimSearchTests(TestCase):
    """Search has to reach the whole queue, not the page already on screen."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="search-admin@test.edu", password="pass", name="Search Admin",
            role=Role.SUPER_ADMIN,
        )
        self.fac = User.objects.create_user(
            email="search-fac@test.edu", password="pass", name="Ada Researcher",
            role=Role.FACULTY, department="EEE",
        )
        # More rows than one page, with the interesting one buried at the end.
        for i in range(60):
            Claim.objects.create(
                owner=self.fac, status=ClaimStatus.SUBMITTED,
                ticket_number=f"SR-{i:03d}", paper_title=f"Routine paper {i}",
                journal_title="Journal of Routine",
            )
        Claim.objects.create(
            owner=self.fac, status=ClaimStatus.SUBMITTED, ticket_number="SR-NEEDLE",
            paper_title="Photovoltaic haystack analysis", journal_title="Solar Reports",
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_search_finds_a_ticket_beyond_the_first_page(self):
        body = self.get("/api/claims?limit=50&offset=0&q=Photovoltaic")
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["results"][0]["ticket_number"], "SR-NEEDLE")

    def test_search_matches_ticket_journal_and_owner(self):
        for term, expected in (
            ("SR-NEEDLE", "SR-NEEDLE"),
            ("Solar Reports", "SR-NEEDLE"),
            ("Ada Researcher", None),
        ):
            body = self.get(f"/api/claims?limit=5&q={term}")
            if expected:
                self.assertEqual(body["total"], 1, term)
                self.assertEqual(body["results"][0]["ticket_number"], expected, term)
            else:
                # The owner's name matches every one of their claims.
                self.assertEqual(body["total"], 61, term)

    def test_search_combines_with_the_status_filter(self):
        Claim.objects.filter(ticket_number="SR-NEEDLE").update(status=ClaimStatus.PAID)
        self.assertEqual(
            self.get("/api/claims?q=Photovoltaic&status=SUBMITTED")["total"], 0
        )
        self.assertEqual(self.get("/api/claims?q=Photovoltaic&status=PAID")["total"], 1)

    def test_search_stays_inside_what_the_role_may_see(self):
        other = User.objects.create_user(
            email="search-other@test.edu", password="pass", name="Other Faculty",
            role=Role.FACULTY,
        )
        c = Client()
        c.force_login(other)
        r = c.get("/api/claims?q=Photovoltaic")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["total"], 0, "search must not leak another account's claims")


class QualityOfLifeTests(TestCase):
    """The batch of smaller hardening and usability endpoints."""

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.faculty = User.objects.create_user(
            email="qol-fac@test.edu", password="pass", name="QoL Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.admin = User.objects.create_user(
            email="qol-admin@test.edu", password="pass", name="QoL Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()

    def test_login_locks_after_repeated_failures(self):
        from django.core.cache import cache

        cache.clear()
        for _ in range(10):
            r = self.client.post(
                "/api/auth/login",
                data=json.dumps({"email": "qol-fac@test.edu", "password": "wrong"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 401)
        r = self.client.post(
            "/api/auth/login",
            data=json.dumps({"email": "qol-fac@test.edu", "password": "pass"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 429, "the right password after lockout must still wait")
        # The refusal tells the person how long, and how to get unlocked now.
        detail = r.json()["detail"]
        self.assertIn("minute", detail)
        self.assertIn("research cell", detail)
        cache.clear()

    def test_repeated_failures_hint_at_password_reset(self):
        from django.core.cache import cache

        cache.clear()
        last = None
        for _ in range(4):
            last = self.client.post(
                "/api/auth/login",
                data=json.dumps({"email": "qol-fac@test.edu", "password": "wrong"}),
                content_type="application/json",
            )
        self.assertEqual(last.status_code, 401)
        self.assertIn("research cell", last.json()["detail"])
        cache.clear()

    def test_admin_password_reset_unlocks_a_locked_account(self):
        from django.core.cache import cache

        cache.clear()
        for _ in range(10):
            self.client.post(
                "/api/auth/login",
                data=json.dumps({"email": "qol-fac@test.edu", "password": "wrong"}),
                content_type="application/json",
            )
        locked = Client()
        r = locked.post(
            "/api/auth/login",
            data=json.dumps({"email": "qol-fac@test.edu", "password": "pass"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 429)

        self.client.force_login(self.admin)
        r = self.client.post(
            "/api/admin/reset-password",
            data=json.dumps({"email": "qol-fac@test.edu", "password": "fresh-start-9"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

        r = locked.post(
            "/api/auth/login",
            data=json.dumps({"email": "qol-fac@test.edu", "password": "fresh-start-9"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, "a reset must unlock the account immediately")
        cache.clear()

    def test_successful_login_resets_the_failure_counter(self):
        from django.core.cache import cache

        cache.clear()
        for _ in range(3):
            self.client.post(
                "/api/auth/login",
                data=json.dumps({"email": "qol-fac@test.edu", "password": "wrong"}),
                content_type="application/json",
            )
        r = self.client.post(
            "/api/auth/login",
            data=json.dumps({"email": "qol-fac@test.edu", "password": "pass"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        cache.clear()

    def test_formula_sheet_is_not_readable_by_every_login(self):
        self.client.force_login(self.faculty)
        self.assertEqual(self.client.get("/api/admin/formula").status_code, 403)
        self.client.force_login(self.admin)
        self.assertEqual(self.client.get("/api/admin/formula").status_code, 200)

    def test_admin_cannot_demote_or_deactivate_themselves(self):
        self.client.force_login(self.admin)
        r = self.client.patch(
            f"/api/admin/users/{self.admin.id}",
            data=json.dumps({"role": "FACULTY"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        r = self.client.patch(
            f"/api/admin/users/{self.admin.id}",
            data=json.dumps({"active": False}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.admin.refresh_from_db()
        self.assertEqual(self.admin.role, Role.SUPER_ADMIN)
        self.assertTrue(self.admin.active)

    def test_user_update_audits_before_and_after(self):
        self.client.force_login(self.admin)
        r = self.client.patch(
            f"/api/admin/users/{self.faculty.id}",
            data=json.dumps({"department": "ECE"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        log = AuditLog.objects.filter(action="USER_UPDATE", entity_id=self.faculty.id).first()
        detail = json.loads(log.detail_json)
        self.assertEqual(detail["department"], {"from": "CSE", "to": "ECE"})

    def test_audit_log_filters_and_paginates(self):
        for i in range(5):
            AuditLog.objects.create(
                actor=self.admin, action="CLEAR", entity="Claim", entity_id=f"c-{i}"
            )
        AuditLog.objects.create(
            actor=self.admin, action="MARK_PAID", entity="Claim", entity_id="c-paid",
            detail_json=json.dumps({"note": "x"}),
        )
        self.client.force_login(self.admin)
        body = self.client.get("/api/admin/audit?action=CLEAR&limit=2").json()
        self.assertEqual(body["total"], 5)
        self.assertEqual(len(body["results"]), 2)
        body = self.client.get("/api/admin/audit?q=c-paid").json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["results"][0]["action"], "MARK_PAID")
        self.assertIn("detail_json", body["results"][0])

    def test_reports_export_xlsx(self):
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, ticket_number="QOL-X1",
            paper_title="=SUM(A1:A2) not a formula", remuneration=1000.0,
            publication_year=2026,
        )
        self.client.force_login(self.admin)
        r = self.client.get("/api/reports/export?fmt=xlsx")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("spreadsheetml", r["Content-Type"])
        import io as _io

        from openpyxl import load_workbook

        wb = load_workbook(_io.BytesIO(r.content))
        ws = wb.active
        self.assertEqual(ws["A1"].value, "Ticket")
        titles = [row[5].value for row in ws.iter_rows(min_row=2)]
        self.assertTrue(any(t and "not a formula" in t and t.startswith("'") for t in titles),
                        "formula-looking cells must be neutralised")


class NotificationApiTests(TestCase):
    """Per-item read, the unread counter, and deep links that actually land."""

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.faculty = User.objects.create_user(
            email="note-fac@test.edu", password="pass", name="Note Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.other = User.objects.create_user(
            email="note-other@test.edu", password="pass", name="Other",
            role=Role.FACULTY,
        )
        self.admin = User.objects.create_user(
            email="note-admin@test.edu", password="pass", name="Note Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()

    def _note(self, user, **kw):
        kw.setdefault("title", "Ticket update")
        return Notification.objects.create(user=user, **kw)

    def test_unread_count_counts_only_unread(self):
        self._note(self.faculty)
        self._note(self.faculty, read=True)
        self._note(self.other)
        self.client.force_login(self.faculty)
        r = self.client.get("/api/notifications/unread-count")
        self.assertEqual(r.json(), {"unread": 1})

    def test_per_item_read_is_owner_scoped(self):
        mine = self._note(self.faculty)
        theirs = self._note(self.other)
        self.client.force_login(self.faculty)
        r = self.client.post(f"/api/notifications/{mine.id}/read")
        self.assertEqual(r.status_code, 200, r.content)
        mine.refresh_from_db()
        self.assertTrue(mine.read)
        r = self.client.post(f"/api/notifications/{theirs.id}/read")
        self.assertEqual(r.status_code, 404, "someone else's notification must 404")
        theirs.refresh_from_db()
        self.assertFalse(theirs.read)

    def test_admin_submission_notification_links_to_the_clearing_queue(self):
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000950", paper_title="Deep Link Paper",
        )
        from core.api import _notify_admins

        _notify_admins(claim, "New ticket", "body")
        note = Notification.objects.filter(user=self.admin, claim_id=claim.id).first()
        self.assertIsNotNone(note)
        self.assertEqual(note.href, f"/admin/clearing?claim={claim.id}")


class JobInfraTests(TestCase):
    """Background work is queued, heartbeats, and resumes after a dead worker."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="job-admin@test.edu", password="pass", name="Job Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()

    def _batch(self, **kw):
        from core.models import MonthlyBatch

        kw.setdefault("name", "August check")
        kw.setdefault("created_by", self.admin)
        return MonthlyBatch.objects.create(**kw)

    def test_process_batch_skips_already_resolved_rows(self):
        from core.models import BatchStatus, MonthlyRow
        from core.services.monthly_processor import process_batch

        batch = self._batch()
        done = MonthlyRow.objects.create(
            batch=batch, row_number=1, paper_title="Already Checked",
            author_id_raw="123", index_status="Indexed",
        )
        pending = MonthlyRow.objects.create(
            batch=batch, row_number=2, paper_title="Needs Author",
            author_id_raw="",  # errors out before any external call
        )
        process_batch(batch.id)
        batch.refresh_from_db()
        done.refresh_from_db()
        pending.refresh_from_db()
        self.assertEqual(batch.status, BatchStatus.DONE)
        self.assertIsNotNone(batch.heartbeat_at)
        self.assertEqual(done.index_status, "Indexed", "resolved rows are not re-fetched")
        self.assertTrue(pending.index_status.startswith("Error:"))

    def test_stale_running_batch_can_be_restarted(self):
        from datetime import timedelta

        from django.utils import timezone

        from core.models import BatchStatus

        fresh = self._batch(status=BatchStatus.RUNNING)
        fresh.heartbeat_at = timezone.now()
        fresh.save(update_fields=["heartbeat_at"])
        stale = self._batch(name="Stale batch", status=BatchStatus.RUNNING)
        stale.heartbeat_at = timezone.now() - timedelta(minutes=30)
        stale.save(update_fields=["heartbeat_at"])

        self.client.force_login(self.admin)
        with patch("core.api.start_batch_async") as started:
            r = self.client.post(f"/api/monthly/{fresh.id}/start")
            self.assertEqual(r.status_code, 400, "a heartbeating batch is genuinely running")
            r = self.client.post(f"/api/monthly/{stale.id}/start")
            self.assertEqual(r.status_code, 200, r.content)
            started.assert_called_once_with(stale.id)

    def test_recover_stale_batches_reenqueues(self):
        from datetime import timedelta

        from django.utils import timezone

        from core.models import BatchStatus
        from core.tasks import recover_stale_batches

        stale = self._batch(status=BatchStatus.RUNNING)
        stale.started_at = timezone.now() - timedelta(minutes=30)
        stale.save(update_fields=["started_at"])
        with patch("django_q.tasks.async_task") as enq:
            recovered = recover_stale_batches()
        self.assertEqual(recovered, [stale.id])
        enq.assert_called_once_with("core.tasks.run_monthly_batch", stale.id)

    def test_erp_import_is_queued_not_inline(self):
        import openpyxl

        wb = openpyxl.Workbook()
        buf = tempfile.SpooledTemporaryFile()
        wb.save(buf)
        buf.seek(0)
        self.client.force_login(self.admin)
        with tempfile.TemporaryDirectory() as media:
            with override_settings(MEDIA_ROOT=media):
                with patch("django_q.tasks.async_task", return_value="job-1") as enq:
                    r = self.client.post(
                        "/api/admin/erp-import",
                        data={"file": SimpleUploadedFile("erp.xlsx", buf.read())},
                    )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["queued"])
        self.assertEqual(body["job_id"], "job-1")
        enq.assert_called_once()
        self.assertEqual(enq.call_args.args[0], "core.tasks.run_erp_import")
        self.assertTrue(
            AuditLog.objects.filter(action="ERP_XLSX_IMPORT_QUEUED", actor=self.admin).exists()
        )

    def test_bulk_verify_is_queued(self):
        self.client.force_login(self.admin)
        with patch("django_q.tasks.async_task", return_value="job-2") as enq:
            r = self.client.post(
                "/api/admin/process/batch",
                data=json.dumps({"claim_ids": ["a", "b", "a"]}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["count"], 2, "duplicate ids are collapsed")
        enq.assert_called_once_with("core.tasks.run_bulk_verify", ["a", "b"], self.admin.id)


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
        # Rejection moved with clearing: admins send tickets back, not HoDs.
        self.admin = User.objects.create_user(
            email="rej-admin@test.edu", password="pass", name="A",
            role=Role.SUPER_ADMIN,
        )
        self.claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000555", paper_title="Returned Paper",
        )
        self.client = Client()

    def test_a_hod_can_no_longer_reject(self):
        self.client.force_login(self.hod)
        r = self.client.post(
            f"/api/claims/{self.claim.id}/reject",
            data=json.dumps({"note": "Not a valid reason to send back"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)

    def _reject(self, note):
        self.client.force_login(self.admin)
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

    def test_a_claimant_cannot_change_any_profile_detail(self):
        """Every field on a profile is identity -- the name on the payment, and
        the Scopus link deciding whose record a paper is checked against."""
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
        self.assertEqual(r.status_code, 403, r.content)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.name, "Identity Faculty")
        self.assertEqual(self.faculty.staff_id, "STF-REAL")
        self.assertEqual(self.faculty.biometric_id, "BIO-REAL")
        self.assertEqual(self.faculty.department, "CSE")

    def test_a_correction_can_be_requested_instead(self):
        """Locking the profile without a route means chasing somebody by email,
        so the detail stays wrong and the claim stays blocked."""
        from core.models import AuditLog

        self.client.force_login(self.faculty)
        r = self.client.post(
            "/api/auth/profile/correction",
            data=json.dumps({
                "field": "scopus_author_url",
                "proposed": "https://www.scopus.com/authid/detail.uri?authorId=123",
                "note": "This points at a different S. Kumar",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        log = AuditLog.objects.filter(action="PROFILE_CORRECTION_REQUEST").first()
        self.assertIsNotNone(log)
        self.assertEqual(json.loads(log.detail_json)["field"], "scopus_author_url")
        # Asking does not change it.
        self.faculty.refresh_from_db()
        self.assertIsNone(self.faculty.scopus_author_url)

    def test_an_unknown_field_cannot_be_requested(self):
        self.client.force_login(self.faculty)
        r = self.client.post(
            "/api/auth/profile/correction",
            data=json.dumps({"field": "role", "proposed": "SUPER_ADMIN"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_super_admin_editing_a_profile_is_audited(self):
        from core.models import AuditLog

        admin = User.objects.create_user(
            email="identity-admin@test.edu", password="pass", name="Identity Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client.force_login(admin)
        r = self.client.patch(
            "/api/auth/profile",
            data=json.dumps({"designation": "Professor"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
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

    def test_media_hidden_from_a_retired_hod_account(self):
        """HOD carries no special rights now, so it reads like any other faculty."""
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


class ScopusCandidateSearchTests(TestCase):
    """Picking the right record is the point — one silent best guess is not enough."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="candidates@test.edu", password="pass", name="Candidate Faculty",
            role=Role.FACULTY, department="CSE",
            scopus_author_url="https://www.scopus.com/authid/detail.uri?authorId=57200000000",
        )
        self.client = Client()

    @staticmethod
    def _entry(title, eid, doi=None):
        return {
            "dc:title": title,
            "eid": eid,
            "prism:doi": doi,
            "prism:publicationName": "Journal of Testing",
            "prism:coverDate": "2024-01-01",
        }

    def test_search_candidates_returns_every_match_deduped(self):
        calls = []

        def fake_search(query, count=1, sort=None):
            calls.append(query)
            return {
                "search-results": {
                    "entry": [
                        self._entry("Deep Learning for X", "2-s2.0-a", "10.1000/a"),
                        self._entry("Deep Learning for X", "2-s2.0-a", "10.1000/a"),  # dupe
                        self._entry("Deep Learning for X — Erratum", "2-s2.0-b"),
                    ]
                }
            }

        with patch("core.services.scopus._search", side_effect=fake_search):
            out = search_candidates(title="Deep Learning for X", limit=10)

        self.assertEqual([c["eid"] for c in out], ["2-s2.0-a", "2-s2.0-b"])
        # The loose fallback query must not run once the exact one has hits.
        self.assertEqual(len(calls), 1)

    def test_search_candidates_skips_the_error_stub_entry(self):
        with patch(
            "core.services.scopus._search",
            return_value={"search-results": {"entry": [{"error": "Result set was empty"}]}},
        ):
            self.assertEqual(search_candidates(title="Nothing At All"), [])

    def test_endpoint_flags_which_candidates_sit_on_the_author_profile(self):
        def fake(*, title=None, doi=None, author_id=None, limit=10):
            entries = [
                parse_search_entry(self._entry("Mine", "2-s2.0-mine", "10.1000/mine")),
                parse_search_entry(self._entry("Someone else's", "2-s2.0-other")),
            ]
            # The AU-ID-narrowed query only ever returns the author's own work.
            return [entries[0]] if author_id else entries

        self.client.force_login(self.faculty)
        with patch("core.api.search_candidates", side_effect=fake):
            r = self.client.post(
                "/api/lookup/candidates",
                data=json.dumps({"title": "Mine", "scopus_author_url": self.faculty.scopus_author_url}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["author_id"], "57200000000")
        self.assertEqual(
            [(c["eid"], c["linked_to_author"]) for c in body["candidates"]],
            [("2-s2.0-mine", True), ("2-s2.0-other", False)],
        )

    def _faculty_without_scopus(self):
        return User.objects.create_user(
            email="noscopus@test.edu", password="pass", name="No Scopus", role=Role.FACULTY
        )

    def test_endpoint_reports_unknown_linkage_without_an_author_id(self):
        self.client.force_login(self._faculty_without_scopus())
        with patch(
            "core.api.search_candidates",
            return_value=[parse_search_entry(self._entry("Mine", "2-s2.0-mine"))],
        ):
            r = self.client.post(
                "/api/lookup/candidates",
                data=json.dumps({"title": "Mine"}),
                content_type="application/json",
            )
        # None, not False — "not checked" must not read as "not linked".
        self.assertIsNone(r.json()["candidates"][0]["linked_to_author"])

    def test_endpoint_needs_something_to_search_on(self):
        # No title, no DOI, and no Scopus profile to fall back to.
        self.client.force_login(self._faculty_without_scopus())
        r = self.client.post(
            "/api/lookup/candidates", data=json.dumps({}), content_type="application/json"
        )
        self.assertEqual(r.json()["code"], "bad_payload")

    def test_endpoint_needs_a_login(self):
        r = self.client.post(
            "/api/lookup/candidates",
            data=json.dumps({"title": "Anything at all"}),
            content_type="application/json",
        )
        self.assertIn(r.status_code, (401, 403))


class ScimagoDumpTests(TestCase):
    """The dump feeds the quartile, and the quartile feeds the payout."""

    DUMP = (
        "Rank;Sourceid;Title;Type;Issn;SJR;SJR Best Quartile;Categories\n"
        "1;28773;Nature;journal;00280836, 14764687;21,507;Q1;Multidisciplinary (Q1)\n"
        # The portal quotes the category cell because it contains the delimiter.
        '2;19700;Journal of Small Things;journal;12345678;0,137;Q4;'
        '"Engineering (Q4); Computer Science (Q3)"\n'
    )

    def test_european_decimals_survive_the_import(self):
        # "0,137" parsed as 137 is a thousand-fold error next to a payout.
        self.assertEqual(parse_decimal("0,137"), 0.137)
        self.assertEqual(parse_decimal("21,507"), 21.507)
        self.assertEqual(parse_decimal("1.234,56"), 1234.56)
        self.assertEqual(parse_decimal("1,234.56"), 1234.56)
        self.assertIsNone(parse_decimal("-"))

    def test_import_loads_both_issns_and_categories(self):
        result = import_csv_text(self.DUMP, 2024)
        self.assertEqual(result["imported"], 2)

        nature = ScimagoJournal.objects.get(issn="00280836", year=2024)
        self.assertEqual(nature.eissn, "14764687")
        self.assertAlmostEqual(nature.sjr, 21.507)

        small = ScimagoJournal.objects.get(issn="12345678", year=2024)
        self.assertAlmostEqual(small.sjr, 0.137)
        cats = json.loads(small.categories_json)
        self.assertEqual(
            [(c["category"], c["quartile"]) for c in cats],
            [("Engineering", "Q4"), ("Computer Science", "Q3")],
        )

    def test_reimporting_the_same_year_updates_instead_of_duplicating(self):
        import_csv_text(self.DUMP, 2024)
        import_csv_text(self.DUMP.replace("21,507", "22,000"), 2024)
        self.assertEqual(ScimagoJournal.objects.filter(year=2024).count(), 2)
        self.assertAlmostEqual(
            ScimagoJournal.objects.get(issn="00280836", year=2024).sjr, 22.0
        )

    def test_a_bot_challenge_is_reported_as_such(self):
        challenge = httpx.Response(
            403, text="<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>"
        )
        with patch("core.services.scimago_sync.httpx.Client") as client:
            client.return_value.__enter__.return_value.get.return_value = challenge
            with self.assertRaises(ScimagoSyncError) as ctx:
                download_dump(2024)
        # The admin needs to know to upload the CSV, not that a 403 happened.
        self.assertIn("bot-protection", str(ctx.exception))
        self.assertIn("upload it here", str(ctx.exception))

    def test_a_comma_delimited_export_parses_too(self):
        csv_text = "Title,Issn,SJR,Categories\nPlain Journal,11112222,0.9,Engineering (Q2)\n"
        self.assertEqual(import_csv_text(csv_text, 2023)["imported"], 1)
        self.assertAlmostEqual(ScimagoJournal.objects.get(issn="11112222", year=2023).sjr, 0.9)


class AuthorProfileBrowseTests(TestCase):
    """Browsing your own Scopus profile is the shortest path to the right record."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="browse@test.edu", password="pass", name="Browse Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-BROWSE",
            scopus_author_url="https://www.scopus.com/authid/detail.uri?authorId=57983494200",
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    @staticmethod
    def _paper(title, eid, doi=None):
        return parse_search_entry(
            {"dc:title": title, "eid": eid, "prism:doi": doi, "prism:coverDate": "2025-02-01"}
        )

    def test_author_id_alone_lists_the_profile_newest_first(self):
        seen = {}

        def fake(*, title=None, doi=None, author_id=None, limit=10, sort=None):
            seen.update({"author_id": author_id, "sort": sort, "title": title})
            return [self._paper("Newest", "2-s2.0-1"), self._paper("Older", "2-s2.0-2")]

        with patch("core.api.search_candidates", side_effect=fake):
            r = self.client.post(
                "/api/lookup/candidates", data=json.dumps({}), content_type="application/json"
            )
        body = r.json()
        self.assertEqual(seen["author_id"], "57983494200")
        self.assertEqual(seen["sort"], "-coverDate")
        self.assertIsNone(seen["title"])
        self.assertTrue(body["by_author"])
        # Everything on the profile is linked by construction.
        self.assertTrue(all(c["linked_to_author"] for c in body["candidates"]))

    def test_a_paper_already_ticketed_is_flagged(self):
        Claim.objects.create(
            owner=self.faculty, paper_title="Newest", doi="10.1000/mine",
            status=ClaimStatus.SUBMITTED,
        )
        with patch(
            "core.api.search_candidates",
            return_value=[
                self._paper("Newest", "2-s2.0-1", "10.1000/mine"),
                self._paper("Other", "2-s2.0-2", "10.1000/other"),
            ],
        ):
            r = self.client.post(
                "/api/lookup/candidates", data=json.dumps({}), content_type="application/json"
            )
        self.assertEqual(
            [c["already_claimed"] for c in r.json()["candidates"]], [True, False]
        )

    def test_a_rejected_ticket_does_not_block_refiling(self):
        Claim.objects.create(
            owner=self.faculty, paper_title="Newest", doi="10.1000/mine",
            status=ClaimStatus.REJECTED,
        )
        with patch(
            "core.api.search_candidates",
            return_value=[self._paper("Newest", "2-s2.0-1", "10.1000/mine")],
        ):
            r = self.client.post(
                "/api/lookup/candidates", data=json.dumps({}), content_type="application/json"
            )
        self.assertFalse(r.json()["candidates"][0]["already_claimed"])

    def test_faculty_cannot_probe_another_users_claims(self):
        other = User.objects.create_user(
            email="other@test.edu", password="pass", name="Other", role=Role.FACULTY
        )
        Claim.objects.create(
            owner=other, paper_title="Theirs", doi="10.1000/theirs",
            status=ClaimStatus.SUBMITTED,
        )
        with patch(
            "core.api.search_candidates",
            return_value=[self._paper("Theirs", "2-s2.0-9", "10.1000/theirs")],
        ):
            r = self.client.post(
                "/api/lookup/candidates",
                data=json.dumps({"owner_id": other.id}),
                content_type="application/json",
            )
        # owner_id is ignored for a non-admin, so their ticket stays invisible.
        self.assertFalse(r.json()["candidates"][0]["already_claimed"])


class ZeroPayoutExplanationTests(TestCase):
    """A bare ₹0.00 reads as a broken formula."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="calcnote@test.edu", password="pass", name="Calc", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def _calc(self, **payload):
        return self.client.post(
            "/api/calculate", data=json.dumps(payload), content_type="application/json"
        ).json()

    def test_count_only_explains_itself(self):
        body = self._calc(snip=0, quartile="Q1", total_authors=1, author_position=1,
                          is_student_publication=True)
        self.assertEqual(body["remuneration"], 0)
        self.assertIn("publication count only", body["note"])

    def test_a_paying_combination_carries_no_note(self):
        body = self._calc(snip=1.5, quartile="Q1", total_authors=1, author_position=1)
        self.assertGreater(body["remuneration"], 0)
        self.assertIsNone(body["note"])


PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
)
PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n"


class UploadTypeTests(TestCase):
    """Uploads are identified by their bytes, not by what the file is called."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="uploader@test.edu", password="pass", name="Uploader",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def _upload(self, name, content, content_type="application/octet-stream"):
        return self.client.post(
            "/api/claims/upload",
            {"file": SimpleUploadedFile(name, content, content_type=content_type)},
        )

    def test_sniff_identifies_the_formats_we_accept(self):
        self.assertEqual(sniff(PDF_BYTES).extension, "pdf")
        self.assertEqual(sniff(PNG_BYTES).extension, "png")
        self.assertEqual(sniff(b"\xff\xd8\xff\xe0JFIF").extension, "jpg")
        self.assertEqual(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ").extension, "webp")
        self.assertEqual(sniff(b"GIF89a....").extension, "gif")
        self.assertIsNone(sniff(b"just some text"))

    def test_an_image_is_stored_and_served_as_an_image(self):
        with tempfile.TemporaryDirectory() as tmp:
            with override_settings(MEDIA_ROOT=Path(tmp)):
                r = self._upload("scan.png", PNG_BYTES, "image/png")
                self.assertEqual(r.status_code, 200, r.content)
                body = r.json()
                self.assertTrue(body["url"].endswith(".png"))
                self.assertEqual(body["content_type"], "image/png")
                # The claimant's own name survives; the stored name is a uuid.
                self.assertEqual(body["filename"], "scan.png")

                served = self.client.get(body["url"])
                self.assertEqual(served.status_code, 200)
                self.assertEqual(served["Content-Type"], "image/png")
                self.assertIn("inline", served["Content-Disposition"])
                self.assertEqual(b"".join(served.streaming_content), PNG_BYTES)
                served.close()  # FileResponse holds the handle; Windows won't rmtree otherwise

    def test_a_renamed_text_file_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with override_settings(MEDIA_ROOT=Path(tmp)):
                r = self._upload("not-really.pdf", b"plain text", "application/pdf")
        self.assertEqual(r.status_code, 400)
        self.assertIn("Renaming a file", r.json()["detail"])

    def test_an_empty_file_is_refused(self):
        r = self._upload("empty.pdf", b"", "application/pdf")
        self.assertEqual(r.status_code, 400)

    def test_a_word_document_downloads_rather_than_rendering(self):
        docx = b"PK\x03\x04" + b"\x00" * 30 + b"word/document.xml" + b"\x00" * 64
        with tempfile.TemporaryDirectory() as tmp:
            with override_settings(MEDIA_ROOT=Path(tmp)):
                r = self._upload("paper.docx", docx)
                self.assertEqual(r.status_code, 200, r.content)
                served = self.client.get(r.json()["url"])
                # Not renderable, and serving it inline invites content sniffing.
                self.assertIn("attachment", served["Content-Disposition"])
                self.assertEqual(served["X-Content-Type-Options"], "nosniff")
                served.close()

    def test_a_stored_pdf_still_serves_as_a_pdf(self):
        with tempfile.TemporaryDirectory() as tmp:
            with override_settings(MEDIA_ROOT=Path(tmp)):
                r = self._upload("paper.pdf", PDF_BYTES, "application/pdf")
                served = self.client.get(r.json()["url"])
                self.assertEqual(served["Content-Type"], "application/pdf")
                served.close()

    def test_upload_and_serve_go_through_the_storage_api(self):
        """Uploads must not touch the filesystem directly.

        open()/Path were how this worked before; on Cloud Run that writes to a
        container filesystem that vanishes with the instance. Going through
        default_storage is what lets the same code write to a bucket in
        production — so this asserts the storage backend actually sees it.
        """
        from django.core.files.storage import default_storage

        with tempfile.TemporaryDirectory() as tmp:
            with override_settings(MEDIA_ROOT=Path(tmp)):
                r = self._upload("paper.pdf", PDF_BYTES, "application/pdf")
                self.assertEqual(r.status_code, 200, r.content)
                stored = r.json()["url"].rsplit("/", 1)[-1]
                self.assertTrue(default_storage.exists(f"claims/{stored}"))
                with default_storage.open(f"claims/{stored}", "rb") as fh:
                    self.assertEqual(fh.read(), PDF_BYTES)
                # And the authenticated view reads it back the same way.
                served = self.client.get(r.json()["url"])
                self.assertEqual(served.status_code, 200)
                self.assertEqual(b"".join(served.streaming_content), PDF_BYTES)
                served.close()

    def test_health_flags_evidence_that_will_not_survive_a_deploy(self):
        # A container filesystem is discarded with the instance, so any local
        # MEDIA_ROOT in production means silent data loss: the ticket keeps
        # listing files that are gone.
        with override_settings(DEBUG=False, GS_BUCKET_NAME=""):
            body = self.client.get("/api/health").json()
        self.assertFalse(body["media_persistent"])
        self.assertIn("warnings", body)
        self.assertIn("GS_BUCKET_NAME", body["warnings"][0])

        # A bucket is durable, so the warning goes away.
        with override_settings(DEBUG=False, GS_BUCKET_NAME="faculty-paper-evidence"):
            body = self.client.get("/api/health").json()
        self.assertTrue(body["media_persistent"])
        self.assertNotIn("warnings", body)
        self.assertEqual(body["media_backend"], "gs://faculty-paper-evidence")

    def test_an_unknown_extension_is_not_served(self):
        # Path traversal and hand-crafted names both land here.
        r = self.client.get("/media/claims/" + "a" * 32 + ".exe")
        self.assertEqual(r.status_code, 404)


class ReportsAndBulkClearTests(TestCase):
    """The reporting view and the batch clearing flow."""

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.faculty = User.objects.create_user(
            email="rep-fac@test.edu", password="pass", name="Rep Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.other = User.objects.create_user(
            email="rep-fac2@test.edu", password="pass", name="Other Faculty",
            role=Role.FACULTY, department="ECE",
        )
        self.admin = User.objects.create_user(
            email="rep-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.finance = User.objects.create_user(
            email="rep-fin@test.edu", password="pass", name="Fin", role=Role.FINANCE
        )
        self.client = Client()

        def claim(owner, **kw):
            kw.setdefault("status", ClaimStatus.SUBMITTED)
            kw.setdefault("publication_year", 2026)
            return Claim.objects.create(owner=owner, paper_title="P", **kw)

        # Submitted rows carry no stored amount: bulk clearing recomputes from
        # verified values, and a stored figure that no longer recomputes would
        # (correctly) make the guard skip them.
        self.a = claim(self.faculty, ticket_number="R-1", quartile="Q1",
                       remuneration=None, remuneration_category="I",
                       engineering_class="Engineering")
        self.b = claim(self.faculty, ticket_number="R-2", quartile="Q2",
                       remuneration=None, remuneration_category="II",
                       engineering_class="Engineering")
        self.c = claim(self.other, ticket_number="R-3", quartile="Q1",
                       status=ClaimStatus.PAID, remuneration=250.0,
                       remuneration_category="I", engineering_class="Non-Engineering",
                       payout_month=date(2026, 8, 1))
        # A draft must not reach the institutional figures at all.
        claim(self.faculty, status=ClaimStatus.DRAFT, ticket_number=None, remuneration=999.0)

    def test_dashboard_totals_come_from_the_database(self):
        self.client.force_login(self.admin)
        body = self.client.get("/api/dashboard").json()
        self.assertEqual(body["total_paid"], 250.0)
        self.assertEqual(body["by_status"]["PAID"], 1)
        self.assertEqual(body["by_status"]["SUBMITTED"], 2)
        # Another person's draft stays invisible even in the totals.
        self.assertEqual(body["by_status"]["DRAFT"], 0)

    def test_reports_are_for_oversight_roles_only(self):
        self.client.force_login(self.faculty)
        self.assertEqual(self.client.get("/api/reports").status_code, 403)
        self.client.force_login(self.admin)
        self.assertEqual(self.client.get("/api/reports").status_code, 200)

    def test_totals_separate_output_from_spend(self):
        self.client.force_login(self.admin)
        body = self.client.get("/api/reports").json()
        t = body["totals"]
        self.assertEqual(t["publications"], 3)  # the draft is excluded
        self.assertEqual(t["paid_claims"], 1)
        self.assertEqual(t["paid_amount"], 250.0)
        # Submitted-but-not-cleared is neither paid nor committed.
        self.assertEqual(t["awaiting_payment"], 0)

    def test_breakdowns_group_by_department_and_category(self):
        self.client.force_login(self.admin)
        body = self.client.get("/api/reports").json()
        depts = {r["key"]: r["count"] for r in body["by_department"]}
        self.assertEqual(depts, {"CSE": 2, "ECE": 1})
        cats = {r["key"]: r["count"] for r in body["by_category"]}
        self.assertEqual(cats["I"], 2)
        self.assertTrue(
            any("Category I" in r["label"] for r in body["by_category"]),
            "categories should carry their human label",
        )

    def test_filters_narrow_the_figures(self):
        self.client.force_login(self.admin)
        body = self.client.get("/api/reports?department=CSE").json()
        self.assertEqual(body["totals"]["publications"], 2)
        self.assertEqual(body["totals"]["paid_amount"], 0)

    def test_export_is_one_row_per_publication(self):
        self.client.force_login(self.admin)
        r = self.client.get("/api/reports/export")
        self.assertEqual(r.status_code, 200)
        self.assertIn("text/csv", r["Content-Type"])
        lines = r.content.decode().strip().splitlines()
        self.assertEqual(len(lines), 4)  # header + 3 non-draft claims
        self.assertIn("Remuneration", lines[0])

    def test_bulk_clear_moves_every_submitted_ticket(self):
        self.client.force_login(self.admin)
        r = self.client.post(
            "/api/admin/bulk-clear",
            data=json.dumps({"claim_ids": [self.a.id, self.b.id], "note": "batch"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cleared"], 2)
        for c in (self.a, self.b):
            c.refresh_from_db()
            self.assertEqual(c.status, ClaimStatus.CLEARED)
        # Finance hears about each one.
        self.assertEqual(
            Notification.objects.filter(user=self.finance, claim_id__in=[self.a.id, self.b.id]).count(),
            2,
        )

    def test_bulk_clear_skips_what_it_cannot_clear_and_says_why(self):
        self.client.force_login(self.admin)
        r = self.client.post(
            "/api/admin/bulk-clear",
            data=json.dumps({"claim_ids": [self.a.id, self.c.id, "no-such-id"]}),
            content_type="application/json",
        )
        body = r.json()
        self.assertEqual(body["cleared"], 1)  # only the submitted one
        reasons = {s["id"]: s["reason"] for s in body["skipped"]}
        self.assertIn("PAID", reasons[self.c.id])
        self.assertIn("Not found", reasons["no-such-id"])
        self.c.refresh_from_db()
        self.assertEqual(self.c.status, ClaimStatus.PAID)

    def test_only_admins_can_bulk_clear(self):
        for user in (self.faculty, self.finance):
            self.client.force_login(user)
            r = self.client.post(
                "/api/admin/bulk-clear",
                data=json.dumps({"claim_ids": [self.a.id]}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 403, f"{user.role} should not bulk clear")


class FourRoleModelTests(TestCase):
    """Faculty, Admin, Finance, Principal — and nothing else."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="four-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.legacy = User.objects.create_user(
            email="four-legacy@test.edu", password="pass", name="Legacy Cell",
            role=Role.RESEARCH_CELL,
        )
        self.client = Client()

    def test_admin_can_issue_clear_and_manage_users(self):
        """The research cell's duties all land on the admin role."""
        self.assertTrue(rbac.can_issue_claims(Role.SUPER_ADMIN))
        self.assertTrue(rbac.can_clear_claims(Role.SUPER_ADMIN))
        self.assertTrue(rbac.can_manage_users(Role.SUPER_ADMIN))
        self.assertTrue(rbac.can_view_reports(Role.SUPER_ADMIN))
        self.assertEqual(rbac.portal_for_role(Role.SUPER_ADMIN), "admin")

    def test_an_unmigrated_research_cell_account_still_works(self):
        """Merging is a data change; the code must not lock them out meanwhile."""
        self.assertEqual(rbac.portal_for_role(Role.RESEARCH_CELL), "admin")
        self.assertTrue(rbac.can_clear_claims(Role.RESEARCH_CELL))
        self.client.force_login(self.legacy)
        self.assertEqual(self.client.get("/api/admin/clearing-queue").status_code, 200)

    def test_the_merge_command_moves_them_to_admin(self):
        from django.core.management import call_command

        call_command("merge_research_cell", "--apply", verbosity=0)
        self.legacy.refresh_from_db()
        self.assertEqual(self.legacy.role, Role.SUPER_ADMIN)
        self.assertTrue(
            AuditLog.objects.filter(action="ROLE_MERGED", entity_id=self.legacy.id).exists()
        )

    def test_principal_can_query_but_not_act(self):
        principal = User.objects.create_user(
            email="four-principal@test.edu", password="pass", name="P", role=Role.PRINCIPAL
        )
        self.assertTrue(rbac.can_view_reports(Role.PRINCIPAL))
        self.assertFalse(rbac.can_clear_claims(Role.PRINCIPAL))
        self.assertFalse(rbac.can_issue_claims(Role.PRINCIPAL))
        self.assertFalse(rbac.can_approve_as_finance(Role.PRINCIPAL))
        self.client.force_login(principal)
        self.assertEqual(self.client.get("/api/reports/search").status_code, 200)
        self.assertEqual(self.client.get("/api/admin/clearing-queue").status_code, 403)

    def test_faculty_cannot_query_the_whole_college(self):
        faculty = User.objects.create_user(
            email="four-fac@test.edu", password="pass", name="F", role=Role.FACULTY
        )
        self.client.force_login(faculty)
        self.assertEqual(self.client.get("/api/reports/search").status_code, 403)


class CrossCollegeQueryTests(TestCase):
    """The Principal's query view."""

    def setUp(self):
        self.principal = User.objects.create_user(
            email="qry-p@test.edu", password="pass", name="P", role=Role.PRINCIPAL
        )
        cse = User.objects.create_user(
            email="qry-cse@test.edu", password="pass", name="Ada Lovelace",
            role=Role.FACULTY, department="CSE",
        )
        ece = User.objects.create_user(
            email="qry-ece@test.edu", password="pass", name="Grace Hopper",
            role=Role.FACULTY, department="ECE",
        )
        Claim.objects.create(
            owner=cse, ticket_number="Q-1", paper_title="Neural networks for grids",
            quartile="Q1", engineering_class="Engineering", status=ClaimStatus.PAID,
            remuneration=100.0, publication_year=2026, remuneration_category="I",
        )
        Claim.objects.create(
            owner=cse, ticket_number="Q-2", paper_title="A survey of nursing practice",
            quartile="Q3", engineering_class="Non-Engineering", status=ClaimStatus.SUBMITTED,
            remuneration=20.0, publication_year=2025,
        )
        Claim.objects.create(
            owner=ece, ticket_number="Q-3", paper_title="Antenna design",
            quartile="Q1", engineering_class="Engineering", status=ClaimStatus.SUBMITTED,
            remuneration=50.0, publication_year=2026,
        )
        Claim.objects.create(
            owner=cse, paper_title="Unfinished idea", status=ClaimStatus.DRAFT
        )
        self.client = Client()
        self.client.force_login(self.principal)

    def q(self, qs=""):
        return self.client.get(f"/api/reports/search{qs}").json()

    def test_it_returns_everything_except_other_peoples_drafts(self):
        body = self.q()
        self.assertEqual(body["total"], 3)
        self.assertEqual(body["total_amount"], 170.0)

    def test_free_text_spans_title_faculty_and_identifiers(self):
        self.assertEqual(self.q("?q=Antenna")["total"], 1)
        self.assertEqual(self.q("?q=Ada")["total"], 2)      # by faculty name
        self.assertEqual(self.q("?q=Q-1")["total"], 1)      # by ticket
        self.assertEqual(self.q("?q=nothinghere")["total"], 0)

    def test_filters_combine(self):
        body = self.q("?department=CSE&quartile=Q1&engineering_class=Engineering")
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["results"][0]["ticket_number"], "Q-1")
        # "Which 2026 papers are still unpaid?"
        unpaid = self.q("?year=2026&status=SUBMITTED")
        self.assertEqual([r["ticket_number"] for r in unpaid["results"]], ["Q-3"])

    def test_totals_describe_the_whole_match_not_the_page(self):
        body = self.q("?limit=1")
        self.assertEqual(len(body["results"]), 1)
        self.assertEqual(body["total"], 3)
        self.assertEqual(body["total_amount"], 170.0)

    def test_sorting_by_amount(self):
        body = self.q("?sort=amount")
        self.assertEqual(
            [r["ticket_number"] for r in body["results"]], ["Q-1", "Q-3", "Q-2"]
        )


class PolicyStep8Tests(TestCase):
    """The four remuneration categories, straight from the workflow document."""

    def calc(self, **kw):
        from core.services.remuneration import calculate_remuneration

        kw.setdefault("total_authors", 1)
        kw.setdefault("author_position", 1)
        return calculate_remuneration(
            kw.pop("snip", None), kw.pop("quartile", None),
            kw.pop("total_authors"), kw.pop("author_position"), None, **kw
        )

    def test_category_one_snip_times_55000_plus_quartile_incentive(self):
        # [(SNIP x 55000) + QFA] x APP, Engineering Q1, sole author.
        r = self.calc(snip=2.0, quartile="Q1", indexing_level="Scopus",
                      publication_type="Journal", engineering_class="Engineering")
        self.assertEqual(r.category, "I")
        self.assertEqual(r.qf, 50000)
        self.assertEqual(r.base, 2.0 * 55000 + 50000)
        self.assertEqual(r.remuneration, 160000)

    def test_quartile_incentive_is_engineering_only(self):
        r = self.calc(snip=2.0, quartile="Q1", indexing_level="Scopus",
                      publication_type="Journal", engineering_class="Non-Engineering")
        self.assertEqual(r.qf, 0)
        self.assertEqual(r.remuneration, 110000)
        self.assertIn("Non-Engineering", r.note)

    def test_q4_incentive_is_seven_thousand(self):
        """The policy table says 7,000; the old default had 5,000."""
        r = self.calc(snip=1.0, quartile="Q4", indexing_level="Scopus",
                      publication_type="Journal", engineering_class="Engineering")
        self.assertEqual(r.qf, 7000)

    def test_category_two_scopus_journal_without_snip(self):
        r = self.calc(quartile="Q2", indexing_level="Scopus", publication_type="Journal",
                      engineering_class="Engineering")
        self.assertEqual(r.category, "II")
        self.assertEqual(r.remuneration, 5000)  # 5000 x APP(1) — no QFA

    def test_no_quartile_incentive_outside_the_q1_q4_table(self):
        """The QFA table has four rows. "Others" is not one of them.

        `qf_others` defaulted to 4,000 and the calculator paid it as a quartile
        incentive, so every unranked Engineering journal was overpaid by
        ₹4,000 x APP against a policy that authorises nothing for it.
        """
        for quartile in ("Others", "No Quartile", "NO_SNIP", "SNIP_ONLY", ""):
            r = self.calc(snip=2.0, quartile=quartile, indexing_level="Scopus",
                          publication_type="Journal", engineering_class="Engineering")
            self.assertEqual(r.qf, 0, quartile)
            self.assertEqual(r.remuneration, 110000, quartile)

    def test_quartile_incentive_is_journals_only(self):
        """"...applicable only to Engineering journals..." — a conference paper
        or book chapter earns no QFA even with a SNIP and an Engineering subject."""
        for kind in ("Conference Proceeding", "Book Chapter", "Book Series"):
            r = self.calc(snip=2.0, quartile="Q1", indexing_level="Scopus",
                          publication_type=kind, engineering_class="Engineering")
            self.assertEqual(r.category, "I", kind)
            self.assertEqual(r.qf, 0, kind)
            self.assertEqual(r.remuneration, 110000, kind)
            self.assertIn("journals only", r.note)

    def test_category_three_conference_or_book_without_snip(self):
        for kind in ("Conference Proceeding", "Book Series"):
            r = self.calc(indexing_level="Scopus", publication_type=kind,
                          engineering_class="Engineering")
            self.assertEqual(r.category, "III", kind)
            self.assertEqual(r.remuneration, 4000, kind)

    def test_category_four_web_of_science_not_in_scopus(self):
        # [5000 + QFA] x APP
        r = self.calc(quartile="Q2", indexing_level="SCI", publication_type="Journal",
                      engineering_class="Engineering")
        self.assertEqual(r.category, "IV")
        self.assertEqual(r.remuneration, 5000 + 30000)

    def test_author_position_points_match_the_policy_table(self):
        from core.services.remuneration import author_point

        table = {
            1: [1], 2: [0.6, 0.4], 3: [0.5, 0.3, 0.2], 4: [0.4, 0.3, 0.2, 0.1],
            5: [0.3, 0.25, 0.2, 0.15, 0.1],
            6: [0.275, 0.225, 0.2, 0.15, 0.1, 0.05],
            7: [0.275, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05],
            8: [0.25, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05, 0.025],
            9: [0.225, 0.2, 0.175, 0.125, 0.1, 0.075, 0.05, 0.03, 0.01],
        }
        for total, row in table.items():
            for pos, expected in enumerate(row, start=1):
                point, err = author_point(total, pos)
                self.assertIsNone(err, f"{total}/{pos}")
                self.assertAlmostEqual(point, expected, msg=f"{total} authors, position {pos}")

    def test_more_than_nine_authors_is_not_eligible(self):
        r = self.calc(snip=2.0, quartile="Q1", total_authors=10, author_position=1,
                      indexing_level="Scopus", publication_type="Journal")
        self.assertIsNone(r.remuneration)
        self.assertIn("more than 9 authors", r.error)

    def test_fewer_than_two_sec_references_is_count_only(self):
        for n in (0, 1):
            r = self.calc(snip=2.0, quartile="Q1", indexing_level="Scopus",
                          publication_type="Journal", engineering_class="Engineering",
                          sec_reference_count=n)
            self.assertEqual(r.remuneration, 0, f"{n} references")
            self.assertIn("policy requires 2", r.note)
        # Two clears the bar and the money comes back.
        r = self.calc(snip=2.0, quartile="Q1", indexing_level="Scopus",
                      publication_type="Journal", engineering_class="Engineering",
                      sec_reference_count=2)
        self.assertEqual(r.remuneration, 160000)

    def test_a_shared_paper_splits_by_position(self):
        # 3 authors, 2nd position: APP 0.3 on a [(1 x 55000) + 15000] base.
        r = self.calc(snip=1.0, quartile="Q3", total_authors=3, author_position=2,
                      indexing_level="Scopus", publication_type="Journal",
                      engineering_class="Engineering")
        self.assertEqual(r.point, 0.3)
        self.assertEqual(r.base, 70000)
        self.assertEqual(r.remuneration, 21000)

    def test_engineering_classification_follows_the_subject_keywords(self):
        from core.services.scimago import engineering_class

        for subject in ("Computer Science (Q1)", "Chemical Engineering", "Energy",
                        "Materials Science", "Decision Sciences"):
            self.assertEqual(engineering_class("Journal", subject), "Engineering", subject)
        self.assertEqual(engineering_class("Journal", "Nursing"), "Non-Engineering")
        # "For publication types other than Journal, treat as Engineering."
        self.assertEqual(engineering_class("Conference Proceeding", "Nursing"), "Engineering")


class PolicyUseCaseTests(TestCase):
    """Three worked claims, priced through the live API against the stored policy.

    PolicyStep8Tests exercises the engine directly. These go through
    /api/calculate with a real FormulaConfig row, so a policy row that has
    drifted from the document fails here even when the engine is right.
    """

    def setUp(self):
        import importlib
        import json as _json

        reset = importlib.import_module(
            "core.migrations.0018_reset_policy_to_workflow_document"
        )
        FormulaConfig.objects.all().delete()
        FormulaConfig.objects.create(
            **{
                **reset.POLICY,
                "version": 1,
                "author_point_json": _json.dumps(reset.AUTHOR_POINTS),
                "active": True,
            }
        )
        self.user = User.objects.create_user(
            email="usecase@test.edu", password="pass", name="Use Case",
            role=Role.FACULTY,
        )
        self.client = Client()
        self.client.force_login(self.user)

    def price(self, **payload):
        r = self.client.post(
            "/api/calculate", data=json.dumps(payload), content_type="application/json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_use_case_1_q1_engineering_journal_third_of_three(self):
        """Dr X, 3 authors, 3rd position, SNIP 2.4, Q1 Engineering journal.

        [(2.4 x 55000) + 50000] x 0.2 = 36,400
        """
        body = self.price(
            snip=2.4, quartile="Q1", total_authors=3, author_position=3,
            indexing_level="Scopus", publication_type="Journal",
            engineering_class="Engineering", sec_reference_count=2,
        )
        self.assertEqual(body["category"], "I")
        self.assertEqual(body["qf"], 50000)
        self.assertAlmostEqual(body["remuneration"], (2.4 * 55000 + 50000) * 0.2, places=2)

    def test_use_case_2_scopus_journal_without_snip_sole_author(self):
        """A Scopus journal article with no SNIP on record: 5000 x 1 = 5,000."""
        body = self.price(
            snip=None, quartile="Others", total_authors=1, author_position=1,
            indexing_level="Scopus", publication_type="Journal",
            engineering_class="Engineering", sec_reference_count=2,
        )
        self.assertEqual(body["category"], "II")
        self.assertEqual(body["qf"], 0)
        self.assertEqual(body["remuneration"], 5000)

    def test_use_case_3_web_of_science_esci_two_authors(self):
        """An ESCI journal outside Scopus, 2 authors, 1st: [5000 + 15000] x 0.6 = 12,000."""
        body = self.price(
            snip=None, quartile="Q3", total_authors=2, author_position=1,
            indexing_level="ESCI", publication_type="Journal",
            engineering_class="Engineering", sec_reference_count=3,
        )
        self.assertEqual(body["category"], "IV")
        self.assertEqual(body["qf"], 15000)
        self.assertEqual(body["remuneration"], (5000 + 15000) * 0.6)

    def test_a_use_case_survives_clear_and_payment(self):
        """The number the wizard shows is the number the ledger records.

        Clearing and paying both recompute and refuse a drifted amount, so this
        is where a policy that prices differently from the estimate would bite.
        """
        admin = User.objects.create_user(
            email="uc-admin@test.edu", password="pass", name="UC Admin",
            role=Role.SUPER_ADMIN,
        )
        finance = User.objects.create_user(
            email="uc-fin@test.edu", password="pass", name="UC Finance",
            role=Role.FINANCE,
        )
        # UC1 again, this time as a real claim: [(2.4 x 55000) + 50000] x 0.2
        expected = (2.4 * 55000 + 50000) * 0.2
        claim = Claim.objects.create(
            owner=self.user, status=ClaimStatus.SUBMITTED, ticket_number="UC-PAY-1",
            paper_title="Use case one, all the way to the ledger",
            publication_type="Journal", indexing_level="Scopus",
            engineering_class="Engineering",
            # MANUAL sources survive re-verification, which is what an
            # admin-verified claim looks like by the time it reaches clearing.
            quartile="Q1", quartile_source="MANUAL",
            snip=2.4, snip_source="MANUAL",
            total_authors=3, author_position=3, remuneration=expected,
        )
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'u' * 31}{n[-1]}.pdf", ref_number=n,
            )

        c = Client()
        with patch("core.api.verify_publication", side_effect=_echo_verified):
            c.force_login(admin)
            r = c.post(
                f"/api/claims/{claim.id}/clear",
                data=json.dumps({"note": "Cleared in the use-case test",
                                 "expected_amount": expected}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 200, r.content)

        # Deliberately outside the patch: payment must not depend on Scopus.
        c.force_login(finance)
        r = c.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"note": "Paid in the use-case test",
                             "voucher_number": "VCH-UC-1",
                             "expected_amount": expected}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertAlmostEqual(float(claim.remuneration), expected, places=2)
        ledger = PaidLedger.objects.filter(claim=claim)
        self.assertEqual(ledger.count(), 1)
        self.assertAlmostEqual(float(ledger.first().amount), expected, places=2)

    def test_finance_can_pay_while_scopus_is_down(self):
        """Payment recomputes from stored values, so an outage cannot block it.

        A single mark-paid used to re-verify externally and answer 502 when
        Scopus was unreachable. `skip_external` is super-admin only, so a
        Finance user had no way through — while bulk mark-paid, which never
        called out, paid the same claim happily.
        """
        finance = User.objects.create_user(
            email="uc-fin2@test.edu", password="pass", name="UC Finance 2",
            role=Role.FINANCE,
        )
        expected = 5000.0 * 0.6
        claim = Claim.objects.create(
            owner=self.user, status=ClaimStatus.CLEARED, ticket_number="UC-PAY-2",
            paper_title="Payable while the index is unreachable",
            publication_type="Journal", indexing_level="Scopus",
            engineering_class="Engineering",
            total_authors=2, author_position=1, remuneration=expected,
        )
        for n in ("21", "22"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'d' * 31}{n[-1]}.pdf", ref_number=n,
            )

        c = Client()
        c.force_login(finance)
        with patch("core.api.verify_publication", side_effect=AssertionError(
            "payment must not call Scopus"
        )):
            r = c.post(
                f"/api/claims/{claim.id}/mark-paid",
                data=json.dumps({"note": "Paid during an outage",
                                 "voucher_number": "VCH-UC-2",
                                 "expected_amount": expected}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertAlmostEqual(float(claim.remuneration), expected, places=2)

    def test_stored_policy_matches_the_document(self):
        """Guards the row itself, so a hand-edit that drifts is caught here."""
        cfg = FormulaConfig.objects.get(active=True)
        self.assertEqual(cfg.snip_multiplier, 55000)
        self.assertEqual(
            [cfg.qf_q1, cfg.qf_q2, cfg.qf_q3, cfg.qf_q4], [50000, 30000, 15000, 7000]
        )
        self.assertEqual(cfg.qf_others, 0)
        self.assertEqual(cfg.fixed_journal_no_snip, 5000)
        self.assertEqual(cfg.fixed_other_no_snip, 4000)
        self.assertEqual(cfg.fixed_web_of_science, 5000)
        self.assertEqual(cfg.max_authors, 9)
        self.assertEqual(cfg.min_sec_references, 2)


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

    def test_numeric_cells_do_not_become_floats(self):
        """Excel hands back whole numbers as floats; an author ID is not 5730.0."""
        from core.management.commands.import_erp_excel import _id

        self.assertEqual(_id(57306678000.0), "57306678000")
        self.assertEqual(_id("57306678000.0"), "57306678000")
        self.assertEqual(_id("57306678000"), "57306678000")
        self.assertEqual(_id("SEC.0"), "SEC.0")  # not a number — left alone
        self.assertIsNone(_id(None))
        self.assertIsNone(_id(""))


class ScopusProfileDerivationTests(TestCase):
    """The ERP roster carries author IDs but no profile links, and the claim
    wizard demands the link — so every imported person was blocked from filing
    until the link was derived for them."""

    def test_url_derived_from_id(self):
        from core.services.scopus import author_profile_url

        self.assertEqual(
            author_profile_url("57306678000"),
            "https://www.scopus.com/authid/detail.uri?authorId=57306678000",
        )
        self.assertEqual(
            author_profile_url("57306678000.0"),
            "https://www.scopus.com/authid/detail.uri?authorId=57306678000",
        )
        self.assertIsNone(author_profile_url(None))
        self.assertIsNone(author_profile_url("not-an-id"))

    def test_me_fills_in_the_missing_profile_link(self):
        fac = User.objects.create_user(
            email="derive@test.edu", password="pass", name="Derive Faculty",
            role=Role.FACULTY, scopus_author_id="57306678000",
        )
        c = Client()
        c.force_login(fac)
        body = c.get("/api/auth/me").json()
        self.assertEqual(
            body["scopus_author_url"],
            "https://www.scopus.com/authid/detail.uri?authorId=57306678000",
        )

    def test_repair_migration_cleans_and_backfills(self):
        """This runs once against 400+ live rows, so prove it before it does."""
        import importlib

        from django.apps import apps as django_apps

        repair = importlib.import_module("core.migrations.0017_repair_scopus_identity")

        fac = User.objects.create_user(
            email="repair@test.edu", password="pass", name="Repair Faculty",
            role=Role.FACULTY, scopus_author_id="57983494200.0",
            biometric_id="4168.0",
        )
        keep = User.objects.create_user(
            email="repair-keep@test.edu", password="pass", name="Keep Faculty",
            role=Role.FACULTY, scopus_author_id="57983494201",
            scopus_author_url="https://example.test/mine",
        )

        repair.forwards(django_apps, None)

        fac.refresh_from_db()
        self.assertEqual(fac.scopus_author_id, "57983494200")
        self.assertEqual(fac.biometric_id, "4168")
        self.assertEqual(
            fac.scopus_author_url,
            "https://www.scopus.com/authid/detail.uri?authorId=57983494200",
        )
        keep.refresh_from_db()
        self.assertEqual(keep.scopus_author_url, "https://example.test/mine")

    def test_stored_link_wins_over_derived(self):
        fac = User.objects.create_user(
            email="stored@test.edu", password="pass", name="Stored Faculty",
            role=Role.FACULTY, scopus_author_id="57306678000",
            scopus_author_url="https://www.scopus.com/authid/detail.uri?authorId=99999",
        )
        c = Client()
        c.force_login(fac)
        self.assertIn("99999", c.get("/api/auth/me").json()["scopus_author_url"])


class AdminAccountAdminTests(TestCase):
    """Admins manage 400+ imported accounts, so the directory has to be
    searchable and paged rather than dumped whole."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="acct-admin@test.edu", password="pass", name="Acct Admin",
            role=Role.SUPER_ADMIN,
        )
        for i in range(5):
            User.objects.create_user(
                email=f"acct-fac{i}@test.edu", password="pass", name=f"Faculty {i}",
                role=Role.FACULTY, department="EEE", staff_id=f"STF-{i}",
                active=(i != 4),
            )
        self.client = Client()
        self.client.force_login(self.admin)

    def test_search_filter_and_paging(self):
        body = self.client.get("/api/admin/users?q=STF-2").json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["results"][0]["staff_id"], "STF-2")

        page = self.client.get("/api/admin/users?role=FACULTY&limit=2&offset=0").json()
        self.assertEqual(page["total"], 5)
        self.assertEqual(len(page["results"]), 2)
        rest = self.client.get("/api/admin/users?role=FACULTY&limit=2&offset=4").json()
        self.assertEqual(len(rest["results"]), 1)

        inactive = self.client.get("/api/admin/users?active=false").json()
        self.assertEqual([u["email"] for u in inactive["results"]], ["acct-fac4@test.edu"])

    def test_detail_reports_claim_activity(self):
        fac = User.objects.get(email="acct-fac0@test.edu")
        Claim.objects.create(
            owner=fac, paper_title="Paid Paper", status=ClaimStatus.PAID,
            remuneration=1000, ticket_number="ACCT-1",
        )
        Claim.objects.create(
            owner=fac, paper_title="Open Paper", status=ClaimStatus.SUBMITTED,
            ticket_number="ACCT-2",
        )
        body = self.client.get(f"/api/admin/users/{fac.id}").json()
        self.assertEqual(body["email"], "acct-fac0@test.edu")
        self.assertEqual(body["stats"]["claims"], 2)
        self.assertEqual(body["stats"]["paid_claims"], 1)
        self.assertEqual(float(body["stats"]["paid_amount"]), 1000.0)

    def test_directory_is_admin_only(self):
        fac = User.objects.get(email="acct-fac0@test.edu")
        c = Client()
        c.force_login(fac)
        self.assertEqual(c.get("/api/admin/users").status_code, 403)
