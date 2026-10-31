"""The data version behind the shared college figures is cheap, and still moves.

`aggregate_cache.shared()` builds its key from `data_version()`, and a home
screen reads a few shared figures, so the fingerprint used to run two to five
times per request -- ten sub-selects each, two of them scans of every
publication and authorship row. The answers below are what must stay true while
that gets cheaper:

* a change the job worker makes (a different process, so no signal reaches this
  one) moves the version, whatever table it lands in;
* inside one read request the version is worked out once;
* outside a request, and in a write request, nothing is remembered.
"""
from __future__ import annotations

from datetime import timedelta

from django.core.cache import cache
from django.db import connection
from django.http import HttpResponse
from django.test import Client, RequestFactory, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core.models import (
    Authorship, Claim, ClaimStatus, PaidLedger, Publication, Role, User,
)
from core.services import aggregate_cache, research_picture


def _version_queries(ctx) -> list[str]:
    return [q["sql"] for q in ctx.captured_queries if "FROM core_publication" in q["sql"] and "core_paidledger" in q["sql"]]


def _record_queries(ctx) -> list[str]:
    return [q["sql"] for q in ctx.captured_queries if "FROM core_publication" in q["sql"] and "core_authorship" in q["sql"]]


class _Base(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            email="sa@x.edu", password="p", name="Admin", role=Role.SUPER_ADMIN
        )
        self.fac = User.objects.create_user(
            email="f@x.edu", password=None, name="Dr Priya", role=Role.FACULTY, department="ECE"
        )
        self.pub = Publication.objects.create(title="Seed", year=2025, doi="10.1/seed")
        self.row = Authorship.objects.create(
            publication=self.pub, display_name="Priya", author_key="k0", is_college=True, position=1
        )


class TheVersionMovesWhateverTheWorkerChanges(_Base):
    """Each change below is made the way the job worker makes it: no signal reaches this process."""

    def assertMoves(self, change, what):
        before = aggregate_cache.data_version()
        change()
        self.assertNotEqual(aggregate_cache.data_version(), before, what)

    def test_a_harvested_paper(self):
        self.assertMoves(lambda: Publication.objects.create(title="New", year=2025), "new publication")

    def test_a_citation_refresh(self):
        # The refresh writes the count with `update()` and stamps the check time.
        later = timezone.now() + timedelta(hours=1)
        self.assertMoves(
            lambda: Publication.objects.filter(pk=self.pub.pk).update(citations=7, citations_refreshed_at=later),
            "citation refresh",
        )

    def test_a_second_refresh_of_the_same_paper(self):
        first = timezone.now()
        Publication.objects.filter(pk=self.pub.pk).update(citations=7, citations_refreshed_at=first)
        self.assertMoves(
            lambda: Publication.objects.filter(pk=self.pub.pk).update(
                citations=9, citations_refreshed_at=first + timedelta(days=7)
            ),
            "second citation refresh",
        )

    def test_a_new_author_row(self):
        self.assertMoves(
            lambda: Authorship.objects.create(publication=self.pub, display_name="Z", author_key="kz", position=2),
            "new authorship",
        )

    def _a_match_run(self):
        """What `rematch_authors`, the harvest and the Scopus sync do: link with
        `update()`, then recompute everybody's metrics."""
        from core.services import publications

        Authorship.objects.filter(pk=self.row.pk).update(user=self.fac, match_method="orcid")
        publications.refresh_metrics()

    def test_a_match_that_links_an_author_to_a_person(self):
        self.assertMoves(self._a_match_run, "authorship linked")

    def test_a_match_that_links_a_second_author_to_the_same_person(self):
        """The newest linked person does not change, nor the number of papers."""
        from core.services import publications

        other = Authorship.objects.create(publication=self.pub, display_name="P2", author_key="k2", position=2)
        Authorship.objects.filter(pk=self.row.pk).update(user=self.fac)
        publications.refresh_metrics()
        self.assertMoves(
            lambda: (Authorship.objects.filter(pk=other.pk).update(user=self.fac), publications.refresh_metrics()),
            "second authorship linked",
        )

    def test_a_removed_author_row(self):
        extra = Authorship.objects.create(publication=self.pub, display_name="Z", author_key="kz", position=2)
        self.assertMoves(lambda: Authorship.objects.filter(pk=extra.pk).delete(), "authorship removed")

    def test_an_imported_ledger_row(self):
        self.assertMoves(
            lambda: PaidLedger.objects.create(
                staff_id="S1", amount=1000.0, payout_month=timezone.localdate().replace(day=1), department="ECE"
            ),
            "ledger row",
        )

    def test_a_claim_that_changed(self):
        claim = Claim.objects.create(owner=self.fac, status=ClaimStatus.SUBMITTED, ticket_number="T-1", paper_title="P")
        later = timezone.now() + timedelta(hours=1)
        self.assertMoves(
            lambda: Claim.objects.filter(pk=claim.pk).update(status=ClaimStatus.PAID, updated_at=later),
            "claim changed",
        )

    def test_a_person_who_changed(self):
        later = timezone.now() + timedelta(hours=1)
        self.assertMoves(
            lambda: User.objects.filter(pk=self.fac.pk).update(department="Physics", updated_at=later),
            "person changed",
        )

    def test_an_unchanged_record_has_a_stable_version(self):
        self.assertEqual(aggregate_cache.data_version(), aggregate_cache.data_version())

    def test_a_worker_write_reaches_a_shared_figure_through_the_version(self):
        calls = []

        def compute():
            calls.append(1)
            return len(calls)

        self.assertEqual(aggregate_cache.shared("probe", {}, compute), 1)
        self.assertEqual(aggregate_cache.shared("probe", {}, compute), 1)  # kept
        gen = aggregate_cache.generation()
        self._a_match_run()
        cache.set("aggregates:generation", gen, None)  # nothing in this process saw the write
        self.assertEqual(aggregate_cache.shared("probe", {}, compute), 2)

    def test_the_college_picture_notices_the_same_changes(self):
        before = research_picture._signature()
        self._a_match_run()
        self.assertNotEqual(research_picture._signature(), before)
        mid = research_picture._signature()
        Publication.objects.filter(pk=self.pub.pk).update(
            citations=3, citations_refreshed_at=timezone.now() + timedelta(hours=1)
        )
        self.assertNotEqual(research_picture._signature(), mid)
        end = research_picture._signature()
        Publication.objects.create(title="Another", year=2025)
        self.assertNotEqual(research_picture._signature(), end)


