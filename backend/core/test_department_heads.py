"""One head per department, and never a head of no department.

The college's rule (2026-09-23): per person the office records faculty status,
whether they are research faculty, and whether they are the head -- and each
department has exactly one head. Enforced when an account is written, by the
two endpoints that write roles and by the `assign_heads` command, rather than
by a migration: the existing data is what the command is for.
"""
from __future__ import annotations

import io
import json

from django.core.management import CommandError, call_command
from django.test import Client, TestCase

from core.models import AuditLog, Role, User


def _person(email, name, role=Role.FACULTY, **extra):
    return User.objects.create_user(email=email, password=None, name=name, role=role, **extra)


class OneHeadPerDepartmentTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.office = _person("dh-office@test.edu", "Office", Role.RESEARCH_CELL)
        cls.head = _person("dh-head@test.edu", "Dr Current Head", Role.HOD, department="CSE")
        cls.member = _person("dh-member@test.edu", "Dr Next Head", department="CSE")
        cls.elsewhere = _person("dh-ece@test.edu", "Dr Ece Person", department="ECE")

    def setUp(self):
        self.client = Client()
        self.client.force_login(self.office)

    def patch(self, user, body):
        return self.client.patch(
            f"/api/admin/users/{user.id}", data=json.dumps(body),
            content_type="application/json",
        )

    def create(self, body):
        return self.client.post(
            "/api/admin/users", data=json.dumps(body), content_type="application/json"
        )

    def roles(self):
        self.head.refresh_from_db()
        self.member.refresh_from_db()
        return self.head.role, self.member.role

    # ---- the refusal ------------------------------------------------------

    def test_a_second_head_is_refused_with_409_naming_the_current_one(self):
        r = self.patch(self.member, {"role": Role.HOD})
        self.assertEqual(r.status_code, 409, r.content)
        detail = r.json()["detail"]
        self.assertIn("Dr Current Head", detail)
        self.assertIn("CSE", detail)
        self.assertEqual(self.roles(), (Role.HOD, Role.FACULTY), "nothing was written")

    def test_the_department_is_matched_as_the_office_types_it(self):
        self.elsewhere.department = "  cse "
        self.elsewhere.save()
        r = self.patch(self.elsewhere, {"role": Role.HOD})
        self.assertEqual(r.status_code, 409, r.content)

    def test_moving_a_head_into_a_department_that_has_one_is_refused(self):
        ece_head = _person("dh-ecehead@test.edu", "Dr Ece Head", Role.HOD, department="ECE")
        r = self.patch(ece_head, {"department": "CSE"})
        self.assertEqual(r.status_code, 409, r.content)
        ece_head.refresh_from_db()
        self.assertEqual(ece_head.department, "ECE")

    def test_reactivating_a_second_head_is_refused(self):
        dormant = _person(
            "dh-dormant@test.edu", "Dr Dormant", Role.HOD, department="CSE", active=False
        )
        r = self.patch(dormant, {"active": True})
        self.assertEqual(r.status_code, 409, r.content)

    def test_an_inactive_head_does_not_hold_the_post(self):
        self.head.active = False
        self.head.save()
        r = self.patch(self.member, {"role": Role.HOD})
        self.assertEqual(r.status_code, 200, r.content)

    def test_creating_a_second_head_is_refused(self):
        r = self.create({"email": "dh-new@test.edu", "name": "Dr New", "role": Role.HOD,
                         "department": "CSE"})
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("Dr Current Head", r.json()["detail"])
        self.assertFalse(User.objects.filter(email="dh-new@test.edu").exists())

    def test_an_edit_that_does_not_touch_the_post_is_not_blocked(self):
        """A department that already has two heads from before the rule must
        not freeze every unrelated edit to them."""
        _person("dh-legacy@test.edu", "Dr Legacy Second", Role.HOD, department="CSE")
        admin = _person("dh-admin@test.edu", "Admin", Role.SUPER_ADMIN)
        self.client.force_login(admin)
        r = self.patch(self.head, {"designation": "Professor and Head"})
        self.assertEqual(r.status_code, 200, r.content)
        # Sent unchanged, as a whole-form save would: still not a change of post.
        r = self.patch(self.head, {"active": True, "department": "CSE"})
        self.assertEqual(r.status_code, 200, r.content)

    # ---- no department ----------------------------------------------------

    def test_a_head_of_no_department_is_refused(self):
        r = self.patch(self.elsewhere, {"role": Role.HOD, "department": ""})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("department", r.json()["detail"].lower())

    def test_a_head_s_department_cannot_be_cleared(self):
        r = self.patch(self.head, {"department": None})
        self.assertEqual(r.status_code, 400, r.content)
        self.head.refresh_from_db()
        self.assertEqual(self.head.department, "CSE")

    def test_switching_off_a_legacy_head_of_nothing_is_not_refused(self):
        """Switching an account off takes it out of the post; it cannot be
        made to need a department first."""
        stray = _person("dh-stray@test.edu", "Dr Stray", Role.HOD)
        r = self.patch(stray, {"active": False})
        self.assertEqual(r.status_code, 200, r.content)

    def test_creating_a_head_with_no_department_is_refused(self):
        r = self.create({"email": "dh-nodept@test.edu", "name": "Dr Nowhere", "role": Role.HOD})
        self.assertEqual(r.status_code, 400, r.content)

    # ---- the explicit replace ----------------------------------------------

    def test_replace_demotes_the_previous_head_in_the_same_write(self):
        r = self.patch(self.member, {"role": Role.HOD, "replace_hod": True})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.roles(), (Role.FACULTY, Role.HOD))
        self.assertEqual(r.json()["role"], Role.HOD)

    def test_replace_is_audited_against_the_demoted_account(self):
        self.patch(self.member, {"role": Role.HOD, "replace_hod": True})
        entry = AuditLog.objects.get(action="HOD_REPLACED", entity_id=self.head.id)
        self.assertEqual(entry.actor_id, self.office.id)
        detail = json.loads(entry.detail_json)
        self.assertEqual(detail["department"], "CSE")
        self.assertEqual(detail["from"], Role.HOD)
        self.assertEqual(detail["to"], Role.FACULTY)
        self.assertEqual(detail["replaced_by"], self.member.id)
        # And the promotion itself is the ordinary account-edit entry.
        self.assertTrue(
            AuditLog.objects.filter(action="USER_UPDATE", entity_id=self.member.id).exists()
        )

    def test_replace_is_not_stored_on_the_account(self):
        r = self.patch(self.member, {"role": Role.HOD, "replace_hod": True})
        self.assertNotIn("replace_hod", r.json())
        changed = json.loads(
            AuditLog.objects.get(action="USER_UPDATE", entity_id=self.member.id).detail_json
        )
        self.assertEqual(set(changed), {"role"})

    def test_a_refused_replace_changes_nothing(self):
        """Both halves in one transaction: if the new head cannot be written,
        the old one keeps the post."""
        r = self.patch(self.member, {"role": Role.HOD, "department": "", "replace_hod": True})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.roles(), (Role.HOD, Role.FACULTY))
        self.assertFalse(AuditLog.objects.filter(action="HOD_REPLACED").exists())

    def test_replace_on_create(self):
        r = self.create({"email": "dh-new2@test.edu", "name": "Dr New Two", "role": Role.HOD,
                         "department": "CSE", "replace_hod": True})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(User.objects.get(email="dh-new2@test.edu").role, Role.HOD)
        self.head.refresh_from_db()
        self.assertEqual(self.head.role, Role.FACULTY)
        self.assertTrue(AuditLog.objects.filter(action="HOD_REPLACED", entity_id=self.head.id).exists())

    def test_re_saving_the_current_head_is_not_a_conflict_with_themselves(self):
        r = self.patch(self.head, {"role": Role.HOD, "department": "CSE"})
        self.assertEqual(r.status_code, 200, r.content)


