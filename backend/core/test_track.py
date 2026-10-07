"""Track: one view of every claim's journey, and who may see what on it.

The rules pinned here are the college's, not the screen's:

- every office seat sees the whole college and the amounts;
- flags reach the desks that judge a paper and nobody else -- the Director
  and Finance get no flag key at all, and no duplicate marker;
- a head sees their own department and not one rupee, and never learns which
  desk holds a paper or that it is on hold;
- a faculty member is sent to My papers.
"""
from __future__ import annotations

import json
from datetime import timedelta

from django.core.cache import cache
from django.test import Client, TestCase
from django.utils import timezone

from core.hod import MONEY_KEYS
from core.models import Claim, ClaimFlag, ClaimStatus, FormulaConfig, Role, User
from core.services.remuneration import DEFAULT_AUTHOR_POINTS

FIGURE = 61234.0  # a distinctive rupee amount that appears nowhere else
OTHER_DEPT_FIGURE = 88777.0


def _person(email, name, role, **extra):
    return User.objects.create_user(email=email, password=None, name=name, role=role, **extra)


def _walk_keys(value):
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(value, list):
        for v in value:
            yield from _walk_keys(v)


class TrackBase(TestCase):
    @classmethod
    def setUpTestData(cls):
        FormulaConfig.objects.create(author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True)
        cls.admin = _person("tr-admin@test.edu", "Track Admin", Role.SUPER_ADMIN)
        cls.cell = _person("tr-cell@test.edu", "Track Cell", Role.RESEARCH_CELL, department="CSE")
        cls.coord = _person("tr-coord@test.edu", "Track Coordinator", Role.RESEARCH_COORDINATOR)
        cls.principal = _person("tr-prin@test.edu", "Track Principal", Role.PRINCIPAL)
        cls.director = _person("tr-dir@test.edu", "Track Director", Role.DIRECTOR)
        cls.finance = _person("tr-fin@test.edu", "Track Finance", Role.FINANCE)
        cls.head = _person("tr-head@test.edu", "Track Head", Role.HOD, department="CSE")
        cls.faculty = _person("tr-fac@test.edu", "Track Faculty", Role.FACULTY, department="CSE")
        cls.other = _person("tr-oth@test.edu", "Other Dept Person", Role.FACULTY, department="MECH")

        now = timezone.now()

        def claim(owner, status, n, **kw):
            return Claim.objects.create(
                owner=owner, status=status, paper_title=f"Paper {n}", journal_title="J",
                ticket_number=f"FP-2026-0009{n:02d}", publication_year=2026,
                remuneration=kw.pop("remuneration", FIGURE), submitted_at=kw.pop("submitted_at", now - timedelta(days=20)),
                **kw,
            )

        cls.submitted = claim(cls.faculty, ClaimStatus.SUBMITTED, 1, submitted_at=now - timedelta(days=40))
        cls.checked = claim(cls.faculty, ClaimStatus.CLEARED, 2, cleared_at=now - timedelta(days=9))
        cls.approved = claim(cls.faculty, ClaimStatus.PRINCIPAL_APPROVED, 3, principal_approved_at=now - timedelta(days=3))
        cls.authorised = claim(cls.faculty, ClaimStatus.DIRECTOR_APPROVED, 4, director_approved_at=now - timedelta(days=1))
        cls.paid = claim(cls.faculty, ClaimStatus.PAID, 5, paid_at=now - timedelta(days=2))
        cls.sent_back = claim(cls.faculty, ClaimStatus.REJECTED, 6)
        cls.refused = claim(cls.faculty, ClaimStatus.REJECTED, 7, rejected_outright=True)
        cls.held = claim(cls.faculty, ClaimStatus.SUBMITTED, 8, on_hold=True, held_at=now - timedelta(days=5),
                         hold_reason="Waiting for the file")
        cls.elsewhere = claim(cls.other, ClaimStatus.SUBMITTED, 9, remuneration=OTHER_DEPT_FIGURE)
        cls.own = claim(cls.head, ClaimStatus.SUBMITTED, 10)
        cls.draft = Claim.objects.create(owner=cls.faculty, status=ClaimStatus.DRAFT, paper_title="Unfiled draft")
        ClaimFlag.objects.create(claim=cls.submitted, kind="OTHER", note="Byline looks odd", raised_by=cls.admin)
        Claim.objects.filter(pk=cls.checked.pk).update(duplicate_warning=True)

    def setUp(self):
        cache.clear()
        self.client = Client()

    def get(self, user, query=""):
        self.client.force_login(user)
        return self.client.get(f"/api/track{query}")

    def board(self, body):
        return {s["key"]: s for s in body["stages"]}


