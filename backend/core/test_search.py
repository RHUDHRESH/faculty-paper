"""Tests for the custom search engine.

Every outbound call is stubbed, and `httpx.Client` is replaced for the whole
suite, so a test that reaches the network fails loudly instead of passing
slowly on a developer's machine and failing in CI. The failure mode this file
exists to prevent is a suite that quietly depends on Crossref being up.
"""

from __future__ import annotations

import json
import threading
from unittest.mock import patch

import httpx
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings

from core import hod
from core.models import Claim, ClaimStatus, ResearchInterest, Role, ScimagoJournal, SnipSource
from core.services.search import engine, money, papers, resolve, sources, upstream, venues

User = get_user_model()

LOCMEM = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "search-tests",
    }
}


class NoNetwork(AssertionError):
    """Raised if anything in the suite tries to open a socket."""


def _no_network(*args, **kwargs):
    raise NoNetwork("a test tried to make a real HTTP request")


# --------------------------------------------------------------------------- #
# Stub payloads, in the shape the source adapters actually produce            #
# --------------------------------------------------------------------------- #


def crossref_hit(doi="10.1000/SHARED", title="Shared Paper", journal="Applied Surface Science"):
    return {
        "source": "Crossref",
        "title": title,
        "doi": doi.lower(),
        "journal": journal,
        "issn": "0169-4332",
        "publication_year": 2024,
        "publication_date": "2024-03-01",
        "type": "journal-article",
        "publisher": "Elsevier",
        "citations": 10,
        "open_access": False,
        "authors": ["A Author"],
        "author_count": 1,
        "url": "https://doi.org/10.1000/shared",
    }


def openalex_hit(doi="10.1000/shared", title="Shared Paper", journal="Applied Surface Science"):
    return {
        "source": "OpenAlex",
        "title": title,
        "doi": doi,
        "journal": journal,
        "issn": "0169-4332",
        "publication_year": 2024,
        "publication_date": "2024-03-01",
        "type": "article",
        "publisher": "Elsevier BV",
        "citations": 42,
        "open_access": True,
        "authors": ["A Author"],
        "author_count": 1,
        "url": "https://doi.org/10.1000/shared",
    }


def scopus_hit(doi="https://doi.org/10.1000/Shared", title="Shared Paper"):
    return {
        "source": "Scopus",
        "title": title,
        "doi": doi,
        "journal": "Applied Surface Science",
        "issn": "0169-4332",
        "publication_year": 2024,
        "cover_date": "2024-03-01",
        "aggregation_type": "Journal",
        "type": "Journal",
        "eid": "2-s2.0-999",
        "scopus_url": "https://scopus.example/999",
        "author_count": 1,
        "citations": 0,
        "open_access": False,
        "authors": [],
        "url": "https://scopus.example/999",
    }


def _boom(exc=None):
    def fail(query, limit):
        raise exc or httpx.ConnectError("down")

    return fail


#: Real PBKDF2 hashing costs about a third of a second per account, and this
#: suite creates two or three per test -- most of a minute spent proving Django
#: can hash a password, in a file about search.
FAST_HASHER = ["django.contrib.auth.hashers.MD5PasswordHasher"]


