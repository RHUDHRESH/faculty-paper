"""The Vice principal: sees what the Principal sees, decides nothing, still files papers.

Plus the data migration 0090 that seats the account and gives EEE its own head.
"""
from __future__ import annotations

import importlib
import json

from django.apps import apps as real_apps
from django.test import TestCase

from core.models import AuditLog, Claim, ClaimStatus, Role, User
from core.services import notify, rbac
from core.test_chain_rules import ChainBase

migration = importlib.import_module("core.migrations.0090_vice_principal")


class VicePrincipalBase(ChainBase):
    def setUp(self):
        super().setUp()
        self.vp = User.objects.create_user(
            email="vp-test@test.edu", password=None, name="Vimala Vice", role=Role.VICE_PRINCIPAL,
            department="ECE", staff_id="STF-VP1",
        )


class ViceprincipalReads(VicePrincipalBase):
    """Everything the Principal can read, the Vice principal can read."""

    def test_the_college_wide_readers_include_the_vice_principal(self):
        for helper in (
            rbac.can_view_college_wide,
            rbac.can_view_reports,
            rbac.can_view_audit,
            rbac.can_read_conflicts,
            rbac.can_file_own_papers,
        ):
            self.assertTrue(helper(Role.VICE_PRINCIPAL), helper.__name__)
        self.assertEqual(rbac.portal_for_role(Role.VICE_PRINCIPAL), "principal")

    def test_every_read_the_principal_has_is_open(self):
        self._claim(ClaimStatus.PAID, ticket="VP-PAID")
        urls = (
            "/api/dashboard/top5",
            "/api/dashboard",
            "/api/reports",
            "/api/reports/papers",
            "/api/track",
            "/api/journals/top",
            "/api/directory/faculty",
            "/api/payouts/months",
            "/api/admin/conflicts",
            "/api/claims",
        )
        for url in urls:
            with self.subTest(url=url):
                principal = self._as(self.principal).get(url)
                vice = self._as(self.vp).get(url)
                self.assertEqual(principal.status_code, 200, f"{url} for the Principal")
                self.assertEqual(vice.status_code, 200, f"{url} {vice.content[:200]}")

    def test_the_top5_board_shows_the_vice_principal_the_money_list(self):
        r = self._as(self.vp).get("/api/dashboard/top5")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(set(r.json()) & {"snip", "remuneration", "count"}, {"snip", "remuneration", "count"})

    def test_a_journal_opens_as_the_college_view_with_authors_and_amounts(self):
        self._claim(ClaimStatus.PAID, ticket="VP-J1", remuneration=12345)
        body = self._as(self.vp).get("/api/journals/report", {"title": "Nature"}).json()
        self.assertNotIn("view", body)
        self.assertEqual(body["totals"]["publications"], 1)

    def test_faculty_still_cannot_read_what_the_vice_principal_reads(self):
        for url in ("/api/admin/conflicts", "/api/dashboard/top5", "/api/payouts/months", "/api/journals/top"):
            with self.subTest(url=url):
                self.assertEqual(self._as(self.faculty).get(url).status_code, 403)

    def test_settling_a_conflict_stays_with_the_office(self):
        self.assertFalse(rbac.can_manage_users(Role.VICE_PRINCIPAL))
        r = self._post(self.vp, "/api/admin/conflicts/nothing/resolve", {"action": "dismiss"})
        self.assertEqual(r.status_code, 403, r.content)


