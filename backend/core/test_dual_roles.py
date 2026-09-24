"""People who hold an office do their own research too, and never decide it.

The owner's words: people with office roles "must be able to do both: do
their own research as well as track others'". A Principal, a research cell
member, the research coordinator, the Director or a Finance officer who is
also an academic files and tracks their own papers exactly as a faculty member
does. Their office screens stay what they were.

Two rules follow, and each class below pins one of them:

- **On their own papers they are the claimant.** The claimant's view of a
  paper -- a stage rather than a desk, "The college" rather than a colleague's
  name, no desk notes, no flags -- applies to them for their own papers and
  for nobody else's. The pattern is `hod.for_head`'s, generalised.
- **Nobody decides their own paper, at any desk.** Clear, send back, hold,
  approve, authorise, pay, the bulk versions of each, void, the overrides:
  refused on the server. Their own paper is not in their own queue; it goes to
  another holder of that desk, or, when there is none, to the super admin --
  who may decide anybody's paper except their own.
"""
from __future__ import annotations

import json
from datetime import date

from django.utils import timezone

from core.models import (
    AuditLog,
    Claim,
    ClaimAction,
    ClaimFlag,
    ClaimNote,
    ClaimStatus,
    Notification,
    PaidLedger,
    Role,
    User,
)
from core.services import rbac
from core.test_chain_rules import ChainBase

#: The message every refusal carries. The screens show the same sentence.
OWN = "your own paper"

REASON = "The DOI resolves to a different paper entirely"


def _fileable(title: str, seed: str) -> dict:
    """Everything the submission gate asks for, as the filing wizard sends it."""
    def media(n: int) -> str:
        return f"/media/claims/{(seed * 32)[:31]}{n}.pdf"

    return {
        "paper_title": title,
        "journal_title": "Journal of Dual Roles",
        "issn": "0140-6736",
        "publication_date": "2026-03-01",
        "indexing_level": "Scopus",
        "yukthi_id": "YK-DUAL",
        "scopus_author_url": "https://www.scopus.com/authid/detail.uri?authorId=1",
        "quartile": "Q2",
        "snip": 1.0,
        "total_authors": 1,
        "author_position": 1,
        "affiliation_ok": True,
        "attachments": [
            {"kind": "PUBLISHED_PAPER", "url": media(1), "filename": "paper.pdf", "size_bytes": 10},
            {"kind": "SEC_REFERENCE", "url": media(2), "filename": "r14.pdf",
             "size_bytes": 10, "ref_number": "14"},
            {"kind": "SEC_REFERENCE", "url": media(3), "filename": "r15.pdf",
             "size_bytes": 10, "ref_number": "15"},
        ],
        "submit": True,
        "contest_forward": True,
        "contest_note": "Filed with my own journal details, please check them.",
    }


class DualRoleBase(ChainBase):
    """The chain's cast, each of whom may also have papers of their own."""

    def _own(self, user, status=ClaimStatus.SUBMITTED, ticket="DR-1", **extra):
        """A paper of `user`'s, at `status`, with the signatures a paper there carries."""
        now = timezone.now()
        stamps = {}
        if status in (
            ClaimStatus.CLEARED, ClaimStatus.PRINCIPAL_APPROVED,
            ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID,
        ):
            stamps.update(cleared_by=self.coordinator, cleared_at=now)
        if status in (ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID):
            stamps.update(
                principal_approved_by=self.admin, principal_approved_at=now,
                second_approved_by=self.admin, second_approved_at=now,
            )
        if status in (ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID):
            stamps.update(director_approved_by=self.admin, director_approved_at=now)
        stamps.update(extra)
        claim = self._claim(status, ticket=ticket, owner=user, **stamps)
        if status == ClaimStatus.PAID:
            claim.paid_at = now
            claim.save(update_fields=["paid_at"])
            PaidLedger.objects.create(
                claim=claim, payout_month=date(2026, 9, 1), amount=claim.remuneration,
                faculty_name=user.name, voucher_number=f"V-{ticket}",
            )
        return claim

    def _get(self, user, path):
        return self._as(user).get(path)

    def assertRefusedAsOwn(self, response, where: str):
        self.assertEqual(response.status_code, 403, f"{where}: {response.content!r}")
        self.assertIn(OWN, response.json()["detail"].lower(), where)

    def assertUnmoved(self, claim, status):
        claim.refresh_from_db()
        self.assertEqual(claim.status, status)