class ResearchFacultyDirectoryTests(TestCase):
    """The People list filters on research faculty, beside the role filter."""

    @classmethod
    def setUpTestData(cls):
        cls.office = _person("rf-office@test.edu", "Office", Role.SUPER_ADMIN)
        cls.research = _person("rf-research@test.edu", "Dr Research", faculty_type="RESEARCH",
                               research_quota=4, department="CSE")
        cls.regular = _person("rf-regular@test.edu", "Dr Regular", department="CSE")

    def test_filter_by_faculty_type(self):
        client = Client()
        client.force_login(self.office)
        r = client.get("/api/admin/users?faculty_type=RESEARCH")
        self.assertEqual(r.status_code, 200, r.content)
        emails = [u["email"] for u in r.json()["results"]]
        self.assertEqual(emails, ["rf-research@test.edu"])
        self.assertEqual(r.json()["results"][0]["research_quota"], 4)

    def test_research_yes_no_and_quota_keep_the_existing_rules(self):
        """Super admin only; a quota needs a research post; never negative."""
        client = Client()
        client.force_login(self.office)
        r = client.patch(f"/api/admin/users/{self.regular.id}",
                         data=json.dumps({"faculty_type": "RESEARCH", "research_quota": 3}),
                         content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["faculty_type"], r.json()["research_quota"]), ("RESEARCH", 3))
        r = client.patch(f"/api/admin/users/{self.regular.id}",
                         data=json.dumps({"faculty_type": "REGULAR"}),
                         content_type="application/json")
        self.assertIsNone(r.json()["research_quota"], "a regular post carries no quota")

        cell = _person("rf-cell@test.edu", "Cell", Role.RESEARCH_CELL)
        client.force_login(cell)
        r = client.patch(f"/api/admin/users/{self.regular.id}",
                         data=json.dumps({"faculty_type": "RESEARCH"}),
                         content_type="application/json")
        self.assertEqual(r.status_code, 403, r.content)