class ViceprincipalCannotAct(VicePrincipalBase):
    """No approving, authorising, paying, clearing or managing accounts."""

    def test_no_helper_that_acts_lists_the_vice_principal(self):
        role = Role.VICE_PRINCIPAL
        for helper in (
            rbac.can_clear_claims,
            rbac.can_reject_claims,
            rbac.can_approve_as_director,
            rbac.can_approve_as_finance,
            rbac.can_manage_users,
            rbac.can_import_prior,
            rbac.can_edit_formula,
            rbac.can_admin_portal,
            rbac.can_finance_portal,
            rbac.can_director_portal,
            rbac.can_principal_portal,
            rbac.can_review_flags,
            rbac.sits_at_a_desk,
        ):
            self.assertFalse(helper(role), helper.__name__)
        for desk in (rbac.SUPERVISOR_DESK, rbac.PRINCIPAL_DESK):
            self.assertFalse(rbac.can_act_at_desk(role, desk))

    def _expect_refused(self, claim, path, body=None):
        before = claim.status
        r = self._post(self.vp, path.format(id=claim.id), body or {"note": "Looks fine to me"})
        self.assertEqual(r.status_code, 403, f"{path}: {r.status_code} {r.content[:200]}")
        claim.refresh_from_db()
        self.assertEqual(claim.status, before, path)

    def test_the_vice_principal_cannot_move_a_claim_at_any_desk(self):
        submitted = self._claim(ClaimStatus.SUBMITTED, ticket="VP-S")
        cleared = self._claim(ClaimStatus.CLEARED, ticket="VP-C")
        approved = self._claim(ClaimStatus.PRINCIPAL_APPROVED, ticket="VP-A")
        authorised = self._claim(ClaimStatus.DIRECTOR_APPROVED, ticket="VP-D")
        for claim, paths in (
            (submitted, ("/api/claims/{id}/clear", "/api/claims/{id}/hold")),
            (cleared, ("/api/claims/{id}/principal-approve", "/api/claims/{id}/principal-reject",
                       "/api/claims/{id}/hold", "/api/claims/{id}/clear")),
            (approved, ("/api/claims/{id}/director-approve", "/api/claims/{id}/director-reject")),
            (authorised, ("/api/claims/{id}/mark-paid",)),
        ):
            for path in paths:
                with self.subTest(path=path, status=claim.status):
                    self._expect_refused(claim, path, {"note": "Looks fine to me", "reason": "Not a decision of mine"})

    def test_the_vice_principal_cannot_work_the_queues_or_manage_accounts(self):
        self.assertEqual(self._as(self.vp).get("/api/principal/queue").status_code, 403)
        self.assertEqual(self._as(self.vp).get("/api/admin/users").status_code, 403)
        r = self._post(self.vp, "/api/admin/users", {
            "email": "minted-by-vp@test.edu", "name": "Minted", "role": "FACULTY",
            "password": "a-long-enough-one",
        })
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(User.objects.filter(email="minted-by-vp@test.edu").exists())

    def test_the_vice_principal_does_not_decide_a_paper_for_the_principals_or_anyones_desk(self):
        claim = self._claim(ClaimStatus.CLEARED, ticket="VP-BULK")
        r = self._post(self.vp, "/api/principal/bulk-approve", {"claim_ids": [claim.id]})
        self.assertEqual(r.status_code, 403, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)


class ViceprincipalStillFiles(VicePrincipalBase):
    def test_it_is_a_claimant(self):
        self.assertIn(Role.VICE_PRINCIPAL, rbac.CLAIMANT_ROLES)
        self.assertTrue(rbac.can_file_own_papers(Role.VICE_PRINCIPAL))
        self.assertTrue(rbac.can_issue_claims(Role.VICE_PRINCIPAL))

    def test_it_starts_and_tracks_its_own_draft(self):
        r = self._post(self.vp, "/api/claims", {"paper_title": "Vice principal field study"})
        self.assertEqual(r.status_code, 200, r.content)
        claim = Claim.objects.get(pk=r.json()["id"])
        self.assertEqual(claim.owner_id, self.vp.id)
        mine = self._as(self.vp).get("/api/claims/counts?mine=true").json()
        self.assertEqual(mine["counts"]["draft"], 1)

    def test_it_never_decides_its_own_paper(self):
        claim = self._claim(ClaimStatus.CLEARED, ticket="VP-OWN", owner=self.vp)
        self.assertTrue(rbac.is_own_claim(self.vp, claim))

    def test_it_gets_claimant_notices_and_the_principals_college_notices(self):
        self.assertTrue(notify.applies_to(notify.kind_of("badge"), self.vp))
        self.assertTrue(notify.applies_to(notify.kind_of("target"), self.vp))
        self.assertFalse(notify.applies_to(notify.kind_of("target"), self.faculty))


