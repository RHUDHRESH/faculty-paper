"""The per-paper resolver: one answer for every report. Synthetic data only."""
import json
from datetime import date

from django.test import SimpleTestCase, TestCase

from core.models import (
    Authorship, Claim, ClaimReason, ClaimStatus, PaidLedger, Publication, Role, ScimagoJournal, SnipSource, User,
)
from core.services import paper_fields, top5


def person(email="a@t.edu", staff_id="T001", name="Asha Rao"):
    return User.objects.create_user(
        email=email, password="p", name=name, role=Role.FACULTY, department="CSE", staff_id=staff_id,
    )


def row(raw=None, *, claim=None, staff_id="T001", title="A paper", journal=None, amount=1000.0):
    return PaidLedger.objects.create(
        payout_month=date(2025, 5, 1), amount=amount, staff_id=staff_id, faculty_name="Asha Rao",
        paper_title=title, journal_title=journal, claim=claim,
        raw_json=json.dumps(raw) if raw is not None else None,
    )


def pub(title="A paper", doi=None, authors=(), **extra):
    from core.services.normalize import normalize_title

    p = Publication.objects.create(
        title=title, normalized_title=normalize_title(title), doi=doi, source="record", **extra,
    )
    for i, who in enumerate(authors, start=1):
        Authorship.objects.create(
            publication=p, position=i, display_name=getattr(who, "name", who), author_key=f"n:{i}{title}",
            user=who if isinstance(who, User) else None,
        )
    return p


class SnipRuleTests(SimpleTestCase):
    def test_one_rule_for_the_resolver_and_the_boards(self):
        good = ["0.475", 1.2, "2", " 3.5 "]
        bad = ["N/A", "-", "", None, 0, "0", "0.0", -1, True, "abc", float("inf"), "nan"]
        for v in good:
            self.assertEqual(paper_fields.parse_snip(v), float(str(v).strip()))
            self.assertEqual(top5._snip(v), paper_fields.parse_snip(v))
        for v in bad:
            self.assertIsNone(paper_fields.parse_snip(v), v)
            self.assertIsNone(top5._snip(v), v)

    def test_raw_snip_reads_the_sheet_key_and_its_spellings(self):
        self.assertEqual(paper_fields.raw_snip('{"SNIP Value": "0.475"}'), 0.475)
        self.assertEqual(paper_fields.raw_snip('{"snip": 1.5}'), 1.5)
        self.assertIsNone(paper_fields.raw_snip('{"SNIP Value": "N/A"}'))
        self.assertIsNone(paper_fields.raw_snip("not json SNIP"))
        self.assertIsNone(paper_fields.raw_snip(None))


class Precedence(TestCase):
    def test_claim_beats_the_sheet_beats_the_publication_beats_the_journal_tables(self):
        me = person()
        SnipSource.objects.create(title="Journal Z", print_issn="12345678.0", snip=9.0, year=2025)
        pub("A paper", doi="10.1/x", authors=[me], issn="1234-5678", quartile="Q4", venue="Pub Venue")
        c = Claim.objects.create(
            owner=me, status=ClaimStatus.PAID, paper_title="A paper", journal_title="Claim Journal",
            issn="1234-5678", quartile="Q1", snip=1.5, engineering_class="Engineering", total_authors=3,
            author_position=2, doi="10.1/x", authors_json="[]x",
        )
        r = row(
            {"SJR Quartile": "Q2", "SNIP Value": "2.5", "Engineering Classification": "Non-Engineering",
             "Total No of Authors": "9", "Author Position": "8", "Source Title": "Sheet Journal"},
            claim=c, journal="Ledger Journal",
        )
        got = paper_fields.for_ledger_row(r)
        self.assertEqual(
            (got["quartile"], got["snip"], got["category"], got["total_authors"], got["author_position"],
             got["journal"]),
            ("Q1", 1.5, "Engineering", 3, 2, "Claim Journal"),
        )
        # The claim alone says the same: one paper, one answer.
        self.assertEqual(paper_fields.for_claim(c)["snip"], 1.5)

    def test_a_blank_claim_falls_to_the_sheet_then_the_publication_then_the_journal(self):
        me = person()
        c = Claim.objects.create(owner=me, status=ClaimStatus.PAID, paper_title="A paper", ticket_number="ERP-X-1")
        r = row({"SJR Quartile": "Q3", "ISSN": "1234567.0"}, claim=c)
        pub("A paper", authors=[me, "Other One"], issn="1234-5678", quartile="Q4", **{"type": "article"})
        SnipSource.objects.create(title="Journal Z", print_issn="01234567.0", snip=1.25, year=2024)
        SnipSource.objects.create(title="Journal Z", print_issn="01234567.0", snip=1.75, year=2025)
        got = paper_fields.for_ledger_row(r)
        self.assertEqual(got["quartile"], "Q3")               # the sheet, not the publication's Q4
        self.assertEqual(got["issn"], "0123-4567")            # the sheet's float-mangled ISSN, repaired
        self.assertEqual(got["snip"], 1.75)                   # the journal table, newest year, by ISSN
        self.assertEqual((got["total_authors"], got["author_position"]), (2, 1))  # the publication's order
        self.assertEqual(got["document_type"], "Article")

    def test_scimago_gives_quartile_and_category_when_nothing_else_does(self):
        r = row({"ISSN": "2345-6789"}, title="Nothing known")
        ScimagoJournal.objects.create(
            title="Journal S", issn="2345-6789", year=2025, sjr=1.0,
            categories_json=json.dumps([{"category": "Computer Science (miscellaneous)", "quartile": "Q2"},
                                        {"category": "Medicine", "quartile": "Q1"}]),
        )
        got = paper_fields.for_ledger_row(r)
        self.assertEqual((got["quartile"], got["category"], got["journal"]), ("Q1", "Engineering", "Journal S"))

    def test_nothing_known_is_none_never_a_word(self):
        got = paper_fields.for_ledger_row(row({"SNIP Value": "N/A", "SJR Quartile": "Others", "ISSN": "N/A",
                                               "Engineering Classification": "-", "DOI": "-"}, title="Lonely"))
        for name in ("issn", "category", "quartile", "snip", "total_authors", "author_position", "doi",
                     "document_type", "indexing", "remark"):
            self.assertIsNone(got[name], name)
        self.assertEqual(got["title"], "Lonely")


