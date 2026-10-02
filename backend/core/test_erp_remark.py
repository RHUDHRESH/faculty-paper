"""Old-ERP claims wrongly imported as paid, put back into the normal run.

The importer marked every row of the workbook's Accounts sheet PAID, including
rows Accounts had never priced or paid (Amount 0, author points not worked
out). `core.services.erp_remark` finds them from the database alone, holds back
the ones the research cell must look at first (a possible repeat payment, a
row the sheet itself says was rejected) and moves the rest to Cleared, where
the amount is worked out, approved, authorised and then paid like any other.

Every claim and person here is synthetic.
"""
from __future__ import annotations

import json
from datetime import date, datetime
from datetime import timezone as dt_tz

from core.api import _apply_calc
from core.api.common import IMPERSONATOR_KEY
from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, PaidLedger, PriorPayment, Role, User
from core.services import erp_remark, payment_guards
from core.test_chain_rules import ChainBase

PREVIEW = "/api/admin/erp-remark/preview"
APPLY = "/api/admin/erp-remark/apply"
UNDO = "/api/admin/erp-remark/undo"
BATCHES = "/api/admin/erp-remark/batches"
IMPORTED_AT = datetime(2026, 6, 14, 10, 30, tzinfo=dt_tz.utc)
IMPORT_MONTH = date(2026, 6, 1)


class RemarkBase(ChainBase):
    def erp(self, ticket, *, note="Accounts", amount=0.0, ledger=0.0, **extra):
        """A claim as the importer left it: PAID, stamped paid on the day of the
        import, no amount, and (usually) one ledger row for the sheet's ₹0."""
        claim = self._claim(ClaimStatus.PAID, ticket=ticket, **extra)
        Claim.objects.filter(pk=claim.pk).update(
            remuneration=amount, status_note=note, paid_at=IMPORTED_AT, payout_month=IMPORT_MONTH,
        )
        if ledger is not None:
            PaidLedger.objects.create(
                claim=claim, payout_month=IMPORT_MONTH, amount=ledger, paper_title=claim.paper_title,
                raw_json=json.dumps({"Status": note, "Amount": ledger}),
            )
        claim.refresh_from_db()
        return claim

    def preview(self, who=None):
        r = self._as(who or self.admin).get(PREVIEW)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def apply(self, body=None, who=None):
        if body is None:
            body = {"signature": self.preview()["signature"], "confirm": True}
        return self._post(who or self.admin, APPLY, body)

    def fresh(self, claim):
        return Claim.objects.get(pk=claim.pk)

    def nos(self, rows):
        return [r["claim_no"] for r in rows]