@override_settings(CACHES=LOCMEM, SCOPUS_API_KEY="test-key", PASSWORD_HASHERS=FAST_HASHER)
class SearchTestCase(TestCase):
    """Shared fixtures: two journals we hold, and one we do not."""

    def setUp(self):
        cache.clear()
        patcher = patch.object(httpx, "Client", _no_network)
        patcher.start()
        self.addCleanup(patcher.stop)

        ScimagoJournal.objects.create(
            title="Applied Surface Science",
            issn="0169-4332",
            eissn="1873-5584",
            sjr=1.2,
            year=2025,
            categories_json=json.dumps(
                [{"category": "Surfaces and Interfaces", "quartile": "Q1"}]
            ),
        )
        SnipSource.objects.create(
            title="Applied Surface Science", print_issn="0169-4332", snip=1.138, year=2025
        )
        ScimagoJournal.objects.create(
            title="Journal of Quiet Surfaces",
            issn="1111-2223",
            sjr=0.2,
            year=2025,
            categories_json=json.dumps([{"category": "Surfaces and Interfaces", "quartile": "Q3"}]),
        )

        self.faculty = User.objects.create_user(
            email="faculty@example.com", password="x", name="Fay Faculty",
            role=Role.FACULTY, department="Mechanical",
        )
        self.head = User.objects.create_user(
            email="head@example.com", password="x", name="Hank Head",
            role=Role.HOD, department="Mechanical",
        )

    def stub_sources(self, *, crossref=None, openalex=None, sources=None, scopus=None):
        """Replace every fetcher. Anything not named returns nothing."""
        for target, name, stub in (
            (papers, "fetch_crossref", crossref),
            (papers, "fetch_openalex", openalex),
            (papers, "fetch_scopus", scopus),
            (venues, "fetch_openalex_sources", sources),
        ):
            patcher = patch.object(target, name, stub or (lambda q, n: []))
            patcher.start()
            self.addCleanup(patcher.stop)

    def source(self, payload, source_id):
        return next((s for s in payload["sources"] if s["id"] == source_id), None)


# --------------------------------------------------------------------------- #
# De-duplication by DOI                                                       #
# --------------------------------------------------------------------------- #


class DeduplicationTests(SearchTestCase):
    def test_same_doi_from_three_sources_is_one_result(self):
        """Three spellings of one DOI collapse into a single row.

        `10.1000/SHARED`, `10.1000/shared` and `https://doi.org/10.1000/Shared`
        are one paper described three ways; `normalize_doi` is what makes them
        one row.
        """
        self.stub_sources(
            crossref=lambda q, n: [crossref_hit()],
            openalex=lambda q, n: [openalex_hit()],
            scopus=lambda q, n: [scopus_hit()],
        )
        rows = engine.search("shared paper", viewer=self.faculty, kinds=["papers"])["papers"]

        self.assertEqual(len(rows), 1, "one paper described three ways is one result")
        self.assertEqual(rows[0]["doi"], "10.1000/shared")
        self.assertEqual(sorted(rows[0]["found_in"]), ["Crossref", "OpenAlex", "Scopus"])

    def test_found_in_carries_labels_not_ids(self):
        self.stub_sources(crossref=lambda q, n: [crossref_hit()])
        row = engine.search("shared", viewer=self.faculty, kinds=["papers"])["papers"][0]
        self.assertEqual(row["found_in"], ["Crossref"])
        self.assertIn("Crossref", sources.LABELS.values())

    def test_merge_keeps_the_best_field_from_each_source(self):
        """The merged row is richer than any single source's row."""
        self.stub_sources(
            crossref=lambda q, n: [crossref_hit()],
            openalex=lambda q, n: [openalex_hit()],
            scopus=lambda q, n: [scopus_hit()],
        )
        row = engine.search("shared", viewer=self.faculty, kinds=["papers"])["papers"][0]

        self.assertEqual(row["cited_by"], 42, "the higher citation count wins")
        self.assertEqual(row["filing"]["eid"], "2-s2.0-999", "only Scopus carries an EID")

    def test_different_dois_stay_separate(self):
        self.stub_sources(
            crossref=lambda q, n: [crossref_hit(doi="10.1000/one", title="One")],
            openalex=lambda q, n: [openalex_hit(doi="10.1000/two", title="Two")],
        )
        rows = engine.search("x paper", viewer=self.faculty, kinds=["papers"])["papers"]
        self.assertEqual(len(rows), 2)

    def test_results_carry_the_filing_form_shape(self):
        """A search result drops into the claim form without translation."""
        self.stub_sources(crossref=lambda q, n: [crossref_hit()])
        row = engine.search("shared", viewer=self.faculty, kinds=["papers"])["papers"][0]
        self.assertEqual(
            set(row["filing"]),
            {
                "matched_title", "doi", "issn", "eid", "journal", "cover_date",
                "publication_year", "aggregation_type", "author_count",
                "snip", "snip_year", "quartile", "subject_category", "scimago_found",
            },
        )
        # Verified fields come from our own tables, never from the source.
        self.assertTrue(row["filing"]["scimago_found"])
        self.assertEqual(row["filing"]["quartile"], "Q1")
        self.assertEqual(row["filing"]["snip"], 1.138)
        self.assertEqual(row["filing"]["snip_year"], 2025)

    def test_a_paper_already_filed_here_says_so(self):
        Claim.objects.create(
            owner=self.faculty,
            paper_title="Shared Paper",
            doi="10.1000/SHARED",
            status=ClaimStatus.CLEARED,
        )
        self.stub_sources(crossref=lambda q, n: [crossref_hit()])
        row = engine.search("shared", viewer=self.faculty, kinds=["papers"])["papers"][0]
        self.assertIsNotNone(row["claim"], "a DOI stored in another case still matches")
        self.assertEqual(row["claim"]["status"], ClaimStatus.CLEARED)
        self.assertTrue(row["claim"]["mine"])

    def test_an_unclaimed_paper_has_a_null_claim(self):
        self.stub_sources(crossref=lambda q, n: [crossref_hit()])
        row = engine.search("shared", viewer=self.faculty, kinds=["papers"])["papers"][0]
        self.assertIsNone(row["claim"])