class SheetKeys(TestCase):
    def test_key_variants_and_value_shapes(self):
        variants = [
            {"Total No of Authors": "04", "Author Position": "01"},
            {"No. of Authors": 4.0, "Author position": "1.0"},
            {"Number of Authors": "4", "Position of Author": 1},
        ]
        for raw in variants:
            with self.subTest(raw=raw):
                got = paper_fields.for_ledger_row(row(raw))
                self.assertEqual((got["total_authors"], got["author_position"]), (4, 1))

    def test_author_position_points_is_not_the_position(self):
        got = paper_fields.for_ledger_row(row({"Author Position Points": "0.4"}))
        self.assertIsNone(got["author_position"])

    def test_the_shifted_block_holds_the_author_count_under_amount(self):
        shifted = {"Amount": "4.0", "col22": "3.0", "col23": "0.2", "col24": "Processed for Remuneration",
                   "col27": "21979.0"}
        got = paper_fields.for_ledger_row(row(shifted, amount=21979.0))
        self.assertEqual((got["total_authors"], got["author_position"]), (4, 3))
        self.assertEqual(got["remark"], "Processed for Remuneration")
        # Without col27 the same "Amount" is money, not a count.
        got = paper_fields.for_ledger_row(row({"Amount": "4.0"}))
        self.assertIsNone(got["total_authors"])

    def test_the_sheets_other_columns(self):
        got = paper_fields.for_ledger_row(row({
            "ISSN": "23488549.0", "SNIP Value": "0.074", "SJR Quartile": "Q4", "Document Type": "Journal",
            "Indexing Status": "Not yet indexed", "DOI": "https://doi.org/10.1/ABC",
            "Engineering Classification": "Non-Engineering",
        }))
        self.assertEqual(
            (got["issn"], got["snip"], got["quartile"], got["document_type"], got["indexing"], got["doi"],
             got["category"]),
            ("2348-8549", 0.074, "Q4", "Journal", "Not yet indexed", "10.1/abc", "Non-engineering"),
        )

    def test_others_and_no_quartile_are_not_quartiles(self):
        for word in ("Others", "No Quartile", "-", "Q5"):
            self.assertIsNone(paper_fields.for_ledger_row(row({"SJR Quartile": word}))["quartile"], word)


