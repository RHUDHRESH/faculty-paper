"""The review workspace's single request, and byte ranges on claim files."""
from __future__ import annotations

import shutil
import tempfile

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.test import override_settings

from core.models import AttachmentKind, ClaimAttachment, ClaimStatus, ClaimFlag
from core.test_chain_rules import ChainBase

#: Every key a flag or a file check travels under (see test_flags).
FLAG_KEYS = {"flags", "open_flags", "file_checks"}


class WorkspaceTests(ChainBase):
    def _workspace(self, user, claim):
        return self._as(user).get(f"/api/claims/{claim.id}/workspace")

    def test_the_office_gets_claim_history_and_flags_in_one_answer(self):
        claim = self._claim()
        ClaimFlag.objects.create(
            claim=claim, kind=ClaimFlag.Kind.AMOUNT, note="Check this amount", raised_by=self.cell
        )
        r = self._workspace(self.cell, claim)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["claim"]["id"], claim.id)
        self.assertEqual(body["claim"]["ticket_number"], claim.ticket_number)
        self.assertIn("actions", body["claim"])
        self.assertIn("confirmations", body["claim"])
        self.assertEqual(len(body["claim"]["attachments"]), 2)
        self.assertEqual(len(body["review"]["flags"]), 1)
        self.assertFalse(body["own"])

    def test_every_office_role_and_the_principal_open_it(self):
        claim = self._claim()
        for user in (self.cell, self.coordinator, self.admin, self.principal):
            self.assertEqual(self._workspace(user, claim).status_code, 200, user.role)

    def test_the_director_opens_it_without_any_flags(self):
        claim = self._claim(ClaimStatus.PRINCIPAL_APPROVED)
        ClaimFlag.objects.create(
            claim=claim, kind=ClaimFlag.Kind.AMOUNT, note="FLAGSENTINEL doubt", raised_by=self.cell
        )
        r = self._workspace(self.director, claim)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["review"])
        self.assertNotIn("FLAGSENTINEL", r.content.decode())

    def test_faculty_finance_and_heads_are_refused(self):
        claim = self._claim()
        for user in (self.faculty, self.finance, self.hod):
            self.assertEqual(self._workspace(user, claim).status_code, 403, user.role)

    def test_a_reviewer_opening_their_own_claim_gets_no_flags_and_own_true(self):
        claim = self._claim(owner=self.cell, ticket="CH-OWN")
        ClaimFlag.objects.create(
            claim=claim, kind=ClaimFlag.Kind.AMOUNT, note="FLAGSENTINEL own", raised_by=self.coordinator
        )
        r = self._workspace(self.cell, claim)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["own"])
        self.assertIsNone(body["review"])
        self.assertNotIn("FLAGSENTINEL", r.content.decode())

    def test_a_draft_is_not_opened_by_the_office(self):
        claim = self._claim(ClaimStatus.DRAFT, ticket="CH-DRAFT")
        self.assertEqual(self._workspace(self.cell, claim).status_code, 404)

    def test_an_unknown_claim_is_a_404(self):
        self._as(self.cell)
        self.assertEqual(self.client.get("/api/claims/nope/workspace").status_code, 404)


class RangeTests(ChainBase):
    def setUp(self):
        super().setUp()
        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=media)
        override.enable()
        self.addCleanup(override.disable)
        self.data = bytes(range(256)) * 4
        name = "d" * 32
        default_storage.save(f"claims/{name}.pdf", ContentFile(b"%PDF-1.4\n" + self.data))
        self.data = b"%PDF-1.4\n" + self.data
        self.url = f"/media/claims/{name}.pdf"
        self.claim = self._claim()
        ClaimAttachment.objects.create(
            claim=self.claim, kind=AttachmentKind.PUBLISHED_PAPER, url=self.url, filename="p.pdf"
        )

    def _get(self, **headers):
        return self._as(self.cell).get(self.url, **headers)

    def test_the_whole_file_says_it_can_be_read_in_pieces(self):
        r = self._get()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Accept-Ranges"], "bytes")
        self.assertEqual(b"".join(r.streaming_content), self.data)

    def test_one_range_comes_back_as_206_with_its_position(self):
        r = self._get(HTTP_RANGE="bytes=10-19")
        self.assertEqual(r.status_code, 206)
        self.assertEqual(r["Content-Range"], f"bytes 10-19/{len(self.data)}")
        self.assertEqual(r.content, self.data[10:20])
        self.assertEqual(r["Content-Type"], "application/pdf")

    def test_the_last_bytes_and_an_open_ended_range(self):
        tail = self._get(HTTP_RANGE="bytes=-16")
        self.assertEqual(tail.status_code, 206)
        self.assertEqual(tail.content, self.data[-16:])
        rest = self._get(HTTP_RANGE=f"bytes={len(self.data) - 5}-")
        self.assertEqual(rest.content, self.data[-5:])

    def test_a_range_past_the_end_is_refused_and_junk_gets_the_whole_file(self):
        past = self._get(HTTP_RANGE=f"bytes={len(self.data) + 10}-")
        self.assertEqual(past.status_code, 416)
        junk = self._get(HTTP_RANGE="bytes=0-1,5-9")
        self.assertEqual(junk.status_code, 200)

    def test_a_range_does_not_get_around_the_access_check(self):
        r = self._as(self.finance).get(self.url, HTTP_RANGE="bytes=0-9")
        # Finance may read college-wide claims; a faculty member who does not
        # own the claim may not.
        self.assertIn(r.status_code, (200, 206))
        other = self._as(self.hod).get(self.url, HTTP_RANGE="bytes=0-9")
        self.assertEqual(other.status_code, 403)
