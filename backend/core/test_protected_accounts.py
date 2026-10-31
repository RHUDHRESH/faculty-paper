"""The office manages accounts, but not the ones that decide whether money moves.

`can_manage_users` covers the research cell and the research coordinator, which
is right: creating, correcting and resetting faculty and head-of-department
accounts is their job. It also let them reset the password of the Super Admin,
the Director, Finance or the Principal and sign in as them -- the desk that
clears a claim could take over the desks that approve, authorise and pay it.

For those four roles (`rbac.PROTECTED_ROLES`) every user-management write is a
super admin's alone, whether the account is the *target* (reset, edit,
deactivate, merge) or the role is being *given* (create, promote). A refusal is
a 403 that changes nothing and leaves a `USER_ACTION_REFUSED` audit row.
"""
from __future__ import annotations

import json

from core.models import AuditLog, Role, User
from core.services import issue_passwords, rbac
from core.test_chain_rules import ChainBase

NEW_PASSWORD = "taken-over-1"


def _snapshot(user: User) -> tuple:
    user = User.objects.get(pk=user.pk)
    return (
        user.password, user.role, user.active, user.email, user.name,
        user.department, user.must_change_password,
    )


class ProtectedAccounts(ChainBase):
    def setUp(self):
        super().setUp()
        self.second_admin = User.objects.create_user(
            email="chain-admin2@test.edu", password=None, name="Second Superadmin",
            role=Role.SUPER_ADMIN,
        )
        self.protected = {
            "super admin": self.second_admin,
            "director": self.director,
            "finance": self.finance,
            "principal": self.principal,
        }
        self.office = {"research coordinator": self.coordinator, "research cell": self.cell}

    def _patch(self, actor, target, body):
        return self._as(actor).patch(
            f"/api/admin/users/{target.id}", data=json.dumps(body), content_type="application/json"
        )

    def _refused_rows(self, actor, target):
        return AuditLog.objects.filter(
            action="USER_ACTION_REFUSED", actor=actor, entity="User", entity_id=target.id
        )

    def assertRefused(self, response, actor, target, before):
        self.assertEqual(response.status_code, 403, response.content)
        self.assertEqual(_snapshot(target), before, "the account must be untouched")
        self.assertTrue(self._refused_rows(actor, target).exists(), "the refusal is on the record")

    # ---- the office is refused -------------------------------------------

    def test_the_office_cannot_reset_a_protected_password_by_id(self):
        for actor_label, actor in self.office.items():
            for label, target in self.protected.items():
                with self.subTest(actor=actor_label, target=label):
                    before = _snapshot(target)
                    r = self._post(actor, f"/api/admin/users/{target.id}/reset-password",
                                   {"password": NEW_PASSWORD})
                    self.assertRefused(r, actor, target, before)
                    self.assertFalse(User.objects.get(pk=target.pk).check_password(NEW_PASSWORD))

    def test_the_office_cannot_reset_a_protected_password_by_email(self):
        for actor_label, actor in self.office.items():
            for label, target in self.protected.items():
                with self.subTest(actor=actor_label, target=label):
                    before = _snapshot(target)
                    r = self._post(actor, "/api/admin/reset-password",
                                   {"email": target.email, "password": NEW_PASSWORD})
                    self.assertRefused(r, actor, target, before)
                    self.assertFalse(User.objects.get(pk=target.pk).check_password(NEW_PASSWORD))

    def test_the_office_cannot_edit_a_protected_account(self):
        bodies = [
            {"role": "FACULTY"},
            {"active": False},
            {"department": "ECE"},
            {"email": "mine@test.edu"},
            {"name": "Renamed"},
        ]
        for actor_label, actor in self.office.items():
            for label, target in self.protected.items():
                for body in bodies:
                    with self.subTest(actor=actor_label, target=label, body=body):
                        before = _snapshot(target)
                        self.assertRefused(self._patch(actor, target, body), actor, target, before)

    def test_the_office_cannot_hand_out_a_protected_role(self):
        for actor_label, actor in self.office.items():
            for role in rbac.PROTECTED_ROLES:
                with self.subTest(actor=actor_label, role=role, how="promote"):
                    before = _snapshot(self.faculty)
                    r = self._patch(actor, self.faculty, {"role": role})
                    self.assertEqual(r.status_code, 403, r.content)
                    self.assertEqual(_snapshot(self.faculty), before)
                with self.subTest(actor=actor_label, role=role, how="create"):
                    email = f"minted-{role.lower()}@test.edu"
                    r = self._post(actor, "/api/admin/users", {
                        "email": email, "name": "Minted", "role": role,
                        "password": "a-long-enough-one",
                    })
                    self.assertEqual(r.status_code, 403, r.content)
                    self.assertFalse(User.objects.filter(email=email).exists())

    def test_the_office_cannot_switch_a_protected_account_off_by_merging_it(self):
        for label, target in self.protected.items():
            for keep, drop in ((self.faculty, target), (target, self.faculty)):
                with self.subTest(target=label, protected_is="dropped" if drop is target else "kept"):
                    before = _snapshot(target)
                    r = self._post(self.coordinator, "/api/admin/duplicate-accounts/merge",
                                   {"keep_id": keep.id, "drop_id": drop.id, "confirm": True})
                    self.assertRefused(r, self.coordinator, target, before)
                    self.assertTrue(User.objects.get(pk=self.faculty.pk).active)

    def test_the_bulk_password_scopes_skip_protected_accounts_unless_super_admin(self):
        everyone = [u.id for u in self.protected.values()]
        for actor in self.office.values():
            for scope in (
                dict(who="role", role=Role.FINANCE),
                dict(who="role", role=Role.PRINCIPAL),
                dict(who="ids", ids=everyone),
                dict(who="all"),
            ):
                with self.subTest(actor=actor.role, scope=scope):
                    qs = issue_passwords.scope_queryset(**scope, actor=actor)
                    self.assertFalse(
                        qs.filter(role__in=rbac.PROTECTED_ROLES).exists(), "a protected account is in scope"
                    )
        in_scope = issue_passwords.scope_queryset("ids", ids=everyone, actor=self.admin)
        self.assertEqual({u.id for u in in_scope}, set(everyone), "a super admin may name them")
        finance = issue_passwords.scope_queryset("role", role=Role.FINANCE, actor=self.admin)
        self.assertEqual([u.id for u in finance], [self.finance.id])

    # ---- the office keeps the rest of its job -----------------------------

    def test_the_office_still_resets_faculty_and_head_of_department_accounts(self):
        for actor_label, actor in self.office.items():
            for target in (self.faculty, self.hod):
                with self.subTest(actor=actor_label, target=target.role):
                    r = self._post(actor, f"/api/admin/users/{target.id}/reset-password",
                                   {"password": NEW_PASSWORD})
                    self.assertEqual(r.status_code, 200, r.content)
                    target.refresh_from_db()
                    self.assertTrue(target.check_password(NEW_PASSWORD))
                    self.assertTrue(target.must_change_password)

                    r = self._post(actor, "/api/admin/reset-password",
                                   {"email": target.email, "password": NEW_PASSWORD + "-again"})
                    self.assertEqual(r.status_code, 200, r.content)
                    target.refresh_from_db()
                    self.assertTrue(target.check_password(NEW_PASSWORD + "-again"))

    def test_the_office_still_edits_creates_and_switches_off_ordinary_accounts(self):
        r = self._patch(self.coordinator, self.faculty, {"department": "ECE"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch(self.coordinator, self.faculty, {"active": False})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(User.objects.get(pk=self.faculty.pk).active)
        r = self._patch(self.coordinator, self.faculty, {"active": True})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch(self.cell, self.faculty, {"role": "HOD", "department": "MECH"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._post(self.coordinator, "/api/admin/users", {
            "email": "newhire@test.edu", "name": "New Hire", "role": "FACULTY",
            "password": "a-long-enough-one",
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._refused_rows(self.coordinator, self.faculty).count(), 0)

    def test_the_office_still_changes_its_own_password(self):
        self.coordinator.set_password("old-password-1")
        self.coordinator.save()
        r = self._post(self.coordinator, "/api/auth/change-password",
                       {"current_password": "old-password-1", "new_password": "new-password-2"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(User.objects.get(pk=self.coordinator.pk).check_password("new-password-2"))

    # ---- a super admin can do all of it ----------------------------------

    def test_a_super_admin_manages_the_protected_accounts(self):
        for label, target in self.protected.items():
            with self.subTest(target=label):
                r = self._post(self.admin, f"/api/admin/users/{target.id}/reset-password",
                               {"password": NEW_PASSWORD})
                self.assertEqual(r.status_code, 200, r.content)
                r = self._post(self.admin, "/api/admin/reset-password",
                               {"email": target.email, "password": NEW_PASSWORD + "-again"})
                self.assertEqual(r.status_code, 200, r.content)
                target.refresh_from_db()
                self.assertTrue(target.check_password(NEW_PASSWORD + "-again"))

                self.assertEqual(self._patch(self.admin, target, {"active": False}).status_code, 200)
                self.assertFalse(User.objects.get(pk=target.pk).active)
                self.assertEqual(self._patch(self.admin, target, {"active": True}).status_code, 200)
                self.assertEqual(self._patch(self.admin, target, {"department": "ECE"}).status_code, 200)
                self.assertFalse(self._refused_rows(self.admin, target).exists())

    def test_a_super_admin_still_creates_and_promotes_to_a_protected_role(self):
        r = self._post(self.admin, "/api/admin/users", {
            "email": "newprincipal@test.edu", "name": "New Principal", "role": "PRINCIPAL",
            "password": "a-long-enough-one",
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(User.objects.get(email="newprincipal@test.edu").role, Role.PRINCIPAL)
        r = self._patch(self.admin, self.faculty, {"role": "FINANCE"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(User.objects.get(pk=self.faculty.pk).role, Role.FINANCE)
