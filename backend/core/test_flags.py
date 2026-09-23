"""Discrepancy flags, looking into the past, and reading the files.

The product owner's rule (2026-09-23): a discrepancy never stops a payment.
A flagged claim moves through the chain and can be paid; the flag rides along
and is seen by the research cell, the coordinator, the Principal and the super
admin -- never by the Director or Finance (the same rule as the contested
payment-history match), and never by the claimant. When a flagged claim is
paid, or a flag is raised on one already paid, the super admin is told.

The same reviewers can open any claim in the college's history, paid and
imported ones included, and flag it. Every PDF on a filed claim is read and
compared with what the claim says; a paper whose title or DOI is not in its
own file, or which has no text to read at all, is flagged automatically.
"""
from __future__ import annotations

import io
import json
import shutil
import tempfile
from datetime import date

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.management import call_command
from django.test import override_settings
from django.utils import timezone

from core.models import (
    AttachmentCheck,
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAttachment,
    ClaimFlag,
    ClaimReason,
    ClaimStatus,
    Notification,
    PaidLedger,
    Role,
    User,
)
from core.test_chain_rules import ChainBase, _keys_anywhere
from core.tests import _sec_reference_attachments

#: Every key a flag or a file check travels under. None may reach a seat that
#: is not a reviewer's.
FLAG_KEYS = {"flags", "open_flags", "file_checks"}
SENTINEL = "FLAGSENTINEL the SNIP on the ticket is not the journal's"


