"""Importing the college website: matching, never overwriting, and who may run it."""
from __future__ import annotations

import io
import json
import zipfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import Client, TestCase
from PIL import Image

from core.models import Role, SystemSetting, User
from core.services.college_site import APPLIED_KEY, ZipSource, department_profile, import_site, match


def _jpeg() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (400, 400), (200, 30, 30)).save(out, "JPEG")
    return out.getvalue()


def _zip(rows: list[dict], depts: list[dict] | None = None, root: str = "scraped/") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(root + "faculty.json", json.dumps(rows))
        zf.writestr(root + "departments.json", json.dumps(depts or []))
        zf.writestr(root + "photos/a.jpg", _jpeg())
        zf.writestr(root + "images/d.jpg", _jpeg())
    return buf.getvalue()


def _user(email: str, name: str, dept: str, **extra) -> User:
    u = User(email=email, name=name, department=dept, **extra)
    u.set_unusable_password()
    u.save()
    return u


class MatchingTests(TestCase):
    def setUp(self):
        self.asha = _user("asha@saveetha.ac.in", "Dr. Asha Kumari R", "CSE")
        self.ravi_cse = _user("ravi1@x.in", "Ravi Shankar", "CSE")
        self.ravi_ece = _user("ravi2@x.in", "Ravi Shankar", "ECE")
        self.meena = _user("meena@x.in", "Meena Lakshmi", "MECH", scopus_author_id="57000000001")

    def test_email_then_scopus_then_name_in_department(self):
        rows = [
            {"name": "Someone Else", "email": "ASHA@saveetha.ac.in", "department_slug": "civil-engineering"},
            {"name": "M. Lakshmi", "scopus_author_id": "57000000001", "department_slug": "mechanical-engineering"},
            {"name": "Mr. Ravi Shankar", "department_slug": "electronics-communication-engineering"},
        ]
        found, unmatched, conflicts = match(rows, list(User.objects.all()))
        self.assertEqual(found[0], self.asha)
        self.assertEqual(found[1], self.meena)
        self.assertEqual(found[2], self.ravi_ece)
        self.assertEqual(unmatched, [])

    def test_exact_unique_full_name_crosses_departments_but_a_single_word_does_not(self):
        arul = _user("arul@x.in", "Dr. A. Arul Oli", "CSE")
        _user("nandhini@x.in", "Ms. Nandhini R", "EEE")
        rows = [
            {"name": "Dr. A. Arul Oli", "department_slug": "artificial-intelligence-data-science"},
            {"name": "Ms. Nandhini.R", "department_slug": "agricultural-engineering"},
        ]
        found, unmatched, conflicts = match(rows, list(User.objects.all()))
        self.assertEqual(found, {0: arul})
        self.assertEqual(len(conflicts), 1)

    def test_ambiguous_names_are_reported_not_guessed(self):
        rows = [
            {"name": "Ravi Shankar", "department_slug": "civil-engineering"},
            {"name": "Nobody Known", "department_slug": "civil-engineering"},
            {"name": "Asha Kumari", "department_slug": "civil-engineering"},
        ]
        found, unmatched, conflicts = match(rows, list(User.objects.all()))
        self.assertEqual(found, {})
        self.assertEqual([u["name"] for u in unmatched], ["Nobody Known"])
        self.assertEqual(len(conflicts), 2)


class ImportTests(TestCase):
    def setUp(self):
        self.empty = _user("empty@saveetha.ac.in", "Priya Dharshini", "CSE")
        self.full = _user(
            "full@saveetha.ac.in", "Karthik Raja", "CSE",
            bio="My own words.", designation="Professor", photo="avatars/mine.jpg",
        )
        self.rows = [
            {"name": "Dr. Priya Dharshini", "email": "empty@saveetha.ac.in", "designation": "Assistant Professor",
             "qualifications": "M.E., Ph.D.", "research_areas": ["Machine Learning"], "photo_file": "a.jpg",
             "department_slug": "computer-science-and-engineering"},
            {"name": "Dr. Karthik Raja", "email": "full@saveetha.ac.in", "designation": "Associate Professor",
             "qualifications": "M.E.", "photo_file": "a.jpg", "department_slug": "computer-science-and-engineering"},
        ]
        self.depts = [{"slug": "computer-science-and-engineering", "name": "CSE", "description": "About CSE.",
                       "image_file": "d.jpg", "research_focus": ["AI"], "url": "https://saveetha.ac.in/cse/"}]

    def test_fills_blanks_and_never_overwrites(self):
        report = import_site(ZipSource(_zip(self.rows, self.depts)))
        self.empty.refresh_from_db()
        self.full.refresh_from_db()
        self.assertTrue(self.empty.photo.startswith("avatars/"))
        self.assertEqual(self.empty.designation, "Assistant Professor")
        self.assertIn("Machine Learning", self.empty.bio)
        self.assertEqual(self.full.bio, "My own words.")
        self.assertEqual(self.full.designation, "Professor")
        self.assertEqual(self.full.photo, "avatars/mine.jpg")
        self.assertEqual(report.matched, 2)
        self.assertEqual(report.photos, 1)
        self.assertTrue(any("kept ours" in c["reason"] for c in report.differences))
        prof = department_profile("CSE")
        self.assertEqual(prof["description"], "About CSE.")
        self.assertTrue(prof["image_url"])

    def test_rerun_is_idempotent_and_respects_removal(self):
        import_site(ZipSource(_zip(self.rows)))
        self.empty.refresh_from_db()
        self.empty.photo = None
        self.empty.bio = ""
        self.empty.save()
        report = import_site(ZipSource(_zip(self.rows)))
        self.empty.refresh_from_db()
        self.assertIsNone(self.empty.photo)
        self.assertEqual(self.empty.bio, "")
        self.assertEqual(report.photos, 0)
        self.assertIn("photo", SystemSetting.objects.get(key=APPLIED_KEY).value[self.empty.id])

    def test_dry_run_saves_nothing(self):
        report = import_site(ZipSource(_zip(self.rows)), dry_run=True)
        self.empty.refresh_from_db()
        self.assertIsNone(self.empty.photo)
        self.assertFalse(self.empty.bio)
        self.assertEqual(report.bios, 1)
        self.assertFalse(SystemSetting.objects.filter(key=APPLIED_KEY).exists())

    def test_management_command_reads_a_zip(self):
        import tempfile, os

        fd, path = tempfile.mkstemp(suffix=".zip")
        os.write(fd, _zip(self.rows))
        os.close(fd)
        try:
            call_command("import_college_site", path, stdout=io.StringIO())
        finally:
            os.unlink(path)
        self.empty.refresh_from_db()
        self.assertEqual(self.empty.designation, "Assistant Professor")


class PermissionTests(TestCase):
    def setUp(self):
        self.faculty = _user("f@saveetha.ac.in", "Faculty One", "CSE", role=Role.FACULTY)
        self.office = _user("o@saveetha.ac.in", "Office One", "CSE", role=Role.SUPER_ADMIN)

    def _post(self, user):
        c = Client()
        c.force_login(user)
        up = SimpleUploadedFile("site.zip", _zip([]), content_type="application/zip")
        return c.post("/api/admin/college-site/import", data={"file": up})

    def test_faculty_may_not_import(self):
        self.assertEqual(self._post(self.faculty).status_code, 403)

    def test_office_may_import(self):
        r = self._post(self.office)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["scraped"], 0)

    def test_signed_out_gets_nothing(self):
        self.assertIn(Client().get("/api/departments/CSE/profile").status_code, (401, 403))