# --------------------------------------------------------------------------- #
# 1. Everybody on the staff but the super admin files their own papers         #
# --------------------------------------------------------------------------- #


class OfficeRolesFileTheirOwnPapersTests(DualRoleBase):
    def _officers(self):
        return (self.cell, self.coordinator, self.principal, self.director, self.finance)

    def test_rbac_counts_every_staff_role_but_the_super_admin_as_a_claimant(self):
        for role in (
            Role.FACULTY, Role.HOD, Role.RESEARCH_CELL, Role.RESEARCH_COORDINATOR,
            Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE,
        ):
            self.assertIn(role, rbac.CLAIMANT_ROLES, role)
            self.assertTrue(rbac.can_file_own_papers(role), role)
            self.assertTrue(rbac.can_issue_claims(role), role)
        self.assertNotIn(Role.SUPER_ADMIN, rbac.CLAIMANT_ROLES)
        self.assertFalse(rbac.can_file_own_papers(Role.SUPER_ADMIN))

    def test_each_officer_files_a_paper_and_it_is_theirs(self):
        for i, officer in enumerate(self._officers()):
            r = self._post(officer, "/api/claims", _fileable(f"Officer paper {i}", "abcde"[i]))
            self.assertEqual(r.status_code, 200, f"{officer.role}: {r.content!r}")
            claim = Claim.objects.get(pk=r.json()["id"])
            self.assertEqual(claim.owner_id, officer.id, officer.role)
            self.assertEqual(claim.status, ClaimStatus.SUBMITTED, officer.role)
            # Filed by the claimant, not on anybody's behalf.
            self.assertTrue(
                ClaimAction.objects.filter(claim=claim, actor=officer, action="CONTEST_FORWARD").exists(),
                officer.role,
            )

    def test_the_super_admin_still_files_only_on_somebody_s_behalf(self):
        r = self._post(self.admin, "/api/claims", _fileable("Admin paper", "f"))
        self.assertEqual(r.status_code, 400, r.content)
        r = self._post(
            self.admin, "/api/claims",
            {**_fileable("For the Principal", "f"), "owner_id": self.principal.id},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Claim.objects.get(pk=r.json()["id"]).owner_id, self.principal.id)

    def test_the_office_still_files_for_a_faculty_member(self):
        r = self._post(
            self.cell, "/api/claims",
            {**_fileable("For Asha", "9"), "owner_id": self.faculty.id},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Claim.objects.get(pk=r.json()["id"]).owner_id, self.faculty.id)

    def test_my_papers_lists_only_the_officer_s_own(self):
        mine = self._own(self.principal, ticket="DR-MINE")
        self._claim(ticket="DR-THEIRS")  # Asha's, which the Principal oversees
        body = self._get(self.principal, "/api/claims?mine=1").json()
        self.assertEqual([c["id"] for c in body["results"]], [mine.id])
        self.assertEqual(body["total"], 1)
        counts = self._get(self.principal, "/api/claims/counts?mine=1").json()["counts"]
        self.assertEqual(counts["all"], 1)
        # Without it the college's list is what it was.
        self.assertEqual(self._get(self.principal, "/api/claims").json()["total"], 2)

    def test_their_own_payments_are_theirs_to_see(self):
        paid = self._own(self.finance, ClaimStatus.PAID, ticket="DR-FP")
        body = self._get(self.finance, "/api/me/payments").json()
        self.assertEqual([r["claim_id"] for r in body["rows"]], [paid.id])
        self.assertEqual(body["total"], round(paid.remuneration, 2))


