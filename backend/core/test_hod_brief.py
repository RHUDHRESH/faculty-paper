"""The head's brief and report: on track, who needs a push, who writes with whom."""
from __future__ import annotations

import io
import json
from datetime import date

from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from core.api.hod_brief import _elapsed, _verdict
from core.models import (
    Claim, ClaimStatus, DepartmentAssignment, DepartmentTarget, FormulaConfig, Role, User,
)
from core.services.remuneration import DEFAULT_AUTHOR_POINTS

FIGURE = 61234.5  # a colleague's amount; must appear in no response or file


def _u(email, name, role=Role.FACULTY, dept="CSE"):
    return User.objects.create_user(email=email, password=None, name=name, role=role, department=dept)


def _paper(owner, year, quartile=None, position=1, area="ML", **extra):
    return Claim.objects.create(
        owner=owner, status=extra.pop("status", ClaimStatus.PAID), paper_title=f"P {owner.name} {year}",
        journal_title="J", publication_year=year, publication_date=f"{year}-01-05",
        quartile=quartile, author_position=position, total_authors=3, subject_category=area,
        remuneration=FIGURE, issn="1234-5678", doi=f"10.5555/{owner.id}{year}{quartile}{position}",
        submitted_at=timezone.now(), **extra,
    )


class BriefTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        FormulaConfig.objects.create(author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True)
        cls.year = timezone.localdate().year
        cls.head = _u("h@t.edu", "Head", Role.HOD)
        cls.star = _u("s@t.edu", "Star")
        cls.quiet = _u("q@t.edu", "Quiet")
        cls.other = _u("o@t.edu", "Elsewhere", dept="ECE")
        for q in ("Q1", "Q1", "Q1"):
            _paper(cls.star, cls.year, q)
        _paper(cls.quiet, cls.year - 1, "Q3")
        _paper(cls.quiet, cls.year, "Q2", status=ClaimStatus.REJECTED, rejected_outright=True)
        _paper(cls.other, cls.year, "Q1")
        DepartmentTarget.objects.create(
            department="CSE", year=cls.year, metric=DepartmentTarget.Metric.PUBLICATIONS, target=100,
        )

    def setUp(self):
        cache.clear()
        self.c = Client()
        self.c.force_login(self.head)

    def brief(self):
        r = self.c.get("/api/hod/brief")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_rejected_outright_is_not_counted(self):
        b = self.brief()
        self.assertEqual(b["totals"]["publications"], 3)
        self.assertEqual(b["totals"]["rejected_outright"], 1)
        t = self.c.get("/api/hod/targets").json()["department_targets"][0]
        self.assertEqual(t["done"], 3)

    def test_pace_and_verdict(self):
        b = self.brief()
        pubs = b["targets"][0]
        self.assertAlmostEqual(pubs["expected_by_now"], round(100 * b["elapsed"], 1))
        self.assertEqual(_verdict(50, 60, 100), "behind")
        self.assertEqual(_verdict(55, 60, 100), "close")
        self.assertEqual(_verdict(61, 60, 100), "on_track")
        self.assertEqual(_verdict(100, 60, 100), "met")
        self.assertEqual(_elapsed(2020, date(2026, 6, 1)), 1.0)
        self.assertEqual(_elapsed(2030, date(2026, 6, 1)), 0.0)

    def test_push_and_pair(self):
        b = self.brief()
        names = [r["person"]["name"] for r in b["push"]]
        self.assertIn("Quiet", names)
        self.assertNotIn("Head", names)
        self.assertNotIn("Elsewhere", [p["name"] for p in b["people"]])
        self.assertEqual(len(b["pairs"]), 1)
        self.assertEqual(b["pairs"][0]["mentee"]["name"], "Quiet")
        self.assertEqual(b["pairs"][0]["mentor"]["name"], "Star")

    def test_existing_pairing_is_not_suggested_again(self):
        DepartmentAssignment.objects.create(
            department="CSE", kind=DepartmentAssignment.Kind.PAIRING, title="x",
            assignee=self.quiet, partner=self.star, created_by=self.head,
        )
        self.assertEqual(self.brief()["pairs"], [])

    def test_no_money_anywhere(self):
        self.assertNotIn(str(FIGURE), self.c.get("/api/hod/brief").content.decode())
        from openpyxl import load_workbook
        r = self.c.get("/api/hod/report?fmt=xlsx")
        self.assertEqual(r.status_code, 200)
        wb = load_workbook(io.BytesIO(r.content))
        self.assertEqual(wb.sheetnames[:3], ["Summary", "Per teacher", "NAAC 3.3 papers"])
        cells = [str(c.value) for ws in wb for row in ws.iter_rows() for c in row]
        self.assertFalse(any(str(int(FIGURE)) in v for v in cells))
        naac = wb["NAAC 3.3 papers"]
        self.assertIn("Link to article (DOI)", [c.value for c in naac[4]])

    def test_pdf_is_a4(self):
        r = self.c.get("/api/hod/report?fmt=pdf")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"%PDF"))
        from pypdf import PdfReader
        page = PdfReader(io.BytesIO(r.content)).pages[0]
        self.assertAlmostEqual(float(page.mediabox.width), 595.27, places=0)
        self.assertNotIn(str(int(FIGURE)), page.extract_text())

    def test_pdf_reads_like_a_document(self):
        from pypdf import PdfReader
        pages = PdfReader(io.BytesIO(self.c.get("/api/hod/report?fmt=pdf").content)).pages
        first = pages[0].extract_text()
        for part in ("Saveetha Engineering College", "Research publication report", "Summary",
                     "Pace", "Who needs a push", f"Page 1 of {len(pages)}"):
            self.assertIn(part, first)
        text = " ".join(p.extract_text() for p in pages)
        self.assertIn("Per teacher", text)
        self.assertIn(f"Page {len(pages)} of {len(pages)}", text)

    def test_faculty_cannot(self):
        c = Client()
        c.force_login(self.star)
        self.assertEqual(c.get("/api/hod/brief").status_code, 403)
        self.assertEqual(c.get("/api/hod/report").status_code, 403)