# --------------------------------------------------------------------------- #
# Degradation                                                                 #
# --------------------------------------------------------------------------- #


class DegradationTests(SearchTestCase):
    def test_sources_are_reported_even_on_complete_success(self):
        """The roster is what lets the page tell partial from complete."""
        self.stub_sources(
            crossref=lambda q, n: [crossref_hit()],
            openalex=lambda q, n: [openalex_hit(doi="10.1000/other", title="Other")],
            scopus=lambda q, n: [],
            sources=lambda q, n: [],
        )
        payload = engine.search("shared", viewer=self.faculty)
        self.assertEqual(
            [s["id"] for s in payload["sources"]],
            ["crossref", "openalex", "scopus", "journals", "college"],
        )
        self.assertTrue(all(s["ok"] for s in payload["sources"]))
        self.assertEqual(self.source(payload, "crossref")["count"], 1)
        for entry in payload["sources"]:
            self.assertIsNone(entry["code"])
            self.assertIsNone(entry["detail"])

    def test_one_source_down_returns_the_others(self):
        self.stub_sources(crossref=_boom(), openalex=lambda q, n: [openalex_hit()])
        payload = engine.search("shared", viewer=self.faculty, kinds=["papers"])

        self.assertEqual(len(payload["papers"]), 1, "OpenAlex still answered")
        down = self.source(payload, "crossref")
        self.assertFalse(down["ok"])
        self.assertEqual(down["code"], sources.ERROR)
        self.assertEqual(down["detail"], "Crossref could not be reached.")
        self.assertTrue(self.source(payload, "openalex")["ok"])

    def test_failure_codes_come_from_the_agreed_vocabulary(self):
        vocabulary = {
            sources.RATE_LIMIT, sources.UNAUTHORIZED, sources.TIMEOUT,
            sources.ERROR, sources.NOT_CONFIGURED,
        }
        cases = [
            (httpx.ReadTimeout("slow"), sources.TIMEOUT),
            (
                httpx.HTTPStatusError(
                    "429", request=httpx.Request("GET", "https://x"),
                    response=httpx.Response(429),
                ),
                sources.RATE_LIMIT,
            ),
            (
                httpx.HTTPStatusError(
                    "403", request=httpx.Request("GET", "https://x"),
                    response=httpx.Response(403),
                ),
                sources.UNAUTHORIZED,
            ),
            (httpx.ConnectError("down"), sources.ERROR),
            (ValueError("nonsense"), sources.ERROR),
        ]
        for exc, expected in cases:
            with self.subTest(exc=type(exc).__name__):
                code, detail = sources.classify(exc, "Crossref")
                self.assertEqual(code, expected)
                self.assertIn(code, vocabulary)
                self.assertTrue(detail.startswith("Crossref"), "detail names the source")
                self.assertTrue(detail.endswith("."), "detail is read by a person")

    def test_all_sources_down_is_an_empty_search_not_an_error(self):
        """Nothing raises, nothing is invented, and every failure is named."""
        self.stub_sources(
            crossref=_boom(),
            openalex=_boom(httpx.ReadTimeout("slow")),
            scopus=_boom(),
            sources=_boom(),
        )
        # A query that our own journal table can answer, so the point being
        # made is that the local half survived rather than that it was empty.
        payload = engine.search("surfaces", viewer=self.faculty)

        self.assertEqual(payload["papers"], [])
        for source_id in ("crossref", "openalex", "scopus"):
            entry = self.source(payload, source_id)
            self.assertFalse(entry["ok"], f"{source_id} should be reported down")
            self.assertTrue(entry["detail"])
        # Our own tables never went anywhere, so the venue answer survives every
        # upstream being down. That is the whole argument for holding our own
        # Scimago and SNIP rows rather than calling somebody for them.
        self.assertTrue(self.source(payload, "journals")["ok"])
        self.assertTrue(payload["venues"]["resolved"])
        self.assertTrue(self.source(payload, "college")["ok"])

    def test_a_source_asked_twice_is_reported_once_and_a_failure_wins(self):
        """OpenAlex serves both works and journals; the reader sees one entry."""
        self.stub_sources(openalex=lambda q, n: [openalex_hit()], sources=_boom())
        payload = engine.search("shared", viewer=self.faculty)
        entries = [s for s in payload["sources"] if s["id"] == "openalex"]
        self.assertEqual(len(entries), 1)
        self.assertFalse(entries[0]["ok"], "half of OpenAlex being down is OpenAlex being unwell")

    def test_a_dead_source_does_not_poison_the_cache(self):
        """A failed fetch is never cached, so the next call tries again."""
        calls = []

        def flaky(url, params=None, **kwargs):
            calls.append(url)
            if len(calls) == 1:
                raise httpx.ConnectError("down")
            return {"results": []}

        with patch.object(upstream, "get_json", flaky):
            with self.assertRaises(httpx.ConnectError):
                venues.fetch_openalex_sources("surface", 5)
            venues.fetch_openalex_sources("surface", 5)
        self.assertEqual(len(calls), 2, "the failure was retried, not remembered")

    def test_scopus_without_a_key_is_not_configured_rather_than_failed(self):
        """No key is a state of this installation, not an outage."""
        self.stub_sources(openalex=lambda q, n: [openalex_hit()])
        with override_settings(SCOPUS_API_KEY=""):
            payload = engine.search("shared", viewer=self.faculty, kinds=["papers"])

        entry = self.source(payload, "scopus")
        self.assertEqual(entry["code"], sources.NOT_CONFIGURED)
        self.assertIn("not set up on this server", entry["detail"])
        self.assertEqual(len(payload["papers"]), 1, "the keyless sources still answered")

    def test_a_scopus_rate_limit_is_reported_as_one(self):
        from core.services.scopus import ScopusError

        self.stub_sources(scopus=_boom(ScopusError("slow down", code="rate_limit")))
        payload = engine.search("shared", viewer=self.faculty, kinds=["papers"])
        self.assertEqual(self.source(payload, "scopus")["code"], sources.RATE_LIMIT)

    def test_short_query_asks_nobody(self):
        self.stub_sources(crossref=_boom(), openalex=_boom())
        payload = engine.search("a", viewer=self.faculty)
        self.assertEqual(payload["sources"], [])
        self.assertEqual(payload["papers"], [])
        self.assertIn("two characters", payload["message"])

    def test_two_characters_is_long_enough(self):
        """The client stops at two, so the server must not stop at three."""
        self.stub_sources()
        payload = engine.search("ai", viewer=self.faculty)
        self.assertNotIn("message", payload)
        self.assertTrue(payload["sources"])


