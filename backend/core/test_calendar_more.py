"""The calendar fills itself from what the record already knows, for a faculty
member: the college's payout months (no figures), department colleagues'
publications (with their face), and deadlines from their latest scout run."""
from __future__ import annotations

import json
from datetime import date

from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, PaidLedger, Role, ScoutRun, User


class CalendarMoreTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="m-me@x.edu", password="p", name="Me", role=Role.FACULTY, staff_id="M1", department="ECE"
        )
        self.mate = User.objects.create_user(
            email="m-mate@x.edu", password="p", name="Dr Mate", role=Role.FACULTY, staff_id="M2", department="ECE"
        )
        self.far = User.objects.create_user(
            email="m-far@x.edu", password="p", name="Far", role=Role.FACULTY, staff_id="M3", department="CIVIL"
        )
        self.office = User.objects.create_user(
            email="m-off@x.edu", password="p", name="Office", role=Role.RESEARCH_CELL
        )

    def record(self, user, start="2025-03-01", end="2025-03-31"):
        c = Client()
        c.force_login(user)
        r = c.get(f"/api/calendar?start={start}&end={end}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["record"]

    def test_a_claimant_sees_the_college_payout_month_without_figures(self):
        PaidLedger.objects.create(
            payout_month=date(2025, 3, 1), amount=9000, paper_title="P", staff_id="M2",
            raw_json=json.dumps({"Month": "2025-03-01 00:00:00", "Amount": "9000"}),
        )
        runs = [e for e in self.record(self.me) if e["kind"] == "PAYOUT"]
        self.assertEqual(len(runs), 1)
        self.assertEqual((runs[0]["starts_on"], runs[0]["amount"], runs[0]["count"]), ("2025-03-01", None, 1))
        self.assertNotIn("9000", json.dumps(runs))
        self.assertEqual([e for e in self.record(self.office) if e["kind"] == "PAYOUT"], [])

    def test_a_faculty_member_sees_department_colleagues_publications_with_a_face(self):
        Claim.objects.create(owner=self.mate, status=ClaimStatus.PAID, paper_title="Mate paper", publication_date="2025-03-10")
        Claim.objects.create(owner=self.mate, status=ClaimStatus.DRAFT, paper_title="Secret", publication_date="2025-03-11")
        Claim.objects.create(owner=self.far, status=ClaimStatus.PAID, paper_title="Far paper", publication_date="2025-03-12")
        col = [e for e in self.record(self.me) if e["kind"] == "COLLEAGUE"]
        self.assertEqual([e["title"] for e in col], ["Dr Mate published Mate paper"])
        self.assertEqual(col[0]["person"]["user_id"], self.mate.id)
        self.assertIn("photo_url", col[0]["person"])
        self.assertIsNone(col[0]["claim_id"])

    def test_scout_deadlines_come_from_the_readers_latest_finished_run(self):
        ScoutRun.objects.create(user=self.me, status=ScoutRun.Status.DONE, result_json=json.dumps({"opportunities": [
            {"title": "Special issue on EV", "deadline": "2025-03-20", "url": "https://x.org/si"},
            {"title": "No date", "deadline": ""},
            {"title": "Later", "deadline": "2025-06-01"},
        ]}))
        ScoutRun.objects.create(user=self.mate, status=ScoutRun.Status.DONE, result_json=json.dumps(
            {"opportunities": [{"title": "Not mine", "deadline": "2025-03-21"}]}))
        s = [e for e in self.record(self.me) if e["kind"] == "SCOUT"]
        self.assertEqual([(e["title"], e["starts_on"], e["url"]) for e in s],
                         [("Deadline: Special issue on EV", "2025-03-20", "https://x.org/si")])