class WhatThePreviewLists(RemarkBase):
    def setUp(self):
        super().setUp()
        self.one = self.erp("ERP-PROCESSED-1")
        self.two = self.erp("ERP-RAW-2", amount=None, ledger=None)
        self.rejected = self.erp("ERP-PROCESSED-3", note="Rejected")
        self.repeat = self.erp("ERP-PROCESSED-4", doi="10.5555/remark.repeat")
        PriorPayment.objects.create(
            employee_id=self.faculty.staff_id, doi="10.5555/remark.repeat", amount_paid=12000.0,
            paper_title="Earlier payment", raw_json="{}", claim_ref="1888",
        )
        # Not wrongly paid, or not ours to touch:
        self.erp("ERP-PROCESSED-5", ledger=5000.0)                  # money on the ledger
        self.erp("ERP-PROCESSED-6", note="Student Publication. No Remuneration. Only for count")
        self.erp("ERP-PROCESSED-7", amount=15000.0, ledger=15000.0)  # priced and paid
        self.erp("FP-2026-000001")                                  # filed here, not imported
        self.erp("ERP-000001")                                      # a ledger-born claim, not a sheet row
        self._claim(ClaimStatus.SUBMITTED, ticket="ERP-RAW-8")
        paid_here = self.erp("ERP-PROCESSED-9")
        ClaimAction.objects.create(claim=paid_here, actor=self.finance, from_status=ClaimStatus.DIRECTOR_APPROVED,
                                   to_status=ClaimStatus.PAID, action="MARK_PAID")

    def test_lists_exactly_the_wrongly_paid_old_erp_claims(self):
        body = self.preview()
        self.assertEqual(self.nos(body["will_change"]), ["ERP-PROCESSED-1", "ERP-RAW-2"])
        self.assertEqual(
            {r["claim_no"]: r["reason"] for r in body["held"]},
            {"ERP-PROCESSED-3": "rejected on the accounts sheet", "ERP-PROCESSED-4": "possible repeat"},
        )
        self.assertEqual(
            body["counts"],
            {"will_change": 2, "held_repeat": 1, "held_rejected": 1, "already_done": 0},
        )
        self.assertEqual(body["signature"], erp_remark.signature([self.one.id, self.two.id]))
        self.assertTrue(body["after_status_label"])

    def test_each_row_says_who_what_and_why(self):
        row = self.preview()["will_change"][0]
        self.assertEqual(row["claim_id"], self.one.id)
        self.assertEqual(row["title"], self.one.paper_title)
        self.assertEqual(row["status_before"], ClaimStatus.PAID)
        self.assertEqual(row["status_after"], ClaimStatus.CLEARED)
        self.assertTrue(row["reason"])
        who = row["claimant"]
        self.assertEqual((who["id"], who["name"], who["staff_id"]), (self.faculty.id, "Asha Faculty", "STF-CH1"))
        self.assertIn("photo_url", who)
        held = self.preview()["held"][0]
        self.assertEqual(set(held), {"claim_id", "claim_no", "claimant", "title", "reason"})

    def test_a_co_authors_payment_is_not_a_repeat(self):
        PriorPayment.objects.create(
            employee_id="STF-SOMEONE-ELSE", doi="10.5555/remark.coauthor", amount_paid=9000.0,
            paper_title="Co-author's share", raw_json="{}", claim_ref="2001",
        )
        self.erp("ERP-PROCESSED-10", doi="10.5555/remark.coauthor")
        self.assertIn("ERP-PROCESSED-10", self.nos(self.preview()["will_change"]))

    def test_the_preview_writes_nothing(self):
        audit, actions, ledger = AuditLog.objects.count(), ClaimAction.objects.count(), PaidLedger.objects.count()
        self.preview()
        self.assertEqual(self.fresh(self.one).status, ClaimStatus.PAID)
        self.assertEqual((AuditLog.objects.count(), ClaimAction.objects.count(), PaidLedger.objects.count()),
                         (audit, actions, ledger))


