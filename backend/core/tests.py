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
from core.services.remuneration import (
    MAX_ELIGIBLE_AUTHORS,
    MIN_SEC_REFERENCES,
)
from core.services.verify import check_already_paid
from core.models import Budget, CalendarEvent, DepartmentTarget, DuplicateFinding, JournalStanding, ScimagoJournal
from core.models import ClaimReason, Mention, Post, Team, TeamMember, Thread, ThreadSubscription
from core.models import SnipSource
from core.services import ai, discover


class patch_api:
    """Patch a name everywhere the API package looks it up.

    core/api.py became a package of modules that each import their service
    functions directly, so patching `core.api.<name>` no longer intercepts
    anything. This patches the name in every `core.api.*` module that holds
    it, with one shared mock, and behaves like `patch` (context manager or
    start/stop) so call sites keep their assertions.
    """

    def __init__(self, name, **kwargs):
        import importlib, pkgutil
        from unittest.mock import MagicMock
        import core.api as pkg
        self.mock = MagicMock(**kwargs)
        self._patches = []
        for info in pkgutil.iter_modules(pkg.__path__):
            mod = importlib.import_module(f"core.api.{info.name}")
            if hasattr(mod, name):
                self._patches.append(patch.object(mod, name, self.mock))
        if not self._patches:
            raise AttributeError(f"no core.api module uses {name}")

    def start(self):
        for p in self._patches:
            p.start()
        return self.mock

    def stop(self):
        for p in reversed(self._patches):
            p.stop()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
        return False


def _model_ready():
    """Pretend the local model service is up with the model installed.

    Stubbed rather than probed: availability is now a loopback round trip to
    Ollama, and a test suite that fails when a daemon is not running is a
    suite nobody can trust on a fresh machine.
    """
    return patch.object(
        ai,
        "health",
        return_value={
            "provider": "ollama", "ready": True, "code": "ready", "detail": None,
            "model": "gemma4:12b", "base_url": "http://127.0.0.1:11434",
            # The fast tier is a separate readiness with its own remedy: a
            # machine can hold gemma4:12b and not gemma3:4b, in which case the
            # venue search works and the thread assistant does not. A fixture
            # that omits these describes an impossible system -- a service
            # that is ready and has no interactive model at all.
            "fast_ready": True, "fast_code": "ready", "fast_detail": None,
            "fast_model": "gemma3:4b",
        },
    )


def _model_unavailable(code="service_down", detail="No local model service is answering."):
    return patch.object(
        ai,
        "health",
        return_value={
            "provider": "ollama", "ready": False, "code": code, "detail": detail,
            "model": "gemma4:12b", "base_url": "http://127.0.0.1:11434",
            # Down is down for both tiers unless a test says otherwise; the
            # daemon being unreachable does not spare the small model.
            "fast_ready": False, "fast_code": code, "fast_detail": detail,
            "fast_model": "gemma3:4b",
        },
    )
from core.services import research_search as rs
from core.services.normalize import normalize_issn
from django.core.cache import cache
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


def _sec_reference_attachments(*numbers, seed="e"):
    """The evidence an incentive claim is actually paid on.

    `_check_mandatory_fields` refuses an incentive claim that does not attach
    the cited paper for each SEC-affiliated reference and record the number it
    carries in the paper's reference list — the same thing `_apply_calc`
    counts when it works out the money. A typed `sec_refs` string no longer
    stands in for it.

    Tests below that are about something else entirely and merely need a claim
    to *reach* submission use this, so they go on testing what they were
    written for rather than tripping over the reference rule.
    """
    numbers = numbers or tuple(str(10 + i) for i in range(MIN_SEC_REFERENCES))
    return [
        {
            "kind": "SEC_REFERENCE",
            # A distinct 32-hex media name per reference. `_validated_attachments`
            # drops a repeated URL, so re-using one would quietly file a single
            # reference and the claim would then be refused for the right reason
            # at the wrong moment.
            "url": f"/media/claims/{f'{seed}{i:x}'.ljust(32, seed)[:32]}.pdf",
            "filename": f"ref-{n}.pdf",
            "size_bytes": 10,
            "ref_number": str(n),
        }
        for i, n in enumerate(numbers)
    ]