# --------------------------------------------------------------------------- #
# The database disposes                                                       #
# --------------------------------------------------------------------------- #


class ResolutionTests(SearchTestCase):
    def test_unresolvable_journal_comes_back_separately_with_no_numbers(self):
        """A name we cannot find gets its own list and carries nothing."""
        self.stub_sources(
            sources=lambda q, n: [
                {
                    "name": "Journal of Entirely Made Up Studies",
                    "issn": "9999-9994",
                    "publisher": "Nobody",
                    "homepage": "https://example.invalid",
                }
            ]
        )
        group = engine.search("surfaces", viewer=self.faculty, kinds=["venues"])["venues"]

        self.assertEqual(len(group["unresolved"]), 1)
        row = group["unresolved"][0]
        self.assertEqual(
            set(row), {"title", "publisher", "issn"},
            "the unresolved branch has no field a number could live in",
        )
        for value in row.values():
            self.assertNotIsInstance(value, (int, float), "no numeric value at all")
        # And it is not quietly mixed in among journals that do have standings.
        self.assertNotIn(
            "Journal of Entirely Made Up Studies",
            [r["title"] for r in group["resolved"]],
        )

    def test_a_name_openalex_supplies_is_resolved_before_it_gets_a_quartile(self):
        """An external name that *does* match becomes an ordinary result."""
        self.stub_sources(
            sources=lambda q, n: [
                {"name": "Applied Surface Sci.", "issn": "1873-5584", "publisher": "Elsevier"}
            ]
        )
        group = engine.search("quiet surfaces", viewer=self.faculty, kinds=["venues"])["venues"]
        matched = [r for r in group["resolved"] if r["title"] == "Applied Surface Science"]
        self.assertEqual(len(matched), 1, "matched on eISSN, shown under our spelling")
        self.assertEqual(matched[0]["quartile"], "Q1")
        self.assertEqual(matched[0]["snip"], 1.138)
        self.assertEqual(group["unresolved"], [])

    def test_a_resolved_venue_may_have_a_null_quartile(self):
        """Different statement: we know the journal, we hold no quartile for it."""
        ScimagoJournal.objects.create(
            title="Journal of Unrated Surfaces", issn="3333-4446", year=2025,
            categories_json=json.dumps([{"category": "Surfaces and Interfaces", "quartile": None}]),
        )
        self.stub_sources()
        found = engine.search("unrated surfaces", viewer=self.faculty, kinds=["venues"])["venues"]
        row = next(r for r in found["resolved"] if r["title"] == "Journal of Unrated Surfaces")
        self.assertIsNone(row["quartile"])
        self.assertIn("quartile", row, "on the resolved branch the key exists and is null")

    def test_a_paper_in_an_unknown_journal_gets_no_quartile(self):
        self.stub_sources(
            crossref=lambda q, n: [
                dict(crossref_hit(), journal="Journal of Nowhere", issn="9999-9994")
            ]
        )
        row = engine.search("shared", viewer=self.faculty, kinds=["papers"])["papers"][0]
        self.assertFalse(row["filing"]["scimago_found"])
        self.assertIsNone(row["filing"]["quartile"])
        self.assertIsNone(row["filing"]["snip"])

    def test_a_near_miss_is_not_a_match(self):
        """A wrong quartile is worse than none: the reader cannot tell it is wrong."""
        self.assertIsNone(resolve.resolve_journal(title="Applied Surface Sciences Weekly"))
        self.assertIsNotNone(resolve.resolve_journal(title="applied surface science"))

    def test_quartile_filter_excludes_journals_with_no_quartile(self):
        self.stub_sources()
        found = engine.search(
            "surfaces", viewer=self.faculty, kinds=["venues"], quartile="Q1"
        )["venues"]["resolved"]
        self.assertTrue(found)
        self.assertTrue(all(r["quartile"] == "Q1" for r in found))

    def test_dataset_year_is_read_from_the_table_not_hardcoded(self):
        ScimagoJournal.objects.create(
            title="Next Year Journal", issn="2222-3334", year=2026, categories_json="[]"
        )
        self.assertEqual(resolve.dataset_year(), 2026)