def _pdf(*lines: str) -> bytes:
    """A one-page PDF with a real text layer."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    page = canvas.Canvas(buf, pagesize=A4)
    y = 800
    for line in lines:
        page.drawString(40, y, line)
        y -= 16
    page.showPage()
    page.save()
    return buf.getvalue()


def _scanned_pdf() -> bytes:
    """A page with marks on it and no text layer -- what a scanner produces."""
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    page = canvas.Canvas(buf)
    page.rect(40, 40, 400, 600, fill=1)
    page.showPage()
    page.save()
    return buf.getvalue()


TITLE = "Deep Learning Methods for Crop Yield Prediction in Coastal Districts"
DOI = "10.1016/j.compag.2026.109876"


def _matching_paper(owner_name: str = "Asha Faculty") -> bytes:
    return _pdf(
        TITLE,
        f"{owner_name}, Department of CSE, Saveetha Engineering College, Chennai",
        "Computers and Electronics in Agriculture, ISSN 0168-1699",
        f"https://doi.org/{DOI}",
    )


class MediaMixin:
    """Real files in a throwaway MEDIA_ROOT, because the check reads bytes."""

    def setUp(self):
        super().setUp()
        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=media)
        override.enable()
        self.addCleanup(override.disable)

    def _store(self, data: bytes, stem: str) -> str:
        name = f"{stem * (32 // len(stem))}"[:32]
        default_storage.save(f"claims/{name}.pdf", ContentFile(data))
        return f"/media/claims/{name}.pdf"

    def _attach(self, claim, data: bytes, stem: str, kind=AttachmentKind.PUBLISHED_PAPER, **extra):
        url = self._store(data, stem)
        return ClaimAttachment.objects.create(
            claim=claim, kind=kind, url=url, filename=f"{stem}.pdf",
            size_bytes=len(data), **extra,
        )


class FlagBase(ChainBase):
    def _flag(self, user, claim, kind="AMOUNT", note=SENTINEL):
        return self._post(user, f"/api/claims/{claim.id}/flags", {"kind": kind, "note": note})

    def _paid(self, ticket="FG-P", **extra):
        claim = self._claim(
            ClaimStatus.PAID, ticket=ticket,
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
            paid_at=timezone.now(), **extra,
        )
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 9, 1), amount=claim.remuneration or 0,
            faculty_name=self.faculty.name, voucher_number=f"V-{ticket}",
        )
        return claim


# --------------------------------------------------------------------------- #
# 1. Raising and resolving                                                    #
# --------------------------------------------------------------------------- #


class RaiseAndResolveTests(FlagBase):
    def test_each_reviewer_may_raise_a_flag(self):
        claim = self._claim(ticket="FG-R1")
        for who in (self.cell, self.coordinator, self.principal, self.admin):
            r = self._flag(who, claim, note=f"Raised by {who.role}: check the SNIP")
            self.assertEqual(r.status_code, 200, f"{who.role}: {r.content}")
            body = r.json()
            self.assertEqual(body["kind"], "AMOUNT")
            self.assertEqual(body["source"], "MANUAL")
            self.assertTrue(body["open"])
            self.assertEqual(body["raised_by_name"], who.name)
        self.assertEqual(ClaimFlag.objects.filter(claim=claim).count(), 4)

    def test_nobody_else_may(self):
        claim = self._claim(ticket="FG-R2")
        for who in (self.faculty, self.hod, self.director, self.finance):
            r = self._flag(who, claim)
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")
        self.assertFalse(ClaimFlag.objects.exists())

    def test_a_flag_needs_a_known_kind_and_a_real_note(self):
        claim = self._claim(ticket="FG-R3")
        self.assertEqual(self._flag(self.cell, claim, kind="NONSENSE").status_code, 400)
        self.assertEqual(self._flag(self.cell, claim, note="bad").status_code, 400)
        self.assertFalse(ClaimFlag.objects.exists())

    def test_a_draft_cannot_be_flagged_because_nobody_else_can_see_it(self):
        draft = self._claim(ClaimStatus.DRAFT, ticket=None)
        self.assertEqual(self._flag(self.admin, draft).status_code, 404)

    def test_raising_and_resolving_are_both_audited(self):
        claim = self._claim(ticket="FG-R4")
        flag_id = self._flag(self.principal, claim).json()["id"]
        r = self._post(self.admin, f"/api/flags/{flag_id}/resolve", {"note": "Checked against Scopus: fine"})
        self.assertEqual(r.status_code, 200, r.content)
        flag = ClaimFlag.objects.get(pk=flag_id)
        self.assertIsNotNone(flag.resolved_at)
        self.assertEqual(flag.resolved_by, self.admin)
        self.assertEqual(flag.resolution_note, "Checked against Scopus: fine")
        actions = list(
            AuditLog.objects.filter(entity="ClaimFlag", entity_id=flag_id)
            .order_by("created_at")
            .values_list("action", "actor")
        )
        self.assertEqual(
            actions, [("CLAIM_FLAG_RAISE", self.principal.id), ("CLAIM_FLAG_RESOLVE", self.admin.id)]
        )

    def test_resolving_needs_a_note_and_happens_once(self):
        claim = self._claim(ticket="FG-R5")
        flag_id = self._flag(self.cell, claim).json()["id"]
        self.assertEqual(
            self._post(self.cell, f"/api/flags/{flag_id}/resolve", {"note": "ok"}).status_code, 400
        )
        self.assertEqual(
            self._post(self.cell, f"/api/flags/{flag_id}/resolve", {"note": "Publisher confirmed it"}).status_code,
            200,
        )
        self.assertEqual(
            self._post(self.cell, f"/api/flags/{flag_id}/resolve", {"note": "Publisher confirmed it"}).status_code,
            409,
        )
        for who in (self.director, self.finance, self.faculty):
            r = self._post(who, f"/api/flags/{flag_id}/resolve", {"note": "Publisher confirmed it"})
            self.assertEqual(r.status_code, 403, who.role)


# --------------------------------------------------------------------------- #
# 2. A flag never blocks the chain or the payment                             #
# --------------------------------------------------------------------------- #


class FlagsDoNotBlockTests(FlagBase):
    def test_a_flagged_paper_goes_all_the_way_to_paid(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="FG-B1")
        self.assertEqual(self._flag(self.cell, claim, kind="CONTENT_MISMATCH").status_code, 200)
        amount = {"expected_amount": claim.remuneration}
        for who, verb in (
            (self.cell, "clear"),
            (self.principal, "principal-approve"),
            (self.director, "director-approve"),
            (self.finance, "mark-paid"),
        ):
            r = self._post(who, f"/api/claims/{claim.id}/{verb}", amount)
            self.assertEqual(r.status_code, 200, f"{who.role} {verb}: {r.content}")
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertEqual(claim.ledger_rows.count(), 1)
        self.assertTrue(ClaimFlag.objects.get(claim=claim).resolved_at is None, "the flag rides along")

    def test_bulk_payment_pays_a_flagged_paper_too(self):
        claim = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket="FG-B2",
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
        )
        self._flag(self.principal, claim)
        r = self._post(
            self.finance, "/api/admin/bulk-mark-paid",
            {"items": [{"claim_id": claim.id, "expected_amount": claim.remuneration}]},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["paid"], 1, r.content)


# --------------------------------------------------------------------------- #
# 3. The super admin is told                                                  #
# --------------------------------------------------------------------------- #


class SuperAdminIsToldTests(FlagBase):
    def _admin_notes(self):
        return Notification.objects.filter(user=self.admin)

    def test_paying_a_flagged_claim_tells_the_super_admin(self):
        claim = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket="FG-N1",
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
        )
        self._flag(self.cell, claim)
        r = self._post(
            self.finance, f"/api/claims/{claim.id}/mark-paid",
            {"expected_amount": claim.remuneration},
        )
        self.assertEqual(r.status_code, 200, r.content)
        notes = list(self._admin_notes())
        paid_notes = [n for n in notes if "FG-N1" in n.title and "paid" in n.title.lower()]
        self.assertEqual(len(paid_notes), 1, [n.title for n in notes])
        self.assertIn("/flags", paid_notes[0].href)
        self.assertEqual(paid_notes[0].claim_id, claim.id)

    def test_paying_an_unflagged_claim_does_not(self):
        claim = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket="FG-N2",
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
        )
        self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", {"expected_amount": claim.remuneration})
        self.assertFalse(self._admin_notes().filter(title__icontains="flag").exists())

    def test_a_resolved_flag_does_not_count(self):
        claim = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket="FG-N3",
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
        )
        flag_id = self._flag(self.cell, claim).json()["id"]
        self._post(self.cell, f"/api/flags/{flag_id}/resolve", {"note": "Checked with the publisher"})
        self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", {"expected_amount": claim.remuneration})
        self.assertFalse(self._admin_notes().filter(title__icontains="flag").exists())

    def test_flagging_a_claim_already_paid_tells_the_super_admin(self):
        claim = self._paid("FG-N4")
        self._flag(self.principal, claim)
        notes = self._admin_notes().filter(title__icontains="FG-N4")
        self.assertEqual(notes.count(), 1)
        self.assertIn("/flags", notes.get().href)

    def test_flagging_an_unpaid_claim_does_not(self):
        claim = self._claim(ticket="FG-N5")
        self._flag(self.principal, claim)
        self.assertFalse(self._admin_notes().filter(title__icontains="FG-N5").exists())


# --------------------------------------------------------------------------- #
# 4. Who sees a flag                                                          #
# --------------------------------------------------------------------------- #


class FlagVisibilityTests(FlagBase):
    def setUp(self):
        super().setUp()
        self.authorised = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket="FG-V1",
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
        )
        self.approved = self._claim(
            ClaimStatus.PRINCIPAL_APPROVED, ticket="FG-V2",
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
        )
        for claim in (self.authorised, self.approved):
            self.assertEqual(self._flag(self.principal, claim).status_code, 200)

    def _paths(self, user):
        paths = [
            f"/api/claims/{self.authorised.id}",
            f"/api/claims/{self.approved.id}",
            "/api/claims?limit=200",
            "/api/dashboard",
            "/api/reports/search?limit=50",
            "/api/admin/audit?limit=500",
            "/api/admin/payouts?status=DIRECTOR_APPROVED",
            "/api/notifications",
        ]
        if user.role == Role.DIRECTOR:
            paths.append("/api/director/queue")
        return paths

    def test_the_director_and_finance_never_see_a_flag(self):
        for who in (self.director, self.finance):
            client = self._as(who)
            answered = 0
            for path in self._paths(who):
                r = client.get(path)
                if r.status_code in (403, 404):
                    continue
                self.assertEqual(r.status_code, 200, f"{who.role} {path}: {r.content[:300]}")
                answered += 1
                raw = r.content.decode("utf-8", errors="ignore")
                self.assertNotIn("FLAGSENTINEL", raw, f"{who.role} {path}")
                self.assertNotIn("CLAIM_FLAG", raw, f"{who.role} {path}")
                self.assertEqual(_keys_anywhere(r.json()) & FLAG_KEYS, set(), f"{who.role} {path}")
            self.assertGreaterEqual(answered, 5, who.role)
            for path in (
                "/api/flags",
                f"/api/claims/{self.authorised.id}/review",
                "/api/archive/claims",
            ):
                self.assertEqual(client.get(path).status_code, 403, f"{who.role} {path}")

    def test_the_claimant_sees_nothing_of_it(self):
        client = self._as(self.faculty)
        for path in (f"/api/claims/{self.authorised.id}", "/api/claims?limit=200", "/api/notifications"):
            r = client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertNotIn("FLAGSENTINEL", r.content.decode("utf-8", errors="ignore"), path)
            self.assertEqual(_keys_anywhere(r.json()) & FLAG_KEYS, set(), path)
        for path in ("/api/flags", f"/api/claims/{self.authorised.id}/review", "/api/archive/claims"):
            self.assertEqual(client.get(path).status_code, 403, path)
        self.assertFalse(Notification.objects.filter(user=self.faculty, body__contains="FLAGSENTINEL").exists())

    def test_the_head_of_department_sees_nothing_of_it(self):
        client = self._as(self.hod)
        for path in ("/api/flags", f"/api/claims/{self.authorised.id}/review", "/api/archive/claims"):
            self.assertEqual(client.get(path).status_code, 403, path)

    def test_the_reviewers_see_it_on_the_claim_and_in_the_queue(self):
        for who in (self.cell, self.coordinator, self.principal, self.admin):
            review = self._as(who).get(f"/api/claims/{self.authorised.id}/review")
            self.assertEqual(review.status_code, 200, who.role)
            self.assertEqual([f["note"] for f in review.json()["flags"]], [SENTINEL], who.role)
            queue = self._as(who).get("/api/flags").json()
            self.assertEqual(
                sorted(r["claim"]["ticket_number"] for r in queue["results"]), ["FG-V1", "FG-V2"], who.role
            )


# --------------------------------------------------------------------------- #
# 5. The flagged queue                                                        #
# --------------------------------------------------------------------------- #


class FlagQueueTests(FlagBase):
    def setUp(self):
        super().setUp()
        self.unpaid = self._claim(ticket="FG-Q1")
        self.paid = self._paid("FG-Q2")
        self._flag(self.cell, self.unpaid, kind="AUTHOR", note="Author position looks wrong here")
        self._flag(self.cell, self.paid, kind="AMOUNT", note="Paid more than the formula gives")
        done = self._flag(self.cell, self.paid, kind="OTHER", note="Wrong department on the ticket").json()
        self._post(self.admin, f"/api/flags/{done['id']}/resolve", {"note": "Department corrected"})

    def _tickets(self, query=""):
        r = self._as(self.admin).get(f"/api/flags{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return sorted((row["claim"]["ticket_number"], row["kind"]) for row in r.json()["results"])

    def test_open_is_the_default(self):
        self.assertEqual(self._tickets(), [("FG-Q1", "AUTHOR"), ("FG-Q2", "AMOUNT")])

    def test_filters(self):
        self.assertEqual(self._tickets("?status=resolved"), [("FG-Q2", "OTHER")])
        self.assertEqual(len(self._tickets("?status=all")), 3)
        self.assertEqual(self._tickets("?kind=AUTHOR"), [("FG-Q1", "AUTHOR")])
        self.assertEqual(self._tickets("?paid=yes"), [("FG-Q2", "AMOUNT")])
        self.assertEqual(self._tickets("?paid=no"), [("FG-Q1", "AUTHOR")])

    def test_summary_counts(self):
        summary = self._as(self.admin).get("/api/flags").json()["summary"]
        self.assertEqual(summary, {"open": 2, "resolved": 1, "open_on_paid": 1})


# --------------------------------------------------------------------------- #
# 6. Looking into the past                                                    #
# --------------------------------------------------------------------------- #


class PastClaimsTests(FlagBase):
    def setUp(self):
        super().setUp()
        self.live = self._claim(ticket="FG-A1", publication_year=2026)
        self.paid = self._paid("FG-A2", publication_year=2024)
        # An imported row: paid on the old ERP, never authorised here.
        self.imported = self._claim(
            ClaimStatus.PAID, ticket="ERP-000123", publication_year=2023,
            status_note="Accounts", paid_at=timezone.now(),
        )
        self.legacy = self._claim(ClaimStatus.FINANCE_APPROVED, ticket="FG-A4", publication_year=2022)
        self.draft = self._claim(ClaimStatus.DRAFT, ticket=None, paper_title="Private draft")
        other = User.objects.create_user(
            email="past-ece@test.edu", password=None, name="Other Faculty",
            role=Role.FACULTY, department="ECE",
        )
        self.ece = self._claim(ticket="FG-A5", owner=other, publication_year=2024)

    def _tickets(self, user, query=""):
        r = self._as(user).get(f"/api/archive/claims{query}")
        self.assertEqual(r.status_code, 200, f"{user.role}: {r.content}")
        return sorted(row["ticket_number"] for row in r.json()["results"])

    def test_the_reviewers_see_everything_filed_paid_and_imported(self):
        for who in (self.principal, self.admin, self.cell, self.coordinator):
            self.assertEqual(
                self._tickets(who),
                ["ERP-000123", "FG-A1", "FG-A2", "FG-A4", "FG-A5"],
                who.role,
            )

    def test_nobody_else_does(self):
        for who in (self.faculty, self.hod, self.director, self.finance):
            self.assertEqual(self._as(who).get("/api/archive/claims").status_code, 403, who.role)

    def test_filters(self):
        self.assertEqual(self._tickets(self.admin, "?status=PAID"), ["ERP-000123", "FG-A2"])
        self.assertEqual(self._tickets(self.admin, "?year=2024"), ["FG-A2", "FG-A5"])
        self.assertEqual(self._tickets(self.admin, "?department=ECE"), ["FG-A5"])
        self.assertEqual(self._tickets(self.admin, "?q=ERP-000"), ["ERP-000123"])

    def test_flag_counts_ride_on_each_row_and_filter(self):
        self._flag(self.cell, self.imported)
        rows = {r["ticket_number"]: r for r in self._as(self.admin).get("/api/archive/claims").json()["results"]}
        self.assertEqual(rows["ERP-000123"]["open_flags"], 1)
        self.assertEqual(rows["FG-A1"]["open_flags"], 0)
        self.assertEqual(self._tickets(self.admin, "?flagged=open"), ["ERP-000123"])

    def test_a_past_paid_claim_can_be_opened_and_flagged(self):
        detail = self._as(self.cell).get(f"/api/claims/{self.imported.id}")
        self.assertEqual(detail.status_code, 200)
        r = self._flag(self.cell, self.imported, kind="AMOUNT", note="Paid twice for this DOI in 2023")
        self.assertEqual(r.status_code, 200, r.content)


# --------------------------------------------------------------------------- #
# 7. Reading the files                                                        #
# --------------------------------------------------------------------------- #


@override_settings(FILE_CHECKS_SYNC=True)
class ContentCheckTests(MediaMixin, FlagBase):
    def _bare(self, claim):
        """`ChainBase._claim` attaches two reference PDFs that are not in
        storage; each test here says exactly which files its claim carries."""
        claim.attachments.all().delete()
        return claim

    def _submitted(self, ticket, **extra):
        fields = dict(paper_title=TITLE, doi=DOI, journal_title="Computers and Electronics in Agriculture",
                      issn="0168-1699")
        fields.update(extra)
        return self._bare(self._claim(ClaimStatus.SUBMITTED, ticket=ticket, **fields))

    def _check(self, claim):
        from core.services.content_check import check_claim_files

        return check_claim_files(claim.id)

    def test_a_paper_that_says_what_the_claim_says_passes(self):
        claim = self._submitted("FG-C1")
        self._attach(claim, _matching_paper(), "a1")
        self._check(claim)
        check = AttachmentCheck.objects.get(claim=claim)
        self.assertEqual(check.outcome, AttachmentCheck.Outcome.MATCHED)
        self.assertEqual(set(json.loads(check.found_json)), {"title", "doi", "journal", "claimant", "affiliation"})
        self.assertEqual(json.loads(check.missing_json), [])
        self.assertEqual(check.score, 100)
        self.assertFalse(ClaimFlag.objects.filter(claim=claim).exists())

    def test_a_paper_without_the_title_or_doi_is_flagged(self):
        claim = self._submitted("FG-C2")
        wrong = _pdf("A Survey of Something Else Entirely", "Some Other College, Elsewhere")
        self._attach(claim, wrong, "a2")
        self._check(claim)
        check = AttachmentCheck.objects.get(claim=claim)
        self.assertEqual(check.outcome, AttachmentCheck.Outcome.MISMATCH)
        missing = set(json.loads(check.missing_json))
        self.assertTrue({"title", "doi", "affiliation"} <= missing, missing)
        self.assertLess(check.score, 50)
        flag = ClaimFlag.objects.get(claim=claim)
        self.assertEqual(flag.kind, ClaimFlag.Kind.CONTENT_MISMATCH)
        self.assertEqual(flag.source, ClaimFlag.Source.AUTO)
        self.assertIsNone(flag.raised_by)
        self.assertIn("title", flag.note.lower())
        self.assertIn("doi", flag.note.lower())
        self.assertTrue(AuditLog.objects.filter(action="CLAIM_FLAG_RAISE", entity_id=flag.id).exists())

    def test_the_title_alone_missing_is_enough(self):
        claim = self._submitted("FG-C3")
        self._attach(claim, _pdf("An Unrelated Title About Bridges", f"doi:{DOI}", "Saveetha"), "a3")
        self._check(claim)
        check = AttachmentCheck.objects.get(claim=claim)
        self.assertEqual(json.loads(check.missing_json)[:1], ["title"])
        self.assertIn("doi", json.loads(check.found_json))
        self.assertTrue(ClaimFlag.objects.filter(claim=claim, kind="CONTENT_MISMATCH").exists())

    def test_a_scanned_paper_is_flagged_as_having_no_text(self):
        claim = self._submitted("FG-C4")
        self._attach(claim, _scanned_pdf(), "a4")
        self._check(claim)
        check = AttachmentCheck.objects.get(claim=claim)
        self.assertEqual(check.outcome, AttachmentCheck.Outcome.NO_TEXT)
        flag = ClaimFlag.objects.get(claim=claim)
        self.assertIn("scanned", flag.note.lower())

    def test_checking_again_raises_nothing_twice_and_a_resolved_flag_stays_resolved(self):
        claim = self._submitted("FG-C5")
        self._attach(claim, _scanned_pdf(), "a5")
        self._check(claim)
        self._check(claim)
        self.assertEqual(ClaimFlag.objects.filter(claim=claim).count(), 1)
        self.assertEqual(AttachmentCheck.objects.filter(claim=claim).count(), 1)
        flag = ClaimFlag.objects.get(claim=claim)
        self._post(self.cell, f"/api/flags/{flag.id}/resolve", {"note": "Scanned copy, read it by eye: fine"})
        from core.services.content_check import check_claim_files

        check_claim_files(claim.id, force=True)
        self.assertEqual(ClaimFlag.objects.filter(claim=claim).count(), 1)
        self.assertIsNotNone(ClaimFlag.objects.get(claim=claim).resolved_at)

    def test_a_cited_reference_is_not_held_to_the_claims_title(self):
        claim = self._submitted("FG-C6")
        self._attach(
            claim, _pdf("Graph Neural Networks for Traffic", "R. Kumar, Saveetha Engineering College"), "a6",
            kind=AttachmentKind.SEC_REFERENCE, ref_number="14", ref_title="Graph Neural Networks for Traffic",
        )
        self._check(claim)
        check = AttachmentCheck.objects.get(claim=claim, url__contains="a6")
        self.assertIn("affiliation", json.loads(check.found_json))
        self.assertIn("reference_title", json.loads(check.found_json))
        self.assertFalse(ClaimFlag.objects.filter(claim=claim).exists())

    def test_a_file_missing_from_storage_does_not_stop_the_others(self):
        claim = self._submitted("FG-C12")
        ClaimAttachment.objects.create(
            claim=claim, kind=AttachmentKind.PUBLISHED_PAPER,
            url=f"/media/claims/{'e' * 32}.pdf", filename="gone.pdf", size_bytes=10,
        )
        self._attach(claim, _matching_paper(), "f1")
        self._check(claim)
        outcomes = dict(AttachmentCheck.objects.filter(claim=claim).values_list("filename", "outcome"))
        self.assertEqual(outcomes, {"gone.pdf": "UNREADABLE", "f1.pdf": "MATCHED"})
        self.assertFalse(ClaimFlag.objects.filter(claim=claim).exists(), "a storage fault is not a discrepancy")

    def test_a_pdf_that_breaks_the_reader_is_unreadable_and_the_rest_are_read(self):
        """pypdf raises all sorts on a malformed file -- not only its own errors."""
        from unittest.mock import patch

        import pypdf

        real = pypdf.PdfReader

        def reader(stream, *args, **kwargs):
            if b"BREAKS THE READER" in stream.getvalue():
                raise AttributeError("'NullObject' object has no attribute 'get_object'")
            return real(stream, *args, **kwargs)

        claim = self._submitted("FG-C13")
        # Page text is compressed, so the marker rides as a trailing comment.
        self._attach(claim, _matching_paper() + b"\n%BREAKS THE READER\n", "b2")
        self._attach(claim, _matching_paper(), "b3")
        with patch("pypdf.PdfReader", side_effect=reader):
            self._check(claim)
        outcomes = dict(AttachmentCheck.objects.filter(claim=claim).values_list("filename", "outcome"))
        self.assertEqual(outcomes, {"b2.pdf": "UNREADABLE", "b3.pdf": "MATCHED"})

    def test_the_backfill_carries_on_past_a_claim_that_fails(self):
        from unittest.mock import patch

        from core.services import content_check

        broken = self._submitted("FG-C14")
        self._attach(broken, _matching_paper(), "b4")
        fine = self._submitted("FG-C15")
        self._attach(fine, _scanned_pdf(), "b5")
        real = content_check.check_claim_files

        def flaky(claim_id, **kwargs):
            if claim_id == broken.id:
                raise RuntimeError("database hiccup")
            return real(claim_id, **kwargs)

        out = io.StringIO()
        with patch("core.management.commands.check_claim_files.check_claim_files", side_effect=flaky):
            call_command("check_claim_files", stdout=out)
        self.assertTrue(ClaimFlag.objects.filter(claim=fine).exists())
        self.assertIn("1 claim could not be read", out.getvalue())

    def test_refiling_with_a_changed_title_asks_again(self):
        """A resolved flag answered the question about the claim as it was."""
        claim = self._submitted("FG-C16", paper_title="A Title The Paper Does Not Carry")
        self._attach(claim, _matching_paper(), "b6")
        self._check(claim)
        first = ClaimFlag.objects.get(claim=claim)
        self._post(self.cell, f"/api/flags/{first.id}/resolve", {"note": "Checked: the journal retitled it"})

        Claim.objects.filter(pk=claim.pk).update(paper_title="Another Title Still Not In The File")
        from core.services.content_check import check_claim_files

        check_claim_files(claim.id, force=True)
        flags = list(ClaimFlag.objects.filter(claim=claim).order_by("raised_at"))
        self.assertEqual(len(flags), 2)
        self.assertIsNotNone(flags[0].resolved_at)
        self.assertIsNone(flags[1].resolved_at, "the new title is a new question")

    def test_a_flag_whose_file_now_matches_is_closed_by_the_check(self):
        claim = self._submitted("FG-C17", paper_title="A Title The Paper Does Not Carry")
        self._attach(claim, _matching_paper(), "b7")
        self._check(claim)
        flag = ClaimFlag.objects.get(claim=claim)
        self.assertIsNone(flag.resolved_at)

        Claim.objects.filter(pk=claim.pk).update(paper_title=TITLE)
        from core.services.content_check import check_claim_files

        check_claim_files(claim.id, force=True)
        flag.refresh_from_db()
        self.assertIsNotNone(flag.resolved_at)
        self.assertIsNone(flag.resolved_by, "closed by the check, not by a person")
        self.assertIn("no longer", flag.resolution_note)
        self.assertEqual(ClaimFlag.objects.filter(claim=claim).count(), 1)
        self.assertTrue(
            AuditLog.objects.filter(action="CLAIM_FLAG_RESOLVE", entity_id=flag.id, actor__isnull=True).exists()
        )

    def test_a_non_forced_run_reads_a_file_again_when_the_claim_changed(self):
        claim = self._submitted("FG-C18")
        self._attach(claim, _matching_paper(), "b8")
        self._check(claim)
        self.assertEqual(AttachmentCheck.objects.get(claim=claim).outcome, "MATCHED")
        Claim.objects.filter(pk=claim.pk).update(doi="10.9999/not.this.one")
        self._check(claim)
        self.assertEqual(AttachmentCheck.objects.get(claim=claim).outcome, "MISMATCH")

    def test_a_draft_is_read_but_not_flagged(self):
        claim = self._claim(ClaimStatus.DRAFT, ticket=None, paper_title=TITLE, doi=DOI)
        self._attach(claim, _scanned_pdf(), "a7")
        self._check(claim)
        self.assertTrue(AttachmentCheck.objects.filter(claim=claim).exists())
        self.assertFalse(ClaimFlag.objects.filter(claim=claim).exists())

    def test_the_check_shows_beside_each_file_for_the_reviewers(self):
        claim = self._submitted("FG-C8")
        attachment = self._attach(claim, _matching_paper(), "a8")
        self._check(claim)
        body = self._as(self.principal).get(f"/api/claims/{claim.id}/review").json()
        self.assertEqual(len(body["file_checks"]), 1)
        row = body["file_checks"][0]
        self.assertEqual(row["url"], attachment.url)
        self.assertEqual(row["outcome"], "MATCHED")
        self.assertEqual(row["score"], 100)

    def test_the_check_files_action_runs_it(self):
        claim = self._submitted("FG-C9")
        self._attach(claim, _scanned_pdf(), "a9")
        r = self._post(self.cell, f"/api/claims/{claim.id}/check-files")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([c["outcome"] for c in r.json()["file_checks"]], ["NO_TEXT"])
        self.assertTrue(ClaimFlag.objects.filter(claim=claim).exists())
        self.assertTrue(AuditLog.objects.filter(action="CLAIM_FILES_CHECK", entity_id=claim.id).exists())
        for who in (self.director, self.finance, self.faculty):
            self.assertEqual(self._post(who, f"/api/claims/{claim.id}/check-files").status_code, 403, who.role)

    def test_filing_a_paper_reads_its_files(self):
        url = self._store(_matching_paper(), "b1")
        self._as(self.faculty)
        payload = {
            "paper_title": TITLE,
            "doi": DOI,
            "journal_title": "Computers and Electronics in Agriculture",
            "issn": "0168-1699",
            "publication_date": "2026-03-01",
            "indexing_level": "Scopus",
            "yukthi_id": "YK-FG",
            "scopus_author_url": "https://scopus.com/authid/detail.uri?authorId=1",
            "quartile": "Q1",
            "snip": 1.0,
            "total_authors": 1,
            "author_position": 1,
            "affiliation_ok": True,
            "attachments": [
                {"kind": "PUBLISHED_PAPER", "url": url, "filename": "paper.pdf", "size_bytes": 10},
                *_sec_reference_attachments("14", "15", seed="d"),
            ],
            "submit": True,
            "contest_forward": True,
            "contest_note": "Submitting with faculty-provided journal details.",
        }
        r = self.client.post("/api/claims", data=json.dumps(payload), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        claim = Claim.objects.get(pk=r.json()["id"])
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        check = AttachmentCheck.objects.get(claim=claim, url=url)
        self.assertEqual(check.outcome, AttachmentCheck.Outcome.MATCHED)

    def test_the_management_command_reads_existing_claims(self):
        good = self._submitted("FG-C10")
        self._attach(good, _matching_paper(), "c1")
        bad = self._bare(self._paid("FG-C11", paper_title=TITLE, doi=DOI))
        self._attach(bad, _scanned_pdf(), "c2")
        out = io.StringIO()
        call_command("check_claim_files", stdout=out)
        self.assertEqual(AttachmentCheck.objects.filter(claim__in=[good, bad]).count(), 2)
        self.assertTrue(ClaimFlag.objects.filter(claim=bad, source="AUTO").exists())
        self.assertIn("1 flag", out.getvalue())
        # A backfill over history tells the super admin once, not once per claim.
        self.assertEqual(Notification.objects.filter(user=self.admin, title__icontains="file check").count(), 1)
        call_command("check_claim_files", stdout=io.StringIO())
        self.assertEqual(ClaimFlag.objects.filter(claim=bad).count(), 1)


# --------------------------------------------------------------------------- #
# 8. What the ERP import already got wrong                                    #
# --------------------------------------------------------------------------- #


class ImportDiscrepancyTests(FlagBase):
    def _imported(self, ticket, *, amount, note="Accounts", raw=None, **extra):
        claim = self._claim(
            ClaimStatus.PAID, ticket=ticket, status_note=note, paid_at=timezone.now(), **extra,
        )
        Claim.objects.filter(pk=claim.pk).update(remuneration=amount)
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2025, 3, 1), amount=amount or 0,
            faculty_name=self.faculty.name,
            raw_json=json.dumps(raw) if raw is not None else None,
        )
        return claim

    def _sweep(self):
        from core.services.import_discrepancies import flag_import_discrepancies

        return flag_import_discrepancies()

    def test_paid_nothing_without_saying_why_is_an_amount_flag_quoting_the_erp(self):
        claim = self._imported(
            "ERP-Z1", amount=0,
            raw={"Amount": "0", "(SNIP * 55000)+QF": "73000.0", "QF Amount": "18000", "SNIP Value": "1.0"},
        )
        counts = self._sweep()
        flag = ClaimFlag.objects.get(claim=claim)
        self.assertEqual(flag.kind, ClaimFlag.Kind.AMOUNT)
        self.assertEqual(flag.source, ClaimFlag.Source.AUTO)
        self.assertIn("73,000", flag.note)
        self.assertIn("Amount", flag.note)
        self.assertEqual(counts["paid_zero"], 1)
        self.assertTrue(AuditLog.objects.filter(action="CLAIM_FLAG_RAISE", entity_id=flag.id).exists())

    def test_null_amount_counts_too_and_no_ledger_row_is_still_flagged(self):
        claim = self._claim(ClaimStatus.PAID, ticket="ERP-Z2", status_note="Accounts", paid_at=timezone.now())
        Claim.objects.filter(pk=claim.pk).update(remuneration=None)
        self._sweep()
        self.assertEqual(ClaimFlag.objects.get(claim=claim).kind, ClaimFlag.Kind.AMOUNT)

    def test_zero_paid_and_zero_worked_out_is_the_erp_agreeing_with_itself(self):
        claim = self._imported("ERP-Z0", amount=0, raw={"Amount": "0", "(SNIP * 55000)+QF": "0", "QF Amount": "0"})
        self._sweep()
        self.assertFalse(ClaimFlag.objects.filter(claim=claim).exists())

    def test_flags_already_raised_on_zero_both_ways_are_closed(self):
        from core.services.import_discrepancies import RULE_PAID_ZERO, close_zero_both_ways

        zero = self._imported("ERP-C1", amount=0, raw={"Amount": "0", "(SNIP * 55000)+QF": "0"})
        real = self._imported("ERP-C2", amount=0, raw={"Amount": "0", "(SNIP * 55000)+QF": "4000"})
        for c in (zero, real):
            ClaimFlag.objects.create(claim=c, kind="AMOUNT", source="AUTO", note="x", auto_key=RULE_PAID_ZERO)
        self.assertEqual(close_zero_both_ways(), 1)
        self.assertIsNotNone(ClaimFlag.objects.get(claim=zero).resolved_at)
        self.assertIsNone(ClaimFlag.objects.get(claim=real).resolved_at)


    def test_papers_paid_nothing_on_purpose_are_left_alone(self):
        for n, note in enumerate(("Processed only for count", "No remuneration - student paper", "no renumeration")):
            self._imported(f"ERP-Z3{n}", amount=0, note=note)
        live = self._paid("FG-LIVE0", claim_reason=ClaimReason.COUNT_ONLY)
        Claim.objects.filter(pk=live.pk).update(remuneration=0)
        self._sweep()
        self.assertFalse(ClaimFlag.objects.exists())

    def test_paid_but_marked_rejected_is_flagged(self):
        claim = self._imported("ERP-R1", amount=41000, note="Rejected")
        counts = self._sweep()
        flag = ClaimFlag.objects.get(claim=claim)
        self.assertEqual(flag.kind, ClaimFlag.Kind.OTHER)
        self.assertIn("Rejected", flag.note)
        self.assertIn("41,000", flag.note)
        self.assertEqual(counts["paid_rejected"], 1)

    def test_rejected_and_paid_nothing_is_one_flag_not_two(self):
        claim = self._imported("ERP-R2", amount=0, note="Rejected")
        self._sweep()
        self.assertEqual(ClaimFlag.objects.filter(claim=claim).count(), 1)

    def test_running_it_again_raises_nothing_new(self):
        zero = self._imported("ERP-I1", amount=0)
        rejected = self._imported("ERP-I2", amount=5000, note="Rejected")
        first = self._sweep()
        flag = ClaimFlag.objects.get(claim=zero)
        flag.resolved_at = timezone.now()
        flag.resolution_note = "Checked the voucher"
        flag.save()
        second = self._sweep()
        self.assertEqual(first["raised"], 2)
        self.assertEqual(second["raised"], 0)
        self.assertEqual(ClaimFlag.objects.filter(claim__in=[zero, rejected]).count(), 2)

    def test_the_super_admin_hears_once_per_sweep(self):
        self._imported("ERP-S1", amount=0)
        self._imported("ERP-S2", amount=0)
        self._sweep()
        self._sweep()
        self.assertEqual(Notification.objects.filter(user=self.admin, title__icontains="import").count(), 1)

    def test_the_command_and_the_migration_share_it(self):
        self._imported("ERP-M1", amount=0)
        out = io.StringIO()
        call_command("flag_import_discrepancies", stdout=out)
        self.assertIn("1", out.getvalue())
        self.assertEqual(ClaimFlag.objects.count(), 1)

        import importlib

        from django.apps import apps

        migration = importlib.import_module("core.migrations.0043_claim_flags_and_file_checks")
        self._imported("ERP-M2", amount=0)
        migration.flag_existing_import_discrepancies(apps, None)
        self.assertEqual(ClaimFlag.objects.count(), 2)
