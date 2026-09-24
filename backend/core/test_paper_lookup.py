"""The paper lookup that works without a Scopus key.

Production has no SCOPUS_API_KEY, so every "pull it from Scopus" failed there
and the claimant typed everything by hand. The lookup now asks OpenAlex first
(a single work by DOI is free and needs no key), Crossref second, and Scopus
only when a key is configured -- and then fills the journal's standing from our
own SCImago and SNIP tables.

Every outbound call is stubbed and `httpx.Client` is booby-trapped for the
whole suite, as in test_search.py: a test that reaches the network fails
instead of passing slowly on one machine and failing on another.

The people in these payloads are made up. Their names are written the way the
real roster and the real OpenAlex records write them -- "Dr. R N Kavitha"
against "R. N. Kavitha", "Dr. Uma Devi V" against "V. UmaDevi" -- because that
disagreement is exactly what the matcher has to survive.
"""

from __future__ import annotations

import io
import json
import shutil
import tempfile
from unittest.mock import patch

import httpx
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.test import TestCase, override_settings

from core.models import Claim, ClaimAttachment, ClaimStatus, Role, ScimagoJournal, SnipSource
from core.services import paper_lookup as pl
from core.services.search import upstream

User = get_user_model()

LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "paper-lookup"}}
FAST_HASHER = ["django.contrib.auth.hashers.MD5PasswordHasher"]
COLLEGE = "Saveetha Engineering College"
DOI = "10.1038/s41598-026-99999-x"


class NoNetwork(AssertionError):
    pass


def _no_network(*args, **kwargs):
    raise NoNetwork("a test tried to make a real HTTP request")


def openalex_work(**overrides):
    """An OpenAlex work in the shape `works/doi:` returns, trimmed."""
    work = {
        "id": "https://openalex.org/W1",
        "doi": f"https://doi.org/{DOI}",
        "title": "A Sharded Ledger for Cloud Storage",
        "display_name": "A Sharded Ledger for Cloud Storage",
        "publication_year": 2026,
        "publication_date": "2026-05-20",
        "type": "article",
        "cited_by_count": 7,
        "is_retracted": False,
        "open_access": {"is_oa": True, "oa_status": "gold", "oa_url": "https://example.org/oa.pdf"},
        "best_oa_location": {
            "pdf_url": "https://example.org/oa.pdf",
            "landing_page_url": f"https://doi.org/{DOI}",
        },
        "primary_location": {
            "source": {
                "display_name": "Scientific Reports",
                "issn_l": "2045-2322",
                "issn": ["2045-2322"],
                "type": "journal",
                "host_organization_name": "Nature Portfolio",
            }
        },
        "biblio": {"volume": "16", "issue": "1", "first_page": None, "last_page": None},
        "authorships": [
            {
                "author_position": "first",
                "author": {"display_name": "R. N. Kavitha", "orcid": "https://orcid.org/0000-0002-0000-0001"},
                "institutions": [{"display_name": "Saveetha University"}],
                "raw_affiliation_strings": [
                    "Department of IT, Saveetha Engineering College, Chennai, Tamil Nadu, India"
                ],
                "is_corresponding": True,
            },
            {
                "author_position": "middle",
                "author": {"display_name": "C. Valli", "orcid": None},
                "institutions": [{"display_name": "Anna University, Chennai"}],
                "raw_affiliation_strings": ["Department of CSE, Anna University, Chennai, India"],
                "is_corresponding": False,
            },
            {
                "author_position": "middle",
                "author": {"display_name": "V. UmaDevi", "orcid": None},
                "institutions": [{"display_name": "Saveetha University"}],
                "raw_affiliation_strings": [
                    "Department of CSE, Saveetha Engineering College, Chennai, India"
                ],
                "is_corresponding": False,
            },
            {
                "author_position": "last",
                "author": {"display_name": "G. Kavi", "orcid": None},
                "institutions": [{"display_name": "Saveetha University"}],
                "raw_affiliation_strings": [
                    "Department of AI&DS, Saveetha Engineering College, Chennai, India"
                ],
                "is_corresponding": False,
            },
        ],
    }
    work.update(overrides)
    return work


