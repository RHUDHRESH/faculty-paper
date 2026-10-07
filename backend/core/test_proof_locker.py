"""The proof locker: upload once, checked before filing, reused on claims."""
from __future__ import annotations

import json

from django.core.files.uploadedfile import SimpleUploadedFile

from core.models import AttachmentKind, ClaimAttachment, ClaimStatus, ProofFile, Publication, Role, User
from core.services import proof_locker
from core.test_chain_rules import ChainBase
from core.test_flags import DOI, TITLE, MediaMixin, _matching_paper, _pdf, _scanned_pdf


def _status(proof: ProofFile) -> dict[str, str]:
    return {c["key"]: c["status"] for c in json.loads(proof.checks_json)}


class ProofLockerTests(MediaMixin, ChainBase):
    def setUp(self):
        super().setUp()
        self.pub = Publication.objects.create(title=TITLE, doi=DOI)

    def _upload(self, user, data, name="paper.pdf", **form):
        self.client.force_login(user)
        return self.client.post(
            "/api/me/proofs", {"file": SimpleUploadedFile(name, data, "application/pdf"), **form}
        )

    # ---- checks -----------------------------------------------------------

    def test_matching_article_all_ok(self):
        r = self._upload(self.faculty, _matching_paper(), publication_id=self.pub.id)
        self.assertEqual(r.status_code, 200, r.content)
        proof = ProofFile.objects.get(id=r.json()["id"])
        self.assertEqual(
            _status(proof),
            {"readable": "ok", "affiliation": "ok", "author": "ok", "title": "ok", "doi": "ok"},
        )
        self.assertEqual(proof.doi_found, DOI)
        self.assertEqual(r.json()["worst"], "ok")

    def test_article_without_affiliation_or_name(self):
        data = _pdf("A Completely Different Paper About Bridges", "Somebody Else, Another University",
                    "https://doi.org/10.9999/other.1")
        r = self._upload(self.faculty, data, publication_id=self.pub.id)
        s = _status(ProofFile.objects.get(id=r.json()["id"]))
        self.assertEqual(s["affiliation"], "bad")
        self.assertEqual(s["author"], "warn")
        self.assertEqual(s["title"], "bad")
        self.assertEqual(s["doi"], "bad")
        aff = next(c for c in r.json()["checks"] if c["key"] == "affiliation")
        self.assertIn("college's name is not on this PDF", aff["detail"])

    def test_scanned_is_unknown_never_bad(self):
        r = self._upload(self.faculty, _scanned_pdf(), publication_id=self.pub.id)
        self.assertEqual(_status(ProofFile.objects.get(id=r.json()["id"])), {"readable": "unknown"})
        self.assertEqual(r.json()["worst"], "unknown")

    def test_reference_checks(self):
        ref = _pdf("Another paper on soil", "K. Ravi, Saveetha Engineering College, Chennai")
        r = self._upload(self.faculty, ref, name="ref.pdf", kind="REFERENCE")
        self.assertEqual(_status(ProofFile.objects.get(id=r.json()["id"])),
                         {"readable": "ok", "affiliation": "ok", "not_article": "ok"})
        # The article itself, filed as a reference, is caught.
        art = self._upload(self.faculty, _matching_paper(), publication_id=self.pub.id).json()
        same = ProofFile.objects.get(id=art["id"])
        same.kind = ProofFile.Kind.REFERENCE
        same.save()
        self.assertEqual(_status(proof_locker.check(same))["not_article"], "bad")

    # ---- dedupe, permissions ---------------------------------------------

    def test_same_bytes_are_one_file(self):
        data = _matching_paper()
        a = self._upload(self.faculty, data, name="a.pdf").json()
        b = self._upload(self.faculty, data, name="renamed.pdf").json()
        self.assertEqual(a["id"], b["id"])
        self.assertTrue(b["already_in_locker"])
        self.assertEqual(ProofFile.objects.filter(owner=self.faculty).count(), 1)

    def test_owner_only(self):
        pid = self._upload(self.faculty, _matching_paper()).json()["id"]
        other = User.objects.create_user(email="other@test.edu", password=None, name="Bala Other", role=Role.FACULTY)
        self.client.force_login(other)
        self.assertEqual(self.client.get("/api/me/proofs").json()["items"], [])
        self.assertEqual(self.client.post(f"/api/me/proofs/{pid}/recheck").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/me/proofs/{pid}").status_code, 404)
        claim = self._claim(status=ClaimStatus.DRAFT, ticket="PL-O", owner=other)
        r = self.client.post(f"/api/claims/{claim.id}/attach-proof", {"proof_id": pid},
                             content_type="application/json")
        self.assertEqual(r.status_code, 404)

    # ---- claims -----------------------------------------------------------

    def test_attach_proof_creates_claim_attachment(self):
        pid = self._upload(self.faculty, _matching_paper()).json()["id"]
        claim = self._claim(status=ClaimStatus.DRAFT, ticket="PL-A")
        r = self.client.post(f"/api/claims/{claim.id}/attach-proof", {"proof_id": pid, "role": "article"},
                             content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        row = ClaimAttachment.objects.get(claim=claim, kind=AttachmentKind.PUBLISHED_PAPER)
        proof = ProofFile.objects.get(id=pid)
        self.assertEqual(row.kind, AttachmentKind.PUBLISHED_PAPER)
        self.assertEqual(row.content_hash, proof.content_hash)
        self.assertEqual(row.url, f"/media/{proof.storage_path}")
        claim.refresh_from_db()
        self.assertEqual(claim.proof_url, row.url)
        # A filed claim takes no more files.
        filed = self._claim(status=ClaimStatus.SUBMITTED, ticket="PL-F")
        r = self.client.post(f"/api/claims/{filed.id}/attach-proof", {"proof_id": pid},
                             content_type="application/json")
        self.assertEqual(r.status_code, 409)

    def test_delete_refused_once_filed(self):
        pid = self._upload(self.faculty, _matching_paper()).json()["id"]
        proof = ProofFile.objects.get(id=pid)
        claim = self._claim(status=ClaimStatus.DRAFT, ticket="PL-D")
        ClaimAttachment.objects.create(claim=claim, kind=AttachmentKind.PUBLISHED_PAPER, url="/media/x",
                                       content_hash=proof.content_hash)
        claim.status = ClaimStatus.SUBMITTED
        claim.save(update_fields=["status"])
        self.assertEqual(self.client.delete(f"/api/me/proofs/{pid}").status_code, 409)
        claim.status = ClaimStatus.DRAFT
        claim.save(update_fields=["status"])
        self.assertEqual(self.client.delete(f"/api/me/proofs/{pid}").status_code, 200)
        self.assertFalse(ProofFile.objects.filter(id=pid).exists())

    def test_patch_relinks_and_rechecks(self):
        pid = self._upload(self.faculty, _matching_paper()).json()["id"]
        self.assertEqual(_status(ProofFile.objects.get(id=pid))["title"], "unknown")
        r = self.client.patch(f"/api/me/proofs/{pid}", {"publication_id": self.pub.id},
                              content_type="application/json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(_status(ProofFile.objects.get(id=pid))["title"], "ok")

    def test_claim_upload_saves_to_locker(self):
        self.client.force_login(self.faculty)
        r = self.client.post("/api/claims/upload?locker_kind=REFERENCE",
                             {"file": SimpleUploadedFile("r.pdf", _matching_paper(), "application/pdf")})
        self.assertEqual(r.status_code, 200, r.content)
        proof = ProofFile.objects.get(id=r.json()["locker_id"])
        self.assertEqual(proof.kind, ProofFile.Kind.REFERENCE)
