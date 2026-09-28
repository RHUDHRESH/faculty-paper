"""Costs found by timing every GET on the full record (17k papers, 3k ledger rows).

See docs/jtbd/real-data-speed.md. Each test pins a query count that must not
grow with the data, or proves a cached figure is rebuilt after a write.
"""
from __future__ import annotations

from django.core.cache import cache
from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext

from core.models import (
    Authorship, Claim, ClaimStatus, JournalWatch, Publication, Role, User,
)


def _queries(fn) -> int:
    with CaptureQueriesContext(connection) as ctx:
        fn()
    return len(ctx.captured_queries)


class _Base(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            email="sa@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN
        )
        self.fac = User.objects.create_user(
            email="f@x.edu", password=None, name="Dr Priya", role=Role.FACULTY, department="ECE"
        )
        self.c = Client()
        self.c.force_login(self.admin)
        self.n = 0

    def claims(self, count: int) -> None:
        for _ in range(count):
            self.n += 1
            Claim.objects.create(
                owner=self.fac, status=ClaimStatus.SUBMITTED, ticket_number=f"T-{self.n}",
                paper_title=f"Paper {self.n}", journal_title="J", issn="1234-5678",
                publication_year=2025,
            )

    def papers(self, count: int) -> None:
        for _ in range(count):
            self.n += 1
            p = Publication.objects.create(title=f"Record {self.n}", year=2025, doi=f"10.1/{self.n}")
            Authorship.objects.create(publication=p, display_name="Priya", author_key=f"k{self.n}",
                                      is_college=True, user=self.fac, position=1)
            Authorship.objects.create(publication=p, display_name="Unmatched " + "".join(chr(97 + int(d)) for d in str(self.n)) + "son",
                                      author_key=f"u{self.n}", is_college=True, position=2)


class ClaimListWatchTests(_Base):
    """The journal watch-list was read once per claim row: 95 of 101 queries."""

    def setUp(self):
        super().setUp()
        JournalWatch.objects.create(issn="1234-5678", title="J", reason="predatory")

    def test_claim_lists_do_not_grow_with_rows(self):
        # Warm what is kept outside the aggregate cache (session, formula).
        self.c.get("/api/claims")
        self.c.get("/api/reports/search")
        for path in ("/api/claims", "/api/reports/search"):
            self.claims(3)
            cache.clear()
            small = _queries(lambda: self.c.get(path))
            self.claims(12)
            cache.clear()
            big = _queries(lambda: self.c.get(path))
            # Nine more rows; a per-row read would add nine. The formula
            # threshold has its own clock and may add one either way.
            self.assertLessEqual(abs(big - small), 1, path)
            self.assertLessEqual(big, 10, path)

    def test_the_watch_hit_is_still_reported(self):
        self.claims(1)
        rows = self.c.get("/api/claims").json()
        items = rows["items"] if isinstance(rows, dict) and "items" in rows else rows.get("results", rows)
        self.assertTrue(any((r.get("journal_watch") or {}).get("reason") == "predatory" for r in items))

    def test_a_new_watch_entry_is_seen_at_once(self):
        from core.services.journal_watch import watch_for

        self.assertIsNone(watch_for("1111-2222", None))
        JournalWatch.objects.create(issn="1111-2222", title="K", reason="cloned")
        self.assertEqual(watch_for("1111-2222", None)["reason"], "cloned")


class PackRowsTests(_Base):
    """Five thousand full Publication and User objects per page: 2-3 s."""

    def test_pack_rows_queries_do_not_grow_with_the_record(self):
        self.papers(2)
        cache.clear()
        small = _queries(lambda: self.c.get("/api/reports/pack/rows"))
        self.papers(10)
        cache.clear()
        big = _queries(lambda: self.c.get("/api/reports/pack/rows"))
        self.assertEqual(small, big)
        self.assertLessEqual(big, 10)

    def test_a_new_record_paper_shows_on_the_next_read(self):
        self.papers(1)
        first = self.c.get("/api/reports/pack/rows").json()["total"]
        self.papers(1)
        self.assertEqual(self.c.get("/api/reports/pack/rows").json()["total"], first + 1)


class CachedAggregateTests(_Base):
    """Author-name groups and the college's paper records, kept per generation."""

    def test_author_groups_are_read_once_then_rebuilt_on_write(self):
        from core.services import author_review

        self.papers(3)
        first = author_review.unmatched_groups()
        self.assertEqual(first["total"], 3)
        # Second read: aliases and people only, not every authorship again.
        with CaptureQueriesContext(connection) as ctx:
            author_review.unmatched_groups()
        self.assertFalse(any("display_name" in q["sql"] for q in ctx.captured_queries))
        self.papers(1)
        self.assertEqual(author_review.unmatched_groups()["total"], 4)

    def test_college_records_are_rebuilt_after_a_claim_is_paid(self):
        from core.services.records import collect

        before = len(collect(include_unmatched=True))
        # One query: the data version, not the claims and ledger again.
        self.assertEqual(_queries(lambda: collect(include_unmatched=True)), 1)
        Claim.objects.create(
            owner=self.fac, status=ClaimStatus.PAID, ticket_number="T-P",
            paper_title="Newly paid paper", publication_year=2025,
        )
        self.assertEqual(len(collect(include_unmatched=True)), before + 1)

    def test_a_write_from_another_process_is_seen(self):
        # The job worker writes without moving this process's generation;
        # the data version in the key is what notices it.
        from core.services import college_totals

        self.papers(2)
        self.assertEqual(len(college_totals.papers()), 2)
        from core.services import aggregate_cache

        gen = aggregate_cache.generation()
        p = Publication.objects.create(title="Worker paper", year=2025)
        Authorship.objects.create(publication=p, display_name="Priya", author_key="kw",
                                  is_college=True, user=self.fac, position=1)
        # Undo the in-process bump so only the data version can tell.
        cache.set("aggregates:generation", gen, None)
        self.assertEqual(len(college_totals.papers()), 3)

    def test_filters_share_one_computation(self):
        from core.services import college_totals

        self.papers(2)
        college_totals.papers()
        with CaptureQueriesContext(connection) as ctx:
            self.assertEqual(len(college_totals.papers(year=2025, department="ECE")), 2)
            self.assertEqual(college_totals.papers(year=1999), [])
        self.assertFalse(any("core_authorship" in q["sql"] and "JOIN" in q["sql"] for q in ctx.captured_queries))

    def test_reports_build_second_read_is_cheap(self):
        self.papers(3)
        self.c.get("/api/reports/build")
        self.assertLessEqual(_queries(lambda: self.c.get("/api/reports/build")), 6)