# --------------------------------------------------------------------------- #
# 2. On their own papers they are the claimant, and on nobody else's           #
# --------------------------------------------------------------------------- #


class TheirOwnPaperIsSeenAsAClaimantSeesItTests(DualRoleBase):
    def _cleared_with_history(self, owner, ticket):
        claim = self._own(owner, ClaimStatus.CLEARED, ticket=ticket, cleared_by=self.cell)
        ClaimAction.objects.create(
            claim=claim, actor=owner, from_status=ClaimStatus.DRAFT,
            to_status=ClaimStatus.SUBMITTED, action="SUBMIT",
        )
        ClaimAction.objects.create(
            claim=claim, actor=self.cell, from_status=ClaimStatus.SUBMITTED,
            to_status=ClaimStatus.CLEARED, action="CLEAR", note="Checked against Scopus",
        )
        return claim

    def test_an_officer_s_own_paper_names_no_desk_and_no_person(self):
        for officer in (self.principal, self.director, self.finance, self.coordinator):
            claim = self._cleared_with_history(officer, f"DR-V-{officer.role}")
            r = self._get(officer, f"/api/claims/{claim.id}")
            self.assertEqual(r.status_code, 200, r.content)
            body = r.json()
            self.assertEqual(body["faculty_stage"], "Under review", officer.role)
            self.assertIsNone(body["cleared_by_name"], officer.role)
            self.assertNotIn(self.cell.name, r.content.decode(), officer.role)
            steps = {s["action"]: s for s in body["actions"]}
            self.assertEqual(steps["IN_REVIEW"]["actor_name"], "The college", officer.role)
            self.assertIsNone(steps["IN_REVIEW"]["note"], officer.role)
            # Their own step keeps their own name.
            self.assertEqual(steps["SUBMIT"]["actor_name"], officer.name, officer.role)

    def test_on_everybody_else_s_papers_the_officer_sees_what_they_always_did(self):
        claim = self._cleared_with_history(self.faculty, "DR-V-FAC")
        body = self._get(self.principal, f"/api/claims/{claim.id}").json()
        self.assertEqual(body["cleared_by_name"], self.cell.name)
        self.assertNotIn("faculty_stage", body)
        self.assertIn("CLEAR", [s["action"] for s in body["actions"]])

    def test_their_own_money_stays_on_their_own_paper(self):
        claim = self._own(self.director, ClaimStatus.PAID, ticket="DR-V-MONEY")
        body = self._get(self.director, f"/api/claims/{claim.id}").json()
        self.assertEqual(body["remuneration"], claim.remuneration)
        self.assertEqual(body["faculty_stage"], "Paid")

    def test_no_flag_on_their_own_paper_reaches_them(self):
        own = self._own(self.principal, ClaimStatus.CLEARED, ticket="DR-V-FLAG")
        other = self._claim(ticket="DR-V-OTHER")
        for claim in (own, other):
            ClaimFlag.objects.create(
                claim=claim, kind=ClaimFlag.Kind.OTHER, note="Looks like a different paper",
                raised_by=self.cell,
            )
        body = self._get(self.principal, f"/api/claims/{own.id}").json()
        for key in ("flags", "open_flags", "file_checks"):
            self.assertNotIn(key, body, key)
        listed = self._get(self.principal, "/api/flags").json()
        self.assertEqual([f["claim_id"] for f in listed["results"]], [other.id])
        self.assertEqual(listed["summary"]["open"], 1)
        self.assertRefusedAsOwn(self._get(self.principal, f"/api/claims/{own.id}/review"), "review")
        archive = self._get(self.principal, "/api/archive/claims").json()
        self.assertNotIn(own.id, [c["id"] for c in archive["results"]])

    def test_the_desk_s_notes_on_their_own_paper_are_not_theirs_to_read(self):
        own = self._own(self.principal, ClaimStatus.SUBMITTED, ticket="DR-V-NOTE")
        ClaimNote.objects.create(claim=own, author=self.cell, body="Ask about the affiliation")
        self.assertRefusedAsOwn(self._get(self.principal, f"/api/claims/{own.id}/notes"), "notes")
        self.assertRefusedAsOwn(
            self._post(self.principal, f"/api/claims/{own.id}/notes", {"body": "Please hurry"}),
            "add a note",
        )

    def test_the_audit_log_leaves_out_their_own_paper(self):
        from core.services import flags as flag_service

        own = self._own(self.principal, ClaimStatus.CLEARED, ticket="DR-V-AUD")
        other = self._claim(ticket="DR-V-AUD2")
        own_flags, other_flags = [], []
        for claim, flags in ((own, own_flags), (other, other_flags)):
            AuditLog.objects.create(
                actor=self.cell, action="CLEAR", entity="Claim", entity_id=claim.id,
                detail_json=json.dumps({"ticket": claim.ticket_number}),
            )
            # A flag's audit row is filed under the flag, not the claim.
            flag, _ = flag_service.raise_flag(
                claim, kind=ClaimFlag.Kind.OTHER, note="Affiliation reads wrong", actor=self.cell,
            )
            flags.append(flag.id)
        rows = self._get(self.principal, "/api/admin/audit").json()["results"]
        ids = {r["entity_id"] for r in rows}
        self.assertIn(other.id, ids)
        self.assertIn(other_flags[0], ids)
        self.assertNotIn(own.id, ids)
        self.assertNotIn(own_flags[0], ids)

    def test_a_director_reads_the_note_they_filed_their_own_paper_with(self):
        note = "Filed with the publisher's own figures, please check"
        own = self._own(
            self.director, ClaimStatus.SUBMITTED, ticket="DR-V-CN",
            contest_forward=True, contest_note=note,
        )
        other = self._claim(ticket="DR-V-CN2", contest_forward=True, contest_note=note)
        mine = self._get(self.director, f"/api/claims/{own.id}").json()
        self.assertEqual(mine["contest_note"], note)
        # Anybody else's contest is still not the Director's to see.
        theirs = self._get(self.director, f"/api/claims/{other.id}").json()
        self.assertNotIn("contest_note", theirs)
        self.assertNotIn("contest_forward", theirs)

    def test_a_flag_on_a_paid_paper_is_not_announced_to_its_owner(self):
        from core.services import flags as flag_service

        # An account that owned papers before it was made a super admin.
        own = self._own(self.admin, ClaimStatus.PAID, ticket="DR-V-ANN")
        deputy = User.objects.create_user(
            email="dr-deputy-admin@test.edu", password=None, name="Deputy Admin", role=Role.SUPER_ADMIN,
        )
        Notification.objects.all().delete()
        flag_service.raise_flag(own, kind=ClaimFlag.Kind.OTHER, note="Paid twice?", actor=self.cell)
        told = set(Notification.objects.filter(claim_id=own.id).values_list("user_id", flat=True))
        self.assertEqual(told, {deputy.id})