class TheRepeatRuleIsThePayGuards(RemarkBase):
    """The preview works out "paid before" for every claim at once, for speed.
    It must give exactly the answer `payment_guards.earlier_payment` gives one
    claim at a time, which is what refuses the payment later."""

    def prior(self, staff, *, doi=None, title_key=None, ref="1"):
        PriorPayment.objects.create(employee_id=staff, doi=doi, normalized_title=title_key, amount_paid=5000.0,
                                    paper_title="Earlier", raw_json="{}", claim_ref=ref)

    def paid_here(self, ticket, **extra):
        return self._claim(ClaimStatus.PAID, ticket=ticket, owner=self.faculty, **extra)

    def test_the_bulk_answer_agrees_with_the_pay_guard_claim_by_claim(self):
        from core.services.normalize import normalize_title

        long_title = "A sufficiently long title about remark matching"
        cases = {
            "doi-in-workbook": self.erp("ERP-PROCESSED-21", doi="10.7/a", owner=self.faculty),
            "title-in-workbook": self.erp("ERP-PROCESSED-22", paper_title=long_title + " one"),
            "short-title": self.erp("ERP-PROCESSED-23", paper_title="Intro"),
            "own-workbook-row": self.erp("ERP-PROCESSED-24", doi="10.7/b", owner=self.faculty),
            "co-author-paid": self.erp("ERP-PROCESSED-25", doi="10.7/c", owner=self.faculty),
            "paid-here-doi": self.erp("ERP-PROCESSED-26", doi="10.7/d", owner=self.faculty),
            "paid-here-eid": self.erp("ERP-PROCESSED-27", eid="2-s2.0-777", owner=self.faculty),
            "two-dois-same-title": self.erp("ERP-PROCESSED-28", doi="10.7/e", paper_title=long_title + " two",
                                            owner=self.faculty),
            "doi-and-title-no-doi": self.erp("ERP-PROCESSED-29", doi="10.7/f", paper_title=long_title + " three",
                                             owner=self.faculty),
            "title-only-paid-here": self.erp("ERP-PROCESSED-34", paper_title=long_title + " four"),
            "twin-a": self.erp("ERP-PROCESSED-30", doi="10.7/g", owner=self.faculty),
            "twin-b": self.erp("ERP-PROCESSED-31", doi="10.7/g", owner=self.faculty),
            "nothing": self.erp("ERP-PROCESSED-32", doi="10.7/h", owner=self.faculty),
        }
        nobody = User.objects.create_user(email="no-staff@test.edu", password=None, name="No Staff",
                                          role=Role.FACULTY)
        cases["owner-without-staff-id"] = self.erp("ERP-PROCESSED-33", doi="10.7/i", owner=nobody)
        staff = self.faculty.staff_id
        self.prior(staff.lower(), doi="10.7/A")                            # case differs on both sides
        self.prior(staff, title_key=normalize_title(long_title + " one"))
        self.prior(staff, title_key=normalize_title("Intro"))
        self.prior(staff, doi="10.7/b", ref="ERP-PROCESSED-24")            # the claim's own sheet row
        self.prior("STF-SOMEONE-ELSE", doi="10.7/c")
        self.prior("", doi="10.7/i")
        self.paid_here("FP-2026-000101", doi="10.7/D")
        self.paid_here("FP-2026-000102", eid="2-s2.0-777")
        self.paid_here("FP-2026-000103", doi="10.7/zz", normalized_title=normalize_title(long_title + " two"))
        self.paid_here("FP-2026-000104", normalized_title=normalize_title(long_title + " three"))
        self.paid_here("FP-2026-000105", doi="10.7/x", normalized_title=normalize_title(long_title + " four"))

        claims = list(Claim.objects.filter(pk__in=[c.pk for c in cases.values()]).select_related("owner"))
        bulk = erp_remark.paid_before(claims)
        one_by_one = {c.pk for c in claims if payment_guards.earlier_payment(c) is not None}
        named = {c.pk: name for name, c in cases.items()}
        self.assertEqual(sorted(named[i] for i in bulk), sorted(named[i] for i in one_by_one))
        self.assertEqual(
            sorted(named[i] for i in bulk),
            ["doi-and-title-no-doi", "doi-in-workbook", "paid-here-doi", "paid-here-eid", "title-in-workbook",
             "title-only-paid-here", "twin-a", "twin-b"],
        )