class ViceprincipalIsProtected(VicePrincipalBase):
    def test_only_a_super_admin_manages_the_account(self):
        self.assertIn(Role.VICE_PRINCIPAL, rbac.PROTECTED_ROLES)
        for actor in (self.cell, self.coordinator):
            r = self._post(actor, f"/api/admin/users/{self.vp.id}/reset-password", {"password": "taken-over-1"})
            self.assertEqual(r.status_code, 403, r.content)
            r = self._as(actor).patch(
                f"/api/admin/users/{self.vp.id}", data=json.dumps({"active": False}),
                content_type="application/json",
            )
            self.assertEqual(r.status_code, 403, r.content)
            r = self._post(actor, "/api/admin/users", {
                "email": "second-vp@test.edu", "name": "Second", "role": "VICE_PRINCIPAL",
                "password": "a-long-enough-one",
            })
            self.assertEqual(r.status_code, 403, r.content)
        self.vp.refresh_from_db()
        self.assertTrue(self.vp.active)
        self.assertTrue(
            AuditLog.objects.filter(action="USER_ACTION_REFUSED", entity_id=self.vp.id).exists()
        )

    def test_a_super_admin_may_seat_one(self):
        r = self._post(self.admin, "/api/admin/users", {
            "email": "seated-vp@test.edu", "name": "Seated", "role": "VICE_PRINCIPAL",
            "password": "a-long-enough-one",
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(User.objects.get(email="seated-vp@test.edu").role, Role.VICE_PRINCIPAL)


class EeeHeadIsScopedToEee(ChainBase):
    def test_the_head_sees_eee_papers_and_no_money(self):
        migration.add_eee_head(real_apps, None)
        head = User.objects.get(email=migration.EEE_HEAD_EMAIL)
        eee = User.objects.create_user(
            email="eee-fac@test.edu", password=None, name="Elan Electrical", role=Role.FACULTY,
            department="EEE", staff_id="STF-EEE1",
        )
        self._claim(ClaimStatus.PAID, ticket="EEE-1", owner=eee, journal_title="Power Journal", remuneration=44444)
        self._claim(ClaimStatus.PAID, ticket="CSE-1", journal_title="Power Journal", remuneration=99999)
        body = self._as(head).get("/api/journals/report", {"title": "Power Journal"}).json()
        self.assertEqual(body["totals"]["publications"], 1)
        raw = json.dumps(body)
        self.assertNotIn("Asha Faculty", raw)
        self.assertNotIn("44444", raw)
        self.assertNotIn("99999", raw)
        top = self._as(head).get("/api/dashboard/top5").json()
        self.assertEqual(top["department"], "EEE")
        self.assertEqual(self._as(head).get("/api/dashboard/top5", {"department": "CSE"}).status_code, 403)


class MigrationSeatsTheAccounts(TestCase):
    """0090's data step, on a synthetic database."""

    def setUp(self):
        # An installation that already has people: on an empty database the
        # migration leaves the first-run setup alone (test_an_empty_database...).
        User.objects.create_user(
            email="somebody@test.edu", password=None, name="Somebody", role=Role.SUPER_ADMIN
        )
        User.objects.filter(email__in=[migration.EEE_HEAD_EMAIL, migration.VP_EMAIL]).delete()
        # The log is append-only: count only what this test's run adds.
        self.before = set(AuditLog.objects.values_list("id", flat=True))

    def _run(self):
        migration.forwards(real_apps, None)

    def _logged(self, action):
        return [
            a for a in AuditLog.objects.filter(action=action).exclude(id__in=self.before)
            if migration.VIA in (a.detail_json or "")
        ]

    def test_a_faculty_account_becomes_the_vice_principal_and_it_is_logged_once(self):
        u = User.objects.create_user(
            email="VicePrincipal@Saveetha.ac.in", password="x", name="V P",
            role=Role.FACULTY, department="ECE",
        )
        self._run()
        u.refresh_from_db()
        self.assertEqual(u.role, Role.VICE_PRINCIPAL)
        self.assertEqual(len(self._logged("USER_UPDATE")), 1)
        self._run()
        u.refresh_from_db()
        self.assertEqual(u.role, Role.VICE_PRINCIPAL)
        self.assertEqual(len(self._logged("USER_UPDATE")), 1, "the second run changes and logs nothing")

    def test_a_head_of_department_account_also_becomes_the_vice_principal(self):
        u = User.objects.create_user(
            email=migration.VP_EMAIL.upper(), password=None, name="V P", role=Role.HOD, department="MECH",
        )
        self._run()
        u.refresh_from_db()
        self.assertEqual(u.role, Role.VICE_PRINCIPAL)

    def test_an_account_in_any_other_role_is_left_alone(self):
        u = User.objects.create_user(
            email=migration.VP_EMAIL, password=None, name="V P", role=Role.FINANCE,
        )
        self._run()
        u.refresh_from_db()
        self.assertEqual(u.role, Role.FINANCE)
        self.assertEqual(self._logged("USER_UPDATE"), [])

    def test_an_empty_database_gets_no_account_so_first_run_setup_still_opens(self):
        User.objects.all().delete()
        self._run()
        self.assertFalse(User.objects.exists())

    def test_no_vice_principal_account_is_not_an_error(self):
        self._run()
        self.assertFalse(User.objects.filter(role=Role.VICE_PRINCIPAL, email=migration.VP_EMAIL).exists())

    def test_eee_gets_its_own_head_exactly_once(self):
        self._run()
        head = User.objects.get(email=migration.EEE_HEAD_EMAIL)
        self.assertEqual(head.role, Role.HOD)
        self.assertEqual(head.department, "EEE")
        self.assertEqual(head.name, "Head of Department, EEE")
        self.assertTrue(head.active)
        self.assertFalse(head.has_usable_password())
        self.assertFalse(head.must_change_password)
        self.assertFalse(head.staff_id)
        created = self._logged("USER_CREATE")
        self.assertEqual(len(created), 1)
        self.assertEqual(created[0].entity_id, head.id)
        self._run()
        self.assertEqual(User.objects.filter(email=migration.EEE_HEAD_EMAIL).count(), 1)
        self.assertEqual(len(self._logged("USER_CREATE")), 1)

    def test_it_is_skipped_when_an_eee_head_already_exists(self):
        User.objects.create_user(
            email="existing.eee.head@test.edu", password=None, name="Existing Head", role=Role.HOD,
            department=" eee ", active=True,
        )
        self._run()
        self.assertFalse(User.objects.filter(email=migration.EEE_HEAD_EMAIL).exists())
        self.assertEqual(self._logged("USER_CREATE"), [])

    def test_a_switched_off_eee_head_does_not_count(self):
        User.objects.create_user(
            email="old.eee.head@test.edu", password=None, name="Old Head", role=Role.HOD,
            department="EEE", active=False,
        )
        self._run()
        self.assertTrue(User.objects.filter(email=migration.EEE_HEAD_EMAIL, active=True).exists())

    def test_a_head_of_another_department_does_not_count(self):
        User.objects.create_user(
            email="cse.head@test.edu", password=None, name="CSE Head", role=Role.HOD, department="CSE",
        )
        self._run()
        self.assertTrue(User.objects.filter(email=migration.EEE_HEAD_EMAIL).exists())

    def test_the_vice_principal_who_was_the_eee_head_leaves_the_post_to_the_new_account(self):
        User.objects.create_user(
            email=migration.VP_EMAIL, password=None, name="V P", role=Role.HOD, department="EEE",
        )
        self._run()
        self.assertEqual(User.objects.get(email=migration.VP_EMAIL).role, Role.VICE_PRINCIPAL)
        self.assertEqual(User.objects.get(email=migration.EEE_HEAD_EMAIL).role, Role.HOD)

    def test_an_address_already_taken_is_not_taken_over(self):
        owner = User.objects.create_user(
            email=migration.EEE_HEAD_EMAIL, password="x", name="Somebody Else", role=Role.FACULTY,
            department="EEE",
        )
        self._run()
        owner.refresh_from_db()
        self.assertEqual(owner.role, Role.FACULTY)
        self.assertEqual(User.objects.filter(email=migration.EEE_HEAD_EMAIL).count(), 1)
