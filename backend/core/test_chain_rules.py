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


# --------------------------------------------------------------------------- #
# 4. A contested payment-history match is not shown to the Director or Finance #
# --------------------------------------------------------------------------- #


def _keys_anywhere(value, found=None):
    found = set() if found is None else found
    if isinstance(value, dict):
        for k, v in value.items():
            found.add(k)
            _keys_anywhere(v, found)
    elif isinstance(value, list):
        for v in value:
            _keys_anywhere(v, found)
    return found


class ContestedFlagVisibilityTests(ChainBase):
    CONTEST = "CONTESTSENTINEL the earlier payment was for a different paper"
    OVERRIDE = "OVERRIDESENTINEL checked with the publisher"
    MATCH = "DUPSENTINEL An Earlier Paper With A Similar Title"
    #: Every one of these names a contested or duplicate flag, and none may
    #: reach the Director or Finance under any spelling.
    FLAG_KEYS = {
        "contest_forward", "contest_note", "verification_ok",
        "verification_snapshot_json", "duplicate_warning", "duplicate_matches",
        "duplicate_matches_json", "override_duplicate", "override_reason",
        "override_by_name", "override_at",
    }
    SENTINELS = ("CONTESTSENTINEL", "OVERRIDESENTINEL", "DUPSENTINEL",
                 "Payment history may already", "CONTEST_FORWARD", "DUPLICATE_REVIEW")

    def setUp(self):
        super().setUp()
        from core.models import DuplicateFinding

        flags = dict(
            contest_forward=True,
            contest_note=self.CONTEST,
            verification_ok=False,
            verification_snapshot_json=json.dumps(
                {"issues": ["Payment history may already include this paper"]}
            ),
            duplicate_warning=True,
            duplicate_matches_json=json.dumps([{"title": self.MATCH, "amount": 40000}]),
            override_duplicate=True,
            override_reason=self.OVERRIDE,
            override_by=self.faculty,
            override_at=timezone.now(),
            publication_year=2026,
            cleared_by=self.cell,
            cleared_at=timezone.now(),
        )
        self.approved = self._claim(
            ClaimStatus.PRINCIPAL_APPROVED, ticket="CT-1",
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            **flags,
        )
        self.authorised = self._claim(
            ClaimStatus.DIRECTOR_APPROVED, ticket="CT-2",
            principal_approved_by=self.principal, principal_approved_at=timezone.now(),
            director_approved_by=self.director, director_approved_at=timezone.now(),
            **flags,
        )
        self.contested = [self.approved, self.authorised]
        for claim in self.contested:
            ClaimAction.objects.create(
                claim=claim, actor=self.faculty, from_status=ClaimStatus.DRAFT,
                to_status=ClaimStatus.SUBMITTED, action="CONTEST_FORWARD", note=self.CONTEST,
            )
            ClaimAction.objects.create(
                claim=claim, actor=self.faculty, from_status=ClaimStatus.REJECTED,
                to_status=ClaimStatus.SUBMITTED, action="RESUBMIT", note=self.CONTEST,
            )
        self.finding = DuplicateFinding.objects.create(
            kind=DuplicateFinding.Kind.SAME_PERSON, matched_on="title",
            paper_title=self.MATCH, faculty_name=self.faculty.name,
            payment_count=2, total_amount=80000, extra_amount=40000, rows_json="[]",
        )
        AuditLog.objects.create(
            actor=self.admin, action="DUPLICATE_REVIEW", entity="DuplicateFinding",
            entity_id=self.finding.id, detail_json=json.dumps({"status": "DISMISSED"}),
        )

    def _paths_for(self, user):
        paths = [f"/api/claims/{c.id}" for c in self.contested] + [
            "/api/claims?limit=200",
            "/api/dashboard",
            "/api/reports",
            "/api/reports/search?limit=50",
            "/api/reports/pack/rows?limit=200",
            "/api/reports/pack?fmt=json",
            "/api/reports/export",
            "/api/reports/search/export",
            "/api/lookup/ticket?q=CT-",
            f"/api/faculty/{self.faculty.id}/report",
            "/api/admin/audit?limit=500",
            "/api/admin/payouts?status=DIRECTOR_APPROVED",
            "/api/admin/payouts?status=PRINCIPAL_APPROVED",
        ]
        if user.role == Role.DIRECTOR:
            paths.append("/api/director/queue")
        return paths

    def test_no_contested_flag_reaches_the_director_or_finance(self):
        for who in (self.director, self.finance):
            client = self._as(who)
            answered = 0
            for path in self._paths_for(who):
                r = client.get(path)
                if r.status_code == 403:
                    continue
                self.assertEqual(r.status_code, 200, f"{who.role} {path}: {r.content[:300]}")
                answered += 1
                raw = r.content.decode("utf-8", errors="ignore")
                for sentinel in self.SENTINELS:
                    self.assertNotIn(sentinel, raw, f"{who.role} {path} carries {sentinel!r}")
                if r["Content-Type"].startswith("application/json"):
                    leaked = _keys_anywhere(r.json()) & self.FLAG_KEYS
                    self.assertEqual(leaked, set(), f"{who.role} {path}")
            # Not vacuous: most of these doors are open to both roles.
            self.assertGreaterEqual(answered, 12, who.role)

    def test_the_claim_itself_still_reaches_them(self):
        """Stripping flags, not claims: the Director still sees what to authorise."""
        body = self._as(self.director).get("/api/director/queue").json()
        self.assertEqual([r["ticket_number"] for r in body["results"]], ["CT-1"])
        detail = self._as(self.finance).get(f"/api/claims/{self.authorised.id}").json()
        self.assertEqual(detail["ticket_number"], "CT-2")
        self.assertEqual(detail["remuneration"], self.authorised.remuneration)
        self.assertEqual(
            [a["action"] for a in detail["actions"]], ["SUBMIT", "RESUBMIT"],
            "the history is still there, told without the contest",
        )

    def test_everyone_else_in_the_chain_still_sees_the_flag(self):
        for who in (self.faculty, self.cell, self.coordinator, self.principal, self.admin):
            detail = self._as(who).get(f"/api/claims/{self.approved.id}").json()
            self.assertTrue(detail["contest_forward"], who.role)
            self.assertEqual(detail["contest_note"], self.CONTEST, who.role)
            self.assertTrue(detail["override_duplicate"], who.role)

    def test_the_duplicate_findings_screens_are_refused_to_them(self):
        for who in (self.director, self.finance):
            r = self._as(who).get("/api/admin/duplicate-findings")
            self.assertEqual(r.status_code, 403, who.role)
            r = self._post(
                who, f"/api/admin/duplicate-findings/{self.finding.id}",
                {"status": "CONFIRMED", "note": "Paid twice in error"},
            )
            self.assertEqual(r.status_code, 403, who.role)
        for who in (self.principal, self.admin, self.cell):
            r = self._as(who).get("/api/admin/duplicate-findings")
            self.assertEqual(r.status_code, 200, who.role)

    def test_a_refused_payment_does_not_tell_finance_why_it_was_contested(self):
        """An overridden duplicate needs a second signature at any amount. When
        Finance is stopped for want of one, the refusal says so -- and not that
        the reason is a set-aside payment-history warning."""
        # No second signature from anybody but the person who cleared it.
        self.authorised.second_approved_by = self.cell
        self.authorised.save()
        r = self._post(
            self.finance, f"/api/claims/{self.authorised.id}/mark-paid",
            {"expected_amount": self.authorised.remuneration},
        )
        self.assertEqual(r.status_code, 400, r.content)
        detail = r.json()["detail"].lower()
        self.assertIn("second approver", detail)
        self.assertNotIn("payment-history", detail)
        self.assertNotIn(self.faculty.name.lower(), detail)


