"""The approval chain as the college owner decided it.

Faculty file -> research supervisor desk clears -> Principal approves ->
Director authorises -> Finance pays. HOD is not an approver.

Each class here pins one of the owner's rules:

- a paper can be put on hold at the research supervisor's desk or the
  Principal's without losing its place in the chain;
- the two review desks can return a paper (one step, or to the faculty) or
  reject it outright;
- the Director and Finance only move a paper forward;
- a contested payment-history match is not shown to the Director or Finance;
- a faculty member never learns which desk, or which person, holds their paper;
- `seed --demo` builds a demo college with a paper at every stage;
- the filing wizard's DOI lookup falls back to Crossref when Scopus cannot answer.
"""
from __future__ import annotations

import json
from datetime import timedelta

from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from core.api import _apply_calc
from core.models import (
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAction,
    ClaimAttachment,
    ClaimStatus,
    FormulaConfig,
    Notification,
    Role,
    User,
)
from core.services.remuneration import DEFAULT_AUTHOR_POINTS
from core.tests import _echo_verified, patch_api


class ChainBase(TestCase):
    """Every role the chain involves, and a paper that prices deterministically."""

    @classmethod
    def setUpTestData(cls):
        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True
        )

        def person(email, name, role, **extra):
            # No password: force_login does not need one, and hashing eight
            # of them per test is most of the suite's time.
            return User.objects.create_user(
                email=email, password=None, name=name, role=role, **extra
            )

        cls.faculty = person(
            "chain-fac@test.edu", "Asha Faculty", Role.FACULTY,
            department="CSE", staff_id="STF-CH1",
        )
        cls.cell = person("chain-cell@test.edu", "Ravi Cellperson", Role.RESEARCH_CELL)
        cls.coordinator = person(
            "chain-coord@test.edu", "Meera Coordinator", Role.RESEARCH_COORDINATOR
        )
        cls.admin = person("chain-admin@test.edu", "Suresh Superadmin", Role.SUPER_ADMIN)
        cls.principal = person("chain-prin@test.edu", "Lakshmi Principal", Role.PRINCIPAL)
        cls.director = person("chain-dir@test.edu", "Vikram Director", Role.DIRECTOR)
        cls.finance = person("chain-fin@test.edu", "Kavya Financeperson", Role.FINANCE)
        cls.hod = person("chain-hod@test.edu", "Hari Hod", Role.HOD, department="CSE")

    def setUp(self):
        cache.clear()
        self.client = Client()
        verify = patch_api("verify_publication", side_effect=_echo_verified)
        verify.start()
        self.addCleanup(verify.stop)

    # ---- fixtures ---------------------------------------------------------

    def _claim(self, status=ClaimStatus.SUBMITTED, ticket="CH-1", **extra):
        fields = dict(
            owner=self.faculty,
            paper_title=f"Chain Rules Paper {ticket}",
            journal_title="Nature",
            quartile="Q2",
            quartile_source="SCIMAGO",
            snip=1.0,
            snip_source="SCOPUS",
            scimago_verified=True,
            status=status,
            ticket_number=ticket,
            publication_type="Journal",
            indexing_level="Scopus",
            engineering_class="Engineering",
            total_authors=1,
            author_position=1,
            verification_ok=True,
            submitted_at=timezone.now(),
        )
        fields.update(extra)
        claim = Claim.objects.create(**fields)
        for n in ("14", "15"):
            ClaimAttachment.objects.create(
                claim=claim, kind=AttachmentKind.SEC_REFERENCE,
                url=f"/media/claims/{'c' * 31}{n[-1]}.pdf", ref_number=n,
            )
        _apply_calc(claim)
        claim.save()
        return claim

    def _as(self, user):
        self.client.force_login(user)
        return self.client

    def _post(self, user, path, body=None):
        return self._as(user).post(
            path, data=json.dumps(body or {}), content_type="application/json"
        )


# --------------------------------------------------------------------------- #
# 1. On hold                                                                  #
# --------------------------------------------------------------------------- #


