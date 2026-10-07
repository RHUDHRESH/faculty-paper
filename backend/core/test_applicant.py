"""The applicant's side: the payout rhythm and the look at a claim's files before sending.

Both are the claimant's own, both are read-only, and neither names a desk.
"""
from __future__ import annotations

import json
import re
from datetime import date

from django.test import Client, TestCase

from core.models import (
    AttachmentCheck,
    AttachmentKind,
    Claim,
    ClaimConfirmation,
    ClaimFlag,
    ClaimStatus,
    FormulaConfig,
    PaidLedger,
    Role,
    User,
)
from core.services.applicant import payout_outlook
from core.test_flags import MediaMixin, _pdf, _scanned_pdf

#: Words that would tell a faculty member which desk or person holds a claim.
DESK_WORDS = re.compile(r"research office|research cell|principal|director|finance|clearing|head of department|\bHOD\b", re.I)

COLLEGE_LINE = "Asha Faculty, Department of CSE, Saveetha Engineering College, Chennai"


def _ledger(*months: date, amount: float = 1000) -> None:
    for m in months:
        PaidLedger.objects.create(payout_month=m, amount=amount, paper_title="P")


class PayoutOutlookTests(TestCase):
    def test_a_monthly_run_names_the_last_and_the_next_month(self):
        _ledger(*(date(2025, m, 1) for m in range(10, 13)), *(date(2026, m, 1) for m in range(1, 10)))
        out = payout_outlook(date(2026, 9, 30))
        self.assertEqual(out["pattern"], "monthly")
        self.assertEqual(out["last_run"], "2026-09")
        self.assertEqual(out["next_run"], "2026-10")
        self.assertEqual(out["next_run_label"], "October 2026")
        self.assertIn("The last run was September 2026", out["sentence"])
        self.assertIn("expected in October 2026", out["sentence"])

    def test_when_this_months_run_has_not_happened_it_is_the_next_one(self):
        _ledger(*(date(2025, m, 1) for m in range(10, 13)), *(date(2026, m, 1) for m in range(1, 9)))
        out = payout_outlook(date(2026, 9, 12))
        self.assertEqual(out["next_run"], "2026-09")
        self.assertIn("September 2026's is still to come", out["sentence"])

    def test_no_history_gives_no_date_and_says_who_to_ask(self):
        out = payout_outlook(date(2026, 9, 12))
        self.assertEqual(out["pattern"], "none")
        self.assertIsNone(out["next_run"])
        self.assertIn("research office", out["sentence"])

    def test_the_filing_cutoff_is_said_when_the_policy_sets_one(self):
        FormulaConfig.objects.create(active=True, filing_cutoff_day=22)
        _ledger(*(date(2025, m, 1) for m in range(10, 13)), *(date(2026, m, 1) for m in range(1, 10)))
        self.assertIn("closes on the 22nd", payout_outlook(date(2026, 9, 30))["sentence"])

    def test_the_endpoint_needs_a_session_and_names_no_desk(self):
        _ledger(*(date(2025, m, 1) for m in range(10, 13)), *(date(2026, m, 1) for m in range(1, 10)))
        self.assertIn(Client().get("/api/me/next-payout").status_code, (401, 403))
        me = User.objects.create_user(email="f@x.edu", password=None, name="F", role=Role.FACULTY)
        c = Client()
        c.force_login(me)
        res = c.get("/api/me/next-payout")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["pattern"], "monthly")
        self.assertIsNone(DESK_WORDS.search(res.content.decode()))