# --------------------------------------------------------------------------- #
# 5. A faculty member never learns which desk, or which person, has the paper #
# 6. Everyone else keeps the full timeline                                    #
# --------------------------------------------------------------------------- #


class FacultyViewTests(ChainBase):
    STAFF_NAMES = (
        "Ravi Cellperson", "Meera Coordinator", "Suresh Superadmin",
        "Lakshmi Principal", "Vikram Director", "Kavya Financeperson",
    )
    #: Words that name a desk. None may appear in anything composed for the
    #: claimant -- a notification, or a timeline note written by the system.
    DESK_WORDS = ("principal", "director", "finance", "research", "cell",
                  "supervisor", "office", "admin", "hod", "coordinator")

    def _walk_the_whole_chain(self):
        """A paper filed by the claimant and taken all the way to paid through
        the real endpoints, with a hold and a one-step return on the way."""
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="FV-1")
        ClaimAction.objects.create(
            claim=claim, actor=self.faculty, from_status=ClaimStatus.DRAFT,
            to_status=ClaimStatus.SUBMITTED, action="SUBMIT", note="Filed by me",
        )
        amount = {"expected_amount": claim.remuneration}
        steps = [
            (self.cell, "hold", {"reason": "Checking the co-author list with the dean"}),
            (self.cell, "resume", {}),
            (self.cell, "clear", {**amount, "note": "Ravi checked the SNIP"}),
            (self.principal, "return-one-step", {"note": "Lakshmi wants the DOI checked"}),
            (self.coordinator, "clear", {**amount, "note": "DOI fine"}),
            (self.principal, "principal-approve", {**amount, "note": "Approved by the Principal"}),
            (self.director, "director-approve", {**amount, "note": "Authorised by the Director"}),
            (self.finance, "mark-paid", {**amount, "note": "Paid by Finance"}),
        ]
        for who, verb, body in steps:
            r = self._post(who, f"/api/claims/{claim.id}/{verb}", body)
            self.assertEqual(r.status_code, 200, f"{who.role} {verb}: {r.content}")
        return claim

    # ---- the stage --------------------------------------------------------

    def test_every_status_has_a_faculty_stage(self):
        expected = {
            "FS-DRAFT": (dict(status=ClaimStatus.DRAFT, ticket_number=None), "Draft"),
            "FS-WD": (dict(status=ClaimStatus.DRAFT), "Withdrawn"),
            "FS-SUB": (dict(status=ClaimStatus.SUBMITTED), "Under review"),
            "FS-HELD": (dict(status=ClaimStatus.SUBMITTED, on_hold=True,
                             hold_reason="Waiting on the publisher", held_by=self.cell,
                             held_at=timezone.now()), "Under review"),
            "FS-CLR": (dict(status=ClaimStatus.CLEARED), "Under review"),
            "FS-PA": (dict(status=ClaimStatus.PRINCIPAL_APPROVED), "Under review"),
            "FS-DA": (dict(status=ClaimStatus.DIRECTOR_APPROVED), "Approved for payment"),
            "FS-PAID": (dict(status=ClaimStatus.PAID), "Paid"),
            "FS-BACK": (dict(status=ClaimStatus.REJECTED), "Sent back to you"),
            "FS-OUT": (dict(status=ClaimStatus.REJECTED, rejected_outright=True), "Not accepted"),
        }
        for key, (fields, _) in expected.items():
            fields = dict(fields)
            status = fields.pop("status")
            fields.setdefault("ticket_number", key)
            self._claim(status, paper_title=f"Stage {key}", **fields)

        rows = self._as(self.faculty).get("/api/claims?limit=200").json()["results"]
        got = {r["paper_title"].removeprefix("Stage "): r["faculty_stage"] for r in rows}
        self.assertEqual(got, {k: stage for k, (_, stage) in expected.items()})

    def test_days_waiting_counts_from_filing_not_from_the_last_desk(self):
        """Counting from the last status change would reset the clock each
        time the paper changed desks -- which is telling the claimant it had."""
        filed = timezone.now() - timedelta(days=9)
        claim = self._claim(
            ClaimStatus.CLEARED, ticket="FV-W", submitted_at=filed,
            cleared_by=self.cell, cleared_at=timezone.now() - timedelta(days=1),
        )
        body = self._as(self.faculty).get(f"/api/claims/{claim.id}").json()
        self.assertEqual(body["days_waiting"], 9)

        for status in (ClaimStatus.DRAFT, ClaimStatus.PAID, ClaimStatus.REJECTED):
            other = self._claim(status, ticket=f"FV-{status}", submitted_at=filed)
            body = self._as(self.faculty).get(f"/api/claims/{other.id}").json()
            self.assertIsNone(body["days_waiting"], status)

    # ---- the timeline and the people --------------------------------------

    def test_the_timeline_names_nobody_but_the_claimant(self):
        claim = self._walk_the_whole_chain()
        r = self._as(self.faculty).get(f"/api/claims/{claim.id}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        raw = r.content.decode()
        for name in self.STAFF_NAMES:
            self.assertNotIn(name, raw, f"{name} reached the claimant")

        own = [a for a in body["actions"] if a["actor_name"] == self.faculty.name]
        theirs = [a for a in body["actions"] if a["actor_name"] != self.faculty.name]
        self.assertEqual([a["action"] for a in own], ["SUBMIT"])
        self.assertEqual(own[0]["note"], "Filed by me", "their own words stay theirs")
        self.assertGreaterEqual(len(theirs), 8)
        for step in theirs:
            self.assertEqual(step["actor_name"], "The college")
            self.assertIsNone(step["actor_id"])
            self.assertIsNone(step["note"], step)
            for word in self.DESK_WORDS:
                self.assertNotIn(word, step["action"].lower(), step)
        self.assertEqual(theirs[-1]["action"], "PAID")

    def test_no_person_or_private_note_on_the_claimant_s_copy(self):
        claim = self._claim(
            ClaimStatus.CLEARED, ticket="FV-N",
            cleared_by=self.cell, cleared_at=timezone.now(),
            second_approved_by=self.coordinator, second_approved_at=timezone.now(),
            manual_verified_by=self.admin, manual_verified_at=timezone.now(),
            on_hold=True, hold_reason="The Principal is away until Monday",
            held_by=self.principal, held_at=timezone.now(),
            status_note="Internal: Lakshmi asked for this",
        )
        body = self._as(self.faculty).get(f"/api/claims/{claim.id}").json()
        for key in ("cleared_by_name", "second_approved_by_name", "manual_verified_by_name",
                    "principal_approved_by_name", "director_approved_by_name",
                    "held_by_name", "hold_reason", "status_note"):
            self.assertIsNone(body[key], key)
        self.assertTrue(body["on_hold"], "that it is paused is theirs to know")
        self.assertEqual(body["faculty_stage"], "Under review")

    def test_the_reason_it_was_sent_back_is_theirs_to_read(self):
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="FV-R")
        self._post(self.cell, f"/api/claims/{claim.id}/return-to-faculty",
                   {"note": "Attach the published version, not the preprint"})
        body = self._as(self.faculty).get(f"/api/claims/{claim.id}").json()
        self.assertEqual(body["faculty_stage"], "Sent back to you")
        self.assertEqual(body["status_note"], "Attach the published version, not the preprint")
        sent_back = [a for a in body["actions"] if a["action"] == "SENT_BACK"]
        self.assertEqual(sent_back[0]["note"], "Attach the published version, not the preprint")

    # ---- what they are told ---------------------------------------------

    def test_nothing_the_claimant_is_sent_names_a_desk_or_a_person(self):
        Notification.objects.all().delete()
        self._walk_the_whole_chain()
        back = self._claim(ClaimStatus.CLEARED, ticket="FV-B")
        self._post(self.principal, f"/api/claims/{back.id}/return-to-faculty",
                   {"note": "Attach the published version"})
        out = self._claim(ClaimStatus.SUBMITTED, ticket="FV-O")
        self._post(self.cell, f"/api/claims/{out.id}/reject-outright",
                   {"note": "The venue is not an indexed journal"})

        told = list(Notification.objects.filter(user=self.faculty).values_list("title", "body"))
        self.assertTrue(told)
        for title, body in told:
            text = f"{title} {body}"
            for word in self.DESK_WORDS:
                self.assertNotIn(word, text.lower(), text)
            for name in self.STAFF_NAMES:
                self.assertNotIn(name.split()[0], text, text)

        titles = " | ".join(t for t, _ in told)
        for expected in ("On hold", "Review resumed", "Approved for payment", "Paid",
                         "Sent back to you", "Not accepted"):
            self.assertIn(expected, titles)

    def test_moves_between_desks_are_not_announced_to_the_claimant(self):
        """Every step between filing and approval for payment is "Under review"
        to them. A message at each one would let them count the desks."""
        claim = self._claim(ClaimStatus.SUBMITTED, ticket="FV-Q")
        Notification.objects.all().delete()
        amount = {"expected_amount": claim.remuneration}
        self._post(self.cell, f"/api/claims/{claim.id}/clear", amount)
        self._post(self.principal, f"/api/claims/{claim.id}/return-one-step",
                   {"note": "Check the DOI again"})
        self._post(self.cell, f"/api/claims/{claim.id}/clear", amount)
        self._post(self.principal, f"/api/claims/{claim.id}/principal-approve", amount)
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PRINCIPAL_APPROVED)
        self.assertFalse(Notification.objects.filter(user=self.faculty).exists())

    # ---- 6. staff keep the full timeline ----------------------------------

    def test_the_super_admin_the_office_and_the_principal_see_every_name(self):
        claim = self._walk_the_whole_chain()
        for who in (self.admin, self.cell, self.coordinator, self.principal):
            body = self._as(who).get(f"/api/claims/{claim.id}").json()
            names = [a["actor_name"] for a in body["actions"]]
            for expected in ("Asha Faculty", "Ravi Cellperson", "Meera Coordinator",
                             "Lakshmi Principal", "Vikram Director", "Kavya Financeperson"):
                self.assertIn(expected, names, who.role)
            self.assertNotIn("The college", names, who.role)
            codes = [a["action"] for a in body["actions"]]
            self.assertIn("PRINCIPAL_APPROVE", codes, who.role)
            self.assertIn("PRINCIPAL_SEND_BACK", codes, who.role)
            self.assertEqual(body["principal_approved_by_name"], "Lakshmi Principal", who.role)
            self.assertNotIn("faculty_stage", body, "the staff payload is unchanged")