class HoldTests(ChainBase):
    REASON = "Waiting on the publisher's erratum"

    def _hold(self, user, claim, reason=REASON):
        return self._post(user, f"/api/claims/{claim.id}/hold", {"reason": reason})

    def _resume(self, user, claim):
        return self._post(user, f"/api/claims/{claim.id}/resume")

    def test_the_office_holds_a_submitted_paper_without_moving_it(self):
        claim = self._claim()
        r = self._hold(self.cell, claim)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["on_hold"])
        self.assertEqual(body["hold_reason"], self.REASON)

        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED, "a hold is not a status")
        self.assertTrue(claim.on_hold)
        self.assertEqual(claim.hold_reason, self.REASON)
        self.assertEqual(claim.held_by, self.cell)
        self.assertIsNotNone(claim.held_at)

        action = ClaimAction.objects.get(claim=claim, action="HOLD")
        self.assertEqual(action.from_status, ClaimStatus.SUBMITTED)
        self.assertEqual(action.to_status, ClaimStatus.SUBMITTED)
        self.assertEqual(action.note, self.REASON)
        self.assertTrue(
            AuditLog.objects.filter(action="CLAIM_HOLD", entity_id=claim.id).exists()
        )

    def test_a_held_paper_keeps_its_place_in_every_status_filter(self):
        claim = self._claim()
        self._hold(self.coordinator, claim)
        rows = self._as(self.admin).get("/api/claims?status=SUBMITTED").json()["results"]
        self.assertEqual([r["id"] for r in rows], [claim.id])
        self.assertTrue(rows[0]["on_hold"])

    def test_a_hold_needs_a_reason_of_ten_characters(self):
        claim = self._claim()
        r = self._hold(self.cell, claim, reason="too short")
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertFalse(claim.on_hold)

    def test_the_principal_holds_a_cleared_paper(self):
        claim = self._claim(ClaimStatus.CLEARED, cleared_by=self.cell, cleared_at=timezone.now())
        r = self._hold(self.principal, claim)
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertTrue(claim.on_hold)
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

        principal_queue = self._as(self.principal).get("/api/principal/queue").json()
        self.assertEqual(len(principal_queue["results"]), 1)
        self.assertTrue(principal_queue["results"][0]["on_hold"])

    def test_each_desk_holds_only_what_is_at_that_desk(self):
        submitted = self._claim(ticket="CH-S")
        cleared = self._claim(ClaimStatus.CLEARED, ticket="CH-C")
        self.assertEqual(self._hold(self.principal, submitted).status_code, 403)
        self.assertEqual(self._hold(self.cell, cleared).status_code, 403)
        self.assertEqual(self._hold(self.coordinator, cleared).status_code, 403)

    def test_a_super_admin_holds_at_either_desk(self):
        submitted = self._claim(ticket="CH-S")
        cleared = self._claim(ClaimStatus.CLEARED, ticket="CH-C")
        self.assertEqual(self._hold(self.admin, submitted).status_code, 200)
        self.assertEqual(self._hold(self.admin, cleared).status_code, 200)

    def test_nobody_outside_the_two_desks_can_hold(self):
        submitted = self._claim(ticket="CH-S")
        cleared = self._claim(ClaimStatus.CLEARED, ticket="CH-C")
        for who in (self.faculty, self.hod, self.director, self.finance):
            for claim in (submitted, cleared):
                r = self._hold(who, claim)
                self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")

    def test_nothing_past_the_principal_s_desk_can_be_held(self):
        for status in (
            ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED,
            ClaimStatus.PAID, ClaimStatus.REJECTED, ClaimStatus.DRAFT,
        ):
            claim = self._claim(status, ticket=f"CH-{status}")
            r = self._hold(self.admin, claim)
            self.assertEqual(r.status_code, 400, f"{status}: {r.content}")

    def test_holding_twice_and_resuming_what_is_not_held_are_refused(self):
        claim = self._claim()
        self.assertEqual(self._resume(self.cell, claim).status_code, 409)
        self.assertEqual(self._hold(self.cell, claim).status_code, 200)
        self.assertEqual(self._hold(self.cell, claim).status_code, 409)

    def test_a_held_paper_cannot_be_cleared(self):
        claim = self._claim()
        self._hold(self.cell, claim)
        r = self._post(
            self.coordinator, f"/api/claims/{claim.id}/clear",
            {"expected_amount": claim.remuneration},
        )
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("hold", r.json()["detail"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    def test_a_batch_clear_skips_a_held_paper_and_says_why(self):
        held = self._claim(ticket="CH-H")
        free = self._claim(ticket="CH-F")
        self._hold(self.cell, held)
        r = self._post(self.coordinator, "/api/admin/bulk-clear", {"claim_ids": [held.id, free.id]})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["cleared"], 1)
        self.assertEqual([s["id"] for s in body["skipped"]], [held.id])
        self.assertIn("hold", body["skipped"][0]["reason"].lower())
        held.refresh_from_db()
        self.assertEqual(held.status, ClaimStatus.SUBMITTED)

    def test_a_held_paper_cannot_be_approved_by_the_principal(self):
        claim = self._claim(ClaimStatus.CLEARED, cleared_by=self.cell, cleared_at=timezone.now())
        self._hold(self.principal, claim)
        r = self._post(
            self.principal, f"/api/claims/{claim.id}/principal-approve",
            {"expected_amount": claim.remuneration},
        )
        self.assertEqual(r.status_code, 409, r.content)
        self.assertIn("hold", r.json()["detail"].lower())

        r = self._post(self.principal, "/api/principal/bulk-approve", {"claim_ids": [claim.id]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["approved"], 0)
        self.assertIn("hold", r.json()["skipped"][0]["reason"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

    def test_resuming_lets_the_paper_move_again(self):
        claim = self._claim()
        self._hold(self.cell, claim)
        r = self._resume(self.coordinator, claim)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["on_hold"])
        claim.refresh_from_db()
        self.assertFalse(claim.on_hold)
        self.assertIsNone(claim.hold_reason)
        self.assertIsNone(claim.held_by_id)
        self.assertIsNone(claim.held_at)
        self.assertTrue(ClaimAction.objects.filter(claim=claim, action="RESUME").exists())
        self.assertTrue(
            AuditLog.objects.filter(action="CLAIM_RESUME", entity_id=claim.id).exists()
        )

        r = self._post(
            self.coordinator, f"/api/claims/{claim.id}/clear",
            {"expected_amount": claim.remuneration},
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_resuming_belongs_to_the_desk_the_paper_is_at(self):
        claim = self._claim(ClaimStatus.CLEARED)
        self._hold(self.principal, claim)
        self.assertEqual(self._resume(self.cell, claim).status_code, 403)
        self.assertEqual(self._resume(self.director, claim).status_code, 403)
        self.assertEqual(self._resume(self.admin, claim).status_code, 200)

    def test_the_claimant_is_told_without_naming_the_desk_or_the_person(self):
        claim = self._claim(ClaimStatus.CLEARED)
        Notification.objects.all().delete()
        self._hold(self.principal, claim)
        self._resume(self.principal, claim)
        told = list(
            Notification.objects.filter(user=self.faculty).values_list("title", "body")
        )
        self.assertEqual(len(told), 2, told)
        for title, body in told:
            text = f"{title} {body}".lower()
            for word in ("principal", "lakshmi", "director", "finance", "research", "cell"):
                self.assertNotIn(word, text, f"{word!r} in {text!r}")
            self.assertNotIn(self.REASON.lower(), text)


# --------------------------------------------------------------------------- #
# 2. Return one step, return to faculty, reject outright                      #
# --------------------------------------------------------------------------- #


class ReturnAndRejectTests(ChainBase):
    REASON = "The DOI resolves to a different paper"

    def _cleared(self, ticket="CH-C"):
        return self._claim(
            ClaimStatus.CLEARED, ticket=ticket,
            cleared_by=self.cell, cleared_at=timezone.now(),
        )

    def _send(self, user, claim, verb, note=REASON):
        return self._post(user, f"/api/claims/{claim.id}/{verb}", {"note": note})

    # ---- the research supervisor's desk ----------------------------------

    def test_the_supervisor_desk_returns_a_paper_to_the_faculty(self):
        claim = self._claim()
        r = self._send(self.cell, claim, "return-to-faculty")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["rejected_outright"])
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.REJECTED)
        self.assertEqual(claim.ticket_number, "CH-1", "the ticket number is kept")
        self.assertFalse(claim.rejected_outright)
        self.assertEqual(claim.status_note, self.REASON)

        # Returned means the claimant can fix it and file it again.
        r = self._as(self.faculty).patch(
            f"/api/claims/{claim.id}",
            data=json.dumps({"paper_title": "Chain Rules Paper, corrected"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_older_reject_path_still_returns_to_the_faculty(self):
        claim = self._claim()
        r = self._send(self.coordinator, claim, "reject")
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.REJECTED)
        self.assertFalse(claim.rejected_outright)

    def test_the_supervisor_desk_rejects_a_paper_outright(self):
        claim = self._claim()
        r = self._send(self.cell, claim, "reject-outright")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["rejected_outright"])
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.REJECTED)
        self.assertTrue(claim.rejected_outright)
        action = ClaimAction.objects.get(claim=claim, action="REJECT_OUTRIGHT")
        self.assertEqual(action.note, self.REASON)

        # Not accepted is final: there is nothing to fix and file again.
        r = self._as(self.faculty).patch(
            f"/api/claims/{claim.id}",
            data=json.dumps({"paper_title": "Trying again"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_rejecting_outright_needs_a_reason(self):
        claim = self._claim()
        r = self._send(self.cell, claim, "reject-outright", note="no")
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)

    # ---- the Principal's desk ------------------------------------------

    def test_the_principal_returns_a_paper_one_step_to_the_supervisor(self):
        for verb, ticket in (("return-one-step", "CH-A"), ("principal-reject", "CH-B")):
            claim = self._cleared(ticket)
            r = self._send(self.principal, claim, verb)
            self.assertEqual(r.status_code, 200, f"{verb}: {r.content}")
            claim.refresh_from_db()
            self.assertEqual(claim.status, ClaimStatus.SUBMITTED, verb)
            # The clearing is withdrawn with the status, as the Director's
            # send-back withdraws the Principal's approval.
            self.assertIsNone(claim.cleared_by_id, verb)
            self.assertIsNone(claim.cleared_at, verb)

    def test_a_one_step_return_needs_a_note(self):
        claim = self._cleared()
        r = self._send(self.principal, claim, "return-one-step", note="no")
        self.assertEqual(r.status_code, 400, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

    def test_the_principal_returns_to_the_faculty_or_rejects_outright(self):
        back = self._cleared("CH-BACK")
        r = self._send(self.principal, back, "return-to-faculty")
        self.assertEqual(r.status_code, 200, r.content)
        back.refresh_from_db()
        self.assertEqual(back.status, ClaimStatus.REJECTED)
        self.assertFalse(back.rejected_outright)
        self.assertIsNone(back.cleared_by_id)

        out = self._cleared("CH-OUT")
        r = self._send(self.principal, out, "reject-outright")
        self.assertEqual(r.status_code, 200, r.content)
        out.refresh_from_db()
        self.assertEqual(out.status, ClaimStatus.REJECTED)
        self.assertTrue(out.rejected_outright)

    def test_each_desk_returns_only_what_is_at_it(self):
        submitted = self._claim(ticket="CH-S")
        cleared = self._cleared("CH-C")
        for verb in ("return-to-faculty", "reject", "reject-outright"):
            self.assertEqual(self._send(self.principal, submitted, verb).status_code, 403, verb)
            self.assertEqual(self._send(self.cell, cleared, verb).status_code, 403, verb)
            self.assertEqual(self._send(self.coordinator, cleared, verb).status_code, 403, verb)
        self.assertEqual(self._send(self.cell, cleared, "return-one-step").status_code, 403)
        submitted.refresh_from_db()
        cleared.refresh_from_db()
        self.assertEqual(submitted.status, ClaimStatus.SUBMITTED)
        self.assertEqual(cleared.status, ClaimStatus.CLEARED)

    def test_a_super_admin_does_all_of_it_at_either_desk(self):
        cases = [
            ("return-to-faculty", self._claim(ticket="SA-1"), ClaimStatus.REJECTED),
            ("reject-outright", self._claim(ticket="SA-2"), ClaimStatus.REJECTED),
            ("return-to-faculty", self._cleared("SA-3"), ClaimStatus.REJECTED),
            ("reject-outright", self._cleared("SA-4"), ClaimStatus.REJECTED),
            ("return-one-step", self._cleared("SA-5"), ClaimStatus.SUBMITTED),
        ]
        for verb, claim, expected in cases:
            r = self._send(self.admin, claim, verb)
            self.assertEqual(r.status_code, 200, f"{verb} {claim.ticket_number}: {r.content}")
            claim.refresh_from_db()
            self.assertEqual(claim.status, expected, f"{verb} {claim.ticket_number}")

    def test_the_director_and_finance_never_send_a_paper_back(self):
        claims = [
            self._claim(ClaimStatus.SUBMITTED, ticket="DF-1"),
            self._cleared("DF-2"),
            self._claim(ClaimStatus.PRINCIPAL_APPROVED, ticket="DF-3"),
            self._claim(ClaimStatus.DIRECTOR_APPROVED, ticket="DF-4"),
        ]
        for who in (self.director, self.finance):
            for claim in claims:
                for verb in ("reject", "return-to-faculty", "reject-outright", "return-one-step"):
                    r = self._send(who, claim, verb)
                    self.assertEqual(
                        r.status_code, 403, f"{who.role} {verb} {claim.status}: {r.content}"
                    )
        for claim in claims:
            before = claim.status
            claim.refresh_from_db()
            self.assertEqual(claim.status, before)

    def test_past_the_principal_only_a_super_admin_can_send_a_paper_back(self):
        claim = self._claim(ClaimStatus.PRINCIPAL_APPROVED, ticket="PA-1")
        for who in (self.cell, self.coordinator, self.principal):
            self.assertEqual(self._send(who, claim, "reject").status_code, 403, who.role)
        self.assertEqual(self._send(self.admin, claim, "reject").status_code, 200)

    def test_sending_a_held_paper_back_lifts_the_hold(self):
        claim = self._cleared()
        self._post(self.principal, f"/api/claims/{claim.id}/hold",
                   {"reason": "Checking the co-author list"})
        r = self._send(self.principal, claim, "return-one-step")
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertFalse(claim.on_hold)
        self.assertIsNone(claim.hold_reason)

    def test_a_rescued_paper_is_no_longer_marked_not_accepted(self):
        claim = self._claim()
        self._send(self.cell, claim, "reject-outright")
        r = self._post(
            self.admin, f"/api/admin/claims/{claim.id}/override-status",
            {"to_status": "SUBMITTED", "note": "Rejected against the wrong paper"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.SUBMITTED)
        self.assertFalse(claim.rejected_outright)


# --------------------------------------------------------------------------- #
# 3. The Director and Finance only move a paper forward                       #
# --------------------------------------------------------------------------- #


class ForwardOnlyTests(ChainBase):
    def _approved(self, ticket="FW-1"):
        return self._claim(
            ClaimStatus.PRINCIPAL_APPROVED, ticket=ticket,
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
        )

    def _authorised(self, ticket="FW-A"):
        return self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket=ticket,
            cleared_by=self.cell, cleared_at=timezone.now(),
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            second_approved_by=self.principal, second_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
        )

    def _paid(self, ticket="FW-P"):
        from datetime import date

        from core.models import PaidLedger

        claim = self._authorised(ticket)
        claim.status = ClaimStatus.PAID
        claim.paid_at = timezone.now()
        claim.save()
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 9, 1), amount=claim.remuneration,
            faculty_name=self.faculty.name, voucher_number="V-FW",
        )
        return claim

    def test_the_director_cannot_send_a_paper_back(self):
        claim = self._approved()
        r = self._post(
            self.director, f"/api/claims/{claim.id}/director-reject",
            {"note": "Past the quarter's allocation"},
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("authorise", r.json()["detail"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)
        self.assertEqual(claim.principal_approved_by, self.principal)

    def test_a_super_admin_can_still_send_one_back_from_there(self):
        claim = self._approved()
        r = self._post(
            self.admin, f"/api/claims/{claim.id}/director-reject",
            {"note": "Approved against the wrong budget head"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)
        self.assertIsNone(claim.principal_approved_by_id)

    def test_the_director_still_authorises_one_and_many(self):
        one = self._approved("FW-1")
        many = self._approved("FW-2")
        r = self._post(
            self.director, f"/api/claims/{one.id}/director-approve",
            {"expected_amount": one.remuneration},
        )
        self.assertEqual(r.status_code, 200, r.content)
        r = self._post(self.director, "/api/director/bulk-approve", {"claim_ids": [many.id]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["approved"], 1)

    def test_finance_still_pays(self):
        claim = self._authorised()
        r = self._post(
            self.finance, f"/api/claims/{claim.id}/mark-paid",
            {"expected_amount": claim.remuneration},
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)

    def test_finance_cannot_void_a_payment(self):
        claim = self._paid()
        r = self._post(
            self.finance, f"/api/claims/{claim.id}/void-payment",
            {"note": "Paid against the wrong voucher"},
        )
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn("super admin", r.json()["detail"].lower())
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)
        self.assertEqual(claim.ledger_rows.count(), 1)

    def test_only_a_super_admin_voids_a_payment(self):
        claim = self._paid()
        for who in (self.director, self.principal, self.cell, self.coordinator):
            r = self._post(
                who, f"/api/claims/{claim.id}/void-payment",
                {"note": "Paid against the wrong voucher"},
            )
            self.assertEqual(r.status_code, 403, f"{who.role}: {r.content}")
        r = self._post(
            self.admin, f"/api/claims/{claim.id}/void-payment",
            {"note": "Paid against the wrong voucher"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.CLEARED)