class Applying(RemarkBase):
    def setUp(self):
        super().setUp()
        self.one = self.erp("ERP-PROCESSED-1")
        self.two = self.erp("ERP-RAW-2", amount=None, ledger=None)
        self.rejected = self.erp("ERP-PROCESSED-3", note="Rejected")
        self.untouched = self.erp("ERP-PROCESSED-5", ledger=5000.0)

    def test_apply_moves_only_the_listed_claims_to_cleared_with_nothing_paid_on_them(self):
        r = self.apply()
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["changed"], body["skipped"]), (2, 0))
        self.assertTrue(body["batch_id"])
        for claim in (self.one, self.two):
            c = self.fresh(claim)
            self.assertEqual(c.status, ClaimStatus.CLEARED)
            self.assertIsNone(c.paid_at)
            self.assertIsNone(c.payout_month)
            self.assertIsNone(c.remuneration)
            self.assertIsNone(c.principal_approved_at)
            self.assertIsNone(c.director_approved_at)
            self.assertEqual(c.status_note, "Accounts", "the sheet's own status is kept")
        for claim in (self.rejected, self.untouched):
            self.assertEqual(self.fresh(claim).status, ClaimStatus.PAID)

    def test_apply_writes_the_audit_trail(self):
        batch = self.apply().json()["batch_id"]
        row = AuditLog.objects.get(action=erp_remark.ACTION, entity=erp_remark.ENTITY, entity_id=batch)
        self.assertEqual(row.actor, self.admin)
        detail = json.loads(row.detail_json)
        snap = {s["claim_id"]: s for s in detail["claims"]}
        self.assertEqual(set(snap), {self.one.id, self.two.id})
        self.assertEqual(snap[self.one.id]["before"]["status"], ClaimStatus.PAID)
        self.assertEqual(snap[self.one.id]["before"]["payout_month"], "2026-06-01")
        self.assertEqual(snap[self.one.id]["before"]["remuneration"], 0.0)
        self.assertEqual(snap[self.one.id]["after"]["status"], ClaimStatus.CLEARED)
        self.assertNotIn("held", detail, "a doubt about a paper stays off the audit Finance can read")
        for claim in (self.one, self.two):
            self.assertTrue(
                AuditLog.objects.filter(action=erp_remark.ACTION, entity="Claim", entity_id=claim.id).exists()
            )
            step = ClaimAction.objects.get(claim=claim, action=erp_remark.ACTION)
            self.assertEqual((step.from_status, step.to_status, step.actor),
                             (ClaimStatus.PAID, ClaimStatus.CLEARED, self.admin))

    def test_the_imports_zero_payment_is_reversed_so_the_claim_can_be_paid_later(self):
        self.assertIsNotNone(payment_guards.already_paid_answer(self.one), "the import's ₹0 row reads as paid")
        self.apply()
        one = self.fresh(self.one)
        reversal = one.ledger_rows.get(kind=PaidLedger.Kind.REVERSAL)
        self.assertEqual((reversal.cycle, reversal.amount), (1, 0.0))
        self.assertEqual(payment_guards.current_cycle(one), 2)
        self.assertIsNone(payment_guards.already_paid_answer(one))
        self.assertFalse(self.fresh(self.two).ledger_rows.exists(), "no row to reverse, none written")

    def test_a_stale_preview_is_refused_and_nothing_changes(self):
        old = self.preview()["signature"]
        late = self.erp("ERP-PROCESSED-11")
        r = self.apply({"signature": old, "confirm": True})
        self.assertEqual(r.status_code, 409, r.content)
        for claim in (self.one, self.two, late):
            self.assertEqual(self.fresh(claim).status, ClaimStatus.PAID)
        self.assertFalse(AuditLog.objects.filter(action=erp_remark.ACTION).exists())

    def test_it_must_be_confirmed(self):
        r = self.apply({"signature": self.preview()["signature"], "confirm": False})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self.fresh(self.one).status, ClaimStatus.PAID)

    def test_applying_twice_changes_nothing_the_second_time(self):
        first = self.preview()["signature"]
        self.assertEqual(self.apply({"signature": first, "confirm": True}).json()["changed"], 2)
        after = self.preview()
        self.assertEqual(after["counts"]["will_change"], 0)
        self.assertEqual(after["counts"]["already_done"], 2)
        self.assertEqual(self.apply({"signature": first, "confirm": True}).status_code, 409)
        again = self.apply({"signature": after["signature"], "confirm": True})
        self.assertEqual(again.status_code, 200, again.content)
        self.assertEqual((again.json()["changed"], again.json()["batch_id"]), (0, None))
        self.assertEqual(AuditLog.objects.filter(action=erp_remark.ACTION, entity=erp_remark.ENTITY).count(), 1)
        self.assertEqual(PaidLedger.objects.filter(kind=PaidLedger.Kind.REVERSAL).count(), 1)

    def test_the_admin_can_narrow_the_batch_but_never_widen_it(self):
        sig = self.preview()["signature"]
        r = self.apply({"signature": sig, "confirm": True, "include_only": ["ERP-PROCESSED-1", "erp-processed-3"]})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["changed"], body["skipped"]), (1, 1))
        self.assertEqual(body["skipped_claims"][0]["claim_no"], "ERP-PROCESSED-3")
        self.assertEqual(self.fresh(self.rejected).status, ClaimStatus.PAID, "a held claim is never changed")
        self.assertEqual(self.fresh(self.two).status, ClaimStatus.PAID)
        rest = self.preview()
        r = self.apply({"signature": rest["signature"], "confirm": True, "exclude_claim_nos": ["ERP-RAW-2"]})
        self.assertEqual(r.json()["changed"], 0)
        self.assertEqual(self.fresh(self.two).status, ClaimStatus.PAID)

    def test_nobody_remarks_their_own_claim(self):
        mine = self.erp("ERP-PROCESSED-12", owner=self.admin)
        body = self.apply().json()
        self.assertEqual((body["changed"], body["skipped"]), (2, 1))
        self.assertEqual(body["skipped_claims"][0]["claim_no"], "ERP-PROCESSED-12")
        self.assertEqual(self.fresh(mine).status, ClaimStatus.PAID)