# --------------------------------------------------------------------------- #
# 3. Nobody decides their own paper, at any desk                               #
# --------------------------------------------------------------------------- #


class TheClearingDeskTests(DualRoleBase):
    """The research cell's own paper, at the desk the research cell sits at."""

    def setUp(self):
        super().setUp()
        self.paper = self._own(self.cell, ClaimStatus.SUBMITTED, ticket="DR-CL")

    def test_the_owner_cannot_clear_it_alone_or_in_a_batch(self):
        self.assertRefusedAsOwn(
            self._post(self.cell, f"/api/claims/{self.paper.id}/clear",
                       {"expected_amount": self.paper.remuneration}),
            "clear",
        )
        r = self._post(self.cell, "/api/admin/bulk-clear", {"claim_ids": [self.paper.id]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["cleared"], 0)
        self.assertIn(OWN, r.json()["skipped"][0]["reason"].lower())
        self.assertUnmoved(self.paper, ClaimStatus.SUBMITTED)

    def test_the_owner_cannot_send_it_back_hold_it_or_rework_its_figures(self):
        paths = {
            "reject": {"note": REASON},
            "return-to-faculty": {"note": REASON},
            "reject-outright": {"note": REASON},
            "hold": {"reason": REASON},
            "recalculate": {},
            "verify": {},
        }
        for verb, body in paths.items():
            self.assertRefusedAsOwn(
                self._post(self.cell, f"/api/claims/{self.paper.id}/{verb}", body), verb
            )
        self.assertRefusedAsOwn(
            self._post(self.cell, f"/api/admin/claims/{self.paper.id}/set-verified",
                       {"snip": 3.5, "quartile": "Q1", "note": "From the journal's own page"}),
            "set-verified",
        )
        self.assertRefusedAsOwn(
            self._post(self.cell, f"/api/admin/claims/{self.paper.id}/override-status",
                       {"to_status": ClaimStatus.CLEARED, "note": "Clearing my own, surely fine"}),
            "override-status",
        )
        self.paper.refresh_from_db()
        self.assertEqual(self.paper.status, ClaimStatus.SUBMITTED)
        self.assertFalse(self.paper.on_hold)
        self.assertEqual(self.paper.snip, 1.0)

    def test_it_is_not_in_the_owner_s_queue_and_is_in_everybody_else_s(self):
        other = self._claim(ticket="DR-CL-FAC")
        own_queue = [c["id"] for c in self._get(self.cell, "/api/admin/clearing-queue").json()]
        self.assertEqual(own_queue, [other.id])
        for desk in (self.coordinator, self.admin):
            queue = [c["id"] for c in self._get(desk, "/api/admin/clearing-queue").json()]
            self.assertIn(self.paper.id, queue, desk.role)

    def test_another_officer_at_the_desk_clears_it(self):
        r = self._post(self.coordinator, f"/api/claims/{self.paper.id}/clear",
                       {"expected_amount": self.paper.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertUnmoved(self.paper, ClaimStatus.CLEARED)

    def test_the_owner_is_not_told_their_own_paper_is_waiting_at_their_desk(self):
        Notification.objects.all().delete()
        r = self._post(self.cell, "/api/claims", _fileable("The cell's second paper", "7"))
        self.assertEqual(r.status_code, 200, r.content)
        told = set(Notification.objects.filter(title__startswith="To clear").values_list("user_id", flat=True))
        self.assertNotIn(self.cell.id, told)
        self.assertIn(self.coordinator.id, told)
        self.assertIn(self.admin.id, told)


class ThePrincipalsDeskTests(DualRoleBase):
    """The Principal's own paper, cleared and waiting at the Principal's desk."""

    def setUp(self):
        super().setUp()
        self.paper = self._own(self.principal, ClaimStatus.CLEARED, ticket="DR-PR")

    def test_the_principal_cannot_approve_their_own_alone_or_in_a_batch(self):
        self.assertRefusedAsOwn(
            self._post(self.principal, f"/api/claims/{self.paper.id}/principal-approve",
                       {"expected_amount": self.paper.remuneration}),
            "principal-approve",
        )
        r = self._post(self.principal, "/api/principal/bulk-approve", {"claim_ids": [self.paper.id]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["approved"], 0)
        self.assertIn(OWN, r.json()["skipped"][0]["reason"].lower())
        self.assertUnmoved(self.paper, ClaimStatus.CLEARED)

    def test_the_principal_cannot_send_it_back_or_hold_it(self):
        for verb, body in {
            "principal-reject": {"note": REASON},
            "return-one-step": {"note": REASON},
            "reject": {"note": REASON},
            "reject-outright": {"note": REASON},
            "hold": {"reason": REASON},
        }.items():
            self.assertRefusedAsOwn(
                self._post(self.principal, f"/api/claims/{self.paper.id}/{verb}", body), verb
            )
        self.assertUnmoved(self.paper, ClaimStatus.CLEARED)

    def test_it_is_not_in_the_principal_s_queue(self):
        other = self._claim(ClaimStatus.CLEARED, ticket="DR-PR-FAC")
        body = self._get(self.principal, "/api/principal/queue").json()
        self.assertEqual([c["id"] for c in body["results"]], [other.id])
        self.assertEqual(body["totals"]["count"], 1)
        admin_queue = self._get(self.admin, "/api/principal/queue").json()
        self.assertIn(self.paper.id, [c["id"] for c in admin_queue["results"]])

    def test_the_desk_s_counts_leave_it_out_and_my_papers_count_it(self):
        # The sidebar badge and the office home count the desk from
        # `/claims/counts`. Counting the Principal's own paper there would say
        # "1 waiting" over an empty queue -- and tell a claimant which desk
        # holds their paper, which no claimant is told.
        self._claim(ClaimStatus.CLEARED, ticket="DR-PR-CNT")
        desk = self._get(self.principal, "/api/claims/counts").json()["counts"]
        self.assertEqual(desk["checked"], 1)
        mine = self._get(self.principal, "/api/claims/counts?mine=1").json()["counts"]
        self.assertEqual(mine["checked"], 1)
        self.assertEqual(mine["all"], 1)
        # Another holder of the desk counts it as theirs to decide.
        self.assertEqual(self._get(self.admin, "/api/claims/counts").json()["counts"]["checked"], 2)

    def test_with_no_other_principal_the_super_admin_decides_it_and_is_told(self):
        Notification.objects.all().delete()
        fresh = self._own(self.principal, ClaimStatus.SUBMITTED, ticket="DR-PR-2")
        r = self._post(self.coordinator, f"/api/claims/{fresh.id}/clear",
                       {"expected_amount": fresh.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        told = set(
            Notification.objects.filter(claim_id=fresh.id, title__startswith="Cleared")
            .values_list("user_id", flat=True)
        )
        self.assertEqual(told, {self.admin.id})
        fresh.refresh_from_db()
        r = self._post(self.admin, f"/api/claims/{fresh.id}/principal-approve",
                       {"expected_amount": fresh.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertUnmoved(fresh, ClaimStatus.PRINCIPAL_APPROVED)

    def test_a_second_principal_is_the_one_told_and_the_one_who_decides(self):
        deputy = User.objects.create_user(
            email="dr-deputy@test.edu", password=None, name="Deputy Principal", role=Role.PRINCIPAL,
        )
        Notification.objects.all().delete()
        fresh = self._own(self.principal, ClaimStatus.SUBMITTED, ticket="DR-PR-3")
        self._post(self.coordinator, f"/api/claims/{fresh.id}/clear",
                   {"expected_amount": fresh.remuneration})
        told = set(
            Notification.objects.filter(claim_id=fresh.id, title__startswith="Cleared")
            .values_list("user_id", flat=True)
        )
        self.assertEqual(told, {deputy.id})
        self.assertIn(fresh.id, [c["id"] for c in self._get(deputy, "/api/principal/queue").json()["results"]])
        fresh.refresh_from_db()
        r = self._post(deputy, f"/api/claims/{fresh.id}/principal-approve",
                       {"expected_amount": fresh.remuneration})
        self.assertEqual(r.status_code, 200, r.content)


class TheDirectorsDeskTests(DualRoleBase):
    def setUp(self):
        super().setUp()
        self.paper = self._own(self.director, ClaimStatus.PRINCIPAL_APPROVED, ticket="DR-DI")

    def test_the_director_cannot_authorise_their_own_alone_or_in_a_batch(self):
        self.assertRefusedAsOwn(
            self._post(self.director, f"/api/claims/{self.paper.id}/director-approve",
                       {"expected_amount": self.paper.remuneration}),
            "director-approve",
        )
        r = self._post(self.director, "/api/director/bulk-approve", {"claim_ids": [self.paper.id]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["approved"], 0)
        self.assertIn(OWN, r.json()["skipped"][0]["reason"].lower())
        self.assertUnmoved(self.paper, ClaimStatus.PRINCIPAL_APPROVED)

    def test_it_is_not_in_the_director_s_queue_and_the_super_admin_authorises_it(self):
        other = self._claim(
            ClaimStatus.PRINCIPAL_APPROVED, ticket="DR-DI-FAC",
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
        )
        body = self._get(self.director, "/api/director/queue").json()
        self.assertEqual([c["id"] for c in body["results"]], [other.id])
        r = self._post(self.admin, f"/api/claims/{self.paper.id}/director-approve",
                       {"expected_amount": self.paper.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertUnmoved(self.paper, ClaimStatus.DIRECTOR_APPROVED)

    def test_the_director_hears_as_a_claimant_and_finance_as_the_desk(self):
        Notification.objects.all().delete()
        r = self._post(self.admin, f"/api/claims/{self.paper.id}/director-approve",
                       {"expected_amount": self.paper.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        desk = set(
            Notification.objects.filter(claim_id=self.paper.id, title__startswith="Authorised for payment")
            .values_list("user_id", flat=True)
        )
        self.assertEqual(desk, {self.finance.id})
        # The owner is told what any claimant is told, in the claimant's words.
        mine = Notification.objects.get(claim_id=self.paper.id, user=self.director)
        self.assertIn("Approved for payment", mine.title)


class TheFinanceDeskTests(DualRoleBase):
    def setUp(self):
        super().setUp()
        self.paper = self._own(self.finance, ClaimStatus.DIRECTOR_APPROVED, ticket="DR-FI")

    def test_finance_cannot_pay_their_own_alone_or_in_a_batch(self):
        self.assertRefusedAsOwn(
            self._post(self.finance, f"/api/claims/{self.paper.id}/mark-paid",
                       {"expected_amount": self.paper.remuneration}),
            "mark-paid",
        )
        r = self._post(
            self.finance, "/api/admin/bulk-mark-paid",
            {"items": [{"claim_id": self.paper.id, "expected_amount": self.paper.remuneration}]},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["paid"], 0)
        self.assertIn(OWN, r.json()["skipped"][0]["reason"].lower())
        self.assertUnmoved(self.paper, ClaimStatus.DIRECTOR_APPROVED)
        self.assertFalse(PaidLedger.objects.filter(claim=self.paper).exists())

    def test_it_is_not_in_the_payable_queue_and_the_super_admin_pays_it(self):
        other = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket="DR-FI-FAC",
            director_approved_by=self.director, director_approved_at=timezone.now(),
            second_approved_by=self.principal, second_approved_at=timezone.now(),
        )
        body = self._get(self.finance, "/api/admin/payouts?status=DIRECTOR_APPROVED").json()
        self.assertEqual([c["id"] for c in body["results"]], [other.id])
        admin_view = self._get(self.admin, "/api/admin/payouts?status=DIRECTOR_APPROVED").json()
        self.assertIn(self.paper.id, [c["id"] for c in admin_view["results"]])
        r = self._post(self.admin, f"/api/claims/{self.paper.id}/mark-paid",
                       {"expected_amount": self.paper.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertUnmoved(self.paper, ClaimStatus.PAID)

    def test_with_no_other_finance_officer_the_super_admin_is_told(self):
        fresh = self._own(self.finance, ClaimStatus.PRINCIPAL_APPROVED, ticket="DR-FI-2")
        Notification.objects.all().delete()
        r = self._post(self.director, f"/api/claims/{fresh.id}/director-approve",
                       {"expected_amount": fresh.remuneration})
        self.assertEqual(r.status_code, 200, r.content)
        desk = set(
            Notification.objects.filter(claim_id=fresh.id, title__startswith="Authorised for payment")
            .values_list("user_id", flat=True)
        )
        self.assertEqual(desk, {self.admin.id})


class SecondSignaturesAndRescuesTests(DualRoleBase):
    def test_nobody_second_signs_their_own_paper(self):
        from core.api import _high_value_threshold

        paper = self._own(self.coordinator, ClaimStatus.CLEARED, ticket="DR-2S", cleared_by=self.cell)
        Claim.objects.filter(pk=paper.pk).update(remuneration=_high_value_threshold() + 1)
        self.assertRefusedAsOwn(
            self._post(self.coordinator, f"/api/claims/{paper.id}/second-approve", {}),
            "second-approve",
        )
        paper.refresh_from_db()
        self.assertIsNone(paper.second_approved_by_id)

    def test_the_super_admin_decides_anybody_s_paper_but_their_own(self):
        # An account that owned papers before it was made a super admin.
        paper = self._own(self.admin, ClaimStatus.PAID, ticket="DR-SA")
        for verb, body in {
            "void-payment": {"note": "Paid against the wrong voucher"},
        }.items():
            self.assertRefusedAsOwn(
                self._post(self.admin, f"/api/claims/{paper.id}/{verb}", body), verb
            )
        self.assertRefusedAsOwn(
            self._post(self.admin, f"/api/admin/claims/{paper.id}/edit",
                       {"fields": {"remuneration": 1}, "reason": "Correcting my own amount"}),
            "edit",
        )
        self.assertRefusedAsOwn(
            self._post(self.admin, f"/api/admin/claims/{paper.id}/reassign",
                       {"owner_email": self.faculty.email, "reason": "Moving my paper to Asha"}),
            "reassign",
        )
        self.assertUnmoved(paper, ClaimStatus.PAID)
        # And a colleague's paper is still theirs to rescue.
        other = self._own(self.principal, ClaimStatus.PAID, ticket="DR-SA-2")
        r = self._post(self.admin, f"/api/claims/{other.id}/void-payment",
                       {"note": "Paid against the wrong voucher"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_super_admin_stands_in_at_no_desk_on_their_own_paper(self):
        # The super admin stands in at every desk -- but a paper of their own
        # (one they owned before the role was theirs) is decided by the desk
        # itself, never by the account that can reach every desk.
        cases = [
            (ClaimStatus.SUBMITTED, "clear", {}),
            (ClaimStatus.SUBMITTED, "reject", {"note": REASON}),
            (ClaimStatus.SUBMITTED, "hold", {"reason": REASON}),
            (ClaimStatus.CLEARED, "principal-approve", {}),
            (ClaimStatus.CLEARED, "principal-reject", {"note": REASON}),
            (ClaimStatus.PRINCIPAL_APPROVED, "director-approve", {}),
            (ClaimStatus.PRINCIPAL_APPROVED, "director-reject", {"note": REASON}),
            (ClaimStatus.DIRECTOR_APPROVED, "mark-paid", {}),
        ]
        for n, (status, verb, body) in enumerate(cases):
            paper = self._own(self.admin, status, ticket=f"DR-SA-{n}")
            payload = {"expected_amount": paper.remuneration, **body}
            self.assertRefusedAsOwn(
                self._post(self.admin, f"/api/claims/{paper.id}/{verb}", payload), verb
            )
            self.assertUnmoved(paper, status)
        self.assertRefusedAsOwn(
            self._post(
                self.admin, f"/api/admin/claims/{paper.id}/override-status",
                {"to_status": ClaimStatus.CLEARED, "note": "Pushing my own paper through"},
            ),
            "override-status",
        )

    def test_nobody_flags_their_own_paper_or_answers_a_flag_on_it(self):
        paper = self._own(self.cell, ClaimStatus.SUBMITTED, ticket="DR-FL")
        flag = ClaimFlag.objects.create(
            claim=paper, kind=ClaimFlag.Kind.OTHER, note="Affiliation reads wrong", raised_by=self.coordinator,
        )
        self.assertRefusedAsOwn(
            self._post(self.cell, f"/api/claims/{paper.id}/flags",
                       {"kind": ClaimFlag.Kind.OTHER, "note": "Nothing to see on this one"}),
            "raise",
        )
        self.assertRefusedAsOwn(
            self._post(self.cell, f"/api/flags/{flag.id}/resolve", {"note": "It is fine, trust me"}),
            "resolve",
        )
        self.assertRefusedAsOwn(self._post(self.cell, f"/api/claims/{paper.id}/check-files"), "check-files")
        flag.refresh_from_db()
        self.assertTrue(flag.is_open)