# --------------------------------------------------------------------------- #
# Money-blindness                                                             #
# --------------------------------------------------------------------------- #


def money_keys_in(payload, path="") -> list[str]:
    """Every money-bearing key anywhere in a nested structure."""
    found: list[str] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            if key in hod.MONEY_KEYS:
                found.append(f"{path}.{key}")
            found.extend(money_keys_in(value, f"{path}.{key}"))
    elif isinstance(payload, (list, tuple)):
        for i, item in enumerate(payload):
            found.extend(money_keys_in(item, f"{path}[{i}]"))
    return found


class MoneyBlindnessTests(SearchTestCase):
    def setUp(self):
        super().setUp()
        self.paid = Claim.objects.create(
            owner=self.faculty,
            paper_title="Surface Science Of Everything",
            normalized_title="surface science of everything",
            journal_title="Applied Surface Science",
            issn="0169-4332",
            doi="10.1000/paid",
            publication_year=2024,
            quartile="Q1",
            snip=1.138,
            status=ClaimStatus.PAID,
            remuneration=112590.0,
            base_amount=90000.0,
            qf_amount=22590.0,
        )

    def test_every_key_this_package_emits_is_one_the_filter_strips(self):
        """The import-time guard, asserted rather than assumed."""
        self.assertTrue(money.EMITTED_MONEY_KEYS <= hod.MONEY_KEYS)

    def test_faculty_see_the_amount_on_a_ticket(self):
        self.stub_sources()
        ticket = engine.search(
            "Surface Science Of Everything", viewer=self.faculty, kinds=["people"]
        )["tickets"][0]
        self.assertEqual(ticket["amount"], 112590.0)

    def test_a_head_of_department_receives_no_rupee_figure_anywhere(self):
        """The whole response, walked recursively, against hod.MONEY_KEYS."""
        self.stub_sources(
            crossref=lambda q, n: [crossref_hit(title="Surface Science Of Everything")],
            sources=lambda q, n: [{"name": "Applied Surface Science", "issn": "0169-4332"}],
        )
        payload = engine.search("surface science", viewer=self.head)

        leaked = money_keys_in(payload)
        self.assertEqual(leaked, [], f"a head of department was sent money at {leaked}")
        self.assertFalse(payload["money_visible"])
        self.assertTrue(payload["venues"]["resolved"], "and still got a real answer")

    def test_the_amount_key_is_absent_for_a_head_not_zero(self):
        """`amount: 0` is the bug that put a zero-rupee column on four charts."""
        self.stub_sources()
        ticket = engine.search(
            "Surface Science Of Everything", viewer=self.head, kinds=["people"]
        )["tickets"][0]
        self.assertNotIn("amount", ticket)
        self.assertEqual(money.amount_for(112590.0, Role.HOD), {})
        self.assertEqual(money.amount_for(0.0, Role.FACULTY), {"amount": 0.0})

    def test_a_head_keeps_the_academic_standing(self):
        """Blind to money, not blind to the journal."""
        self.stub_sources()
        top = engine.search("surface science", viewer=self.head, kinds=["venues"])[
            "venues"
        ]["resolved"][0]
        self.assertEqual(top["quartile"], "Q1")
        self.assertEqual(top["snip"], 1.138)
        self.assertEqual(top["sjr"], 1.2)

    def test_no_venue_carries_money_for_anybody(self):
        """Estimating a payout is /discover's job and stays behind its guard."""
        self.stub_sources()
        found = engine.search("surface science", viewer=self.faculty, kinds=["venues"])
        self.assertEqual(money_keys_in(found["venues"]), [])

    def test_no_paper_or_person_carries_money_for_anybody(self):
        self.stub_sources(crossref=lambda q, n: [crossref_hit()])
        payload = engine.search("shared", viewer=self.faculty)
        self.assertEqual(money_keys_in(payload["papers"]), [])
        self.assertEqual(money_keys_in(payload["people"]), [])

    def test_a_head_is_told_progress_not_that_a_colleague_was_paid(self):
        self.stub_sources(
            crossref=lambda q, n: [dict(crossref_hit(doi="10.1000/paid"))],
        )
        seen = engine.search("Surface Science Of Everything", viewer=self.head)
        self.assertEqual(seen["tickets"][0]["status"], "Completed")
        self.assertNotIn(
            ClaimStatus.PAID,
            [t["status"] for t in seen["tickets"]],
            "'PAID' says a named colleague was paid",
        )

        by_faculty = engine.search(
            "Surface Science Of Everything", viewer=self.faculty, kinds=["people"]
        )
        self.assertEqual(by_faculty["tickets"][0]["status"], ClaimStatus.PAID)

    def test_the_translation_reaches_a_paper_claim_badge_too(self):
        """The same status, on the other route it can leave by."""
        self.stub_sources(crossref=lambda q, n: [crossref_hit(doi="10.1000/paid")])
        row = engine.search("shared", viewer=self.head, kinds=["papers"])["papers"][0]
        self.assertEqual(row["claim"]["status"], "Completed")


