"""What the home screens cost the server, which on the free plan is a tenth of a CPU.

Every figure here is a round trip to Postgres or Python work on that tenth of
a CPU, repeated on every visit to a home screen. The tests pin the cost of the
screens people open most, so it cannot creep back unnoticed.
"""
from __future__ import annotations

from datetime import date, timedelta

from django.core.cache import cache
from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.services import institution


def _queries(fn) -> int:
    with CaptureQueriesContext(connection) as ctx:
        fn()
    return len(ctx.captured_queries)


class InstitutionTests(TestCase):
    def test_the_three_strings_are_one_query(self):
        # Asked by every visit, signed in or not.
        self.assertEqual(_queries(institution.public), 1)

    def test_a_saved_name_still_wins_over_the_default(self):
        admin = User.objects.create_user(
            email="set@x.edu", password="p", name="Set", role=Role.SUPER_ADMIN
        )
        institution.set_values({"college_name": "Another College"}, admin)
        self.assertEqual(institution.public()["college_name"], "Another College")
        self.assertEqual(institution.public()["support_email"], "")


class FaultsCostTests(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            email="speed-admin@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN
        )
        self.client = Client()
        self.client.force_login(self.admin)

    def test_a_check_that_finds_little_asks_once_not_twice(self):
        # Fifteen checks; a sample and a count each was thirty-odd queries on
        # every visit to the office home, nearly all of them finding nothing.
        n = _queries(lambda: self.client.get("/api/admin/faults"))
        self.assertLessEqual(n, 20)

    def test_a_full_sample_still_counts_everything(self):
        fac = User.objects.create_user(
            email="stuck@x.edu", password="p", name="Stuck", role=Role.FACULTY,
            biometric_id="B", department="ECE", scopus_author_id="1",
        )
        old = timezone.now() - timedelta(days=40)
        for i in range(6):
            c = Claim.objects.create(
                owner=fac, status=ClaimStatus.SUBMITTED, ticket_number=f"S-{i}", paper_title="t"
            )
            Claim.objects.filter(pk=c.pk).update(updated_at=old)
        cache.clear()
        body = self.client.get("/api/admin/faults").json()
        found = {f["key"]: f for g in body["groups"] for f in g["faults"]}
        self.assertEqual(found["stale_submitted"]["count"], 6)
        self.assertEqual(len(found["stale_submitted"]["sample"]), 4)


class AggregateCacheTests(TestCase):
    """College-wide figures are the same for everyone allowed to see them, so
    the second person to open a home screen should not pay for them again --
    and nobody may be shown a figure a write has already changed."""

    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            email="agg-admin@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN
        )
        self.principal = User.objects.create_user(
            email="agg-pr@x.edu", password="p", name="Principal", role=Role.PRINCIPAL
        )
        self.a = Client()
        self.a.force_login(self.admin)
        self.p = Client()
        self.p.force_login(self.principal)

    def test_the_second_reader_is_served_from_the_cache(self):
        first = _queries(lambda: self.a.get("/api/admin/faults"))
        second = _queries(lambda: self.p.get("/api/admin/faults"))
        self.assertLess(second, first)
        # Only the session and the account are read the second time.
        self.assertLessEqual(second, 3)

    def test_reports_are_shared_the_same_way(self):
        first = _queries(lambda: self.a.get("/api/reports"))
        second = _queries(lambda: self.p.get("/api/reports"))
        self.assertLessEqual(second, 3)
        self.assertLess(second, first)

    def test_a_saved_row_is_never_hidden_behind_the_cache(self):
        self.assertEqual(self._no_biometric(), 0)
        User.objects.create_user(email="nobio@x.edu", password="p", name="N", role=Role.FACULTY)
        self.assertEqual(self._no_biometric(), 1)

    def test_a_bulk_update_is_seen_after_the_next_write_request(self):
        # `.update()` sends no signal, so the write request that made it is
        # what moves the cache on.
        fac = User.objects.create_user(
            email="u@x.edu", password="p", name="U", role=Role.FACULTY, biometric_id="B"
        )
        self.assertEqual(self._no_biometric(), 0)
        User.objects.filter(pk=fac.pk).update(biometric_id="")
        self.a.post("/api/notifications/read-all", content_type="application/json")
        self.assertEqual(self._no_biometric(), 1)

    def test_reports_do_not_mix_up_filters(self):
        owner = User.objects.create_user(
            email="o@x.edu", password="p", name="O", role=Role.FACULTY, department="ECE"
        )
        Claim.objects.create(
            owner=owner, status=ClaimStatus.SUBMITTED, paper_title="t", publication_year=2025
        )
        all_years = self.a.get("/api/reports").json()["totals"]["publications"]
        other = self.a.get("/api/reports?year=2019").json()["totals"]["publications"]
        self.assertEqual((all_years, other), (1, 0))

    def _no_biometric(self) -> int:
        body = self.a.get("/api/admin/faults").json()
        return {f["key"]: f for g in body["groups"] for f in g["faults"]}["no_biometric"]["count"]


class DashboardTests(TestCase):
    def test_a_home_that_shows_no_recent_list_does_not_pay_for_one(self):
        principal = User.objects.create_user(
            email="d-pr@x.edu", password="p", name="Pr", role=Role.PRINCIPAL
        )
        owner = User.objects.create_user(email="d-o@x.edu", password="p", name="O", role=Role.FACULTY)
        for i in range(3):
            Claim.objects.create(owner=owner, status=ClaimStatus.SUBMITTED, paper_title=f"t{i}")
        PaidLedger.objects.create(payout_month=date(2025, 1, 1), amount=100, paper_title="P")
        c = Client()
        c.force_login(principal)
        full = c.get("/api/dashboard").json()
        light = c.get("/api/dashboard?recent=0").json()
        self.assertEqual(len(full["recent"]), 3)
        self.assertEqual(light["recent"], [])
        self.assertEqual(light["by_status"], full["by_status"])
        self.assertEqual(light["ledger_total"], 100)