def crossref_message(**overrides):
    """A Crossref `works/{doi}` message, trimmed."""
    message = {
        "DOI": DOI,
        "title": ["A sharded ledger for cloud storage"],
        "container-title": ["Scientific Reports"],
        "ISSN": ["2045-2322"],
        "issued": {"date-parts": [[2026, 5, 20]]},
        "type": "journal-article",
        "publisher": "Springer Science and Business Media LLC",
        "volume": "16",
        "issue": "1",
        "is-referenced-by-count": 3,
        "author": [
            {"given": "R. N.", "family": "Kavitha", "sequence": "first",
             "affiliation": [{"name": "Saveetha Engineering College"}]},
            {"given": "C.", "family": "Valli", "sequence": "additional", "affiliation": []},
            {"given": "V.", "family": "UmaDevi", "sequence": "additional", "affiliation": []},
            {"given": "G.", "family": "Kavi", "sequence": "additional", "affiliation": []},
        ],
        "URL": f"https://doi.org/{DOI}",
    }
    message.update(overrides)
    return message


def _status_error(code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://example.org")
    return httpx.HTTPStatusError("x", request=request, response=httpx.Response(code, request=request))


@override_settings(CACHES=LOCMEM, SCOPUS_API_KEY="", PASSWORD_HASHERS=FAST_HASHER)
class LookupBase(TestCase):
    def setUp(self):
        cache.clear()
        patcher = patch.object(httpx, "Client", _no_network)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.faculty = User.objects.create_user(
            email="kavitha@example.com", password="x", name="Dr. R N Kavitha",
            role=Role.FACULTY, department="IT",
        )
        # The two shapes the real reference data stores an ISSN in: floats a
        # spreadsheet wrote, and a float that also lost its leading zero.
        ScimagoJournal.objects.create(
            title="Scientific Reports", issn="20452322.0", sjr=0.9, year=2025,
            categories_json=json.dumps([
                {"category": "Multidisciplinary", "quartile": "Q1"},
                {"category": "Computer Science (miscellaneous)", "quartile": "Q2"},
            ]),
        )
        SnipSource.objects.create(
            title="Scientific Reports", print_issn="20452322.0", e_issn="20452322.0",
            snip=1.339, year=2025,
        )
        ScimagoJournal.objects.create(
            title="Clinical Obstetrics Quarterly", issn="3906663.0", sjr=0.2, year=2025,
            categories_json=json.dumps([{"category": "Obstetrics and Gynecology", "quartile": "Q3"}]),
        )
        SnipSource.objects.create(
            title="Clinical Obstetrics Quarterly", print_issn="3906663.0", snip=0.303, year=2025
        )

    def stub(self, *, openalex=None, crossref=None, crossref_search=None, scopus=None):
        """Replace every fetcher. Anything not named answers "no such record"."""
        for name, stub in (
            ("fetch_openalex_work", openalex or (lambda doi: None)),
            ("fetch_crossref_work", crossref or (lambda doi: None)),
            ("search_crossref", crossref_search or (lambda title, limit: [])),
            ("fetch_scopus_record", scopus or (lambda doi: None)),
        ):
            patcher = patch.object(pl, name, stub)
            patcher.start()
            self.addCleanup(patcher.stop)

    def lookup(self, text, *, user=None, college=COLLEGE):
        return pl.lookup(text, claimant=user or self.faculty, college_name=college)


# --------------------------------------------------------------------------- #
# What was pasted                                                             #
# --------------------------------------------------------------------------- #


class ParseReferenceTests(TestCase):
    def test_a_bare_doi(self):
        ref = pl.parse_reference("10.1038/s41598-026-51254-y")
        self.assertEqual((ref.kind, ref.doi), ("doi", "10.1038/s41598-026-51254-y"))

    def test_a_doi_link_is_tidied_and_lowercased(self):
        ref = pl.parse_reference("  https://doi.org/10.1038/S41598-026-51254-Y  ")
        self.assertEqual(ref.doi, "10.1038/s41598-026-51254-y")

    def test_a_doi_prefix_and_trailing_full_stop(self):
        self.assertEqual(pl.parse_reference("doi:10.1016/j.apsusc.2024.159876.").doi,
                         "10.1016/j.apsusc.2024.159876")

    def test_a_publisher_link_that_carries_the_doi(self):
        ref = pl.parse_reference("https://link.springer.com/article/10.1007/s12596-026-03210-2?utm=x")
        self.assertEqual((ref.kind, ref.doi), ("url", "10.1007/s12596-026-03210-2"))

    def test_a_nature_article_link_names_its_doi_without_the_prefix(self):
        ref = pl.parse_reference("https://www.nature.com/articles/s41598-026-51254-y")
        self.assertEqual(ref.doi, "10.1038/s41598-026-51254-y")

    def test_a_scopus_record_link(self):
        ref = pl.parse_reference(
            "https://www.scopus.com/record/display.uri?eid=2-s2.0-85190001234&origin=resultslist"
        )
        self.assertEqual((ref.kind, ref.eid), ("scopus", "2-s2.0-85190001234"))

    def test_a_link_with_no_doi_in_it(self):
        ref = pl.parse_reference("https://www.sciencedirect.com/science/article/pii/S0169433224001234")
        self.assertEqual(ref.kind, "url_without_doi")
        self.assertIsNone(ref.doi)

    def test_a_title(self):
        ref = pl.parse_reference("A Sharded Ledger for Cloud Storage")
        self.assertEqual((ref.kind, ref.title), ("title", "A Sharded Ledger for Cloud Storage"))

    def test_too_little_to_go_on(self):
        self.assertEqual(pl.parse_reference("ledger").kind, "too_short")
        self.assertEqual(pl.parse_reference("   ").kind, "empty")


# --------------------------------------------------------------------------- #
# Which author is the claimant                                                #
# --------------------------------------------------------------------------- #


def _authors(*names):
    return [{"position": i + 1, "name": n, "affiliations": []} for i, n in enumerate(names)]


PAPER_AUTHORS = _authors("R. N. Kavitha", "C. Valli", "V. UmaDevi", "G. Kavi")


class ClaimantMatchTests(TestCase):
    def test_initials_and_honorific_do_not_get_in_the_way(self):
        m = pl.match_claimant(PAPER_AUTHORS, name="Dr. R N Kavitha")
        self.assertEqual((m["position"], m["confidence"]), (1, "exact"))

    def test_a_shorter_name_is_not_a_prefix_match(self):
        """"Kavi" must find G. Kavi, never R. N. Kavitha."""
        m = pl.match_claimant(PAPER_AUTHORS, name="Dr. G. Kavi")
        self.assertEqual(m["position"], 4)

    def test_a_name_run_together_on_the_paper(self):
        m = pl.match_claimant(PAPER_AUTHORS, name="Dr. Uma Devi V")
        self.assertEqual(m["position"], 3)

    def test_initials_after_the_name(self):
        m = pl.match_claimant(_authors("A. Author", "Narendran S"), name="Dr. S. Narendran")
        self.assertEqual(m["position"], 2)

    def test_a_dropped_initial_is_still_a_likely_match(self):
        m = pl.match_claimant(_authors("Rakesh Kumar"), name="Dr. Rakesh Kumar M")
        self.assertEqual((m["position"], m["confidence"]), (1, "likely"))

    def test_conflicting_initials_are_a_different_person(self):
        m = pl.match_claimant(_authors("K. Senthil Kumar"), name="Dr. P. Senthil Kumar")
        self.assertIsNone(m["position"])
        self.assertEqual(m["confidence"], "none")

    def test_nobody_matches(self):
        m = pl.match_claimant(PAPER_AUTHORS, name="Ms. Priya Dharshini")
        self.assertEqual((m["position"], m["confidence"]), (None, "none"))

    def test_two_equally_good_matches_are_not_guessed_between(self):
        m = pl.match_claimant(_authors("S. Anand", "X. Other", "S. Anand"), name="Dr. S. Anand")
        self.assertIsNone(m["position"])
        self.assertEqual(m["confidence"], "ambiguous")
        self.assertEqual(m["candidates"], [1, 3])

    def test_a_scopus_author_id_beats_a_name(self):
        authors = _authors("S. Anand", "S. Anand")
        authors[1]["scopus_id"] = "5700001"
        m = pl.match_claimant(authors, name="Dr. S. Anand", scopus_author_id="5700001")
        self.assertEqual((m["position"], m["confidence"], m["matched_on"]), (2, "exact", "scopus_id"))


# --------------------------------------------------------------------------- #
# Whether the college is on the paper                                          #
# --------------------------------------------------------------------------- #


class AffiliationTests(TestCase):
    def _authors(self, *affiliations):
        return [
            {"position": i + 1, "name": f"A{i}", "affiliations": list(a), "institutions": []}
            for i, a in enumerate(affiliations)
        ]

    def test_the_college_printed_in_full(self):
        found = pl.college_affiliation(
            self._authors(["Dept of IT, Saveetha Engineering College, Chennai"], ["Anna University"]),
            college_name=COLLEGE, claimant_position=1,
        )
        self.assertEqual((found["status"], found["claimant_status"]), ("yes", "yes"))
        self.assertEqual(found["positions"], [1])

    def test_a_different_institution_of_the_same_name_is_not_the_college(self):
        found = pl.college_affiliation(
            self._authors(["Saveetha University, Chennai"]), college_name=COLLEGE, claimant_position=1
        )
        self.assertEqual(found["status"], "other")
        self.assertIn("Saveetha University", found["text"])

    def test_not_there_at_all(self):
        found = pl.college_affiliation(
            self._authors(["Anna University"]), college_name=COLLEGE, claimant_position=1
        )
        self.assertEqual(found["status"], "no")

    def test_a_source_with_no_affiliations_says_it_cannot_tell(self):
        found = pl.college_affiliation(self._authors([], []), college_name=COLLEGE, claimant_position=None)
        self.assertEqual(found["status"], "unknown")

    def test_the_college_is_on_the_paper_but_not_beside_the_claimant(self):
        found = pl.college_affiliation(
            self._authors(["Anna University"], ["Saveetha Engineering College"]),
            college_name=COLLEGE, claimant_position=1,
        )
        self.assertEqual((found["status"], found["claimant_status"]), ("yes", "no"))

    def test_another_college_installs_the_product(self):
        found = pl.college_affiliation(
            self._authors(["Department of ECE, Riverside Institute of Technology"]),
            college_name="Riverside Institute of Technology", claimant_position=1,
        )
        self.assertEqual(found["status"], "yes")


# --------------------------------------------------------------------------- #
# The journal's standing, from our own tables                                 #
# --------------------------------------------------------------------------- #


class JournalMetricsTests(LookupBase):
    def test_an_issn_stored_as_a_float_is_still_found(self):
        m = pl.journal_metrics(issns=["2045-2322"], journal="Sci Rep", publication_type="Journal")
        self.assertTrue(m["found"])
        self.assertEqual((m["quartile"], m["snip"], m["matched_by"]), ("Q1", 1.339, "issn"))
        self.assertEqual(m["dataset_year"], 2025)

    def test_a_float_that_lost_its_leading_zero_is_still_found(self):
        m = pl.journal_metrics(issns=["0390-6663"], journal=None, publication_type="Journal")
        self.assertEqual((m["quartile"], m["snip"]), ("Q3", 0.303))

    def test_engineering_classification_from_the_subject_areas(self):
        sci = pl.journal_metrics(issns=["2045-2322"], journal=None, publication_type="Journal")
        self.assertEqual(sci["engineering_class"], "Engineering", "Computer Science counts")
        obs = pl.journal_metrics(issns=["0390-6663"], journal=None, publication_type="Journal")
        self.assertEqual(obs["engineering_class"], "Non-Engineering")

    def test_by_exact_name_when_the_issn_is_unknown(self):
        m = pl.journal_metrics(issns=["1111-1111"], journal="Scientific Reports", publication_type="Journal")
        self.assertEqual((m["quartile"], m["matched_by"]), ("Q1", "title"))

    def test_a_journal_we_do_not_hold(self):
        m = pl.journal_metrics(issns=["1234-5679"], journal="Journal of Nowhere", publication_type="Journal")
        self.assertFalse(m["found"])
        self.assertIsNone(m["quartile"])
        self.assertIsNone(m["snip"])


# --------------------------------------------------------------------------- #
# The lookup, end to end, with every upstream stubbed                          #
# --------------------------------------------------------------------------- #


class LookupTests(LookupBase):
    def test_a_doi_is_answered_from_openalex_with_no_scopus_key(self):
        self.stub(openalex=lambda doi: openalex_work(), crossref=lambda doi: crossref_message())
        out = self.lookup(f"https://doi.org/{DOI}")
        self.assertTrue(out["ok"])
        paper = out["paper"]
        self.assertEqual(paper["title"], "A Sharded Ledger for Cloud Storage")
        self.assertEqual(paper["journal"], "Scientific Reports")
        self.assertEqual(paper["issns"], ["2045-2322"])
        self.assertEqual(paper["publication_date"], "2026-05-20")
        self.assertEqual(paper["publication_type"], "Journal")
        self.assertEqual(paper["document_type"], "Journal article")
        self.assertEqual(paper["total_authors"], 4)
        self.assertEqual(paper["citations"], 7, "the larger count of the two sources")
        self.assertEqual(paper["open_access_url"], "https://example.org/oa.pdf")
        self.assertEqual([a["name"] for a in paper["authors"]][:2], ["R. N. Kavitha", "C. Valli"])
        self.assertEqual(out["field_sources"]["title"], "OpenAlex")
        self.assertEqual(out["field_sources"]["quartile"], "Our journal data")

    def test_the_claimant_affiliation_and_metrics_come_back_together(self):
        self.stub(openalex=lambda doi: openalex_work())
        out = self.lookup(DOI)
        self.assertEqual(out["claimant"]["position"], 1)
        self.assertTrue(out["paper"]["authors"][0]["is_claimant"])
        self.assertEqual(out["affiliation"]["status"], "yes")
        self.assertEqual(out["metrics"]["quartile"], "Q1")
        self.assertEqual(out["metrics"]["snip"], 1.339)
        self.assertEqual(out["metrics"]["engineering_class"], "Engineering")

    def test_every_source_reports_itself(self):
        self.stub(openalex=lambda doi: openalex_work(), crossref=lambda doi: crossref_message())
        sources = {s["id"]: s for s in self.lookup(DOI)["sources"]}
        self.assertTrue(sources["openalex"]["ok"])
        self.assertTrue(sources["crossref"]["ok"])
        self.assertEqual(sources["scopus"]["code"], "not_configured")
        self.assertTrue(sources["journals"]["ok"])
        self.assertEqual(self.lookup(DOI)["scopus_status"], "not_configured")

    def test_openalex_down_falls_back_to_crossref(self):
        def down(doi):
            raise httpx.ConnectError("down")

        self.stub(openalex=down, crossref=lambda doi: crossref_message())
        out = self.lookup(DOI)
        self.assertTrue(out["ok"])
        self.assertEqual(out["paper"]["title"], "A sharded ledger for cloud storage")
        self.assertEqual(out["field_sources"]["title"], "Crossref")
        openalex = next(s for s in out["sources"] if s["id"] == "openalex")
        self.assertFalse(openalex["ok"])
        self.assertEqual(openalex["detail"], "OpenAlex could not be reached.")
        # Crossref carries affiliations for the first author only.
        self.assertEqual(out["claimant"]["position"], 1)

    def test_no_source_knows_the_doi(self):
        self.stub()
        out = self.lookup(DOI)
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "not_found")
        self.assertIn(DOI, out["message"])

    def test_every_source_down_is_a_message_not_an_exception(self):
        def down(doi):
            raise httpx.ReadTimeout("slow")

        self.stub(openalex=down, crossref=down)
        out = self.lookup(DOI)
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "unreachable")
        self.assertIn("by hand", out["message"])

    def test_scopus_is_asked_only_when_a_key_is_set(self):
        asked = []

        def scopus(doi):
            asked.append(doi)
            return {"eid": "2-s2.0-1", "scopus_url": "https://scopus.example/1",
                    "aggregation_type": "Journal", "cover_date": "2026-06-01", "issn": "2045-2322"}

        self.stub(openalex=lambda doi: openalex_work(), scopus=scopus)
        self.lookup(DOI)
        self.assertEqual(asked, [], "no key, no Scopus call")
        with override_settings(SCOPUS_API_KEY="real-key"):
            out = self.lookup(DOI)
        self.assertEqual(asked, [DOI])
        self.assertEqual(out["paper"]["eid"], "2-s2.0-1")
        self.assertEqual(out["paper"]["publication_date"], "2026-06-01", "the index's own date wins")
        self.assertEqual(out["field_sources"]["publication_date"], "Scopus")
        self.assertEqual(out["scopus_status"], "ok")

    def test_a_retracted_paper_is_said_out_loud(self):
        self.stub(openalex=lambda doi: openalex_work(is_retracted=True))
        out = self.lookup(DOI)
        self.assertTrue(any("retracted" in w.lower() for w in out["warnings"]))

    def test_an_erratum_is_not_the_paper(self):
        self.stub(openalex=lambda doi: openalex_work(type="erratum"))
        out = self.lookup(DOI)
        self.assertTrue(any("erratum" in w.lower() for w in out["warnings"]))
        self.assertEqual(out["paper"]["publication_type"], "Other")

    def test_what_still_needs_checking_is_listed(self):
        work = openalex_work()
        work["authorships"][0]["raw_affiliation_strings"] = ["Saveetha University, Chennai"]
        for a in work["authorships"]:
            a["raw_affiliation_strings"] = ["Saveetha University, Chennai"]
        self.stub(openalex=lambda doi: work)
        other = User.objects.create_user(
            email="rk@example.com", password="x", name="Dr. Rakesh Kumar M", role=Role.FACULTY
        )
        work["authorships"][1]["author"]["display_name"] = "Rakesh Kumar"
        out = self.lookup(DOI, user=other)
        keys = {c["key"] for c in out["to_check"]}
        self.assertIn("position", keys, "a likely match is for the claimant to confirm")
        self.assertIn("affiliation", keys, "Saveetha University is not the college")
        position = next(c for c in out["to_check"] if c["key"] == "position")
        self.assertIn("Rakesh Kumar", position["text"])

    def test_a_date_known_only_to_the_month_asks_for_the_day(self):
        self.stub(crossref=lambda doi: crossref_message(issued={"date-parts": [[2026, 5]]}))
        out = self.lookup(DOI)
        self.assertEqual(out["paper"]["publication_date"], "2026-05")
        self.assertEqual(out["paper"]["publication_date_precision"], "month")
        self.assertIn("date", {c["key"] for c in out["to_check"]})

    def test_a_journal_we_do_not_hold_asks_for_the_figures(self):
        work = openalex_work()
        work["primary_location"]["source"].update(
            display_name="Journal of Nowhere", issn_l="1234-5679", issn=["1234-5679"]
        )
        self.stub(openalex=lambda doi: work)
        out = self.lookup(DOI)
        self.assertFalse(out["metrics"]["found"])
        self.assertIn("metrics", {c["key"] for c in out["to_check"]})

    def test_a_conference_paper_is_not_asked_for_a_quartile(self):
        """A quartile is a journal's; a proceedings volume is paid on its SNIP alone."""
        work = openalex_work()
        work["primary_location"]["source"].update(
            display_name="2026 International Conference on Signals", issn_l=None, issn=[], type="conference"
        )
        self.stub(openalex=lambda doi: work)
        out = self.lookup(DOI)
        self.assertEqual(out["paper"]["publication_type"], "Conference Proceeding")
        metrics = next(c for c in out["to_check"] if c["key"] == "metrics")
        self.assertNotIn("quartile", metrics["text"].lower().replace("without a quartile", ""))
        self.assertIn("without a quartile", metrics["text"])

    def test_a_paper_you_have_already_filed_is_said(self):
        Claim.objects.create(owner=self.faculty, doi=DOI, paper_title="x", status=ClaimStatus.SUBMITTED,
                             ticket_number="T-1")
        self.stub(openalex=lambda doi: openalex_work())
        out = self.lookup(DOI)
        self.assertEqual(out["already_filed"]["ticket_number"], "T-1")

    def test_a_scopus_link_without_a_key_says_what_to_paste_instead(self):
        self.stub()
        out = self.lookup("https://www.scopus.com/record/display.uri?eid=2-s2.0-85190001234")
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "scopus_link")
        self.assertIn("DOI", out["message"])

    def test_a_link_without_a_doi_says_so(self):
        self.stub()
        out = self.lookup("https://www.sciencedirect.com/science/article/pii/S0169433224001234")
        self.assertEqual(out["code"], "bad_input")
        self.assertIn("10.", out["message"])

    def test_a_title_with_one_exact_match_is_looked_up_by_its_doi(self):
        hits = [{"doi": DOI, "title": "A Sharded Ledger for Cloud Storage", "journal": "Scientific Reports",
                 "publication_year": 2026, "authors": ["R. N. Kavitha"], "author_count": 4}]
        self.stub(openalex=lambda doi: openalex_work(), crossref_search=lambda title, limit: hits)
        out = self.lookup("a sharded ledger for cloud storage")
        self.assertTrue(out["ok"])
        self.assertEqual(out["paper"]["doi"], DOI)

    def test_a_title_that_matches_several_records_asks_which(self):
        hits = [
            {"doi": DOI, "title": "A Sharded Ledger for Cloud Storage", "journal": "Scientific Reports",
             "publication_year": 2026, "authors": ["R. N. Kavitha"], "author_count": 4},
            {"doi": "10.1038/erratum-1", "title": "A Sharded Ledger for Cloud Storage",
             "journal": "Scientific Reports", "publication_year": 2026, "authors": [], "author_count": 0},
        ]
        self.stub(openalex=lambda doi: openalex_work(), crossref_search=lambda title, limit: hits)
        out = self.lookup("A Sharded Ledger for Cloud Storage")
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "choose")
        self.assertEqual([c["doi"] for c in out["candidates"]], [DOI, "10.1038/erratum-1"])

    def test_nothing_money_bearing_is_in_the_answer(self):
        self.stub(openalex=lambda doi: openalex_work())
        text = json.dumps(self.lookup(DOI)).lower()
        for word in ("remuneration", "amount", "payout", "₹"):
            self.assertNotIn(word, text)