# --------------------------------------------------------------------------- #
# People and tickets                                                          #
# --------------------------------------------------------------------------- #


class PeopleTests(SearchTestCase):
    def setUp(self):
        super().setUp()
        self.other = User.objects.create_user(
            email="other@example.com", password="x", name="Ada Other",
            role=Role.FACULTY, department="Civil",
        )
        ResearchInterest.objects.create(user=self.other, domain="Surfaces and Interfaces")
        Claim.objects.create(
            owner=self.faculty,
            paper_title="Nanostructured Surfaces For Energy",
            normalized_title="nanostructured surfaces for energy",
            journal_title="Applied Surface Science",
            doi="10.1000/prior",
            publication_year=2023,
            status=ClaimStatus.CLEARED,
        )

    def test_tickets_answer_has_this_been_filed(self):
        self.stub_sources()
        tickets = engine.search(
            "Nanostructured Surfaces For Energy", viewer=self.faculty, kinds=["people"]
        )["tickets"]
        self.assertEqual(len(tickets), 1)
        self.assertEqual(tickets[0]["claimant"]["name"], "Fay Faculty")
        self.assertEqual(tickets[0]["department"], "Mechanical")

    def test_a_rejected_ticket_does_not_read_as_already_claimed(self):
        """The one wrong answer that would stop a legitimate filing."""
        Claim.objects.filter(doi="10.1000/prior").update(status=ClaimStatus.REJECTED)
        self.stub_sources()
        tickets = engine.search(
            "Nanostructured Surfaces For Energy", viewer=self.faculty, kinds=["people"]
        )["tickets"]
        self.assertEqual(tickets, [])

    def test_someone_with_no_publications_is_still_found_by_interest(self):
        self.stub_sources()
        found = engine.search(
            "Surfaces and Interfaces", viewer=self.faculty, kinds=["people"]
        )["people"]
        ada = next(p for p in found if p["name"] == "Ada Other")
        self.assertEqual(ada["papers"], 0)
        self.assertIn("lists it as a research interest", ada["why"])

    def test_people_carry_the_contract_fields(self):
        self.stub_sources()
        found = engine.search("Surfaces", viewer=self.faculty, kinds=["people"])["people"]
        self.assertTrue(found)
        self.assertTrue({"id", "name", "department", "designation", "papers"} <= set(found[0]))

    def test_a_head_sees_only_their_own_department(self):
        """Read from the account, never from a parameter."""
        self.stub_sources()
        payload = engine.search("Surfaces", viewer=self.head, kinds=["people"])
        self.assertNotIn("Ada Other", [p["name"] for p in payload["people"]], "Civil is not theirs")
        self.assertIn("Fay Faculty", [p["name"] for p in payload["people"]])


