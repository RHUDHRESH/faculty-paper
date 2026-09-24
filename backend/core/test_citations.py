"""Someone cited you: the daily citation check against OpenAlex.

OpenAlex is mocked at `upstream.get_json`, the one function that leaves the
machine, so these tests exercise the batching, the filter syntax and the
bookkeeping exactly as production runs them.

What is pinned:

- DOIs are asked for in batches of at most 50 with `filter=doi:a|b|c`;
- a day's run asks for at most CITATION_DOIS_PER_RUN DOIs, oldest-checked
  first, so a long list is covered over several days;
- the first count for a paper is a baseline and tells nobody -- otherwise the
  first run would announce every citation a paper ever had;
- a rise tells every owner of a claim on that DOI, with the new total;
- a fall, an unknown DOI and an OpenAlex outage tell nobody and lose nothing.
"""
from __future__ import annotations

from unittest.mock import patch

from django.test import TestCase, override_settings

from core.models import CitationCount, CitationHistory, Claim, ClaimStatus, Notification, Role, User
from core.services import citations


def _person(email, name):
    return User.objects.create_user(email=email, password=None, name=name, role=Role.FACULTY)


class FakeOpenAlex:
    """Answers `upstream.get_json` from a table of DOI -> cited_by_count."""

    def __init__(self, counts):
        self.counts = counts
        self.calls = []

    def __call__(self, url, params=None, **kwargs):
        self.calls.append(params)
        wanted = params["filter"].removeprefix("doi:").split("|")
        return {
            "results": [
                {"id": f"https://openalex.org/W{i}", "doi": f"https://doi.org/{d}",
                 "cited_by_count": self.counts[d]}
                for i, d in enumerate(wanted)
                if d in self.counts
            ]
        }


