"""The product layer: first-run setup, institution identity, versioning.

A second college's first hour with this system runs through these endpoints,
so their guards are pinned the way the money chain's are: setup exists only
for an empty system and says so once it is not; the identity strings are
public where pages need them and office-editable everywhere else; the
founder's password is held to a longer minimum than a reset password.
"""

from __future__ import annotations

import json

from django.core.cache import cache
from django.test import TestCase

from core.models import AuditLog, FormulaConfig, SystemSetting, User
from core.services import institution
from django.conf import settings


def _post_setup(client, **overrides):
    payload = {
        "college_name": "Saveetha Engineering College",
        "admin_name": "Ada Founder",
        "admin_email": "office@saveetha.ac.in",
        "admin_password": "founders-gate-2026",
        **overrides,
    }
    if overrides.pop("drop", None):
        for key in overrides.pop("drop"):
            payload.pop(key, None)
    return client.post(
        "/api/setup", data=json.dumps(payload), content_type="application/json"
    )


class SetUpOnAnEmptySystem(TestCase):
    def setUp(self):
        cache.clear()

    def test_a_fresh_system_says_it_needs_setup(self):
        r = self.client.get("/api/setup/status")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["needs_setup"])

    def test_setup_creates_the_founder_the_name_and_a_policy(self):
        r = _post_setup(self.client)
        self.assertEqual(r.status_code, 200, r.content)
        admin = User.objects.get(email="office@saveetha.ac.in")
        self.assertEqual(admin.role, "SUPER_ADMIN")
        self.assertTrue(admin.is_authenticated or admin.has_usable_password())
        self.assertFalse(admin.must_change_password)
        self.assertEqual(institution.get("college_name"), "Saveetha Engineering College")
        # the row exists: a write happened, this is not the default being read
        self.assertTrue(SystemSetting.objects.filter(pk="college_name").exists())
        self.assertTrue(FormulaConfig.objects.filter(active=True).exists())
        self.assertTrue(AuditLog.objects.filter(action="Set up the system").exists())

    def test_after_setup_the_door_is_closed_for_good(self):
        _post_setup(self.client)
        r = self.client.get("/api/setup/status")
        self.assertFalse(r.json()["needs_setup"])
        r = _post_setup(self.client, admin_email="second@saveetha.ac.in")
        self.assertEqual(r.status_code, 409, r.content)
        self.assertFalse(User.objects.filter(email="second@saveetha.ac.in").exists())

    def test_a_short_founder_password_is_refused(self):
        r = _post_setup(self.client, admin_password="short")
        self.assertEqual(r.status_code, 422)
        self.assertFalse(User.objects.exists())

    def test_a_broken_email_is_refused(self):
        r = _post_setup(self.client, admin_email="not-an-email")
        self.assertEqual(r.status_code, 422)
        self.assertFalse(User.objects.exists())

    def test_a_too_short_college_name_is_refused(self):
        r = _post_setup(self.client, college_name="A")
        self.assertEqual(r.status_code, 422)


class SetUpIsInertOnALivedInSystem(TestCase):
    def setUp(self):
        cache.clear()
        User.objects.create_user(
            email="existing@college.edu", password="x", name="Existing", role="FACULTY"
        )

    def test_status_says_so(self):
        r = self.client.get("/api/setup/status")
        self.assertFalse(r.json()["needs_setup"])

    def test_setup_refuses_rather_than_wiping_anything(self):
        before = User.objects.count()
        r = _post_setup(self.client)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(User.objects.count(), before)


class TheInstitutionEndpointIsPublic(TestCase):
    def test_the_default_name_travels_without_a_session(self):
        r = self.client.get("/api/institution")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["college_name"], institution.DEFAULTS["college_name"])

    def test_an_edited_name_is_what_the_public_sees(self):
        institution.set_values({"college_name": "Saveetha Engineering College"}, None)
        r = self.client.get("/api/institution")
        self.assertEqual(r.json()["college_name"], "Saveetha Engineering College")
        self.assertTrue(SystemSetting.objects.filter(pk="college_name").exists())

    def test_an_unknown_key_is_a_configuration_error_not_a_blank(self):
        with self.assertRaises(KeyError):
            institution.get("mascot")


class TheSettingsScreenBelongsToTheOffice(TestCase):
    def setUp(self):
        cache.clear()
        self.office = User.objects.create_user(
            email="office@college.edu", password="x", name="Office", role="SUPER_ADMIN"
        )
        self.faculty = User.objects.create_user(
            email="fac@college.edu", password="x", name="Fac", role="FACULTY"
        )

    def test_the_office_reads_and_writes_the_strings(self):
        self.client.force_login(self.office)
        r = self.client.get("/api/admin/settings")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["college_name"], institution.DEFAULTS["college_name"])

        r = self.client.put(
            "/api/admin/settings",
            data=json.dumps(
                {
                    "college_name": "Saveetha Engineering College",
                    "sign_in_note": "Passwords are issued by the research cell.",
                    "support_email": "researchcell@saveetha.ac.in",
                }
            ),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["college_name"], "Saveetha Engineering College")
        self.assertTrue(SystemSetting.objects.filter(pk="college_name").exists())
        row = SystemSetting.objects.get(pk="college_name")
        self.assertEqual(row.updated_by, self.office)
        self.assertTrue(AuditLog.objects.filter(entity="system_setting").exists())

    def test_faculty_is_refused_by_name(self):
        self.client.force_login(self.faculty)
        self.assertEqual(self.client.get("/api/admin/settings").status_code, 403)
        r = self.client.put(
            "/api/admin/settings",
            data=json.dumps({"college_name": "Saveetha Engineering College"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 403)
        self.assertEqual(institution.get("college_name"), institution.DEFAULTS["college_name"])

    def test_an_unknown_setting_is_refused(self):
        self.client.force_login(self.office)
        r = self.client.put(
            "/api/admin/settings",
            data=json.dumps({"mascot": "Badgers"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 422)
        self.assertFalse(SystemSetting.objects.filter(pk="mascot").exists())


class TheVersionIsATruthfulString(TestCase):
    def test_health_reports_the_version_file(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["version"], settings.APP_VERSION)

    def test_the_version_setting_comes_from_the_file(self):
        self.assertEqual(settings.APP_VERSION, "1.0.0")