class WhoMayOpenTrack(TrackBase):
    def test_every_office_seat_and_the_head_may_open_it(self):
        for user in (self.admin, self.cell, self.coord, self.principal, self.director, self.finance, self.head):
            self.assertEqual(self.get(user).status_code, 200, user.role)

    def test_a_faculty_member_is_sent_to_their_own_papers(self):
        r = self.get(self.faculty)
        self.assertEqual(r.status_code, 403)
        self.assertIn("My papers", r.json()["detail"])

    def test_signed_out_is_refused(self):
        self.assertIn(Client().get("/api/track").status_code, (401, 403))


class TheBoard(TrackBase):
    def test_each_claim_lands_in_exactly_one_stage_and_drafts_in_none(self):
        body = self.get(self.admin).json()
        b = self.board(body)
        self.assertEqual(
            {k: v["count"] for k, v in b.items()},
            {"submitted": 3, "checked": 1, "approved": 1, "authorised": 1, "paid": 1,
             "sent_back": 1, "on_hold": 1, "not_accepted": 1, "closed_old": 0},
        )
        self.assertEqual(sum(v["count"] for v in b.values()), body["total_claims"])
        self.assertEqual(body["total_claims"], 10)

    def test_money_is_totalled_per_stage_for_the_seats_that_see_money(self):
        b = self.board(self.get(self.finance).json())
        self.assertEqual(b["paid"]["amount"], FIGURE)
        self.assertEqual(b["submitted"]["amount"], FIGURE * 2 + OTHER_DEPT_FIGURE)

    def test_days_are_counted_from_the_stage_not_from_filing(self):
        b = self.board(self.get(self.admin).json())
        self.assertEqual(b["checked"]["oldest_days"], 9)
        self.assertEqual(b["approved"]["oldest_days"], 3)
        self.assertEqual(b["submitted"]["oldest_days"], 40)
        self.assertEqual(b["on_hold"]["oldest_days"], 5)

    def test_ageing_buckets_split_the_waiting_claims(self):
        ageing = self.board(self.get(self.admin).json())["submitted"]["ageing"]
        self.assertEqual(sum(ageing.values()), 3)
        self.assertEqual(ageing["older"], 1)  # 40 days
        self.assertEqual(ageing["month"], 2)  # the two at 20 days

    def test_a_finished_stage_carries_no_ageing(self):
        b = self.board(self.get(self.admin).json())
        self.assertIsNone(b["paid"]["ageing"])
        self.assertIsNone(b["not_accepted"]["ageing"])