class TheVersionIsCheap(_Base):
    def test_it_does_not_read_every_publication_row(self):
        with CaptureQueriesContext(connection) as ctx:
            aggregate_cache.data_version()
        (sql,) = _version_queries(ctx)
        self.assertNotIn("SUM(", sql.upper(), "summing citations reads every publication row")

    def test_it_is_one_query(self):
        with CaptureQueriesContext(connection) as ctx:
            aggregate_cache.data_version()
        self.assertEqual(len(ctx.captured_queries), 1)

    def test_the_college_picture_signature_is_one_query(self):
        with CaptureQueriesContext(connection) as ctx:
            research_picture._signature()
        self.assertEqual(len(ctx.captured_queries), 1)


class TheVersionIsWorkedOutOncePerReadRequest(_Base):
    def _through_the_middleware(self, method, view):
        request = getattr(RequestFactory(), method)("/x")
        with CaptureQueriesContext(connection) as ctx:
            aggregate_cache.BumpOnWriteMiddleware(view)(request)
        return ctx

    def test_two_reads_in_one_get_run_the_query_once(self):
        def view(request):
            first = aggregate_cache.data_version()
            assert aggregate_cache.data_version() == first
            return HttpResponse("ok")

        self.assertEqual(len(_version_queries(self._through_the_middleware("get", view))), 1)

    def test_the_picture_signature_is_remembered_the_same_way(self):
        def view(request):
            research_picture._signature()
            research_picture._signature()
            return HttpResponse("ok")

        self.assertEqual(len(_record_queries(self._through_the_middleware("get", view))), 1)

    def test_shared_figures_in_one_get_cost_one_version_query(self):
        def view(request):
            for name in ("a", "b", "c"):
                aggregate_cache.shared(name, {}, lambda: 1)
            return HttpResponse("ok")

        self.assertEqual(len(_version_queries(self._through_the_middleware("get", view))), 1)

    def test_a_write_in_the_request_makes_the_next_read_start_again(self):
        seen = []

        def view(request):
            seen.append(aggregate_cache.data_version())
            Publication.objects.create(title="Mid-request", year=2025)  # signal: the generation moves
            seen.append(aggregate_cache.data_version())
            return HttpResponse("ok")

        ctx = self._through_the_middleware("get", view)
        self.assertNotEqual(seen[0], seen[1])
        self.assertEqual(len(_version_queries(ctx)), 2)

    def test_nothing_is_kept_between_requests(self):
        def view(request):
            aggregate_cache.data_version()
            return HttpResponse("ok")

        first = self._through_the_middleware("get", view)
        Publication.objects.create(title="Between requests", year=2025)
        second = self._through_the_middleware("get", view)
        self.assertEqual((len(_version_queries(first)), len(_version_queries(second))), (1, 1))

    def test_outside_a_request_every_read_asks_the_database(self):
        with CaptureQueriesContext(connection) as ctx:
            aggregate_cache.data_version()
            aggregate_cache.data_version()
        self.assertEqual(len(_version_queries(ctx)), 2)

    def test_a_write_request_remembers_nothing(self):
        def view(request):
            aggregate_cache.data_version()
            aggregate_cache.data_version()
            return HttpResponse("ok")

        self.assertEqual(len(_version_queries(self._through_the_middleware("post", view))), 2)

    def test_the_memory_is_gone_when_the_request_fails(self):
        def view(request):
            aggregate_cache.data_version()
            raise RuntimeError("boom")

        with self.assertRaises(RuntimeError):
            self._through_the_middleware("get", view)
        with CaptureQueriesContext(connection) as ctx:
            aggregate_cache.data_version()
            aggregate_cache.data_version()
        self.assertEqual(len(_version_queries(ctx)), 2)

    def test_the_office_home_reads_the_version_once(self):
        """/api/admin/attention builds several shared figures; each used to run the fingerprint."""
        c = Client()
        c.force_login(self.admin)
        c.get("/api/admin/attention")  # warm what is kept outside the aggregate cache
        cache.clear()
        with CaptureQueriesContext(connection) as ctx:
            res = c.get("/api/admin/attention")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(_version_queries(ctx)), 1)
