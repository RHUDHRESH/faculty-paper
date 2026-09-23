"""The thread assistant's web-search tool, which had never once worked.

`_answer_search` called `research_search.search(..., this_year=None)`. That
None reached `rank`, where the score is computed from
`this_year - (h.get("year") or this_year)` -- None minus an int. Every hit
raised TypeError, the caller's bare `except Exception` turned it into "I could
not reach the scholarly sources just now", and the tool reported a permanent
outage of sources that were in fact answering perfectly well.

It failed *whenever the search succeeded*. An empty result set was the one
case that did not crash, so the only way to see the bug was to find something.

Nothing caught it because nothing tested `_answer_search` at all. These do,
with the upstreams stubbed -- the point is the arithmetic and the handler, and
a test that needs Crossref to be up would be its own kind of unreliable.
"""
from __future__ import annotations

from unittest.mock import patch

from django.core.cache import cache
from django.test import TestCase
from django.utils import timezone

from core.services import research_search as rs
from core.services.thread_agent import _answer_search

#: `merge` pops a "source" off every hit, so a stub without one is not a
#: stand-in for what a real source function returns.
HITS = [
    {"title": "A graph network for molecules", "year": 2023, "cited_by": 184,
     "doi": "10.1038/s41467-023-38192-3", "venue": "Nature Communications",
     "source": "crossref"},
    {"title": "An older survey", "year": 2015, "cited_by": 541,
     "venue": "Some Journal", "source": "crossref"},
]


class RankYearTests(TestCase):
    """`rank` must answer for every way a caller can leave the year out."""

    def test_it_ranks_whether_the_year_is_given_omitted_or_none(self):
        for label, kwargs in (
            ("explicit", {"this_year": 2026}),
            ("none", {"this_year": None}),
            ("omitted", {}),
        ):
            with self.subTest(year=label):
                self.assertEqual(len(rs.rank([dict(h) for h in HITS], **kwargs)), 2)

    def test_a_hit_with_no_year_of_its_own_does_not_raise(self):
        """`h.get("year") or this_year` is None on both sides of the subtraction."""
        self.assertEqual(len(rs.rank([{"title": "No year", "cited_by": 3}], this_year=None)), 1)

    def test_the_default_year_is_today_rather_than_a_literal(self):
        """It was `this_year: int = 2026`. A literal silently prices last
        year's recency curve the moment the calendar turns."""
        import inspect

        self.assertIsNone(inspect.signature(rs.search).parameters["this_year"].default)


class ThreadSearchToolTests(TestCase):
    """The tool as the reader meets it."""

    def setUp(self):
        # `search` caches by query, and these tests reuse queries other tests
        # ask. A result left over from elsewhere means the stub is never
        # called and the test proves nothing about it.
        cache.clear()

    def _stub(self, hits):
        # Fresh dicts on every call, as a real source returns. `merge` pops
        # "source" off each hit it is handed, so a stub sharing the module's
        # HITS dicts left them without one after the first uncached search,
        # and the next test raised KeyError -- passing only when an earlier
        # test had happened to leave the same query in the cache.
        return patch.dict(
            rs.SOURCES, {"crossref": lambda q, limit: [dict(h) for h in hits]}, clear=True
        )

    def test_it_answers_with_what_it_found(self):
        with self._stub(HITS):
            out = _answer_search("graph networks for molecules")
        self.assertIn("graph network for molecules", out.lower())
        self.assertNotIn("could not reach", out.lower())

    def test_the_bug_this_file_exists_for(self):
        """Passing no year must not turn a working search into an outage."""
        with self._stub(HITS):
            out = _answer_search("anything at all")
        self.assertNotIn(
            "could not reach", out.lower(),
            "a successful search was reported to the reader as an unreachable source",
        )

    def test_an_upstream_that_is_genuinely_down_still_says_so_calmly(self):
        def boom(q, limit):
            raise RuntimeError("down")

        with patch.dict(rs.SOURCES, {"crossref": boom}, clear=True):
            out = _answer_search("something")
        # Sources failing individually is handled inside `search`, which
        # collects rather than raises -- so this is the empty-result path,
        # not the exception path, and must not claim an outage either.
        self.assertNotIn("nothing is wrong with the thread", out.lower())

    def test_a_real_failure_is_logged_rather_than_only_shown(self):
        """The handler stays -- a thread should not 500 -- but it must not be
        the only place a bug goes."""
        with patch.object(rs, "search", side_effect=RuntimeError("kaboom")):
            with self.assertLogs("core.services.thread_agent", level="ERROR") as caught:
                out = _answer_search("something")
        self.assertIn("could not reach", out.lower())
        self.assertTrue(any("kaboom" in r.getMessage() or r.exc_info for r in caught.records))


class SearchYearResolutionTests(TestCase):
    def setUp(self):
        cache.clear()  # see ThreadSearchToolTests.setUp

    def test_search_without_a_year_uses_this_one(self):
        with patch.dict(rs.SOURCES, {"crossref": lambda q, limit: [dict(h) for h in HITS]}, clear=True):
            with patch.object(rs, "rank", wraps=rs.rank) as ranked:
                rs.search("graph networks for molecules", limit=5)
        self.assertEqual(ranked.call_args.kwargs["this_year"], timezone.now().year)