class AuthorsFromThePublication(TestCase):
    def test_total_and_position_come_from_the_authorship_matched_by_doi_then_title(self):
        me, other = person(), person("b@t.edu", "T002", "Bala Iyer")
        pub("First", doi="10.9/one", authors=["Z", other, me, "Y"])
        pub("Second paper", authors=[other, me])
        by_doi = paper_fields.for_ledger_row(row({"DOI": "10.9/one"}, title="x"))
        by_title = paper_fields.for_ledger_row(row({}, title="Second  Paper!"))
        self.assertEqual((by_doi["total_authors"], by_doi["author_position"]), (4, 3))
        self.assertEqual((by_title["total_authors"], by_title["author_position"]), (2, 2))

    def test_an_import_default_of_one_of_one_is_not_a_fact(self):
        me = person()
        c = Claim.objects.create(owner=me, status=ClaimStatus.PAID, paper_title="Solo?", ticket_number="ERP-RAW-9")
        self.assertEqual((c.total_authors, c.author_position), (1, 1))
        got = paper_fields.for_claim(c)
        self.assertEqual((got["total_authors"], got["author_position"]), (None, None))
        pub("Solo?", authors=[me, "B"])
        got = paper_fields.for_claim(c)
        self.assertEqual((got["total_authors"], got["author_position"]), (2, 1))

    def test_a_filed_claim_with_authors_listed_keeps_its_one_of_one(self):
        me = person()
        c = Claim.objects.create(owner=me, status=ClaimStatus.SUBMITTED, paper_title="Solo", ticket_number="FP-1",
                                 authors_json='["Asha Rao"]')
        self.assertEqual(
            (paper_fields.for_claim(c)["total_authors"], paper_fields.for_claim(c)["author_position"]), (1, 1))

    def test_a_person_not_on_the_paper_gets_a_count_and_no_position(self):
        pub("Others only", authors=["P", "Q"])
        got = paper_fields.for_ledger_row(row({}, title="Others only", staff_id="NOBODY"))
        self.assertEqual((got["total_authors"], got["author_position"]), (2, None))


class Categories(TestCase):
    def test_engineering_and_non_engineering(self):
        for given, want in (("Engineering", "Engineering"), ("Non-Engineering", "Non-engineering"),
                            ("non engineering", "Non-engineering"), ("-", None), ("", None), ("Pending", None)):
            got = paper_fields.for_ledger_row(row({"Engineering Classification": given}))["category"]
            self.assertEqual(got, want, given)

    def test_the_colleges_rule_is_applied_to_subject_areas_when_nothing_classified_it(self):
        eng = paper_fields.for_ledger_row(row({"Subject Area": "Control and Systems Engineering (Q3)",
                                               "Document Type": "Journal"}))
        non = paper_fields.for_ledger_row(row({"Subject Area": "Medicine (Q1); Nursing", "Document Type": "Journal"}))
        conf = paper_fields.for_ledger_row(row({"Subject Area": "Medicine (Q1)", "Document Type": "Conference Proceeding"}))
        self.assertEqual((eng["category"], non["category"], conf["category"]),
                         ("Engineering", "Non-engineering", "Engineering"))


class Remarks(TestCase):
    def test_the_sheets_remark_and_what_the_claim_says(self):
        me = person()
        c = Claim.objects.create(owner=me, status=ClaimStatus.PAID, paper_title="S", is_student_publication=True,
                                 claim_reason=ClaimReason.COUNT_ONLY, ticket_number="FP-2", authors_json="x")
        got = paper_fields.for_ledger_row(row({"col24": "Student Publication. No Remuneration. Only for count"}, claim=c))
        self.assertEqual(got["remark"], "Student Publication. No Remuneration. Only for count")
        # A claim read on its own, with no payment sheet row, says it in its own words.
        lone = Claim.objects.create(owner=me, status=ClaimStatus.SUBMITTED, paper_title="T", is_student_publication=True,
                                    claim_reason=ClaimReason.COUNT_ONLY, ticket_number="FP-3", authors_json="x")
        self.assertEqual(paper_fields.for_claim(lone)["remark"], "Count only. Student publication")
        # With its payment, the sheet's own remark is the remark.
        self.assertEqual(paper_fields.for_claim(c)["remark"], "Student Publication. No Remuneration. Only for count")

    def test_nothing_to_remark_is_none(self):
        self.assertIsNone(paper_fields.for_ledger_row(row({"Status": None}))["remark"])


class TopFiveAgrees(TestCase):
    def test_the_boards_and_the_resolver_give_one_snip(self):
        for raw, want in (({"SNIP Value": "0.475"}, 0.475), ({"SNIP Value": "N/A"}, None), ({"SNIP Value": "0"}, None)):
            r = row(raw)
            self.assertEqual(paper_fields.for_ledger_row(r)["snip"], want)
            self.assertEqual(top5._raw_snip(r.raw_json), want)


class Batch(TestCase):
    def test_many_rows_take_a_handful_of_queries(self):
        me = person()
        rows = [row({"ISSN": f"{1000 + i % 5}-0000", "DOI": f"10.1/{i}"}, title=f"Paper {i}") for i in range(60)]
        with self.assertNumQueries(6):
            out = paper_fields.for_ledger_rows(rows)
        self.assertEqual(len(out), 60)