class CitationCheckTests(TestCase):
    def setUp(self):
        self.asha = _person("asha@test.edu", "Asha")
        self.ravi = _person("ravi@test.edu", "Ravi")

    def _claim(self, owner, doi, title="A Paper on Heat Exchangers", status=ClaimStatus.PAID):
        return Claim.objects.create(owner=owner, doi=doi, paper_title=title, status=status)

    def _run(self, counts, **kw):
        fake = FakeOpenAlex(counts)
        with patch("core.services.citations.upstream.get_json", side_effect=fake):
            summary = citations.check_citations(pause=0, **kw)
        return fake, summary

    def test_the_first_count_is_a_baseline_and_tells_nobody(self):
        self._claim(self.asha, "10.1000/abc")
        _, summary = self._run({"10.1000/abc": 12})
        row = CitationCount.objects.get(doi="10.1000/abc")
        self.assertEqual(row.count, 12)
        self.assertIsNotNone(row.checked_at)
        self.assertEqual(CitationHistory.objects.filter(citation=row).count(), 1)
        self.assertFalse(Notification.objects.exists())
        self.assertEqual(summary["baselines"], 1)

    def test_a_rise_tells_every_owner_the_gain_and_the_total(self):
        self._claim(self.asha, "https://doi.org/10.1000/ABC", title="Heat Exchangers Revisited")
        self._claim(self.ravi, "10.1000/abc", title="Heat Exchangers Revisited")
        self._run({"10.1000/abc": 12})
        _, summary = self._run({"10.1000/abc": 14})
        notes = Notification.objects.filter(kind="citation").order_by("user__email")
        self.assertEqual([n.user for n in notes], [self.asha, self.ravi])
        self.assertEqual(
            notes[0].title, "Your paper “Heat Exchangers Revisited” gained 2 citations — 14 now"
        )
        self.assertEqual(summary["notified"], 2)
        self.assertEqual(
            list(CitationHistory.objects.values_list("count", flat=True)), [12, 14]
        )

    def test_one_new_citation_reads_in_the_singular(self):
        self._claim(self.asha, "10.1000/one")
        self._run({"10.1000/one": 3})
        self._run({"10.1000/one": 4})
        self.assertIn("gained 1 citation — 4 now", Notification.objects.get().title)

    def test_a_fall_or_no_change_tells_nobody(self):
        self._claim(self.asha, "10.1000/abc")
        self._run({"10.1000/abc": 12})
        self._run({"10.1000/abc": 12})
        self._run({"10.1000/abc": 11})
        self.assertFalse(Notification.objects.exists())
        self.assertEqual(CitationCount.objects.get().count, 11)

    def test_drafts_and_returned_papers_are_not_checked(self):
        self._claim(self.asha, "10.1000/draft", status=ClaimStatus.DRAFT)
        self._claim(self.asha, "10.1000/back", status=ClaimStatus.REJECTED)
        self._claim(self.asha, "10.1000/live", status=ClaimStatus.SUBMITTED)
        fake, _ = self._run({"10.1000/live": 1, "10.1000/draft": 1, "10.1000/back": 1})
        self.assertEqual(set(CitationCount.objects.values_list("doi", flat=True)), {"10.1000/live"})
        self.assertEqual(fake.calls[0]["filter"], "doi:10.1000/live")

    def test_dois_go_fifty_to_a_request_with_the_or_filter(self):
        for i in range(120):
            self._claim(self.asha, f"10.1000/p{i:03d}")
        fake, summary = self._run({f"10.1000/p{i:03d}": 1 for i in range(120)})
        self.assertEqual(len(fake.calls), 3)
        sizes = [len(c["filter"].removeprefix("doi:").split("|")) for c in fake.calls]
        self.assertEqual(sizes, [50, 50, 20])
        first = fake.calls[0]
        self.assertTrue(first["filter"].startswith("doi:10.1000/p"))
        self.assertIn("mailto", first)
        self.assertGreaterEqual(first["per_page"], 50)
        self.assertEqual(summary["checked"], 120)

    @override_settings(OPENALEX_API_KEY="k-123")
    def test_the_api_key_is_sent_when_there_is_one(self):
        self._claim(self.asha, "10.1000/abc")
        fake, _ = self._run({"10.1000/abc": 1})
        self.assertEqual(fake.calls[0]["api_key"], "k-123")

    def test_no_api_key_is_sent_when_there_is_none(self):
        self._claim(self.asha, "10.1000/abc")
        fake, _ = self._run({"10.1000/abc": 1})
        self.assertNotIn("api_key", fake.calls[0])

    @override_settings(CITATION_DOIS_PER_RUN=60)
    def test_a_long_list_is_spread_across_days_oldest_first(self):
        for i in range(100):
            self._claim(self.asha, f"10.1000/p{i:03d}")
        counts = {f"10.1000/p{i:03d}": 1 for i in range(100)}
        _, day1 = self._run(counts)
        self.assertEqual(day1["checked"], 60)
        waiting = set(
            CitationCount.objects.filter(checked_at__isnull=True).values_list("doi", flat=True)
        )
        self.assertEqual(len(waiting), 40)
        fake, day2 = self._run(counts)
        self.assertEqual(day2["checked"], 60)
        # The forty never asked about go first on the second day.
        first_batch = set(fake.calls[0]["filter"].removeprefix("doi:").split("|"))
        self.assertTrue(waiting <= first_batch)
        self.assertFalse(CitationCount.objects.filter(checked_at__isnull=True).exists())

    def test_an_outage_loses_nothing_and_raises_nothing(self):
        self._claim(self.asha, "10.1000/abc")
        with patch("core.services.citations.upstream.get_json", side_effect=OSError("down")):
            summary = citations.check_citations(pause=0)
        self.assertEqual(summary["failed_batches"], 1)
        row = CitationCount.objects.get()
        self.assertIsNone(row.checked_at)  # so tomorrow asks again, first
        self.assertIsNone(row.count)

    def test_a_doi_openalex_does_not_know_is_checked_and_left_empty(self):
        self._claim(self.asha, "10.1000/unknown")
        self._run({})
        row = CitationCount.objects.get()
        self.assertIsNotNone(row.checked_at)
        self.assertIsNone(row.count)

    def test_a_doi_that_would_break_the_filter_is_skipped(self):
        self._claim(self.asha, "10.1000/a|b")
        self._claim(self.asha, "10.1000/fine")
        fake, _ = self._run({"10.1000/fine": 2})
        self.assertEqual(fake.calls[0]["filter"], "doi:10.1000/fine")

    def test_switched_off_means_not_told(self):
        from core.models import NotificationPreference

        NotificationPreference.objects.create(user=self.asha, kind="citation", level="off")
        self._claim(self.asha, "10.1000/abc")
        self._run({"10.1000/abc": 1})
        self._run({"10.1000/abc": 5})
        self.assertFalse(Notification.objects.exists())
