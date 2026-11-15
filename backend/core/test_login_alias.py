"""Signing in with the email the college's faculty list holds (synthetic data only)."""
from __future__ import annotations

import json

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import FacultyMaster, Role, User


def login(email: str, password: str, client: Client | None = None):
    return (client or Client()).post(
        "/api/auth/login",
        json.dumps({"email": email, "password": password}),
        content_type="application/json",
    )


class ListEmailSignInTests(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        self.user = User.objects.create_user(
            email="acct-one@x.edu", password="right-pass-1", name="One", role=Role.FACULTY, staff_id="TS001",
        )
        FacultyMaster.objects.create(staff_id="ts001", name="One", email="Listed.One@Saveetha.test")

    def test_normal_email_still_works(self):
        r = login("acct-one@x.edu", "right-pass-1")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["email"], "acct-one@x.edu")

    def test_the_list_email_signs_in_to_that_account(self):
        r = login("  listed.one@saveetha.TEST ", "right-pass-1")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["email"], "acct-one@x.edu")
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, "acct-one@x.edu")  # nothing stored is changed
        self.assertEqual(FacultyMaster.objects.get().email, "Listed.One@Saveetha.test")

    def test_wrong_password_fails_with_the_same_message_as_an_unknown_email(self):
        alias = login("listed.one@saveetha.test", "nope")
        unknown = login("nobody@saveetha.test", "nope")
        self.assertEqual(alias.status_code, 401)
        self.assertEqual(alias.status_code, unknown.status_code)
        self.assertEqual(alias.json(), unknown.json())

    def test_an_email_shared_by_two_people_on_the_list_fails(self):
        # One staff id is one account (unique in the database), so "several" means
        # two list rows with the address pointing at two accounts: never guess.
        User.objects.create_user(email="acct-dup@x.edu", password="right-pass-1", name="Dup",
                                 role=Role.FACULTY, staff_id="TS002")
        FacultyMaster.objects.create(staff_id="TS002", name="Dup", email="listed.one@saveetha.test")
        r = login("listed.one@saveetha.test", "right-pass-1")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), login("nobody@saveetha.test", "right-pass-1").json())

    def test_an_inactive_account_fails(self):
        self.user.active = False
        self.user.save(update_fields=["active"])
        r = login("listed.one@saveetha.test", "right-pass-1")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), login("nobody@saveetha.test", "right-pass-1").json())

    def test_an_inactive_twin_does_not_block_the_one_active_account(self):
        User.objects.create_user(email="acct-gone@x.edu", password="right-pass-1", name="Gone",
                                 role=Role.FACULTY, staff_id="TS002", active=False)
        FacultyMaster.objects.create(staff_id="TS002", name="Gone", email="listed.one@saveetha.test")
        self.assertEqual(login("listed.one@saveetha.test", "right-pass-1").status_code, 200)

    def test_a_list_email_with_no_staff_id_or_no_account_fails(self):
        FacultyMaster.objects.create(staff_id=None, name="No id", email="noid@saveetha.test")
        FacultyMaster.objects.create(staff_id="TS999", name="No account", email="noacct@saveetha.test")
        self.assertEqual(login("noid@saveetha.test", "right-pass-1").status_code, 401)
        self.assertEqual(login("noacct@saveetha.test", "right-pass-1").status_code, 401)

    def test_an_active_account_with_the_typed_email_wins_over_the_list(self):
        other = User.objects.create_user(email="listed.one@saveetha.test", password="other-pass-1",
                                         name="Other", role=Role.FACULTY, staff_id="TS777")
        self.assertEqual(login("listed.one@saveetha.test", "right-pass-1").status_code, 401)
        r = login("listed.one@saveetha.test", "other-pass-1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["email"], other.email)

    def test_the_lockout_counts_against_the_typed_email(self):
        for _ in range(10):
            self.assertEqual(login("listed.one@saveetha.test", "wrong").status_code, 401)
        r = login("listed.one@saveetha.test", "right-pass-1")
        self.assertEqual(r.status_code, 429)
        # a different typed email for the same person has its own counter
        self.assertEqual(login("acct-one@x.edu", "right-pass-1").status_code, 200)