def _published_paper_attachment(url="/media/claims/f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0.pdf"):
    return {
        "kind": "PUBLISHED_PAPER",
        "url": url,
        "filename": "paper.pdf",
        "size_bytes": 20,
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
        self.director = User.objects.create_user(
            email="dir@test.edu",
            password="pass",
            name="Dir",
            role=Role.DIRECTOR,
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
        verify_patch = patch_api("verify_publication", side_effect=_echo_verified)
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

        # Approved is not authorised: the director signs before finance can
        # move anything, and finance is told only once it actually can.
        self._login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"note": "paid", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Director", r.json()["detail"])

        self._login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            data=json.dumps({"note": "authorised", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)
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
        claim.status = ClaimStatus.FINANCE_APPROVED
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
        self.assertEqual(claim.status, ClaimStatus.FINANCE_APPROVED)

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

        # A head's claim list is their own papers (a head files like any
        # faculty member), and neither it nor their department screens carry
        # somebody else's draft: an unfinished ticket is not output.
        self._login(self.hod)
        r = self.client.get("/api/claims")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("Half-written idea", [c["paper_title"] for c in r.json()["results"]])
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
        never reach is anybody else's remuneration -- and the claim list carries
        one on every row. A head is also a claimant now (2026-09-23), so the
        list answers them, with their own papers only."""
        other = User.objects.create_user(
            email="o@test.edu",
            password="pass",
            name="Other",
            role=Role.FACULTY,
            department="CSE",  # same department the old HoD used to oversee
        )
        theirs = Claim.objects.create(
            owner=other,
            paper_title="CSE Paper",
            status=ClaimStatus.SUBMITTED,
            ticket_number="FP-2026-000002",
            quartile="Q2",
            remuneration=64321.5,
        )
        self._login(self.hod)
        r = self.client.get("/api/claims")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["results"], [], "a colleague's claim is not on a head's list")
        self.assertNotIn("64321.5", r.content.decode())
        r = self.client.get(f"/api/claims/{theirs.id}")
        self.assertEqual(r.status_code, 403, "nor can it be opened by id")
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
            status=ClaimStatus.DIRECTOR_APPROVED,
            principal_approved_at=timezone.now(),
            director_approved_at=timezone.now(),
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

    def _submittable_payload(self, **overrides):
        """A payload that can actually be filed as an incentive claim.

        The policy is paid on evidenced SEC references — the cited paper
        attached, carrying the number it has in the reference list — and
        submission is refused without them. A test about indexing levels or
        annexure numbers has to carry them or it never reaches the rule it was
        written to check.
        """
        return self._complete_payload(
            attachments=[_published_paper_attachment(), *_sec_reference_attachments()],
            **overrides,
        )

    def _post_claim(self, payload):
        return self.client.post(
            "/api/claims", data=json.dumps(payload), content_type="application/json"
        )

    def test_submit_requires_mandatory_form_fields(self):
        self._login(self.faculty)
        r = self._post_claim(self._complete_payload(yukthi_id="", journal_title=""))
        self.assertEqual(r.status_code, 400, r.content)
        detail = r.json().get("detail", "")
        self.assertIn("Yukthi ID", detail)
        self.assertIn("Journal name", detail)

    def test_the_missing_list_names_no_field_the_form_does_not_have(self):
        """`sec_refs` used to be in it, and it is not a box anybody can fill.

        The wizard derives that column from the number entered against each
        attached reference, so a first-time claimant -- who by definition has
        never entered one -- was refused by the name of a field that is not on
        their screen, and told nothing about the files or the numbers. The
        reference rule says all of that; the missing list stands aside for it.
        """
        self._login(self.faculty)
        r = self._post_claim(
            self._complete_payload(
                sec_refs="",
                attachments=[
                    _published_paper_attachment(
                        "/media/claims/c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0.pdf"
                    ),
                    # Attached, and neither carries its number -- the mistake
                    # as it is actually made the first time.
                    {"kind": "SEC_REFERENCE", "size_bytes": 10, "filename": "r1.pdf",
                     "url": "/media/claims/c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1.pdf"},
                    {"kind": "SEC_REFERENCE", "size_bytes": 10, "filename": "r2.pdf",
                     "url": "/media/claims/c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2.pdf"},
                ],
            )
        )
        self.assertEqual(r.status_code, 400, r.content)
        detail = r.json().get("detail", "")
        self.assertNotIn(
            "Complete these before submitting", detail,
            "the generic list answered a claimant it has no field to name",
        )
        self.assertIn(f"0 of {MIN_SEC_REFERENCES}", detail)
        self.assertIn("attach the cited paper", detail)
        self.assertIn("number it has in your reference list", detail)
        self.assertIn("Rs 0", detail)
        self.assertIn("publication count", detail)

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
        """No legacy proof_url — the attachments array must be enough to submit.

        Enough, but only once each reference carries the number it has in the
        paper's reference list. The gate used to accept a bare SEC_REFERENCE
        file while the calculator counted only numbered ones, so a claim like
        the first one below was ticketed, sent to Finance and worked out as
        Rs 0. It is refused at the form now instead, where it can be fixed.
        """
        self._login(self.faculty)
        paper = _published_paper_attachment(
            "/media/claims/a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4.pdf"
        )
        unnumbered = self._post_claim(
            self._complete_payload(
                proof_url="",
                sec_proof_url="",
                attachments=[
                    paper,
                    {"kind": "SEC_REFERENCE", "url": "/media/claims/a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5.pdf",
                     "filename": "r.pdf", "size_bytes": 10},
                ],
            )
        )
        self.assertEqual(unnumbered.status_code, 400, unnumbered.content)
        detail = unnumbered.json()["detail"]
        self.assertIn("number it has in your reference list", detail)
        self.assertIn("Rs 0", detail)
        self.assertFalse(
            Claim.objects.filter(status=ClaimStatus.SUBMITTED).exists(),
            "an unnumbered claim must not reach the clearing queue",
        )

        r = self._post_claim(
            self._complete_payload(
                proof_url="",
                sec_proof_url="",
                attachments=[paper, *_sec_reference_attachments("14", "15", seed="a")],
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
            self._submittable_payload(indexing_level="Scopus, UGC Care", submit=True)
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("UGC Care", r.json()["detail"])

        r2 = self._post_claim(
            self._submittable_payload(
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
            self._submittable_payload(
                indexing_level="AU Annexure, UGC Care",
                au_annexure_ref="AU-77",
                submit=True,
            )
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("UGC Care", r.json()["detail"])

        r2 = self._post_claim(
            self._submittable_payload(
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
            # This test is about the SNIP the claimant typed, not about
            # references — the references are attached and numbered so the
            # claim reaches submission and the SNIP question can be asked.
            "attachments": [
                _published_paper_attachment(
                    "/media/claims/b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0.pdf"
                ),
                *_sec_reference_attachments("14", "15", seed="b"),
            ],
            "snip": 30.0,
            "quartile": "Q1",
            "total_authors": 1,
            "author_position": 1,
            "affiliation_ok": True,
            "submit": True,
            "contest_forward": True,
            "contest_note": "Submitting with faculty-provided journal details.",
        }
        with patch_api("verify_publication", return_value=dict(_VERIFY_MISS)):
            r = self.client.post(
                "/api/claims", data=json.dumps(payload), content_type="application/json"
            )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["status"], "SUBMITTED")
        self.assertIsNone(body["snip"], "self-declared SNIP must not become the verified value")
        self.assertEqual(body["self_reported_snip"], 30.0)

        # This used to assert a flat zero, and the zero was not the trust
        # boundary holding: the claim carried no numbered SEC references, so
        # the calculator zeroed it before the SNIP question was ever reached.
        # Now that the references are attached the ticket is priced for real,
        # and the figure is the one a paper with no *verified* SNIP earns --
        # not a rupee of it derived from the 30.0 the claimant typed.
        from core.services.remuneration import formula_from_model

        cfg = formula_from_model(FormulaConfig.objects.filter(active=True).first())
        believed = calculate_remuneration(
            30.0, "Q1", 1, 1, cfg, publication_type="Journal",
            indexing_level="Scopus", sec_reference_count=MIN_SEC_REFERENCES,
        ).remuneration
        unverified = calculate_remuneration(
            None, None, 1, 1, cfg, publication_type="Journal",
            indexing_level="Scopus", sec_reference_count=MIN_SEC_REFERENCES,
        ).remuneration
        self.assertGreater(believed, 1_000_000, "the hole this test guards")
        self.assertEqual(
            body["remuneration"], unverified,
            "priced from the verified columns, which hold no SNIP at all",
        )

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
        self.director = User.objects.create_user(
            email="life-dir@test.edu", password="pass", name="Life Director",
            role=Role.DIRECTOR,
        )
        self.client = Client()
        verify_patch = patch_api("verify_publication", side_effect=_echo_verified)
        verify_patch.start()
        self.addCleanup(verify_patch.stop)

    def _claim(self, *, status, remuneration, ticket, **kw):
        """A claim whose amount recomputes to exactly `remuneration`.

        snip = (remuneration/point − QFA)/55000 is fiddly; instead build from a
        chosen snip: remuneration = snip × 55000 + qf(quartile).
        """
        # A ticket only counts as approved or authorised if it happened here:
        # an imported ERP row carries the status with no signature behind it,
        # and finance must not pay one of those.
        if status == ClaimStatus.DIRECTOR_APPROVED:
            kw.setdefault("principal_approved_at", timezone.now())
        if status == ClaimStatus.DIRECTOR_APPROVED:
            kw.setdefault("principal_approved_at", timezone.now())
            kw.setdefault("director_approved_at", timezone.now())
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
        claim = self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="LC-2")
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
        with patch_api("verify_publication", return_value=_verify_hit(snip=2.0, quartile="Q1")):
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
        with patch_api("verify_publication", return_value=_verify_hit(snip=2.0, quartile="Q1")):
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
        claim = self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0,
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
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)

    def test_clear_scopus_down_leaves_an_unverified_claim_untouched(self):
        claim = self._claim(status=ClaimStatus.SUBMITTED, remuneration=85000.0, ticket="LC-502")
        Claim.objects.filter(pk=claim.pk).update(snip_source=None, quartile_source=None)
        self.client.force_login(self.admin)
        with patch_api("verify_publication", return_value={"ok": False}):
            r = self.client.post(
                f"/api/claims/{claim.id}/clear",
                data=json.dumps({"expected_amount": 85000.0}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 502, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertEqual(claim.remuneration, 85000.0)

    def test_clear_scopus_down_uses_stored_verified_values(self):
        """An outage (or no Scopus key) must not stop the office when the
        claim already carries server-verified values; it is recomputed from
        them, still guarded by the confirmed amount, and audited."""
        claim = self._claim(status=ClaimStatus.SUBMITTED, remuneration=85000.0, ticket="LC-503")
        Claim.objects.filter(pk=claim.pk).update(snip_source="SCOPUS", quartile_source="SCIMAGO")
        claim.refresh_from_db()
        self.client.force_login(self.admin)
        with patch_api("verify_publication", return_value={"ok": False}):
            r = self.client.post(
                f"/api/claims/{claim.id}/clear",
                data=json.dumps({"expected_amount": float(claim.remuneration)}),
                content_type="application/json",
            )
        claim.refresh_from_db()
        self.assertIn(r.status_code, (200, 409), r.content)
        self.assertTrue(AuditLog.objects.filter(
            action="CLAIM_RECALC_STORED_VALUES", entity_id=claim.id).exists())

    def test_mark_paid_does_not_depend_on_scopus(self):
        """Payment recomputes from stored verified values, so an outage cannot
        stop Finance paying a claim that clearing already verified.

        This used to answer 502. `skip_external` is super-admin only, so a
        Finance user had no way through — while bulk mark-paid, which has never
        called out, paid the very same claim. A guard that bulk skips is not a
        guard, and clearing is where external re-verification belongs.
        """
        claim = self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="LC-P502")
        self.client.force_login(self.finance)
        with patch_api("verify_publication", return_value={"ok": False}) as called:
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
            status=ClaimStatus.DIRECTOR_APPROVED, remuneration=160000.0, ticket=ticket,
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
        # A super admin's power: Finance only pays (core/test_chain_rules.py).
        self.client.force_login(self.admin)
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
        self.client.force_login(self.admin)
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
        self.client.force_login(self.admin)
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
        self.client.force_login(self.admin)
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
        self.client.force_login(self.finance)
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

        # A void drops the ticket to CLEARED, so it climbs the whole chain
        # again. Both signatures, not just the principal's -- a payment that
        # was wrong once is not waved through the second time.
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V101", "expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, "still needs the director")

        self.client.force_login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
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
        a = self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="LC-BP1")
        b = self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="LC-BP2")
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
        good = self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="LC-BP3")
        drifted = self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="LC-BP4")
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
        self.assertEqual(drifted.status, ClaimStatus.DIRECTOR_APPROVED, "a skipped row is untouched")
        high.refresh_from_db()
        self.assertEqual(high.status, ClaimStatus.DIRECTOR_APPROVED)

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

    def test_an_edit_cannot_move_a_claim_through_the_chain(self):
        """Status and approval columns move only through their own actions;
        an edit that set PAID would skip the Director and write no ledger."""
        unpaid = Claim.objects.create(
            owner=self.alice, status=ClaimStatus.SUBMITTED, ticket_number="PWR-2",
            paper_title="Unpaid", remuneration=1000,
        )
        self.client.force_login(self.admin)
        for fields in ({"status": "PAID"}, {"director_approved_at": "2026-01-01T00:00:00Z"},
                       {"override_duplicate": True}, {"snip": 9.9}):
            r = self.post(f"/api/admin/claims/{unpaid.id}/edit",
                          {"fields": fields, "reason": "Trying to skip the chain"})
            self.assertEqual(r.status_code, 400, (fields, r.content))
        unpaid.refresh_from_db()
        self.assertEqual(unpaid.status, ClaimStatus.SUBMITTED)

    def test_an_unpaid_amount_cannot_be_set_by_hand(self):
        unpaid = Claim.objects.create(
            owner=self.alice, status=ClaimStatus.CLEARED, ticket_number="PWR-3",
            paper_title="Unpaid", remuneration=1000,
        )
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/claims/{unpaid.id}/edit",
                      {"fields": {"remuneration": 99999}, "reason": "Setting the amount by hand"})
        self.assertEqual(r.status_code, 400, r.content)

    def test_an_edit_rejects_a_value_of_the_wrong_type(self):
        self.client.force_login(self.admin)
        r = self.post(f"/api/admin/claims/{self.claim.id}/edit",
                      {"fields": {"publication_year": "not a year"},
                       "reason": "Year was wrong in the import"})
        self.assertEqual(r.status_code, 400, r.content)

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
        with patch_api("start_batch_async") as started:
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
        # The role used to be the example here. It is requestable now -- to a
        # super admin only, see AccountChangeRequestTests -- so these are the
        # fields that are still not a request's business at all.
        self.client.force_login(self.faculty)
        for field, proposed in (
            ("is_staff", "true"), ("active", "true"), ("email", "x@test.edu"),
            ("google_sub", "123"), ("password", "hunter22"),
        ):
            r = self.client.post(
                "/api/auth/profile/correction",
                data=json.dumps({"field": field, "proposed": proposed}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400, (field, r.content))
        self.assertFalse(ProfileChangeRequest.objects.exists())

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
            # These tests are about a retracted title. The references are
            # attached and numbered so the claim gets far enough for the
            # retraction check to be the thing that stops it.
            "attachments": [
                _published_paper_attachment(
                    "/media/claims/b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0.pdf"
                ),
                *_sec_reference_attachments("14", "15", seed="b"),
            ],
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

        verify_patch = patch_api("verify_publication", side_effect=_no_scopus_but_real_duplicate_check
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
            # These tests are about the payment-history warning and who may
            # wave it away. The references are attached and numbered so the
            # duplicate check is what the claim is stopped by.
            "attachments": [
                _published_paper_attachment(
                    "/media/claims/d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0.pdf"
                ),
                *_sec_reference_attachments("14", "15", seed="d"),
            ],
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

        # A fourth pair of eyes: the director authorises what the principal
        # approved, and only then is there anything for finance to pay.
        director = User.objects.create_user(
            email="dup-dir@test.edu", password="pass", name="Dup Director",
            role=Role.DIRECTOR,
        )
        self.client.force_login(director)
        r = self.client.post(
            f"/api/claims/{claim_id}/director-approve",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

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



class FiveStepChainTests(TestCase):
    """Nothing reaches finance without the principal AND the director.

    The chain once ran research cell → finance, so the person accountable for
    the spend could read every figure and authorise none of them. It then ran
    through the principal, and now through the director after them: approving
    the spend and authorising it against the institution's position are two
    decisions, and they are taken by two people.
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
        self.director = User.objects.create_user(
            email="chain-dir@test.edu", password="pass", name="Chain Director",
            role=Role.DIRECTOR,
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
        with patch_api("verify_publication", side_effect=_echo_verified):
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

    def test_approving_tells_the_director_and_not_finance(self):
        """Approval used to tell Finance the ticket was "approved for payment".

        It is not payable at that point -- the director has not authorised it
        -- so the desk that had to act next was never told and the desk that
        was told could do nothing. Exactly the fault the principal step was
        added to fix, one link further down.
        """
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
        self.assertIn(Role.DIRECTOR, told, "the director must hear about it")
        self.assertNotIn(
            Role.FINANCE, told, "finance cannot act on a merely approved ticket"
        )

    def test_authorising_is_what_tells_finance(self):
        claim = self._cleared("CH-N3")
        self.client.force_login(self.head)
        self.client.post(
            f"/api/claims/{claim.id}/principal-approve",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        Notification.objects.all().delete()
        self.client.force_login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        told = set(
            Notification.objects.filter(claim_id=claim.id)
            .values_list("user__role", flat=True)
        )
        self.assertIn(Role.FINANCE, told)

    def test_the_claimant_is_told_the_stage_and_never_the_desk(self):
        """It once said "with Finance" where Finance could not pay, and then
        named every desk correctly. The college has since decided a claimant is
        not told whose desk their paper is on at all (core/test_chain_rules.py)."""
        for status, stage in (
            (ClaimStatus.CLEARED, "Under review"),
            (ClaimStatus.PRINCIPAL_APPROVED, "Under review"),
            (ClaimStatus.DIRECTOR_APPROVED, "Approved for payment"),
            (ClaimStatus.PAID, "Paid"),
        ):
            title, body = api_module._faculty_status_copy(status)
            self.assertEqual(title, stage, status)
            for desk in ("Principal", "Director", "Finance", "research cell"):
                self.assertNotIn(desk, title + body, status)

    def test_approved_is_still_not_payable_until_the_director_authorises(self):
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

        # The step this test exists for: approved is not payable.
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Director", r.json()["detail"])

        self.client.force_login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)

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
        # A status from the retired chain, which the import writes freely.
        Claim.objects.filter(pk=claim.pk).update(
            status=ClaimStatus.FINANCE_APPROVED, principal_approved_at=None
        )
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("retired approval status", r.json()["detail"])

        # And the live authorisation status is no different if nobody signed
        # it: the gate reads director_approved_at, not the word in the column.
        Claim.objects.filter(pk=claim.pk).update(
            status=ClaimStatus.DIRECTOR_APPROVED, director_approved_at=None
        )
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 105000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

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


class YearFallbackVisibilityTests(TestCase):
    """Which year the figures came from, said out loud on the claim.

    `lookup_scimago` falls back to the newest table it holds when the paper's
    own year is not in the dump, and records the year it used. That number
    reached the claim payload as a bare integer and nothing anywhere said it
    was a fallback, so a 2019 paper priced off the 2025 ranking read exactly
    like a 2019 one. The quartile is a term in the payout, and the dumps only
    reach back to 2024, so this is most older papers rather than an edge.

    `lookup_snip_dump` is the worse half: it takes no year at all, so there is
    not even a year recorded to compare. The claim says that much rather than
    guessing which year the figure belongs to.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )
        self.faculty = User.objects.create_user(
            email="yearfall@test.edu", password="pass", name="Year Faculty",
            role=Role.FACULTY, department="CSE",
        )

    def _claim(self, **extra):
        base = dict(
            owner=self.faculty, paper_title="An Older Paper", journal_title="J",
            issn="9999-0000", status=ClaimStatus.SUBMITTED, publication_year=2019,
            indexing_level="Scopus", publication_type="Journal",
            total_authors=1, author_position=1,
        )
        base.update(extra)
        return Claim.objects.create(**base)

    def test_a_quartile_taken_from_another_year_says_so_on_the_claim(self):
        """End to end from the dump the lookup actually falls back to."""
        from core.api import _apply_calc, claim_to_dict
        from core.services.scimago import lookup_scimago
        from core.services.verify import apply_verify_to_claim

        ScimagoJournal.objects.create(
            source_id="yf1", title="Journal Of Late Dumps", issn="99990000",
            year=2025, categories_json=json.dumps(
                [{"category": "Engineering", "quartile": "Q1"}]
            ),
        )
        found = lookup_scimago(issn="9999-0000", year=2019)
        self.assertFalse(found["year_exact"], "the fallback this test is about")

        claim = self._claim(snip=1.2, snip_source="SCOPUS", snip_year=2019)
        apply_verify_to_claim(
            claim,
            {
                "scopus": {"indexed": True, "linked": True},
                "scimago": {
                    "found": True, "quartile": found["matched_quartile"],
                    "sjr": found["sjr"], "categories": found["categories"],
                    "year": found["year"],
                },
                "snip": 1.2, "snip_source": "SCOPUS",
            },
        )
        _apply_calc(claim)
        claim.save()

        note = claim_to_dict(claim)["quartile_year_note"]
        self.assertIsNotNone(note, "the fallback must not be silent")
        self.assertIn("2025", note)
        self.assertIn("2019", note)
        # And on the line the ticket, the clearing queue and the approval
        # screen already display -- a field nothing renders is not visibility.
        self.assertIn(note, claim.remuneration_note or "")

    def test_the_paper_s_own_year_raises_nothing(self):
        """Said only when it is news. A note on every claim is a note nobody
        reads, and the ones that matter would go with it."""
        from core.api import claim_to_dict

        claim = self._claim(
            publication_year=2025, quartile="Q1", quartile_source="SCIMAGO",
            scimago_verified=True, scimago_dataset_year=2025,
        )
        self.assertIsNone(claim_to_dict(claim)["quartile_year_note"])

    def test_a_hand_entered_quartile_raises_nothing(self):
        """Nothing fell back: an admin signed for the value, and the dataset
        year left on the row is from whatever the lookup found before."""
        from core.api import claim_to_dict

        claim = self._claim(
            quartile="Q1", quartile_source="MANUAL", scimago_dataset_year=2025,
        )
        self.assertIsNone(claim_to_dict(claim)["quartile_year_note"])

    def test_the_snip_dump_is_not_year_matched_and_the_claim_says_so(self):
        """`lookup_snip_dump(issn, title)` has no year parameter at all -- it
        returns whichever row carries the ISSN. So unlike the quartile there is
        nothing recorded to compare against, and the honest thing to say is
        that the figure is unyeared, not a guess at which year it is."""
        import inspect
        from core.api import _apply_calc, claim_to_dict
        from core.services.verify import lookup_snip_dump

        self.assertNotIn(
            "year", inspect.signature(lookup_snip_dump).parameters,
            "if this gains a year, record it and the note below can go",
        )
        SnipSource.objects.create(
            title="Journal Of Late Dumps", print_issn="9999-0000", snip=1.4, year=2025,
        )
        self.assertEqual(lookup_snip_dump("9999-0000"), 1.4)

        claim = self._claim(
            snip=1.4, snip_source="SNIP_DUMP",
            quartile="Q1", quartile_source="MANUAL",
        )
        _apply_calc(claim)
        note = claim_to_dict(claim)["snip_year_note"]
        self.assertIsNotNone(note)
        self.assertIn("not matched to the year of publication", note)
        self.assertIn("2019", note)
        self.assertIn(note, claim.remuneration_note or "")

    def test_recording_the_dump_s_year_would_silence_the_note(self):
        """The real fix belongs in `lookup_snip_dump`: return the year of the
        row it matched so it can be stored. The day that lands, a claim
        carrying a year stops being told its SNIP is unyeared -- without this
        file or the serialiser changing again."""
        from core.api import claim_to_dict

        claim = self._claim(snip=1.4, snip_source="SNIP_DUMP", snip_year=2019)
        self.assertIsNone(claim_to_dict(claim)["snip_year_note"])


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
        # MECH, not CSE: CSE already has its head (`users["HOD"]`), and a
        # department has one.
        r = client.patch(
            f"/api/admin/users/{self.target.id}",
            data=json.dumps({"role": "HOD", "department": "MECH"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.target.refresh_from_db()
        self.assertEqual(self.target.role, Role.HOD)

    def test_a_head_holds_no_capability_that_touches_anybody_else_s_money(self):
        """The whole point of the role. Every door it can open is one of its
        own department screens -- which carry no money -- or a door every
        claimant has, which answers with their own papers only (a head files
        their own since 2026-09-23)."""
        from core.permission_matrix import CAPABILITIES, FACULTY, HOD

        for capability in CAPABILITIES:
            if HOD in capability.allowed:
                department_screen = capability.path.startswith("/api/hod/")
                claimant_door = (
                    FACULTY in capability.allowed and capability.path.startswith("/api/claims")
                )
                self.assertTrue(
                    department_screen or claimant_door,
                    f"a head may reach {capability.path}, which is neither a department "
                    "screen nor a door every claimant has",
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
            f"/api/claims/{self.paid.id}",
            "/api/admin/duplicate-findings",
        ):
            r = self.client.get(path)
            self.assertIn(r.status_code, (403, 404), f"{path}: {r.status_code}")

        # The claim list answers a head now -- they file their own papers --
        # with their own papers only. This head has none; the colleague's paid
        # claim is not among them.
        r = self.client.get("/api/claims?limit=50")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["results"], [])
        self.assertNotIn("90000", r.content.decode())

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
        # The head is one of the department's faculty (2026-09-23): they file
        # their own papers, which the totals count, so they are counted too.
        self.assertEqual(totals["faculty_in_department"], 2)
        names = {p["name"] for p in body["people"]}
        self.assertIn("CSE Person", names)
        self.assertIn("Head of CSE", names)
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
        with patch_api("search_candidates", side_effect=fake):
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
        with patch_api("search_candidates",
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

        with patch_api("search_candidates", side_effect=fake):
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
        with patch_api("search_candidates",
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
        with patch_api("search_candidates",
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
        with patch_api("search_candidates",
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
        body = self._calc(snip=1.5, quartile="Q1", total_authors=1, author_position=1,
                          engineering_class="Engineering")
        self.assertGreater(body["remuneration"], 0)
        self.assertIsNone(body["note"])

    def test_an_unclassified_journal_is_not_given_the_quartile_incentive(self):
        """The college's rule: QFA only for a journal classified Engineering;
        one whose subject area is not known yet is paid without it, and says why."""
        classified = self._calc(snip=1.5, quartile="Q1", total_authors=1, author_position=1,
                                engineering_class="Engineering")
        pending = self._calc(snip=1.5, quartile="Q1", total_authors=1, author_position=1)
        self.assertAlmostEqual(classified["remuneration"] - pending["remuneration"], 50000, places=2)
        self.assertIn("not classified", pending["note"])


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
        with patch_api("verify_publication", side_effect=_echo_verified):
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

        # ...and the director authorises it, which is what finance pays against.
        director = User.objects.create_user(
            email="uc-dir@test.edu", password="pass", name="UC Director",
            role=Role.DIRECTOR,
        )
        c.force_login(director)
        r = c.post(
            f"/api/claims/{claim.id}/director-approve",
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
            owner=self.user, status=ClaimStatus.DIRECTOR_APPROVED,
            principal_approved_at=timezone.now(),
            director_approved_at=timezone.now(), ticket_number="UC-PAY-2",
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
        with patch_api("verify_publication", side_effect=AssertionError(
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

    def test_more_than_one_lost_zero_is_recovered(self):
        """0010-0161 read as a number is six characters, not seven."""
        self.assertEqual(normalize_issn("100161"), "0010-0161")
        self.assertEqual(normalize_issn("12505"), "0001-2505")
        # Padding is only accepted when the check digit agrees, so a value
        # that no number of zeros makes valid is left alone rather than
        # turned into some other journal's identifier.
        self.assertEqual(normalize_issn("100459"), "100459")

    def test_padding_never_invents_an_issn_out_of_nothing(self):
        """All zeros satisfy the checksum trivially, which is the trap.

        Every one of these strips to nothing or nearly nothing, pads to
        "00000000", and passes a mod-11 check over seven zeros. Accepting that
        would hand back 0000-0000 -- a well-formed ISSN, indistinguishable
        downstream from a real one -- for input that carried no ISSN at all.
        """
        for junk in ("not an issn", "", "-", "0", "00", "0000", "000000", "x"):
            self.assertNotEqual(normalize_issn(junk), "0000-0000", junk)


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

    def test_deleting_an_account_cannot_take_its_paid_papers_with_it(self):
        """The guard has to judge the cascade, not the row that was named.

        `Claim.owner` cascades. Refusing to delete a paid claim while allowing
        the account that owns it to be deleted refuses nothing at all -- it
        just makes the deletion take a route the check does not watch. On the
        live database the worst case was 113 paid publications and ₹398,204 of
        settled payments, removed by one call whose audit entry said a user
        had been deleted.
        """
        res = self.delete("User", self.faculty.id)
        self.assertEqual(res.status_code, 400)
        detail = res.json()["detail"].lower()
        self.assertIn("paid", detail)
        # Says how many, so the refusal is actionable rather than mysterious.
        self.assertIn("1 publication", detail)
        self.assertTrue(User.objects.filter(pk=self.faculty.pk).exists())
        self.assertTrue(Claim.objects.filter(pk=self.paid.pk).exists())

    def test_an_account_with_nothing_paid_still_deletes(self):
        """The guard protects the payment record, not accounts in general."""
        spare = User.objects.create_user(
            email="del-spare@test.edu", password="pass", name="Spare",
            role=Role.FACULTY, department="ECE",
        )
        Claim.objects.create(
            owner=spare, paper_title="Never filed", journal_title="J",
            status=ClaimStatus.DRAFT, publication_year=2025,
        )
        res = self.delete("User", spare.id)
        self.assertEqual(res.status_code, 200, res.content[:200])
        self.assertFalse(User.objects.filter(pk=spare.pk).exists())

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


class SelfServiceDetailsTests(TestCase):
    """The few details that are nobody's business but the person's own.

    Everything that decides who gets paid stays behind a request. What is left
    -- a phone number -- is edited directly, because making somebody ask a
    super admin to change their own phone number is the kind of process that
    guarantees it is never kept up to date.
    """

    def setUp(self):
        self.person = User.objects.create_user(
            email="ss-person@test.edu", password="pass", name="SS Person",
            role=Role.FACULTY, department="CSE", staff_id="STF-SS",
        )
        self.client = Client()
        self.client.force_login(self.person)

    def patch_self(self, body, client=None):
        return (client or self.client).patch(
            "/api/auth/profile/self",
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_a_person_can_set_their_own_phone(self):
        r = self.patch_self({"phone": " +91 98400 12345 "})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["phone"], "+91 98400 12345")
        self.person.refresh_from_db()
        self.assertEqual(self.person.phone, "+91 98400 12345")
        self.assertEqual(self.client.get("/api/auth/me").json()["phone"], "+91 98400 12345")

    def test_the_change_is_audited_without_the_number_itself(self):
        self.patch_self({"phone": "044-2680 1234"})
        log = AuditLog.objects.get(action="PROFILE_SELF_UPDATE", entity_id=self.person.id)
        self.assertEqual(json.loads(log.detail_json)["fields"], ["phone"])
        self.assertNotIn("2680", log.detail_json)

    def test_saving_what_it_already_says_writes_no_audit_row(self):
        self.patch_self({"phone": "9840012345"})
        self.patch_self({"phone": "9840012345"})
        self.assertEqual(AuditLog.objects.filter(action="PROFILE_SELF_UPDATE").count(), 1)

    def test_a_phone_can_be_cleared(self):
        self.patch_self({"phone": "9840012345"})
        r = self.patch_self({"phone": ""})
        self.assertEqual(r.status_code, 200, r.content)
        self.person.refresh_from_db()
        self.assertFalse(self.person.phone)

    def test_something_that_is_not_a_phone_number_is_refused(self):
        for bad in ("call me", "12345", "+91 98400 12345 12345 12345", "98400<script>"):
            r = self.patch_self({"phone": bad})
            self.assertEqual(r.status_code, 400, (bad, r.content))
        self.person.refresh_from_db()
        self.assertFalse(self.person.phone)

    def test_identity_cannot_ride_along_with_a_phone_number(self):
        r = self.patch_self({"phone": "9840012345", "staff_id": "STF-SELF", "role": "SUPER_ADMIN"})
        self.assertIn(r.status_code, (400, 422), r.content)
        self.person.refresh_from_db()
        self.assertEqual(self.person.staff_id, "STF-SS")
        self.assertEqual(self.person.role, Role.FACULTY)
        self.assertFalse(self.person.phone)

    def test_the_identity_route_is_still_closed(self):
        r = self.client.patch(
            "/api/auth/profile",
            data=json.dumps({"name": "Somebody Else"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)

    def test_it_needs_a_session(self):
        self.assertEqual(self.patch_self({"phone": "9840012345"}, client=Client()).status_code, 401)


class AccountChangeRequestTests(TestCase):
    """Role, head of department, faculty type and quota: asked for, not typed.

    These were admin-only with no way to ask. Being wrongly marked research
    faculty zeroes papers, so a person needs a route to say so -- and the route
    goes to a super admin, with the same checks the account editor applies,
    because approving a role from a queue must not be a way round them.
    """

    def setUp(self):
        self.admin = User.objects.create_user(
            email="acr-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.cell = User.objects.create_user(
            email="acr-cell@test.edu", password="pass", name="Cell",
            role=Role.RESEARCH_CELL,
        )
        self.person = User.objects.create_user(
            email="acr-fac@test.edu", password="pass", name="ACR Person",
            role=Role.FACULTY, department="ECE",
            faculty_type="RESEARCH", research_quota=4,
        )
        self.fc = Client()
        self.fc.force_login(self.person)
        self.ac = Client()
        self.ac.force_login(self.admin)

    def ask(self, field, proposed, client=None):
        return (client or self.fc).post(
            "/api/auth/profile/correction",
            data=json.dumps({"field": field, "proposed": proposed, "note": "changed post"}),
            content_type="application/json",
        )

    def decide(self, approve=True, note="checked", client=None):
        rid = ProfileChangeRequest.objects.get(status="PENDING").id
        return (client or self.ac).post(
            f"/api/admin/profile-requests/{rid}",
            data=json.dumps({"approve": approve, "note": note}),
            content_type="application/json",
        )

    def test_a_role_change_is_listed_for_a_super_admin_and_applied_on_approval(self):
        self.assertEqual(self.ask("role", "HOD").status_code, 200)
        row = self.ac.get("/api/admin/profile-requests").json()["results"][0]
        self.assertEqual((row["field"], row["label"]), ("role", "Role"))
        self.assertEqual((row["current_value"], row["proposed_value"]), ("FACULTY", "HOD"))
        self.assertTrue(row["identity"])
        r = self.decide()
        self.assertEqual(r.status_code, 200, r.content)
        self.person.refresh_from_db()
        self.assertEqual(self.person.role, Role.HOD)

    def test_a_role_nothing_recognises_cannot_be_asked_for(self):
        self.assertEqual(self.ask("role", "EMPEROR").status_code, 400)
        self.assertFalse(ProfileChangeRequest.objects.exists())

    def test_a_role_request_goes_only_to_a_super_admin(self):
        self.ask("role", "HOD")
        told = set(
            Notification.objects.filter(title__startswith="Profile correction")
            .values_list("user__email", flat=True)
        )
        self.assertEqual(told, {self.admin.email})
        cc = Client()
        cc.force_login(self.cell)
        self.assertEqual(self.decide(client=cc).status_code, 403)
        self.person.refresh_from_db()
        self.assertEqual(self.person.role, Role.FACULTY)

    def test_approving_a_second_head_is_refused_and_the_request_stays_open(self):
        User.objects.create_user(
            email="acr-head@test.edu", password="pass", name="Head In Post",
            role=Role.HOD, department="ECE",
        )
        self.ask("role", "HOD")
        r = self.decide()
        self.assertEqual(r.status_code, 409, r.content)
        self.person.refresh_from_db()
        self.assertEqual(self.person.role, Role.FACULTY)
        self.assertEqual(ProfileChangeRequest.objects.get().status, "PENDING")

    def test_a_head_moving_department_is_held_to_one_head_per_department(self):
        """The account editor checks this on a department change; approving
        the same change from the queue must not skip it."""
        User.objects.create_user(
            email="acr-head-cse@test.edu", password="pass", name="CSE Head",
            role=Role.HOD, department="CSE",
        )
        self.person.role = Role.HOD
        self.person.save()
        self.assertEqual(self.ask("department", "CSE").status_code, 200)
        r = self.decide()
        self.assertEqual(r.status_code, 409, r.content)
        self.person.refresh_from_db()
        self.assertEqual(self.person.department, "ECE")
        self.assertEqual(ProfileChangeRequest.objects.get().status, "PENDING")

    def test_a_super_admin_cannot_approve_their_own_role(self):
        self.ask("role", "FACULTY", client=self.ac)
        r = self.decide()
        self.assertEqual(r.status_code, 400, r.content)
        self.admin.refresh_from_db()
        self.assertEqual(self.admin.role, Role.SUPER_ADMIN)

    def test_regular_faculty_on_approval_drops_the_quota(self):
        self.assertEqual(self.ask("faculty_type", "REGULAR").status_code, 200)
        self.assertEqual(self.decide().status_code, 200)
        self.person.refresh_from_db()
        self.assertEqual(self.person.faculty_type, "REGULAR")
        self.assertIsNone(self.person.research_quota)

    def test_a_faculty_type_must_be_regular_or_research(self):
        self.assertEqual(self.ask("faculty_type", "VISITING").status_code, 400)

    def test_a_quota_change_is_applied_as_a_number(self):
        self.assertEqual(self.ask("research_quota", " 2 ").status_code, 200)
        self.assertEqual(self.decide().status_code, 200)
        self.person.refresh_from_db()
        self.assertEqual(self.person.research_quota, 2)

    def test_a_quota_must_be_a_whole_number(self):
        for bad in ("two", "-1", "2.5"):
            self.assertEqual(self.ask("research_quota", bad).status_code, 400, bad)

    def test_a_quota_is_not_applied_to_a_regular_post(self):
        self.person.faculty_type = "REGULAR"
        self.person.research_quota = None
        self.person.save()
        self.ask("research_quota", "3")
        r = self.decide()
        self.assertEqual(r.status_code, 400, r.content)
        self.person.refresh_from_db()
        self.assertIsNone(self.person.research_quota)

    def test_the_person_sees_what_came_of_it(self):
        self.ask("faculty_type", "REGULAR")
        self.decide(approve=False, note="the post is a research post")
        mine = self.fc.get("/api/auth/profile/corrections").json()["results"]
        self.assertEqual((mine[0]["field"], mine[0]["status"]), ("faculty_type", "DECLINED"))


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
        with _model_unavailable():
            self.assertFalse(self.client.get("/api/discover/status").json()["available"])
        with _model_ready():
            self.assertTrue(self.client.get("/api/discover/status").json()["available"])

    def test_no_key_is_a_supported_state_not_a_crash(self):
        """The normal condition on a developer machine, and possibly in
        production. It must say so rather than 500."""
        with _model_unavailable():
            r = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "A Paper About Something Or Other"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 503)
            # It says which of the three ways it is off, because each has a
            # different one-command remedy. "Switched off" -- the old copy --
            # was only right for one of them.
            self.assertIn("No local model service", r.json()["detail"])

            self.assertEqual(self.client.get("/api/discover/directions").status_code, 503)

    def test_a_title_too_short_to_work_with_is_refused_before_the_model(self):
        with _model_ready():
            r = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "Hi"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400)

    def test_the_model_failing_is_never_a_500(self):
        """The request was fine; something the request depends on was not.

        Which of the two it is decides the status. A model that is not
        installed, or a service that is not running, is 503 and a one-command
        fix on the machine it runs on. A model that answered badly is 502.
        Both are the reader's cue to retry; neither is a bug in their request.
        """
        cases = [
            ("unreachable", 503),
            ("model_missing", 503),
            ("misconfigured", 503),
            ("timeout", 502),
            ("unparsable", 502),
        ]
        for code, expected in cases:
            with self.subTest(code=code):
                with _model_ready(), patch(
                    "core.services.discover.ai.ask_json",
                    side_effect=ai.AIError("it did not work", code=code),
                ):
                    r = self.client.post(
                        "/api/discover/venues",
                        data=json.dumps({"title": "A Paper About Something Or Other"}),
                        content_type="application/json",
                    )
                self.assertEqual(r.status_code, expected, code)

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
        with _model_ready(), patch(
            "core.services.discover.ai.ask_json", return_value=reply
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
        with _model_ready(), patch(
            "core.services.discover.ai.ask_json", return_value={"journals": []}
        ):
            body = self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "A Paper Title Long Enough", "author_position": 2, "total_authors": 5}),
                content_type="application/json",
            ).json()
        self.assertEqual(body["assumed"]["author_position"], 2)
        self.assertEqual(body["assumed"]["total_authors"], 5)

    def test_nothing_to_go_on_says_so_rather_than_asking_the_model(self):
        with _model_ready(), patch(
            "core.services.discover.ai.ask_json"
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


class RepriceAndDirectoryTests(TestCase):
    """Trying a different author position, and finding a person."""

    def setUp(self):
        self.user = User.objects.create_user(
            email="rp@test.edu", password="p", name="RP", role=Role.FACULTY
        )
        self.admin = User.objects.create_user(
            email="rp-admin@test.edu", password="p", name="A", role=Role.SUPER_ADMIN
        )
        ScimagoJournal.objects.create(
            source_id="1", title="Applied Soft Computing", issn="15684946", year=2025,
            sjr=1.4, categories_json=json.dumps([{"category": "Software", "quartile": "Q1"}]),
        )
        SnipSource.objects.create(
            title="Applied Soft Computing", print_issn="15684946", snip=1.831, year=2025
        )
        self.client = Client()
        self.client.force_login(self.user)

    def post(self, body):
        return self.client.post(
            "/api/discover/reprice",
            data=json.dumps(body),
            content_type="application/json",
        )

    def test_repricing_never_calls_the_model(self):
        """The whole reason it exists. Asking the model the same question again
        for an answer that cannot have changed costs seconds and a paid call
        per keystroke."""
        with patch("core.services.discover.ai.ask_json") as asked:
            r = self.post({"issns": ["15684946"], "author_position": 1, "total_authors": 3})
            asked.assert_not_called()
        self.assertEqual(r.status_code, 200)
        self.assertIsNotNone(r.json()["journals"][0]["payout"]["amount"])

    def test_it_works_with_no_model_configured_at_all(self):
        with _model_unavailable():
            self.assertEqual(
                self.post({"issns": ["15684946"]}).status_code, 200
            )

    def test_the_position_actually_changes_the_figure(self):
        first = self.post({"issns": ["15684946"], "author_position": 1, "total_authors": 4})
        fourth = self.post({"issns": ["15684946"], "author_position": 4, "total_authors": 4})
        self.assertNotEqual(
            first.json()["journals"][0]["payout"]["amount"],
            fourth.json()["journals"][0]["payout"]["amount"],
        )

    def test_an_issn_we_do_not_hold_is_dropped_rather_than_priced(self):
        """The client is not the authority on which journal an ISSN is, so the
        row is looked up again rather than trusted."""
        body = self.post({"issns": ["15684946", "00000000"]}).json()
        self.assertEqual([j["issn"] for j in body["journals"]], ["15684946"])

    def test_the_assumptions_come_back_with_the_figures(self):
        body = self.post({"issns": ["15684946"], "author_position": 2, "total_authors": 5}).json()
        self.assertEqual(body["assumed"]["author_position"], 2)
        self.assertEqual(body["assumed"]["total_authors"], 5)

    # ---- the directory's department filter -------------------------------

    def test_a_department_can_be_filtered_alongside_a_search(self):
        """`q` already matches department, but only as one of six things, so it
        could not be combined with a name search — picking a department cleared
        the search box and vice versa."""
        User.objects.create_user(
            email="k-ece@test.edu", password="p", name="Kumar", department="ECE"
        )
        User.objects.create_user(
            email="k-cse@test.edu", password="p", name="Kumar", department="CSE"
        )
        User.objects.create_user(
            email="r-ece@test.edu", password="p", name="Ravi", department="ECE"
        )
        c = Client()
        c.force_login(self.admin)

        both = c.get("/api/admin/users?q=Kumar&department=ECE").json()
        self.assertEqual([u["email"] for u in both["results"]], ["k-ece@test.edu"])

        dept_only = c.get("/api/admin/users?department=ECE").json()
        self.assertEqual(
            {u["email"] for u in dept_only["results"]},
            {"k-ece@test.edu", "r-ece@test.edu"},
        )

    def test_the_department_filter_is_exact_not_a_substring(self):
        """"CS" must not pull in everyone in "CSE"."""
        User.objects.create_user(
            email="cse@test.edu", password="p", name="C", department="CSE"
        )
        c = Client()
        c.force_login(self.admin)
        self.assertEqual(c.get("/api/admin/users?department=CS").json()["total"], 0)
        self.assertEqual(c.get("/api/admin/users?department=cse").json()["total"], 1)

    def test_a_claimant_cannot_read_the_directory(self):
        self.assertEqual(self.client.get("/api/admin/users").status_code, 403)


class ResearchSearchTests(TestCase):
    """A metasearch over the scholarly record, priced against our own tables.

    None of this needs a model or a key, which is the point: the AI features
    switch off without credits and this does not. So the tests run entirely
    offline — the three upstreams are stubbed, because what is worth testing
    here is the merging, the ranking and the pricing, not whether OpenAlex is
    up.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            email="rs@test.edu", password="p", name="RS", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.user)
        cache.clear()

    def hit(self, **kw):
        base = dict(
            source="OpenAlex", title="", doi=None, year=2025, journal="", issn=None,
            citations=0, open_access=False, type="article", authors=[], url="",
        )
        base.update(kw)
        return rs.Hit(base)

    # ---- merging ---------------------------------------------------------

    def test_the_same_doi_from_two_sources_is_one_result(self):
        merged = rs.merge([
            [self.hit(source="OpenAlex", doi="10.1/x", title="A Paper", citations=40)],
            [self.hit(source="Crossref", doi="10.1/x", title="A Paper")],
        ])
        self.assertEqual(len(merged), 1)
        self.assertEqual(sorted(merged[0]["sources"]), ["Crossref", "OpenAlex"])

    def test_a_title_match_dedupes_when_neither_has_a_doi(self):
        merged = rs.merge([
            [self.hit(source="OpenAlex", title="Deep Learning For Fault Detection")],
            [self.hit(source="arXiv", title="deep learning for fault detection.")],
        ])
        self.assertEqual(len(merged), 1)

    def test_different_dois_stay_apart_however_alike_the_titles(self):
        """Survey papers repeat titles across venues. Two works that happen to
        share a name are not one work."""
        merged = rs.merge([
            [self.hit(doi="10.1/aaa", title="A Review Of Machine Learning")],
            [self.hit(doi="10.1/bbb", title="A Review Of Machine Learning")],
        ])
        self.assertEqual(len(merged), 2)

    def test_merging_keeps_the_richest_version_of_each_field(self):
        """The same paper arrives from OpenAlex with citations and an ISSN and
        from Crossref with neither. Taking whichever landed first would throw
        away half of what three sources were asked for."""
        merged = rs.merge([
            [self.hit(source="Crossref", doi="10.1/x", title="A Paper", journal="")],
            [self.hit(source="OpenAlex", doi="10.1/x", title="A Paper",
                      journal="Applied Soft Computing", issn="15684946", citations=99)],
        ])[0]
        self.assertEqual(merged["journal"], "Applied Soft Computing")
        self.assertEqual(merged["issn"], "15684946")
        self.assertEqual(merged["citations"], 99)

    def test_a_real_value_is_never_overwritten_by_an_empty_one(self):
        merged = rs.merge([
            [self.hit(source="OpenAlex", doi="10.1/x", journal="Applied Soft Computing")],
            [self.hit(source="Crossref", doi="10.1/x", journal="")],
        ])[0]
        self.assertEqual(merged["journal"], "Applied Soft Computing")

    # ---- ranking ---------------------------------------------------------

    def test_recent_work_is_not_buried_by_decades_of_citations(self):
        """Citations accumulate over decades, so ranking on them alone hides
        everything from the last two years -- which is exactly what somebody
        asking "what is happening in my field" wants."""
        old = self.hit(doi="10.1/old", title="Old", year=2005, citations=800)
        new = self.hit(doi="10.1/new", title="New", year=2026, citations=3)
        ranked = rs.rank(rs.merge([[old], [new]]), this_year=2026)
        self.assertEqual(ranked[0]["title"], "New")

    # ---- pricing ---------------------------------------------------------

    def test_a_journal_we_hold_is_priced_by_our_own_formula(self):
        ScimagoJournal.objects.create(
            source_id="1", title="Applied Soft Computing", issn="15684946", year=2025,
            sjr=1.4, categories_json=json.dumps([{"category": "Software", "quartile": "Q1"}]),
        )
        SnipSource.objects.create(
            title="Applied Soft Computing", print_issn="15684946", snip=1.831, year=2025
        )
        hits = [self.hit(doi="10.1/x", journal="Applied Soft Computing", issn="1568-4946")]
        rs.enrich_with_our_data(hits, author_position=1, total_authors=3)

        self.assertTrue(hits[0]["journal_known"])
        self.assertEqual(hits[0]["quartile"], "Q1")
        self.assertIsNotNone(hits[0]["payout"]["amount"])

    def test_a_journal_we_do_not_hold_carries_no_numbers(self):
        """The same rule as the venue suggestions. A figure beside a journal we
        have not identified is worse than no figure."""
        hits = [self.hit(doi="10.1/x", journal="Journal Of Imaginary Widgetry", issn="99990000")]
        rs.enrich_with_our_data(hits, author_position=1, total_authors=1)
        self.assertFalse(hits[0]["journal_known"])
        self.assertNotIn("payout", hits[0])
        self.assertNotIn("quartile", hits[0])

    def test_a_preprint_is_never_priced(self):
        """arXiv results have no journal yet. Saying otherwise would let a
        preprint be priced as though it had been accepted somewhere."""
        hits = [self.hit(source="arXiv", title="A Preprint", journal="", issn=None)]
        rs.enrich_with_our_data(hits, author_position=1, total_authors=1)
        self.assertFalse(hits[0]["journal_known"])

    # ---- failure ---------------------------------------------------------

    def test_one_source_failing_degrades_the_results_rather_than_emptying_them(self):
        """An upstream having a bad day is not this application having an
        error, and a thin result set must not be mistaken for a thin field."""
        def boom(query, limit):
            raise RuntimeError("arXiv is down")

        with patch.dict(rs.SOURCES, {
            "openalex": lambda q, n: [self.hit(doi="10.1/x", title="Still Here")],
            "crossref": lambda q, n: [],
            "arxiv": boom,
        }):
            out = rs.search("something", limit=5)

        self.assertEqual([r["title"] for r in out["results"]], ["Still Here"])
        self.assertEqual(out["failed"], ["arxiv"])
        self.assertIn("openalex", out["asked"])

    def test_a_query_too_short_to_mean_anything_asks_nobody(self):
        with patch.dict(rs.SOURCES, {"openalex": lambda q, n: 1 / 0}):
            out = rs.search("ab")
        self.assertEqual(out["results"], [])
        self.assertEqual(out["asked"], [])

    # ---- the endpoint ----------------------------------------------------

    def test_the_endpoint_works_with_no_model_and_no_key(self):
        """The whole reason this exists beside the AI features."""
        with _model_unavailable(), patch.dict(rs.SOURCES, {
            "openalex": lambda q, n: [self.hit(doi="10.1/x", title="Found It")],
            "crossref": lambda q, n: [],
            "arxiv": lambda q, n: [],
        }):
            r = self.client.get("/api/research/search?q=fault+detection")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([h["title"] for h in r.json()["results"]], ["Found It"])

    def test_the_endpoint_says_which_sources_answered(self):
        with patch.dict(rs.SOURCES, {
            "openalex": lambda q, n: [self.hit(doi="10.1/x", title="A")],
            "crossref": lambda q, n: [],
            "arxiv": lambda q, n: (_ for _ in ()).throw(RuntimeError("down")),
        }):
            body = self.client.get("/api/research/search?q=fault+detection").json()
        self.assertEqual(body["failed"], ["arxiv"])

    def test_signing_out_closes_it(self):
        self.assertEqual(Client().get("/api/research/search?q=anything").status_code, 401)


class IssnRepairTests(TestCase):
    """The spreadsheet bug that halved what this system could price.

    Both reference tables stored ISSNs as floats -- `14327643.0` -- because a
    column was read as a number on the way in. Two consequences, both silent: a
    SNIP row never equalled the Scimago row for the same journal, and any ISSN
    with a leading zero had lost it entirely.

    Migrations 0027 and 0028 repaired 59,741 values between them and the match
    rate went from 32% to 89%. These tests are about `normalize_issn`, which
    knew how to undo both mistakes long before anything applied it to the
    stored data -- and about the importers, so the next dump does not put it
    all back.
    """

    def test_a_float_suffix_is_stripped(self):
        self.assertEqual(normalize_issn("14327643.0"), "1432-7643")

    def test_a_lost_leading_zero_is_restored(self):
        """Read as a number, 0390-6663 arrives as 3906663. Seven characters, so
        stripping the suffix alone does not fix it."""
        self.assertEqual(normalize_issn("3906663.0"), "0390-6663")

    def test_an_issn_that_legitimately_ends_in_zero_is_untouched(self):
        self.assertEqual(normalize_issn("1234-5670"), "1234-5670")
        self.assertEqual(normalize_issn("12345670"), "1234-5670")

    def test_the_repaired_tables_match_each_other(self):
        """The failure that started this: both sides corrupt matched by luck,
        and cleaning one side alone pulled those pairs apart."""
        ScimagoJournal.objects.create(
            source_id="1", title="Soft Computing", issn="14327643", year=2025,
            sjr=0.9, categories_json=json.dumps([{"category": "Software", "quartile": "Q2"}]),
        )
        SnipSource.objects.create(
            title="Soft Computing", print_issn="14327643", e_issn="14337479",
            snip=1.051, year=2025,
        )
        row = discover.find_journal("Soft Computing")
        self.assertIsNotNone(row)
        self.assertEqual(discover.find_snip(row), 1.051)


class DirectorChainTests(TestCase):
    """The step between the Principal and Finance.

    The chain is FACULTY -> admin office -> Principal -> Director -> Finance,
    and the thing worth testing hardest is the join: that a Principal-approved
    claim is *not* payable, and that the high-value second-signature rule still
    fires now that the status Finance pays from has changed. That guard is only
    consulted once a ticket reaches the payable status, so moving the payable
    status without moving the guard would have switched it off silently.
    """

    def setUp(self):
        from core.api import _invalidate_threshold_cache

        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            high_value_threshold=100000,
        )
        _invalidate_threshold_cache()
        self.addCleanup(_invalidate_threshold_cache)

        self.faculty = User.objects.create_user(
            email="dir-fac@test.edu", password="pass", name="Dir Faculty",
            role=Role.FACULTY, department="CSE", staff_id="STF-DIR",
        )
        self.admin = User.objects.create_user(
            email="dir-admin@test.edu", password="pass", name="Dir Admin",
            role=Role.SUPER_ADMIN,
        )
        self.principal = User.objects.create_user(
            email="dir-principal@test.edu", password="pass", name="Dir Principal",
            role=Role.PRINCIPAL,
        )
        self.director = User.objects.create_user(
            email="dir-director@test.edu", password="pass", name="Dir Director",
            role=Role.DIRECTOR,
        )
        self.finance = User.objects.create_user(
            email="dir-fin@test.edu", password="pass", name="Dir Finance",
            role=Role.FINANCE,
        )
        self.client = Client()
        verify_patch = patch_api("verify_publication", side_effect=_echo_verified)
        verify_patch.start()
        self.addCleanup(verify_patch.stop)

    def _claim(self, *, status, remuneration, ticket, **kw):
        if status == ClaimStatus.PRINCIPAL_APPROVED:
            kw.setdefault("principal_approved_at", timezone.now())
            kw.setdefault("principal_approved_by", self.principal)
        if status == ClaimStatus.DIRECTOR_APPROVED:
            kw.setdefault("principal_approved_at", timezone.now())
            kw.setdefault("principal_approved_by", self.principal)
            kw.setdefault("director_approved_at", timezone.now())
            kw.setdefault("director_approved_by", self.director)
        claim = Claim.objects.create(
            owner=self.faculty, status=status, ticket_number=ticket,
            paper_title=f"Director {ticket}", publication_type="Journal",
            indexing_level="Scopus", engineering_class="Engineering",
            quartile=kw.pop("quartile", "Q2"), quartile_source="SCIMAGO",
            snip=kw.pop("snip", 1.0), snip_source="SCOPUS",
            total_authors=1, author_position=1,
            remuneration=remuneration, **kw,
        )
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'d' * 31}{n[-1]}.pdf", ref_number=n,
            )
        return claim

    # ---- the gate ----------------------------------------------------

    def test_finance_cannot_pay_what_the_director_has_not_authorised(self):
        """The whole point of the step. A Principal-approved claim is not payable."""
        claim = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-1"
        )
        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Director", r.json()["detail"])
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)
        self.assertEqual(PaidLedger.objects.filter(claim=claim).count(), 0)

    def test_director_authorisation_makes_it_payable(self):
        claim = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-2"
        )
        self.client.force_login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            data=json.dumps({"expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)
        self.assertEqual(claim.director_approved_by_id, self.director.id)
        self.assertIsNotNone(claim.director_approved_at)

        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)

    def test_a_cleared_ticket_cannot_skip_the_principal(self):
        claim = self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="D-3")
        self.client.force_login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            data=json.dumps({"expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

    # ---- who may do it -----------------------------------------------

    def test_only_the_director_or_a_super_admin_may_authorise(self):
        for actor, expected in (
            (self.faculty, 403),
            (self.principal, 403),
            (self.finance, 403),
            (self.director, 200),
        ):
            claim = self._claim(
                status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0,
                ticket=f"D-role-{actor.id[:6]}",
            )
            self.client.force_login(actor)
            r = self.client.post(
                f"/api/claims/{claim.id}/director-approve",
                data=json.dumps({"expected_amount": 85000.0}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, expected, f"{actor.role}: {r.content}")

    def test_a_super_admin_may_stand_in_for_the_director(self):
        claim = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-stand-in"
        )
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            data=json.dumps({"expected_amount": 85000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    # ---- the amount guard --------------------------------------------

    def test_authorising_refuses_when_the_amount_drifted(self):
        claim = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-4"
        )
        self.client.force_login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            # What the screen showed, which is not what it recomputes to.
            data=json.dumps({"expected_amount": 42000.0}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 409, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

    # ---- the second signature, which must still fire -------------------

    def test_a_high_value_claim_still_needs_a_second_signature(self):
        """The guard is consulted at the payable status, which has moved.

        Before the Director step, `_needs_second_approval` looked only at
        CLEARED and PRINCIPAL_APPROVED. Payment now happens at
        DIRECTOR_APPROVED, so leaving that list alone would have meant the
        check returned False for every claim finance could actually pay --
        switching the rule off on exactly the large amounts it exists for.
        """
        claim = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=160000.0,
            ticket="D-5", snip=2.0, quartile="Q1",
        )
        # Cleared by the same person who will authorise it, so authorising
        # cannot itself supply the second signature.
        claim.cleared_by = self.director
        claim.save(update_fields=["cleared_by"])

        self.client.force_login(self.director)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-approve",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)

        self.client.force_login(self.finance)
        r = self.client.post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"expected_amount": claim.remuneration}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("second approver", r.json()["detail"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)

    # ---- sending it back ----------------------------------------------

    def test_sending_back_returns_it_to_the_principal_and_withdraws_the_approval(self):
        claim = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-6"
        )
        # The Director is forward-only now; the send-back is a super admin's
        # rescue (core/test_chain_rules.py ForwardOnlyTests).
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-reject",
            data=json.dumps({"note": "Past the quarter's allocation"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        # Back one step, to the Principal -- not to the claimant.
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self.assertEqual(claim.status_note, "Past the quarter's allocation")
        # And the approval goes with it: a signature left on a reopened
        # decision reads later as though it was approved twice.
        self.assertIsNone(claim.principal_approved_at)
        self.assertIsNone(claim.principal_approved_by_id)

    def test_sending_back_needs_a_reason(self):
        claim = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-7"
        )
        self.client.force_login(self.admin)
        r = self.client.post(
            f"/api/claims/{claim.id}/director-reject",
            data=json.dumps({"note": "no"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

    # ---- the queue -----------------------------------------------------

    def test_the_queue_holds_what_the_principal_approved(self):
        self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-8")
        self._claim(status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="D-9")
        self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="D-10")

        self.client.force_login(self.director)
        body = self.client.get("/api/director/queue").json()
        tickets = {row["ticket_number"] for row in body["results"]}
        self.assertEqual(tickets, {"D-8"})
        self.assertEqual(body["totals"]["count"], 1)
        self.assertEqual(body["totals"]["amount"], 85000.0)

    def test_the_payable_queue_holds_only_what_was_authorised(self):
        self._claim(status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-11")
        self._claim(status=ClaimStatus.DIRECTOR_APPROVED, remuneration=85000.0, ticket="D-12")

        self.client.force_login(self.finance)
        body = self.client.get("/api/admin/payouts?status=PRINCIPAL_APPROVED").json()
        tickets = {row["ticket_number"] for row in body["results"]}
        self.assertEqual(tickets, {"D-12"})

    # ---- bulk ----------------------------------------------------------

    def test_bulk_authorise_skips_what_does_not_qualify_and_says_why(self):
        ok = self._claim(
            status=ClaimStatus.PRINCIPAL_APPROVED, remuneration=85000.0, ticket="D-13"
        )
        wrong_stage = self._claim(
            status=ClaimStatus.CLEARED, remuneration=85000.0, ticket="D-14"
        )
        self.client.force_login(self.director)
        r = self.client.post(
            "/api/director/bulk-approve",
            data=json.dumps({"claim_ids": [ok.id, wrong_stage.id]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["approved"], 1)
        self.assertEqual(len(body["skipped"]), 1)
        self.assertIn("D-14", body["skipped"][0]["reason"])
        ok.refresh_from_db()
        wrong_stage.refresh_from_db()
        self.assertEqual(ok.status, ClaimStatus.DIRECTOR_APPROVED)
        self.assertEqual(wrong_stage.status, ClaimStatus.CLEARED)

    # ---- what the claimant is told --------------------------------------

    def test_the_claimant_is_not_sent_to_finance_a_step_early(self):
        # In the claimant's own words now, which name no desk
        # (core/test_chain_rules.py): approved by the Principal is still under
        # review; only the Director's authorisation is approval for payment.
        title, body = api_module._faculty_status_copy(ClaimStatus.PRINCIPAL_APPROVED)
        self.assertEqual(title, "Under review")
        self.assertNotIn("payment", (title + body).lower())
        title, body = api_module._faculty_status_copy(ClaimStatus.DIRECTOR_APPROVED)
        self.assertEqual(title, "Approved for payment")


class ReportBuilderTests(TestCase):
    """The built report, and the one figure it refuses to add up."""

    def setUp(self):
        self.admin = User.objects.create_user(
            email="rb-admin@test.edu", password="pass", name="RB Admin",
            role=Role.SUPER_ADMIN,
        )
        self.faculty = User.objects.create_user(
            email="rb-fac@test.edu", password="pass", name="RB Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def _paper(self, ticket, subjects, amount):
        return Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, ticket_number=ticket,
            paper_title=f"RB {ticket}", subjects_json=subjects,
            remuneration=amount, publication_year=2025,
        )

    def test_subject_areas_do_not_report_a_money_total(self):
        """A paper in three areas would have its amount counted three times.

        Counting the paper under each area is the honest answer to "how much
        work do we do here". Adding up the money the same way turned 2.8 crore
        of real payouts into 12.6 crore, which is the kind of figure that ends
        up in a board pack.
        """
        self._paper("RB-1", "Engineering; Computer Science; Signal Processing (Q4)", 30000.0)
        self._paper("RB-2", "Engineering", 20000.0)

        self.client.force_login(self.admin)
        body = self.client.get("/api/reports/build?dimensions=area,department").json()
        areas = next(t for t in body["tables"] if t["key"] == "area")
        department = next(t for t in body["tables"] if t["key"] == "department")

        self.assertTrue(areas["overlapping"])
        self.assertIsNone(areas["totals"]["amount"])
        # Four appearances across two papers.
        self.assertEqual(areas["totals"]["count"], 4)

        # A dimension where a paper belongs to exactly one row still totals.
        self.assertFalse(department["overlapping"])
        self.assertEqual(department["totals"]["amount"], 50000.0)
        self.assertEqual(department["totals"]["count"], 2)

    def test_a_subject_quartile_is_split_from_the_area_name(self):
        """Scimago writes the quartile into the label: "Signal Processing (Q4)".

        Left alone, the same area under four quartiles is four areas that
        happen to share a name. "(miscellaneous)" is a real category and must
        survive, which is why only a trailing Q1-Q4 is stripped.
        """
        parsed = api_module._split_subjects(
            "Physics and Astronomy (miscellaneous); Signal Processing (Q4)"
        )
        self.assertEqual(
            parsed,
            [("Physics and Astronomy (miscellaneous)", None), ("Signal Processing", "Q4")],
        )

    def test_the_download_is_the_report_that_was_previewed(self):
        self._paper("RB-3", "Engineering", 20000.0)
        self.client.force_login(self.admin)
        r = self.client.get("/api/reports/build?dimensions=department&fmt=xlsx")
        self.assertEqual(r.status_code, 200)
        self.assertIn("spreadsheetml", r["Content-Type"])
        self.assertIn("attachment", r["Content-Disposition"])
        self.assertGreater(len(r.content), 2000)

    def test_an_unknown_breakdown_is_named_rather_than_ignored(self):
        self.client.force_login(self.admin)
        r = self.client.get("/api/reports/build?dimensions=department,wingspan")
        self.assertEqual(r.status_code, 400)
        self.assertIn("wingspan", r.json()["detail"])


class ProgrammeTests(TestCase):
    """A faculty member's research picture, which carries nobody's money."""

    def setUp(self):
        self.me = User.objects.create_user(
            email="pg-me@test.edu", password="pass", name="Programme Me",
            role=Role.FACULTY, department="CSE",
        )
        self.other = User.objects.create_user(
            email="pg-other@test.edu", password="pass", name="Programme Other",
            role=Role.FACULTY, department="ECE",
        )
        self.client = Client()

    def _paper(self, owner, ticket, subjects, amount=50000.0):
        return Claim.objects.create(
            owner=owner, status=ClaimStatus.PAID, ticket_number=ticket,
            paper_title=f"PG {ticket}", subjects_json=subjects,
            remuneration=amount, publication_year=2025,
        )

    def test_areas_come_from_filed_papers_and_colleagues_from_shared_areas(self):
        self._paper(self.me, "PG-1", "Signal Processing (Q4); Computer Science")
        self._paper(self.other, "PG-2", "Computer Science")
        self._paper(self.other, "PG-3", "Marine Biology")

        self.client.force_login(self.me)
        body = self.client.get("/api/programme/me").json()

        self.assertEqual(
            {a["key"] for a in body["areas"]}, {"Signal Processing", "Computer Science"}
        )
        self.assertEqual([c["name"] for c in body["colleagues"]], ["Programme Other"])
        # Matched on the shared area only -- their marine biology paper is not
        # what makes them a colleague.
        self.assertEqual(body["colleagues"][0]["areas"], ["Computer Science"])

    def test_it_carries_no_money_at_all(self):
        """A claimant sees their own amounts and nobody else's.

        This page is entirely about other people, so an amount anywhere in the
        payload is a colleague's payout leaking through the back door.
        """
        self._paper(self.me, "PG-4", "Computer Science")
        self._paper(self.other, "PG-5", "Computer Science")

        self.client.force_login(self.me)
        raw = self.client.get("/api/programme/me").content.decode()
        for word in ("remuneration", "payout", "amount"):
            self.assertNotIn(word, raw, f"{word!r} must not appear in the programme payload")

    def test_somebody_with_no_papers_gets_an_empty_picture_not_an_error(self):
        self.client.force_login(self.me)
        r = self.client.get("/api/programme/me")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["areas"], [])
        self.assertEqual(body["colleagues"], [])
        self.assertEqual(body["totals"]["my_papers"], 0)


class HodTargetsTests(TestCase):
    """What a head may set, for whom, and what they are never shown.

    Two invariants carry the weight here. A head is money-blind, so no
    response on any of these endpoints may contain a rupee figure. And a head
    owns exactly one department, so a target aimed at somebody outside it is
    refused on the server rather than merely hidden on the screen.
    """

    def setUp(self):
        self.head = User.objects.create_user(
            email="ht-head@test.edu", password="pass", name="Head of Physics",
            role=Role.HOD, department="Physics",
        )
        self.mine = User.objects.create_user(
            email="ht-mine@test.edu", password="pass", name="Physics Person",
            role=Role.FACULTY, department="Physics",
        )
        self.theirs = User.objects.create_user(
            email="ht-theirs@test.edu", password="pass", name="Chemistry Person",
            role=Role.FACULTY, department="Chemistry",
        )
        self.client = Client()

    def _paper(self, owner, ticket, *, quartile="Q2", position=1, year=2025, amount=50000.0):
        return Claim.objects.create(
            owner=owner, status=ClaimStatus.PAID, ticket_number=ticket,
            paper_title=f"HT {ticket}", journal_title="A Journal",
            quartile=quartile, author_position=position, total_authors=2,
            publication_year=year, remuneration=amount, issn="1111-0000", doi="10.1/x",
        )

    # ---- targets -------------------------------------------------------

    def test_a_head_sets_a_departmental_target_and_progress_is_counted(self):
        self._paper(self.mine, "HT-1", quartile="Q1")
        self._paper(self.mine, "HT-2", quartile="Q1")
        self._paper(self.mine, "HT-3", quartile="Q3")

        self.client.force_login(self.head)
        r = self.client.post(
            "/api/hod/targets",
            data=json.dumps({"year": 2025, "metric": "Q1", "target": 5}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

        body = self.client.get("/api/hod/targets?year=2025").json()
        self.assertEqual(len(body["department_targets"]), 1)
        target = body["department_targets"][0]
        # Two Q1 papers of a target of five -- counted from filed work rather
        # than stored, so it cannot go stale.
        self.assertEqual(target["done"], 2)
        self.assertEqual(target["target"], 5)
        self.assertEqual(target["remaining"], 3)
        self.assertFalse(target["met"])

    def test_a_personal_target_counts_only_that_person(self):
        other = User.objects.create_user(
            email="ht-mine2@test.edu", password="pass", name="Second Physicist",
            role=Role.FACULTY, department="Physics",
        )
        self._paper(self.mine, "HT-4")
        self._paper(other, "HT-5")
        self._paper(other, "HT-6")

        self.client.force_login(self.head)
        self.client.post(
            "/api/hod/targets",
            data=json.dumps({
                "year": 2025, "metric": "PUBLICATIONS", "target": 3,
                "person_id": self.mine.id,
            }),
            content_type="application/json",
        )
        body = self.client.get("/api/hod/targets?year=2025").json()
        personal = body["personal_targets"][0]
        self.assertEqual(personal["person_name"], "Physics Person")
        # One paper, not the department's three.
        self.assertEqual(personal["done"], 1)

    def test_a_head_cannot_set_a_target_on_another_department(self):
        self.client.force_login(self.head)
        r = self.client.post(
            "/api/hod/targets",
            data=json.dumps({
                "year": 2025, "metric": "PUBLICATIONS", "target": 3,
                "person_id": self.theirs.id,
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("Physics", r.json()["detail"])
        self.assertEqual(DepartmentTarget.objects.count(), 0)

    def test_setting_the_same_metric_twice_replaces_rather_than_duplicates(self):
        self.client.force_login(self.head)
        for value in (5, 9):
            r = self.client.post(
                "/api/hod/targets",
                data=json.dumps({"year": 2025, "metric": "Q1", "target": value}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(DepartmentTarget.objects.count(), 1)
        self.assertEqual(DepartmentTarget.objects.get().target, 9)

    def test_a_head_cannot_delete_another_department_s_target(self):
        theirs = DepartmentTarget.objects.create(
            department="Chemistry", year=2025, metric="Q1", target=4,
        )
        self.client.force_login(self.head)
        r = self.client.delete(f"/api/hod/targets/{theirs.id}")
        self.assertEqual(r.status_code, 403, r.content)
        self.assertTrue(DepartmentTarget.objects.filter(pk=theirs.id).exists())

    def test_an_unknown_metric_is_refused(self):
        self.client.force_login(self.head)
        r = self.client.post(
            "/api/hod/targets",
            data=json.dumps({"year": 2025, "metric": "REVENUE", "target": 5}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    # ---- standing ------------------------------------------------------

    def test_standing_places_the_department_without_naming_another_one(self):
        """A head sees where they sit, not a league table of their colleagues.

        "3rd of 22" answers the question. A ranked list of every department by
        name is a different document with different politics, and it is not a
        head's to hold.
        """
        self._paper(self.mine, "HT-7")
        self._paper(self.mine, "HT-8")
        self._paper(self.theirs, "HT-9")

        self.client.force_login(self.head)
        body = self.client.get("/api/hod/standing").json()

        self.assertEqual(body["department"], "Physics")
        self.assertEqual(body["mine"]["publications"], 2)
        self.assertEqual(body["college"]["publications"], 3)
        self.assertEqual(body["position"], 1)
        self.assertEqual(body["of"], 2)
        self.assertAlmostEqual(body["share"], 2 / 3, places=3)
        # The other department exists in the arithmetic and nowhere in the text.
        self.assertNotIn("Chemistry", json.dumps(body))

    def test_none_of_it_carries_money(self):
        self._paper(self.mine, "HT-10", amount=123456.0)
        self.client.force_login(self.head)
        for path in (
            "/api/hod/standing",
            "/api/hod/targets",
            "/api/hod/opportunities",
            "/api/hod/overview",
        ):
            raw = self.client.get(path).content.decode()
            self.assertNotIn("123456", raw, f"{path} leaked an amount")
            for key in ("remuneration", "voucher_number", "paid_at", "amount"):
                self.assertNotIn(f'"{key}"', raw, f"{path} carries {key}")

    # ---- opportunities -------------------------------------------------

    def test_opportunities_name_the_people_behind_each_count(self):
        quiet = User.objects.create_user(
            email="ht-quiet@test.edu", password="pass", name="Quiet Physicist",
            role=Role.FACULTY, department="Physics",
        )
        self._paper(self.mine, "HT-11", quartile="Q3")

        self.client.force_login(self.head)
        body = self.client.get("/api/hod/opportunities").json()
        groups = {g["key"]: g for g in body["groups"]}

        # Somebody with nothing filed is named, not just counted -- the head
        # included, who is faculty too (2026-09-23) and has filed nothing here.
        self.assertEqual(groups["silent"]["count"], 2)
        self.assertEqual(
            {p["name"] for p in groups["silent"]["people"]},
            {"Quiet Physicist", "Head of Physics"},
        )
        self.assertNotIn(quiet.id, [p["id"] for p in groups["no_q1"]["people"]])

        # Publishing but never in a Q1 journal.
        self.assertEqual(groups["no_q1"]["count"], 1)
        self.assertEqual(groups["no_q1"]["people"][0]["name"], "Physics Person")

    def test_papers_missing_an_issn_or_doi_are_listed_for_fixing(self):
        c = self._paper(self.mine, "HT-12")
        Claim.objects.filter(pk=c.pk).update(issn="", doi=None)

        self.client.force_login(self.head)
        body = self.client.get("/api/hod/opportunities").json()
        self.assertEqual(body["incomplete_records"]["count"], 1)
        row = body["incomplete_records"]["papers"][0]
        self.assertEqual(sorted(row["missing"]), ["DOI", "ISSN"])

    # ---- one person ----------------------------------------------------

    def test_a_head_can_open_somebody_in_their_own_department(self):
        """Every name on a head's department screen used to be a dead link.

        `/api/faculty/{id}/report` needs `can_view_reports`, which a head does
        not have, so the list of their own staff linked to a refusal for each
        one. This is the same question inside a head's limits.
        """
        self._paper(self.mine, "HP-1", quartile="Q1")
        self._paper(self.mine, "HP-2", quartile="Q3", position=2)

        self.client.force_login(self.head)
        r = self.client.get(f"/api/hod/people/{self.mine.id}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["person"]["name"], "Physics Person")
        self.assertEqual(body["totals"]["publications"], 2)
        self.assertEqual(body["totals"]["q1"], 1)
        self.assertEqual(body["totals"]["first_author"], 1)
        self.assertEqual(len(body["papers"]), 2)
        # Status is translated, never passed through: "PAID" would tell a head
        # that a colleague was paid.
        self.assertEqual({p["progress"] for p in body["papers"]}, {"Completed"})
        self.assertNotIn("PAID", json.dumps(body))

    def test_a_head_cannot_open_somebody_in_another_department(self):
        self.client.force_login(self.head)
        r = self.client.get(f"/api/hod/people/{self.theirs.id}")
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("Physics", r.json()["detail"])

    def test_the_person_view_carries_no_money(self):
        self._paper(self.mine, "HP-3", amount=987654.0)
        self.client.force_login(self.head)
        raw = self.client.get(f"/api/hod/people/{self.mine.id}").content.decode()
        self.assertNotIn("987654", raw)
        for key in ("remuneration", "voucher_number", "paid_at", "payout_month"):
            self.assertNotIn(f'"{key}"', raw)

    def test_a_personal_target_shows_on_the_person(self):
        self._paper(self.mine, "HP-4", quartile="Q1")
        self.client.force_login(self.head)
        self.client.post(
            "/api/hod/targets",
            data=json.dumps({
                "year": 2025, "metric": "Q1", "target": 3, "person_id": self.mine.id,
            }),
            content_type="application/json",
        )
        body = self.client.get(f"/api/hod/people/{self.mine.id}").json()
        self.assertEqual(len(body["targets"]), 1)
        self.assertEqual(body["targets"][0]["done"], 1)
        self.assertEqual(body["targets"][0]["target"], 3)
        self.assertFalse(body["targets"][0]["met"])

    def test_only_a_head_may_open_any_of_it(self):
        outsider = User.objects.create_user(
            email="ht-out@test.edu", password="pass", name="Somebody Else",
            role=Role.FACULTY, department="Physics",
        )
        self.client.force_login(outsider)
        for path in ("/api/hod/standing", "/api/hod/targets", "/api/hod/opportunities"):
            self.assertEqual(self.client.get(path).status_code, 403, path)


class FilingRulesTests(TestCase):
    """The rules the filing form enforces, read from the live policy.

    The point of the endpoint is that the form stops hard-coding them. A
    hard-coded 2 in the client is a rule that silently stops matching the one
    the money is calculated from the day somebody publishes a new policy --
    and the way anybody finds out is a claimant being paid nothing.
    """

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="fr-fac@test.edu", password="pass", name="FR Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def test_a_claimant_may_read_the_rules_they_have_to_satisfy(self):
        """Deliberately wider than the policy sheet, which 403s them.

        A claimant cannot read the rates -- that is an oversight document --
        but they must be able to read the rules that decide whether their own
        paper is eligible at all.
        """
        self.client.force_login(self.faculty)
        r = self.client.get("/api/meta/filing-rules")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.client.get("/api/admin/formula").status_code, 403)

    def test_the_rules_come_from_the_active_policy(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            max_authors=4, min_sec_references=3,
        )
        self.client.force_login(self.faculty)
        body = self.client.get("/api/meta/filing-rules").json()
        self.assertEqual(body["max_authors"], 4)
        self.assertEqual(body["min_sec_references"], 3)
        # The sentence the form shows is the server's, so what a claimant is
        # told before filing matches what the calculator would say after.
        self.assertIn("4", body["why"]["max_authors"])
        self.assertIn("3", body["why"]["min_sec_references"])

    def test_with_no_policy_row_it_falls_back_to_the_built_in_limits(self):
        self.client.force_login(self.faculty)
        body = self.client.get("/api/meta/filing-rules").json()
        self.assertEqual(body["max_authors"], MAX_ELIGIBLE_AUTHORS)
        self.assertEqual(body["min_sec_references"], MIN_SEC_REFERENCES)

    def test_it_carries_no_rates(self):
        """Eligibility rules, not the payout sheet.

        The distinction is the reason this endpoint exists rather than simply
        opening `/admin/formula` to everybody.
        """
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            snip_multiplier=55000, qf_q1=50000,
        )
        self.client.force_login(self.faculty)
        raw = self.client.get("/api/meta/filing-rules").content.decode()
        for leaked in ("snip_multiplier", "qf_q1", "55000", "50000", "high_value_threshold"):
            self.assertNotIn(leaked, raw)

    def test_the_upload_limits_match_what_the_server_enforces(self):
        self.client.force_login(self.faculty)
        body = self.client.get("/api/meta/filing-rules").json()
        self.assertEqual(
            body["attachment_limits"]["PUBLISHED_PAPER"],
            ATTACHMENT_LIMITS[AttachmentKind.PUBLISHED_PAPER],
        )
        self.assertEqual(
            body["attachment_limits"]["SEC_REFERENCE"],
            ATTACHMENT_LIMITS[AttachmentKind.SEC_REFERENCE],
        )

    def test_it_needs_a_session(self):
        self.assertEqual(self.client.get("/api/meta/filing-rules").status_code, 401)


class AssignableRoleTests(TestCase):
    """Every role in the chain has to be one an account can actually be given.

    The Director authorises every payment. Leaving DIRECTOR out of
    `ASSIGNABLE_ROLES` gave the chain a step nobody could be appointed to --
    the endpoint existed, the queue existed, and there was no way to make
    somebody the Director through the app at all.
    """

    def setUp(self):
        self.admin = User.objects.create_user(
            email="ar-admin@test.edu", password="pass", name="AR Admin",
            role=Role.SUPER_ADMIN,
        )
        self.person = User.objects.create_user(
            email="ar-person@test.edu", password="pass", name="AR Person",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def test_every_role_in_the_chain_can_be_assigned(self):
        self.client.force_login(self.admin)
        for role in (Role.FACULTY, Role.HOD, Role.PRINCIPAL, Role.DIRECTOR,
                     Role.FINANCE, Role.RESEARCH_CELL, Role.SUPER_ADMIN):
            r = self.client.patch(
                f"/api/admin/users/{self.person.id}",
                data=json.dumps({"role": role}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 200, f"{role}: {r.content}")
            self.person.refresh_from_db()
            self.assertEqual(self.person.role, role)

    def test_a_role_nothing_recognises_is_refused(self):
        self.client.force_login(self.admin)
        r = self.client.patch(
            f"/api/admin/users/{self.person.id}",
            data=json.dumps({"role": "CHANCELLOR"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.person.refresh_from_db()
        self.assertEqual(self.person.role, Role.FACULTY)

    def test_a_new_account_may_be_created_as_the_director(self):
        self.client.force_login(self.admin)
        r = self.client.post(
            "/api/admin/users",
            data=json.dumps({
                "email": "ar-dir@test.edu", "name": "AR Director",
                "password": "a-handover-value", "role": Role.DIRECTOR,
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        made = User.objects.get(email="ar-dir@test.edu")
        self.assertEqual(made.role, Role.DIRECTOR)
        # Issued, not chosen: they are asked for their own on first sign-in.
        self.assertTrue(made.must_change_password)

    def test_the_research_cell_may_move_somebody_between_departments(self):
        """Routing, not identity -- people move departments as a matter of course."""
        cell = User.objects.create_user(
            email="ar-cell@test.edu", password="pass", name="AR Cell",
            role=Role.RESEARCH_CELL,
        )
        self.client.force_login(cell)
        r = self.client.patch(
            f"/api/admin/users/{self.person.id}",
            data=json.dumps({"department": "Physics"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.person.refresh_from_db()
        self.assertEqual(self.person.department, "Physics")
        # And the move is on the record, with what it was before.
        entry = AuditLog.objects.filter(action="USER_UPDATE", entity_id=self.person.id).first()
        self.assertIsNotNone(entry)
        self.assertIn("CSE", entry.detail_json)

    def test_an_admin_cannot_lock_themselves_out(self):
        self.client.force_login(self.admin)
        for payload in ({"role": Role.FACULTY}, {"active": False}):
            r = self.client.patch(
                f"/api/admin/users/{self.admin.id}",
                data=json.dumps(payload),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 400, f"{payload}: {r.content}")
        self.admin.refresh_from_db()
        self.assertEqual(self.admin.role, Role.SUPER_ADMIN)
        self.assertTrue(self.admin.active)


class ThreadVisibilityTests(TestCase):
    """Who may see a thread. The one property everything else rests on."""

    def setUp(self):
        self.ece = User.objects.create_user(
            email="tv-ece@test.edu", password="pass", name="ECE Person",
            role=Role.FACULTY, department="ECE",
        )
        self.mech = User.objects.create_user(
            email="tv-mech@test.edu", password="pass", name="MECH Person",
            role=Role.FACULTY, department="MECH",
        )
        self.office = User.objects.create_user(
            email="tv-office@test.edu", password="pass", name="TV Office",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()

    def _open(self, actor, visibility, department=None, title="A thread for testing"):
        self.client.force_login(actor)
        r = self.client.post(
            "/api/threads",
            data=json.dumps({
                "title": title, "body": "the first post",
                "visibility": visibility, "department": department,
            }),
            content_type="application/json",
        )
        return r

    def _can_read(self, actor, thread_id) -> bool:
        self.client.force_login(actor)
        return self.client.get(f"/api/threads/{thread_id}").status_code == 200

    def test_the_visibility_matrix(self):
        public = self._open(self.ece, "PUBLIC").json()["id"]
        dept = self._open(self.ece, "DEPARTMENT", "ECE").json()["id"]
        office = self._open(self.ece, "OFFICE").json()["id"]

        # Public: everybody.
        for who in (self.ece, self.mech, self.office):
            self.assertTrue(self._can_read(who, public), f"{who.name} on public")

        # Department: the department, and the office who moderate it.
        self.assertTrue(self._can_read(self.ece, dept))
        self.assertFalse(self._can_read(self.mech, dept), "another department must not see it")
        self.assertTrue(self._can_read(self.office, dept), "the office moderates, so it reads")

        # Office-only: the office, and whoever asked.
        self.assertTrue(self._can_read(self.office, office))
        self.assertTrue(
            self._can_read(self.ece, office),
            "the person who asked the office must be able to read their own thread",
        )
        self.assertFalse(self._can_read(self.mech, office), "a colleague must not see it")

    def test_a_thread_you_cannot_see_is_a_404_not_a_403(self):
        """A 403 confirms the thread exists, which is itself a leak."""
        office = self._open(self.ece, "OFFICE").json()["id"]
        self.client.force_login(self.mech)
        self.assertEqual(self.client.get(f"/api/threads/{office}").status_code, 404)

    def test_a_department_thread_can_only_be_opened_for_your_own(self):
        r = self._open(self.mech, "DEPARTMENT", "ECE")
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("MECH", r.json()["detail"])
        self.assertEqual(Thread.objects.count(), 0)

    def test_a_department_thread_needs_a_department(self):
        r = self._open(self.ece, "DEPARTMENT", None)
        self.assertEqual(r.status_code, 400, r.content)

    def test_the_list_only_offers_what_you_may_read(self):
        self._open(self.ece, "OFFICE", title="A private ask for the office")
        self._open(self.ece, "PUBLIC", title="An open question for everybody")
        self.client.force_login(self.mech)
        titles = {t["title"] for t in self.client.get("/api/threads").json()["results"]}
        self.assertIn("An open question for everybody", titles)
        self.assertNotIn("A private ask for the office", titles)


class ThreadPostTests(TestCase):
    """Posting, editing, deleting, locking, and who hears about it."""

    def setUp(self):
        self.a = User.objects.create_user(
            email="tp-a@test.edu", password="pass", name="Post Author",
            role=Role.FACULTY, department="CSE",
        )
        self.b = User.objects.create_user(
            email="tp-b@test.edu", password="pass", name="Post Reader",
            role=Role.FACULTY, department="CSE",
        )
        self.office = User.objects.create_user(
            email="tp-office@test.edu", password="pass", name="TP Office",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()
        self.client.force_login(self.a)
        self.thread_id = self.client.post(
            "/api/threads",
            data=json.dumps({"title": "A thread to post in", "body": "opening post"}),
            content_type="application/json",
        ).json()["id"]

    def test_a_mention_notifies_the_person_and_never_the_author(self):
        Notification.objects.all().delete()
        self.client.force_login(self.a)
        r = self.client.post(
            f"/api/threads/{self.thread_id}/posts",
            data=json.dumps({"body": "what do you think @tp-b?"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        told = set(Notification.objects.values_list("user__email", flat=True))
        self.assertIn("tp-b@test.edu", told)
        self.assertNotIn("tp-a@test.edu", told, "nobody is notified of their own post")

    def test_being_mentioned_subscribes_you(self):
        self.client.force_login(self.a)
        self.client.post(
            f"/api/threads/{self.thread_id}/posts",
            data=json.dumps({"body": "@tp-b have a look"}),
            content_type="application/json",
        )
        self.assertTrue(
            ThreadSubscription.objects.filter(thread_id=self.thread_id, user=self.b).exists()
        )

    def test_an_edit_rewrites_the_mentions(self):
        self.client.force_login(self.a)
        post_id = self.client.post(
            f"/api/threads/{self.thread_id}/posts",
            data=json.dumps({"body": "@tp-b look"}),
            content_type="application/json",
        ).json()["post"]["id"]
        self.assertEqual(Mention.objects.filter(post_id=post_id).count(), 1)

        r = self.client.patch(
            f"/api/posts/{post_id}",
            data=json.dumps({"body": "never mind"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        # The mention is part of the text; taking it out takes it out.
        self.assertEqual(Mention.objects.filter(post_id=post_id).count(), 0)
        self.assertIsNotNone(r.json()["edited_at"])

    def test_you_cannot_edit_somebody_else_s_post(self):
        self.client.force_login(self.a)
        post_id = self.client.post(
            f"/api/threads/{self.thread_id}/posts",
            data=json.dumps({"body": "mine"}),
            content_type="application/json",
        ).json()["post"]["id"]
        self.client.force_login(self.b)
        r = self.client.patch(
            f"/api/posts/{post_id}",
            data=json.dumps({"body": "not yours"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403, r.content)

    def test_a_deleted_post_leaves_a_tombstone(self):
        """Not removed: the replies underneath still have to make sense."""
        self.client.force_login(self.a)
        post_id = self.client.post(
            f"/api/threads/{self.thread_id}/posts",
            data=json.dumps({"body": "something regrettable"}),
            content_type="application/json",
        ).json()["post"]["id"]

        self.assertEqual(self.client.delete(f"/api/posts/{post_id}").status_code, 200)
        posts = self.client.get(f"/api/threads/{self.thread_id}").json()["posts"]
        gone = next(p for p in posts if p["id"] == post_id)
        self.assertTrue(gone["deleted"])
        self.assertEqual(gone["body"], "", "the text goes")
        self.assertIn(post_id, [p["id"] for p in posts], "the post stays in the thread")

    def test_the_office_can_lock_a_thread_and_it_stays_readable(self):
        self.client.force_login(self.office)
        self.assertEqual(
            self.client.post(f"/api/threads/{self.thread_id}/lock").status_code, 200
        )
        self.client.force_login(self.a)
        self.assertEqual(self.client.get(f"/api/threads/{self.thread_id}").status_code, 200)
        r = self.client.post(
            f"/api/threads/{self.thread_id}/posts",
            data=json.dumps({"body": "one more"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_only_the_office_locks(self):
        self.client.force_login(self.b)
        self.assertEqual(
            self.client.post(f"/api/threads/{self.thread_id}/lock").status_code, 403
        )


class ThreadAgentTests(TestCase):
    """The assistant. It works without a model, and it does not invent."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="ta-fac@test.edu", password="pass", name="TA Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.head = User.objects.create_user(
            email="ta-head@test.edu", password="pass", name="TA Head",
            role=Role.HOD, department="CSE",
        )
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            snip_multiplier=55000, qf_q1=50000,
        )
        # A journal we hold real reference data for.
        ScimagoJournal.objects.create(
            title="A Known Journal", issn="1234-5678", sjr=2.5, year=2025,
            categories_json=json.dumps([{"name": "Engineering", "quartile": "Q1"}]),
        )
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, ticket_number="TA-1",
            paper_title="A paper in a known journal",
            journal_title="A Known Journal", issn="1234-5678",
            quartile="Q1", remuneration=90000.0, publication_year=2025,
        )
        self.client = Client()

    def _ask(self, actor, body):
        self.client.force_login(actor)
        r = self.client.post(
            "/api/threads",
            data=json.dumps({"title": "Asking the assistant something", "body": body}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        posts = self.client.get(f"/api/threads/{r.json()['id']}").json()["posts"]
        agent = [p for p in posts if p["kind"] == "AGENT"]
        return agent[0]["body"] if agent else None

    def test_it_answers_a_journal_with_what_we_actually_hold(self):
        said = self._ask(self.faculty, '@agent @journal:"A Known Journal"')
        self.assertIsNotNone(said, "the assistant did not answer")
        self.assertIn("A Known Journal", said)
        self.assertIn("Q1", said)

    def test_it_refuses_to_price_a_journal_it_does_not_know(self):
        """The property that stops it being confidently wrong about a venue."""
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, ticket_number="TA-2",
            paper_title="A paper somewhere unknown",
            journal_title="A Journal Nobody Has Heard Of", issn="9999-9999",
        )
        said = self._ask(self.faculty, '@agent @journal:"A Journal Nobody Has Heard Of"')
        self.assertIsNotNone(said)
        self.assertIn("no SCImago or SNIP record", said)
        # No figure, of any size, anywhere in the answer.
        self.assertNotIn("₹", said)

    def test_it_shows_a_head_of_department_no_money(self):
        said = self._ask(self.head, '@agent @journal:"A Known Journal"')
        self.assertIsNotNone(said)
        self.assertIn("Q1", said, "the academic standing is still their business")
        self.assertNotIn("₹", said, "a head sees no amount, here as anywhere else")

    def test_it_answers_with_help_when_asked_for_nothing(self):
        said = self._ask(self.faculty, "@agent")
        self.assertIsNotNone(said)
        self.assertIn("look things up", said)

    def test_it_says_nothing_when_it_was_not_asked(self):
        said = self._ask(self.faculty, "just talking among ourselves here")
        self.assertIsNone(said, "the assistant must not join a conversation uninvited")

    def test_a_failing_assistant_does_not_lose_the_post(self):
        """The message is already written; only the reply did not happen."""
        with patch("core.services.thread_agent.answer", side_effect=RuntimeError("down")):
            self.client.force_login(self.faculty)
            r = self.client.post(
                "/api/threads",
                data=json.dumps({"title": "A thread while it is broken", "body": "@agent hello"}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 200, r.content)
            posts = self.client.get(f"/api/threads/{r.json()['id']}").json()["posts"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0]["body"], "@agent hello")


class ThreadAgentModelTests(TestCase):
    """The local model as a fallback, never as a substitute for a row we hold.

    Every one of these stubs `ai.ask_json`. The suite must pass on a machine
    with no daemon running, and a test that quietly takes thirty seconds when
    one happens to be up is a test people learn to skip.
    """

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="tam-fac@test.edu", password="pass", name="TAM Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.head = User.objects.create_user(
            email="tam-head@test.edu", password="pass", name="TAM Head",
            role=Role.HOD, department="CSE",
        )
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            snip_multiplier=55000, qf_q1=50000,
        )
        ScimagoJournal.objects.create(
            title="Applied Soft Computing", issn="1568-4946", sjr=2.5, year=2025,
            categories_json=json.dumps([{"category": "Software", "quartile": "Q1"}]),
        )
        SnipSource.objects.create(
            title="Applied Soft Computing", print_issn="1568-4946",
            snip=1.8, year=2025,
        )
        Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, ticket_number="TAM-1",
            paper_title="Scheduling under uncertainty",
            journal_title="Applied Soft Computing", issn="1568-4946",
            quartile="Q1", remuneration=90000.0, publication_year=2025,
        )
        self.client = Client()

    # -- helpers ---------------------------------------------------------- #

    def _open(self, actor, body, title="Asking the assistant something"):
        self.client.force_login(actor)
        r = self.client.post(
            "/api/threads",
            data=json.dumps({"title": title, "body": body}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["id"]

    def _posts(self, thread_id, actor):
        self.client.force_login(actor)
        return self.client.get(f"/api/threads/{thread_id}").json()["posts"]

    def _agent_body(self, thread_id, actor):
        said = [p for p in self._posts(thread_id, actor) if p["kind"] == "AGENT"]
        return said[-1]["body"] if said else None

    def _ask(self, actor, body):
        return self._agent_body(self._open(actor, body), actor)

    def _reply(self, thread_id, actor, body):
        self.client.force_login(actor)
        r = self.client.post(
            f"/api/threads/{thread_id}/posts",
            data=json.dumps({"body": body}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        return self._agent_body(thread_id, actor)

    def _answers(self, answer, journals=None):
        return patch.object(
            ai, "ask_json", return_value={"answer": answer, "journals": journals or []}
        )

    # -- the lookups still come first ------------------------------------- #

    def test_a_fact_we_hold_is_answered_without_asking_the_model(self):
        """The whole point of the ordering: instant, exact, and no inference."""
        with _model_ready(), patch.object(ai, "ask_json") as asked:
            said = self._ask(self.faculty, '@agent @journal:"Applied Soft Computing"')
        asked.assert_not_called()
        self.assertIn("Applied Soft Computing", said)
        self.assertIn("Q1", said)

    def test_a_literature_search_still_goes_to_the_keyless_sources(self):
        with _model_ready(), patch.object(ai, "ask_json") as asked, patch.object(
            rs, "search", return_value={"results": [], "failed": []}
        ) as searched:
            said = self._ask(self.faculty, "@agent find recent work on federated learning")
        asked.assert_not_called()
        searched.assert_called_once()
        self.assertIn("Nothing came back", said)

    # -- and the model answers what they cannot --------------------------- #

    def test_an_open_question_reaches_the_model_and_is_grounded(self):
        with _model_ready(), self._answers(
            "That direction builds on the scheduling work you have already published."
        ) as asked:
            said = self._ask(
                self.faculty,
                "@agent would that venue suit the direction I have been working in?",
            )
        asked.assert_called_once()
        self.assertIn("builds on the scheduling work", said)
        # It is honest about where the sentence came from and how long it took.
        self.assertIn("model on this machine", said)
        # And it was told what this person has actually published.
        prompt = asked.call_args.args[0]
        self.assertIn("Scheduling under uncertainty", prompt)

    def test_a_question_beside_a_mention_gets_the_facts_and_then_the_model(self):
        with _model_ready(), self._answers("It is a reasonable fit for that kind of work.") as asked:
            said = self._ask(
                self.faculty,
                '@agent @journal:"Applied Soft Computing" is that a sensible home for my work?',
            )
        asked.assert_called_once()
        self.assertIn("Q1", said, "the looked-up standing is still printed")
        self.assertIn("reasonable fit", said)

    # -- the model proposes, the database disposes ------------------------ #

    def test_a_journal_the_model_invented_is_dropped(self):
        with _model_ready(), self._answers(
            "Two venues take work of this kind.",
            ["Applied Soft Computing", "International Journal of Entirely Fictional Results"],
        ):
            said = self._ask(
                self.faculty, "@agent where might this line of work reasonably go?"
            )
        self.assertIn("Applied Soft Computing", said)
        self.assertIn("Q1", said, "a resolved journal carries our own numbers")
        self.assertNotIn("Entirely Fictional", said)

    def test_a_quartile_asserted_by_the_model_is_thrown_away(self):
        """A number in the house style is worse than a guess in plain words."""
        with _model_ready(), self._answers(
            "That journal is Q1 with a SNIP of 4.2. It suits applied work."
        ):
            said = self._ask(
                self.faculty, "@agent how well regarded is that venue in practice?"
            )
        self.assertIn("It suits applied work", said)
        self.assertNotIn("4.2", said)

    # -- money-blindness -------------------------------------------------- #

    def test_a_head_of_department_gets_no_amount_out_of_the_model(self):
        with _model_ready(), self._answers(
            "A paper there is worth about ₹2,00,000 to you. Beyond that I cannot say.",
            ["Applied Soft Computing"],
        ):
            said = self._ask(
                self.head,
                "@agent what would a paper in that journal be worth to my department?",
            )
        self.assertIsNotNone(said)
        self.assertNotIn("₹", said, "a head sees no amount, here as anywhere else")
        self.assertNotIn("2,00,000", said)
        self.assertIn("Beyond that I cannot say", said, "the founded half survives")
        self.assertIn("Q1", said, "academic standing is still their business")

    def test_the_model_may_not_price_anything_for_anybody(self):
        with _model_ready(), self._answers("Expect roughly 1.5 lakh for that. It is a strong venue."):
            said = self._ask(
                self.faculty, "@agent is that venue worth the effort for someone at my stage?"
            )
        self.assertNotIn("lakh", said)
        self.assertIn("It is a strong venue", said)

    def test_no_rupee_figure_from_the_thread_ever_reaches_the_prompt(self):
        thread_id = self._open(
            self.faculty, "we were paid ₹90,000 for that one last year", title="Money talk"
        )
        with _model_ready(), self._answers("I would judge it on scope rather than on that.") as asked:
            said = self._reply(
                thread_id, self.head, "@agent should the department push for that venue?"
            )
        self.assertIsNotNone(said)
        prompt = asked.call_args.args[0]
        self.assertNotIn("₹", prompt)
        self.assertNotIn("90,000", prompt)
        self.assertIn("[amount withheld]", prompt)

    # -- when there is no model ------------------------------------------- #

    def test_no_model_means_a_keyless_answer_and_a_recorded_reason(self):
        from core.services import thread_agent

        with _model_unavailable(), patch.object(ai, "ask_json") as asked, patch.object(
            rs, "search", return_value={"results": [], "failed": []}
        ) as searched:
            said = self._ask(
                self.faculty, "@agent would that venue suit the direction I am heading in?"
            )
        asked.assert_not_called()
        searched.assert_called_once()
        self.assertIsNotNone(said, "an absent model must not silence the assistant")
        self.assertEqual(thread_agent.last_model_error()["reason"], "unavailable")
        self.assertEqual(thread_agent.last_model_error()["code"], "service_down")

    def test_a_refused_call_is_silent_to_the_reader_and_loud_in_the_log(self):
        from core.services import thread_agent

        with _model_ready(), patch.object(
            ai, "ask_json", side_effect=ai.AIError("too slow", code="timeout")
        ), patch.object(rs, "search", return_value={"results": [], "failed": []}):
            said = self._ask(
                self.faculty, "@agent would that venue suit the direction I am heading in?"
            )
        self.assertIsNotNone(said)
        self.assertNotIn("too slow", said, "the reader is not shown the plumbing")
        self.assertEqual(thread_agent.last_model_error()["code"], "timeout")

    def test_a_model_that_explodes_never_eats_the_human_post(self):
        thread_id = self._open(self.faculty, "opening this one", title="Still standing")
        with _model_ready(), patch.object(
            ai, "ask_json", side_effect=RuntimeError("boom")
        ), patch.object(rs, "search", side_effect=RuntimeError("also down")):
            self.client.force_login(self.faculty)
            r = self.client.post(
                f"/api/threads/{thread_id}/posts",
                data=json.dumps({"body": "@agent what should I be reading right now?"}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 200, r.content)
        bodies = [p["body"] for p in self._posts(thread_id, self.faculty)]
        self.assertIn("@agent what should I be reading right now?", bodies)


class MentionResolutionTests(TestCase):
    """An @name points at a record, or at nothing at all."""

    def setUp(self):
        self.person = User.objects.create_user(
            email="mr-person@test.edu", password="pass", name="Unique Person",
            role=Role.FACULTY, department="CSE", staff_id="STF-MR1",
        )
        self.claim = Claim.objects.create(
            owner=self.person, status=ClaimStatus.PAID, ticket_number="MR-0001",
            paper_title="A mentionable paper", journal_title="Mentionable Journal",
        )

    def test_it_resolves_people_papers_departments_and_journals(self):
        from core.discussions import parse_mentions

        found = {m["kind"]: m for m in parse_mentions(
            '@mr-person and @paper:MR-0001 and @dept:CSE and @journal:"Mentionable Journal"'
        )}
        self.assertEqual(found["USER"]["user"].id, self.person.id)
        self.assertEqual(found["PAPER"]["claim"].id, self.claim.id)
        self.assertEqual(found["DEPARTMENT"]["department"], "CSE")
        self.assertEqual(found["JOURNAL"]["journal_title"], "Mentionable Journal")

    def test_an_unresolved_mention_is_dropped_rather_than_stored(self):
        from core.discussions import parse_mentions

        self.assertEqual(parse_mentions("hello @nobody-at-all-here"), [])

    def test_an_ambiguous_name_resolves_to_nobody(self):
        """Two people called the same thing is normal; guessing is not."""
        from core.discussions import parse_mentions

        for i in (1, 2):
            User.objects.create_user(
                email=f"mr-dup{i}@test.edu", password="pass", name="R Kumar",
                role=Role.FACULTY,
            )
        self.assertEqual(parse_mentions('@user:"R Kumar"'), [])

    def test_the_autocomplete_does_not_leak_other_people_s_papers(self):
        from core.discussions import mention_candidates

        stranger = User.objects.create_user(
            email="mr-stranger@test.edu", password="pass", name="A Stranger",
            role=Role.FACULTY, department="ECE",
        )
        tickets = [
            c["label"] for c in mention_candidates(stranger, "MR-0001", "PAPER")
        ]
        self.assertEqual(tickets, [], "a claimant must not be able to enumerate tickets")
        mine = [c["label"] for c in mention_candidates(self.person, "MR-0001", "PAPER")]
        self.assertIn("MR-0001", mine)


class CalendarTests(TestCase):
    """Dates, which nothing in this system held until now."""

    def setUp(self):
        self.office = User.objects.create_user(
            email="cal-office@test.edu", password="pass", name="Cal Office",
            role=Role.SUPER_ADMIN,
        )
        self.faculty = User.objects.create_user(
            email="cal-fac@test.edu", password="pass", name="Cal Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def _add(self, actor, **kw):
        self.client.force_login(actor)
        payload = {
            "title": "An event", "kind": "DEADLINE",
            "starts_on": "2026-09-01", "visibility": "PUBLIC",
        }
        payload.update(kw)
        return self.client.post(
            "/api/calendar", data=json.dumps(payload), content_type="application/json"
        )

    def test_an_event_is_found_by_a_window_that_overlaps_it(self):
        """A span is not just its first day."""
        self._add(self.office, title="A submission window", kind="SUBMISSION_WINDOW",
                  starts_on="2026-09-01", ends_on="2026-11-30")
        self.client.force_login(self.faculty)
        # A window entirely inside the event, touching neither end.
        found = self.client.get("/api/calendar?start=2026-10-01&end=2026-10-15").json()
        self.assertEqual(len(found["results"]), 1, found)

    def test_it_cannot_end_before_it_starts(self):
        r = self._add(self.office, starts_on="2026-09-10", ends_on="2026-09-01")
        self.assertEqual(r.status_code, 400, r.content)

    def test_an_event_follows_the_same_visibility_rule_as_a_thread(self):
        self._add(self.faculty, title="A CSE-only date", visibility="DEPARTMENT",
                  department="CSE")
        other = User.objects.create_user(
            email="cal-other@test.edu", password="pass", name="Other Dept",
            role=Role.FACULTY, department="MECH",
        )
        self.client.force_login(other)
        titles = {
            e["title"] for e in
            self.client.get("/api/calendar?start=2026-01-01&end=2027-01-01").json()["results"]
        }
        self.assertNotIn("A CSE-only date", titles)

    def test_an_event_from_a_thread_is_recorded_in_it(self):
        """The decision and the date must not live in two places that disagree."""
        self.client.force_login(self.office)
        thread_id = self.client.post(
            "/api/threads",
            data=json.dumps({"title": "When shall we submit this", "body": "opening"}),
            content_type="application/json",
        ).json()["id"]

        r = self._add(self.office, title="Submit by then", thread_id=thread_id)
        self.assertEqual(r.status_code, 200, r.content)

        posts = self.client.get(f"/api/threads/{thread_id}").json()["posts"]
        system = [p for p in posts if p["kind"] == "SYSTEM"]
        self.assertEqual(len(system), 1)
        self.assertIn("Submit by then", system[0]["body"])

    def test_somebody_else_s_event_is_not_yours_to_delete(self):
        event_id = self._add(self.office).json()["id"]
        self.client.force_login(self.faculty)
        self.assertEqual(self.client.delete(f"/api/calendar/{event_id}").status_code, 403)


class ResearchQuotaTests(TestCase):
    """Research faculty are paid only for what exceeds their quota.

    They are already paid to do research, so the scheme rewards the surplus
    rather than the expectation: papers up to the quota carry no remuneration
    and only the ones beyond it are reimbursed.
    """

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            snip_multiplier=55000, qf_q1=50000,
        )
        self.researcher = User.objects.create_user(
            email="rq-res@test.edu", password="pass", name="Research Faculty",
            role=Role.FACULTY, department="CSE",
            faculty_type="RESEARCH", research_quota=2,
        )
        self.regular = User.objects.create_user(
            email="rq-reg@test.edu", password="pass", name="Regular Faculty",
            role=Role.FACULTY, department="CSE",
        )

    def _paper(self, owner, ticket, year=2026):
        claim = Claim.objects.create(
            owner=owner, status=ClaimStatus.SUBMITTED, ticket_number=ticket,
            paper_title=f"Quota {ticket}", publication_year=year,
            quartile="Q1", quartile_source="SCIMAGO", snip=1.0, snip_source="SCOPUS",
            total_authors=1, author_position=1, indexing_level="Scopus",
            publication_type="Journal", engineering_class="Engineering",
        )
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'q' * 31}{n[-1]}.pdf", ref_number=n,
            )
        # Mirrors `_submit_claim`: the paper takes its slot in the year, then
        # the amount is worked out. Pricing without assigning first was how the
        # original bug hid — every paper computed as "paper 1" and paid nothing,
        # and a test that skipped this step never saw it.
        api_module._assign_quota_position(claim)
        api_module._apply_calc(claim)
        claim.save()
        return claim

    def _in_order(self, claims):
        """Filing order, which is what `quota_position` records.

        This used to sort on `(created_at, id)` — the very key the production
        code was changed away from, because `auto_now_add` reads a clock
        coarser than the loop and the id is a random uuid. So the test agreed
        with the code only when the uuids happened to fall the right way, and
        the full suite eventually dealt a run where they did not.
        """
        return sorted(claims, key=lambda c: (c.quota_position or 0, c.id))

    def test_papers_inside_the_quota_pay_nothing_and_the_surplus_pays_in_full(self):
        made = self._in_order([self._paper(self.researcher, f"RQ-{i}") for i in range(4)])
        amounts = [c.remuneration for c in made]
        self.assertEqual(amounts[:2], [0.0, 0.0], "the quota carries no remuneration")
        self.assertTrue(all(a and a > 0 for a in amounts[2:]), f"the surplus is paid: {amounts}")

    def test_the_ticket_still_shows_what_the_paper_was_worth(self):
        """Zeroed, not unpriced. A paper that looks unpriceable reads as a bug."""
        first = self._in_order([self._paper(self.researcher, f"RQ-W{i}") for i in range(2)])[0]
        self.assertEqual(first.remuneration, 0.0)
        self.assertTrue(first.quota_applied)
        self.assertIn("quota", (first.quota_note or "").lower())
        # The working the policy did is still on the ticket.
        self.assertIsNotNone(first.base_amount)
        self.assertIsNotNone(first.author_point)

    def test_a_regular_faculty_member_is_untouched(self):
        made = self._in_order([self._paper(self.regular, f"RG-{i}") for i in range(3)])
        for claim in made:
            self.assertFalse(claim.quota_applied)
            self.assertTrue(claim.remuneration and claim.remuneration > 0)

    def test_the_quota_is_counted_per_year(self):
        """Last year's output does not spend this year's quota.

        Three papers in 2025 already exceed a quota of two. If the years ran
        together the first 2026 paper would be the fourth and be paid; because
        they do not, it is the first of a fresh two and carries none.
        """
        self._in_order([self._paper(self.researcher, f"RY-{i}", year=2025) for i in range(3)])
        fresh = self._paper(self.researcher, "RY-NEW", year=2026)
        self.assertTrue(fresh.quota_applied, "a new year starts the quota again")
        self.assertEqual(fresh.quota_position, 1)
        self.assertIn("Paper 1 of a 2-paper", fresh.quota_note)

    def test_research_faculty_with_no_quota_set_are_paid_normally(self):
        self.researcher.research_quota = None
        self.researcher.save()
        claim = self._paper(self.researcher, "RQ-NONE")
        self.assertFalse(claim.quota_applied)
        self.assertTrue(claim.remuneration and claim.remuneration > 0)

    def test_a_count_only_paper_does_not_spend_the_quota(self):
        """It asks for no money, so it cannot use up the allowance for money."""
        for i in range(3):
            c = self._paper(self.researcher, f"RC-{i}")
            c.claim_reason = ClaimReason.COUNT_ONLY
            c.save()
        after = self._paper(self.researcher, "RC-PAID")
        self.assertFalse(after.quota_applied)

    def test_the_order_is_total_so_two_papers_never_share_a_position(self):
        """`auto_now_add` reads a clock coarser than a loop, so several claims
        share a timestamp to the microsecond. On `created_at` alone every one
        of them counts the same number before it -- and at the quota boundary
        that decides whether a paper pays nothing or pays in full."""
        made = [self._paper(self.researcher, f"RT-{i}") for i in range(5)]
        inside = [c for c in made if c.quota_applied]
        self.assertEqual(len(inside), 2, "exactly the quota falls inside it")
        # And they are the first two filed, not whichever drew a low uuid.
        self.assertEqual([c.ticket_number for c in inside], ["RT-0", "RT-1"])
        self.assertEqual([c.quota_position for c in made], [1, 2, 3, 4, 5])


class ResearchQuotaSlotTests(TestCase):
    """Handing out, keeping and reading a research-quota slot.

    The number itself is `ResearchQuotaTests` above. This is the column's
    plumbing: that two submits landing together cannot lose one, that a paper
    whose year is corrected takes a place in the new year rather than sitting
    in it unnumbered, and what the stored number is allowed to mean.
    """

    def setUp(self):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            snip_multiplier=55000, qf_q1=50000,
        )
        self.researcher = User.objects.create_user(
            email="rqs-res@test.edu", password="pass", name="Research Faculty",
            role=Role.FACULTY, department="CSE",
            faculty_type="RESEARCH", research_quota=2,
        )
        self.cell = User.objects.create_user(
            email="rqs-cell@test.edu", password="pass", name="Cell",
            role=Role.RESEARCH_CELL,
        )
        self.client = Client()

    def _paper(self, ticket, year=2026, **extra):
        base = dict(
            owner=self.researcher, status=ClaimStatus.SUBMITTED, ticket_number=ticket,
            paper_title=f"Slot {ticket}", publication_year=year,
            quartile="Q1", quartile_source="SCIMAGO", snip=1.0, snip_source="SCOPUS",
            total_authors=1, author_position=1, indexing_level="Scopus",
            publication_type="Journal", engineering_class="Engineering",
        )
        base.update(extra)
        return Claim.objects.create(**base)

    # ---- 1. two submits in the same instant ------------------------------

    def test_a_slot_lost_to_a_concurrent_submit_is_taken_again(self):
        """MAX + 1 is read in one statement and written in another, so two
        submits for one author and year can be handed the same number. The
        unique constraint now refuses the second write, which is the better of
        the two failures and still a failure: the claimant got a 500 and their
        submission did not happen. Retry under the bucket lock instead.

        Simulated rather than threaded -- the suite runs on SQLite, where the
        lock is a no-op and two real connections cannot interleave. What is
        exercised is the thing the constraint actually does to this code path:
        raise IntegrityError out of the save.
        """
        from django.db import IntegrityError

        claim = self._paper("SLOT-RACE")
        collided = {"once": False}
        real_save = Claim.save

        def save_that_loses_the_first_race(inner, *args, **kwargs):
            if inner.pk == claim.pk and not collided["once"]:
                collided["once"] = True
                raise IntegrityError("uniq_claim_quota_slot_per_owner_year")
            return real_save(inner, *args, **kwargs)

        with patch.object(Claim, "save", save_that_loses_the_first_race):
            api_module._assign_quota_position(claim)

        self.assertTrue(collided["once"], "the collision was never reached")
        claim.refresh_from_db()
        self.assertEqual(claim.quota_position, 1, "the slot has to end up stored")

    def test_the_position_is_written_not_left_on_the_instance(self):
        """A number the constraint has not seen is a number nothing protects."""
        claim = self._paper("SLOT-WRITE")
        api_module._assign_quota_position(claim)
        self.assertEqual(
            Claim.objects.values_list("quota_position", flat=True).get(pk=claim.pk), 1
        )

    def test_a_second_paper_takes_the_next_slot(self):
        first = self._paper("SLOT-A")
        api_module._assign_quota_position(first)
        second = self._paper("SLOT-B")
        api_module._assign_quota_position(second)
        self.assertEqual([first.quota_position, second.quota_position], [1, 2])

    # ---- 2. a corrected year ---------------------------------------------

    def test_correcting_the_year_moves_the_paper_into_the_new_year_s_sequence(self):
        """`Claim.save` drops the slot when the year changes, because a slot
        belongs to the year that issued it. Nothing then gave the paper one in
        its new year: `_assign_quota_position` runs at submission and this
        paper was submitted long ago, so it sat in 2025 unnumbered -- counting
        against nobody's quota and spending none of it."""
        existing = self._paper("SLOT-2025", year=2025)
        api_module._assign_quota_position(existing)
        moving = self._paper("SLOT-MOVED", year=2026)
        api_module._assign_quota_position(moving)
        self.assertEqual(moving.quota_position, 1)

        self.client.force_login(self.cell)
        r = self.client.patch(
            f"/api/reports/pack/rows/{moving.id}",
            data=json.dumps({
                "field": "publication_year", "value": "2025",
                "reason": "Published online in 2025, not 2026.",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

        moving.refresh_from_db()
        self.assertEqual(moving.publication_year, 2025)
        self.assertIsNotNone(
            moving.quota_position, "a filed paper cannot sit in a year unnumbered"
        )
        self.assertEqual(moving.quota_position, 2, "behind the paper already in 2025")

    def test_correcting_something_else_leaves_the_slot_alone(self):
        claim = self._paper("SLOT-TITLE")
        api_module._assign_quota_position(claim)
        self.client.force_login(self.cell)
        r = self.client.patch(
            f"/api/reports/pack/rows/{claim.id}",
            data=json.dumps({
                "field": "paper_title", "value": "A Better Title",
                "reason": "The publisher corrected the title.",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.quota_position, 1)

    def test_a_correction_re_takes_a_slot_and_never_hands_out_a_first_one(self):
        """Every paper filed before the quota column existed has no position,
        which is all of them today. A year corrected on one of those must not
        be the moment it starts spending somebody's allowance -- the slot is
        handed out at filing, and this only replaces one the correction
        dropped."""
        legacy = self._paper("SLOT-LEGACY")
        self.assertIsNone(legacy.quota_position)

        self.client.force_login(self.cell)
        r = self.client.patch(
            f"/api/reports/pack/rows/{legacy.id}",
            data=json.dumps({
                "field": "publication_year", "value": "2025",
                "reason": "Corrected against the publisher's page.",
            }),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        legacy.refresh_from_db()
        self.assertEqual(legacy.publication_year, 2025)
        self.assertIsNone(
            legacy.quota_position, "a correction is not a filing"
        )

    # ---- 3. what the stored number is allowed to mean ---------------------

    def test_a_gap_protecting_a_paid_paper_is_read_as_it_stands(self):
        """The one bucket where the stored position and the paper's rank in
        its year disagree, and the reason `_quota_state` reads the number
        rather than ranking.

        `Claim._close_quota_gap` refuses to renumber a year when a paper that
        would move down has already been paid, because moving it down moves it
        from outside the quota to inside it and claws back money that has gone
        out. Ranking in `_quota_state` would do exactly that, one layer later:
        the paid paper would be counted as the year's second and zeroed.
        """
        first = self._paper("GAP-1")
        api_module._assign_quota_position(first)
        second = self._paper("GAP-2")
        api_module._assign_quota_position(second)
        third = self._paper("GAP-3", status=ClaimStatus.PAID)
        api_module._assign_quota_position(third)
        self.assertEqual(
            [first.quota_position, second.quota_position, third.quota_position],
            [1, 2, 3],
        )
        third.paid_at = timezone.now()
        third.save(update_fields=["paid_at"])

        # The middle paper leaves the year. Renumbering would pull the paid
        # paper from 3 to 2, so the model leaves the gap open on purpose.
        second.delete()
        third.refresh_from_db()
        self.assertEqual(third.quota_position, 3, "the gap is deliberate")

        inside, why = api_module._quota_state(third)
        self.assertFalse(
            inside,
            "ranking would call this the year's second paper and zero money "
            "that has already been paid",
        )
        self.assertIn("beyond the 2-paper research quota", why)

    def test_an_unbroken_sequence_reads_the_same_either_way(self):
        """Which is the rest of the time, and why the rank query would buy
        nothing: the sequence is kept hole-free everywhere else."""
        made = [self._paper(f"RANK-{i}") for i in range(4)]
        for claim in made:
            api_module._assign_quota_position(claim)
        for n, claim in enumerate(made, start=1):
            rank = (
                Claim.objects.filter(
                    owner=self.researcher, publication_year=claim.publication_year,
                    quota_position__lt=claim.quota_position,
                ).count()
                + 1
            )
            self.assertEqual(claim.quota_position, n)
            self.assertEqual(rank, claim.quota_position)


class SearchRouteTests(TestCase):
    """`GET /api/search` exists, and lets a head of department through.

    `core.services.search` was finished, tested and reachable from every
    role's sidebar, and no route was ever registered for it -- so the page
    shipped and every query came back 404. `routes.spec.ts` could not catch
    it: with an empty box the page shows its prompt and looks perfectly well.

    These ask two things of the wiring. That it is there, and that its guard
    is `require_user` rather than `_require_may_see_money` -- the helper that
    refuses a head outright, which is correct on `/prior/check` and
    `/discover/venues` because those exist to hand over a figure, and would
    take the search box away from the one role most likely to use it daily.
    Blindness belongs inside the package, where the amount key is left out
    rather than zeroed; `core.test_search` is where that is proved in depth.

    `kinds=people` is the query used throughout, because it is the one scope
    that asks nothing outside this machine: no Crossref, no OpenAlex, no
    Scopus, so no test here depends on a vendor being up.
    """

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="sr-fac@test.edu", password="pass", name="Search Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.cell = User.objects.create_user(
            email="sr-cell@test.edu", password="pass", name="Search Cell",
            role=Role.RESEARCH_CELL,
        )
        self.hod = User.objects.create_user(
            email="sr-hod@test.edu", password="pass", name="Search Head",
            role=Role.HOD, department="CSE",
        )
        self.claim = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID,
            ticket_number="FP-2026-SEARCH", paper_title="Thermal Runaway In Packed Beds",
            normalized_title=normalize_title("Thermal Runaway In Packed Beds"),
            journal_title="Journal of Testing", publication_year=2026,
            remuneration=44000.0,
        )
        self.client = Client()

    def _search(self, **params):
        params.setdefault("kinds", "people")
        return self.client.get("/api/search", params)

    def test_the_route_is_registered_at_all(self):
        """The whole defect: this used to be a 404 for every role."""
        self.client.force_login(self.faculty)
        r = self._search(q="Thermal Runaway")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["query"], "Thermal Runaway")

    def test_it_finds_a_claim_this_college_has_filed_and_prices_it(self):
        self.client.force_login(self.cell)
        r = self._search(q="Thermal Runaway In Packed Beds")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        titles = [t["paper_title"] for t in body["tickets"]]
        self.assertIn("Thermal Runaway In Packed Beds", titles)
        self.assertTrue(body["money_visible"])
        self.assertEqual(body["tickets"][0]["amount"], 44000.0)

    def test_a_head_of_department_is_not_locked_out_of_the_search_box(self):
        """The guard that would have been the obvious one to reach for.

        `_require_may_see_money` 403s a head, and using it here would have
        looked like tightening the endpoint. It would have removed the second
        item in their own sidebar. A head may look a paper up; they are only
        not to be told what it paid.
        """
        self.client.force_login(self.hod)
        r = self._search(q="Thermal Runaway In Packed Beds")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        titles = [t["paper_title"] for t in body["tickets"]]
        self.assertIn(
            "Thermal Runaway In Packed Beds", titles,
            "a head of department could not find a filed claim by its title",
        )
        self.assertFalse(body["money_visible"])
        for ticket in body["tickets"]:
            self.assertNotIn("amount", ticket, "the key is left out, not zeroed")
        self.assertNotIn("44000", r.content.decode())

    def test_signed_out_it_answers_nothing(self):
        r = self._search(q="Thermal Runaway")
        self.assertIn(r.status_code, (401, 403), r.content)

    def test_a_query_too_short_to_ask_is_answered_not_refused(self):
        """A keystroke must not render as an error."""
        self.client.force_login(self.faculty)
        r = self._search(q="a")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["tickets"], [])

    def test_the_kinds_and_limit_the_client_sends_reach_the_engine(self):
        """The parameters are what make the page's filters work, and a route
        that dropped them would still return a plausible-looking answer."""
        from unittest.mock import ANY

        self.client.force_login(self.faculty)
        with patch_api("run_search", return_value={"ok": True}) as ran:
            r = self.client.get(
                "/api/search",
                {"q": "graphene", "kinds": "venues, people", "limit": "3",
                 "field": "Chemistry", "quartile": "Q1", "doi": "10.1/x"},
            )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"ok": True})
        ran.assert_called_once_with(
            "graphene", viewer=ANY, kinds=["venues", "people"], limit=3,
            field="Chemistry", quartile="Q1", doi="10.1/x",
        )

    def test_an_empty_kinds_string_searches_everything(self):
        """Rather than searching nothing, which is what a bare split gives."""
        from unittest.mock import ANY

        self.client.force_login(self.faculty)
        with patch_api("run_search", return_value={"ok": True}) as ran:
            self.client.get("/api/search", {"q": "graphene", "kinds": ""})
        self.assertEqual(
            ran.call_args.kwargs["kinds"], list(__import__("core.services.search", fromlist=["KINDS"]).KINDS)
        )


class StudentProjectTeamTests(TestCase):
    """The team behind a student project claim."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="tm-fac@test.edu", password="pass", name="Team Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def _make(self, **kw):
        payload = {
            "code": "CSE-2026-001",
            "title": "A student project",
            "members": [{"name": "S Priya", "register_number": "21CS101"}],
        }
        payload.update(kw)
        return self.client.post(
            "/api/teams", data=json.dumps(payload), content_type="application/json"
        )

    def test_an_unknown_code_is_an_ordinary_404(self):
        """The form uses it to choose between confirming and asking."""
        self.assertEqual(self.client.get("/api/teams/NOT-A-TEAM").status_code, 404)

    def test_a_team_is_created_then_found_by_its_code_whatever_the_case(self):
        self.assertEqual(self._make().status_code, 200)
        found = self.client.get("/api/teams/cse-2026-001")
        self.assertEqual(found.status_code, 200)
        self.assertEqual(found.json()["code"], "CSE-2026-001")

    def test_filing_the_same_code_again_updates_rather_than_duplicates(self):
        self.assertTrue(self._make().json()["created"])
        again = self._make(members=[
            {"name": "S Priya", "register_number": "21CS101"},
            {"name": "R Karthik", "register_number": "21CS102"},
        ])
        self.assertFalse(again.json()["created"])
        self.assertEqual(Team.objects.count(), 1)
        self.assertEqual(len(again.json()["members"]), 2)

    def test_removing_somebody_from_the_team_removes_them(self):
        self._make(members=[{"name": "A"}, {"name": "B"}])
        after = self._make(members=[{"name": "A"}])
        self.assertEqual([m["name"] for m in after.json()["members"]], ["A"])

    def test_each_student_keeps_their_own_mentor_and_falls_back_to_the_team_s(self):
        r = self._make(
            mentor_name="Dr. Team Mentor",
            members=[
                {"name": "Has own", "mentor_name": "Dr. Their Own"},
                {"name": "Has none"},
            ],
        )
        mentors = {m["name"]: m["mentor_name"] for m in r.json()["members"]}
        self.assertEqual(mentors["Has own"], "Dr. Their Own")
        self.assertEqual(mentors["Has none"], "Dr. Team Mentor")

    def test_a_team_needs_at_least_one_student(self):
        self.assertEqual(self._make(members=[]).status_code, 400)

    def test_student_project_is_a_reason_a_claim_can_carry(self):
        self.assertIn("STUDENT_PROJECT", ClaimReason.values)


class CreateAccountWithoutAPasswordTests(TestCase):
    """An account can be put on the roster without one being chosen for it.

    A password picked on somebody else's behalf and typed into a form has been
    read by whoever typed it and is usually still in their sent items, and
    these accounts decide who gets paid. So the field is optional, and left
    out the account gets no usable password at all rather than a guessable
    one -- with two honest ways in from there: an admin sets one through the
    reset flow and hands it over, or the person signs in with Google, which
    never consults the password field.
    """

    def setUp(self):
        self.admin = User.objects.create_user(
            email="ca-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def create(self, **extra):
        body = {"email": "new-person@test.edu", "name": "New Person", **extra}
        return self.client.post(
            "/api/admin/users", data=json.dumps(body), content_type="application/json"
        )

    def test_an_account_is_created_with_no_usable_password(self):
        res = self.create()
        self.assertEqual(res.status_code, 200, res.content[:300])
        self.assertTrue(res.json()["needs_password"])
        u = User.objects.get(email="new-person@test.edu")
        self.assertFalse(u.has_usable_password())

    def test_it_cannot_be_signed_into_until_a_password_is_set(self):
        """The point of an unusable password: no input matches it, including
        the empty string, which is the way this goes wrong if it is stored as
        an ordinary hash of nothing."""
        self.create()
        anon = Client()
        for attempt in ("", " ", "password", "new-person@test.edu"):
            res = anon.post(
                "/api/auth/login",
                data=json.dumps({"email": "new-person@test.edu", "password": attempt}),
                content_type="application/json",
            )
            self.assertEqual(res.status_code, 401, f"{attempt!r} opened a session")

    def test_it_is_made_to_choose_one(self):
        self.create()
        self.assertTrue(User.objects.get(email="new-person@test.edu").must_change_password)

    def test_the_flag_cannot_be_waived_on_a_passwordless_account(self):
        """Otherwise the account is both unable to sign in and never asked to
        fix that."""
        self.create(must_change_password=False)
        self.assertTrue(User.objects.get(email="new-person@test.edu").must_change_password)

    def test_a_password_may_still_be_given(self):
        res = self.create(password="a-real-password-1")
        self.assertEqual(res.status_code, 200, res.content[:300])
        self.assertFalse(res.json()["needs_password"])
        self.assertTrue(
            User.objects.get(email="new-person@test.edu").has_usable_password()
        )

    def test_a_duplicate_address_says_whose_it_is(self):
        self.create()
        again = self.create(name="Someone Else")
        self.assertEqual(again.status_code, 400)
        self.assertIn("New Person", again.json()["detail"])

    def test_only_somebody_who_manages_users_may_create_one(self):
        faculty = User.objects.create_user(
            email="ca-fac@test.edu", password="pass", name="Fac", role=Role.FACULTY,
        )
        c = Client()
        c.force_login(faculty)
        res = c.post(
            "/api/admin/users",
            data=json.dumps({"email": "x@test.edu", "name": "X"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 403)


class WalkthroughTest(TestCase):
    """One paper, filed to paid, printing what each desk actually sees.

    Every other test asserts one thing about one step. This walks the whole
    chain in order so the result is legible to somebody who is not going to
    read the suite -- and it asserts as it goes, so it is a test rather than a
    demonstration that cannot fail.

    Run it with -v 2 to see the transcript.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        mk = User.objects.create_user
        self.faculty = mk(email="w-fac@sec.edu", password="x", name="Dr S Kanagamalliga",
                          role=Role.FACULTY, department="ECE", staff_id="SEC1042")
        self.cell = mk(email="w-cell@sec.edu", password="x", name="Research Cell",
                       role=Role.RESEARCH_CELL)
        self.principal = mk(email="w-prin@sec.edu", password="x", name="Principal",
                            role=Role.PRINCIPAL)
        self.director = mk(email="w-dir@sec.edu", password="x", name="Director",
                           role=Role.DIRECTOR)
        self.finance = mk(email="w-fin@sec.edu", password="x", name="Finance",
                          role=Role.FINANCE)
        self.hod = mk(email="w-hod@sec.edu", password="x", name="Head of ECE",
                      role=Role.HOD, department="ECE")

        # The reference tables. Production holds 32,187 Scimago rows and
        # 32,087 SNIP rows; a test database holds none, and without the
        # journal the formula has no quartile and no SNIP to work from and
        # correctly prices the paper at nothing.
        ScimagoJournal.objects.create(
            source_id="sol-1", title="Solar Energy", issn="0038-092X", year=2025,
            categories_json=json.dumps(
                [{"category": "Renewable Energy, Sustainability and the Environment",
                  "quartile": "Q1"}]
            ),
        )
        SnipSource.objects.create(
            source_id="sol-1", title="Solar Energy", print_issn="0038-092X",
            snip=1.85, year=2025,
        )

    def as_(self, user):
        c = Client()
        c.force_login(user)
        return c

    def say(self, line=""):
        print(line)

    def test_a_paper_walks_from_filing_to_payment(self):
        self.say("\n" + "=" * 68)
        self.say("  ONE PAPER, FILED TO PAID")
        self.say("=" * 68)

        # 1. The claimant files it.
        body = {
            "paper_title": "Thermal Imaging for Fault Detection in Photovoltaic Arrays",
            "journal_title": "Solar Energy",
            "issn": "0038-092X",
            "publication_year": 2025,
            "publication_date": "2025-03-14",
            "publication_type": "Article",
            "indexing_level": "Scopus",
            "yukthi_id": "YK-2025-118",
            "scopus_author_url": "https://www.scopus.com/authid/detail.uri?authorId=57200000",
            "sec_refs": "3",
            "self_reported_quartile": "Q1",
            "self_reported_snip": 1.85,
            "total_authors": 3,
            "author_position": 1,
            "affiliation_ok": True,
            # The submission gate wants the published paper and the SEC
            # references on file before it will take the claim -- which is the
            # system working: an incentive is paid against evidence.
            "proof_url": "https://doi.org/10.1016/j.solener.2025.03.014",
            # The policy pays only for references it can see evidence of, and
            # the evidence is the file plus the reference number -- a declared
            # count of 3 with nothing attached counts as nought.
            "attachments": [
                {"kind": "PUBLISHED_PAPER", "url": "/media/claims/%s.pdf" % ("a" * 32),
                 "filename": "paper.pdf", "size_bytes": 812345},
                {"kind": "SEC_REFERENCE", "url": "/media/claims/%s.pdf" % ("b" * 32),
                 "filename": "ref1.pdf", "size_bytes": 22100, "ref_number": "12",
                 "ref_title": "Prior SEC work on PV monitoring"},
                {"kind": "SEC_REFERENCE", "url": "/media/claims/%s.pdf" % ("c" * 32),
                 "filename": "ref2.pdf", "size_bytes": 19800, "ref_number": "27",
                 "ref_title": "SEC thermal imaging study"},
            ],
            "submit": True,
            # Scopus has not indexed it yet and the reference tables in a test
            # database are empty, so auto-confirmation fails -- which is the
            # ordinary case for a recent paper. The claimant sends it anyway
            # with a note, and the research cell checks it by hand. That is
            # the designed path, not a workaround.
            "contest_forward": True,
            "contest_note": "Published 14 March 2025; Scopus indexing is still pending.",
        }
        res = self.as_(self.faculty).post(
            "/api/claims", data=json.dumps(body), content_type="application/json"
        )
        self.assertEqual(res.status_code, 200, res.content[:400])
        claim = Claim.objects.get(pk=res.json()["id"])
        self.say(f"\n  1. FACULTY files it")
        self.say(f"     {self.faculty.name} — {claim.paper_title[:52]}")
        self.say(f"     ticket {claim.ticket_number}   status {claim.status}")
        self.say(f"     Scopus has not indexed it yet, so it arrives unpriced "
                 f"(Rs {claim.remuneration or 0:,.2f}) with the claimant's note")
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertTrue(claim.contest_forward)

        # 1b. The research cell enters the verified figures by hand. This is
        #     the designed lane for a paper the index has not caught up with,
        #     and the note is what an auditor follows later.
        res = self.as_(self.cell).post(
            f"/api/admin/claims/{claim.id}/set-verified",
            data=json.dumps({
                "quartile": "Q1", "snip": 1.85,
                "note": "Scimago 2025 lists Solar Energy as Q1; SNIP 1.85 from the 2025 CWTS table.",
            }),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:300])
        claim.refresh_from_db()
        self.say()
        self.say(f"  1b. RESEARCH CELL verifies by hand    -> {claim.quartile}, SNIP {claim.snip}")
        self.say(f"      the formula now says Rs {claim.remuneration:,.2f}")
        self.say(f"      why: {claim.remuneration_note or claim.calc_error or 'n/a'}")
        self.say(f"      sec_refs={claim.sec_refs!r} category={claim.remuneration_category!r}")
        self.assertGreater(claim.remuneration or 0, 0)

        # 2. A head of department must not see any of that.
        hod = self.as_(self.hod)
        blocked = [
            hod.get("/api/dashboard").status_code,
            hod.get(f"/api/lookup/ticket?q={claim.ticket_number}").status_code,
        ]
        self.say(f"\n  2. HEAD OF DEPARTMENT is refused every screen carrying money")
        self.say(f"     /api/dashboard -> {blocked[0]}   /api/lookup/ticket -> {blocked[1]}")
        self.assertEqual(blocked, [403, 403])

        # 3. The research cell clears it.
        res = self.as_(self.cell).post(
            f"/api/claims/{claim.id}/clear",
            data=json.dumps({"expected_amount": float(claim.remuneration)}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:300])
        claim.refresh_from_db()
        self.say(f"\n  3. RESEARCH CELL clears it            -> {claim.status}")
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

        # 4. Finance cannot jump the queue.
        early = self.as_(self.finance).post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({"voucher_number": "V-001"}),
            content_type="application/json",
        )
        self.say(f"\n  4. FINANCE tries to pay it early      -> {early.status_code} refused")
        self.assertEqual(early.status_code, 400)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

        # 5. Principal, then Director.
        claim.refresh_from_db()
        res = self.as_(self.principal).post(
            f"/api/claims/{claim.id}/principal-approve",
            # Every desk that moves the claim forward confirms the figure
            # it is looking at. An amount that changed under somebody
            # between reading and approving is refused, not waved through.
            data=json.dumps({"expected_amount": float(claim.remuneration)}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:300])
        claim.refresh_from_db()
        self.say(f"\n  5. PRINCIPAL approves                 -> {claim.status}")
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)

        claim.refresh_from_db()
        res = self.as_(self.director).post(
            f"/api/claims/{claim.id}/director-approve",
            # Every desk that moves the claim forward confirms the figure
            # it is looking at. An amount that changed under somebody
            # between reading and approving is refused, not waved through.
            data=json.dumps({"expected_amount": float(claim.remuneration)}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:300])
        claim.refresh_from_db()
        self.say(f"  6. DIRECTOR authorises                -> {claim.status}")
        self.assertEqual(claim.status, ClaimStatus.DIRECTOR_APPROVED)

        # 7. Now Finance may pay.
        claim.refresh_from_db()
        confirmed = float(claim.remuneration)
        self.say(f"     Finance confirms the figure on screen: Rs {confirmed:,.2f}")
        res = self.as_(self.finance).post(
            f"/api/claims/{claim.id}/mark-paid",
            data=json.dumps({
                "voucher_number": "V-2025-0001",
                "expected_amount": confirmed,
                # Scopus is unreachable in a test database. Re-verifying would
                # wipe the hand-entered quartile and reprice the claim to
                # nothing mid-payment, which is what the super-admin escape
                # hatch exists for.
                "skip_external": True,
            }),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:400])
        claim.refresh_from_db()
        self.say(f"\n  7. FINANCE pays it                    -> {claim.status}")
        self.say(f"     voucher {claim.voucher_number}   Rs {claim.remuneration:,.2f}")
        self.assertEqual(claim.status, ClaimStatus.PAID)

        # 8. The ledger carries it, and the account cannot be deleted away.
        rows = PaidLedger.objects.filter(claim=claim)
        self.say(f"\n  8. LEDGER has {rows.count()} row for it")
        self.assertEqual(rows.count(), 1)

        refusal = api_module._refuses_because_paid(self.faculty)
        self.say(f"\n  9. Deleting the account is refused:")
        self.say(f"     \"{(refusal or '')[:66]}...\"")
        self.assertIsNotNone(refusal)

        # 10. A second identical claim is warned about.
        dup = self.as_(self.faculty).post(
            "/api/claims",
            data=json.dumps({**body, "submit": False}),
            content_type="application/json",
        )
        dup_claim = Claim.objects.get(pk=dup.json()["id"])
        self.say(f"\n 10. The same paper filed again is flagged: "
                 f"duplicate_warning={dup_claim.duplicate_warning}")
        self.assertTrue(dup_claim.duplicate_warning)

        self.say("\n" + "=" * 68)
        self.say(f"  Rs {claim.remuneration:,.2f} paid, through five desks, "
                 f"none able to skip another.")
        self.say("=" * 68 + "\n")


class DirectMessageTests(TestCase):
    """A conversation whose audience is a list of people.

    Every other visibility answers "who may read this" from a property of the
    reader -- their department, their role, whether they opened it. A private
    conversation cannot be expressed that way, and `ThreadSubscription` only
    looked like the missing list: nothing in `visible_threads` has ever
    consulted it, so subscribing somebody routed a notification and granted no
    access at all.
    """

    def setUp(self):
        mk = User.objects.create_user
        self.a = mk(email="dm-a@test.edu", password="x", name="Fac A",
                    role=Role.FACULTY, department="CSE")
        self.b = mk(email="dm-b@test.edu", password="x", name="Fac B",
                    role=Role.FACULTY, department="ECE")
        self.outsider = mk(email="dm-c@test.edu", password="x", name="Fac C",
                           role=Role.FACULTY, department="CSE")
        self.office = mk(email="dm-o@test.edu", password="x", name="Cell",
                         role=Role.RESEARCH_CELL)
        self.admin = mk(email="dm-s@test.edu", password="x", name="Admin",
                        role=Role.SUPER_ADMIN)

    def as_(self, user):
        c = Client()
        c.force_login(user)
        return c

    def open_direct(self, author, others, **extra):
        body = {
            "title": "About my March claim",
            "body": "Could we talk about this privately?",
            "visibility": "DIRECT",
            "participant_ids": [u.id for u in others],
            **extra,
        }
        return self.as_(author).post(
            "/api/threads", data=json.dumps(body), content_type="application/json"
        )

    # ---- who can see it ------------------------------------------------

    def test_the_people_in_it_can_read_it(self):
        res = self.open_direct(self.a, [self.b])
        self.assertEqual(res.status_code, 200, res.content[:300])
        tid = res.json()["id"]
        self.assertEqual(self.as_(self.a).get(f"/api/threads/{tid}").status_code, 200)
        self.assertEqual(self.as_(self.b).get(f"/api/threads/{tid}").status_code, 200)

    def test_nobody_else_can(self):
        tid = self.open_direct(self.a, [self.b]).json()["id"]
        self.assertEqual(self.as_(self.outsider).get(f"/api/threads/{tid}").status_code, 404)

    def test_not_even_the_office(self):
        """The office reads every other kind of thread, and must not read this
        one. A direct message the administration can read is a quiet
        conversation wearing the name of a private one."""
        tid = self.open_direct(self.a, [self.b]).json()["id"]
        for who in (self.office, self.admin):
            self.assertEqual(
                self.as_(who).get(f"/api/threads/{tid}").status_code, 404, who.role
            )
        listed = self.as_(self.office).get("/api/threads?visibility=DIRECT").json()
        self.assertEqual(listed["results"], [])

    def test_the_office_cannot_moderate_what_it_cannot_read(self):
        """`may_moderate` returns True for the office on any thread, which
        would be a lock button on a conversation invisible to them."""
        from core import discussions

        tid = self.open_direct(self.a, [self.b]).json()["id"]
        thread = Thread.objects.get(pk=tid)
        self.assertFalse(discussions.may_moderate(self.office, thread))
        self.assertTrue(discussions.may_moderate(self.a, thread))
        self.assertTrue(discussions.may_moderate(self.b, thread))
        self.assertFalse(discussions.may_moderate(self.outsider, thread))

    # ---- what it refuses -----------------------------------------------

    def test_a_conversation_with_nobody_in_it_is_refused(self):
        """Otherwise it is readable by its author alone -- a private note that
        looks like a sent message, which is the worst way for one to fail."""
        res = self.open_direct(self.a, [])
        self.assertEqual(res.status_code, 400)
        self.assertIn("at least one person", res.json()["detail"])

    def test_naming_only_yourself_is_the_same_thing(self):
        res = self.open_direct(self.a, [self.a])
        self.assertEqual(res.status_code, 400)

    def test_naming_somebody_who_is_not_here_is_refused(self):
        """Refused rather than quietly dropped: a conversation silently
        missing the person it was for is worse than one that failed to open."""
        res = self.as_(self.a).post(
            "/api/threads",
            data=json.dumps({
                "title": "A ghost", "body": "hello", "visibility": "DIRECT",
                "participant_ids": ["no-such-user"],
            }),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 404)
        self.assertFalse(Thread.objects.filter(title="A ghost").exists())

    def test_a_deactivated_account_cannot_be_added(self):
        self.b.active = False
        self.b.save(update_fields=["active"])
        self.assertEqual(self.open_direct(self.a, [self.b]).status_code, 404)

    def test_it_is_not_a_mailing_list(self):
        many = [
            User.objects.create_user(
                email=f"dm-bulk{i}@test.edu", password="x", name=f"P{i}",
                role=Role.FACULTY,
            )
            for i in range(21)
        ]
        res = self.open_direct(self.a, many)
        self.assertEqual(res.status_code, 400)
        self.assertIn("handful", res.json()["detail"])

    # ---- the rows are the audience -------------------------------------

    def test_the_author_is_in_their_own_conversation(self):
        tid = self.open_direct(self.a, [self.b]).json()["id"]
        from core.models import ThreadParticipant

        people = set(
            ThreadParticipant.objects.filter(thread_id=tid).values_list("user_id", flat=True)
        )
        self.assertEqual(people, {self.a.id, self.b.id})

    def test_a_thread_appears_once_however_many_people_are_in_it(self):
        """`participants` is a reverse FK, so the join repeats the thread once
        per matching row without a distinct()."""
        from core import discussions

        c = User.objects.create_user(
            email="dm-d@test.edu", password="x", name="Fac D", role=Role.FACULTY
        )
        tid = self.open_direct(self.a, [self.b, c]).json()["id"]
        self.assertEqual(discussions.visible_threads(self.a).filter(pk=tid).count(), 1)

    def test_a_subscription_still_grants_nothing(self):
        """The distinction this whole feature rests on: being told about a
        conversation is not being in it."""
        from core import discussions

        tid = self.open_direct(self.a, [self.b]).json()["id"]
        thread = Thread.objects.get(pk=tid)
        ThreadSubscription.objects.create(thread=thread, user=self.outsider)
        self.assertFalse(discussions.may_read(self.outsider, thread))

    def test_the_other_visibilities_still_work(self):
        """The new clause must not widen anything that already existed."""
        pub = self.as_(self.a).post(
            "/api/threads",
            data=json.dumps({"title": "An open thread", "body": "hi", "visibility": "PUBLIC"}),
            content_type="application/json",
        )
        self.assertEqual(pub.status_code, 200, pub.content[:200])
        tid = pub.json()["id"]
        for who in (self.a, self.b, self.outsider, self.office):
            self.assertEqual(
                self.as_(who).get(f"/api/threads/{tid}").status_code, 200, who.email
            )

    def test_a_calendar_event_cannot_be_direct(self):
        """CalendarEvent reused Thread.Visibility.choices. A DIRECT event
        would have an empty audience -- created successfully, then visible to
        nobody including whoever made it."""
        from core.models import CalendarEvent

        values = [v for v, _ in CalendarEvent._meta.get_field("visibility").choices]
        self.assertNotIn("DIRECT", values)
        self.assertIn("PUBLIC", values)


class AttachmentFingerprintTests(TestCase):
    """A file's fingerprint survives an edit.

    `_persist_attachments` deletes the attachment set and rebuilds it from the
    payload, so a field `_claim_dict` does not send is a field the next save
    erases. `content_hash` was omitted, which meant every save of a reopened
    draft silently wiped every attachment's fingerprint -- and the duplicate
    check on /claims/upload matches on bytes, so it went blind for that claim
    permanently. The same PDF could then be attached to a second ticket with
    nothing left to notice.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.faculty = User.objects.create_user(
            email="hash-fac@test.edu", password="x", name="Fac",
            role=Role.FACULTY, department="ECE",
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def test_the_fingerprint_is_returned_and_survives_a_save(self):
        url = f"/media/claims/{'a' * 32}.pdf"
        made = self.client.post(
            "/api/claims",
            data=json.dumps({
                "paper_title": "A Paper", "journal_title": "J",
                "attachments": [{
                    "kind": "PUBLISHED_PAPER", "url": url, "filename": "p.pdf",
                    "size_bytes": 100, "content_hash": "deadbeef" * 8,
                }],
            }),
            content_type="application/json",
        )
        self.assertEqual(made.status_code, 200, made.content[:200])
        claim_id = made.json()["id"]

        # It has to come back, or the client cannot return it.
        detail = self.client.get(f"/api/claims/{claim_id}").json()
        self.assertEqual(detail["attachments"][0]["content_hash"], "deadbeef" * 8)

        # And a save that echoes what it was given must not lose it.
        again = self.client.patch(
            f"/api/claims/{claim_id}",
            data=json.dumps({"attachments": detail["attachments"]}),
            content_type="application/json",
        )
        self.assertEqual(again.status_code, 200, again.content[:200])
        kept = ClaimAttachment.objects.get(claim_id=claim_id)
        self.assertEqual(
            kept.content_hash, "deadbeef" * 8,
            "the fingerprint was erased by an ordinary edit",
        )


# The reference rule below refuses a submission, so these read the refusal.
from ninja.errors import HttpError


class ZeroRupeeTrapTests(TestCase):
    """The submission gate and the formula now measure the same thing.

    They used to disagree. `_check_mandatory_fields` was satisfied by
    `claim.sec_refs` -- a text field the claimant types -- or by a bare
    `sec_proof_url`. `_apply_calc` counted something else entirely:
    SEC_REFERENCE attachments carrying a `ref_number`, and it wanted
    `min_sec_references` of them. So a claim passed every gate, was ticketed,
    reached Finance and was worked out as Rs 0 with a note saying the claimant
    had cited 0 references while the form in front of them said 3.

    The owner closed it by refusing the submission rather than by paying it:
    the formula is the policy, and the gate was the thing that was wrong.
    Nobody's amount moved -- every claim this refuses was already worth
    nothing, which was the whole trap -- and COUNT_ONLY is exempt, because a
    threshold whose only job is to decide an amount has nothing to say about a
    claim that asks for none.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.faculty = User.objects.create_user(
            email="zt-fac@test.edu", password="x", name="Fac",
            role=Role.FACULTY, department="ECE",
        )

    def claim(self, **extra):
        base = dict(
            owner=self.faculty, paper_title="A Paper", journal_title="J",
            status=ClaimStatus.DRAFT, publication_year=2025,
            issn="0038-092X", publication_date="2025-03-01",
            indexing_level="Scopus", yukthi_id="YK-1",
            scopus_author_url="https://www.scopus.com/authid/detail.uri?authorId=1",
            affiliation_ok=True, total_authors=3, author_position=1,
            proof_url="https://doi.org/10.0/x", sec_proof_url="https://doi.org/10.0/r",
            sec_refs="12, 27",
        )
        base.update(extra)
        return Claim.objects.create(**base)

    def attach(self, claim, *numbers):
        """What the policy is actually paid on: the cited paper attached, and
        the number it carries in this article's reference list."""
        for n in numbers:
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{str(n).rjust(2, 'a') * 16}.pdf",
                filename=f"ref-{n}.pdf", size_bytes=100, ref_number=str(n),
            )

    def test_typed_reference_numbers_are_no_longer_evidence(self):
        """The claim out of the old defect, filed today: refused, not ticketed
        and then paid nothing."""
        from core.api import _check_mandatory_fields

        claim = self.claim()          # typed numbers, a URL, no attachments
        with self.assertRaises(HttpError) as caught:
            _check_mandatory_fields(claim)
        self.assertEqual(caught.exception.status_code, 400)

    def test_the_refusal_says_what_to_do_and_what_filing_anyway_would_pay(self):
        """A refusal a claimant cannot act on is the same trap wearing a hat."""
        from core.api import _check_mandatory_fields

        with self.assertRaises(HttpError) as caught:
            _check_mandatory_fields(self.claim())
        message = str(caught.exception)
        # The two things they have to do, and why it is worth doing them.
        self.assertIn("attach the cited paper", message)
        self.assertIn("number it has in your reference list", message)
        self.assertIn("Rs 0", message)
        # And the way out for somebody who genuinely has no more to cite.
        self.assertIn("publication count", message)

    def test_one_short_of_the_minimum_is_still_refused(self):
        """The gate counts them, rather than checking that any exists at all."""
        from core.api import _check_mandatory_fields

        claim = self.claim()
        self.attach(claim, "12")
        with self.assertRaises(HttpError) as caught:
            _check_mandatory_fields(claim)
        self.assertIn(f"1 of {MIN_SEC_REFERENCES}", str(caught.exception))

    def test_an_unnumbered_attachment_is_not_a_cited_reference(self):
        """A PDF nobody can match to a line in the reference list evidences
        nothing, and the calculator has never counted one."""
        from core.api import _check_mandatory_fields

        claim = self.claim()
        for i in range(MIN_SEC_REFERENCES + 1):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'b' * 30}{i:02d}.pdf",
                filename="ref.pdf", size_bytes=100,
            )
        with self.assertRaises(HttpError):
            _check_mandatory_fields(claim)

    def test_attaching_the_numbered_references_files_and_pays(self):
        """The remedy the refusal asks for, and what it is worth -- so the rule
        reads as a mismatch closed, not as the policy refusing to pay anybody."""
        from core.api import _apply_calc, _check_mandatory_fields

        claim = self.claim()
        self.attach(claim, "12", "27")
        _check_mandatory_fields(claim)   # passes: does not raise
        _apply_calc(claim)
        self.assertGreater(claim.remuneration or 0, 0)

    def test_count_only_is_exempt_because_it_asks_for_no_money(self):
        """A publication filed for the record is not refused by a threshold
        that exists only to decide an amount."""
        from core.api import _apply_calc, _check_mandatory_fields

        claim = self.claim(claim_reason=ClaimReason.COUNT_ONLY)
        _check_mandatory_fields(claim)   # passes: does not raise
        _apply_calc(claim)
        self.assertEqual(claim.remuneration or 0, 0)

    def test_count_only_still_has_to_show_a_reference(self):
        """Exempt from the threshold, not from evidence. The older, looser rule
        stands for it: something has to be on file, or the record is a claim
        that a paper cites Saveetha with nothing behind it."""
        from core.api import _check_mandatory_fields

        claim = self.claim(claim_reason=ClaimReason.COUNT_ONLY, sec_proof_url=None)
        with self.assertRaises(HttpError) as caught:
            _check_mandatory_fields(claim)
        self.assertIn("cited reference", str(caught.exception))

    def test_the_threshold_is_the_live_policys_and_not_a_hardcoded_two(self):
        """The gate, the filing form and the formula have to move together: a
        copy of the number in any one of them is a rule that silently stops
        matching the money."""
        from core.api import _check_mandatory_fields

        self.cfg.min_sec_references = 3
        self.cfg.save(update_fields=["min_sec_references"])

        claim = self.claim()
        self.attach(claim, "12", "27")
        with self.assertRaises(HttpError) as caught:
            _check_mandatory_fields(claim)
        self.assertIn("2 of 3", str(caught.exception))

        self.attach(claim, "41")
        _check_mandatory_fields(claim)   # passes: does not raise

        # And downwards: a policy that asks for one accepts one.
        self.cfg.min_sec_references = 1
        self.cfg.save(update_fields=["min_sec_references"])
        lenient = self.claim(paper_title="A Second Paper")
        self.attach(lenient, "12")
        _check_mandatory_fields(lenient)

    def test_closing_the_trap_moves_nobodys_money(self):
        """The refusal is not a pay cut. Every claim it stops was already being
        worked out as Rs 0 -- that was the trap -- and every claim that carried
        its evidence is priced exactly as it was before."""
        from core.api import _apply_calc

        refused_now = self.claim()
        _apply_calc(refused_now)
        self.assertEqual(
            refused_now.remuneration or 0, 0,
            "these claims were already paying nothing before the gate closed",
        )
        self.assertIn("0 SEC-affiliated references", refused_now.remuneration_note or "")

        evidenced = self.claim(paper_title="A Second Paper")
        self.attach(evidenced, "12", "27")
        _apply_calc(evidenced)
        before = evidenced.remuneration
        self.assertGreater(before or 0, 0)
        # Priced again now the gate exists: the same figure out of the same
        # formula. The gate decides what may be filed, never what it is worth.
        _apply_calc(evidenced)
        self.assertEqual(evidenced.remuneration, before)


class MoneyBlindnessSweepTests(TestCase):
    """Walk every registered route as a head of department.

    The existing defence was a hand-written list of paths in one test, which
    is a list somebody has to remember to add to. It had drifted: /dashboard,
    /lookup/ticket, /prior/check, /lookup/verify and /discover/venues all
    returned rupee figures to a head and none of them were on it.

    This asks the router instead, so a new endpoint is covered the day it is
    written rather than the day somebody remembers it.
    """

    def setUp(self):
        self.hod = User.objects.create_user(
            email="sweep-hod@test.edu", password="pass", name="Head",
            role=Role.HOD, department="CSE",
        )
        self.faculty = User.objects.create_user(
            email="sweep-fac@test.edu", password="pass", name="Fac",
            role=Role.FACULTY, department="CSE",
        )
        # A head who owns a paid claim. Without this the sweep passes for the
        # wrong reason: `_claims_queryset` scopes a head to their own claims,
        # and an unguarded endpoint returns an empty list that looks like a
        # refusal. A head files their own papers (2026-09-23) and sees their
        # own amount on it; the sweep checks that is the only figure they get.
        self.paid = Claim.objects.create(
            owner=self.hod, paper_title="A Head's Own Paper", journal_title="J",
            status=ClaimStatus.PAID, remuneration=90000, publication_year=2025,
            ticket_number="FP-2025-000001",
        )
        # And a colleague in the same department with a paid claim of their
        # own, whose figure must reach the head by no route at all.
        Claim.objects.create(
            owner=self.faculty, paper_title="A Colleague's Paper", journal_title="J",
            status=ClaimStatus.PAID, remuneration=61803.25, publication_year=2025,
            ticket_number="FP-2025-000002",
        )
        self.client = Client()
        self.client.force_login(self.hod)

    def _money_outside_own_rows(self, node, where, found):
        """Every money key that is not inside a row naming the head as owner."""
        from core.hod import MONEY_KEYS

        if isinstance(node, dict):
            if node.get("owner_id") == self.hod.id:
                return  # their own claim: its figures are theirs to see
            for key, value in node.items():
                if key in MONEY_KEYS:
                    found.append(f"{where} -> {key}")
                self._money_outside_own_rows(value, where, found)
        elif isinstance(node, list):
            for item in node:
                self._money_outside_own_rows(item, where, found)

    def test_no_get_route_hands_a_head_a_rupee_figure_that_is_not_theirs(self):
        checked, leaked, own_seen = 0, [], False
        for _prefix, router in api_module.api._routers:
            for path, view in router.path_operations.items():
                methods = {m for op in view.operations for m in op.methods}
                if "GET" not in methods or "{" in path:
                    continue
                url = f"/api{path}"
                try:
                    res = self.client.get(url)
                except Exception:
                    continue
                if res.status_code != 200:
                    continue
                checked += 1
                raw = res.content.decode("utf-8", errors="ignore")
                if "61803.25" in raw:
                    leaked.append(f"{url} -> the colleague's figure")
                own_seen = own_seen or "90000" in raw
                try:
                    body = res.json()
                except ValueError:
                    continue  # a file; its columns are checked by the export tests
                self._money_outside_own_rows(body, url, leaked)
        self.assertGreater(checked, 10, "the sweep did not actually reach any route")
        self.assertEqual(leaked, [], f"money reached a head of department: {leaked}")
        self.assertTrue(own_seen, "the head's own amount should reach them on /claims")

    def test_the_named_readers_refuse_a_head(self):
        """The ones the sweep cannot reach, because they need an argument."""
        self.assertEqual(self.client.get("/api/lookup/ticket?q=FP-2025").status_code, 403)
        self.assertEqual(
            self.client.post(
                "/api/prior/check", data=json.dumps({"title": "A Head's Own Paper"}),
                content_type="application/json",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/lookup/verify", data=json.dumps({"title": "A Head's Own Paper"}),
                content_type="application/json",
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/discover/venues",
                data=json.dumps({"title": "A Head's Own Paper About Things"}),
                content_type="application/json",
            ).status_code,
            403,
        )

    def test_a_colleague_s_payout_is_not_readable_by_title(self):
        """/prior/check answered with an amount and a name for any title."""
        Claim.objects.create(
            owner=self.faculty, paper_title="Deep Learning For Widgets",
            journal_title="J", status=ClaimStatus.PAID, remuneration=90000,
            publication_year=2025,
        )
        res = self.client.post(
            "/api/prior/check",
            data=json.dumps({"title": "Deep Learning For Widgets"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 403)
        self.assertNotIn("90000", res.content.decode())


class PrivilegedRoleTests(TestCase):
    """The desk that clears a claim cannot appoint the desk that pays it.

    `can_manage_users` covers the research cell and the coordinator, which is
    correct -- managing accounts is their job. It also covered SUPER_ADMIN,
    DIRECTOR and FINANCE, so the clearing desk could promote itself and then
    approve, authorise and pay the claim it had just cleared. Every separation
    in the chain was optional for the one role placed to exploit it.
    """

    def setUp(self):
        self.cell = User.objects.create_user(
            email="pr-cell@test.edu", password="pass", name="Cell",
            role=Role.RESEARCH_CELL,
        )
        self.admin = User.objects.create_user(
            email="pr-admin@test.edu", password="pass", name="Admin",
            role=Role.SUPER_ADMIN,
        )
        self.someone = User.objects.create_user(
            email="pr-someone@test.edu", password="pass", name="Someone",
            role=Role.FACULTY, department="CSE",
        )

    def as_(self, user):
        c = Client()
        c.force_login(user)
        return c

    def test_the_research_cell_cannot_mint_a_super_admin(self):
        res = self.as_(self.cell).post(
            "/api/admin/users",
            data=json.dumps({"email": "new@test.edu", "name": "New", "role": "SUPER_ADMIN"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 403)
        self.assertFalse(User.objects.filter(email="new@test.edu").exists())

    def test_the_research_cell_cannot_promote_somebody_to_finance(self):
        res = self.as_(self.cell).patch(
            f"/api/admin/users/{self.someone.id}",
            data=json.dumps({"role": "FINANCE"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 403)
        self.someone.refresh_from_db()
        self.assertEqual(self.someone.role, Role.FACULTY)

    def test_nor_a_director(self):
        res = self.as_(self.cell).patch(
            f"/api/admin/users/{self.someone.id}",
            data=json.dumps({"role": "DIRECTOR"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 403)

    def test_the_cell_keeps_the_rest_of_account_management(self):
        """The fix must not stop the office doing its job."""
        res = self.as_(self.cell).patch(
            f"/api/admin/users/{self.someone.id}",
            data=json.dumps({"role": "HOD", "department": "ECE"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:200])
        self.someone.refresh_from_db()
        self.assertEqual(self.someone.role, Role.HOD)

    def test_a_super_admin_still_appoints_anybody(self):
        res = self.as_(self.admin).patch(
            f"/api/admin/users/{self.someone.id}",
            data=json.dumps({"role": "FINANCE"}),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:200])


class DuplicateWarningSurvivesOutageTests(TestCase):
    """A Scopus outage must not erase a duplicate-payment warning.

    `check_already_paid` asks our own database and has nothing to do with
    Scopus, but it sat after the early return on ScopusError -- so an outage
    meant the result carried no "paid" block, and the caller wrote the default
    (no warning, no matches) straight over a warning raised at creation.

    A verbatim duplicate of an already-paid claim then reached Finance with
    nothing on it to say so.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.faculty = User.objects.create_user(
            email="dup-fac@test.edu", password="pass", name="Fac",
            role=Role.FACULTY, department="CSE", staff_id="S1",
        )
        Claim.objects.create(
            owner=self.faculty, paper_title="A Paper Paid Once Already",
            journal_title="J", status=ClaimStatus.PAID, remuneration=90000,
            publication_year=2025, normalized_title=normalize_title("A Paper Paid Once Already"),
        )

    def test_the_warning_is_kept_when_scopus_is_down(self):
        from core.services.scopus import ScopusError
        from core.services.verify import verify_publication

        with patch(
            "core.services.verify.search_by_title",
            side_effect=ScopusError("unauthorized", "no key"),
        ):
            out = verify_publication(title="A Paper Paid Once Already")

        self.assertFalse(out["ok"], "the outage should still be reported")
        self.assertIn("paid", out, "the paid check must still have run")
        self.assertTrue(out["paid"]["warning"], "the duplicate went unnoticed")

    def test_applying_a_result_without_a_paid_block_keeps_what_was_there(self):
        """Belt and braces: an unasked question is not a 'no'."""
        from core.services.verify import apply_verify_to_claim

        claim = Claim.objects.create(
            owner=self.faculty, paper_title="A Paper Paid Once Already",
            journal_title="J", status=ClaimStatus.DRAFT, publication_year=2025,
            duplicate_warning=True,
            duplicate_matches_json=json.dumps([{"amount": 90000.0}]),
        )
        apply_verify_to_claim(claim, {"ok": False, "scopus": {}})
        self.assertTrue(claim.duplicate_warning)
        self.assertIn("90000", claim.duplicate_matches_json)


class LoginThrottleTests(TestCase):
    """The lockout counter cannot be reset by a header the client writes."""

    def test_the_client_half_of_x_forwarded_for_is_ignored(self):
        factory = __import__("django.test", fromlist=["RequestFactory"]).RequestFactory()

        req = factory.post("/api/auth/login", REMOTE_ADDR="10.0.0.9")
        # Client-supplied value first, our proxy's appended last. Taking the
        # leftmost gave a fresh bucket per request and the ten-attempt limit
        # never fired.
        req.META["HTTP_X_FORWARDED_FOR"] = "1.2.3.4, 203.0.113.7"
        first = api_module._login_throttle_key(req, "a@test.edu")

        req.META["HTTP_X_FORWARDED_FOR"] = "9.9.9.9, 203.0.113.7"
        second = api_module._login_throttle_key(req, "a@test.edu")

        self.assertEqual(first, second, "a spoofed hop still moved the bucket")
        self.assertIn("203.0.113.7", first)

    def test_it_falls_back_to_the_socket_address(self):
        factory = __import__("django.test", fromlist=["RequestFactory"]).RequestFactory()
        req = factory.post("/api/auth/login", REMOTE_ADDR="10.0.0.9")
        self.assertIn("10.0.0.9", api_module._login_throttle_key(req, "a@test.edu"))


class PayoutMonthTests(TestCase):
    """The claimant does not choose which month's budget pays them."""

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.faculty = User.objects.create_user(
            email="pm-fac@test.edu", password="pass", name="Fac",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def test_a_claimant_cannot_set_the_payout_month(self):
        """It decides which financial year's budget the payment lands in. One
        set to 2019-04 produced a real payment the current year's budget
        report could not see."""
        res = self.client.post(
            "/api/claims",
            data=json.dumps({
                "paper_title": "A Paper", "journal_title": "J",
                "payout_month": "2019-04",
            }),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:200])
        claim = Claim.objects.get(pk=res.json()["id"])
        self.assertIsNone(claim.payout_month)


class LocalInferenceTests(TestCase):
    """The provider seam, and the ways local inference is allowed to fail.

    None of these need a running Ollama: the transport is stubbed at
    `urllib.request.urlopen`, which is the boundary between our code and the
    daemon. What is being tested is our reading of its answers, not the
    daemon.
    """

    def setUp(self):
        from core.services import ollama

        self.ollama = ollama

    def _reply(self, payload, status=200):
        """Stand in for one urlopen call returning a JSON body."""
        import io

        return io.BytesIO(json.dumps(payload).encode())

    # ---- configuration ------------------------------------------------

    def test_the_provider_is_local_by_default(self):
        self.assertEqual(ai.provider_name(), "ollama")

    @override_settings(AI_PROVIDER="openai")
    def test_an_unknown_provider_is_refused_rather_than_resolved(self):
        """A typo in a deployment variable must stop the feature, not quietly
        change where a faculty member's unpublished abstract is sent."""
        state = ai.health()
        self.assertFalse(state["ready"])
        self.assertEqual(state["code"], "misconfigured")
        with self.assertRaises(ai.AIError) as caught:
            ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "misconfigured")

    @override_settings(OLLAMA_BASE_URL="http://127.0.0.1:11434")
    def test_it_only_ever_talks_to_loopback_by_default(self):
        self.assertTrue(self.ollama.base_url().startswith("http://127.0.0.1"))

    # ---- health -------------------------------------------------------

    def test_a_dead_service_and_a_missing_model_are_told_apart(self):
        """Two different situations with two different one-command remedies.
        Collapsing them into "unavailable" leaves somebody who could have
        fixed it in one step with nothing to act on."""
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            state = ai.health()
        self.assertFalse(state["ready"])
        self.assertEqual(state["code"], "service_down")
        self.assertIn("Start Ollama", state["detail"])

        replies = [
            self._reply({"version": "0.32.15"}),
            self._reply({"models": [{"name": "qwen2.5-coder:1.5b"}]}),
        ]
        with patch("urllib.request.urlopen", side_effect=replies):
            state = ai.health()
        self.assertFalse(state["ready"])
        self.assertEqual(state["code"], "model_missing")
        self.assertIn("ollama pull", state["detail"])

    @override_settings(OLLAMA_MODEL="gemma4:12b")
    def test_it_is_ready_when_the_model_is_installed(self):
        replies = [
            self._reply({"version": "0.32.15"}),
            self._reply({"models": [{"name": "gemma4:12b"}]}),
        ]
        with patch("urllib.request.urlopen", side_effect=replies):
            state = ai.health()
        self.assertTrue(state["ready"])
        self.assertEqual(state["code"], "ready")

    @override_settings(OLLAMA_MODEL="gemma4")
    def test_a_tagless_name_matches_its_tagged_install(self):
        """Ollama treats a bare name as :latest, and somebody configuring this
        by hand writes whichever form they saw."""
        replies = [
            self._reply({"version": "0.32.15"}),
            self._reply({"models": [{"name": "gemma4:12b"}]}),
        ]
        with patch("urllib.request.urlopen", side_effect=replies):
            self.assertTrue(ai.health()["ready"])

    def test_a_health_probe_never_takes_a_page_down(self):
        with patch("core.services.ai.health", side_effect=RuntimeError("boom")):
            self.assertFalse(ai.available())

    # ---- failure mapping ----------------------------------------------

    def test_a_missing_model_is_configuration_not_a_server_error(self):
        import urllib.error

        err = urllib.error.HTTPError(
            "http://127.0.0.1:11434/api/generate", 404, "Not Found", {},
            __import__("io").BytesIO(b'{"error":"model \'gemma4:12b\' not found"}'),
        )
        with patch("urllib.request.urlopen", side_effect=err):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "model_missing")

    def test_a_timeout_is_reported_as_one(self):
        with patch("urllib.request.urlopen", side_effect=TimeoutError()):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "timeout")

    def test_nothing_falls_back_to_a_remote_service(self):
        """The whole point of running locally is that the text stays here.
        A fallback would make that stop being true exactly when nobody is
        watching, so a dead daemon raises rather than reaching outward."""
        with patch("urllib.request.urlopen", side_effect=OSError("refused")):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("anything")
        self.assertEqual(caught.exception.code, "unreachable")

    # ---- the request we actually send ---------------------------------

    def test_thinking_is_off(self):
        """Gemma 4 reasons before answering and does it silently. With
        thinking left on and a normal token ceiling it spends the whole budget
        reasoning and returns an EMPTY string with done_reason "length" -- an
        HTTP success carrying nothing at all. Measured on this hardware:
        20 tokens produced 0 characters with it on, and a correct answer in
        10 with it off."""
        seen = {}

        def capture(req, timeout=None):
            seen.update(json.loads(req.data.decode()))
            return self._reply({"response": '{"ok": true}'})

        with patch("urllib.request.urlopen", side_effect=capture):
            ai.ask_json("anything")
        self.assertIs(seen.get("think"), False)

    def test_the_schema_is_passed_as_a_decoding_constraint(self):
        """Stronger than asking in the prompt: the decoder cannot emit tokens
        that break the schema. A smaller local model needs that."""
        seen = {}

        def capture(req, timeout=None):
            seen.update(json.loads(req.data.decode()))
            return self._reply({"response": '{"journals": []}'})

        schema = {"type": "object", "properties": {"journals": {"type": "array"}}}
        with patch("urllib.request.urlopen", side_effect=capture):
            ai.ask_json("anything", schema=schema)
        self.assertEqual(seen.get("format"), schema)

    def test_every_call_is_bounded(self):
        """An unbounded generate holds a worker until something else times out
        and blames the wrong thing."""
        seen = {}

        def capture(req, timeout=None):
            seen["timeout"] = timeout
            return self._reply({"response": "{}"})

        with patch("urllib.request.urlopen", side_effect=capture):
            ai.ask_json("anything")
        self.assertIsNotNone(seen["timeout"])
        self.assertLessEqual(seen["timeout"], 600)

    # ---- reading the answer -------------------------------------------

    def test_a_fenced_answer_is_still_read(self):
        with patch(
            "urllib.request.urlopen",
            return_value=self._reply({"response": '```json\n{"a": 1}\n```'}),
        ):
            self.assertEqual(ai.ask_json("x"), {"a": 1})

    def test_an_empty_answer_is_an_error_not_an_empty_result(self):
        """The failure mode thinking-on produced. A feature that silently
        yields nothing looks exactly like one nobody switched on."""
        with patch("urllib.request.urlopen", return_value=self._reply({"response": "  "})):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("x")
        self.assertEqual(caught.exception.code, "empty")

    def test_a_truncated_answer_says_so(self):
        with patch(
            "urllib.request.urlopen",
            return_value=self._reply({"response": '{"journals": [{"title": "Half'}),
        ):
            with self.assertRaises(ai.AIError) as caught:
                ai.ask_json("x")
        self.assertEqual(caught.exception.code, "unparsable")


class LocalInferenceShapeTests(TestCase):
    """The callers survive a smaller model missing the shape it was asked for.

    A hosted model almost always returned the object it was told to. A local
    one at this size returns a bare array often enough that `.get` on it -- an
    uncaught AttributeError, so a 500 -- was a question of when.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )

    def test_venues_survive_a_bare_array(self):
        with patch(
            "core.services.discover.ai.ask_json",
            return_value=[{"title": "Applied Soft Computing", "why": "fits"}],
        ):
            out = discover.suggest_venues(title="A Paper About Photovoltaic Arrays")
        self.assertIn("journals", out)

    def test_venues_survive_junk_entries(self):
        with patch(
            "core.services.discover.ai.ask_json",
            return_value={"journals": ["just a string", None, {"title": "", "why": "x"}]},
        ):
            out = discover.suggest_venues(title="A Paper About Photovoltaic Arrays")
        self.assertEqual(out["journals"], [])

    def test_directions_survive_a_bare_array(self):
        with patch(
            "core.services.discover.ai.ask_json",
            return_value=[{"topic": "PV fault detection", "why": "y", "first_step": "z"}],
        ):
            out = discover.suggest_directions(history=[{"title": "t", "journal": "j", "year": "2025"}], interests=[])
        self.assertEqual(len(out["directions"]), 1)

    def test_directions_survive_junk_entries(self):
        with patch(
            "core.services.discover.ai.ask_json",
            return_value={"directions": ["nope", 7, {"topic": ""}]},
        ):
            out = discover.suggest_directions(history=[{"title": "t", "journal": "j", "year": "2025"}], interests=[])
        self.assertEqual(out["directions"], [])


class ClerkPublishableKeyTests(TestCase):
    """The instance is read out of the publishable key, not configured twice.

    Keeping the key and the instance host as two settings means they can drift
    apart, and the failure that produces is an instance verifying tokens
    against a different instance's signing keys.
    """

    def test_the_host_is_decoded_from_the_key(self):
        import base64

        from core.clerk import frontend_api_from_publishable_key

        key = "pk_test_" + base64.b64encode(b"clerk.example.com$").decode()
        self.assertEqual(frontend_api_from_publishable_key(key), "clerk.example.com")

    def test_live_and_test_keys_both_work(self):
        import base64

        from core.clerk import frontend_api_from_publishable_key

        encoded = base64.b64encode(b"clerk.sec.edu.in$").decode()
        for prefix in ("pk_test_", "pk_live_"):
            self.assertEqual(
                frontend_api_from_publishable_key(prefix + encoded), "clerk.sec.edu.in"
            )

    def test_the_jwks_address_follows_from_it(self):
        import base64

        from core.clerk import jwks_url

        key = "pk_test_" + base64.b64encode(b"clerk.example.com$").decode()
        self.assertEqual(
            jwks_url(key), "https://clerk.example.com/.well-known/jwks.json"
        )

    def test_rubbish_is_refused_rather_than_guessed_at(self):
        from core.clerk import ClerkError, frontend_api_from_publishable_key

        for bad in ("", "not-a-key", "sk_test_secret", "pk_test_!!!!"):
            with self.assertRaises(ClerkError, msg=bad):
                frontend_api_from_publishable_key(bad)


class ClerkSignInTests(TestCase):
    """Clerk says who somebody is. This system still says what they may do."""

    def setUp(self):
        self.faculty = User.objects.create_user(
            email="clerk-fac@test.edu", password="pass", name="Clerk Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def post(self, token="a.b.c"):
        return self.client.post(
            "/api/auth/clerk",
            data=json.dumps({"token": token}),
            content_type="application/json",
        )

    @override_settings(CLERK_PUBLISHABLE_KEY="")
    def test_it_says_so_when_it_is_not_configured(self):
        res = self.post()
        self.assertEqual(res.status_code, 503)

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_an_unverifiable_token_opens_nothing(self):
        res = self.post("clearly-not-a-jwt")
        self.assertEqual(res.status_code, 401)
        self.assertNotIn("_auth_user_id", self.client.session)

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_an_address_with_no_account_here_is_refused(self):
        """The rule that matters. Clerk authenticating somebody is not this
        college having an account for them, and these accounts carry staff
        ids and decide who gets paid."""
        with patch("core.clerk.verify_clerk_token", return_value={
            "iss": "https://clerk.example.com", "email": "stranger@elsewhere.com",
        }):
            res = self.post()
        self.assertEqual(res.status_code, 403)
        self.assertIn("no account here", res.json()["detail"])
        self.assertEqual(User.objects.filter(email="stranger@elsewhere.com").count(), 0)

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_a_known_address_is_signed_in(self):
        with patch("core.clerk.verify_clerk_token", return_value={
            "iss": "https://clerk.example.com", "email": "clerk-fac@test.edu",
        }):
            res = self.post()
        self.assertEqual(res.status_code, 200, res.content[:300])
        self.assertEqual(res.json()["email"], "clerk-fac@test.edu")
        self.assertEqual(str(self.client.session["_auth_user_id"]), str(self.faculty.id))

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_the_match_is_case_insensitive(self):
        with patch("core.clerk.verify_clerk_token", return_value={
            "iss": "https://clerk.example.com", "email": "Clerk-Fac@Test.edu",
        }):
            self.assertEqual(self.post().status_code, 200)

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_a_deactivated_account_stays_shut(self):
        self.faculty.active = False
        self.faculty.save(update_fields=["active"])
        with patch("core.clerk.verify_clerk_token", return_value={
            "iss": "https://clerk.example.com", "email": "clerk-fac@test.edu",
        }):
            res = self.post()
        self.assertEqual(res.status_code, 403)
        self.assertNotIn("_auth_user_id", self.client.session)

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_a_token_with_no_email_says_what_is_wrong(self):
        """Clerk's default session token carries no email; it is added by a
        JWT template. Without this the sign-in verifies perfectly and then
        matches nobody, which reads as the account being missing."""
        with patch("core.clerk.verify_clerk_token", return_value={
            "iss": "https://clerk.example.com", "sub": "user_123",
        }):
            res = self.post()
        self.assertEqual(res.status_code, 403)
        self.assertIn("email claim", res.json()["detail"])

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_the_role_comes_from_here_not_from_clerk(self):
        """Clerk is the front door and nothing more. A token claiming a role
        does not get one -- the role decides what may be approved and what
        rupee figures are shown, and it lives in our table."""
        with patch("core.clerk.verify_clerk_token", return_value={
            "iss": "https://clerk.example.com",
            "email": "clerk-fac@test.edu",
            "role": "SUPER_ADMIN",
            "department": "Finance",
        }):
            res = self.post()
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["role"], Role.FACULTY)
        self.faculty.refresh_from_db()
        self.assertEqual(self.faculty.role, Role.FACULTY)
        self.assertEqual(self.faculty.department, "CSE")

    @override_settings(CLERK_PUBLISHABLE_KEY="pk_test_Y2xlcmsuZXhhbXBsZS5jb20k")
    def test_signing_in_is_on_the_record(self):
        with patch("core.clerk.verify_clerk_token", return_value={
            "iss": "https://clerk.example.com", "email": "clerk-fac@test.edu",
        }):
            self.post()
        self.assertTrue(
            AuditLog.objects.filter(action="LOGIN_CLERK", entity_id=self.faculty.id).exists()
        )


class ClerkIssuerTests(TestCase):
    """A valid token from somebody else's Clerk instance is still theirs."""

    def test_a_foreign_issuer_is_rejected(self):
        import base64

        import jwt
        from cryptography.hazmat.primitives.asymmetric import rsa

        from core.clerk import ClerkError, verify_clerk_token

        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        token = jwt.encode(
            {
                "iss": "https://clerk.attacker.test",
                "email": "clerk-fac@test.edu",
                "iat": 1700000000,
                "exp": 4102444800,
            },
            private,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )
        key = "pk_test_" + base64.b64encode(b"clerk.example.com$").decode()

        # The signature check passes -- this is the attacker's own key -- so
        # the issuer check is the only thing standing between their instance
        # and a session here.
        with patch("core.clerk._signing_key", return_value=private.public_key()):
            with self.assertRaises(ClerkError):
                verify_clerk_token(token, key)

    def test_an_expired_token_is_rejected(self):
        import base64

        import jwt
        from cryptography.hazmat.primitives.asymmetric import rsa

        from core.clerk import ClerkError, verify_clerk_token

        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        token = jwt.encode(
            {
                "iss": "https://clerk.example.com",
                "email": "clerk-fac@test.edu",
                "iat": 1600000000,
                "exp": 1600003600,
            },
            private,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )
        key = "pk_test_" + base64.b64encode(b"clerk.example.com$").decode()
        with patch("core.clerk._signing_key", return_value=private.public_key()):
            with self.assertRaises(ClerkError):
                verify_clerk_token(token, key)

    def test_a_well_formed_token_from_this_instance_verifies(self):
        import base64

        import jwt
        from cryptography.hazmat.primitives.asymmetric import rsa

        from core.clerk import email_from_claims, verify_clerk_token

        private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        token = jwt.encode(
            {
                "iss": "https://clerk.example.com",
                "email": "Clerk-Fac@Test.edu",
                "iat": 1700000000,
                "exp": 4102444800,
            },
            private,
            algorithm="RS256",
            headers={"kid": "test-key"},
        )
        key = "pk_test_" + base64.b64encode(b"clerk.example.com$").decode()
        with patch("core.clerk._signing_key", return_value=private.public_key()):
            claims = verify_clerk_token(token, key)
        self.assertEqual(email_from_claims(claims), "clerk-fac@test.edu")


class ClerkEmailClaimTests(TestCase):
    """Instances name the email claim differently; several shapes are tried."""

    def test_the_shapes_a_jwt_template_produces(self):
        from core.clerk import email_from_claims

        for claims in (
            {"email": "a@test.edu"},
            {"email_address": "a@test.edu"},
            {"primary_email_address": "a@test.edu"},
            {"user_email": "a@test.edu"},
            {"user": {"email": "a@test.edu"}},
        ):
            self.assertEqual(email_from_claims(claims), "a@test.edu", str(claims))

    def test_nothing_email_shaped_gives_nothing(self):
        from core.clerk import email_from_claims

        self.assertIsNone(email_from_claims({"sub": "user_123"}))
        self.assertIsNone(email_from_claims({"email": "not-an-address"}))


class StudentProjectClaimTests(TestCase):
    """A student-project claim reaches a team, and is refused without one.

    Every piece of this existed separately and none of it was joined up:
    `Claim.team` was declared, migrated and serialised, `ClaimReason` carried
    a STUDENT_PROJECT member, and no code path in the API ever set the one
    from the other. A claimant could pick the reason and the ticket came out
    naming nobody but them.
    """

    def setUp(self):
        self.cfg = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        self.faculty = User.objects.create_user(
            email="sp-fac@test.edu", password="pass", name="Mentor One",
            role=Role.FACULTY, department="CSE",
        )
        self.team = Team.objects.create(
            code="CSE-24-011", title="Solar tracker", department="CSE",
            mentor=self.faculty,
        )
        TeamMember.objects.create(
            team=self.team, name="A Student", register_number="212221001"
        )
        self.client = Client()
        self.client.force_login(self.faculty)

    def create(self, **extra):
        body = {
            "paper_title": "A conference paper",
            "journal_title": "Some Conference",
            "claim_reason": "STUDENT_PROJECT",
            **extra,
        }
        return self.client.post(
            "/api/claims", data=json.dumps(body), content_type="application/json"
        )

    def test_a_team_code_attaches_the_team(self):
        res = self.create(team_code="CSE-24-011")
        self.assertEqual(res.status_code, 200, res.content[:300])
        claim = Claim.objects.get(pk=res.json()["id"])
        self.assertEqual(claim.team_id, self.team.id)

    def test_the_code_is_matched_the_way_it_is_read_off_a_sheet(self):
        """Case-insensitively. It is typed from print as often as copied."""
        res = self.create(team_code="cse-24-011")
        self.assertEqual(res.status_code, 200, res.content[:300])
        self.assertEqual(Claim.objects.get(pk=res.json()["id"]).team_id, self.team.id)

    def test_an_unknown_code_is_refused_and_says_what_to_do(self):
        res = self.create(team_code="NOPE-1")
        self.assertEqual(res.status_code, 404)
        self.assertIn("Create the team first", res.json()["detail"])

    def test_the_ticket_carries_the_team_and_its_students(self):
        res = self.create(team_code="CSE-24-011")
        detail = self.client.get(f"/api/claims/{res.json()['id']}").json()
        self.assertEqual(detail["team"]["code"], "CSE-24-011")
        self.assertEqual(detail["team"]["mentor_name"], "Mentor One")
        self.assertEqual(
            [m["name"] for m in detail["team"]["members"]], ["A Student"]
        )

    def test_changing_the_reason_lets_go_of_the_team(self):
        """Otherwise a paper that is no longer a student project still shows
        a roster of students it has nothing to do with."""
        res = self.create(team_code="CSE-24-011")
        claim_id = res.json()["id"]
        patched = self.client.patch(
            f"/api/claims/{claim_id}",
            data=json.dumps({"claim_reason": "INCENTIVE"}),
            content_type="application/json",
        )
        self.assertEqual(patched.status_code, 200, patched.content[:300])
        self.assertIsNone(Claim.objects.get(pk=claim_id).team_id)

    def test_a_student_project_cannot_be_submitted_without_a_team(self):
        # Everything else filled in, so the refusal that comes back is the
        # one this test is about rather than the missing-fields list.
        claim = Claim.objects.create(
            owner=self.faculty, paper_title="No team here",
            journal_title="Some Conference", claim_reason=ClaimReason.STUDENT_PROJECT,
            status=ClaimStatus.DRAFT, publication_year=2025,
            issn="0272-8842", publication_date="2025-03-01",
            indexing_level="Scopus", yukthi_id="YK-1",
            scopus_author_url="https://www.scopus.com/authid/detail.uri?authorId=1",
            sec_refs="2",
        )
        from ninja.errors import HttpError

        from core.api import _check_mandatory_fields

        with self.assertRaises(HttpError) as caught:
            _check_mandatory_fields(claim)
        self.assertIn("name the team", str(caught.exception))

    def test_the_reason_does_not_zero_the_payment(self):
        """`is_student_publication` makes the engine return zero, and it is
        set from COUNT_ONLY alone. Wiring it to this reason as well -- both
        have "student" in the name -- would pay every student project nothing,
        which is the opposite of what the reason is for."""
        res = self.create(team_code="CSE-24-011")
        claim = Claim.objects.get(pk=res.json()["id"])
        self.assertFalse(claim.is_student_publication)


class ResearchCoordinatorTests(TestCase):

    """The coordinator checks papers beside the admin office, not after it."""

    def setUp(self):
        self.coordinator = User.objects.create_user(
            email="rc-coord@test.edu", password="pass", name="RC Coordinator",
            role=Role.RESEARCH_COORDINATOR,
        )
        self.faculty = User.objects.create_user(
            email="rc-fac@test.edu", password="pass", name="RC Faculty",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def test_a_coordinator_may_clear_a_paper(self):
        self.assertTrue(rbac.can_clear_claims(Role.RESEARCH_COORDINATOR))

    def test_a_coordinator_has_the_office_s_reach(self):
        for check in (
            rbac.can_manage_users,
            rbac.can_view_reports,
            rbac.can_view_audit,
            rbac.can_issue_claims,
        ):
            self.assertTrue(check(Role.RESEARCH_COORDINATOR), check.__name__)

    def test_a_coordinator_is_not_the_principal_or_finance(self):
        """One job, at one step. The chain is not shortened by adding a desk."""
        self.assertFalse(api_module._may_approve_as_principal(Role.RESEARCH_COORDINATOR))
        self.assertFalse(api_module._may_approve_as_director(Role.RESEARCH_COORDINATOR))
        self.assertFalse(rbac.can_approve_as_finance(Role.RESEARCH_COORDINATOR))

    def test_the_role_can_actually_be_given_to_an_account(self):
        admin = User.objects.create_user(
            email="rc-admin@test.edu", password="pass", name="RC Admin",
            role=Role.SUPER_ADMIN,
        )
        self.client.force_login(admin)
        r = self.client.patch(
            f"/api/admin/users/{self.faculty.id}",
            data=json.dumps({"role": Role.RESEARCH_COORDINATOR}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)


class GoogleSignInTests(TestCase):
    """Signing in with Google, into an account that already exists."""

    def setUp(self):
        self.person = User.objects.create_user(
            email="gs-person@test.edu", password="pass", name="GS Person",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()

    def test_it_says_it_is_off_rather_than_drawing_a_button_that_fails(self):
        with override_settings(GOOGLE_OAUTH_CLIENT_ID=""):
            body = self.client.get("/api/auth/google/config").json()
        self.assertFalse(body["enabled"])
        self.assertIsNone(body["client_id"])

    def test_it_refuses_to_verify_anything_when_it_is_not_configured(self):
        with override_settings(GOOGLE_OAUTH_CLIENT_ID=""):
            r = self.client.post(
                "/api/auth/google",
                data=json.dumps({"credential": "anything"}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 503)

    def test_an_unverifiable_token_is_refused_without_saying_why(self):
        """The reasons a token fails are useful to an attacker and useless to
        the person in front of the screen."""
        with override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id"):
            r = self.client.post(
                "/api/auth/google",
                data=json.dumps({"credential": "not.a.token"}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 401)
        self.assertNotIn("audience", r.json()["detail"].lower())
        self.assertNotIn("signature", r.json()["detail"].lower())

    def test_a_verified_google_account_we_do_not_know_is_refused(self):
        """No account is ever created. An identity here decides who gets paid."""
        claims = {"email": "a-stranger@gmail.com", "email_verified": True}
        with override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id"):
            with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
                r = self.client.post(
                    "/api/auth/google",
                    data=json.dumps({"credential": "x"}),
                    content_type="application/json",
                )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("no account", r.json()["detail"].lower())
        self.assertFalse(User.objects.filter(email="a-stranger@gmail.com").exists())

    def test_a_known_address_signs_into_the_account_that_already_has_it(self):
        claims = {"email": "gs-person@test.edu", "email_verified": True}
        with override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id"):
            with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
                r = self.client.post(
                    "/api/auth/google",
                    data=json.dumps({"credential": "x"}),
                    content_type="application/json",
                )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["email"], "gs-person@test.edu")
        self.assertTrue(
            AuditLog.objects.filter(action="LOGIN_GOOGLE", entity_id=self.person.id).exists()
        )

    def test_an_unverified_google_email_is_refused(self):
        claims = {"email": "gs-person@test.edu", "email_verified": False}
        with override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id"):
            with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
                r = self.client.post(
                    "/api/auth/google",
                    data=json.dumps({"credential": "x"}),
                    content_type="application/json",
                )
        self.assertEqual(r.status_code, 403)

    def test_an_inactive_account_cannot_be_signed_into(self):
        self.person.active = False
        self.person.save()
        claims = {"email": "gs-person@test.edu", "email_verified": True}
        with override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id"):
            with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
                r = self.client.post(
                    "/api/auth/google",
                    data=json.dumps({"credential": "x"}),
                    content_type="application/json",
                )
        self.assertEqual(r.status_code, 403)

    def test_a_hosted_domain_can_be_required(self):
        claims = {"email": "gs-person@test.edu", "email_verified": True, "hd": "elsewhere.com"}
        with override_settings(
            GOOGLE_OAUTH_CLIENT_ID="test-client-id", GOOGLE_HOSTED_DOMAIN="saveetha.ac.in"
        ):
            with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
                r = self.client.post(
                    "/api/auth/google",
                    data=json.dumps({"credential": "x"}),
                    content_type="application/json",
                )
        self.assertEqual(r.status_code, 403)
        self.assertIn("saveetha.ac.in", r.json()["detail"])


@override_settings(GOOGLE_OAUTH_CLIENT_ID="test-client-id", GOOGLE_HOSTED_DOMAIN="college.edu")
class GoogleLinkTests(TestCase):
    """Linking a Google account from a session that already signed in by password.

    Every account has an email and a password; Google is something a person
    adds afterwards. About fourteen staff have only a personal Gmail, so the
    hosted-domain rule that guards sign-in by email does not apply to a link:
    the person proved who they are with their password before choosing it.
    """

    SUB = "google-sub-1001"

    def setUp(self):
        self.person = User.objects.create_user(
            email="gl-person@college.edu", password="pass", name="GL Person",
            role=Role.FACULTY, department="CSE",
        )
        self.other = User.objects.create_user(
            email="gl-other@college.edu", password="pass", name="GL Other",
            role=Role.FACULTY, department="CSE",
        )
        self.client = Client()
        self.client.force_login(self.person)

    def claims(self, **over):
        return {
            "sub": self.SUB,
            "email": "gl.person.personal@gmail.com",
            "email_verified": True,
            **over,
        }

    def link(self, claims=None, client=None):
        with patch(
            "google.oauth2.id_token.verify_oauth2_token",
            return_value=claims if claims is not None else self.claims(),
        ):
            return (client or self.client).post(
                "/api/auth/google/link",
                data=json.dumps({"credential": "x"}),
                content_type="application/json",
            )

    def sign_in_with_google(self, claims):
        with patch("google.oauth2.id_token.verify_oauth2_token", return_value=claims):
            return Client().post(
                "/api/auth/google",
                data=json.dumps({"credential": "x"}),
                content_type="application/json",
            )

    # ---- linking ------------------------------------------------------

    def test_a_personal_gmail_can_be_linked_without_the_hosted_domain(self):
        r = self.link()
        self.assertEqual(r.status_code, 200, r.content)
        self.person.refresh_from_db()
        self.assertEqual(self.person.google_sub, self.SUB)
        self.assertEqual(self.person.google_email, "gl.person.personal@gmail.com")
        self.assertIsNotNone(self.person.google_linked_at)
        self.assertEqual(r.json()["google"]["email"], "gl.person.personal@gmail.com")
        log = AuditLog.objects.get(action="GOOGLE_LINKED", entity_id=self.person.id)
        self.assertEqual(json.loads(log.detail_json)["google_email"], "gl.person.personal@gmail.com")

    def test_me_carries_the_link_or_says_there_is_none(self):
        self.assertIsNone(self.client.get("/api/auth/me").json()["google"])
        self.link()
        google = self.client.get("/api/auth/me").json()["google"]
        self.assertEqual(google["email"], "gl.person.personal@gmail.com")
        self.assertTrue(google["linked_at"])

    def test_a_google_account_linked_to_somebody_else_is_refused(self):
        self.other.google_sub = self.SUB
        self.other.google_email = "shared@gmail.com"
        self.other.save()
        r = self.link()
        self.assertEqual(r.status_code, 409, r.content)
        # Says it is taken, never by whom.
        self.assertNotIn("gl-other", r.json()["detail"])
        self.person.refresh_from_db()
        self.assertIsNone(self.person.google_sub)
        self.assertFalse(AuditLog.objects.filter(action="GOOGLE_LINKED").exists())

    def test_somebody_else_s_college_address_cannot_be_linked(self):
        """Otherwise that colleague pressing "Continue with Google" with their
        own college account would land in this one."""
        r = self.link(self.claims(email="gl-other@college.edu", hd="college.edu"))
        self.assertEqual(r.status_code, 409, r.content)
        self.person.refresh_from_db()
        self.assertIsNone(self.person.google_sub)

    def test_an_unverified_google_email_cannot_be_linked(self):
        r = self.link(self.claims(email_verified=False))
        self.assertEqual(r.status_code, 403, r.content)
        self.person.refresh_from_db()
        self.assertIsNone(self.person.google_sub)

    def test_a_token_that_fails_to_verify_is_refused_without_saying_why(self):
        with patch(
            "google.oauth2.id_token.verify_oauth2_token",
            side_effect=ValueError("Token has wrong audience other-app"),
        ):
            r = self.client.post(
                "/api/auth/google/link",
                data=json.dumps({"credential": "x"}),
                content_type="application/json",
            )
        self.assertEqual(r.status_code, 401, r.content)
        self.assertNotIn("audience", r.json()["detail"].lower())

    def test_linking_needs_a_session(self):
        r = self.link(client=Client())
        self.assertEqual(r.status_code, 401, r.content)

    def test_linking_is_refused_while_off(self):
        with override_settings(GOOGLE_OAUTH_CLIENT_ID=""):
            r = self.link()
        self.assertEqual(r.status_code, 503, r.content)

    # ---- unlinking ----------------------------------------------------

    def test_unlinking_clears_the_link_and_is_audited(self):
        self.link()
        r = self.client.delete("/api/auth/google/link")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["google"])
        self.person.refresh_from_db()
        self.assertIsNone(self.person.google_sub)
        self.assertIsNone(self.person.google_email)
        self.assertIsNone(self.person.google_linked_at)
        log = AuditLog.objects.get(action="GOOGLE_UNLINKED", entity_id=self.person.id)
        self.assertEqual(json.loads(log.detail_json)["google_email"], "gl.person.personal@gmail.com")
        self.assertIsNone(self.client.get("/api/auth/me").json()["google"])

    def test_an_unlinked_google_account_no_longer_signs_in(self):
        self.link()
        self.client.delete("/api/auth/google/link")
        r = self.sign_in_with_google(self.claims())
        self.assertEqual(r.status_code, 403, r.content)

    # ---- signing in ---------------------------------------------------

    def test_a_linked_personal_gmail_signs_in_despite_the_hosted_domain(self):
        self.link()
        r = self.sign_in_with_google(self.claims())
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["email"], "gl-person@college.edu")
        self.assertTrue(
            AuditLog.objects.filter(action="LOGIN_GOOGLE", entity_id=self.person.id).exists()
        )

    def test_an_unlinked_gmail_outside_the_domain_is_still_refused(self):
        # Even with an email that matches an account: the email path keeps
        # the hosted-domain rule.
        r = self.sign_in_with_google(
            {"sub": "never-linked", "email": "gl-person@college.edu", "email_verified": True}
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("college.edu", r.json()["detail"])

    def test_the_college_account_still_signs_in_by_email(self):
        r = self.sign_in_with_google({
            "sub": "college-sub", "email": "gl-person@college.edu",
            "email_verified": True, "hd": "college.edu",
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["email"], "gl-person@college.edu")

    def test_a_linked_account_that_is_switched_off_cannot_sign_in(self):
        self.link()
        self.person.active = False
        self.person.save()
        r = self.sign_in_with_google(self.claims())
        self.assertEqual(r.status_code, 403, r.content)

    def test_a_viewer_impersonating_cannot_link_their_google_to_the_account(self):
        admin = User.objects.create_user(
            email="gl-admin@college.edu", password="pass", name="GL Admin",
            role=Role.SUPER_ADMIN,
        )
        ac = Client()
        ac.force_login(admin)
        ac.post(f"/api/admin/impersonate/{self.person.id}", data="{}",
                content_type="application/json")
        r = self.link(client=ac)
        self.assertEqual(r.status_code, 403, r.content)
        self.person.refresh_from_db()
        self.assertIsNone(self.person.google_sub)


# --------------------------------------------------------------------------- #
# Making a ninety-second wait legible                                          #
# --------------------------------------------------------------------------- #

from django.test import TransactionTestCase as _TransactionTestCase


def _stream_lines(response):
    """Every NDJSON event a streaming response produced, parsed."""
    body = b"".join(response.streaming_content).decode()
    return [json.loads(line) for line in body.splitlines() if line.strip()]


class VenueStreamTests(TestCase):
    """The progress channel in front of a request that takes a minute and a half.

    The model runs on this server's CPU at about four and a half tokens a
    second and nothing here changes that. What these cover is the difference
    between ninety seconds that look like work and ninety seconds that look
    like a hang: that something arrives immediately, that it keeps arriving,
    that the reader can stop it, and that stopping it is not reported as a
    fault.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            email="stream@test.edu", password="p", name="Stream", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.user)
        self.body = json.dumps({"title": "A Paper About Photovoltaic Arrays"})

    def post(self, client=None, body=None):
        return (client or self.client).post(
            "/api/discover/venues/stream",
            data=body or self.body,
            content_type="application/json",
        )

    # ---- what arrives, and when ---------------------------------------

    def test_something_arrives_before_the_model_has_answered(self):
        """The whole complaint, in one assertion.

        A screen that is told nothing until the answer is complete has no
        honest way to distinguish a slow request from a dead one, so it shows
        the same spinner for both and the reader reloads the page.
        """
        def answer(**kwargs):
            sink = ai.current_progress()
            sink.note("connecting")
            sink.note("generating", tokens=12, chars=48)
            sink.note("reading", chars=400)
            return {"journals": [], "unverified": [], "assumed": {}}

        with _model_ready(), patch.object(discover, "suggest_venues", side_effect=answer):
            events = _stream_lines(self.post())

        kinds = [e["event"] for e in events]
        self.assertEqual(kinds[0], "start")
        self.assertEqual(kinds[-1], "result")
        self.assertEqual(
            [e["phase"] for e in events if e["event"] == "step"],
            ["connecting", "generating", "reading"],
        )
        # Said up front, so the screen can promise a duration rather than
        # discovering one.
        self.assertGreater(events[0]["expected_seconds"], 0)
        self.assertEqual(events[0]["model"], "gemma4:12b")

    def test_every_event_carries_how_long_it_has_been(self):
        """Elapsed time comes from the server, not from a timer the client
        started, so a stalled connection cannot keep counting."""
        def answer(**kwargs):
            ai.current_progress().note("generating", tokens=1)
            return {"journals": [], "unverified": [], "assumed": {}}

        with _model_ready(), patch.object(discover, "suggest_venues", side_effect=answer):
            events = _stream_lines(self.post())
        for event in events[1:]:
            self.assertIn("elapsed", event)

    def test_a_search_somebody_stayed_for_is_recorded_once(self):
        with _model_ready(), patch.object(
            discover, "suggest_venues",
            return_value={"journals": [], "unverified": [], "assumed": {}},
        ):
            _stream_lines(self.post())
        self.assertEqual(AuditLog.objects.filter(action="DISCOVER_VENUES").count(), 1)

    # ---- failures ------------------------------------------------------

    def test_what_can_be_refused_is_refused_before_the_stream_starts(self):
        """A 200 that turns out to be a failure is worse than a failure.

        Everything knowable up front -- no model, a title too short to work
        with, a reader not allowed to see money -- keeps its real status,
        because once the first byte is written the status is 200 for good.
        """
        with _model_unavailable():
            self.assertEqual(self.post().status_code, 503)

        with _model_ready():
            self.assertEqual(self.post(body=json.dumps({"title": "Hi"})).status_code, 400)

        hod = User.objects.create_user(
            email="hod-stream@test.edu", password="p", name="H", role=Role.HOD
        )
        as_hod = Client()
        as_hod.force_login(hod)
        with _model_ready():
            self.assertEqual(self.post(client=as_hod).status_code, 403)

        self.assertEqual(self.post(client=Client()).status_code, 401)

    def test_a_model_that_fails_part_way_carries_its_status_in_the_body(self):
        """The headers are long gone by then, so the status travels in the
        event instead -- the same 503/502 split the plain endpoint answers,
        so one screen can read both."""
        for code, expected in (("unreachable", 503), ("timeout", 502), ("unparsable", 502)):
            with self.subTest(code=code):
                with _model_ready(), patch.object(
                    discover, "suggest_venues",
                    side_effect=ai.AIError("it did not work", code=code),
                ):
                    response = self.post()
                    events = _stream_lines(response)
                self.assertEqual(response.status_code, 200)
                failure = events[-1]
                self.assertEqual(failure["event"], "error")
                self.assertEqual(failure["status"], expected)
                self.assertEqual(failure["code"], code)

    def test_a_crash_reaches_the_reader_rather_than_hanging_the_stream(self):
        """A response that simply stops mid-stream is the same silence this
        exists to remove."""
        with _model_ready(), patch.object(
            discover, "suggest_venues", side_effect=RuntimeError("boom")
        ):
            events = _stream_lines(self.post())
        self.assertEqual(events[-1]["event"], "error")

    def test_nothing_is_recorded_for_a_search_that_failed(self):
        with _model_ready(), patch.object(
            discover, "suggest_venues",
            side_effect=ai.AIError("no", code="timeout"),
        ):
            _stream_lines(self.post())
        self.assertEqual(AuditLog.objects.filter(action="DISCOVER_VENUES").count(), 0)

    # ---- stopping ------------------------------------------------------

    def test_the_search_is_named_so_it_can_be_stopped(self):
        """A cancel has to be something the reader sends. Inferring it from
        the connection dropping does not work: measured on this server, a
        client closing a streaming connection mid-answer was never noticed,
        and the model spent another eighty-eight seconds finishing an answer
        with nowhere to go."""
        with _model_ready(), patch.object(
            discover, "suggest_venues",
            return_value={"journals": [], "unverified": [], "assumed": {}},
        ):
            events = _stream_lines(self.post())
        self.assertTrue(events[0]["token"].startswith(f"{self.user.pk}:"))

    def test_stopping_a_running_search_ends_it(self):
        import threading
        import time

        running = threading.Event()
        ended = threading.Event()

        def slow(**kwargs):
            sink = ai.current_progress()
            running.set()
            for _ in range(400):
                try:
                    sink.note("generating", tokens=1)
                except ai.Cancelled:
                    ended.set()
                    raise
                time.sleep(0.01)
            return {"journals": [], "unverified": [], "assumed": {}}

        with _model_ready(), patch.object(discover, "suggest_venues", side_effect=slow):
            response = self.post()
            stream = iter(response.streaming_content)
            start = json.loads(next(stream))
            # The run begins when the response is read, not when it is
            # returned, so take one event off it before expecting one.
            next(stream)
            self.assertTrue(running.wait(2))

            stopped = self.client.post(
                "/api/discover/venues/cancel",
                data=json.dumps({"token": start["token"]}),
                content_type="application/json",
            )
            self.assertEqual(stopped.json(), {"stopped": True})
            self.assertTrue(ended.wait(2))

            last = [json.loads(line) for line in stream if line.strip()][-1]
        self.assertEqual(last["event"], "cancelled")

    def test_a_cancelled_search_is_not_reported_as_a_failure(self):
        """Nothing went wrong; somebody changed their mind. A red panel for
        an action the reader took is a lie about their own doing."""
        with _model_ready(), patch.object(
            discover, "suggest_venues", side_effect=ai.Cancelled()
        ):
            events = _stream_lines(self.post())
        self.assertEqual(events[-1]["event"], "cancelled")
        self.assertNotIn("error", [e["event"] for e in events])

    def test_one_person_cannot_stop_another_person_search(self):
        other = User.objects.create_user(email="other-stream@test.edu", password="p", name="O")
        as_other = Client()
        as_other.force_login(other)
        r = as_other.post(
            "/api/discover/venues/cancel",
            data=json.dumps({"token": f"{self.user.pk}:whatever"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403)

    def test_stopping_something_this_worker_never_had_says_so(self):
        """With more than one worker process the cancel can land on a worker
        that never saw the run. An empty 200 would imply otherwise."""
        r = self.client.post(
            "/api/discover/venues/cancel",
            data=json.dumps({"token": f"{self.user.pk}:not-a-real-run"}),
            content_type="application/json",
        )
        self.assertEqual(r.json(), {"stopped": False})


class VenueStreamSafetyTests(_TransactionTestCase):
    """The model proposes and the database disposes, on the streaming path too.

    A `TransactionTestCase` rather than the usual kind for one specific
    reason: the resolution against our own rows now happens on a worker
    thread, so it reads through its own database connection, and data left
    uncommitted inside a test's transaction would be invisible to it. Testing
    this with the rest would have meant stubbing out the very check being
    tested.
    """

    def setUp(self):
        self.user = User.objects.create_user(
            email="stream-safe@test.edu", password="p", name="Stream", role=Role.FACULTY
        )
        self.client = Client()
        self.client.force_login(self.user)

    def post(self, body):
        return self.client.post(
            "/api/discover/venues/stream", data=body, content_type="application/json"
        )

    def test_an_invented_journal_still_arrives_without_an_amount(self):
        """The same split as the plain endpoint, because it is the same call.

        A plausible venue with a confident payout beside it is how somebody
        submits to a journal that does not exist. Streaming the wait must not
        become a second path on which that check is skipped.
        """
        ScimagoJournal.objects.create(
            source_id="1", title="Applied Soft Computing", issn="15684946", year=2025,
            sjr=1.4, categories_json=json.dumps([{"category": "Software", "quartile": "Q1"}]),
        )
        SnipSource.objects.create(
            title="Applied Soft Computing", print_issn="15684946", snip=1.831, year=2025
        )
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True,
            name="Policy v1", version=1,
        )
        reply = {
            "journals": [
                {"title": "Applied Soft Computing", "why": "fits the scope"},
                {"title": "Journal of Imaginary Widgetry", "why": "also fits"},
            ]
        }

        # The model is stubbed; everything downstream of it -- the resolution
        # against our own rows -- is the real code.
        with _model_ready(), patch.object(ai, "ask_json", return_value=reply):
            events = _stream_lines(
                self.post(json.dumps({"title": "Something About Soft Computing Methods"}))
            )

        result = [e for e in events if e["event"] == "result"][-1]["data"]
        self.assertEqual([j["title"] for j in result["journals"]], ["Applied Soft Computing"])
        self.assertIsNotNone(result["journals"][0]["payout"]["amount"])
        self.assertEqual(
            [u["title"] for u in result["unverified"]], ["Journal of Imaginary Widgetry"]
        )
        self.assertNotIn("payout", result["unverified"][0])


class InferenceProgressTests(TestCase):
    """Watching a generation, and stopping one.

    Stubbed at `urllib.request.urlopen` like the rest of the local-inference
    tests: what is under test is our handling of a stream, not Ollama's.
    """

    def _stream(self, pieces, closed=None):
        """A stand-in for Ollama's NDJSON response body."""
        import io

        lines = [json.dumps({"response": p, "done": False}) for p in pieces]
        lines.append(json.dumps({"response": "", "done": True}))

        class Body(io.BytesIO):
            def close(self):
                if closed is not None:
                    closed.append(True)
                super().close()

        return Body(("\n".join(lines) + "\n").encode())

    def _sink(self, seen, cancel_after=None):
        return ai.Progress(
            emit=seen.append,
            is_cancelled=(lambda: cancel_after is not None and len(seen) >= cancel_after),
        )

    # ---- reporting -----------------------------------------------------

    def test_a_watched_call_returns_the_same_answer_as_an_unwatched_one(self):
        """Progress is an addition to the call, never a different call. The
        answer is still assembled whole and still parsed whole, because half
        a journal name is not something to put on a screen."""
        pieces = ['{"jour', 'nals": [', '{"title": "A"}', "]}"]
        seen = []
        with patch("urllib.request.urlopen", return_value=self._stream(pieces)):
            with ai.progress_to(self._sink(seen)):
                out = ai.ask_json("anything")
        self.assertEqual(out, {"journals": [{"title": "A"}]})

    def test_it_says_it_has_connected_before_the_first_token(self):
        """The slowest part of the wait is the part before any token exists --
        a cold model is eight seconds coming off disk. Silence there is the
        whole complaint."""
        seen = []
        with patch("urllib.request.urlopen", return_value=self._stream(["{}"])):
            with ai.progress_to(self._sink(seen)):
                ai.ask_json("anything")
        self.assertEqual(seen[0]["phase"], "connecting")
        self.assertEqual(seen[-1]["phase"], "reading")

    def test_the_count_it_reports_rises(self):
        seen = []
        with patch(
            "urllib.request.urlopen",
            return_value=self._stream(["{", '"a"', ":", "1", "}"]),
        ):
            with patch.object(ai, "PROGRESS_EVERY", 0):
                with ai.progress_to(self._sink(seen)):
                    ai.ask_json("anything")
        counts = [e["tokens"] for e in seen if e["phase"] == "generating"]
        self.assertEqual(counts, sorted(counts))
        self.assertEqual(counts[-1], 5)

    def test_nothing_is_watched_when_nobody_is_watching(self):
        """The plain endpoint must keep making one unstreamed request."""
        sent = {}

        def capture(req, timeout=None):
            import io

            sent.update(json.loads(req.data.decode()))
            return io.BytesIO(json.dumps({"response": "{}"}).encode())

        with patch("urllib.request.urlopen", side_effect=capture):
            ai.ask_json("anything")
        self.assertIs(sent["stream"], False)

    # ---- the request a watched call sends ------------------------------

    def test_thinking_is_still_off_on_a_watched_call(self):
        """Gemma 4 reasons silently, and with thinking on a stream emits
        nothing at all until the reasoning finishes -- which would defeat the
        entire point of streaming, on top of returning an empty string at the
        token ceiling."""
        sent = {}

        def capture(req, timeout=None):
            sent.update(json.loads(req.data.decode()))
            return self._stream(["{}"])

        with patch("urllib.request.urlopen", side_effect=capture):
            with ai.progress_to(self._sink([])):
                ai.ask_json("anything")
        self.assertIs(sent["think"], False)
        self.assertIs(sent["stream"], True)

    def test_the_schema_still_constrains_a_watched_call(self):
        """Streaming and structured output are not alternatives. A local model
        this size needs the decoder held to the shape."""
        sent = {}
        schema = {"type": "object", "properties": {"journals": {"type": "array"}}}

        def capture(req, timeout=None):
            sent.update(json.loads(req.data.decode()))
            return self._stream(['{"journals": []}'])

        with patch("urllib.request.urlopen", side_effect=capture):
            with ai.progress_to(self._sink([])):
                ai.ask_json("anything", schema=schema)
        self.assertEqual(sent["format"], schema)

    def test_a_watched_call_is_still_bounded(self):
        seen = {}

        def capture(req, timeout=None):
            seen["timeout"] = timeout
            return self._stream(["{}"])

        with patch("urllib.request.urlopen", side_effect=capture):
            with ai.progress_to(self._sink([])):
                ai.ask_json("anything")
        self.assertIsNotNone(seen["timeout"])

    # ---- stopping ------------------------------------------------------

    def test_cancelling_closes_the_connection_to_the_model(self):
        """The point of a cancel button. Without the close, Ollama spends the
        next minute finishing an answer nobody will read, on the four cores
        the next request needs."""
        closed = []
        seen = []
        with patch(
            "urllib.request.urlopen",
            return_value=self._stream(["a", "b", "c", "d"], closed=closed),
        ):
            with patch.object(ai, "PROGRESS_EVERY", 0):
                with ai.progress_to(self._sink(seen, cancel_after=2)):
                    with self.assertRaises(ai.Cancelled):
                        ai.ask_json("anything")
        self.assertTrue(closed)

    def test_a_cancelled_call_is_not_a_failure(self):
        """It has no error to show and no retry to offer. Reporting it as one
        puts a red panel on the screen for something the reader did."""
        self.assertFalse(issubclass(ai.Cancelled, ai.AIError))

    def test_abandoning_the_run_cancels_it(self):
        """A browser going away is not a message anybody sends; it is a write
        that fails. So the run has to be cancelled by the consumer simply
        stopping, which is what closing the generator does."""
        import threading
        import time as _time

        started = threading.Event()
        noticed = threading.Event()

        def slow(**kwargs):
            sink = ai.current_progress()
            started.set()
            for _ in range(400):
                try:
                    sink.note("generating", tokens=1)
                except ai.Cancelled:
                    noticed.set()
                    raise
                _time.sleep(0.01)
            return {"journals": []}

        run = ai.run_with_progress(slow)
        next(run)
        self.assertTrue(started.wait(2))
        run.close()
        self.assertTrue(noticed.wait(2))

    def test_a_run_that_finishes_hands_back_its_answer(self):
        events = list(ai.run_with_progress(lambda **kw: {"journals": ["x"]}))
        self.assertEqual(events[-1], ("result", {"journals": ["x"]}))

    def test_a_run_that_stalls_still_says_something(self):
        """The heartbeat. It keeps the reader's clock honest while the model
        is loading, and it is how the server finds out the browser has gone."""
        import time as _time

        def slow(**kwargs):
            _time.sleep(0.2)
            return {}

        with patch.object(ai, "_HEARTBEAT", 0.01):
            kinds = [kind for kind, _ in ai.run_with_progress(slow)]
        self.assertIn("tick", kinds)
        self.assertEqual(kinds[-1], "result")


# =========================================================================== #
# Trends: what the college is working on, and what a model may add to that    #
# =========================================================================== #


class CollegeLandscapeTests(TestCase):
    """The measured half. It has to be exact, and it has to work with no model.

    This is the part of the trends feature that is allowed no excuses: it is
    counted from our own claims, so a wrong number here is a wrong number the
    software had every means to get right. The tests are about the arithmetic
    and about the window it is computed over -- both of which are invisible on
    screen, where a fading area and a growing one look the same until somebody
    reads the figure.
    """

    def setUp(self):
        from core.services import trends

        self.trends = trends
        self.cse = User.objects.create_user(
            email="cse@test.edu", password="p", name="Ada Rao",
            role=Role.FACULTY, department="CSE", designation="Professor",
        )
        self.ece = User.objects.create_user(
            email="ece@test.edu", password="p", name="Biju Menon",
            role=Role.FACULTY, department="ECE", designation="Assistant Professor",
        )

        def paper(owner, year, subjects, journal="Applied Soft Computing", quartile="Q1",
                  status=ClaimStatus.PAID, title=None):
            return Claim.objects.create(
                owner=owner, status=status,
                paper_title=title or f"{subjects} {year}",
                journal_title=journal, publication_year=year,
                subjects_json=subjects, quartile=quartile,
            )

        # Machine Learning is growing: one paper then, four now.
        paper(self.cse, 2020, "Machine Learning (Q1)")
        for year in (2023, 2024, 2025):
            paper(self.cse, year, "Machine Learning (Q1); Software (Q2)")
        paper(self.ece, 2025, "Machine Learning (Q1)")

        # Signal Processing is fading: four then, one now.
        for year in (2020, 2021, 2021, 2022):
            paper(self.ece, year, "Signal Processing (Q2)", journal="Signal Journal", quartile="Q2")
        paper(self.ece, 2023, "Signal Processing (Q2)", journal="Signal Journal", quartile="Q2")

        # Ceramics stopped entirely -- it never appears in the recent window.
        for year in (2020, 2021, 2022):
            paper(self.cse, year, "Ceramics and Composites (Q3)", journal="Ceramics Today", quartile="Q3")

        # A draft is not published work and must not be counted anywhere.
        paper(self.cse, 2025, "Quantum Widgetry (Q1)", status=ClaimStatus.DRAFT,
              title="Secret Draft")

    def test_the_window_ends_where_the_data_ends(self):
        """Not where the calendar does.

        A college that files its 2025 papers through 2026 would otherwise open
        this page in January and be told every area it has is fading.
        """
        window = self.trends.current_window()
        self.assertEqual(window.latest, 2025)
        self.assertEqual(window.recent_from, 2023)
        self.assertEqual(window.prior_from, 2020)
        self.assertEqual(window.prior_to, 2022)

    def test_areas_are_counted_from_filed_papers(self):
        out = self.trends.college_landscape()
        by_area = {a["area"]: a for a in out["areas"]}
        self.assertEqual(by_area["Machine Learning"]["papers"], 4)
        self.assertEqual(by_area["Machine Learning"]["prior"], 1)
        self.assertEqual(by_area["Software"]["papers"], 3)
        # Two departments publish in it, and both are named.
        self.assertEqual(sorted(by_area["Machine Learning"]["departments"]), ["CSE", "ECE"])
        self.assertEqual(by_area["Machine Learning"]["people"], 2)

    def test_a_draft_is_counted_nowhere(self):
        """An unfiled ticket is a private intention, not a college trend."""
        out = self.trends.college_landscape()
        self.assertNotIn("Quantum Widgetry", [a["area"] for a in out["areas"]])
        # Three from CSE and two from ECE in 2023-2025. The 2025 draft is a
        # sixth row in the table and is not one of them.
        self.assertEqual(out["totals"]["papers"], 5)

    def test_growing_and_fading_are_told_apart(self):
        out = self.trends.college_landscape()
        self.assertIn("Machine Learning", [a["area"] for a in out["rising"]])
        self.assertIn("Signal Processing", [a["area"] for a in out["fading"]])

    def test_an_area_that_stopped_entirely_is_still_reported_as_fading(self):
        """The case somebody opening this page most wants to know about.

        It has no recent papers at all, so it appears in no recent count --
        and would silently vanish rather than be reported as gone.
        """
        out = self.trends.college_landscape()
        gone = [a for a in out["fading"] if a["area"] == "Ceramics and Composites"]
        self.assertEqual(len(gone), 1)
        self.assertEqual(gone[0]["papers"], 0)
        self.assertEqual(gone[0]["prior"], 3)

    def test_one_paper_of_difference_is_not_a_trend(self):
        out = self.trends.college_landscape()
        by_area = {a["area"]: a for a in out["areas"]}
        # Software: 3 recent, 0 prior -- new. Nothing here moves by one, and
        # the classifier must not invent a direction out of noise.
        self.assertEqual(by_area["Software"]["trend"], "new")
        self.assertEqual(self.trends._trend(4, 3), "steady")
        self.assertEqual(self.trends._trend(3, 4), "steady")

    def test_a_department_reports_what_it_is_moving_into(self):
        out = self.trends.college_landscape()
        cse = next(d for d in out["departments"] if d["department"] == "CSE")
        self.assertIn("Machine Learning", [m["area"] for m in cse["moving_into"]])
        self.assertNotIn("Ceramics and Composites", [m["area"] for m in cse["moving_into"]])

    def test_journals_are_counted_over_the_recent_window_only(self):
        out = self.trends.college_landscape()
        by_journal = {j["title"]: j for j in out["journals"]}
        self.assertEqual(by_journal["Applied Soft Computing"]["papers"], 4)
        self.assertEqual(by_journal["Applied Soft Computing"]["quartile"], "Q1")
        self.assertNotIn("Ceramics Today", by_journal)

    def test_the_landscape_carries_no_money_of_any_kind(self):
        """A head of department may read this page, and money-blindness is the
        one rule in this system that is not a matter of taste."""
        from core import hod

        def walk(node, path="body"):
            if isinstance(node, dict):
                for k, v in node.items():
                    self.assertNotIn(k, hod.MONEY_KEYS, f"{path}.{k} carries money")
                    walk(v, f"{path}.{k}")
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, f"{path}[{i}]")

        walk(self.trends.college_landscape())
        walk(self.trends.people_to_work_with(self.cse))

    def test_the_measured_half_never_asks_the_model(self):
        """The whole reason it is a separate function from the suggestions."""
        with patch("core.services.trends.ai.ask_json") as asked:
            self.trends.college_landscape()
            self.trends.people_to_work_with(self.cse)
            asked.assert_not_called()

    def test_an_empty_college_is_an_empty_answer_and_not_a_crash(self):
        Claim.objects.all().delete()
        out = self.trends.college_landscape()
        self.assertEqual(out["areas"], [])
        self.assertEqual(out["totals"]["papers"], 0)

    def test_a_sentinel_is_not_reported_as_a_quartile(self):
        """Claims carry "NO QUARTILE" and "OTHERS" as well as Q1-Q4, and both
        are in the live data. Printing one in a column headed "quartile" is
        worse than printing nothing."""
        Claim.objects.create(
            owner=self.cse, status=ClaimStatus.PAID, paper_title="Sentinel",
            journal_title="Aip Conference Proceedings", publication_year=2025,
            subjects_json="Physics (Q1)", quartile="NO QUARTILE",
        )
        out = self.trends.college_landscape()
        row = next(j for j in out["journals"] if j["title"] == "Aip Conference Proceedings")
        self.assertIsNone(row["quartile"])

    def test_an_earlier_window_too_thin_to_compare_withholds_every_direction(self):
        """Found against the live data, and it is the whole point of the flag.

        This college holds 3,028 papers in 2024-2026 and 140 in 2021-2023,
        because the import only reaches back so far. The arithmetic then calls
        all 193 subject areas growing and none fading -- which is not a trend,
        it is the shape of the import showing through.
        """
        Claim.objects.filter(publication_year__lt=2023).delete()
        for n in range(40):
            Claim.objects.create(
                owner=self.cse, status=ClaimStatus.PAID, paper_title=f"Bulk {n}",
                journal_title="Applied Soft Computing", publication_year=2025,
                subjects_json="Machine Learning (Q1)", quartile="Q1",
            )
        out = self.trends.college_landscape()
        self.assertFalse(out["totals"]["comparable"])
        self.assertIn("reach of the import", out["totals"]["not_comparable_why"])
        self.assertEqual(out["rising"], [])
        self.assertEqual(out["fading"], [])
        self.assertTrue(all(a["trend"] == "unknown" for a in out["areas"]))
        # The counts themselves are facts and still stand.
        by_area = {a["area"]: a for a in out["areas"]}
        self.assertEqual(by_area["Machine Learning"]["papers"], 44)

    def test_a_populated_earlier_window_is_compared_against(self):
        out = self.trends.college_landscape()
        self.assertTrue(out["totals"]["comparable"])
        self.assertIsNone(out["totals"]["not_comparable_why"])


class WhoToWorkWithTests(TestCase):
    """Everybody named is a row in our own User table, and the overlap is counted."""

    def setUp(self):
        from core.services import trends

        self.trends = trends
        self.me = User.objects.create_user(
            email="me@test.edu", password="p", name="Ada Rao", department="CSE"
        )
        self.near = User.objects.create_user(
            email="near@test.edu", password="p", name="Biju Menon",
            department="ECE", designation="Professor",
        )
        self.far = User.objects.create_user(
            email="far@test.edu", password="p", name="Chandra Iyer", department="MECH"
        )
        self.gone = User.objects.create_user(
            email="gone@test.edu", password="p", name="Deepa Nair", department="CSE"
        )
        self.gone.active = False
        self.gone.save(update_fields=["active"])

        def paper(owner, year, subjects, status=ClaimStatus.PAID, title="A Paper"):
            return Claim.objects.create(
                owner=owner, status=status, paper_title=title,
                journal_title="Applied Soft Computing", publication_year=year,
                subjects_json=subjects, quartile="Q1",
            )

        paper(self.me, 2025, "Machine Learning (Q1)")
        paper(self.near, 2025, "Machine Learning (Q1)", title="Nearby Work")
        paper(self.near, 2024, "Machine Learning (Q1); Software (Q2)")
        paper(self.far, 2025, "Ceramics and Composites (Q3)")
        paper(self.gone, 2025, "Machine Learning (Q1)")
        # Old enough to be outside the recent window: somebody who worked on
        # this six years ago is not somebody to start a project with now.
        paper(self.near, 2019, "Machine Learning (Q1)", title="Ancient")

    def test_overlap_comes_from_published_areas(self):
        out = self.trends.people_to_work_with(self.me)
        names = [p["name"] for p in out["people"]]
        self.assertIn("Biju Menon", names)
        self.assertNotIn("Chandra Iyer", names)
        self.assertNotIn("Ada Rao", names, "nobody is their own collaborator")

    def test_an_inactive_account_is_not_offered_as_a_collaborator(self):
        out = self.trends.people_to_work_with(self.me)
        self.assertNotIn("Deepa Nair", [p["name"] for p in out["people"]])

    def test_only_recent_output_counts(self):
        out = self.trends.people_to_work_with(self.me)
        biju = next(p for p in out["people"] if p["name"] == "Biju Menon")
        self.assertEqual(biju["papers"], 2)
        self.assertEqual(biju["recent"]["title"], "Nearby Work")

    def test_a_stated_interest_matches_somebody_with_no_papers_of_your_own(self):
        """A new lecturer has no co-authors and no history. Without this they
        see an empty screen forever."""
        from core.models import ResearchInterest

        fresh = User.objects.create_user(
            email="fresh@test.edu", password="p", name="Esha Pillai", department="CSE"
        )
        ResearchInterest.objects.create(user=fresh, domain="Machine Learning")
        out = self.trends.people_to_work_with(fresh)
        biju = next(p for p in out["people"] if p["name"] == "Biju Menon")
        self.assertEqual(biju["shared_interests"], ["Machine Learning"])
        self.assertEqual(biju["shared_areas"], [])

    def test_knowing_nothing_about_somebody_says_so_rather_than_going_quiet(self):
        blank = User.objects.create_user(
            email="blank@test.edu", password="p", name="Faiz Khan", department="CSE"
        )
        out = self.trends.people_to_work_with(blank)
        self.assertEqual(out["people"], [])
        self.assertIn("File a paper", out["why_empty"])

    def test_nobody_nearby_is_a_different_sentence_from_nothing_known(self):
        """Nobody works on this here, and we do not know what you work on, have
        different remedies -- so they are never the same sentence."""
        alone = User.objects.create_user(
            email="alone@test.edu", password="p", name="Gita Bose", department="CIVIL"
        )
        Claim.objects.create(
            owner=alone, status=ClaimStatus.PAID, paper_title="Solo",
            journal_title="J", publication_year=2025,
            subjects_json="Hydrology (Q4)", quartile="Q4",
        )
        out = self.trends.people_to_work_with(alone)
        self.assertEqual(out["people"], [])
        self.assertIn("Nobody else here", out["why_empty"])


class TrendSuggestionGroundingTests(TestCase):
    """The model's half, and the seam it is held behind.

    It may write prose. It may point at an area and at a colleague. It may not
    assert either, so both are looked up in our own tables before anything is
    shown -- and what does not resolve comes back bare, in its own block, with
    no count and no link beside it. A confidently named colleague who does not
    work here is the exact failure this shape exists to survive.
    """

    def setUp(self):
        from core.services import trends

        self.trends = trends
        self.me = User.objects.create_user(
            email="me2@test.edu", password="p", name="Ada Rao", department="CSE"
        )
        self.real = User.objects.create_user(
            email="real@test.edu", password="p", name="Biju Menon", department="ECE"
        )
        for year in (2024, 2025):
            Claim.objects.create(
                owner=self.me, status=ClaimStatus.PAID,
                paper_title=f"Learning Something {year}",
                journal_title="Applied Soft Computing", publication_year=year,
                subjects_json="Machine Learning (Q1)", quartile="Q1",
            )
        Claim.objects.create(
            owner=self.real, status=ClaimStatus.PAID, paper_title="Nearby",
            journal_title="Applied Soft Computing", publication_year=2025,
            subjects_json="Machine Learning (Q1)", quartile="Q1",
        )

    def _reply(self, openings):
        return patch("core.services.trends.ai.ask_json", return_value={"openings": openings})

    def test_a_colleague_the_model_invented_is_dropped_and_reported_separately(self):
        """The property the whole design rests on."""
        reply = [
            {
                "topic": "Federated learning on campus data",
                "why": "builds on your 2025 work",
                "first_step": "write a one-page protocol",
                "area": "Machine Learning",
                "with_whom": "Biju Menon",
            },
            {
                "topic": "Quantum widget scheduling",
                "why": "adjacent",
                "first_step": "read three papers",
                "area": "Machine Learning",
                "with_whom": "Dr Zephyr Quillbottom",
            },
        ]
        with self._reply(reply):
            out = self.trends.suggest_openings(user=self.me)

        first, second = out["openings"][0], out["openings"][1]
        self.assertEqual(first["with_whom"]["id"], self.real.id)
        self.assertEqual(first["with_whom"]["department"], "ECE")

        self.assertIsNone(second["with_whom"], "an invented person is never a link")
        self.assertEqual(out["unverified"]["people"], ["Dr Zephyr Quillbottom"])

    def test_an_unverified_name_carries_no_numbers(self):
        with self._reply(
            [{"topic": "T", "why": "W", "first_step": "S", "with_whom": "Nobody At All"}]
        ):
            out = self.trends.suggest_openings(user=self.me)
        # A bare string, deliberately: there is nothing to attach a count to.
        self.assertEqual(out["unverified"]["people"], ["Nobody At All"])
        self.assertTrue(all(isinstance(n, str) for n in out["unverified"]["people"]))

    def test_an_honorific_does_not_stop_a_real_person_resolving(self):
        with self._reply(
            [{"topic": "T", "why": "W", "first_step": "S", "with_whom": "Dr. Biju Menon"}]
        ):
            out = self.trends.suggest_openings(user=self.me)
        self.assertEqual(out["openings"][0]["with_whom"]["id"], self.real.id)

    def test_a_title_with_no_space_after_it_still_resolves(self):
        """Found by running the real model against the real staff list.

        Names here are stored as "Dr.G.NaliniPriya" -- no space -- and a model
        handed one to copy writes "Dr. G.NaliniPriya". Requiring the space
        stripped the title from one side only, so a colleague the model had
        been given by name came back unverified. The failure was in the safe
        direction, which is exactly why nothing noticed it.
        """
        real = User.objects.create_user(
            email="nospace@test.edu", password="p", name="Dr.G.NaliniPriya",
            department="IT",
        )
        with self._reply(
            [{"topic": "T", "why": "W", "first_step": "S", "with_whom": "Dr. G.NaliniPriya"}]
        ):
            out = self.trends.suggest_openings(user=self.me)
        self.assertEqual(out["openings"][0]["with_whom"]["id"], real.id)
        self.assertEqual(out["unverified"]["people"], [])

    def test_two_colleagues_of_the_same_name_resolve_to_neither(self):
        """A suggestion that sends somebody to the wrong colleague of the same
        name is worse than one that names nobody."""
        User.objects.create_user(email="twin@test.edu", password="p", name="Biju Menon")
        with self._reply(
            [{"topic": "T", "why": "W", "first_step": "S", "with_whom": "Biju Menon"}]
        ):
            out = self.trends.suggest_openings(user=self.me)
        self.assertIsNone(out["openings"][0]["with_whom"])
        self.assertEqual(out["unverified"]["people"], ["Biju Menon"])

    def test_an_area_the_model_invented_carries_no_count(self):
        with self._reply(
            [
                {"topic": "A", "why": "W", "first_step": "S", "area": "Machine Learning"},
                {"topic": "B", "why": "W", "first_step": "S", "area": "Advanced Quantum Widgetry"},
            ]
        ):
            out = self.trends.suggest_openings(user=self.me)
        self.assertEqual(out["openings"][0]["area"]["name"], "Machine Learning")
        self.assertEqual(out["openings"][0]["area"]["papers"], 3)
        self.assertIsNone(out["openings"][1]["area"])
        self.assertEqual(out["unverified"]["areas"], ["Advanced Quantum Widgetry"])

    def test_the_reader_is_never_suggested_as_their_own_collaborator(self):
        with self._reply(
            [{"topic": "T", "why": "W", "first_step": "S", "with_whom": "Ada Rao"}]
        ):
            out = self.trends.suggest_openings(user=self.me)
        self.assertIsNone(out["openings"][0]["with_whom"])

    def test_a_bare_array_from_the_model_is_still_read(self):
        """A model this size sometimes answers with the array rather than the
        object it was asked for. Calling `.get` on that is a 500 where a shrug
        would do."""
        with patch(
            "core.services.trends.ai.ask_json",
            return_value=[{"topic": "T", "why": "W", "first_step": "S"}],
        ):
            out = self.trends.suggest_openings(user=self.me)
        self.assertEqual(out["openings"][0]["topic"], "T")

    def test_nothing_to_go_on_says_so_rather_than_asking_the_model(self):
        blank = User.objects.create_user(email="b2@test.edu", password="p", name="Blank")
        with patch("core.services.trends.ai.ask_json") as asked:
            out = self.trends.suggest_openings(user=blank)
            asked.assert_not_called()
        self.assertEqual(out["openings"], [])
        self.assertIn("nothing of yours to build on", out["note"])

    def test_what_it_was_grounded_on_comes_back_with_the_answer(self):
        """A thin answer is usually a thin history rather than a bad model,
        and a reader cannot tell those apart unless the screen says which."""
        with self._reply([{"topic": "T", "why": "W", "first_step": "S"}]):
            out = self.trends.suggest_openings(user=self.me)
        self.assertEqual(out["grounded_on"]["papers"], 2)
        self.assertIn("Biju Menon", out["grounded_on"]["colleagues_offered"])

    def test_a_model_failure_is_raised_for_the_caller_to_map(self):
        """Never swallowed into an empty list: a feature that silently
        produces nothing looks exactly like one nobody switched on."""
        with patch(
            "core.services.trends.ai.ask_json",
            side_effect=ai.AIError("nope", code="timeout"),
        ):
            with self.assertRaises(ai.AIError):
                self.trends.suggest_openings(user=self.me)


class TrendsDegradeHonestlyTests(TestCase):
    """With no model at all, the counted half still answers and the page says why."""

    def setUp(self):
        from core.services import trends

        self.trends = trends
        self.me = User.objects.create_user(
            email="deg@test.edu", password="p", name="Ada Rao", department="CSE"
        )
        Claim.objects.create(
            owner=self.me, status=ClaimStatus.PAID, paper_title="A Paper",
            journal_title="Applied Soft Computing", publication_year=2025,
            subjects_json="Machine Learning (Q1)", quartile="Q1",
        )

    def test_status_says_which_way_it_is_off_and_what_fixes_it(self):
        with _model_unavailable(code="model_missing", detail="gemma4:12b is not installed."):
            state = self.trends.status()
        self.assertFalse(state["available"])
        self.assertEqual(state["code"], "model_missing")
        self.assertIn("not installed", state["detail"])

    def test_status_is_ready_when_the_model_is(self):
        with _model_ready():
            self.assertTrue(self.trends.status()["available"])

    def test_a_health_probe_that_itself_fails_does_not_take_the_page_down(self):
        with patch.object(ai, "health", side_effect=OSError("socket")):
            state = self.trends.status()
        self.assertFalse(state["available"])
        self.assertEqual(state["code"], "error")

    def test_the_counted_half_answers_with_no_model_anywhere(self):
        with _model_unavailable():
            landscape = self.trends.college_landscape()
            people = self.trends.people_to_work_with(self.me)
        self.assertEqual(landscape["totals"]["papers"], 1)
        self.assertEqual([a["area"] for a in landscape["areas"]], ["Machine Learning"])
        self.assertEqual(people["people"], [])

    def test_the_overview_still_answers_in_full_with_the_model_off(self):
        """The whole point of the split: the counted half is one request that
        does not touch the model, and it carries the reason the other half is
        unavailable so the page can say so without asking again."""
        with _model_unavailable(code="service_down", detail="No local model service."), patch(
            "core.services.trends.ai.ask_json"
        ) as asked:
            out = self.trends.overview(self.me)
            asked.assert_not_called()
        self.assertEqual(out["college"]["totals"]["papers"], 1)
        self.assertIn("people", out["people"])
        self.assertFalse(out["ai"]["available"])
        self.assertEqual(out["ai"]["code"], "service_down")
