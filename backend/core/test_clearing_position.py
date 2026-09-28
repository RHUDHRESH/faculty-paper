"""The clearing desk compares the claimed author position with the stored author list."""
from __future__ import annotations

from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, Publication, Role, User


class ClearingPositionTests(TestCase):
    def setUp(self):
        self.cell = User.objects.create_user(
            email="cell-pos@x.edu", password="p", name="Cell", role=Role.SUPER_ADMIN, staff_id="CP0"
        )
        self.me = User.objects.create_user(
            email="me-pos@x.edu", password="p", name="Me", role=Role.FACULTY, staff_id="CP1"
        )
        self.c = Client()
        self.c.force_login(self.cell)

    def claim(self, position, doi="10.1/pos"):
        return Claim.objects.create(
            owner=self.me, status=ClaimStatus.SUBMITTED, paper_title="P", doi=doi, author_position=position
        )

    def row(self, claim):
        rows = self.c.get("/api/admin/clearing-queue").json()
        return next(r for r in rows if r["id"] == claim.id)

    def test_record_position_comes_from_authorship(self):
        pub = Publication.objects.create(doi="10.1/POS", title="P")
        Authorship.objects.create(publication=pub, position=1, display_name="A", author_key="n:a")
        Authorship.objects.create(publication=pub, position=2, display_name="Me", author_key="n:me", user=self.me)
        claim = self.claim(1)
        r = self.row(claim)
        self.assertEqual(r["author_position"], 1)
        self.assertEqual(r["record_author_position"], 2)
        self.assertEqual(r["record_total_authors"], 2)
        detail = self.c.get(f"/api/claims/{claim.id}").json()
        self.assertEqual(detail["record_author_position"], 2)

    def test_no_publication_means_no_record(self):
        r = self.row(self.claim(1, doi="10.1/none"))
        self.assertIsNone(r["record_author_position"])
        self.assertFalse(r["record_has_authors"])