class WhoMayUseIt(RemarkBase):
    def test_only_a_super_admin(self):
        claim = self.erp("ERP-PROCESSED-1")
        sig = self.preview()["signature"]
        for who in (self.finance, self.director, self.principal, self.cell, self.coordinator, self.faculty):
            self.assertEqual(self._as(who).get(PREVIEW).status_code, 403, who.role)
            self.assertEqual(self._as(who).get(BATCHES).status_code, 403, who.role)
            self.assertEqual(self.apply({"signature": sig, "confirm": True}, who=who).status_code, 403, who.role)
            self.assertEqual(self._post(who, UNDO, {"batch_id": "x"}).status_code, 403, who.role)
        self.assertEqual(self.fresh(claim).status, ClaimStatus.PAID)

    def test_viewing_as_somebody_changes_nothing(self):
        claim = self.erp("ERP-PROCESSED-1")
        sig = self.preview()["signature"]
        client = self._as(self.admin)
        session = client.session
        session[IMPERSONATOR_KEY] = User.objects.create_user(
            email="other-admin@test.edu", password=None, name="Other", role=Role.SUPER_ADMIN).id
        session.save()
        r = client.post(APPLY, data=json.dumps({"signature": sig, "confirm": True}), content_type="application/json")
        self.assertEqual(r.status_code, 403, r.content)
        self.assertEqual(self.fresh(claim).status, ClaimStatus.PAID)


