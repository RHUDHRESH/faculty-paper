"""The calendar's dates from the record: payments made, papers published, papers filed.

Nobody has entered a calendar event, so a calendar of entered events is empty
for everyone -- while the ledger holds thirty months of payouts. These are
read-only entries worked out from what the record actually carries, and never
from a date an import stamped on a row because it had none.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone as dt_tz

from django.test import Client, TestCase

from core.models import Claim, ClaimAction, ClaimStatus, PaidLedger, Role, User

ERP_ROW = {"S.No": "1.0", "Faculty Name": "X", "Amount": "1000"}


def _ledger(amount, month, *, staff_id=None, claim=None, recorded=True):
    raw = dict(ERP_ROW, Month=f"{month.isoformat()} 00:00:00") if recorded else ERP_ROW
    return PaidLedger.objects.create(
        payout_month=month, amount=amount, paper_title="P", staff_id=staff_id,
        claim=claim, raw_json=json.dumps(raw),
    )


class CalendarRecordTests(TestCase):
    def setUp(self):
        self.office = User.objects.create_user(
            email="cal-office@x.edu", password="p", name="Office", role=Role.RESEARCH_CELL
        )
        self.me = User.objects.create_user(
            email="cal-me@x.edu", password="p", name="Me", role=Role.FACULTY,
            staff_id="TS1", department="ECE",
        )
        self.other = User.objects.create_user(
            email="cal-other@x.edu", password="p", name="Other", role=Role.FACULTY,
            staff_id="TS2", department="ECE",
        )
        self.head = User.objects.create_user(
            email="cal-head@x.edu", password="p", name="Head", role=Role.HOD,
            staff_id="TS3", department="ECE",
        )

    def record(self, user, start="2025-03-01", end="2025-03-31"):
        c = Client()
        c.force_login(user)
        r = c.get(f"/api/calendar?start={start}&end={end}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["record"]

    def test_the_office_sees_each_payout_month_with_what_went_out(self):
        _ledger(1000, date(2025, 3, 1), staff_id="TS1")
        _ledger(500, date(2025, 3, 1), staff_id="TS2")
        paid = [e for e in self.record(self.office) if e["kind"] == "PAID"]
        self.assertEqual(len(paid), 1)
        self.assertEqual(paid[0]["starts_on"], "2025-03-01")
        self.assertEqual((paid[0]["count"], paid[0]["amount"]), (2, 1500))

    def test_a_month_the_import_had_to_guess_is_not_shown_as_a_payout(self):
        owner_claim = Claim.objects.create(owner=self.me, status=ClaimStatus.PAID, paper_title="T")
        _ledger(1000, date(2025, 3, 1), claim=owner_claim, recorded=False)
        self.assertEqual([e for e in self.record(self.office) if e["kind"] == "PAID"], [])

    def test_a_claimant_sees_their_own_payments_and_never_the_college_total(self):
        _ledger(1000, date(2025, 3, 1), staff_id="TS1")
        _ledger(7000, date(2025, 3, 1), staff_id="TS2")
        paid = [e for e in self.record(self.me) if e["kind"] == "PAID"]
        self.assertEqual(len(paid), 1)
        self.assertEqual(paid[0]["amount"], 1000)
        self.assertNotIn("7000", json.dumps(self.record(self.me)))
        self.assertNotIn("8000", json.dumps(self.record(self.me)))

    def test_a_head_sees_only_their_own_money(self):
        _ledger(1000, date(2025, 3, 1), staff_id="TS3")
        _ledger(7000, date(2025, 3, 1), staff_id="TS2")
        body = json.dumps(self.record(self.head))
        self.assertIn("1000", body)
        self.assertNotIn("7000", body)
        self.assertNotIn("8000", body)

    def test_a_claimant_sees_the_publication_dates_of_their_own_papers_only(self):
        mine = Claim.objects.create(
            owner=self.me, status=ClaimStatus.PAID, paper_title="My paper",
            publication_date="2025-03-14",
        )
        Claim.objects.create(
            owner=self.other, status=ClaimStatus.PAID, paper_title="Their paper",
            publication_date="2025-03-20",
        )
        published = [e for e in self.record(self.me) if e["kind"] == "PUBLISHED"]
        self.assertEqual([(e["starts_on"], e["claim_id"]) for e in published], [("2025-03-14", mine.id)])
        self.assertIn("My paper", published[0]["title"])

    def test_a_head_sees_their_departments_papers_but_no_other_departments(self):
        Claim.objects.create(
            owner=self.other, status=ClaimStatus.PAID, paper_title="A colleague's paper",
            publication_date="2025-03-14", remuneration=9000,
        )
        stranger = User.objects.create_user(
            email="cal-far@x.edu", password="p", name="Far", role=Role.FACULTY, department="MECH"
        )
        Claim.objects.create(
            owner=stranger, status=ClaimStatus.PAID, paper_title="Another department",
            publication_date="2025-03-15",
        )
        record = self.record(self.head)
        published = [e for e in record if e["kind"] == "PUBLISHED"]
        self.assertEqual(len(published), 1)
        self.assertIn("A colleague's paper", published[0]["titles"])
        self.assertNotIn("Another department", json.dumps(record))
        self.assertNotIn("9000", json.dumps(record))

    def test_the_office_sees_publications_gathered_by_month(self):
        for i in range(3):
            Claim.objects.create(
                owner=self.me, status=ClaimStatus.SUBMITTED, paper_title=f"Paper {i}",
                publication_date=f"2025-03-{10 + i}",
            )
        published = [e for e in self.record(self.office) if e["kind"] == "PUBLISHED"]
        self.assertEqual(len(published), 1)
        self.assertEqual(published[0]["count"], 3)

    def test_a_draft_is_nobody_elses_business(self):
        Claim.objects.create(
            owner=self.me, status=ClaimStatus.DRAFT, paper_title="Half done",
            publication_date="2025-03-14",
        )
        self.assertEqual([e for e in self.record(self.office) if e["kind"] == "PUBLISHED"], [])

    def test_a_filing_date_the_import_stamped_is_not_a_filing(self):
        stamped = Claim.objects.create(owner=self.me, status=ClaimStatus.PAID, paper_title="Imported")
        Claim.objects.filter(pk=stamped.pk).update(
            submitted_at=stamped.created_at, created_at=stamped.created_at
        )
        start = stamped.created_at.date().isoformat()
        filed = [e for e in self.record(self.office, start, start) if e["kind"] == "FILED"]
        self.assertEqual(filed, [])

    def test_a_filing_the_old_form_recorded_is_shown(self):
        real = datetime(2025, 3, 5, 10, 0, tzinfo=dt_tz.utc)
        c = Claim.objects.create(owner=self.me, status=ClaimStatus.SUBMITTED, paper_title="Filed by form")
        Claim.objects.filter(pk=c.pk).update(submitted_at=real)
        filed = [e for e in self.record(self.me) if e["kind"] == "FILED"]
        self.assertEqual([e["starts_on"] for e in filed], ["2025-03-05"])

    def test_a_filing_made_here_is_shown_on_its_day(self):
        c = Claim.objects.create(owner=self.me, status=ClaimStatus.SUBMITTED, paper_title="Filed here")
        ClaimAction.objects.create(claim=c, actor=self.me, action="SUBMIT")
        day = c.created_at.date()
        Claim.objects.filter(pk=c.pk).update(submitted_at=c.created_at)
        filed = [e for e in self.record(self.me, day.isoformat(), (day + timedelta(days=1)).isoformat()) if e["kind"] == "FILED"]
        self.assertEqual(len(filed), 1)
