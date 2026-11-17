"""Fixes from the 17 Nov 2026 red team that are about what the server says."""
from __future__ import annotations

from datetime import date

from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, Role, User


class ReportsDepartmentOrderTests(TestCase):
    def test_papers_with_no_department_are_listed_last_and_named_for_what_they_are(self):
        admin = User.objects.create_user(email="a@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN)
        ece = User.objects.create_user(email="e@x.edu", password="p", name="Ece Person", role=Role.FACULTY, department="ECE")
        nobody = User.objects.create_user(email="n@x.edu", password="p", name="No Dept", role=Role.FACULTY, department="")
        for i, owner in enumerate([nobody] * 3 + [ece]):
            Claim.objects.create(
                owner=owner, paper_title=f"Paper {i}", status=ClaimStatus.PAID, remuneration=1000,
                payout_month=date(2026, 6, 1), publication_year=2026, ticket_number=f"RT-{i}",
            )
        c = Client()
        c.force_login(admin)
        rows = c.get("/api/reports").json()["by_department"]
        from core.services import college_totals

        self.assertEqual(rows[-1]["key"], college_totals.NO_DEPARTMENT)
        self.assertEqual(rows[-1]["label"], "No department on the account (3)")
        self.assertEqual(rows[0]["key"], "ECE")


class TrackPaidMonthTests(TestCase):
    """Track, the Ledger and Finance read one definition of a payment month."""

    def setUp(self):
        from core.models import PaidLedger

        self.admin = User.objects.create_user(email="ta@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN)
        owner = User.objects.create_user(email="to@x.edu", password="p", name="Owner", role=Role.FACULTY, department="ECE")
        self.no_month = Claim.objects.create(
            owner=owner, paper_title="From the Processed sheet", status=ClaimStatus.PAID, remuneration=5000,
            payout_month=date(2026, 9, 1), ticket_number="ERP-PROCESSED-1",
        )
        PaidLedger.objects.create(
            claim=self.no_month, payout_month=date(2026, 9, 1), amount=5000, paper_title="x",
            raw_json='{"Faculty Name": "Owner"}',
        )
        self.with_month = Claim.objects.create(
            owner=owner, paper_title="From the history sheet", status=ClaimStatus.PAID, remuneration=6000,
            payout_month=date(2025, 3, 1), ticket_number="ERP-PAYMENTS-2",
        )
        PaidLedger.objects.create(
            claim=self.with_month, payout_month=date(2025, 3, 1), amount=6000, paper_title="y",
            raw_json='{"Month": "Mar 2025"}',
        )
        self.c = Client()
        self.c.force_login(self.admin)

    def test_track_does_not_print_the_imports_month_as_a_payment_month(self):
        rows = {r["ticket_number"]: r for r in self.c.get("/api/track?stage=paid").json()["results"]}
        self.assertIsNone(rows["ERP-PROCESSED-1"]["paid_on"])
        self.assertIs(rows["ERP-PROCESSED-1"]["paid_month_recorded"], False)
        self.assertEqual(rows["ERP-PAYMENTS-2"]["paid_on"], "2025-03-01")
        self.assertNotIn("paid_month_recorded", rows["ERP-PAYMENTS-2"])

    def test_the_ledger_says_the_same_about_the_same_payment(self):
        body = self.c.get("/api/admin/ledger").json()
        self.assertEqual(body["no_month"], {"amount": 5000, "count": 1})


class ImportsPaperCountTests(TestCase):
    def test_drafts_are_not_papers_claimed(self):
        admin = User.objects.create_user(email="ia@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN)
        owner = User.objects.create_user(email="io@x.edu", password="p", name="Owner", role=Role.FACULTY)
        for i, st in enumerate([ClaimStatus.DRAFT, ClaimStatus.DRAFT, ClaimStatus.PAID, ClaimStatus.REJECTED]):
            Claim.objects.create(owner=owner, paper_title=f"P{i}", status=st, ticket_number=f"IMP-{i}")
        c = Client()
        c.force_login(admin)
        body = c.get("/api/admin/erp-stats").json()
        self.assertEqual(body["claims"], 2)
        self.assertEqual(body["claim_drafts"], 2)
        self.assertEqual(body["claims_paid"], 1)


class SlowPagesDoNotQueryPerPerson(TestCase):
    """The red team's slow pages (record anomalies, roster names, the HOD's
    report, brief and department, collaborate, leaderboard) each cost one more
    round of queries for every person on the record. Each is asked for its
    queries with a few people and with many more; the count may not grow."""

    PAGES = (
        ("admin", "/api/admin/record/anomalies"),
        ("admin", "/api/admin/record/roster-names"),
        ("hod", "/api/hod/brief"),
        ("hod", "/api/hod/report"),
        ("hod", "/api/hod/department/records"),
        ("hod", "/api/hod/overview"),
        ("faculty", "/api/people/me/ego"),
        ("faculty", "/api/leaderboard"),
        ("admin", "/api/insights/suggestions"),
    )

    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        self.n = 0
        self.users = {
            "admin": User.objects.create_user(email="adm@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN),
            "hod": User.objects.create_user(
                email="hod@x.edu", password="p", name="Head Person", role=Role.HOD, department="ECE", staff_id="H0"
            ),
            "faculty": User.objects.create_user(
                email="fac@x.edu", password="p", name="Fac Person", role=Role.FACULTY, department="ECE", staff_id="F0"
            ),
        }

    def _people(self, count: int) -> None:
        from core.models import Authorship, PaidLedger, Publication

        for _ in range(count):
            self.n += 1
            u = User.objects.create_user(
                email=f"p{self.n}@x.edu", password="p", name=f"Person Number{self.n}", role=Role.FACULTY,
                department="ECE", staff_id=f"S{self.n}",
            )
            pub = Publication.objects.create(
                title=f"Paper about topic {self.n}", normalized_title=f"paper about topic {self.n}",
                year=2025, date=date(2025, 3, 1), venue="Journal of Things", quartile="Q2",
            )
            for who in (u, self.users["faculty"], self.users["hod"]):
                Authorship.objects.create(
                    publication=pub, user=who, position=1, display_name=who.name,
                    author_key=f"u:{who.id}:{self.n}", is_college=True,
                )
            Claim.objects.create(
                owner=u, paper_title=f"Paper about topic {self.n}", status=ClaimStatus.PAID, remuneration=1000,
                payout_month=date(2025, 4, 1), publication_year=2025, ticket_number=f"QC-{self.n}",
            )
            PaidLedger.objects.create(
                staff_id=u.staff_id, faculty_name=u.name, department="ECE", amount=1000,
                payout_month=date(2025, 4, 1), paper_title=f"Ledger paper {self.n}",
            )

    def _queries(self, who: str, path: str) -> int:
        from django.core.cache import cache
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        cache.clear()
        c = Client()
        c.force_login(self.users[who])
        with CaptureQueriesContext(connection) as ctx:
            r = c.get(path)
        self.assertEqual(r.status_code, 200, (path, r.content[:200]))
        return len(ctx)

    def test_queries_do_not_grow_with_the_number_of_people(self):
        self._people(3)
        few = {p: self._queries(w, p) for w, p in self.PAGES}
        self._people(15)
        many = {p: self._queries(w, p) for w, p in self.PAGES}
        for _w, path in self.PAGES:
            self.assertLessEqual(many[path], few[path] + 3, f"{path}: {few[path]} queries for 3 people, {many[path]} for 18")


class PublicationDateFlagsTests(TestCase):
    def test_data_health_flags_a_date_after_filing_or_in_the_future_and_changes_nothing(self):
        from datetime import timedelta

        from django.utils import timezone

        from core.services import integrity

        owner = User.objects.create_user(email="pd@x.edu", password="p", name="Owner", role=Role.FACULTY)
        today = timezone.localdate()
        future = Claim.objects.create(
            owner=owner, paper_title="From next year", status=ClaimStatus.SUBMITTED,
            publication_date=(today + timedelta(days=400)).isoformat(), ticket_number="PD-1", submitted_at=timezone.now(),
        )
        after = Claim.objects.create(
            owner=owner, paper_title="After filing", status=ClaimStatus.SUBMITTED,
            publication_date=(today + timedelta(days=10)).isoformat(), ticket_number="PD-2",
            submitted_at=timezone.now() - timedelta(days=60),
        )
        fine = Claim.objects.create(
            owner=owner, paper_title="Fine", status=ClaimStatus.SUBMITTED,
            publication_date=(today - timedelta(days=90)).isoformat(), ticket_number="PD-3",
            submitted_at=timezone.now() - timedelta(days=30),
        )
        found = integrity.check_publication_dates()
        self.assertEqual(found.count, 2)
        labels = " ".join(r["label"] for r in found.rows)
        self.assertIn("PD-1", labels)
        self.assertIn("PD-2", labels)
        self.assertNotIn("PD-3", labels)
        future.refresh_from_db()
        self.assertEqual(future.publication_date, (today + timedelta(days=400)).isoformat())
        self.assertIn("claim_publication_date", [f["key"] for f in integrity.run_audit()["findings"]])
        del after, fine


class RupeesTests(TestCase):
    def test_whole_rupees_unless_the_paise_are_real(self):
        from core.services.rupees import rupees

        self.assertEqual(rupees(5000), "₹5,000")
        self.assertEqual(rupees(5000.0), "₹5,000")
        self.assertEqual(rupees(109265), "₹1,09,265")
        self.assertEqual(rupees(26557834.73), "₹2,65,57,834.73")
        self.assertEqual(rupees(0.5), "₹0.50")
        self.assertEqual(rupees(None), "Not recorded")


class EllipsisTests(TestCase):
    def test_a_long_title_is_cut_at_a_word_and_marked(self):
        from core.services.ellipsis import ellipsize

        title = "Design and analysis of a low-power high-speed comparator for successive approximation converters"
        out = ellipsize(title, 40)
        self.assertTrue(out.endswith("…"))
        self.assertLessEqual(len(out), 40)
        self.assertTrue(title.startswith(out[:-1]))
        self.assertEqual(title[len(out) - 1], " ")  # cut between words, never inside one
        self.assertEqual(ellipsize("Short", 40), "Short")
        self.assertEqual(ellipsize(None, 40), "")