class TheList(TrackBase):
    def ids(self, body):
        return [r["id"] for r in body["results"]]

    def test_the_list_is_longest_waiting_first_by_default(self):
        days = [r["days_in_stage"] for r in self.get(self.admin, "?stage=submitted").json()["results"]]
        self.assertEqual(days, sorted(days, reverse=True))
        self.assertEqual(days[0], 40)

    def test_choosing_a_stage_filters_the_list_but_not_the_board(self):
        body = self.get(self.admin, "?stage=checked").json()
        self.assertEqual(self.ids(body), [self.checked.id])
        self.assertEqual(self.board(body)["paid"]["count"], 1)

    def test_moving_leaves_out_finished_and_sent_back_claims_but_keeps_the_board(self):
        body = self.get(self.admin, "?moving=1&limit=100").json()
        stages = {r["stage"] for r in body["results"]}
        self.assertEqual(stages, {"submitted", "checked", "approved", "authorised", "on_hold"})
        self.assertEqual(self.board(body)["paid"]["count"], 1)
        # Oldest first, so a home page can show what has waited longest.
        self.assertEqual(body["results"][0]["days_in_stage"], 40)

    def test_exclude_drops_stages_from_the_list_only(self):
        body = self.get(self.admin, "?moving=1&exclude=submitted,on_hold&limit=100").json()
        self.assertEqual({r["stage"] for r in body["results"]}, {"checked", "approved", "authorised"})
        self.assertEqual(self.board(body)["submitted"]["count"], 3)

    def test_search_by_claim_number_claimant_and_title(self):
        for term, expect in (("FP-2026-000903", self.approved), ("Other Dept", self.elsewhere), ("Paper 5", self.paid)):
            self.assertEqual(self.ids(self.get(self.admin, f"?q={term.replace(' ', '%20')}").json()), [expect.id], term)

    def test_department_filter(self):
        body = self.get(self.admin, "?department=MECH").json()
        self.assertEqual(self.ids(body), [self.elsewhere.id])
        self.assertEqual(body["total_claims"], 1)
        self.assertEqual(sorted(body["departments"]), ["CSE", "MECH"])

    def test_month_filter_and_bad_month(self):
        # The claims here were filed 20 and 40 days ago, so "this month" is
        # only among them mid-month; ask for the months they were filed in.
        filed = (timezone.now() - timedelta(days=20)).strftime("%Y-%m")
        body = self.get(self.admin).json()
        self.assertIn(filed, body["months"])
        self.assertEqual(self.get(self.admin, "?month=1999-01").json()["total_claims"], 0)
        self.assertEqual(self.get(self.admin, "?month=nonsense").status_code, 400)

    def test_paging(self):
        body = self.get(self.admin, "?limit=3&offset=0").json()
        self.assertEqual(len(body["results"]), 3)
        self.assertEqual(body["total"], 10)
        rest = self.get(self.admin, "?limit=3&offset=9").json()
        self.assertEqual(len(rest["results"]), 1)

    def test_a_row_carries_what_the_screen_needs_and_marks_the_viewers_own(self):
        rows = {r["id"]: r for r in self.get(self.cell, "?limit=100").json()["results"]}
        row = rows[self.paid.id]
        self.assertEqual(row["ticket_number"], "FP-2026-000905")
        self.assertEqual(row["owner_name"], "Track Faculty")
        self.assertEqual(row["stage_label"], "Paid")
        self.assertEqual(row["amount"], FIGURE)
        self.assertIn("owner_photo_url", row)  # the face travels with the claimant
        self.assertFalse(row["is_mine"])


class FlagsOnlyForTheDesksThatJudge(TrackBase):
    def test_reviewers_see_flags_and_duplicates(self):
        for user in (self.admin, self.cell, self.coord, self.principal):
            body = self.get(user, "?limit=100").json()
            self.assertTrue(body["sees_flags"], user.role)
            rows = {r["id"]: r for r in body["results"]}
            self.assertEqual(rows[self.submitted.id]["open_flags"], 1, user.role)
            self.assertTrue(rows[self.checked.id]["duplicate"], user.role)
            self.assertEqual(self.board(body)["submitted"]["flagged"], 1, user.role)

    def test_the_director_and_finance_get_no_flag_or_duplicate_key_anywhere(self):
        for user in (self.director, self.finance):
            body = self.get(user, "?limit=100").json()
            self.assertFalse(body["sees_flags"], user.role)
            keys = set(_walk_keys(body))
            for banned in ("open_flags", "flagged", "duplicate", "duplicate_warning", "flags", "file_checks"):
                self.assertNotIn(banned, keys, f"{user.role} was shown {banned}")

    def test_a_head_gets_none_either(self):
        keys = set(_walk_keys(self.get(self.head, "?limit=100").json()))
        for banned in ("open_flags", "flagged", "duplicate"):
            self.assertNotIn(banned, keys)


class TheHeadSeesOnlyTheirDepartmentAndNoMoney(TrackBase):
    def test_only_the_heads_department(self):
        body = self.get(self.head, "?limit=100").json()
        self.assertEqual(body["scope"], "department")
        self.assertEqual(body["department"], "CSE")
        self.assertNotIn(self.elsewhere.id, [r["id"] for r in body["results"]])
        self.assertEqual(body["total_claims"], 9)  # every CSE claim but the draft

    def test_asking_for_another_department_changes_nothing(self):
        body = self.get(self.head, "?department=MECH&limit=100").json()
        self.assertNotIn(self.elsewhere.id, [r["id"] for r in body["results"]])
        self.assertEqual(body["departments"], [])

    def test_no_rupee_reaches_a_head_by_key_or_by_value(self):
        raw = self.get(self.head, "?limit=100").content.decode()
        body = json.loads(raw)
        keys = set(_walk_keys(body))
        self.assertFalse(keys & set(MONEY_KEYS), keys & set(MONEY_KEYS))
        self.assertFalse(body["sees_money"])
        for spelling in ("61234", "88777"):
            self.assertNotIn(spelling, raw)

    def test_a_head_learns_neither_the_desk_nor_the_hold_nor_the_payment(self):
        body = self.get(self.head, "?limit=100").json()
        self.assertEqual([s["key"] for s in body["stages"]], ["review", "approved", "completed", "sent_back", "closed_old"])
        labels = {r["stage_label"] for r in body["results"]}
        self.assertLessEqual(labels, {"Under review", "Approved", "Completed", "Sent back", "Closed (old system)"})
        self.assertNotIn("On hold", labels)
        self.assertNotIn("Paid", json.dumps(body))
        self.assertNotIn("Waiting for the file", json.dumps(body))

    def test_a_heads_days_run_from_filing(self):
        rows = {r["id"]: r for r in self.get(self.head, "?limit=100").json()["results"]}
        # Cleared nine days ago, filed twenty: a head is told twenty.
        self.assertEqual(rows[self.checked.id]["days_in_stage"], 20)

    def test_a_head_with_no_department_is_told_so(self):
        nobody = _person("tr-head2@test.edu", "Headless", Role.HOD)
        r = self.get(nobody)
        self.assertEqual(r.status_code, 400)