# --------------------------------------------------------------------------- #
# Cache                                                                       #
# --------------------------------------------------------------------------- #


class CacheTests(SearchTestCase):
    def test_a_repeated_query_does_not_call_the_upstream_twice(self):
        calls = []

        def once(url, params=None, **kwargs):
            calls.append(url)
            return {"message": {"items": []}}

        with patch.object(upstream, "get_json", once):
            papers.fetch_crossref("supercapacitor", 10)
            papers.fetch_crossref("supercapacitor", 10)
            papers.fetch_crossref("SUPERCAPACITOR", 10)
        self.assertEqual(len(calls), 1, "the same query was fetched once")

    def test_a_different_query_is_a_different_key(self):
        calls = []

        def once(url, params=None, **kwargs):
            calls.append(url)
            return {"results": []}

        with patch.object(upstream, "get_json", once):
            venues.fetch_openalex_sources("materials", 10)
            venues.fetch_openalex_sources("mechanics", 10)
        self.assertEqual(len(calls), 2)

    def test_an_empty_result_is_cached_too(self):
        """Otherwise a query that legitimately finds nothing is re-fetched forever."""
        calls = []

        def once(url, params=None, **kwargs):
            calls.append(url)
            return {"results": []}

        with patch.object(upstream, "get_json", once):
            self.assertEqual(papers.fetch_openalex("nothing at all", 5), [])
            self.assertEqual(papers.fetch_openalex("nothing at all", 5), [])
        self.assertEqual(len(calls), 1)

    def test_the_cache_holds_the_raw_payload_and_nothing_resolved(self):
        """Only upstream payloads are cached, never a resolved or priced answer.

        Two reasons: a cached answer would pin a journal's quartile to whatever
        our tables said half an hour ago, and it would put one person's view of
        a ticket into a store the next person reads from.
        """
        key = upstream.cache_key("sources", "openalex", "surface science", 10)
        with patch.object(
            upstream,
            "get_json",
            lambda *a, **k: {
                "results": [
                    {"display_name": "Applied Surface Science", "issn_l": "0169-4332"}
                ]
            },
        ):
            venues.fetch_openalex_sources("surface science", 10)

        stored = cache.get(key)
        self.assertEqual(stored, [
            {
                "name": "Applied Surface Science",
                "issn": "0169-4332",
                "publisher": None,
                "homepage": None,
                "openalex_id": None,
            }
        ])
        self.assertEqual(money_keys_in(stored), [], "nothing money-bearing is ever cached")
        for forbidden in ("quartile", "snip", "sjr"):
            self.assertNotIn(forbidden, json.dumps(stored), f"{forbidden} is resolved, not cached")

    def test_a_second_search_serves_the_same_result_without_the_network(self):
        """End to end: warm cache, and `httpx.Client` is still booby-trapped."""
        payload = {"results": [{"display_name": "Applied Surface Science",
                                "issn_l": "0169-4332"}]}
        with patch.object(upstream, "get_json", lambda *a, **k: payload):
            first = venues.fetch_openalex_sources("surface science", 10)
        # No stub at all this time -- any network call raises NoNetwork.
        second = venues.fetch_openalex_sources("surface science", 10)
        self.assertEqual(first, second)

    def test_ttls_are_the_ones_documented(self):
        self.assertEqual(upstream.WORKS_TTL, 1800, "thirty minutes for bibliographic search")
        self.assertEqual(upstream.VENUE_TTL, 86400, "a day for journal metadata")