class CachingTests(LookupBase):
    def test_a_raw_payload_is_fetched_once(self):
        calls = []

        def fake_get(url, params=None, **kwargs):
            calls.append(url)
            return openalex_work()

        with patch.object(upstream, "get_json", fake_get):
            pl.fetch_openalex_work(DOI)
            pl.fetch_openalex_work(DOI.upper())
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].endswith(f"works/doi:{DOI}"))

    def test_a_missing_work_is_remembered_but_a_failure_is_not(self):
        calls = []

        def missing(url, params=None, **kwargs):
            calls.append(url)
            raise _status_error(404)

        with patch.object(upstream, "get_json", missing):
            self.assertIsNone(pl.fetch_openalex_work(DOI))
            self.assertIsNone(pl.fetch_openalex_work(DOI))
        self.assertEqual(len(calls), 1)

        def boom(url, params=None, **kwargs):
            calls.append(url)
            raise httpx.ConnectError("down")

        cache.clear()
        with patch.object(upstream, "get_json", boom):
            for _ in range(2):
                with self.assertRaises(httpx.ConnectError):
                    pl.fetch_openalex_work(DOI)
        self.assertEqual(len(calls), 3, "a failure is asked again next time")

    def test_requests_are_polite_and_short(self):
        seen = {}

        def capture(url, params=None, **kwargs):
            seen[url] = (params, kwargs)
            return {"message": crossref_message()} if "crossref" in url else openalex_work()

        with override_settings(OPENALEX_API_KEY="oa-key"), patch.object(upstream, "get_json", capture):
            pl.fetch_openalex_work(DOI)
            pl.fetch_crossref_work(DOI)
        for url, (params, kwargs) in seen.items():
            self.assertIn("mailto", params, url)
            self.assertLessEqual(kwargs.get("read_timeout", 99), pl.READ_TIMEOUT, url)
        openalex = next(v for k, v in seen.items() if "openalex" in k)
        self.assertEqual(openalex[0].get("api_key"), "oa-key")