class TheOfficersOwnClaims(TrackBase):
    def test_an_officers_own_claim_is_marked_and_stays_a_row_not_a_claimant_view(self):
        Claim.objects.create(owner=self.principal, status=ClaimStatus.SUBMITTED, paper_title="Principal's",
                             ticket_number="FP-2026-000950", submitted_at=timezone.now(), remuneration=FIGURE)
        rows = self.get(self.principal, "?q=Principal%27s").json()["results"]
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["is_mine"])
        # The claimant rules would have stripped the stage; this is a tracking row.
        self.assertEqual(rows[0]["stage"], "submitted")


class ClaimsClosedInTheOldSystem(TrackBase):
    """`close_erp_imported` closes ERP claims the old system handled. They were
    neither refused nor are they waiting, so Track must not call them "Not
    accepted": the claimant already reads "Closed (old system)", and so must
    every desk."""

    def setUp(self):
        super().setUp()
        import io

        from django.core.management import call_command

        self.erp = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.SUBMITTED, paper_title="An old ERP paper", journal_title="J",
            ticket_number="ERP-RAW-77", publication_year=2024, submitted_at=timezone.now() - timedelta(days=200),
        )
        call_command("close_erp_imported", "--apply", stdout=io.StringIO())

    def test_it_reads_closed_old_system_and_is_counted_apart_from_refusals(self):
        body = self.get(self.admin, "?limit=100").json()
        row = next(r for r in body["results"] if r["id"] == self.erp.id)
        self.assertEqual((row["stage"], row["stage_label"]), ("closed_old", "Closed (old system)"))
        self.assertNotEqual(row["amount_note"], "Not priced yet")
        b = self.board(body)
        self.assertEqual(b["closed_old"]["count"], 1)
        self.assertEqual(b["closed_old"]["label"], "Closed (old system)")
        self.assertIsNone(b["closed_old"]["ageing"])
        self.assertEqual(b["not_accepted"]["count"], 1)  # the real refusal, and only it

    def test_it_is_not_moving(self):
        body = self.get(self.admin, "?moving=1&limit=100").json()
        self.assertNotIn(self.erp.id, [r["id"] for r in body["results"]])

    def test_a_head_reads_the_same_words(self):
        rows = {r["id"]: r for r in self.get(self.head, "?limit=100").json()["results"]}
        self.assertEqual(rows[self.erp.id]["stage_label"], "Closed (old system)")


class TheAdminHub(TrackBase):
    def test_the_office_gets_counts_and_others_are_refused(self):
        for user in (self.admin, self.cell, self.coord):
            self.assertEqual(self.client_get(user).status_code, 200, user.role)
        for user in (self.principal, self.director, self.finance, self.head, self.faculty):
            self.assertEqual(self.client_get(user).status_code, 403, user.role)

    def client_get(self, user):
        self.client.force_login(user)
        return self.client.get("/api/admin/hub")

    def test_the_job_queue_and_data_health_are_the_super_admins_alone(self):
        admin = self.client_get(self.admin).json()["counts"]
        cell = self.client_get(self.cell).json()["counts"]
        for route in ("/jobs", "/data/health"):
            self.assertIn(route, admin)
            self.assertNotIn(route, cell)
        for route in ("/requests", "/people/matches", "/duplicates", "/faults", "/policy", "/audit", "/people"):
            self.assertIn(route, cell)