class Undoing(RemarkBase):
    def setUp(self):
        super().setUp()
        self.one = self.erp("ERP-PROCESSED-1")
        self.two = self.erp("ERP-RAW-2", amount=None, ledger=None)

    def test_undo_restores_exactly_what_was_there(self):
        batch = self.apply().json()["batch_id"]
        r = self._post(self.admin, UNDO, {"batch_id": batch})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"restored": 2, "skipped": []})
        one, two = self.fresh(self.one), self.fresh(self.two)
        self.assertEqual((one.status, one.paid_at, one.payout_month, one.remuneration),
                         (ClaimStatus.PAID, IMPORTED_AT, IMPORT_MONTH, 0.0))
        self.assertEqual((two.status, two.remuneration), (ClaimStatus.PAID, None))
        self.assertTrue(AuditLog.objects.filter(action=erp_remark.UNDO_ACTION, entity=erp_remark.ENTITY,
                                                entity_id=batch).exists())
        self.assertTrue(ClaimAction.objects.filter(claim=self.one, action=erp_remark.UNDO_ACTION).exists())
        listed = self._as(self.admin).get(BATCHES).json()["batches"]
        self.assertEqual(len(listed), 1)
        self.assertEqual((listed[0]["batch_id"], listed[0]["changed"], listed[0]["undone"]), (batch, 2, True))
        self.assertEqual(listed[0]["by"], self.admin.name)

    def test_undo_leaves_a_claim_that_has_moved_on(self):
        batch = self.apply().json()["batch_id"]
        expected = Claim.objects.get(pk=self.one.pk)
        _apply_calc(expected)
        moved = self._post(self.principal, f"/api/claims/{self.one.id}/principal-approve",
                           {"expected_amount": expected.remuneration})
        self.assertEqual(moved.status_code, 200, moved.content)
        body = self._post(self.admin, UNDO, {"batch_id": batch}).json()
        self.assertEqual(body["restored"], 1)
        self.assertEqual([s["claim_no"] for s in body["skipped"]], ["ERP-PROCESSED-1"])
        self.assertEqual(self.fresh(self.one).status, ClaimStatus.PRINCIPAL_APPROVED)
        self.assertEqual(self.fresh(self.two).status, ClaimStatus.PAID)

    def test_a_batch_is_undone_once(self):
        batch = self.apply().json()["batch_id"]
        self.assertEqual(self._post(self.admin, UNDO, {"batch_id": batch}).status_code, 200)
        self.assertEqual(self._post(self.admin, UNDO, {"batch_id": batch}).status_code, 409)
        self.assertEqual(self._post(self.admin, UNDO, {"batch_id": "no-such-batch"}).status_code, 404)

    def test_after_an_undo_the_same_claims_can_be_remarked_without_a_second_reversal(self):
        batch = self.apply().json()["batch_id"]
        self._post(self.admin, UNDO, {"batch_id": batch})
        self.assertEqual(self.nos(self.preview()["will_change"]), ["ERP-PROCESSED-1", "ERP-RAW-2"])
        self.assertEqual(self.apply().json()["changed"], 2)
        self.assertEqual(self.fresh(self.one).ledger_rows.filter(kind=PaidLedger.Kind.REVERSAL).count(), 1)
        self.assertIsNone(payment_guards.already_paid_answer(self.fresh(self.one)))


class TheNormalRunPicksThemUp(RemarkBase):
    """Cleared is where the run starts: the Principal works the amount out and
    approves it, the Director authorises it, and Finance pays it, once."""

    def test_a_remarked_claim_is_priced_authorised_and_paid_through_the_ordinary_chain(self):
        claim = self.erp("ERP-PROCESSED-1")
        repeat = self.erp("ERP-PROCESSED-4", doi="10.5555/remark.repeat")
        PriorPayment.objects.create(employee_id=self.faculty.staff_id, doi="10.5555/remark.repeat",
                                    amount_paid=12000.0, paper_title="Earlier", raw_json="{}", claim_ref="1")
        self.assertEqual(self.apply().json()["changed"], 1)

        queue = self._as(self.principal).get("/api/principal/queue").json()
        ids = [r["id"] for r in queue["results"]]
        self.assertIn(claim.id, ids)
        self.assertNotIn(repeat.id, ids)

        priced = Claim.objects.get(pk=claim.pk)
        _apply_calc(priced)
        amount = priced.remuneration
        self.assertGreater(amount, 0)
        for who, step in ((self.principal, "principal-approve"), (self.director, "director-approve")):
            r = self._post(who, f"/api/claims/{claim.id}/{step}", {"expected_amount": amount})
            self.assertEqual(r.status_code, 200, r.content)

        payable = self._as(self.finance).get("/api/admin/payouts", {"status": "DIRECTOR_APPROVED"}).json()
        self.assertEqual([r["id"] for r in payable["results"]], [claim.id])

        paid = self._post(self.finance, f"/api/claims/{claim.id}/mark-paid", {"expected_amount": amount})
        self.assertEqual(paid.status_code, 200, paid.content)
        claim = self.fresh(claim)
        self.assertEqual(claim.status, ClaimStatus.PAID)
        payment = claim.ledger_rows.get(kind=PaidLedger.Kind.PAYMENT, cycle=2)
        self.assertEqual(payment.amount, amount)
        self.assertAlmostEqual(payment_guards.net_on_ledger(claim), amount)