# --------------------------------------------------------------------------- #
# 7. seed --demo: a demo college with a paper at every stage                  #
# --------------------------------------------------------------------------- #


class DemoSeedTests(TestCase):
    LIVE_STATUSES = {
        ClaimStatus.DRAFT, ClaimStatus.SUBMITTED, ClaimStatus.CLEARED,
        ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED,
        ClaimStatus.PAID, ClaimStatus.REJECTED,
    }

    def _seed(self):
        from django.core.management import call_command

        call_command("seed", "--demo", force=True, verbosity=0)

    def _counts(self):
        from core.models import PaidLedger, ScimagoJournal, SnipSource

        return {
            "users": User.objects.count(),
            "claims": Claim.objects.count(),
            "actions": ClaimAction.objects.count(),
            "attachments": ClaimAttachment.objects.count(),
            "ledger": PaidLedger.objects.count(),
            "scimago": ScimagoJournal.objects.count(),
            "snip": SnipSource.objects.count(),
        }

    def test_it_runs_twice_and_the_second_run_adds_nothing(self):
        self._seed()
        first = self._counts()
        self._seed()
        self.assertEqual(self._counts(), first)
        self.assertGreaterEqual(first["claims"], 13)

    def test_there_is_a_paper_at_every_stage(self):
        self._seed()
        claims = Claim.objects.all()
        self.assertEqual(set(claims.values_list("status", flat=True)), self.LIVE_STATUSES)
        self.assertTrue(claims.filter(status=ClaimStatus.SUBMITTED, on_hold=True).exists())
        back = claims.get(status=ClaimStatus.REJECTED, rejected_outright=False)
        self.assertTrue(back.status_note, "sent back with a reason")
        self.assertTrue(back.ticket_number, "and it keeps its ticket number")
        self.assertTrue(claims.filter(status=ClaimStatus.REJECTED, rejected_outright=True).exists())
        contested = claims.get(contest_forward=True)
        self.assertTrue(contested.duplicate_warning)
        self.assertTrue(contested.override_duplicate)
        self.assertTrue(json.loads(contested.duplicate_matches_json))
        self.assertTrue(
            claims.filter(status=ClaimStatus.DRAFT, ticket_number__isnull=False).exists(),
            "a withdrawn paper",
        )

    def test_the_amounts_are_the_formula_s_own(self):
        self._seed()
        for claim in Claim.objects.all():
            stored = claim.remuneration
            _apply_calc(claim)
            self.assertAlmostEqual(stored, claim.remuneration, 2, claim.ticket_number)
            self.assertGreater(stored or 0, 0, f"{claim.ticket_number}: {claim.remuneration_note}")
        for claim in Claim.objects.filter(status=ClaimStatus.PAID):
            ledger = sum(r.amount for r in claim.ledger_rows.all())
            self.assertAlmostEqual(ledger, claim.remuneration, 2)
            self.assertIsNotNone(claim.payout_month)
            self.assertIsNotNone(claim.paid_at)

    def test_each_paper_carries_the_history_of_every_step(self):
        from core.models import ScimagoJournal

        self._seed()
        director = User.objects.get(email="director@college.edu")
        finance = User.objects.get(email="finance@college.edu")
        for claim in Claim.objects.all():
            steps = list(claim.actions.order_by("created_at").values_list("action", "to_status"))
            self.assertTrue(steps, claim.ticket_number)
            self.assertEqual(steps[-1][1], claim.status, f"{claim.ticket_number}: {steps}")
            self.assertTrue(
                ScimagoJournal.objects.filter(issn=claim.issn).exists(),
                f"{claim.ticket_number} uses a journal the tables hold",
            )
        for claim in Claim.objects.filter(status=ClaimStatus.PAID):
            last = claim.actions.order_by("-created_at").first()
            self.assertEqual((last.action, last.actor), ("MARK_PAID", finance))
            self.assertTrue(claim.actions.filter(action="DIRECTOR_APPROVE", actor=director).exists())
            self.assertEqual(claim.director_approved_by, director)

    def test_every_role_has_an_account_and_existing_passwords_are_kept(self):
        from django.core.management import call_command

        call_command("seed", force=True, verbosity=0)
        faculty = User.objects.get(email="faculty@college.edu")
        faculty.set_password("set-after-deploy")
        faculty.save()

        self._seed()
        faculty.refresh_from_db()
        self.assertTrue(faculty.check_password("set-after-deploy"))
        for email, password, role in (
            ("hod@college.edu", "hod123", Role.HOD),
            ("director@college.edu", "director123", Role.DIRECTOR),
            ("research@college.edu", "research123", Role.RESEARCH_CELL),
            ("principal@college.edu", "principal123", Role.PRINCIPAL),
            ("finance@college.edu", "finance123", Role.FINANCE),
        ):
            user = User.objects.get(email=email)
            self.assertEqual(user.role, role, email)
            self.assertTrue(user.check_password(password), email)
        self.assertEqual(User.objects.get(email="hod@college.edu").department, "CSE")

        demo_faculty = User.objects.filter(role=Role.FACULTY).exclude(email="faculty@college.edu")
        self.assertEqual(demo_faculty.count(), 6)
        self.assertEqual(
            set(demo_faculty.values_list("department", flat=True)), {"CSE", "ECE", "MECH"}
        )
        staff_ids = list(demo_faculty.values_list("staff_id", flat=True))
        self.assertTrue(all(staff_ids))
        self.assertEqual(len(set(staff_ids)), 6)

    def test_demo_is_refused_outside_debug_without_force(self):
        from django.core.management import call_command
        from django.core.management.base import CommandError

        with self.assertRaisesRegex(CommandError, "Refusing to seed"):
            call_command("seed", "--demo", verbosity=0)
        self.assertFalse(Claim.objects.exists())