# --------------------------------------------------------------------------- #
# The endpoint                                                                #
# --------------------------------------------------------------------------- #


class EndpointTests(LookupBase):
    def post(self, body, user=None):
        self.client.force_login(user or self.faculty)
        return self.client.post("/api/lookup/paper", data=json.dumps(body), content_type="application/json")

    def test_signed_out_is_refused(self):
        r = self.client.post("/api/lookup/paper", data=json.dumps({"query": DOI}),
                             content_type="application/json")
        self.assertEqual(r.status_code, 401)

    def test_a_doi_comes_back_filled_in(self):
        self.stub(openalex=lambda doi: openalex_work())
        r = self.post({"query": DOI})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["claimant"]["position"], 1)
        self.assertEqual(body["metrics"]["quartile"], "Q1")

    def test_an_unexpected_failure_is_a_sentence_not_a_500(self):
        def broken(*args, **kwargs):
            raise RuntimeError("bug")

        with patch.object(pl, "lookup", broken):
            r = self.post({"query": DOI})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["code"], "error")
        self.assertIn("by hand", body["message"])

    def test_a_head_of_department_gets_the_same_answer(self):
        head = User.objects.create_user(email="h@example.com", password="x", name="Dr. G Kavi",
                                        role=Role.HOD, department="IT")
        self.stub(openalex=lambda doi: openalex_work())
        body = self.post({"query": DOI}, user=head).json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["claimant"]["position"], 4)

    def test_filing_for_someone_else_matches_them_not_you(self):
        admin = User.objects.create_user(email="a@example.com", password="x", name="Office Person",
                                         role=Role.SUPER_ADMIN)
        self.stub(openalex=lambda doi: openalex_work())
        body = self.post({"query": DOI, "owner_id": self.faculty.id}, user=admin).json()
        self.assertEqual(body["claimant"]["position"], 1)

    def test_a_claimant_cannot_borrow_someone_elses_name(self):
        other = User.objects.create_user(email="o@example.com", password="x", name="Dr. G Kavi",
                                         role=Role.FACULTY)
        self.stub(openalex=lambda doi: openalex_work())
        body = self.post({"query": DOI, "owner_id": other.id}).json()
        self.assertEqual(body["claimant"]["position"], 1, "owner_id is ignored for a faculty member")


