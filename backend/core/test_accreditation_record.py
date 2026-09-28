"""The accreditation list covers the publication record, not claims only."""
from __future__ import annotations

from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, Publication, Role, User


class AccreditationRecordTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            email="sa@x.edu", password="p", name="Sys Admin", role=Role.SUPER_ADMIN
        )
        self.fac = User.objects.create_user(
            email="f@x.edu", password=None, name="Dr Priya", role=Role.FACULTY, department="ECE"
        )
        claimed = Claim.objects.create(
            owner=self.fac, status=ClaimStatus.PAID, ticket_number="T-1", paper_title="Claimed paper",
            publication_year=2025,
        )
        p1 = Publication.objects.create(title="Claimed paper", year=2025, doi="10.1/a")
        p1.claims.add(claimed)
        Authorship.objects.create(publication=p1, display_name="Priya", author_key="k1",
                                  is_college=True, user=self.fac, position=1)
        p2 = Publication.objects.create(title="Harvested only", year=2025, doi="10.1/b",
                                        venue="IEEE Access", issn="21693536")
        Authorship.objects.create(publication=p2, display_name="Priya", author_key="k1",
                                  is_college=True, user=self.fac, position=1)
        # An outside author only: not a college paper.
        p3 = Publication.objects.create(title="Someone else", year=2025)
        Authorship.objects.create(publication=p3, display_name="X", author_key="k2", is_college=False)
        self.c = Client()
        self.c.force_login(self.admin)

    def test_rows_include_unclaimed_record_papers_once(self):
        d = self.c.get("/api/reports/pack/rows?limit=200").json()
        titles = sorted(r["paper_title"] for r in d["results"])
        self.assertEqual(titles, ["Claimed paper", "Harvested only"])
        rec = next(r for r in d["results"] if r["paper_title"] == "Harvested only")
        self.assertEqual(rec["source"], "record")
        self.assertEqual(rec["owner_name"], "Dr Priya")
        self.assertEqual(rec["issn"], "2169-3536")
        self.assertEqual(rec["link"], "https://doi.org/10.1/b")

    def test_workbook_counts_record_papers(self):
        from core.services.reporting_pack import build_pack

        pack = build_pack(year=None, scope=Claim.objects.all(), include_record=True)
        self.assertEqual(len(pack["NAAC 3.4.3"]["rows"]), 2)
        pack = build_pack(year=None, scope=Claim.objects.all())
        self.assertEqual(len(pack["NAAC 3.4.3"]["rows"]), 1)

    def test_faculty_sees_no_record_rows(self):
        c = Client()
        c.force_login(self.fac)
        r = c.get("/api/reports/pack/rows")
        if r.status_code == 200:
            self.assertTrue(all(x.get("source") != "record" for x in r.json()["results"]))
