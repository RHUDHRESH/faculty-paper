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
from core.services.verify import check_already_paid
from core.models import Budget, DuplicateFinding, JournalStanding, ScimagoJournal
from core.models import SnipSource
from core.services import discover, gemini
from core.services.remuneration import calculate_remuneration
from core import api as api_module
from core.models import (
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAction,
    ClaimAttachment,
    ClaimStatus,
    FacultyMaster,
    FormulaConfig,
    Notification,
    ProfileChangeRequest,
    Role,
    ScimagoJournal,
)
from core.models import PaidLedger, PriorPayment
from core.services import rbac
from core.services.erp_import import find_existing_claim, map_excel_status, stable_ticket
from core.services.normalize import normalize_issn, normalize_title
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

        # Cleared is not payable: the principal has not agreed to the spend.
        self._login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"note": "paid", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("principal", r.json()["detail"].lower())

        self._login(self.principal)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"note": "approved", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)
        self.assertEqual(claim.principal_approved_by, self.principal)
        # Finance is told there is money to move, once it actually can move.
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
        for viewer in (self.principal, self.finance, self.admin):
            self._login(viewer)
            titles = [c["paper_title"] for c in self.client.get("/api/claims").json()["results"]]
            self.assertNotIn("Half-written idea", titles, f"{viewer.role} saw a draft")

        # A head reaches neither this list nor their own department screens
        # with a draft in them: an unfinished ticket is not output.
        self._login(self.hod)
        self.assertEqual(self.client.get("/api/claims").status_code, 403)
        self.hod.department = "CSE"
        self.hod.save()
        self._login(self.hod)
        titles = [
            row["paper_title"]
            for row in self.client.get("/api/hod/publications").json()["results"]
        ]
        self.assertNotIn("Half-written idea", titles)

        # The author still sees their own.
        self._login(self.faculty)
        titles = [c["paper_title"] for c in self.client.get("/api/claims").json()["results"]]
        self.assertIn("Half-written idea", titles)

    def test_a_head_of_department_is_kept_away_from_the_money_screens(self):
        """The role is live again, with its own department portal. What it must
        never reach is anything carrying a remuneration -- and the claim list
        carries one on every row."""
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
        r = self.client.get("/api/claims")
        self.assertEqual(r.status_code, 403, "the claim list carries the remuneration")
        self.assertIn("no payment details", r.json()["detail"])

        # They land in their own portal, not somebody else's.
        self.assertEqual(rbac.portal_for_role(Role.HOD), "hod")

        # And their own screen shows the department without any money in it.
        self.hod.department = "CSE"
        self.hod.save()
        self._login(self.hod)
        body = self.client.get("/api/hod/publications").json()
        self.assertIn("CSE Paper", [row["paper_title"] for row in body["results"]])
        self.assertNotIn("remuneration", self.client.get("/api/hod/publications").content.decode())

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
            principal_approved_at=timezone.now(),
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
        self.principal = User.objects.create_user(
            email="life-head@test.edu", password="pass", name="Life Head", role=Role.PRINCIPAL
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
        # A ticket sitting at PRINCIPAL_APPROVED only counts as approved if it
        # was approved here: an imported ERP row carries the status with no
        # signature behind it, and finance must not pay one of those.
        if status == ClaimStatus.PRINCIPAL_APPROVED:
            kw.setdefault("principal_approved_at", timezone.now())
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
        claim = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="LC-2")
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
        claim = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0,
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
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

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
        claim = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="LC-P502")
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
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=160000.0, ticket=ticket,
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

        # A void returns the ticket to Cleared, so paying it again needs the
        # principal's approval afresh. Money that moved and was pulled back is
        # exactly the case where a second look is worth the friction.
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V101", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, "a voided ticket is not payable unapproved")

        self.client.force_login(self.principal)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

        self.client.force_login(self.finance)
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
        a = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="LC-BP1")
        b = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="LC-BP2")
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
        good = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="LC-BP3")
        drifted = self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="LC-BP4")
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
        self.assertEqual(drifted.status, ClaimStatus.PRINCIPAL_APPROVED, "a skipped row is untouched")
        high.refresh_from_db()
        self.assertEqual(high.status, ClaimStatus.PRINCIPAL_APPROVED)

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

    def test_the_research_cell_cannot_change_identity_through_the_user_editor(self):
        """Closing the self-edit route while leaving this one open moves the
        same mistake one desk over: the research cell clears the claims these
        fields decide the outcome of."""
        cell = User.objects.create_user(
            email="cell@test.edu", password="pass", name="Research Cell",
            role=Role.RESEARCH_CELL,
        )
        self.client.force_login(cell)
        r = self.client.patch(
            f"/api/admin/users/{self.faculty.id}",
            data=json.dumps({"name": "Someone Else", "biometric_id": "BIO-HACKED"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.name, "Identity Faculty")
        self.assertEqual(self.faculty.biometric_id, "BIO-REAL")

    def test_the_research_cell_can_still_move_a_department_and_stand_an_account_down(self):
        """Routing and account state are not identity, and are its job."""
        cell = User.objects.create_user(
            email="cell2@test.edu", password="pass", name="Research Cell",
            role=Role.RESEARCH_CELL,
        )
        self.client.force_login(cell)
        r = self.client.patch(
            f"/api/admin/users/{self.faculty.id}",
            data=json.dumps({"department": "ECE", "active": False}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.department, "ECE")
        self.assertFalse(self.faculty.active)

    def test_a_super_admin_can_change_identity_through_the_user_editor(self):
        admin = User.objects.create_user(
            email="identity-super@test.edu", password="pass", name="Super",
            role=Role.SUPER_ADMIN,
        )
        self.client.force_login(admin)
        r = self.client.patch(
            f"/api/admin/users/{self.faculty.id}",
            data=json.dumps({"biometric_id": "BIO-CORRECTED"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.biometric_id, "BIO-CORRECTED")

    def test_an_identity_correction_only_notifies_who_can_action_it(self):
        """A notification the reader cannot act on trains them to ignore the
        rest, so the research cell is not told about identity requests."""
        from core.models import Notification

        cell = User.objects.create_user(
            email="cell3@test.edu", password="pass", role=Role.RESEARCH_CELL
        )
        sup = User.objects.create_user(
            email="super3@test.edu", password="pass", role=Role.SUPER_ADMIN
        )
        self.client.force_login(self.faculty)
        r = self.client.post(
            "/api/auth/profile/correction",
            data=json.dumps({"field": "staff_id", "proposed": "STF-9"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        told = set(
            Notification.objects.filter(title__startswith="Profile correction")
            .values_list("user__email", flat=True)
        )
        self.assertEqual(told, {sup.email})

        # A department is routing, not identity, so the cell does hear about it.
        Notification.objects.all().delete()
        self.client.post(
            "/api/auth/profile/correction",
            data=json.dumps({"field": "department", "proposed": "ECE"}),
            content_type="application/json",
        )
        told = set(
            Notification.objects.filter(title__startswith="Profile correction")
            .values_list("user__email", flat=True)
        )
        self.assertEqual(told, {sup.email, cell.email})



class PrincipalOversightTests(TestCase):
    """What the principal can ask of the system, and what it must not answer.

    Every one of these was previously answerable only by exporting the ledger
    and pivoting it by hand.
    """

    def setUp(self):
        from datetime import date

        self.principal = User.objects.create_user(
            email="head@test.edu", password="pass", name="Head", role=Role.PRINCIPAL
        )
        self.person = User.objects.create_user(
            email="prof@test.edu", password="pass", name="Prof Person",
            role=Role.FACULTY, department="CSE", staff_id="STF-77",
        )
        common = dict(
            owner=self.person, journal_title="J", issn="1111-2222",
            staff_id="STF-77",
        )
        self.march = Claim.objects.create(
            paper_title="Paid in March", status=ClaimStatus.PAID,
            remuneration=55000, payout_month=date(2026, 3, 1),
            publication_year=2025, quartile="Q1", **common,
        )
        self.april = Claim.objects.create(
            paper_title="Paid in April", status=ClaimStatus.PAID,
            remuneration=22000, payout_month=date(2026, 4, 1),
            publication_year=2026, quartile="Q2", **common,
        )
        self.draft = Claim.objects.create(
            paper_title="Never filed", status=ClaimStatus.DRAFT,
            remuneration=99999, publication_year=2026, **common,
        )
        self.client = Client()
        self.client.force_login(self.principal)

    def test_a_month_narrows_the_figures_to_what_was_settled_then(self):
        r = self.client.get("/api/reports?month=2026-03")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["totals"]["paid_amount"], 55000)
        self.assertIn("2026-03", body["payout_months"])
        self.assertIn("2026-04", body["payout_months"])

    def test_a_malformed_month_is_refused_rather_than_ignored(self):
        """Silently returning everything reads as "March had no payments"."""
        for bad in ("march", "2026-13", "2026"):
            r = self.client.get(f"/api/reports?month={bad}")
            self.assertEqual(r.status_code, 400, f"{bad}: {r.content}")

    def test_the_record_of_one_person_leaves_out_their_drafts(self):
        """A draft is private working paper, not a record of anything -- and
        the export already excludes them, so counting them here would make the
        screen and the file disagree."""
        r = self.client.get(f"/api/faculty/{self.person.id}/report")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["totals"]["publications"], 2)
        self.assertEqual(body["totals"]["paid_amount"], 77000)
        titles = {c["paper_title"] for c in body["claims"]}
        self.assertNotIn("Never filed", titles)

    def test_the_record_exports_as_a_real_workbook(self):
        r = self.client.get(f"/api/faculty/{self.person.id}/report/export?fmt=xlsx")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("spreadsheetml", r["Content-Type"])
        # A .xlsx is a zip; an HTML error page is not.
        self.assertEqual(bytes(r.content[:2]), b"PK")
        self.assertIn("STF-77", r["Content-Disposition"])

    def test_a_claimant_cannot_read_another_person_s_record(self):
        self.client.force_login(self.person)
        other = User.objects.create_user(
            email="other@test.edu", password="pass", role=Role.FACULTY
        )
        r = self.client.get(f"/api/faculty/{other.id}/report")
        self.assertEqual(r.status_code, 403, r.content)
        r = self.client.get(f"/api/faculty/{other.id}/report/export")
        self.assertEqual(r.status_code, 403, r.content)


class ClaimNoteVisibilityTests(TestCase):
    """A note is between the principal and the research cell, on one ticket."""

    def setUp(self):
        self.principal = User.objects.create_user(
            email="head2@test.edu", password="pass", name="Head", role=Role.PRINCIPAL
        )
        self.cell = User.objects.create_user(
            email="cell9@test.edu", password="pass", name="Cell", role=Role.RESEARCH_CELL
        )
        self.claimant = User.objects.create_user(
            email="claimant@test.edu", password="pass", name="Claimant",
            role=Role.FACULTY, department="CSE",
        )
        self.finance = User.objects.create_user(
            email="fin9@test.edu", password="pass", role=Role.FINANCE
        )
        self.claim = Claim.objects.create(
            owner=self.claimant, paper_title="Under discussion",
            journal_title="J", issn="3333-4444", status=ClaimStatus.SUBMITTED,
        )
        self.client = Client()

    def _raise(self, body="Please confirm the SNIP on this one"):
        return self.client.post(
            f"/api/claims/{self.claim.id}/notes",
            data=json.dumps({"body": body}),
            content_type="application/json",
        )

    def test_the_principal_raises_it_and_the_research_cell_reads_it(self):
        self.client.force_login(self.principal)
        self.assertEqual(self._raise().status_code, 200)

        self.client.force_login(self.cell)
        r = self.client.get(f"/api/claims/{self.claim.id}/notes")
        self.assertEqual(r.status_code, 200, r.content)
        bodies = [n["body"] for n in r.json()["results"]]
        self.assertIn("Please confirm the SNIP on this one", bodies)

    def test_neither_the_claimant_nor_finance_can_read_it(self):
        """The whole point is that it is not a conversation with the claimant."""
        self.client.force_login(self.principal)
        self._raise()
        for who in (self.claimant, self.finance):
            self.client.force_login(who)
            r = self.client.get(f"/api/claims/{self.claim.id}/notes")
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")

    def test_only_the_research_cell_closes_a_note(self):
        """Otherwise the person who asked marks their own question answered."""
        self.client.force_login(self.principal)
        note_id = self._raise().json()["id"]

        r = self.client.post(f"/api/claims/notes/{note_id}/resolve")
        self.assertEqual(r.status_code, 403, r.content)

        self.client.force_login(self.cell)
        r = self.client.post(f"/api/claims/notes/{note_id}/resolve")
        self.assertEqual(r.status_code, 200, r.content)

        r = self.client.get(f"/api/claims/{self.claim.id}/notes")
        note = r.json()["results"][0]
        self.assertIsNotNone(note["resolved_at"])
        self.assertEqual(note["resolved_by_name"], "Cell")

    def test_an_empty_note_is_refused(self):
        self.client.force_login(self.principal)
        self.assertEqual(self._raise("  ").status_code, 400)



class RetractionFlagTests(TestCase):
    """A retracted paper is stopped, and the claimant can argue it is not.

    Nothing here decides anything on its own: the signal is the publisher's
    own renaming of the title, which arrives late and can be wrong in both
    directions, so it takes the same route a missing quartile takes.
    """

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="retract@test.edu", password="pass", name="R Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-R",
            biometric_id="BIO-R",
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def test_the_words_a_publisher_uses_are_recognised_and_others_are_not(self):
        from core.services.retraction import looks_retracted

        for title in (
            "RETRACTED: Deep learning for lung cancer staging",
            "Retraction: A study of graphene oxide",
            "WITHDRAWN: Optimising retrial queues",
            "[Retracted] Neural networks in medicine",
            "Expression of Concern: Fuzzy logic control",
            "This article has been retracted",
        ):
            self.assertIsNotNone(looks_retracted(title), title)

        # A paper *about* retractions is not a retracted paper. Getting this
        # wrong would block a legitimate claim on a word in its own subject.
        for title in (
            "A study of retraction rates in engineering journals",
            "Detecting withdrawn papers using citation graphs",
            "Machine learning for structural health monitoring",
            "",
            None,
        ):
            self.assertIsNone(looks_retracted(title), title)

    def test_a_retracted_title_is_raised_as_an_issue_the_claimant_can_contest(self):
        claim = Claim.objects.create(
            owner=self.faculty,
            paper_title="RETRACTED: Deep learning for lung cancer staging",
            journal_title="J", issn="5555-6666", status=ClaimStatus.DRAFT,
            staff_id="STF-R", quartile="Q1", total_authors=1, author_position=1,
        )
        issues = api_module._verification_issues({"scopus": {"indexed": True}}, claim)
        self.assertTrue(
            any("retracted or withdrawn" in i for i in issues),
            issues,
        )

    def test_the_index_title_is_checked_too(self):
        """The publisher renames the paper after the form was filled in, so the
        claimant's own title still reads clean."""
        claim = Claim.objects.create(
            owner=self.faculty,
            paper_title="Deep learning for lung cancer staging",
            journal_title="J", issn="5555-6666", status=ClaimStatus.DRAFT,
            staff_id="STF-R", quartile="Q1",
        )
        issues = api_module._verification_issues(
            {"scopus": {"indexed": True, "title": "RETRACTED: Deep learning for lung cancer staging"}},
            claim,
        )
        self.assertTrue(any("retracted or withdrawn" in i for i in issues), issues)

    def _submittable(self, **overrides):
        payload = {
            "paper_title": "A Complete Paper",
            "journal_title": "Journal of Testing",
            "issn": "1234-5678",
            "publication_date": "2026-03-01",
            "indexing_level": "Scopus",
            "yukthi_id": "YK-R",
            "scopus_author_url": "https://scopus.com/authid/detail.uri?authorId=1",
            "sec_refs": "14, 15",
            "proof_url": "/media/claims/b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0.pdf",
            "sec_proof_url": "/media/claims/b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1.pdf",
            "quartile": "Q1",
            "snip": 1.0,
            "total_authors": 3,
            "author_position": 1,
            "affiliation_ok": True,
            "submit": True,
        }
        payload.update(overrides)
        return self.client.post(
            "/api/claims", data=json.dumps(payload), content_type="application/json"
        )

    def test_a_retracted_paper_cannot_be_filed_silently(self):
        r = self._submittable(paper_title="RETRACTED: A Complete Paper")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("retracted or withdrawn", r.json()["detail"])

    def test_it_can_be_contested_and_arrives_flagged_for_the_admin(self):
        """Contesting is the point: the signal is the publisher's renaming of
        the title, which can be wrong, so the claimant gets to say so -- and
        the research cell gets a ticket that says it was argued."""
        r = self._submittable(
            paper_title="RETRACTED: A Complete Paper",
            contest_forward=True,
            contest_note="The retraction was of the erratum, not the article.",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim = Claim.objects.get(pk=r.json()["id"])
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertTrue(claim.contest_forward)
        self.assertIn("erratum", claim.contest_note)
        self.assertIsNotNone(claim.ticket_number)
        issues = json.loads(claim.verification_snapshot_json)["issues"]
        self.assertTrue(any("retracted or withdrawn" in i for i in issues), issues)

    def test_a_contest_without_a_note_is_still_refused(self):
        r = self._submittable(
            paper_title="RETRACTED: A Complete Paper", contest_forward=True
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_clean_title_raises_nothing(self):
        claim = Claim.objects.create(
            owner=self.faculty, paper_title="Deep learning for lung cancer staging",
            journal_title="J", issn="5555-6666", status=ClaimStatus.DRAFT,
            staff_id="STF-R", quartile="Q1",
        )
        issues = api_module._verification_issues(
            {"scopus": {"indexed": True, "title": "Deep learning for lung cancer staging"}},
            claim,
        )
        self.assertFalse([i for i in issues if "retracted" in i], issues)



class DuplicateOverrideGuardTests(TestCase):
    """One person must not dismiss a payment-history warning and then act on it.

    The warning fired and submission was refused -- that part worked. What did
    not was everything afterwards: the warning was waved away with a short
    note, and nothing downstream knew it had ever been raised, so the same
    person could clear the ticket and finance would pay a second time for one
    paper.
    """

    def setUp(self):
        self.cell = User.objects.create_user(
            email="dup-cell@test.edu", password="pass", name="First Admin",
            role=Role.RESEARCH_CELL,
        )
        self.other = User.objects.create_user(
            email="dup-cell2@test.edu", password="pass", name="Second Admin",
            role=Role.RESEARCH_CELL,
        )
        self.finance = User.objects.create_user(
            email="dup-fin@test.edu", password="pass", name="Finance",
            role=Role.FINANCE,
        )
        self.faculty = User.objects.create_user(
            email="dup-fac@test.edu", password="pass", name="Claimant",
            role=Role.FACULTY, department="CSE", staff_id="STF-D",
            biometric_id="BIO-D",
            scopus_author_url="https://scopus.com/authid/detail.uri?authorId=9",
        )
        # What the college already paid for.
        PriorPayment.objects.create(
            faculty_name="Claimant",
            paper_title="A Paper Paid For Once Already",
            normalized_title=normalize_title("A Paper Paid For Once Already"),
            amount_paid=55000,
            claim_ref="ERP-000123",
        )
        self.client = Client()
        # Scopus is not what these tests are about, and calling it for real
        # made them depend on the network -- which is how they started timing
        # out in a full run while passing on their own. The payment-history
        # check runs against the database either way, and that is the subject.
        def _no_scopus_but_real_duplicate_check(*args, **kwargs):
            out = _echo_verified(*args, **kwargs)
            out["paid"] = check_already_paid(
                title=kwargs.get("title"),
                doi=kwargs.get("doi"),
                staff_id=kwargs.get("staff_id"),
                exclude_claim_id=kwargs.get("exclude_claim_id"),
            )
            return out

        verify_patch = patch(
            "core.api.verify_publication", side_effect=_no_scopus_but_real_duplicate_check
        )
        verify_patch.start()
        self.addCleanup(verify_patch.stop)

    def _refile(self, **overrides):
        payload = {
            "owner_id": str(self.faculty.id),
            "paper_title": "A Paper Paid For Once Already",
            "journal_title": "Journal of Testing",
            "issn": "1234-5678",
            "publication_date": "2026-03-01",
            "indexing_level": "Scopus",
            "yukthi_id": "YK-D",
            "scopus_author_url": "https://scopus.com/authid/detail.uri?authorId=9",
            "sec_refs": "14, 15",
            "proof_url": "/media/claims/d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0.pdf",
            "sec_proof_url": "/media/claims/d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1.pdf",
            "quartile": "Q1",
            "snip": 1.0,
            "total_authors": 3,
            "author_position": 1,
            "affiliation_ok": True,
            "submit": True,
        }
        payload.update(overrides)
        return self.client.post(
            "/api/claims", data=json.dumps(payload), content_type="application/json"
        )

    def test_re_filing_a_paid_paper_is_refused_and_says_so_once(self):
        self.client.force_login(self.cell)
        r = self._refile()
        self.assertEqual(r.status_code, 400, r.content)
        detail = r.json()["detail"]
        self.assertIn("Payment history", detail)
        # The same sentence used to be appended twice, from two places.
        self.assertEqual(detail.count("Payment history may already include this paper"), 1)

    def test_setting_the_warning_aside_records_who_did_it(self):
        self.client.force_login(self.cell)
        r = self._refile(contest_forward=True, contest_note="Filing this for the office.")
        self.assertEqual(r.status_code, 200, r.content)
        claim = Claim.objects.get(pk=r.json()["id"])
        self.assertTrue(claim.duplicate_warning)
        self.assertTrue(claim.override_duplicate)
        self.assertEqual(claim.override_by_id, self.cell.id)
        self.assertIsNotNone(claim.override_at)

    def test_the_person_who_set_it_aside_cannot_clear_it(self):
        self.client.force_login(self.cell)
        claim_id = self._refile(
            contest_forward=True, contest_note="Filing this for the office."
        ).json()["id"]
        claim = Claim.objects.get(pk=claim_id)

        r = self.client.post(
            f"/api/claims/{claim_id}/clear",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("somebody else", r.json()["detail"])
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

        # Somebody else may.
        self.client.force_login(self.other)
        r = self.client.post(
            f"/api/claims/{claim_id}/clear",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_bulk_clear_skips_it_rather_than_sweeping_it_through(self):
        """A dismissed duplicate is exactly the row that must not go through in
        a batch of two hundred without being looked at."""
        self.client.force_login(self.cell)
        claim_id = self._refile(
            contest_forward=True, contest_note="Filing this for the office."
        ).json()["id"]

        r = self.client.post(
            "/api/admin/bulk-clear",
            data=json.dumps({"claim_ids": [claim_id]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body.get("cleared", 0), 0, body)
        self.assertTrue(
            any("somebody else" in s["reason"] for s in body.get("skipped", [])), body
        )

    def test_finance_cannot_pay_it_without_a_second_approver(self):
        self.client.force_login(self.cell)
        claim_id = self._refile(
            contest_forward=True, contest_note="Filing this for the office."
        ).json()["id"]
        claim = Claim.objects.get(pk=claim_id)

        self.client.force_login(self.other)
        self.client.post(
            f"/api/claims/{claim_id}/clear",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

        # Cleared is not payable at all now, so the first refusal names the
        # missing approval rather than the missing second signature.
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim_id}/mark-paid",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("principal", r.json()["detail"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

        # The principal is a third person again, and their approval is what
        # satisfies the second-signature rule the override raised. Three people
        # have now looked at a ticket somebody said was not a duplicate.
        head = User.objects.create_user(
            email="dup-head@test.edu", password="pass", name="Head", role=Role.PRINCIPAL
        )
        self.client.force_login(head)
        r = self.client.post(
            f"/api/claims/{claim_id}/principal-approve",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.second_approved_by_id, head.id)

        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim_id}/mark-paid",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_an_ordinary_claim_is_not_caught_by_any_of_this(self):
        """A contested claim with no payment-history match is untouched: the
        guard keys on the duplicate warning, not on contesting."""
        self.client.force_login(self.cell)
        r = self._refile(
            paper_title="A Paper Nobody Has Claimed Before",
            contest_forward=True,
            contest_note="Journal details provided by the faculty member.",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim = Claim.objects.get(pk=r.json()["id"])
        self.assertFalse(claim.duplicate_warning)
        self.assertFalse(claim.override_duplicate)
        r = self.client.post(
            f"/api/claims/{claim.id}/clear",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)



class FourStepChainTests(TestCase):
    """Nothing reaches finance without the principal's approval.

    The chain ran research cell → finance, so the person accountable for the
    spend could read every figure and authorise none of them.
    """

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="chain-fac@test.edu", password="pass", name="Chain Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.cell = User.objects.create_user(
            email="chain-cell@test.edu", password="pass", name="Chain Cell",
            role=Role.RESEARCH_CELL,
        )
        self.head = User.objects.create_user(
            email="chain-head@test.edu", password="pass", name="Chain Head",
            role=Role.PRINCIPAL,
        )
        self.finance = User.objects.create_user(
            email="chain-fin@test.edu", password="pass", name="Chain Fin",
            role=Role.FINANCE,
        )
        self.client = Client()

    def _cleared(self, ticket="CH-1", amount=105000.0, **kw):
        claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.CLEARED, ticket_number=ticket,
            paper_title=f"Chain {ticket}", journal_title="J", issn="1111-0000",
            quartile="Q1", quartile_source="SCIMAGO", snip=1.0, snip_source="SCOPUS",
            engineering_class="Engineering", indexing_level="Scopus",
            publication_type="Journal", total_authors=1, author_position=1,
            remuneration=amount, cleared_by=self.cell, cleared_at=timezone.now(),
            **kw,
        )
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'f' * 31}{n[-1]}.pdf", ref_number=n,
            )
        return claim

    def test_finance_cannot_pay_something_the_principal_has_not_approved(self):
        claim = self._cleared()
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("principal", r.json()["detail"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

    def test_clearing_tells_the_principal_and_not_finance(self):
        """Clearing used to tell Finance the ticket was "cleared for payment"
        -- money they cannot release until the principal has approved it. So
        the desk that had to act was never told, and the desk that was told
        could do nothing."""
        claim = self._cleared("CH-N1")
        # The fixture builds it already cleared; clearing is the transition
        # under test, so it goes back to submitted first and is cleared once.
        Claim.objects.filter(pk=claim.pk).update(status=ClaimStatus.SUBMITTED)
        Notification.objects.all().delete()
        self.client.force_login(self.cell)
        # Clearing re-verifies against the index; replaying the stored values
        # keeps the amount steady so the guard does not fire on a figure that
        # is not what this test is about.
        with patch("core.api.verify_publication", side_effect=_echo_verified):
            r = self.client.post(
                f"/api/claims/{claim.id}/clear",
                data=json.dumps({"expected_amount": 105000.0}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)

        told = set(
            Notification.objects.filter(claim_id=claim.id)
            .values_list("user__role", flat=True)
        )
        self.assertIn(Role.PRINCIPAL, told, "the principal must hear about it")
        self.assertNotIn(
            Role.FINANCE, told, "finance cannot act on a merely cleared ticket"
        )

    def test_approving_is_what_tells_finance(self):
        claim = self._cleared("CH-N2")
        Notification.objects.all().delete()
        self.client.force_login(self.head)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        told = set(
            Notification.objects.filter(claim_id=claim.id)
            .values_list("user__role", flat=True)
        )
        self.assertIn(Role.FINANCE, told)

    def test_the_claimant_is_told_where_their_ticket_actually_is(self):
        """It said "with Finance" at a point where Finance could not pay it."""
        title, body = api_module._faculty_status_copy(ClaimStatus.CLEARED)
        self.assertIn("Principal", title + body)
        self.assertNotIn("with Finance", body)

        title, body = api_module._faculty_status_copy(ClaimStatus.PRINCIPAL_APPROVED)
        self.assertIn("Finance", body)

    def test_the_principal_approves_and_then_it_is_payable(self):
        claim = self._cleared("CH-2")
        self.client.force_login(self.head)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)
        self.assertEqual(claim.principal_approved_by_id, self.head.id)
        self.assertIsNotNone(claim.principal_approved_at)

        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_an_imported_erp_row_is_not_payable_just_because_of_its_status(self):
        """The import carries PRINCIPAL_APPROVED with nobody behind it: no
        verification, no recomputed amount, no signature. Only an approval
        taken here sets principal_approved_at, and that is what the gate reads."""
        claim = self._cleared("CH-3")
        Claim.objects.filter(pk=claim.pk).update(
            status=ClaimStatus.PRINCIPAL_APPROVED, principal_approved_at=None
        )
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("retired approval status", r.json()["detail"])

    def test_only_the_principal_approves(self):
        claim = self._cleared("CH-4")
        for who in (self.cell, self.finance, self.faculty):
            self.client.force_login(who)
            r = self.client.post(
                f"/api/claims/{claim.id}/principal-approve",
                data=json.dumps({"expected_amount": 105000.0}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")

    def test_the_approved_amount_is_the_amount_paid(self):
        """An approval given for one figure must not be paid at another."""
        claim = self._cleared("CH-5")
        self.client.force_login(self.head)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"expected_amount": 12345.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

    def test_a_batch_approves_what_it_can_and_names_what_it_cannot(self):
        good = self._cleared("CH-6")
        already = self._cleared("CH-7")
        Claim.objects.filter(pk=already.pk).update(status=ClaimStatus.SUBMITTED)

        self.client.force_login(self.head)
        r = self.client.post(
            "/api/principal/bulk-approve",
            data=json.dumps({"claim_ids": [good.id, already.id]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["approved"], 1)
        self.assertEqual(body["total"], 105000.0)
        self.assertEqual(len(body["skipped"]), 1)
        self.assertIn("CH-7", body["skipped"][0]["reason"])

    def test_the_queue_totals_cover_the_filter_not_the_page(self):
        for i in range(3):
            self._cleared(f"CH-Q{i}", amount=10000.0)
        self.client.force_login(self.head)
        r = self.client.get("/api/principal/queue?limit=1")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(len(body["results"]), 1, "one row on the page")
        self.assertEqual(body["totals"]["count"], 3, "three in the total")
        self.assertEqual(body["totals"]["amount"], 30000.0)

    def test_the_queue_can_be_narrowed_by_how_long_something_has_waited(self):
        fresh = self._cleared("CH-NEW", amount=1000.0)
        old = self._cleared("CH-OLD", amount=2000.0)
        Claim.objects.filter(pk=old.pk).update(
            cleared_at=timezone.now() - timedelta(days=40)
        )
        self.client.force_login(self.head)
        r = self.client.get("/api/principal/queue?waiting_over=30")
        body = r.json()
        self.assertEqual(body["totals"]["count"], 1)
        self.assertEqual(body["results"][0]["ticket_number"], "CH-OLD")
        self.assertGreaterEqual(body["results"][0]["waiting_days"], 40)
        self.assertNotIn(fresh.ticket_number, [c["ticket_number"] for c in body["results"]])

    def test_the_principal_sends_one_back_to_the_research_cell(self):
        claim = self._cleared("CH-8")
        self.client.force_login(self.head)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-reject",
            data=json.dumps({"note": "The quartile does not match that year"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertIn("quartile", claim.status_note)
        # The research cell hears about it; it is their checking being queried.
        self.assertTrue(
            Notification.objects.filter(user=self.cell, claim_id=claim.id).exists()
        )

    def test_sending_it_back_needs_a_reason(self):
        claim = self._cleared("CH-9")
        self.client.force_login(self.head)
        r = self.client.post(
            f"/api/claims/{claim.id}/principal-reject",
            data=json.dumps({"note": "no"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)



class BudgetTests(TestCase):
    """Allocation, spend, and the part nobody was tracking: what is committed."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="bud-admin@test.edu", password="pass", role=Role.SUPER_ADMIN
        )
        self.faculty = User.objects.create_user(
            email="bud-fac@test.edu", password="pass", name="Bud Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def _claim(self, status, amount, month=None):
        return Claim.objects.create(
            owner=self.faculty, status=status, remuneration=amount,
            paper_title="Budget test", journal_title="J", payout_month=month,
        )

    def test_the_financial_year_runs_april_to_march(self):
        from core.api import financial_year_of
        from datetime import date as d

        self.assertEqual(financial_year_of(d(2026, 4, 1)), "2026-27")
        self.assertEqual(financial_year_of(d(2027, 3, 31)), "2026-27")
        self.assertEqual(financial_year_of(d(2026, 3, 31)), "2025-26")

    def test_cleared_and_approved_money_counts_as_committed(self):
        """It is owed. Reporting only what has been paid understates the
        position by exactly the amount about to leave the account."""
        from datetime import date as d

        self.client.post(
            "/api/budgets",
            data=json.dumps({"financial_year": "2026-27", "amount": 100000}),
            content_type="application/json",
        )
        self._claim(ClaimStatus.PAID, 10000, d(2026, 5, 1))
        self._claim(ClaimStatus.CLEARED, 5000)
        self._claim(ClaimStatus.PRINCIPAL_APPROVED, 7000)
        # Outside the year, so it must not count against this allocation.
        self._claim(ClaimStatus.PAID, 90000, d(2025, 5, 1))

        r = self.client.get("/api/budgets?financial_year=2026-27")
        self.assertEqual(r.status_code, 200, r.content)
        college = r.json()["college"]
        self.assertEqual(college["allocated"], 100000)
        self.assertEqual(college["spent"], 10000)
        self.assertEqual(college["committed"], 12000)
        self.assertEqual(college["remaining"], 78000)

    def test_a_year_with_no_allocation_says_so_rather_than_guessing(self):
        r = self.client.get("/api/budgets?financial_year=2030-31")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["college"]["allocated"])
        self.assertIsNone(r.json()["college"]["remaining"])

    def test_departmental_allocations_add_up_to_a_college_ceiling(self):
        """Without a college-wide row, the departments are the only ceiling
        there is -- and saying so is better than reporting none."""
        for dept, amount in (("CSE", 60000), ("ECE", 40000)):
            self.client.post(
                "/api/budgets",
                data=json.dumps(
                    {"financial_year": "2027-28", "department": dept, "amount": amount}
                ),
                content_type="application/json",
            )
        r = self.client.get("/api/budgets?financial_year=2027-28")
        self.assertEqual(r.json()["college"]["allocated"], 100000)

    def test_a_malformed_year_is_refused(self):
        r = self.client.get("/api/budgets?financial_year=2026")
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_claimant_cannot_read_or_set_the_budget(self):
        self.client.force_login(self.faculty)
        self.assertEqual(self.client.get("/api/budgets").status_code, 403)
        r = self.client.post(
            "/api/budgets",
            data=json.dumps({"financial_year": "2026-27", "amount": 1}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)


class DuplicateSweepTests(TestCase):
    """The sweep over paid history, and the review it produces."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="sweep-admin@test.edu", password="pass", role=Role.SUPER_ADMIN
        )
        self.a = User.objects.create_user(
            email="sweep-a@test.edu", password="pass", name="Person A",
            role=Role.FACULTY, department="CSE",
        )
        self.b = User.objects.create_user(
            email="sweep-b@test.edu", password="pass", name="Person B",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def _paid(self, owner, title, amount, ticket, doi=None):
        return Claim.objects.create(
            owner=owner, status=ClaimStatus.PAID, paper_title=title,
            remuneration=amount, ticket_number=ticket, doi=doi, journal_title="J",
        )

    def test_one_person_paid_twice_is_a_finding_worth_the_second_payment(self):
        from django.core.management import call_command

        self._paid(self.a, "A Repeated Paper", 40000, "T-1")
        self._paid(self.a, "A Repeated Paper", 40000, "T-2")
        call_command("find_duplicate_payments", verbosity=0)

        f = DuplicateFinding.objects.get(kind=DuplicateFinding.Kind.SAME_PERSON)
        self.assertEqual(f.payment_count, 2)
        self.assertEqual(f.total_amount, 80000)
        # One of the two was due; the other is the sum at issue.
        self.assertEqual(f.extra_amount, 40000)
        self.assertEqual(f.status, DuplicateFinding.Status.OPEN)

    def test_co_authors_are_recorded_separately_and_not_as_a_repeat(self):
        from django.core.management import call_command

        self._paid(self.a, "A Shared Paper", 30000, "T-3")
        self._paid(self.b, "A Shared Paper", 20000, "T-4")
        call_command("find_duplicate_payments", verbosity=0)

        self.assertFalse(
            DuplicateFinding.objects.filter(kind=DuplicateFinding.Kind.SAME_PERSON).exists()
        )
        cross = DuplicateFinding.objects.get(kind=DuplicateFinding.Kind.CROSS_PERSON)
        self.assertEqual(cross.payment_count, 2)
        self.assertEqual(cross.total_amount, 50000)

    def test_a_ledger_row_that_mirrors_a_claim_is_not_its_own_duplicate(self):
        """The ERP import wrote every payment into both tables. Counting both
        would report all three thousand payments as duplicates of themselves."""
        from django.core.management import call_command

        self._paid(self.a, "An Imported Paper", 25000, "ERP-9001")
        PriorPayment.objects.create(
            faculty_name="Person A", paper_title="An Imported Paper",
            normalized_title=normalize_title("An Imported Paper"),
            amount_paid=25000, claim_ref="ERP-9001",
        )
        call_command("find_duplicate_payments", verbosity=0)
        self.assertEqual(DuplicateFinding.objects.count(), 0)

    def test_a_finding_is_reviewed_and_the_decision_is_recorded(self):
        from django.core.management import call_command

        self._paid(self.a, "A Repeated Paper", 40000, "T-5")
        self._paid(self.a, "A Repeated Paper", 40000, "T-6")
        call_command("find_duplicate_payments", verbosity=0)
        f = DuplicateFinding.objects.get(kind=DuplicateFinding.Kind.SAME_PERSON)

        r = self.client.post(
            f"/api/admin/duplicate-findings/{f.id}",
            data=json.dumps({"status": "CONFIRMED", "note": "Paid twice in error"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        f.refresh_from_db()
        self.assertEqual(f.status, DuplicateFinding.Status.CONFIRMED)
        self.assertEqual(f.reviewed_by_id, self.admin.id)
        self.assertTrue(
            AuditLog.objects.filter(action="DUPLICATE_REVIEW", entity_id=f.id).exists()
        )

    def test_dismissing_one_needs_a_reason(self):
        from django.core.management import call_command

        self._paid(self.a, "A Repeated Paper", 40000, "T-7")
        self._paid(self.a, "A Repeated Paper", 40000, "T-8")
        call_command("find_duplicate_payments", verbosity=0)
        f = DuplicateFinding.objects.get(kind=DuplicateFinding.Kind.SAME_PERSON)

        r = self.client.post(
            f"/api/admin/duplicate-findings/{f.id}",
            data=json.dumps({"status": "DISMISSED"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)


class JournalStandingTests(TestCase):
    """A journal's standing has a date, and so does the paper."""

    def test_nothing_is_claimed_when_no_list_has_been_loaded(self):
        from core.services.verify import check_journal_standing

        out = check_journal_standing(issn="1234-5678", publication_year=2026)
        self.assertFalse(out["checked"])
        self.assertEqual(out["issues"], [])
        self.assertIn("not checked", out["message"])

    def test_a_paper_published_after_the_removal_is_flagged(self):
        from datetime import date as d
        from core.services.verify import check_journal_standing

        JournalStanding.objects.create(
            source=JournalStanding.Source.SCOPUS_DISCONTINUED,
            issn="12345678", listed=False, changed_on=d(2025, 1, 1),
        )
        out = check_journal_standing(issn="1234-5678", publication_year=2026)
        self.assertTrue(out["checked"])
        self.assertTrue(any("removed" in i for i in out["issues"]), out)

    def test_a_paper_published_before_the_removal_is_not(self):
        """It was a recognised journal at the time, which is what the policy asks."""
        from datetime import date as d
        from core.services.verify import check_journal_standing

        JournalStanding.objects.create(
            source=JournalStanding.Source.SCOPUS_DISCONTINUED,
            issn="12345678", listed=False, changed_on=d(2025, 1, 1),
        )
        out = check_journal_standing(issn="1234-5678", publication_year=2023)
        self.assertEqual(out["issues"], [])
        self.assertTrue(out.get("notes"))

    def test_the_quartile_lookup_says_which_year_it_used(self):
        """Scimago is held for a couple of years only, so an older paper falls
        back -- and that has to be visible, not silent."""
        from core.services.scimago import lookup_scimago

        ScimagoJournal.objects.create(
            source_id="1", title="Test Journal Of Things", issn="99990000",
            year=2025, categories_json=json.dumps(
                [{"category": "Engineering", "quartile": "Q1"}]
            ),
        )
        exact = lookup_scimago(issn="9999-0000", year=2025)
        self.assertTrue(exact["year_exact"])
        fallback = lookup_scimago(issn="9999-0000", year=2019)
        self.assertFalse(fallback["year_exact"])
        self.assertEqual(fallback["dataset_year"], 2025)
        self.assertEqual(fallback["requested_year"], 2019)


class ReportingPackTests(TestCase):
    """The accreditation tables, in the columns the frameworks ask for."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="pack-admin@test.edu", password="pass", role=Role.SUPER_ADMIN
        )
        self.faculty = User.objects.create_user(
            email="pack-fac@test.edu", password="pass", name="Pack Faculty",
            role=Role.FACULTY, department="CSE", designation="Professor",
            staff_id="STF-P",
        )
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="A Counted Paper",
            journal_title="Journal of Things", issn="1234-5678", publication_year=2025,
            quartile="Q1", indexing_level="Scopus", remuneration=55000,
            author_position=1, total_authors=2,
        )
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.DRAFT, paper_title="Never Filed",
            journal_title="J", publication_year=2025,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def _table(self, name: str, query: str = "year=2025") -> dict:
        """One named table out of the pack, with rows back as positions.

        The JSON format returns each row as an object keyed by column, which
        is right for a consumer and awkward for a test that cares about column
        order. Turning it back here keeps these assertions about the pack
        rather than about the serialisation.
        """
        res = self.client.get(f"/api/reports/pack?{query}&fmt=json")
        self.assertEqual(res.status_code, 200, res.content[:200])
        body = json.loads(res.content)
        table = next((t for t in body["tables"] if t["name"] == name), None)
        self.assertIsNotNone(table, f"{name} missing; got {[t['name'] for t in body['tables']]}")
        return {
            "columns": table["columns"],
            "rows": [[row.get(c) for c in table["columns"]] for row in table["rows"]],
        }

    def test_the_naac_sheet_has_the_columns_naac_asks_for(self):
        naac = self._table("NAAC 3.4.3")
        self.assertEqual(naac["columns"][:5], [
            "Sl. No.", "Title of paper", "Name of the author/s",
            "Department of the teacher", "Name of journal",
        ])
        # Drafts are not publications.
        self.assertEqual(len(naac["rows"]), 1)
        self.assertEqual(naac["rows"][0][1], "A Counted Paper")

    def test_the_ugc_column_says_not_checked_when_no_list_is_loaded(self):
        """Reporting "No" would assert something nobody checked."""
        self.assertEqual(self._table("NAAC 3.4.3")["rows"][0][-1], "Not checked")

    def test_the_ugc_column_answers_once_a_list_exists(self):
        JournalStanding.objects.create(
            source=JournalStanding.Source.UGC_CARE, issn="12345678", listed=True
        )
        self.assertEqual(self._table("NAAC 3.4.3")["rows"][0][-1], "Yes")

    def test_the_nirf_sheet_counts_by_year_and_carries_no_citation_columns(self):
        nirf = self._table("NIRF publications")
        self.assertNotIn("Citations", " ".join(nirf["columns"]))
        row = nirf["rows"][0]
        self.assertEqual(row[0], 2025)
        self.assertEqual(row[1], 1, "one Scopus publication")
        self.assertEqual(row[3], 1, "one publication in total")

    def test_the_notes_sheet_says_what_could_not_be_produced(self):
        notes = " ".join(str(c) for row in self._table("Notes")["rows"] for c in row)
        self.assertIn("citation", notes.lower())

    def test_it_downloads_as_a_real_workbook(self):
        r = self.client.get("/api/reports/pack?year=2025")
        self.assertEqual(r.status_code, 200)
        self.assertIn("spreadsheetml", r["Content-Type"])
        self.assertEqual(bytes(r.content[:2]), b"PK")

    def test_a_claimant_cannot_download_the_college_pack(self):
        self.client.force_login(self.faculty)
        self.assertEqual(self.client.get("/api/reports/pack").status_code, 403)



class FacultyBoundaryTests(TestCase):
    """What a claimant can and cannot reach, held in the suite rather than in
    an audit script somebody has to remember to run.

    The list below is every door the faculty account can push on that decides
    money, identity, or somebody else's data.
    """

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="edge-fac@test.edu", password="pass", name="Edge Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-E",
            biometric_id="BIO-E",
        )
        self.other = User.objects.create_user(
            email="edge-other@test.edu", password="pass", name="Other Faculty",
            role=Role.FACULTY, department="ECE",
        )
        self.their_claim = Claim.objects.create(
            owner=self.other, status=ClaimStatus.PAID, paper_title="Not Theirs",
            journal_title="J", remuneration=90000, ticket_number="OTH-1",
        )
        self.own = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED,
            paper_title="Their Own Ticket", journal_title="J",
            remuneration=105000, ticket_number="OWN-1", quartile="Q1", snip=1.0,
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def test_a_claimant_cannot_edit_a_ticket_once_it_is_submitted(self):
        """Otherwise the figures an approver is looking at can change under
        them between reading and clearing."""
        r = self.client.patch(
            f"/api/claims/{self.own.id}",
            data=json.dumps({"paper_title": "Edited After Submission", "snip": 30}),
            content_type="application/json",
        )
        self.assertGreaterEqual(r.status_code, 400, r.content)
        self.own.refresh_from_db()
        self.assertEqual(self.own.paper_title, "Their Own Ticket")
        self.assertEqual(self.own.snip, 1.0)

    def test_a_claimant_cannot_open_or_change_somebody_else_s_ticket(self):
        r = self.client.get(f"/api/claims/{self.their_claim.id}")
        self.assertIn(r.status_code, (403, 404), r.content)
        r = self.client.patch(
            f"/api/claims/{self.their_claim.id}",
            data=json.dumps({"paper_title": "Hijacked"}),
            content_type="application/json",
        )
        self.assertIn(r.status_code, (403, 404), r.content)
        self.their_claim.refresh_from_db()
        self.assertEqual(self.their_claim.paper_title, "Not Theirs")

    def test_their_own_list_holds_only_their_own(self):
        r = self.client.get("/api/claims?limit=100")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        rows = body.get("results", body) if isinstance(body, dict) else body
        owners = {c.get("owner_id") for c in rows}
        self.assertTrue(owners <= {str(self.faculty.id), self.faculty.id, None}, owners)

    def test_no_money_moves_at_a_claimant_s_request(self):
        for path, payload in [
            (f"/api/claims/{self.own.id}/clear", {"expected_amount": 105000}),
            (f"/api/claims/{self.own.id}/principal-approve", {"expected_amount": 105000}),
            (f"/api/claims/{self.own.id}/mark-paid", {"expected_amount": 105000}),
            (f"/api/claims/{self.own.id}/second-approve", {}),
            (f"/api/claims/{self.own.id}/void-payment", {"note": "x" * 20}),
            ("/api/admin/bulk-clear", {"claim_ids": [self.own.id]}),
            ("/api/admin/bulk-mark-paid", {"items": [{"claim_id": self.own.id}]}),
            ("/api/budgets", {"financial_year": "2026-27", "amount": 1}),
        ]:
            r = self.client.post(
                path, data=json.dumps(payload), content_type="application/json"
            )
            self.assertIn(r.status_code, (403, 404), f"{path}: {r.content}")
        self.own.refresh_from_db()
        self.assertEqual(self.own.status, ClaimStatus.SUBMITTED)

    def test_a_claimant_cannot_rewrite_the_payout_formula(self):
        """A complete, valid body -- a partial one is refused by schema
        validation before the permission check, which proves nothing."""
        r = self.client.put(
            "/api/admin/formula",
            data=json.dumps({
                "snip_multiplier": 999999,
                "qf_q1": 1, "qf_q2": 1, "qf_q3": 1, "qf_q4": 1,
                "author_point_json": '{"1": 1}',
            }),
            content_type="application/json",
        )
        self.assertIn(r.status_code, (403, 404), r.content)

    def test_a_claimant_cannot_read_the_college_s_figures(self):
        for path in [
            "/api/reports",
            "/api/reports/search?limit=1",
            "/api/reports/pack?fmt=json",
            "/api/reports/export",
            "/api/budgets",
            "/api/admin/users?limit=1",
            "/api/admin/duplicate-findings",
            "/api/admin/payouts?limit=1",
            "/api/principal/queue",
            f"/api/faculty/{self.other.id}/report",
        ]:
            r = self.client.get(path)
            self.assertIn(r.status_code, (403, 404), f"{path}: {r.status_code}")

    def test_the_lookup_box_is_scoped_rather_than_blocked(self):
        """A claimant may look up their own ticket number. What must not come
        back is anybody else's ticket, or any person."""
        r = self.client.get("/api/lookup/ticket?q=OTH")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["tickets"], [])
        self.assertEqual(body["faculty"], [])

        r = self.client.get("/api/lookup/ticket?q=OWN")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            [t["ticket_number"] for t in r.json()["tickets"]], ["OWN-1"]
        )

    def test_private_notes_on_their_own_ticket_stay_private(self):
        r = self.client.get(f"/api/claims/{self.own.id}/notes")
        self.assertEqual(r.status_code, 403, r.content)



class PermissionMatrixTests(TestCase):
    """Every role against every door, checked against the declaration.

    The rules live at the point of use, which is right, but that leaves
    nowhere to notice a new endpoint given the wrong guard. core/permission
    _matrix.py writes the intended picture down; this asserts the running
    system matches it.

    Reaching the handler is what is being checked, not succeeding: finance may
    call mark-paid and still be refused because the ticket is not approved.
    So a 4xx that is not 403 counts as "got through the door" -- the business
    rule behind it is tested elsewhere.
    """

    @classmethod
    def setUpTestData(cls):
        from core.permission_matrix import ROLES

        cls.users = {}
        for role in ROLES:
            cls.users[role] = User.objects.create_user(
                email=f"matrix-{role.lower()}@test.edu",
                password="pass",
                name=f"Matrix {role.title()}",
                role=role,
                department="CSE",
                staff_id=f"STF-{role[:3]}",
                biometric_id=f"BIO-{role[:3]}",
            )
        # Somebody to be edited, reset and impersonated, who is not the actor.
        cls.target = User.objects.create_user(
            email="matrix-target@test.edu", password="pass", name="Matrix Target",
            role=Role.FACULTY, department="CSE",
        )
        cls.claim = Claim.objects.create(
            owner=cls.target, status=ClaimStatus.SUBMITTED,
            paper_title="Matrix Subject", journal_title="J", issn="1234-5678",
            remuneration=1000, ticket_number="MTX-1",
        )

    def _call(self, client, capability, actor_role=""):
        import json as _json

        path = capability.path.replace("{claim}", self.claim.id).replace(
            "{user}", str(self.target.id)
        )
        body = capability.payload
        if body is not None:
            body = _json.loads(
                _json.dumps(body)
                .replace("{claim}", self.claim.id)
                .replace("{user}", str(self.target.id))
                .replace("{actor}", actor_role.lower())
            )
        method = getattr(client, capability.method.lower())
        if capability.upload:
            # A real file, so schema validation cannot answer 422 in place of
            # the permission check and leave an unlocked door looking shut.
            from django.core.files.uploadedfile import SimpleUploadedFile

            return method(
                path,
                data={"file": SimpleUploadedFile("probe.csv", b"a,b\n1,2\n")},
            )
        if body is None:
            return method(path)
        return method(path, data=_json.dumps(body), content_type="application/json")

    def test_every_role_against_every_door(self):
        from core.permission_matrix import CAPABILITIES, ROLES

        wrong = []
        for capability in CAPABILITIES:
            for role in ROLES:
                client = Client()
                client.force_login(self.users[role])
                response = self._call(client, capability, role)
                got_through = response.status_code != 403
                should = role in capability.allowed
                if got_through != should:
                    wrong.append(
                        f"{capability.name} · {role}: "
                        f"{'reached' if got_through else 'refused'} "
                        f"({response.status_code}), expected "
                        f"{'to reach' if should else 'a refusal'}"
                        f" — {capability.because}"
                    )
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))

    def test_the_declaration_covers_what_it_claims_to(self):
        """A matrix that has drifted out of date is worse than none: it reads
        as coverage. Every capability must name a door that exists."""
        from django.urls import resolve
        from core.permission_matrix import CAPABILITIES

        self.assertGreaterEqual(len(CAPABILITIES), 25)
        for capability in CAPABILITIES:
            path = capability.path.replace("{claim}", self.claim.id).replace(
                "{user}", str(self.target.id)
            )
            resolve(path.split("?")[0])  # raises if no route matches
            self.assertTrue(capability.because.strip(), capability.name)
            self.assertTrue(capability.allowed, f"{capability.name} allows nobody")

    def test_a_role_that_nothing_recognises_cannot_be_assigned(self):
        """The field took any string. An account carrying "NONSENSE", or an
        empty string, fails every permission check while reading normally in
        the user list -- locked out of everything with nothing to explain it."""
        client = Client()
        client.force_login(self.users["SUPER_ADMIN"])
        for bad in ("NONSENSE", "", "hod", "SUPER ADMIN"):
            r = client.patch(
                f"/api/admin/users/{self.target.id}",
                data=json.dumps({"role": bad}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400, f"{bad!r}: {r.content}")
            self.target.refresh_from_db()
            self.assertEqual(self.target.role, Role.FACULTY)

    def test_the_hod_role_carries_capabilities_and_can_be_assigned(self):
        """It was a relic with no permissions -- an account holding it could
        sign in and do nothing, so assigning it was a way to brick somebody.
        It has a department portal now, so it is a real role again."""
        from core.permission_matrix import CAPABILITIES, HOD

        theirs = [c.name for c in CAPABILITIES if HOD in c.allowed]
        self.assertTrue(theirs, "HOD holds no capability, so it should not be assignable")

        client = Client()
        client.force_login(self.users["SUPER_ADMIN"])
        r = client.patch(
            f"/api/admin/users/{self.target.id}",
            data=json.dumps({"role": "HOD", "department": "CSE"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.target.refresh_from_db()
        self.assertEqual(self.target.role, Role.HOD)

    def test_a_head_holds_no_capability_that_touches_money(self):
        """The whole point of the role. Every door it can open must be one of
        its own department screens."""
        from core.permission_matrix import CAPABILITIES, HOD

        for capability in CAPABILITIES:
            if HOD in capability.allowed:
                self.assertTrue(
                    capability.path.startswith("/api/hod/"),
                    f"a head may reach {capability.path}, which is not a department screen",
                )

    def test_a_real_role_is_still_accepted(self):
        client = Client()
        client.force_login(self.users["SUPER_ADMIN"])
        for good in ("PRINCIPAL", "FINANCE", "RESEARCH_CELL", "FACULTY"):
            r = client.patch(
                f"/api/admin/users/{self.target.id}",
                data=json.dumps({"role": good}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 200, f"{good}: {r.content}")

    def test_a_duplicate_email_is_refused_rather_than_crashing(self):
        """It answered 500 with a stack trace, because nothing checked before
        the database did. Creating heads of department ran straight into it:
        two of the addresses already belonged to real people."""
        client = Client()
        client.force_login(self.users["SUPER_ADMIN"])
        r = client.post(
            "/api/admin/users",
            data=json.dumps({
                "email": self.target.email.upper(),  # case must not slip past
                "name": "Clash",
                "password": "a-long-enough-one",
                "role": "FACULTY",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        detail = r.json()["detail"]
        self.assertIn("already belongs to", detail)
        self.assertIn(self.target.name, detail)

    def test_a_user_cannot_be_created_with_an_unrecognised_role(self):
        client = Client()
        client.force_login(self.users["SUPER_ADMIN"])
        r = client.post(
            "/api/admin/users",
            data=json.dumps({
                "email": "bad-role@test.edu", "name": "Bad Role",
                "password": "a-long-enough-one", "role": "WHATEVER",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(User.objects.filter(email="bad-role@test.edu").exists())

    def test_no_door_is_open_to_everybody(self):
        """A capability every role may use is either mis-declared or should
        not be in a permission matrix at all."""
        from core.permission_matrix import CAPABILITIES, ROLES

        for capability in CAPABILITIES:
            self.assertNotEqual(
                set(capability.allowed), set(ROLES),
                f"{capability.name} is open to every role",
            )



class DataExplorerTests(TestCase):
    """Reading is wide; writing is deliberately narrow.

    The explorer is the one feature that could undo everything else: a grid
    able to set `status = PAID` makes the trust boundary, the payment gates,
    the amount guards and the duplicate controls all optional. So the shape of
    it is the thing under test.
    """

    def setUp(self):
        self.admin = User.objects.create_user(
            email="dx-admin@test.edu", password="pass", name="DX Admin",
            role=Role.SUPER_ADMIN,
        )
        self.cell = User.objects.create_user(
            email="dx-cell@test.edu", password="pass", name="DX Cell",
            role=Role.RESEARCH_CELL,
        )
        self.head = User.objects.create_user(
            email="dx-head@test.edu", password="pass", name="DX Head",
            role=Role.PRINCIPAL,
        )
        self.finance = User.objects.create_user(
            email="dx-fin@test.edu", password="pass", role=Role.FINANCE
        )
        self.faculty = User.objects.create_user(
            email="dx-fac@test.edu", password="pass", name="DX Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.paid = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, paper_title="Explorer Subject",
            journal_title="J", remuneration=90000, ticket_number="DX-1",
            quartile="Q1", snip=1.0,
        )
        self.journal = ScimagoJournal.objects.create(
            source_id="dx1", title="Journal Of Explorer Testing", issn="99991111",
            year=2025, categories_json=json.dumps([{"category": "Eng", "quartile": "Q1"}]),
        )
        self.client = Client()

    # ---- who gets in ----------------------------------------------------

    def test_the_admin_and_the_principal_may_browse_and_nobody_else(self):
        for who, allowed in (
            (self.admin, True), (self.cell, True), (self.head, True),
            (self.finance, False), (self.faculty, False),
        ):
            self.client.force_login(who)
            r = self.client.get("/api/admin/data/tables")
            self.assertEqual(
                r.status_code, 200 if allowed else 403, f"{who.role}: {r.status_code}"
            )

    def test_only_a_super_admin_may_correct_anything(self):
        for who in (self.cell, self.head, self.finance, self.faculty):
            self.client.force_login(who)
            r = self.client.patch(
                f"/api/admin/data/ScimagoJournal/{self.journal.id}",
                data=json.dumps({
                    "column": "title", "value": "Changed", "reason": "a probe attempt",
                }),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")
        self.journal.refresh_from_db()
        self.assertEqual(self.journal.title, "Journal Of Explorer Testing")

    # ---- what it will never show ----------------------------------------

    def test_a_password_hash_is_not_data_to_browse(self):
        self.client.force_login(self.admin)
        r = self.client.get("/api/admin/data/User?limit=1")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertNotIn("password", [c["name"] for c in body["columns"]])
        self.assertNotIn("password", body["rows"][0])
        self.assertNotIn("is_superuser", body["rows"][0])

    # ---- what it will never write ---------------------------------------

    def test_the_workflow_columns_cannot_be_written_here(self):
        """This is the whole point. Each of these has a screen that owns it,
        recalculates around it and records who moved it."""
        self.client.force_login(self.admin)
        for column, value in (
            ("status", "DRAFT"),
            ("remuneration", 1),
            ("paid_at", None),
            ("quartile", "Q4"),
            ("snip", 30),
            ("override_duplicate", True),
            ("payout_month", "2020-01-01"),
        ):
            r = self.client.patch(
                f"/api/admin/data/Claim/{self.paid.id}",
                data=json.dumps({
                    "column": column, "value": value, "reason": "attempting a change",
                }),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400, f"{column}: {r.content}")
            self.assertIn("not editable here", r.json()["detail"])
        self.paid.refresh_from_db()
        self.assertEqual(self.paid.status, ClaimStatus.PAID)
        self.assertEqual(self.paid.remuneration, 90000)

    def test_the_audit_log_cannot_be_edited_by_anybody(self):
        """A record that can be rewritten is not a record."""
        entry = AuditLog.objects.create(
            actor=self.admin, action="TEST", entity="Thing", entity_id="1"
        )
        self.client.force_login(self.admin)
        r = self.client.patch(
            f"/api/admin/data/AuditLog/{entry.id}",
            data=json.dumps({"column": "action", "value": "SOMETHING ELSE",
                             "reason": "attempting a rewrite"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        entry.refresh_from_db()
        self.assertEqual(entry.action, "TEST")

    # ---- what it will write ---------------------------------------------

    def test_reference_data_is_correctable_and_the_change_is_recorded(self):
        self.client.force_login(self.admin)
        r = self.client.patch(
            f"/api/admin/data/ScimagoJournal/{self.journal.id}",
            data=json.dumps({
                "column": "title",
                "value": "Journal of Explorer Testing",
                "reason": "matched against the publisher page",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.journal.refresh_from_db()
        self.assertEqual(self.journal.title, "Journal of Explorer Testing")

        entry = AuditLog.objects.filter(action="DATA_EDIT").first()
        self.assertIsNotNone(entry)
        detail = json.loads(entry.detail_json)
        self.assertEqual(detail["from"], "Journal Of Explorer Testing")
        self.assertEqual(detail["to"], "Journal of Explorer Testing")
        self.assertIn("publisher page", detail["reason"])

    def test_a_correction_without_a_reason_is_refused(self):
        self.client.force_login(self.admin)
        r = self.client.patch(
            f"/api/admin/data/ScimagoJournal/{self.journal.id}",
            data=json.dumps({"column": "title", "value": "x", "reason": ""}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    # ---- reading ---------------------------------------------------------

    def test_search_and_filter_narrow_the_rows(self):
        self.client.force_login(self.admin)
        r = self.client.get("/api/admin/data/Claim?q=Explorer%20Subject")
        self.assertEqual(r.json()["total"], 1)
        r = self.client.get("/api/admin/data/Claim?filters=status:PAID")
        self.assertEqual(r.json()["total"], 1)
        r = self.client.get("/api/admin/data/Claim?filters=status:REJECTED")
        self.assertEqual(r.json()["total"], 0)

    def test_a_filter_on_a_column_that_does_not_exist_is_refused(self):
        """Otherwise a typo silently returns the whole table, and the reader
        believes the number in front of them."""
        self.client.force_login(self.admin)
        r = self.client.get("/api/admin/data/Claim?filters=nonsense:x")
        self.assertEqual(r.status_code, 400, r.content)

    def test_an_export_carries_the_filter_rather_than_the_whole_table(self):
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.DRAFT, paper_title="Not exported",
            journal_title="J",
        )
        self.client.force_login(self.admin)
        r = self.client.get("/api/admin/data/Claim/export?filters=status:PAID&fmt=csv")
        self.assertEqual(r.status_code, 200)
        body = r.content.decode()
        self.assertIn("Explorer Subject", body)
        self.assertNotIn("Not exported", body)

    def test_every_format_comes_back_as_that_format(self):
        self.client.force_login(self.admin)
        expected = {
            "csv": "text/csv",
            "tsv": "text/tab-separated-values",
            "json": "application/json",
            "md": "text/markdown",
            "xlsx": "spreadsheetml",
        }
        for fmt, content_type in expected.items():
            r = self.client.get(f"/api/admin/data/Budget/export?fmt={fmt}")
            self.assertEqual(r.status_code, 200, fmt)
            self.assertIn(content_type, r["Content-Type"], fmt)
        # The two delimited ones must actually differ.
        csv_body = self.client.get("/api/admin/data/Budget/export?fmt=csv").content.decode()
        tsv_body = self.client.get("/api/admin/data/Budget/export?fmt=tsv").content.decode()
        self.assertIn(",", csv_body.split("\n")[0])
        self.assertIn("\t", tsv_body.split("\n")[0])
        self.assertNotIn("\t", csv_body.split("\n")[0])

    def test_an_export_is_audited(self):
        self.client.force_login(self.admin)
        self.client.get("/api/admin/data/User/export?fmt=csv")
        self.assertTrue(AuditLog.objects.filter(action="DATA_EXPORT").exists())

    def test_every_declared_table_actually_resolves(self):
        """A registry naming a model that no longer exists is a screen that
        breaks the moment somebody clicks it."""
        from core import data_explorer

        self.client.force_login(self.admin)
        for table in data_explorer.TABLES:
            self.assertIsNotNone(
                data_explorer.model_for(table.model_name), table.model_name
            )
            r = self.client.get(f"/api/admin/data/{table.model_name}?limit=1")
            self.assertEqual(r.status_code, 200, f"{table.model_name}: {r.content}")
            self.assertTrue(table.about.strip(), table.model_name)

    def test_every_declared_column_exists_on_its_model(self):
        """A registry naming a column the model does not have is a screen that
        500s the moment somebody opens that table -- which is exactly how the
        payment ledger was broken when this was written."""
        from core import data_explorer

        wrong = []
        for table in data_explorer.TABLES:
            model = data_explorer.model_for(table.model_name)
            names = {f.name for f in model._meta.fields}
            for label, columns in (
                ("order", [table.order.lstrip("-")]),
                ("highlight", list(table.highlight)),
                ("editable", list(table.editable)),
            ):
                for column in columns:
                    if column and column not in names:
                        wrong.append(f"{table.model_name}.{label}: no column {column!r}")
        self.assertEqual(wrong, [], "\n" + "\n".join(wrong))

    def test_an_unknown_table_is_a_404_not_a_crash(self):
        self.client.force_login(self.admin)
        self.assertEqual(self.client.get("/api/admin/data/Nonsense").status_code, 404)



class HeadOfDepartmentTests(TestCase):
    """A head sees their own department, and no money by any route.

    Money-blindness is the reason the role exists in this shape, and its
    failure mode is quiet: one endpoint that forgets to filter, one export
    column, one nested row. So the tests read what a head actually receives
    and look for a rupee figure in it, rather than trusting the filter.
    """

    def setUp(self):
        self.head = User.objects.create_user(
            email="head-cse@test.edu", password="pass", name="Head of CSE",
            role=Role.HOD, department="CSE",
        )
        self.mine = User.objects.create_user(
            email="cse-person@test.edu", password="pass", name="CSE Person",
            role=Role.FACULTY, department="CSE",
        )
        self.theirs = User.objects.create_user(
            email="ece-person@test.edu", password="pass", name="ECE Person",
            role=Role.FACULTY, department="ECE",
        )
        common = dict(journal_title="J", issn="1111-2222", publication_year=2025)
        self.paid = Claim.objects.create(
            owner=self.mine, status=ClaimStatus.PAID, paper_title="A CSE Paper",
            remuneration=90000, quartile="Q1", snip=1.2, ticket_number="CSE-1",
            author_position=1, total_authors=2, voucher_number="V-9",
            indexing_level="Scopus", **common,
        )
        Claim.objects.create(
            owner=self.mine, status=ClaimStatus.DRAFT, paper_title="Unfinished",
            remuneration=1000, **common,
        )
        Claim.objects.create(
            owner=self.theirs, status=ClaimStatus.PAID, paper_title="An ECE Paper",
            remuneration=70000, quartile="Q2", ticket_number="ECE-1", **common,
        )
        self.client = Client()
        self.client.force_login(self.head)

    # ---- scope -----------------------------------------------------------

    def test_a_head_sees_their_own_department_and_no_other(self):
        r = self.client.get("/api/hod/publications")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        titles = {row["paper_title"] for row in body["results"]}
        self.assertIn("A CSE Paper", titles)
        self.assertNotIn("An ECE Paper", titles)
        self.assertEqual(body["department"], "CSE")

    def test_asking_for_somebody_in_another_department_returns_nothing(self):
        """A head asking about another department is not a filter to widen --
        it is a different question with a different answer."""
        r = self.client.get(f"/api/hod/publications?person={self.theirs.id}")
        self.assertEqual(r.json()["total"], 0)

    def test_drafts_are_not_departmental_output(self):
        """An unfinished ticket is the claimant's working paper. Counting it
        would tell a head they had more publications than they do."""
        titles = {
            row["paper_title"] for row in self.client.get("/api/hod/publications").json()["results"]
        }
        self.assertNotIn("Unfinished", titles)
        self.assertEqual(self.client.get("/api/hod/overview").json()["totals"]["publications"], 1)

    # ---- money -----------------------------------------------------------

    def _assert_no_money(self, payload, where):
        from core.hod import MONEY_KEYS

        def walk(node, path):
            if isinstance(node, dict):
                for key, value in node.items():
                    self.assertNotIn(key, MONEY_KEYS, f"{where}: {key} at {path}")
                    walk(value, f"{path}.{key}")
            elif isinstance(node, list):
                for item in node:
                    walk(item, path)

        walk(payload, "")

    def test_no_money_key_reaches_a_head_from_any_department_screen(self):
        for path in ("/api/hod/overview", "/api/hod/publications?limit=50"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self._assert_no_money(r.json(), path)
            body = r.content.decode()
            for token in ("remuneration", "voucher", "payout_month", "paid_at", "90000"):
                self.assertNotIn(token, body, f"{path} leaked {token!r}")

    def test_the_export_carries_no_money_column(self):
        r = self.client.get("/api/hod/export?fmt=csv")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.content.decode()
        header = body.split("\n")[0].lower()
        for token in ("amount", "remuner", "voucher", "paid", "rupee"):
            self.assertNotIn(token, header, f"the export header carries {token!r}")
        self.assertIn("A CSE Paper", body)
        self.assertNotIn("An ECE Paper", body)
        self.assertNotIn("90000", body)

    def test_the_status_is_translated_rather_than_handed_over(self):
        """"PAID" tells a head their colleague was paid."""
        rows = self.client.get("/api/hod/publications").json()["results"]
        self.assertEqual(rows[0]["progress"], "Completed")
        self.assertNotIn("status", rows[0])

    def test_a_head_cannot_reach_a_screen_that_carries_money(self):
        for path in (
            "/api/reports",
            "/api/reports/export",
            "/api/reports/pack?fmt=json",
            "/api/budgets",
            "/api/admin/payouts?limit=1",
            "/api/admin/data/Claim?limit=1",
            "/api/principal/queue",
            "/api/claims?limit=1",
            f"/api/claims/{self.paid.id}",
            "/api/admin/duplicate-findings",
        ):
            r = self.client.get(path)
            self.assertIn(r.status_code, (403, 404), f"{path}: {r.status_code}")

    def test_nobody_else_can_use_the_department_screens(self):
        """They answer for the signed-in person's own department, so another
        role reaching them would be answering for a department they do not
        have."""
        for who in (self.mine, self.theirs):
            self.client.force_login(who)
            self.assertEqual(self.client.get("/api/hod/overview").status_code, 403)

    # ---- the shape of the answer ----------------------------------------

    def test_the_overview_counts_the_department_and_its_people(self):
        body = self.client.get("/api/hod/overview").json()
        self.assertEqual(body["department"], "CSE")
        totals = body["totals"]
        self.assertEqual(totals["publications"], 1)
        self.assertEqual(totals["q1"], 1)
        self.assertEqual(totals["first_author"], 1)
        self.assertEqual(totals["faculty_in_department"], 1)
        names = {p["name"] for p in body["people"]}
        self.assertIn("CSE Person", names)
        self.assertNotIn("ECE Person", names)

    def test_a_head_with_no_department_is_told_rather_than_shown_everything(self):
        """The scope comes from their own account. With none set, the safe
        answer is a refusal, not the whole college."""
        self.head.department = ""
        self.head.save()
        self.client.force_login(self.head)
        r = self.client.get("/api/hod/overview")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("no department", r.json()["detail"])


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
        self.head = User.objects.create_user(
            email="rep-head@test.edu", password="pass", name="Head", role=Role.PRINCIPAL
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
        # The principal hears about each one, because a cleared ticket waits on
        # their approval. Finance does not: they cannot pay it yet, and telling
        # them about money they cannot move is how a queue stops being read.
        self.assertEqual(
            Notification.objects.filter(
                user=self.head, claim_id__in=[self.a.id, self.b.id]
            ).count(),
            2,
        )
        self.assertEqual(
            Notification.objects.filter(
                user=self.finance, claim_id__in=[self.a.id, self.b.id]
            ).count(),
            0,
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

        # The principal approves the spend; without this nothing reaches finance.
        head = User.objects.create_user(
            email="uc-head@test.edu", password="pass", name="UC Head", role=Role.PRINCIPAL
        )
        c.force_login(head)
        r = c.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"expected_amount": expected}),
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
            owner=self.user, status=ClaimStatus.PRINCIPAL_APPROVED,
            principal_approved_at=timezone.now(), ticket_number="UC-PAY-2",
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


class IssnNormalizeTests(TestCase):
    """An ISSN that a spreadsheet has been at is still that ISSN.

    Two forms exist in the live tables, both from being read as numbers, and
    the normalizer mishandled each in a different way.
    """

    def test_float_form_does_not_become_a_different_issn(self):
        # "2728842.0" once cleaned to eight characters -- the float's own
        # trailing zero -- and was returned as 2728-8420, a well-formed ISSN
        # belonging to some other journal. A wrong match attaches the wrong
        # quartile, and quartile is a term in the payout.
        self.assertEqual(normalize_issn("2728842.0"), "0272-8842")

    def test_lost_leading_zero_is_restored(self):
        self.assertEqual(normalize_issn("2728842"), "0272-8842")

    def test_well_formed_issn_is_untouched(self):
        self.assertEqual(normalize_issn("0272-8842"), "0272-8842")
        self.assertEqual(normalize_issn("1024123X"), "1024-123X")

    def test_a_trailing_zero_that_belongs_is_kept(self):
        # 0975-3060 genuinely ends in a zero; stripping ".0" must not fire on
        # a value that has no decimal point in it.
        self.assertEqual(normalize_issn("09753060"), "0975-3060")

    def test_nonsense_is_passed_through_rather_than_invented(self):
        self.assertEqual(normalize_issn("not an issn"), "not an issn")
        self.assertIsNone(normalize_issn(None))


class JournalRecordTests(TestCase):
    """A journal is a record, and it obeys the same boundaries as the rest."""

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="jr-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.faculty = User.objects.create_user(
            email="jr-fac@test.edu", password="pass", name="Fac One",
            role=Role.FACULTY, department="ECE",
        )
        self.other = User.objects.create_user(
            email="jr-other@test.edu", password="pass", name="Fac Two",
            role=Role.FACULTY, department="CSE",
        )
        self.head = User.objects.create_user(
            email="jr-head@test.edu", password="pass", name="Head",
            role=Role.HOD, department="ECE",
        )
        ScimagoJournal.objects.create(
            title="Test Ceramics", issn="02728842", year=2025, sjr=0.961,
            categories_json=json.dumps(
                [{"category": "Ceramics", "quartile": "Q1"},
                 {"category": "Chemistry", "quartile": "Q3"}]
            ),
        )
        for owner, issn in ((self.faculty, "2728842"), (self.other, None)):
            Claim.objects.create(
                owner=owner, paper_title=f"Paper by {owner.name}",
                journal_title="Test Ceramics", issn=issn,
                status=ClaimStatus.PAID, remuneration=50000,
                publication_year=2025, quartile="Q1",
            )

    def _get(self, user, url):
        c = Client()
        c.force_login(user)
        return c.get(url)

    def test_reference_data_is_matched_through_the_mangled_issn(self):
        res = self._get(self.admin, "/api/journals/report?title=Test Ceramics")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        # The claim carries "2728842" and the reference row "02728842": the
        # two only meet if every spelling is tried.
        self.assertEqual(body["journal"]["scimago"]["sjr"], 0.961)
        self.assertEqual(body["journal"]["scimago"]["best_quartile"], "Q1")
        self.assertEqual(body["journal"]["issn"], "0272-8842")
        self.assertEqual(body["totals"]["publications"], 2)
        self.assertEqual(body["totals"]["paid_amount"], 100000)

    def test_unknown_journal_is_a_404_not_an_empty_record(self):
        res = self._get(self.admin, "/api/journals/report?title=No Such Journal")
        self.assertEqual(res.status_code, 404)

    def test_a_claimant_cannot_read_the_college_wide_record(self):
        res = self._get(self.faculty, "/api/journals/report?title=Test Ceramics")
        self.assertEqual(res.status_code, 403)

    def test_a_head_sees_only_their_department_and_no_money(self):
        res = self._get(self.head, "/api/journals/report?title=Test Ceramics")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        # One of the two papers is CSE, which is not this head's to see.
        self.assertEqual(body["totals"]["publications"], 1)
        self.assertNotIn("paid_amount", body["totals"])
        blob = json.dumps(body)
        self.assertNotIn("remuneration", blob)
        # "PAID" is not an amount, but it still says a colleague was paid.
        self.assertNotIn("PAID", blob)
        self.assertIn("Completed", blob)

    def test_top_list_is_scoped_and_money_free_for_a_head(self):
        res = self._get(self.head, "/api/journals/top?limit=10")
        self.assertEqual(res.status_code, 200)
        rows = res.json()["results"]
        self.assertEqual(rows[0]["key"], "Test Ceramics")
        self.assertEqual(rows[0]["count"], 1)
        self.assertNotIn("amount", rows[0])


class SearchNarrowingTests(TestCase):
    """Drill-downs from a record must carry the record with them."""

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="sn-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.a = User.objects.create_user(
            email="sn-a@test.edu", password="pass", name="A", role=Role.FACULTY,
            department="ECE",
        )
        self.b = User.objects.create_user(
            email="sn-b@test.edu", password="pass", name="B", role=Role.FACULTY,
            department="ECE",
        )
        Claim.objects.create(
            owner=self.a, paper_title="A one", journal_title="Alpha Journal",
            status=ClaimStatus.PAID, remuneration=100, quartile="Q1",
        )
        Claim.objects.create(
            owner=self.b, paper_title="B one", journal_title="Alpha Journal",
            status=ClaimStatus.PAID, remuneration=200, quartile="Q1",
        )
        Claim.objects.create(
            owner=self.a, paper_title="A two", journal_title="Beta Journal",
            status=ClaimStatus.PAID, remuneration=300, quartile="Q2",
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def test_owner_narrows_to_one_person(self):
        # Without this, a quartile bar on A's record linked to the college's
        # Q1 papers rather than to A's -- a worse answer than no link.
        body = self.client.get(f"/api/reports/search?owner={self.a.id}").json()
        self.assertEqual(body["total"], 2)
        self.assertEqual(body["total_amount"], 400)

    def test_journal_narrows_to_one_journal_exactly(self):
        body = self.client.get("/api/reports/search?journal=Alpha Journal").json()
        self.assertEqual(body["total"], 2)

    def test_owner_and_quartile_compose(self):
        body = self.client.get(
            f"/api/reports/search?owner={self.a.id}&quartile=Q1"
        ).json()
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["results"][0]["paper_title"], "A one")


class ReportDrillDownTests(TestCase):
    """Every figure the reports draw must open the rows behind it.

    A chart the reader cannot get behind is a number they have to take on
    trust, and the three dimensions here had no filter at all — so clicking
    "Associate Professor, 797" could only ever have gone to an unfiltered
    list, which is worse than not being a link.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="dd-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.prof = User.objects.create_user(
            email="dd-prof@test.edu", password="pass", name="Prof",
            role=Role.FACULTY, department="ECE", designation="Professor",
        )
        self.assoc = User.objects.create_user(
            email="dd-assoc@test.edu", password="pass", name="Assoc",
            role=Role.FACULTY, department="ECE", designation="Associate Professor",
        )
        self.nograde = User.objects.create_user(
            email="dd-none@test.edu", password="pass", name="Nograde",
            role=Role.FACULTY, department="ECE",
        )
        mk = lambda owner, kind, month, title: Claim.objects.create(
            owner=owner, paper_title=title, journal_title="J",
            status=ClaimStatus.PAID, remuneration=100,
            aggregation_type=kind, payout_month=month,
        )
        mk(self.prof, "Journal", date(2026, 1, 1), "P1")
        mk(self.prof, "Conference Proceeding", date(2026, 2, 1), "P2")
        mk(self.assoc, "Journal", date(2026, 1, 1), "A1")
        mk(self.nograde, "", date(2026, 2, 1), "N1")
        self.client = Client()
        self.client.force_login(self.admin)

    def total(self, qs: str) -> int:
        res = self.client.get(f"/api/reports/search?{qs}")
        self.assertEqual(res.status_code, 200, res.content[:200])
        return res.json()["total"]

    def test_designation_narrows_to_one_grade(self):
        self.assertEqual(self.total("designation=Professor"), 2)
        self.assertEqual(self.total("designation=Associate Professor"), 1)

    def test_the_blank_designation_bucket_opens_the_blanks(self):
        # The chart labels these "Not recorded". Sending that string as a
        # designation would match nobody, so the row would open an empty list
        # while claiming a count.
        self.assertEqual(self.total("designation=Not recorded"), 1)

    def test_kind_of_publication_narrows(self):
        self.assertEqual(self.total("publication_type=Journal"), 2)
        self.assertEqual(self.total("publication_type=Conference Proceeding"), 1)
        self.assertEqual(self.total("publication_type=Not stated"), 1)

    def test_payout_month_narrows_to_that_month(self):
        self.assertEqual(self.total("month=2026-01"), 2)
        self.assertEqual(self.total("month=2026-02"), 2)

    def test_a_month_that_is_not_a_month_is_refused_not_ignored(self):
        # Silently ignoring it would return the whole college under a chip
        # saying one month, which is how a wrong figure gets quoted.
        res = self.client.get("/api/reports/search?month=nonsense")
        self.assertEqual(res.status_code, 400)

    def test_the_figure_and_the_rows_behind_it_agree(self):
        # The reports page and the query screen must count the same way, or
        # the drill-down quietly contradicts the chart it came from.
        report = self.client.get("/api/reports").json()
        by_designation = {r["key"]: r for r in report["by_designation"]}
        for key, row in by_designation.items():
            self.assertEqual(
                self.total(f"designation={key}"),
                row["count"],
                f"{key}: chart says {row['count']}",
            )


class ExportFormatTests(TestCase):
    """A report leaves this system in five shapes, and each must be its own.

    The failure this guards against is a quiet one: an endpoint that ignores
    `fmt` and hands back a workbook labelled as a PDF. The browser saves it,
    the name ends .pdf, and nobody finds out until somebody tries to open it.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="ex-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        owner = User.objects.create_user(
            email="ex-fac@test.edu", password="pass", name="Fac",
            role=Role.FACULTY, department="ECE", designation="Professor",
        )
        Claim.objects.create(
            owner=owner, paper_title="A paper", journal_title="A journal",
            issn="2728842", status=ClaimStatus.PAID, remuneration=100,
            publication_year=2025,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    #: The first bytes of each format, which is what identifies a file.
    MAGIC = {
        "xlsx": b"PK\x03\x04",
        "docx": b"PK\x03\x04",
        "pdf": b"%PDF",
        "json": b"{",
        "csv": b"\xef\xbb\xbf",  # the BOM Excel needs to read UTF-8
    }

    def test_each_format_returns_that_format(self):
        for fmt, magic in self.MAGIC.items():
            with self.subTest(fmt=fmt):
                res = self.client.get(f"/api/reports/pack?fmt={fmt}")
                self.assertEqual(res.status_code, 200)
                self.assertTrue(
                    res.content.startswith(magic),
                    f"{fmt} began {res.content[:8]!r}, not {magic!r}",
                )
                self.assertIn(f".{fmt}", res["Content-Disposition"])

    def test_an_unknown_format_is_refused_rather_than_guessed(self):
        self.assertEqual(self.client.get("/api/reports/pack?fmt=exe").status_code, 400)

    def test_csv_says_which_tables_it_could_not_carry(self):
        body = self.client.get("/api/reports/pack?fmt=csv").content.decode("utf-8-sig")
        # A CSV holds one table. Silently containing one of five is how the
        # wrong table gets submitted.
        self.assertIn("CSV holds one table", body)
        self.assertIn("NIRF publications", body)

    def test_json_rows_are_objects_not_positions(self):
        body = json.loads(self.client.get("/api/reports/pack?fmt=json").content)
        table = body["tables"][0]
        self.assertTrue(table["rows"])
        # A consumer reading row[7] has to be told what column seven is, and
        # will be wrong the first time a column is inserted.
        self.assertIsInstance(table["rows"][0], dict)
        self.assertIn("Title of paper", table["rows"][0])

    def test_preview_is_capped_but_reports_the_real_count(self):
        body = self.client.get("/api/reports/pack?fmt=preview").json()
        for table in body["tables"]:
            self.assertLessEqual(len(table["rows"]), 25)
            self.assertGreaterEqual(table["row_count"], len(table["rows"]))

    def test_the_submission_carries_a_well_formed_issn(self):
        body = self.client.get("/api/reports/pack?fmt=json").content.decode()
        # The ticket holds "2728842" because a spreadsheet dropped the leading
        # zero; an assessor checking it against a register needs 0272-8842.
        self.assertIn("0272-8842", body)


class ReportHealthCutsTests(TestCase):
    """Ageing, breadth, and year against year."""

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="hc-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.a = User.objects.create_user(
            email="hc-a@test.edu", password="pass", name="A", role=Role.FACULTY,
            department="ECE",
        )
        self.b = User.objects.create_user(
            email="hc-b@test.edu", password="pass", name="B", role=Role.FACULTY,
            department="CSE",
        )
        now = timezone.now()
        fresh = Claim.objects.create(
            owner=self.a, paper_title="Fresh", status=ClaimStatus.SUBMITTED,
            remuneration=500, publication_year=2026,
        )
        Claim.objects.filter(pk=fresh.pk).update(submitted_at=now - timedelta(days=2))
        old = Claim.objects.create(
            owner=self.a, paper_title="Old", status=ClaimStatus.SUBMITTED,
            remuneration=700, publication_year=2026,
        )
        Claim.objects.filter(pk=old.pk).update(submitted_at=now - timedelta(days=60))
        # Two already paid, which have stopped ageing.
        for title in ("Done", "Done 2"):
            Claim.objects.create(
                owner=self.b, paper_title=title, status=ClaimStatus.PAID,
                remuneration=900, publication_year=2025,
            )
        self.client = Client()
        self.client.force_login(self.admin)

    def report(self):
        return self.client.get("/api/reports").json()

    def test_ageing_counts_only_what_is_still_in_the_chain(self):
        ageing = self.report()["ageing"]
        # The paid claims have stopped ageing; including them would bury the
        # one that needs chasing under the ones that do not.
        self.assertEqual(ageing["total"], 2)
        buckets = {r["key"]: r["count"] for r in ageing["rows"]}
        self.assertEqual(buckets["Up to a week"], 1)
        self.assertEqual(buckets["1–3 months"], 1)
        self.assertGreaterEqual(ageing["oldest_days"], 59)

    def test_every_bucket_is_listed_even_when_empty(self):
        # "Nothing over three months" is the answer somebody wanted, and a
        # missing row does not say it.
        keys = [r["key"] for r in self.report()["ageing"]["rows"]]
        self.assertEqual(len(keys), 5)
        self.assertIn("Over 3 months", keys)

    def test_breadth_separates_more_people_from_more_papers(self):
        rows = {r["key"]: r for r in self.report()["breadth"]}
        self.assertEqual(rows["2026"]["people"], 1)
        self.assertEqual(rows["2026"]["count"], 2)
        self.assertEqual(rows["2026"]["per_person"], 2.0)
        self.assertEqual(rows["2026"]["top_ten_share"], 100)

    def test_year_on_year_marks_a_part_year_as_partial(self):
        yoy = self.report()["year_on_year"]
        self.assertEqual(yoy["this_year"], 2026)
        self.assertEqual(yoy["last_year"], 2025)
        # Without this the reader sees every department down by half and
        # believes it.
        self.assertTrue(yoy["this_year_is_partial"])

    def test_a_department_with_no_previous_year_has_no_percentage(self):
        rows = {r["key"]: r for r in self.report()["year_on_year"]["rows"]}
        # ECE published nothing in 2025: a percentage change would divide by
        # zero and print an infinity where a reader expects a figure.
        self.assertEqual(rows["ECE"]["previous"], 0)
        self.assertIsNone(rows["ECE"]["percent"])
        self.assertEqual(rows["ECE"]["change"], 2)


class PackRowCorrectionTests(TestCase):
    """Working through the submission, and the walls around doing so.

    This screen exists so the office can tidy a NAAC file. The thing it must
    never become is a second way to move money, so most of what is asserted
    here is what it refuses.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="pr-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.faculty = User.objects.create_user(
            email="pr-fac@test.edu", password="pass", name="Fac",
            role=Role.FACULTY, department="ECE", designation="Professor",
        )
        self.finance = User.objects.create_user(
            email="pr-fin@test.edu", password="pass", name="Fin",
            role=Role.FINANCE,
        )
        self.complete = Claim.objects.create(
            owner=self.faculty, paper_title="Complete paper",
            journal_title="A journal", issn="0272-8842", publication_year=2025,
            doi="10.1000/ok", status=ClaimStatus.PAID, remuneration=1000,
        )
        self.gappy = Claim.objects.create(
            owner=self.faculty, paper_title="Gappy paper",
            journal_title="A journal", publication_year=2025,
            status=ClaimStatus.PAID, remuneration=2000,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def rows(self, query: str = "") -> dict:
        res = self.client.get(f"/api/reports/pack/rows?{query}")
        self.assertEqual(res.status_code, 200, res.content[:200])
        return res.json()

    def patch(self, claim, body, user=None):
        c = self.client
        if user is not None:
            c = Client()
            c.force_login(user)
        return c.patch(
            f"/api/reports/pack/rows/{claim.id}",
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_a_row_names_what_it_is_missing(self):
        by_id = {r["id"]: r for r in self.rows()["results"]}
        self.assertEqual(by_id[self.complete.id]["gaps"], [])
        # NAAC asks for an ISSN and a link on every row; this one has neither.
        self.assertIn("No ISSN", by_id[self.gappy.id]["gaps"])
        self.assertIn("No link to the paper", by_id[self.gappy.id]["gaps"])

    def test_gap_counts_are_over_the_whole_set_not_the_page(self):
        body = self.rows("limit=1")
        self.assertEqual(len(body["results"]), 1)
        counts = {g["key"]: g["count"] for g in body["gaps"]}
        # "412 rows have no ISSN" is the number somebody plans an afternoon
        # around; a per-page count would understate it enormously.
        self.assertEqual(counts["No ISSN"], 1)
        self.assertEqual(counts["No title"], 0)

    def test_filtering_to_a_gap_returns_only_those_rows(self):
        body = self.rows("only=No ISSN")
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["results"][0]["id"], self.gappy.id)

    def test_a_correction_fixes_the_row_and_records_why(self):
        res = self.patch(self.gappy, {
            "field": "issn", "value": "2728842",
            "reason": "ISSN read off the printed copy",
        })
        self.assertEqual(res.status_code, 200, res.content[:200])
        # Normalised on the way in, so the submission carries the form a
        # register uses rather than what a spreadsheet left behind.
        self.assertEqual(res.json()["row"]["issn"], "0272-8842")
        self.gappy.refresh_from_db()
        self.assertEqual(self.gappy.issn, "0272-8842")
        action = ClaimAction.objects.filter(claim=self.gappy, action="PACK_CORRECT").first()
        self.assertIsNotNone(action)
        self.assertIn("printed copy", action.note)
        self.assertTrue(AuditLog.objects.filter(action="PACK_CORRECT").exists())

    def test_money_cannot_be_touched_from_here(self):
        res = self.patch(self.gappy, {
            "field": "remuneration", "value": "999999", "reason": "trying it on",
        })
        self.assertEqual(res.status_code, 400)
        self.gappy.refresh_from_db()
        self.assertEqual(self.gappy.remuneration, 2000)

    def test_the_tickets_stage_cannot_be_touched_from_here(self):
        res = self.patch(self.gappy, {
            "field": "status", "value": "DRAFT", "reason": "trying it on",
        })
        self.assertEqual(res.status_code, 400)
        self.gappy.refresh_from_db()
        self.assertEqual(self.gappy.status, ClaimStatus.PAID)

    def test_a_reason_is_required(self):
        res = self.patch(self.gappy, {"field": "issn", "value": "0272-8842", "reason": "x"})
        self.assertEqual(res.status_code, 400)

    def test_an_impossible_year_is_refused(self):
        res = self.patch(self.gappy, {
            "field": "publication_year", "value": "1200", "reason": "fixing a typo",
        })
        self.assertEqual(res.status_code, 400)

    def test_a_year_that_is_not_a_number_is_refused(self):
        res = self.patch(self.gappy, {
            "field": "publication_year", "value": "last year", "reason": "fixing a typo",
        })
        self.assertEqual(res.status_code, 400)

    def test_finance_may_not_edit_the_submission(self):
        # Finance releases money; the submission is the research cell's.
        res = self.patch(self.gappy, {
            "field": "issn", "value": "0272-8842", "reason": "tidying the file",
        }, user=self.finance)
        self.assertEqual(res.status_code, 403)

    def test_a_claimant_cannot_read_the_college_wide_rows(self):
        c = Client()
        c.force_login(self.faculty)
        self.assertEqual(c.get("/api/reports/pack/rows").status_code, 403)

    def test_ugc_reads_not_checked_until_a_list_exists(self):
        body = self.rows()
        self.assertFalse(body["ugc_list_loaded"])
        # Reporting "No" would assert something nobody checked.
        self.assertTrue(all(r["ugc_care"] == "Not checked" for r in body["results"]))


class SearchExportTests(TestCase):
    """The rows on screen, as a file.

    The existing export takes a year, a department and a month — the monthly
    filing. It cannot express "Q1 Engineering papers in ECE that went unpaid",
    so anyone looking at that set exported something wider and rebuilt it by
    hand in Excel, which is the step where a filed figure stops matching the
    screen it came from.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="se-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.faculty = User.objects.create_user(
            email="se-fac@test.edu", password="pass", name="Fac",
            role=Role.FACULTY, department="ECE", designation="Professor",
        )
        for title, quartile in (("Q1 paper", "Q1"), ("Q2 paper", "Q2")):
            Claim.objects.create(
                owner=self.faculty, paper_title=title, journal_title="J",
                quartile=quartile, status=ClaimStatus.PAID, remuneration=100,
                publication_year=2025,
            )
        self.client = Client()
        self.client.force_login(self.admin)

    def test_the_file_holds_exactly_the_filtered_rows(self):
        res = self.client.get("/api/reports/search/export?quartile=Q1&fmt=csv")
        self.assertEqual(res.status_code, 200)
        body = res.content.decode("utf-8", errors="ignore")
        self.assertIn("Q1 paper", body)
        # The whole point: the other row is not in the file.
        self.assertNotIn("Q2 paper", body)

    def test_it_returns_a_real_workbook(self):
        res = self.client.get("/api/reports/search/export?quartile=Q1&fmt=xlsx")
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.content.startswith(b"PK\x03\x04"))
        self.assertIn("spreadsheetml", res["Content-Type"])

    def test_a_claimant_cannot_export_the_college(self):
        c = Client()
        c.force_login(self.faculty)
        self.assertEqual(
            c.get("/api/reports/search/export?quartile=Q1").status_code, 403
        )


class DeletionGuardTests(TestCase):
    """The two endpoints that destroy things, and what stops them.

    This is the most dangerous code in the system: a delete has no undo and
    the database holds the record of real payments to real people. Nearly
    every assertion here is about a refusal.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="del-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.cell = User.objects.create_user(
            email="del-cell@test.edu", password="pass", name="Cell",
            role=Role.RESEARCH_CELL,
        )
        self.faculty = User.objects.create_user(
            email="del-fac@test.edu", password="pass", name="Fac",
            role=Role.FACULTY, department="ECE",
        )
        self.paid = Claim.objects.create(
            owner=self.faculty, paper_title="Paid paper", journal_title="J",
            status=ClaimStatus.PAID, remuneration=5000, publication_year=2025,
        )
        self.draft = Claim.objects.create(
            owner=self.faculty, paper_title="A draft", journal_title="J",
            status=ClaimStatus.DRAFT, publication_year=2025,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def delete(self, table, row_id, reason="removing a row left by a failed import", user=None):
        c = self.client
        if user is not None:
            c = Client()
            c.force_login(user)
        return c.delete(
            f"/api/admin/data/{table}/row/{row_id}",
            data=json.dumps({"reason": reason}),
            content_type="application/json",
        )

    # ---- deleting one row -------------------------------------------

    def test_a_paid_publication_cannot_be_deleted(self):
        res = self.delete("Claim", self.paid.id)
        self.assertEqual(res.status_code, 400)
        self.assertIn("paid", res.json()["detail"].lower())
        # Still there, which is the whole point.
        self.assertTrue(Claim.objects.filter(pk=self.paid.pk).exists())

    def test_the_audit_log_cannot_be_deleted_from(self):
        entry = AuditLog.objects.create(actor=self.admin, action="X", entity="Y")
        res = self.delete("AuditLog", entry.id)
        self.assertEqual(res.status_code, 400)
        self.assertTrue(AuditLog.objects.filter(pk=entry.pk).exists())

    def test_only_a_super_admin_may_delete(self):
        # The research cell manages users and clears claims, and still cannot
        # do this.
        self.assertEqual(self.delete("Claim", self.draft.id, user=self.cell).status_code, 403)
        self.assertEqual(self.delete("Claim", self.draft.id, user=self.faculty).status_code, 403)
        self.assertTrue(Claim.objects.filter(pk=self.draft.pk).exists())

    def test_a_reason_in_words_is_required(self):
        self.assertEqual(self.delete("Claim", self.draft.id, reason="oops").status_code, 400)

    def test_you_cannot_delete_the_account_you_are_signed_in_as(self):
        res = self.delete("User", self.admin.id)
        self.assertEqual(res.status_code, 400)

    def test_a_draft_deletes_and_says_what_it_was(self):
        res = self.delete("Claim", self.draft.id)
        self.assertEqual(res.status_code, 200, res.content[:200])
        self.assertFalse(Claim.objects.filter(pk=self.draft.pk).exists())
        entry = AuditLog.objects.filter(action="DATA_DELETE").first()
        self.assertIsNotNone(entry)
        # Written before the row went: afterwards there is nothing to describe.
        self.assertIn("failed import", entry.detail_json)

    # ---- emptying the system ----------------------------------------

    def wipe(self, body, user=None):
        c = self.client
        if user is not None:
            c = Client()
            c.force_login(user)
        return c.post("/api/admin/wipe", data=json.dumps(body), content_type="application/json")

    def test_preview_says_what_would_go_and_what_survives(self):
        body = self.client.get("/api/admin/wipe/preview").json()
        self.assertEqual(body["paid_claims"], 1)
        self.assertEqual(body["paid_amount"], 5000)
        self.assertGreaterEqual(body["total_rows"], 2)
        self.assertTrue(body["kept"])

    def test_the_phrase_must_be_exact(self):
        for phrase in ["delete everything", "DELETE EVERYTHIN", "", "yes"]:
            res = self.wipe({
                "confirm": phrase, "reason": "clearing the test data",
                "i_understand_payments_will_be_lost": True,
            })
            self.assertEqual(res.status_code, 400, phrase)
        self.assertTrue(Claim.objects.exists())

    def test_settled_payments_need_their_own_consent(self):
        res = self.wipe({"confirm": "DELETE EVERYTHING", "reason": "clearing the test data"})
        self.assertEqual(res.status_code, 400)
        self.assertIn("settled payments", res.json()["detail"])
        self.assertTrue(Claim.objects.exists())

    def test_a_stale_row_count_is_refused(self):
        # The caller confirmed against a number that is no longer true, which
        # means something changed between reading and pressing.
        res = self.wipe({
            "confirm": "DELETE EVERYTHING", "reason": "clearing the test data",
            "expect_rows": 999999, "i_understand_payments_will_be_lost": True,
        })
        self.assertEqual(res.status_code, 409)
        self.assertTrue(Claim.objects.exists())

    def test_only_a_super_admin_may_empty_the_system(self):
        for who in (self.cell, self.faculty):
            res = self.wipe({
                "confirm": "DELETE EVERYTHING", "reason": "clearing the test data",
                "i_understand_payments_will_be_lost": True,
            }, user=who)
            self.assertEqual(res.status_code, 403)
        self.assertTrue(Claim.objects.exists())

    def test_a_wipe_empties_the_records_and_keeps_the_accounts_and_the_trail(self):
        res = self.wipe({
            "confirm": "DELETE EVERYTHING",
            "reason": "clearing the test data before the live import",
            "i_understand_payments_will_be_lost": True,
        })
        self.assertEqual(res.status_code, 200, res.content[:200])
        self.assertEqual(Claim.objects.count(), 0)
        # Everybody keeps their login, and the wipe is in the log that
        # survived it — a wipe that erased its own trace would be worthless.
        self.assertTrue(User.objects.filter(pk=self.admin.pk).exists())
        self.assertTrue(User.objects.filter(pk=self.faculty.pk).exists())
        entry = AuditLog.objects.filter(action="SYSTEM_WIPE").first()
        self.assertIsNotNone(entry)
        self.assertIn("live import", entry.detail_json)


class ProfileCorrectionTests(TestCase):
    """Asking for a detail you cannot change, and somebody deciding on it.

    The permission is the point and it does not move: a claimant cannot write
    their own name, staff id or biometric id, because those decide who gets
    paid and whose record a paper is checked against. What changed is that
    asking now produces something an admin can finish rather than a
    notification that could be missed.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.admin = User.objects.create_user(
            email="pc-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.cell = User.objects.create_user(
            email="pc-cell@test.edu", password="pass", name="Cell",
            role=Role.RESEARCH_CELL,
        )
        self.faculty = User.objects.create_user(
            email="pc-fac@test.edu", password="pass", name="Wrong Name",
            role=Role.FACULTY, department="ECE", staff_id="STF-OLD",
        )
        self.fc = Client()
        self.fc.force_login(self.faculty)
        self.ac = Client()
        self.ac.force_login(self.admin)

    def ask(self, field="staff_id", proposed="STF-NEW", note="misspelt on the ERP sheet", client=None):
        return (client or self.fc).post(
            "/api/auth/profile/correction",
            data=json.dumps({"field": field, "proposed": proposed, "note": note}),
            content_type="application/json",
        )

    def decide(self, request_id, approve, note="", client=None):
        return (client or self.ac).post(
            f"/api/admin/profile-requests/{request_id}",
            data=json.dumps({"approve": approve, "note": note}),
            content_type="application/json",
        )

    def test_a_claimant_still_cannot_write_their_own_identity(self):
        # The whole reason the request exists.
        res = self.fc.patch(
            "/api/auth/profile",
            data=json.dumps({"staff_id": "STF-SELF"}),
            content_type="application/json",
        )
        self.assertIn(res.status_code, (403, 400, 404, 405))
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.staff_id, "STF-OLD")

    def test_asking_creates_something_an_admin_can_see(self):
        self.assertEqual(self.ask().status_code, 200)
        body = self.ac.get("/api/admin/profile-requests").json()
        self.assertEqual(body["pending"], 1)
        row = body["results"][0]
        self.assertEqual(row["proposed_value"], "STF-NEW")
        self.assertEqual(row["current_value"], "STF-OLD")
        self.assertTrue(row["identity"])

    def test_asking_twice_updates_one_request_rather_than_queueing_two(self):
        self.ask(proposed="STF-A")
        self.ask(proposed="STF-B")
        rows = ProfileChangeRequest.objects.filter(status="PENDING")
        self.assertEqual(rows.count(), 1)
        self.assertEqual(rows.first().proposed_value, "STF-B")

    def test_asking_for_what_it_already_says_is_refused(self):
        self.assertEqual(self.ask(proposed="STF-OLD").status_code, 400)

    def test_a_claimant_cannot_decide_their_own_request(self):
        self.ask()
        rid = ProfileChangeRequest.objects.first().id
        self.assertEqual(self.decide(rid, True, client=self.fc).status_code, 403)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.staff_id, "STF-OLD")

    def test_the_research_cell_cannot_apply_an_identity_change(self):
        # They clear the claims these fields decide the outcome of, so they
        # cannot also set them. Declining is still open to them.
        self.ask()
        rid = ProfileChangeRequest.objects.first().id
        cc = Client()
        cc.force_login(self.cell)
        self.assertEqual(self.decide(rid, True, client=cc).status_code, 403)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.staff_id, "STF-OLD")

    def test_declining_needs_a_reason_because_the_person_is_shown_it(self):
        self.ask()
        rid = ProfileChangeRequest.objects.first().id
        self.assertEqual(self.decide(rid, False).status_code, 400)

    def test_approving_writes_the_value_and_tells_them(self):
        self.ask()
        rid = ProfileChangeRequest.objects.first().id
        res = self.decide(rid, True, "checked against the ERP sheet")
        self.assertEqual(res.status_code, 200, res.content[:200])
        self.faculty.refresh_from_db()
        # Applied from the queue rather than retyped on another screen, which
        # is where a correction becomes somebody else's staff id.
        self.assertEqual(self.faculty.staff_id, "STF-NEW")
        note = Notification.objects.filter(user=self.faculty).order_by("-created_at").first()
        self.assertIsNotNone(note)
        self.assertIn("STF-NEW", note.body)

    def test_declining_leaves_the_record_alone_and_still_tells_them(self):
        self.ask()
        rid = ProfileChangeRequest.objects.first().id
        self.decide(rid, False, "payroll uses the id on the ERP roster")
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.staff_id, "STF-OLD")
        note = Notification.objects.filter(user=self.faculty).order_by("-created_at").first()
        self.assertIn("payroll", note.body)

    def test_a_request_cannot_be_decided_twice(self):
        self.ask()
        rid = ProfileChangeRequest.objects.first().id
        self.assertEqual(self.decide(rid, True, "fine").status_code, 200)
        self.assertEqual(self.decide(rid, True, "fine").status_code, 400)

    def test_the_requester_can_see_what_came_of_it(self):
        self.ask()
        rid = ProfileChangeRequest.objects.first().id
        self.decide(rid, False, "payroll uses the id on the ERP roster")
        mine = self.fc.get("/api/auth/profile/corrections").json()["results"]
        self.assertEqual(mine[0]["status"], "DECLINED")
        self.assertIn("payroll", mine[0]["decision_note"])

    def test_a_claimant_cannot_read_the_queue(self):
        self.assertEqual(self.fc.get("/api/admin/profile-requests").status_code, 403)


class CollaborationGraphTests(TestCase):
    """Who has written with whom, inferred rather than entered.

    Nobody records co-authorship in this system. Two people filing a claim for
    the same paper are co-authors, and that is the whole of the evidence -- so
    every test here is really a test of one question: when are two claims the
    same paper?

    Getting that wrong in either direction is bad in a way a graph hides. Too
    loose and the screen invents a working relationship between two people who
    have never met, which is embarrassing in a way software rarely is. Too
    tight and the graph is empty and nobody comes back to it.
    """

    def setUp(self):
        def person(email, name, dept, role=Role.FACULTY):
            return User.objects.create_user(
                email=email, password="pass", name=name, role=role, department=dept
            )

        self.anita = person("anita@test.edu", "Anita Rao", "CSE")
        self.bala = person("bala@test.edu", "Bala Krishnan", "CSE")
        self.chitra = person("chitra@test.edu", "Chitra Menon", "ECE")
        self.deepa = person("deepa@test.edu", "Deepa Nair", "MECH")
        self.head = person("head@test.edu", "Head of CSE", "CSE", Role.HOD)

        self.client = Client()
        self.client.force_login(self.anita)

    def claim(self, owner, title, *, doi=None, journal=None, status=ClaimStatus.PAID):
        return Claim.objects.create(
            owner=owner,
            paper_title=title,
            doi=doi,
            journal_title=journal or "Journal of Testing",
            publication_year=2025,
            status=status,
            remuneration=90000,
        )

    # ---- when two claims are the same paper ------------------------------

    def test_the_same_doi_makes_two_people_co_authors(self):
        self.claim(self.anita, "A Paper", doi="10.1016/j.test.2025.01")
        self.claim(self.bala, "A Paper", doi="10.1016/j.test.2025.01")

        body = self.client.get("/api/collaborate/me").json()
        names = {p["name"] for p in body["worked_with"]}
        self.assertEqual(names, {"Bala Krishnan"})
        self.assertEqual(body["worked_with"][0]["together"], 1)

    def test_a_doi_written_two_different_ways_is_still_one_paper(self):
        """People paste what the publisher gave them, which is a URL as often
        as a bare identifier."""
        self.claim(self.anita, "Some Title", doi="https://doi.org/10.1016/J.TEST.2025.02")
        self.claim(self.bala, "A Quite Different Title", doi="10.1016/j.test.2025.02")

        body = self.client.get("/api/collaborate/me").json()
        self.assertEqual([p["name"] for p in body["worked_with"]], ["Bala Krishnan"])

    def test_the_title_matches_when_there_is_no_doi(self):
        """Most of the older imported rows have no DOI at all. If the title
        were not enough, the graph would only know about recent work."""
        self.claim(self.anita, "Deep Learning for Fault Detection")
        self.claim(self.bala, "deep learning for fault detection.")

        body = self.client.get("/api/collaborate/me").json()
        self.assertEqual([p["name"] for p in body["worked_with"]], ["Bala Krishnan"])

    def test_different_dois_are_different_papers_however_alike_the_titles(self):
        """The one that must not go wrong.

        Survey papers repeat titles across venues, and two people who happened
        to write "A Review of Machine Learning" are not collaborators. A DOI is
        definitive where it exists, so it has to override the title rather than
        merely be consulted first.
        """
        self.claim(self.anita, "A Review Of Machine Learning", doi="10.1/aaa")
        self.claim(self.bala, "A Review Of Machine Learning", doi="10.1/bbb")

        body = self.client.get("/api/collaborate/me").json()
        self.assertEqual(body["worked_with"], [])

    def test_an_unfinished_draft_does_not_make_anyone_a_co_author(self):
        """A draft is somebody's working paper. It may never be filed, and
        naming a collaboration off one publishes a private intention."""
        self.claim(self.anita, "Not Filed Yet", doi="10.1/draft")
        self.claim(self.bala, "Not Filed Yet", doi="10.1/draft", status=ClaimStatus.DRAFT)

        self.assertEqual(self.client.get("/api/collaborate/me").json()["worked_with"], [])

    def test_one_paper_filed_by_three_people_pairs_all_three(self):
        self.claim(self.anita, "Three Way", doi="10.1/three")
        self.claim(self.bala, "Three Way", doi="10.1/three")
        self.claim(self.chitra, "Three Way", doi="10.1/three")

        names = {p["name"] for p in self.client.get("/api/collaborate/me").json()["worked_with"]}
        self.assertEqual(names, {"Bala Krishnan", "Chitra Menon"})

    def test_writing_together_repeatedly_counts_up(self):
        for i in range(3):
            self.claim(self.anita, f"Paper {i}", doi=f"10.1/rep{i}")
            self.claim(self.bala, f"Paper {i}", doi=f"10.1/rep{i}")

        row = self.client.get("/api/collaborate/me").json()["worked_with"][0]
        self.assertEqual(row["together"], 3)

    # ---- who you might work with -----------------------------------------

    def test_a_suggestion_is_somebody_publishing_where_you_publish(self):
        self.claim(self.anita, "Mine", journal="Applied Soft Computing")
        self.claim(self.chitra, "Theirs", journal="Applied Soft Computing")

        body = self.client.get("/api/collaborate/me").json()
        names = {s["name"] for s in body["suggestions"]}
        self.assertIn("Chitra Menon", names)

        chitra = next(s for s in body["suggestions"] if s["name"] == "Chitra Menon")
        self.assertEqual(chitra["shared_journals"], ["applied soft computing"])
        self.assertTrue(chitra["cross_department"])
        self.assertIn("journal", chitra["why"])

    def test_you_are_never_suggested_to_yourself(self):
        self.claim(self.anita, "One", journal="Nature Things")
        self.claim(self.anita, "Two", journal="Nature Things")

        body = self.client.get("/api/collaborate/me").json()
        self.assertNotIn(self.anita.id, {s["id"] for s in body["suggestions"]})

    def test_somebody_you_already_write_with_is_not_suggested(self):
        """The screen answers "who could you work with". Somebody you have
        four papers with is not an introduction, and pushes a real one out."""
        self.claim(self.anita, "Together", doi="10.1/tog", journal="Shared Journal")
        self.claim(self.bala, "Together", doi="10.1/tog", journal="Shared Journal")

        body = self.client.get("/api/collaborate/me").json()
        self.assertIn("Bala Krishnan", {p["name"] for p in body["worked_with"]})
        self.assertNotIn("Bala Krishnan", {s["name"] for s in body["suggestions"]})

    def test_somebody_who_shares_no_journal_is_not_suggested(self):
        self.claim(self.anita, "Mine", journal="Applied Soft Computing")
        self.claim(self.deepa, "Theirs", journal="Tribology International")

        names = {s["name"] for s in self.client.get("/api/collaborate/me").json()["suggestions"]}
        self.assertNotIn("Deepa Nair", names)

    def test_the_screen_says_where_the_graph_came_from(self):
        """A relationship the system asserts about two real people has to be
        accountable, or the first person who disagrees with it has nothing to
        argue with."""
        body = self.client.get("/api/collaborate/me").json()
        self.assertIn("same paper", body["derived_from"])

    # ---- the graph -------------------------------------------------------

    def test_a_pair_appears_as_one_link_not_two(self):
        self.claim(self.anita, "Shared", doi="10.1/shared")
        self.claim(self.bala, "Shared", doi="10.1/shared")

        body = self.client.get("/api/collaborate/graph").json()
        self.assertEqual(len(body["links"]), 1)
        self.assertEqual(
            {body["links"][0]["source"], body["links"][0]["target"]},
            {self.anita.id, self.bala.id},
        )

    def test_somebody_who_has_never_co_authored_is_not_a_node(self):
        """An unconnected dot carries no information and crowds out the ones
        that do."""
        self.claim(self.anita, "Shared", doi="10.1/s")
        self.claim(self.bala, "Shared", doi="10.1/s")
        self.claim(self.deepa, "Alone", doi="10.1/alone")

        ids = {n["id"] for n in self.client.get("/api/collaborate/graph").json()["nodes"]}
        self.assertNotIn(self.deepa.id, ids)

    def test_the_graph_caps_and_says_how_many_it_left_out(self):
        """Silently truncating reads as "this is everyone", which is worse
        than showing less and saying so."""
        for i in range(6):
            a = User.objects.create_user(
                email=f"a{i}@test.edu", password="p", name=f"A{i}", department="CSE"
            )
            b = User.objects.create_user(
                email=f"b{i}@test.edu", password="p", name=f"B{i}", department="CSE"
            )
            self.claim(a, f"P{i}", doi=f"10.1/p{i}")
            self.claim(b, f"P{i}", doi=f"10.1/p{i}")

        body = self.client.get("/api/collaborate/graph?limit=4").json()
        self.assertEqual(len(body["nodes"]), 4)
        self.assertEqual(body["hidden"], 8)

    def test_a_head_gets_their_own_department_whatever_they_ask_for(self):
        """The department is not a filter a head widens -- it is the scope of
        the role."""
        self.claim(self.anita, "CSE Paper", doi="10.1/cse")
        self.claim(self.bala, "CSE Paper", doi="10.1/cse")
        self.claim(self.chitra, "ECE Paper", doi="10.1/ece")
        self.claim(self.deepa, "ECE Paper", doi="10.1/ece")

        c = Client()
        c.force_login(self.head)
        body = c.get("/api/collaborate/graph?department=ECE").json()
        self.assertEqual(body["department"], "CSE")
        self.assertEqual({n["name"] for n in body["nodes"]}, {"Anita Rao", "Bala Krishnan"})

    # ---- money -----------------------------------------------------------

    def test_neither_endpoint_carries_a_rupee(self):
        """Heads of department may read both of these, and a head must never
        see money by any route. The failure mode is one forgotten key in one
        nested row, so this reads everything that comes back rather than
        trusting the shape.
        """
        self.claim(self.anita, "Paid Paper", doi="10.1/money")
        self.claim(self.bala, "Paid Paper", doi="10.1/money")

        banned = ("remuneration", "amount", "paid", "money", "voucher", "payout")

        def walk(node, path="body"):
            if isinstance(node, dict):
                for k, v in node.items():
                    self.assertFalse(
                        any(word in k.lower() for word in banned),
                        f"{path}.{k} looks like money",
                    )
                    walk(v, f"{path}.{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, f"{path}[{i}]")
            elif isinstance(node, (int, float)) and not isinstance(node, bool):
                self.assertLess(node, 50000, f"{path} = {node} is the size of a payment")

        c = Client()
        c.force_login(self.head)
        walk(c.get("/api/collaborate/me").json())
        walk(c.get("/api/collaborate/graph").json())

    def test_signing_out_closes_both(self):
        c = Client()
        self.assertEqual(c.get("/api/collaborate/me").status_code, 401)
        self.assertEqual(c.get("/api/collaborate/graph").status_code, 401)


class DiscoveryGroundingTests(TestCase):
    """The model proposes; the database disposes.

    Everything Gemini says about a journal is treated as a guess at a name and
    nothing more. The name is looked up in our own Scimago and SNIP rows, and
    only what resolves carries a quartile or a rupee figure. These tests are
    about the seam between the two, because that seam is the whole safety
    argument: a plausible journal name with a confident payout beside it is how
    somebody submits a paper to a venue that does not exist.
    """

    def setUp(self):
        ScimagoJournal.objects.create(
            source_id="1",
            title="Applied Soft Computing",
            issn="15684946",
            year=2025,
            sjr=1.456,
            categories_json=json.dumps([{"category": "Software", "quartile": "Q1"}]),
        )
        # Same journal, stored the older way -- the Scimago string form rather
        # than JSON. Both shapes are in the live table.
        ScimagoJournal.objects.create(
            source_id="2",
            title="Legacy Format Journal",
            issn="99998888",
            year=2025,
            sjr=0.9,
            categories_json="Artificial Intelligence (Q2); Software (Q3)",
        )
        SnipSource.objects.create(
            title="Applied Soft Computing", print_issn="15684946", snip=1.831, year=2025
        )

    def test_a_real_journal_resolves(self):
        row = discover.find_journal("Applied Soft Computing")
        self.assertIsNotNone(row)
        self.assertEqual(row.title, "Applied Soft Computing")

    def test_a_journal_the_model_invented_resolves_to_nothing(self):
        """The property the whole design rests on."""
        self.assertIsNone(
            discover.find_journal("International Journal of Advanced Quantum Widgetry")
        )

    def test_a_near_miss_is_not_treated_as_a_match(self):
        """Better no answer than real numbers attached to the wrong journal."""
        self.assertIsNone(discover.find_journal("Applied Soft Computing Letters"))

    def test_a_quartile_is_read_from_either_storage_shape(self):
        """Reading one shape with the other's parser does not raise -- it
        returns a single category whose name is the entire raw string and whose
        quartile is None. A Q1 journal then silently reports no quartile, which
        is exactly the quiet wrong answer this module exists to avoid.
        """
        as_json = discover.describe_journal(discover.find_journal("Applied Soft Computing"))
        self.assertEqual(as_json["quartile"], "Q1")

        as_string = discover.describe_journal(discover.find_journal("Legacy Format Journal"))
        self.assertEqual(as_string["quartile"], "Q2")
        self.assertEqual(as_string["subject"], "Artificial Intelligence")

    def test_snip_is_matched_by_issn_and_never_by_title(self):
        row = discover.find_journal("Applied Soft Computing")
        self.assertEqual(discover.find_snip(row), 1.831)

        # A SNIP row whose title matches but whose ISSN does not must not be
        # picked up: the two dumps spell journal names differently often enough
        # that title matching pairs the wrong rows.
        orphan = ScimagoJournal.objects.create(
            source_id="3", title="Applied Soft Computing", issn="00000001", year=2025
        )
        self.assertIsNone(discover.find_snip(orphan))

    def test_no_snip_means_no_amount_and_a_reason(self):
        out = discover.estimate_payout(
            snip=None, quartile="Q1", author_position=1, total_authors=3
        )
        self.assertIsNone(out["amount"])
        self.assertIn("SNIP", out["why_not"])

    def test_no_quartile_means_no_amount_and_a_different_reason(self):
        out = discover.estimate_payout(
            snip=1.8, quartile=None, author_position=1, total_authors=3
        )
        self.assertIsNone(out["amount"])
        self.assertIn("quartile", out["why_not"])

    def test_an_amount_is_the_real_policy_amount(self):
        """Not a rough figure invented for the screen -- the same calculator
        that decides what is actually paid."""
        out = discover.estimate_payout(
            snip=1.831, quartile="Q1", author_position=1, total_authors=3
        )
        expected = calculate_remuneration(
            1.831, "Q1", 3, 1, None, publication_type="Journal", indexing_level="Scopus"
        )
        self.assertEqual(out["amount"], expected.remuneration)
        self.assertIsNotNone(out["amount"])

    def test_position_changes_the_amount(self):
        first = discover.estimate_payout(
            snip=1.831, quartile="Q1", author_position=1, total_authors=4
        )["amount"]
        fourth = discover.estimate_payout(
            snip=1.831, quartile="Q1", author_position=4, total_authors=4
        )["amount"]
        self.assertNotEqual(first, fourth)

    def test_a_draft_is_never_sent_to_the_model(self):
        """An unfinished ticket is a private intention. Feeding one to a model
        to reason about would be reading somebody's notes."""
        user = User.objects.create_user(email="hist@test.edu", password="p", name="H")
        Claim.objects.create(
            owner=user, paper_title="Filed Paper", status=ClaimStatus.PAID,
            journal_title="J", publication_year=2025,
        )
        Claim.objects.create(
            owner=user, paper_title="Secret Draft", status=ClaimStatus.DRAFT,
            journal_title="J", publication_year=2025,
        )
        titles = {h["title"] for h in discover.publication_history(user)}
        self.assertIn("Filed Paper", titles)
        self.assertNotIn("Secret Draft", titles)

    def test_the_domain_vocabulary_comes_from_our_own_data(self):
        from django.core.cache import cache

        cache.delete("research_domains")
        domains = discover.research_domains(limit=302)
        self.assertIn("Software", domains)
        self.assertIn("Artificial Intelligence", domains)


class DiscoveryEndpointTests(TestCase):
    """What the screens get, including when the feature is switched off."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="disc@test.edu", password="p", name="Disc", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.user)

    def test_status_says_whether_it_can_run(self):
        with override_settings(GEMINI_API_KEY=""):
            self.assertFalse(self.client.get("/api/discover/status").json()["available"])
        with override_settings(GEMINI_API_KEY="test-key"):
            self.assertTrue(self.client.get("/api/discover/status").json()["available"])

    def test_no_key_is_a_supported_state_not_a_crash(self):
        """The normal condition on a developer machine, and possibly in
        production. It must say so rather than 500."""
        with override_settings(GEMINI_API_KEY=""):
            r = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "A Paper About Something Or Other"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 503)
            self.assertIn("switched off", r.json()["detail"])

            self.assertEqual(self.client.get("/api/discover/directions").status_code, 503)

    def test_a_title_too_short_to_work_with_is_refused_before_the_model(self):
        with override_settings(GEMINI_API_KEY="test-key"):
            r = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "Hi"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400)

    def test_the_model_failing_is_a_502_not_a_500(self):
        """It is an upstream failing, the request was fine, and retrying is a
        reasonable thing for the reader to do."""
        with override_settings(GEMINI_API_KEY="test-key"), patch(
            "core.services.discover.gemini.ask_json",
            side_effect=gemini.GeminiError("model is down", code="unreachable"),
        ):
            r = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "A Paper About Something Or Other"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 502)

    def test_an_invented_journal_never_arrives_with_an_amount(self):
        """End to end: the model names two journals, only one of which is real.
        The real one carries numbers; the invented one is reported separately
        and carries none.
        """
        ScimagoJournal.objects.create(
            source_id="1", title="Applied Soft Computing", issn="15684946", year=2025,
            sjr=1.4, categories_json=json.dumps([{"category": "Software", "quartile": "Q1"}]),
        )
        SnipSource.objects.create(
            title="Applied Soft Computing", print_issn="15684946", snip=1.831, year=2025
        )

        reply = {
            "journals": [
                {"title": "Applied Soft Computing", "why": "fits the scope"},
                {"title": "Journal of Imaginary Widgetry", "why": "also fits"},
            ]
        }
        with override_settings(GEMINI_API_KEY="test-key"), patch(
            "core.services.discover.gemini.ask_json", return_value=reply
        ):
            body = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "Something About Soft Computing Methods"}),
                content_type="application/json",
            ).json()

        self.assertEqual([j["title"] for j in body["journals"]], ["Applied Soft Computing"])
        self.assertEqual(body["journals"][0]["quartile"], "Q1")
        self.assertIsNotNone(body["journals"][0]["payout"]["amount"])

        self.assertEqual([u["title"] for u in body["unverified"]], ["Journal of Imaginary Widgetry"])
        self.assertNotIn("payout", body["unverified"][0])
        self.assertNotIn("quartile", body["unverified"][0])

    def test_the_assumptions_behind_the_amount_are_returned(self):
        """An estimate whose assumptions are invisible is a number somebody
        will treat as a promise."""
        with override_settings(GEMINI_API_KEY="test-key"), patch(
            "core.services.discover.gemini.ask_json", return_value={"journals": []}
        ):
            body = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "A Paper Title Long Enough", "author_position": 2, "total_authors": 5}),
                content_type="application/json",
            ).json()
        self.assertEqual(body["assumed"]["author_position"], 2)
        self.assertEqual(body["assumed"]["total_authors"], 5)

    def test_nothing_to_go_on_says_so_rather_than_asking_the_model(self):
        with override_settings(GEMINI_API_KEY="test-key"), patch(
            "core.services.discover.gemini.ask_json"
        ) as asked:
            body = self.client.get("/api/discover/directions").json()
            asked.assert_not_called()
        self.assertEqual(body["directions"], [])
        self.assertIn("nothing to go on", body["note"])

    def test_signing_out_closes_all_of_it(self):
        anon = Client()
        self.assertEqual(anon.get("/api/discover/status").status_code, 401)
        self.assertEqual(anon.get("/api/discover/directions").status_code, 401)
        self.assertEqual(anon.get("/api/me/interests").status_code, 401)


class ResearchInterestTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(
            email="int@test.edu", password="p", name="Int", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.user)

    def put(self, domains):
        return self.client.put(
            "/api/me/interests",
            data=json.dumps({"domains": domains}),
            content_type="application/json",
        )

    def test_setting_replaces_rather_than_adds(self):
        self.put(["Software", "Artificial Intelligence"])
        self.put(["Software", "Robotics"])
        self.assertEqual(
            set(self.client.get("/api/me/interests").json()["domains"]),
            {"Software", "Robotics"},
        )

    def test_saying_it_twice_stores_it_once(self):
        """A duplicate would double that domain's weight in every later match."""
        self.put(["Software", "Software", " Software "])
        self.assertEqual(self.client.get("/api/me/interests").json()["domains"], ["Software"])

    def test_one_person_interests_are_their_own(self):
        other = User.objects.create_user(email="other@test.edu", password="p", name="O")
        self.put(["Software"])
        c = Client()
        c.force_login(other)
        self.assertEqual(c.get("/api/me/interests").json()["domains"], [])


class ClaimCountsRouteTests(TestCase):
    """One query for the filter chips, and a route that is actually reachable."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="counts@test.edu", password="p", name="C", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.user)

    def make(self, status, title="P"):
        return Claim.objects.create(
            owner=self.user, paper_title=title, status=status,
            journal_title="J", publication_year=2025, remuneration=1000,
        )

    def test_counts_is_not_shadowed_by_the_claim_id_route(self):
        """django-ninja matches in registration order. Declared after
        `/claims/{claim_id}` this resolves as a claim whose id is the literal
        string "counts" and 404s -- the same collision that once cost us
        `/admin/data/Claim/export`.
        """
        self.assertEqual(self.client.get("/api/claims/counts").status_code, 200)

    def test_a_legacy_erp_status_is_counted_under_its_stage(self):
        """The reason this endpoint exists rather than the screen asking seven
        times: the list endpoint takes one status, but a stage covers several,
        so an imported HOD_APPROVED row was uncountable from the client.
        """
        self.make(ClaimStatus.SUBMITTED)
        self.make("HOD_APPROVED")
        self.make(ClaimStatus.CLEARED)
        self.make("RESEARCH_APPROVED")

        counts = self.client.get("/api/claims/counts").json()["counts"]
        self.assertEqual(counts["filed"], 2)
        self.assertEqual(counts["checked"], 2)
        self.assertEqual(counts["all"], 4)

    def test_the_search_term_narrows_the_counts(self):
        """Otherwise the chips claim rows the filtered list will not show."""
        self.make(ClaimStatus.PAID, title="Fault Detection In Motors")
        self.make(ClaimStatus.PAID, title="Something Else Entirely")

        counts = self.client.get("/api/claims/counts?q=Fault").json()["counts"]
        self.assertEqual(counts["all"], 1)
        self.assertEqual(counts["paid"], 1)

    def test_a_claimant_counts_only_their_own(self):
        other = User.objects.create_user(email="them@test.edu", password="p", name="T")
        Claim.objects.create(
            owner=other, paper_title="Theirs", status=ClaimStatus.PAID,
            journal_title="J", publication_year=2025,
        )
        self.make(ClaimStatus.PAID)
        self.assertEqual(self.client.get("/api/claims/counts").json()["counts"]["all"], 1)


class HodReachabilityTests(TestCase):
    """Which door a head of department goes through.

    The sidebar offers a head "Publications" and "Reports", and both of the
    obvious endpoints behind those words refuse them: `can_view_reports` is
    SUPER_ADMIN, RESEARCH_CELL, PRINCIPAL and FINANCE, and a head is none of
    those. They have their own pair instead, scoped to their department and
    carrying no money.

    This is written down as a test because the screens for those two items do
    not exist yet, and the next person to build them will reach for the
    general endpoint by name. Doing so gives every head a menu item that 403s
    -- which looks like a permissions bug in the account rather than a wrong
    URL in the client, and is therefore diagnosed slowly.
    """

    def setUp(self):
        self.head = User.objects.create_user(
            email="head-reach@test.edu", password="p", name="Head",
            role=Role.HOD, department="CSE",
        )
        self.client = Client()
        self.client.force_login(self.head)

    def test_the_general_reporting_endpoints_are_closed_to_a_head(self):
        self.assertEqual(self.client.get("/api/reports").status_code, 403)
        self.assertEqual(self.client.get("/api/reports/search?limit=1").status_code, 403)

    def test_the_head_scoped_pair_is_what_they_use_instead(self):
        self.assertEqual(self.client.get("/api/hod/overview").status_code, 200)
        self.assertEqual(self.client.get("/api/hod/publications").status_code, 200)

    def test_a_head_may_still_read_journals_and_the_collaboration_graph(self):
        """Both are legitimately theirs, and neither carries money."""
        for path in ("/api/journals/top", "/api/collaborate/me", "/api/collaborate/graph"):
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_a_head_cannot_open_one_persons_record(self):
        """`/faculty/{id}/report` is a money screen. A head is refused the
        whole endpoint rather than served a filtered copy of it -- so the
        People screens are not for them, and must not be offered."""
        other = User.objects.create_user(
            email="someone@test.edu", password="p", name="S", department="CSE"
        )
        self.assertEqual(
            self.client.get(f"/api/faculty/{other.id}/report").status_code, 403
        )
        self.assertEqual(self.client.get("/api/admin/users").status_code, 403)