class PrecheckTests(MediaMixin, TestCase):
    def setUp(self):
        super().setUp()
        FormulaConfig.objects.create(active=True, min_sec_references=2)
        self.me = User.objects.create_user(
            email="asha@x.edu", password=None, name="Asha Faculty", role=Role.FACULTY, staff_id="S1"
        )
        self.other = User.objects.create_user(email="o@x.edu", password=None, name="Other", role=Role.FACULTY)
        self.c = Client()
        self.c.force_login(self.me)
        self.claim = Claim.objects.create(
            owner=self.me, status=ClaimStatus.REJECTED, paper_title="A paper", total_authors=3,
            author_position=1, authors_json=json.dumps(["Asha Faculty", "B. Second", "C. Third"]),
        )

    def _run(self, claim=None, client=None):
        res = (client or self.c).post(f"/api/claims/{(claim or self.claim).id}/precheck")
        self.assertEqual(res.status_code, 200, res.content)
        return {f["key"]: f for f in res.json()["findings"]}, res.json()

    def _paper(self, *lines):
        return self._attach(self.claim, _pdf(*lines), "a1")

    def _ref(self, stem, number, *lines):
        return self._attach(
            self.claim, _pdf(*lines), stem, kind=AttachmentKind.SEC_REFERENCE,
            ref_number=number, ref_title=f"Ref {stem}",
        )

    def test_affiliation_present_in_the_paper_is_ok(self):
        self._paper("Some title", COLLEGE_LINE)
        found, _ = self._run()
        self.assertEqual(found["affiliation"]["status"], "ok")

    def test_affiliation_missing_from_the_paper_warns_and_says_what_to_do(self):
        self._paper("Some title", "Asha Faculty, Somewhere Else University")
        found, body = self._run()
        self.assertEqual(found["affiliation"]["status"], "warn")
        self.assertIn("replace it", found["affiliation"]["detail"])
        self.assertGreaterEqual(body["warnings"], 1)

    def test_a_scanned_paper_cannot_be_searched_and_says_so_without_accusing(self):
        self._attach(self.claim, _scanned_pdf(), "a2")
        found, _ = self._run()
        self.assertEqual(found["affiliation"]["status"], "unknown")
        self.assertIn("scan", found["affiliation"]["detail"])

    def test_no_paper_attached_is_a_warning(self):
        found, _ = self._run()
        self.assertEqual(found["affiliation"]["status"], "warn")
        self.assertIn("not attached", found["affiliation"]["title"])

    def test_references_must_reach_the_minimum_and_be_numbered(self):
        self._ref("c1", "4", "Reference one", COLLEGE_LINE)
        found, _ = self._run()
        self.assertEqual(found["sec_refs"]["status"], "warn")
        self.assertIn("1 of 2", found["sec_refs"]["title"])

        self._ref("d2", "", "Reference two", COLLEGE_LINE)
        found, _ = self._run()
        self.assertEqual(found["sec_refs"]["status"], "warn")
        self.assertIn("no number", found["sec_refs"]["title"])

        ClaimAttachmentFix = self.claim.attachments.filter(filename="d2.pdf").first()
        ClaimAttachmentFix.ref_number = "9"
        ClaimAttachmentFix.save()
        found, _ = self._run()
        self.assertEqual(found["sec_refs"]["status"], "ok")
        self.assertEqual(found["reference_affiliation"]["status"], "ok")

    def test_a_reference_that_does_not_show_the_college_warns(self):
        self._ref("c1", "1", "Reference one", COLLEGE_LINE)
        self._ref("d2", "2", "Reference two", "Somebody Else, Department of Physics, Elsewhere Institute of Technology")
        found, _ = self._run()
        self.assertEqual(found["reference_affiliation"]["status"], "warn")
        self.assertIn("d2.pdf", found["reference_affiliation"]["detail"])

    def test_author_position_against_the_saved_author_list(self):
        found, _ = self._run()
        self.assertEqual(found["author_position"]["status"], "ok")

        self.claim.author_position = 2
        self.claim.save()
        found, _ = self._run()
        self.assertEqual(found["author_position"]["status"], "warn")
        self.assertIn("position 1", found["author_position"]["detail"])

        self.claim.author_position = 1
        self.claim.total_authors = 5
        self.claim.save()
        found, _ = self._run()
        self.assertEqual(found["author_position"]["status"], "warn")
        self.assertIn("3 names", found["author_position"]["detail"])

    def test_no_author_list_is_unknown_not_wrong(self):
        self.claim.authors_json = None
        self.claim.save()
        found, _ = self._run()
        self.assertEqual(found["author_position"]["status"], "unknown")

    def test_it_only_warns_it_never_writes_or_ticks_anything(self):
        self._paper("Some title", "Elsewhere only")
        before = (Claim.objects.get(pk=self.claim.pk).status, self.claim.attachments.count())
        self._run()
        self.assertEqual((Claim.objects.get(pk=self.claim.pk).status, self.claim.attachments.count()), before)
        self.assertFalse(ClaimConfirmation.objects.exists(), "the conditions are ticked by the claimant only")
        self.assertFalse(AttachmentCheck.objects.exists())
        self.assertFalse(ClaimFlag.objects.exists())

    def test_only_the_owner_and_only_before_it_is_with_the_college(self):
        other = Client()
        other.force_login(self.other)
        self.assertEqual(other.post(f"/api/claims/{self.claim.id}/precheck").status_code, 404)
        self.assertIn(Client().post(f"/api/claims/{self.claim.id}/precheck").status_code, (401, 403))
        self.claim.status = ClaimStatus.SUBMITTED
        self.claim.save()
        res = self.c.post(f"/api/claims/{self.claim.id}/precheck")
        self.assertEqual(res.status_code, 400)
        self.assertNotRegex(res.content.decode(), DESK_WORDS)

    def test_nothing_in_the_answer_names_a_desk(self):
        self._paper("Some title", "Elsewhere only")
        self._ref("c1", "", "Reference one", "Elsewhere")
        _, body = self._run()
        self.assertIsNone(DESK_WORDS.search(json.dumps(body)))


