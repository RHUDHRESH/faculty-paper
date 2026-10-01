"""Review marks: who may mark, who sees which mark, and what a send-back keeps.

The rules under test (docs/ux/21-review-and-apply.md, section B):
staff at the desk the claim is at create and edit; the claimant sees only the
CLAIMANT marks that went back to them, never an author name and never a
staff-only mark; the Director and Finance see none; nobody marks their own
claim.
"""
from __future__ import annotations

import json

from core.models import (
    AttachmentKind,
    ClaimAttachment,
    ClaimStatus,
    ReviewMark,
    Role,
    SendBackRecord,
    User,
)
from core.services import review_marks as marks_service
from core.test_chain_rules import ChainBase

STAFF_SECRET = "STAFFSECRET the SNIP looks doctored to me"
CLAIMANT_TEXT = "The affiliation line is cut off on page 1"
RECT = {"x": 0.1, "y": 0.2, "w": 0.4, "h": 0.05}


class MarkBase(ChainBase):
    def setUp(self):
        super().setUp()
        self.claim = self._claim()
        self.upload = ClaimAttachment.objects.create(
            claim=self.claim, kind=AttachmentKind.PUBLISHED_PAPER,
            url="/media/claims/paper.pdf", filename="paper.pdf",
        )

    def _mark(self, user, **over):
        fields = {
            "upload_id": self.upload.id, "page": 1, "rect": RECT,
            "kind": "ISSUE", "body": CLAIMANT_TEXT, **over,
        }
        return self._post(user, f"/api/claims/{self.claim.id}/marks", fields)

    def _list(self, user, claim=None):
        return self._as(user).get(f"/api/claims/{(claim or self.claim).id}/marks")

    def _staff_mark(self):
        r = self._mark(self.cell, kind="NOTE", body=STAFF_SECRET, rect=None, upload_id=None, page=None)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class CreateAndEditTests(MarkBase):
    def test_the_desk_creates_a_mark_and_kind_sets_the_default_audience(self):
        r = self._mark(self.cell)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["audience"], "CLAIMANT")
        self.assertEqual(body["author_name"], self.cell.name)
        self.assertEqual(body["rect"], RECT)
        self.assertEqual(body["state"], "open")
        note = self._mark(self.cell, kind="NOTE", body="checked the DOI").json()
        ok = self._mark(self.cell, kind="OK", body="affiliation is right").json()
        self.assertEqual((note["audience"], ok["audience"]), ("STAFF", "STAFF"))

    def test_the_coordinator_and_super_admin_mark_at_the_supervisor_desk(self):
        for who in (self.coordinator, self.admin):
            self.assertEqual(self._mark(who).status_code, 200, who.role)

    def test_only_the_desk_the_paper_is_at_marks_it(self):
        # Submitted: the Principal's desk is not this paper's.
        self.assertEqual(self._mark(self.principal).status_code, 403)
        cleared = self._claim(ClaimStatus.CLEARED, ticket="CH-M2")
        r = self._post(self.principal, f"/api/claims/{cleared.id}/marks", {"kind": "NOTE", "body": "look at ref 14"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._post(self.cell, f"/api/claims/{cleared.id}/marks", {"kind": "NOTE", "body": "look at ref 14"})
        self.assertEqual(r.status_code, 403)

    def test_the_director_finance_hod_and_faculty_cannot_mark(self):
        for who in (self.director, self.finance, self.hod, self.faculty):
            self.assertEqual(self._mark(who).status_code, 403, who.role)

    def test_nobody_marks_their_own_claim(self):
        own = self._claim(ticket="CH-OWN", owner=self.cell)
        for who in (self.cell,):
            r = self._post(who, f"/api/claims/{own.id}/marks", {"kind": "NOTE", "body": "my own"})
            self.assertEqual(r.status_code, 403)
        # Another desk-holder still can.
        r = self._post(self.coordinator, f"/api/claims/{own.id}/marks", {"kind": "NOTE", "body": "second look"})
        self.assertEqual(r.status_code, 200, r.content)
        mark_id = r.json()["id"]
        # The owner may not edit, resolve, reopen or delete it either.
        self.assertEqual(
            self._as(self.cell).patch(
                f"/api/marks/{mark_id}", data=json.dumps({"body": "x" * 5}),
                content_type="application/json",
            ).status_code, 403,
        )
        self.assertEqual(self._post(self.cell, f"/api/marks/{mark_id}/resolve").status_code, 403)
        self.assertEqual(self._post(self.cell, f"/api/marks/{mark_id}/reopen").status_code, 403)
        self.assertEqual(self._as(self.cell).delete(f"/api/marks/{mark_id}").status_code, 403)

    def test_a_super_admin_owning_no_claim_can_still_not_mark_a_paid_paper(self):
        paid = self._claim(ClaimStatus.PAID, ticket="CH-PD")
        r = self._post(self.admin, f"/api/claims/{paid.id}/marks", {"kind": "NOTE", "body": "late"})
        self.assertEqual(r.status_code, 403)

    def test_bad_input_is_refused(self):
        self.assertEqual(self._mark(self.cell, rect={"x": 0.9, "y": 0.1, "w": 0.4, "h": 0.1}).status_code, 400)
        self.assertEqual(self._mark(self.cell, kind="SHOUT").status_code, 400)
        self.assertEqual(self._mark(self.cell, checklist_key="nope").status_code, 400)
        self.assertEqual(self._mark(self.cell, body="", rect=None, upload_id=None, page=None).status_code, 400)
        self.assertEqual(self._mark(self.cell, body="").status_code, 400)  # an issue for the claimant needs words
        other = self._claim(ticket="CH-OTH")
        stray = ClaimAttachment.objects.create(
            claim=other, kind=AttachmentKind.PUBLISHED_PAPER, url="/media/claims/x.pdf"
        )
        self.assertEqual(self._mark(self.cell, upload_id=stray.id).status_code, 400)
        draft = self._claim(ClaimStatus.DRAFT, ticket="CH-DR")
        r = self._post(self.cell, f"/api/claims/{draft.id}/marks", {"kind": "NOTE", "body": "abc"})
        self.assertEqual(r.status_code, 404)

    def test_a_checklist_only_mark_needs_no_document(self):
        r = self._mark(
            self.cell, upload_id=None, page=None, rect=None,
            kind="ISSUE", checklist_key="sec_refs", body="Reference 14 is missing",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["upload_id"])

    def test_edit_resolve_reopen_and_delete(self):
        mark_id = self._mark(self.cell).json()["id"]
        r = self._as(self.coordinator).patch(
            f"/api/marks/{mark_id}",
            data=json.dumps({"body": "Affiliation missing", "audience": "STAFF", "rect": None}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["body"], "Affiliation missing")
        self.assertEqual(r.json()["audience"], "STAFF")
        self.assertIsNone(r.json()["rect"])
        r = self._post(self.cell, f"/api/marks/{mark_id}/resolve")
        self.assertEqual(r.json()["state"], "resolved")
        self.assertEqual(r.json()["resolved_by_name"], self.cell.name)
        r = self._post(self.cell, f"/api/marks/{mark_id}/reopen")
        self.assertEqual(r.json()["state"], "open")
        self.assertEqual(self._as(self.cell).delete(f"/api/marks/{mark_id}").status_code, 200)
        self.assertFalse(ReviewMark.objects.filter(pk=mark_id).exists())


class VisibilityTests(MarkBase):
    def setUp(self):
        super().setUp()
        self.issue = self._mark(self.cell).json()
        self.secret = self._staff_mark()

    def test_reviewers_see_every_mark_with_author_names(self):
        for who in (self.cell, self.coordinator, self.admin, self.principal):
            body = self._list(who).json()
            self.assertEqual(body["viewer"], "reviewer")
            self.assertEqual(len(body["results"]), 2, who.role)
            self.assertEqual({m["author_name"] for m in body["results"]}, {self.cell.name})

    def test_the_director_and_finance_see_no_mark_at_all(self):
        for who in (self.director, self.finance):
            r = self._list(who)
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json()["results"], [])
            raw = r.content.decode()
            self.assertNotIn(STAFF_SECRET, raw)
            self.assertNotIn(CLAIMANT_TEXT, raw)
            self.assertFalse(r.json()["can_mark"])

    def test_a_head_of_department_and_other_faculty_are_refused(self):
        self.assertEqual(self._list(self.hod).status_code, 403)
        other = User.objects.create_user(
            email="other-fac@test.edu", password=None, name="Other Faculty", role=Role.FACULTY
        )
        self.assertEqual(self._list(other).status_code, 403)

    def test_the_claimant_sees_nothing_until_it_is_sent_back(self):
        r = self._list(self.faculty)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["results"], [])
        self.assertEqual(r.json()["viewer"], "claimant")
        self.assertNotIn(CLAIMANT_TEXT, r.content.decode())

    def test_the_claimant_sees_only_claimant_marks_from_the_college(self):
        ReviewMark.objects.filter(pk=self.issue["id"]).update(sent_back_at=marks_service.timezone.now())
        ReviewMark.objects.filter(pk=self.secret["id"]).update(sent_back_at=marks_service.timezone.now())
        r = self._list(self.faculty)
        raw = r.content.decode()
        body = r.json()
        self.assertEqual([m["body"] for m in body["results"]], [CLAIMANT_TEXT])
        self.assertEqual(body["results"][0]["author_name"], "The college")
        self.assertIsNone(body["results"][0]["author_id"])
        self.assertIsNone(body["results"][0]["resolved_by_name"])
        self.assertNotIn(STAFF_SECRET, raw)
        for name in (self.cell.name, self.coordinator.name, self.principal.name, self.admin.name):
            self.assertNotIn(name, raw)
        self.assertNotIn(self.cell.id, raw)
        self.assertFalse(body["can_mark"])

    def test_an_officer_who_filed_the_claim_is_its_claimant_and_not_a_reviewer(self):
        own = self._claim(ticket="CH-PO", owner=self.principal, status=ClaimStatus.SUBMITTED)
        m = ReviewMark.objects.create(
            claim=own, kind="NOTE", audience="STAFF", body=STAFF_SECRET, author=self.cell
        )
        i = ReviewMark.objects.create(
            claim=own, kind="ISSUE", audience="CLAIMANT", body=CLAIMANT_TEXT, author=self.cell,
            sent_back_at=marks_service.timezone.now(),
        )
        r = self._list(self.principal, own)
        self.assertEqual(r.json()["viewer"], "claimant")
        self.assertEqual([x["id"] for x in r.json()["results"]], [i.id])
        self.assertNotIn(STAFF_SECRET, r.content.decode())
        self.assertNotIn(m.id, r.content.decode())

    def test_an_anonymous_visitor_is_refused(self):
        from django.test import Client

        r = Client().get(f"/api/claims/{self.claim.id}/marks")
        self.assertIn(r.status_code, (401, 403))


class SendBackTests(MarkBase):
    CHECKLIST = [
        {"key": "affiliation", "status": "issue", "note": "Not on the first page"},
        {"key": "indexing", "status": "ok", "note": ""},
        {"key": "sec_refs", "status": "needs_info", "note": "Send reference 14"},
        {"key": "bogus", "status": "issue"},
        {"key": "quartile", "status": "weird"},
    ]

    def _send_back(self, user=None, checklist=None, note="Please fix the items listed below"):
        body = {"note": note}
        if checklist is not None:
            body["checklist"] = checklist
        return self._post(user or self.cell, f"/api/claims/{self.claim.id}/return-to-faculty", body)

    def test_send_back_stores_open_claimant_marks_and_failed_checklist_items(self):
        self._mark(self.cell)
        self._staff_mark()
        resolved = self._mark(self.cell, body="Already fixed by the desk").json()
        self._post(self.cell, f"/api/marks/{resolved['id']}/resolve")
        r = self._send_back(checklist=self.CHECKLIST)
        self.assertEqual(r.status_code, 200, r.content)
        rec = SendBackRecord.objects.get(claim=self.claim)
        marks = json.loads(rec.marks_json)
        self.assertEqual([m["body"] for m in marks], [CLAIMANT_TEXT])
        self.assertEqual(marks[0]["author_name"], "The college")
        checklist = json.loads(rec.checklist_json)
        self.assertEqual([c["key"] for c in checklist], ["affiliation", "sec_refs", "other"])
        self.assertEqual(rec.reason, "Please fix the items listed below")
        self.assertEqual(rec.action.action, "REJECT")
        # Only the claimant marks that were open became theirs.
        sent = ReviewMark.objects.filter(claim=self.claim, sent_back_at__isnull=False)
        self.assertEqual(sent.count(), 1)

    def test_the_claimant_then_sees_the_marks_and_the_send_back(self):
        self._mark(self.cell)
        secret = self._staff_mark()
        self._send_back(checklist=self.CHECKLIST)
        r = self._list(self.faculty)
        body = r.json()
        raw = r.content.decode()
        self.assertEqual(len(body["results"]), 1)
        self.assertEqual(len(body["send_back"]["marks"]), 1)
        self.assertEqual(len(body["send_back"]["checklist"]), 3)
        self.assertEqual(body["send_back"]["reason"], "Please fix the items listed below")
        self.assertNotIn(STAFF_SECRET, raw)
        self.assertNotIn(secret["id"], raw)
        self.assertNotIn(self.cell.name, raw)

    def test_rejecting_outright_keeps_no_fix_list(self):
        self._mark(self.cell)
        r = self._post(
            self.cell, f"/api/claims/{self.claim.id}/reject-outright",
            {"note": "This is not a paper of this college"},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(SendBackRecord.objects.filter(claim=self.claim).exists())

    def test_a_send_back_without_a_checklist_still_works(self):
        self._mark(self.cell)
        self.assertEqual(self._send_back().status_code, 200)
        self.assertEqual(json.loads(SendBackRecord.objects.get().checklist_json), [])

    def test_a_sent_mark_cannot_be_deleted_only_resolved(self):
        mark_id = self._mark(self.cell).json()["id"]
        self._send_back()
        self.claim.refresh_from_db()
        # Back at the desk after a resubmission.
        self.claim.status = ClaimStatus.SUBMITTED
        self.claim.save()
        self.assertEqual(self._as(self.cell).delete(f"/api/marks/{mark_id}").status_code, 400)

    def test_resubmission_shows_open_marks_as_fixed_to_confirm(self):
        open_id = self._mark(self.cell).json()["id"]
        closed_id = self._mark(self.cell, body="Second thing to fix").json()["id"]
        self._send_back()
        self.claim.refresh_from_db()
        self.claim.status = ClaimStatus.SUBMITTED
        self.claim.save()
        self.assertEqual(self._post(self.cell, f"/api/marks/{closed_id}/resolve").status_code, 200)
        self.assertEqual(marks_service.note_resubmission(self.claim), 1)
        by_id = {m["id"]: m for m in self._list(self.cell).json()["results"]}
        self.assertEqual(by_id[open_id]["state"], "fixed?")
        self.assertEqual(by_id[closed_id]["state"], "resolved")
        # The claimant sees the same state, still without a name.
        theirs = {m["id"]: m for m in self._list(self.faculty).json()["results"]}
        self.assertEqual(theirs[open_id]["state"], "fixed?")
        # Confirming closes it; reopening says it was not fixed.
        self.assertEqual(self._post(self.cell, f"/api/marks/{open_id}/resolve").json()["state"], "resolved")
        reopened = self._post(self.cell, f"/api/marks/{open_id}/reopen").json()
        self.assertEqual(reopened["state"], "open")
        self.assertFalse(reopened["resolved_in_resubmission"])