# --------------------------------------------------------------------------- #
# Politeness and bounds                                                       #
# --------------------------------------------------------------------------- #


class OutboundTests(SearchTestCase):
    def test_every_request_identifies_itself_with_a_reachable_contact(self):
        self.assertIn("mailto:", upstream.user_agent())
        self.assertNotIn(".local", upstream.user_agent(), "a .local address bounces")
        with override_settings(SEARCH_CONTACT_EMAIL="research@college.edu"):
            self.assertIn("research@college.edu", upstream.user_agent())

    def test_the_contact_is_sent_to_crossref_and_openalex(self):
        seen = {}

        def capture(url, params=None, **kwargs):
            seen[url] = params
            return {"results": [], "message": {"items": []}}

        with patch.object(upstream, "get_json", capture):
            papers.fetch_crossref("x query", 5)
            papers.fetch_openalex("x query", 5)
            venues.fetch_openalex_sources("x query", 5)
        self.assertEqual(len(seen), 3)
        for url, params in seen.items():
            self.assertIn("mailto", params, f"{url} was asked impolitely")

    def test_connect_and_read_are_bounded_separately(self):
        self.assertEqual(upstream.CONNECT_TIMEOUT, 4.0)
        self.assertEqual(upstream.READ_TIMEOUT, 10.0)
        self.assertGreater(upstream.FANOUT_BUDGET, upstream.READ_TIMEOUT)

    def test_the_fan_out_gives_up_on_a_straggler(self):
        release = threading.Event()
        self.addCleanup(release.set)

        def never():
            release.wait(30)
            return ["late"]

        results, errors = upstream.fan_out(
            {"quick": lambda: ["fast"], "slow": never}, budget=0.2
        )
        self.assertEqual(results, {"quick": ["fast"]})
        self.assertEqual(list(errors), ["slow"])
        self.assertIsNone(errors["slow"], "abandoned, not raised")
        entry = sources.timed_out("openalex", 14.0)
        self.assertEqual(entry["code"], sources.TIMEOUT)

    def test_nothing_in_this_suite_reaches_the_network(self):
        with self.assertRaises(NoNetwork):
            upstream.get_json("https://api.crossref.org/works")