# --------------------------------------------------------------------------- #
# The command                                                                 #
# --------------------------------------------------------------------------- #


class AssignHeadsCommandTests(TestCase):
    def setUp(self):
        # CSE: exactly one "Head" -- made head.
        self.cse_head = _person("ah-cse@test.edu", "Dr Cse Head", department="CSE",
                                designation="Professor & HEAD")
        _person("ah-cse2@test.edu", "Dr Cse Member", department="CSE", designation="Professor")
        # ECE: two -- reported, left alone.
        self.ece_a = _person("ah-ece1@test.edu", "Dr Ece One", department="ECE",
                             designation="Head of Department")
        self.ece_b = _person("ah-ece2@test.edu", "Dr Ece Two", department="ECE",
                             designation="Associate Professor and Head (i/c)")
        # MECH: none -- reported, left alone.
        _person("ah-mech@test.edu", "Dr Mech", department="MECH", designation="Professor")
        # EEE: already right -- reported as such.
        self.eee_head = _person("ah-eee@test.edu", "Dr Eee Head", Role.HOD, department="EEE",
                                designation="Head")
        # CIVIL: the designation names somebody other than the current head.
        self.civil_old = _person("ah-civil-old@test.edu", "Dr Civil Old", Role.HOD,
                                 department="CIVIL", designation="Professor")
        self.civil_new = _person("ah-civil-new@test.edu", "Dr Civil New", department="CIVIL",
                                 designation="Head, Civil Engineering")
        # Not considered: inactive, and an office account whose title says head.
        _person("ah-gone@test.edu", "Dr Gone", department="MECH", designation="Head",
                active=False)
        self.fin = _person("ah-fin@test.edu", "Head of Accounts", Role.FINANCE,
                           department="MECH", designation="Head - Accounts")

    def run_cmd(self, *args):
        out = io.StringIO()
        call_command("assign_heads", *args, stdout=out)
        return out.getvalue()

    def role(self, user):
        user.refresh_from_db()
        return user.role

    def test_dry_run_reports_every_department_and_writes_nothing(self):
        out = self.run_cmd("--from-designation", "--dry-run")
        self.assertIn("dry run", out.lower())
        self.assertIn("CSE: Dr Cse Head <ah-cse@test.edu> -> HOD", out)
        self.assertIn("ECE: several", out)
        self.assertIn("ah-ece1@test.edu", out)
        self.assertIn("ah-ece2@test.edu", out)
        self.assertIn("MECH: none", out)
        self.assertIn("EEE: already HOD", out)
        self.assertIn("CIVIL: Dr Civil New <ah-civil-new@test.edu> -> HOD", out)
        self.assertIn("replaces Dr Civil Old <ah-civil-old@test.edu>", out)
        self.assertEqual(self.role(self.cse_head), Role.FACULTY)
        self.assertEqual(self.role(self.civil_old), Role.HOD)
        self.assertFalse(AuditLog.objects.exists())

    def test_apply_makes_exactly_the_unambiguous_ones_head(self):
        self.run_cmd("--from-designation")
        self.assertEqual(self.role(self.cse_head), Role.HOD)
        self.assertEqual(self.role(self.ece_a), Role.FACULTY, "several: not guessed")
        self.assertEqual(self.role(self.ece_b), Role.FACULTY)
        self.assertEqual(self.role(self.eee_head), Role.HOD)
        self.assertEqual(self.role(self.civil_new), Role.HOD)
        self.assertEqual(self.role(self.civil_old), Role.FACULTY, "one head per department")
        self.assertEqual(self.role(self.fin), Role.FINANCE, "an office account is never touched")
        self.assertEqual(
            User.objects.filter(role=Role.HOD, department="CIVIL", active=True).count(), 1
        )

    def test_apply_is_audited(self):
        self.run_cmd("--from-designation")
        self.assertTrue(AuditLog.objects.filter(action="USER_ROLE_CHANGE",
                                                entity_id=self.cse_head.id).exists())
        replaced = AuditLog.objects.get(action="HOD_REPLACED", entity_id=self.civil_old.id)
        self.assertEqual(json.loads(replaced.detail_json)["replaced_by"], self.civil_new.id)

    def test_running_it_twice_changes_nothing_the_second_time(self):
        self.run_cmd("--from-designation")
        before = AuditLog.objects.count()
        out = self.run_cmd("--from-designation")
        self.assertEqual(AuditLog.objects.count(), before)
        self.assertIn("CSE: already HOD", out)

    def test_principal(self):
        dean = _person("ah-principal@test.edu", "Dr Principal To Be", department="CSE",
                       designation="Principal")
        out = self.run_cmd("--principal", "AH-Principal@test.edu")
        self.assertEqual(self.role(dean), Role.PRINCIPAL)
        self.assertIn("ah-principal@test.edu", out)
        self.assertTrue(AuditLog.objects.filter(action="USER_ROLE_CHANGE", entity_id=dean.id).exists())

    def test_principal_dry_run_writes_nothing(self):
        dean = _person("ah-principal2@test.edu", "Dr Principal Two")
        self.run_cmd("--principal", dean.email, "--dry-run")
        self.assertEqual(self.role(dean), Role.FACULTY)

    def test_principal_is_not_taken_from_an_office_that_moves_money(self):
        with self.assertRaises(CommandError):
            self.run_cmd("--principal", self.fin.email)
        self.assertEqual(self.role(self.fin), Role.FINANCE)

    def test_an_unknown_principal_is_an_error(self):
        with self.assertRaises(CommandError):
            self.run_cmd("--principal", "nobody@test.edu")

    def test_asked_for_nothing_is_an_error(self):
        with self.assertRaises(CommandError):
            self.run_cmd()

    def test_the_principal_is_settled_before_the_heads(self):
        """A principal whose designation also says head is not then made a head."""
        self.cse_head.designation = "Principal and Head"
        self.cse_head.save()
        self.run_cmd("--principal", self.cse_head.email, "--from-designation")
        self.assertEqual(self.role(self.cse_head), Role.PRINCIPAL)