# --------------------------------------------------------------------------- #
# Reading an attached file before it is filed                                  #
# --------------------------------------------------------------------------- #


def _pdf(*lines: str) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    page = canvas.Canvas(buf)
    y = 800
    for line in lines:
        page.drawString(40, y, line)
        y -= 16
    page.showPage()
    page.save()
    return buf.getvalue()


class FileCheckTests(LookupBase):
    def setUp(self):
        super().setUp()
        media = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, media, ignore_errors=True)
        override = override_settings(MEDIA_ROOT=media)
        override.enable()
        self.addCleanup(override.disable)
        self.client.force_login(self.faculty)

    def store(self, data: bytes, stem: str, ext: str = "pdf") -> str:
        name = (stem * 32)[:32]
        default_storage.save(f"claims/{name}.{ext}", ContentFile(data))
        return f"/media/claims/{name}.{ext}"

    def check(self, **body):
        return self.client.post("/api/lookup/file-check", data=json.dumps(body), content_type="application/json")

    def test_the_right_paper_is_recognised(self):
        url = self.store(_pdf("A Sharded Ledger for Cloud Storage", "R N Kavitha, Saveetha Engineering College",
                              f"https://doi.org/{DOI}"), "a")
        r = self.check(url=url, kind="PUBLISHED_PAPER", title="A Sharded Ledger for Cloud Storage", doi=DOI)
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["outcome"], "MATCHED")
        self.assertIn("doi", body["found"])
        self.assertIn("affiliation", body["found"])

    def test_the_wrong_paper_is_said(self):
        url = self.store(_pdf("Some Other Paper Entirely About Soil", "Anna University"), "b")
        body = self.check(url=url, kind="PUBLISHED_PAPER", title="A Sharded Ledger for Cloud Storage",
                          doi=DOI).json()
        self.assertEqual(body["outcome"], "MISMATCH")
        self.assertIn("doi", body["missing"])
        self.assertIn("summary", body)

    def test_an_image_is_not_read(self):
        url = self.store(b"\x89PNG\r\n\x1a\n" + b"0" * 64, "c", ext="png")
        body = self.check(url=url, kind="PUBLISHED_PAPER", title="x").json()
        self.assertEqual(body["outcome"], "NOT_READ")

    def test_a_file_on_somebody_elses_claim_is_not_theirs_to_probe(self):
        other = User.objects.create_user(email="z@example.com", password="x", name="Zed", role=Role.FACULTY)
        url = self.store(_pdf("Secret"), "d")
        claim = Claim.objects.create(owner=other, paper_title="Secret", status=ClaimStatus.SUBMITTED)
        ClaimAttachment.objects.create(claim=claim, kind="PUBLISHED_PAPER", url=url, filename="s.pdf")
        r = self.check(url=url, kind="PUBLISHED_PAPER", title="Secret")
        self.assertEqual(r.status_code, 403)

    def test_a_url_that_is_not_one_of_ours_is_refused(self):
        r = self.check(url="https://evil.example/x.pdf", kind="PUBLISHED_PAPER", title="x")
        self.assertEqual(r.status_code, 400)