class ListByStageTests(TestCase):
    """A claimant's stage covers several statuses; the list takes them joined by commas."""

    def test_several_statuses_in_one_request(self):
        me = User.objects.create_user(email="l@x.edu", password=None, name="L", role=Role.FACULTY)
        for status in (ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID):
            Claim.objects.create(owner=me, status=status, paper_title=f"P {status}")
        c = Client()
        c.force_login(me)
        one = c.get("/api/claims?mine=1&status=SUBMITTED").json()
        self.assertEqual(one["total"], 1)
        many = c.get("/api/claims?mine=1&status=SUBMITTED,CLEARED,PRINCIPAL_APPROVED").json()
        self.assertEqual(many["total"], 2)
        self.assertNotIn("status", many["results"][0], "the claimant's copy names no desk")
        self.assertIn(many["results"][0]["faculty_stage"], ("Under review",))


class MarksSurviveASaveTests(TestCase):
    """The claimant's fix saves the whole attachment set; a reviewer's marks must outlive it."""

    def setUp(self):
        from core.models import ClaimAttachment, ReviewMark

        self.me = User.objects.create_user(email="m@x.edu", password=None, name="M", role=Role.FACULTY)
        self.claim = Claim.objects.create(owner=self.me, status=ClaimStatus.REJECTED, paper_title="P")
        self.paper = ClaimAttachment.objects.create(
            claim=self.claim, kind=AttachmentKind.PUBLISHED_PAPER, url="/media/claims/a.pdf", filename="a.pdf"
        )
        self.mark = ReviewMark.objects.create(
            claim=self.claim, upload=self.paper, page=2, rect_x=0.1, rect_y=0.1, rect_w=0.3, rect_h=0.1,
            kind="ISSUE", audience="CLAIMANT", body="Affiliation is missing here.",
        )

    def _kept(self, url, kind=AttachmentKind.PUBLISHED_PAPER, **extra):
        return {"kind": kind, "url": url, "filename": "f.pdf", "size_bytes": 1, "ref_number": None,
                "ref_title": None, "content_hash": None, **extra}

    def test_saving_with_the_same_file_keeps_the_row_and_its_mark(self):
        from core.api.schemas import _persist_attachments

        _persist_attachments(self.claim, [self._kept("/media/claims/a.pdf")], self.me)
        self.mark.refresh_from_db()
        self.assertEqual(self.mark.upload_id, self.paper.id)

    def test_a_replaced_file_takes_over_the_marks_of_the_old_one(self):
        from core.api.schemas import _persist_attachments

        _persist_attachments(self.claim, [self._kept("/media/claims/b.pdf")], self.me)
        self.mark.refresh_from_db()
        self.assertEqual(self.mark.upload.url, "/media/claims/b.pdf")
        self.assertEqual(self.claim.attachments.count(), 1)

    def test_a_removed_file_leaves_its_mark_without_a_page(self):
        from core.api.schemas import _persist_attachments

        _persist_attachments(self.claim, [], self.me)
        self.mark.refresh_from_db()
        self.assertIsNone(self.mark.upload_id)
        self.assertIsNone(self.mark.rect_x)
        self.assertEqual(self.mark.body, "Affiliation is missing here.")