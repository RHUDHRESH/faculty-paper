"""The per-paper fields in every report: Report studio, register template, files, API and statements.

Synthetic data only. Every person, paper and rupee here is made up.
"""
import csv
import io
import json
from datetime import date

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import (
    Authorship, Claim, ClaimStatus, PaidLedger, Publication, Role, SnipSource, User,
)
from core.services import api_tokens, paper_fields, report_engine, report_studio, report_templates
from core.services.normalize import normalize_title

OWNERS_LIST = [
    "Title", "Journal name", "ISSN", "Category (Engineering / Non-engineering)", "Quartile", "SNIP",
    "Total number of authors", "Author position", "Amount paid",
]
THE_REST = [
    "Faculty", "Staff ID", "Department", "Month paid", "Academic year", "DOI", "Document type",
    "Indexing (Scopus)", "Claim number", "Status", "Remark",
]


def person(email, role=Role.FACULTY, dept="CSE", staff_id=None, name=None):
    return User.objects.create_user(
        email=email, password="pw-long-enough-1", name=name or email.split("@")[0].title(), role=role,
        department=dept, staff_id=staff_id,
    )


class Fields(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.office = person("office@t.edu", Role.RESEARCH_COORDINATOR, "Research")
        cls.finance = person("fin@t.edu", Role.FINANCE, "Accounts")
        cls.hod = person("hod@t.edu", Role.HOD, "CSE")
        cls.asha = person("asha@t.edu", staff_id="S1", name="Asha Rao")
        cls.bala = person("bala@t.edu", staff_id="S2", name="Bala Iyer", dept="ECE")

        SnipSource.objects.create(title="Journal Alpha", print_issn="12345678.0", snip=1.25, year=2025)
        # One paper the college knows from its publication record: authors in Scopus order.
        pub = Publication.objects.create(
            title="Linked paper", normalized_title=normalize_title("Linked paper"), doi="10.1/linked",
            issn="1234-5678", quartile="Q2", source="record", scopus_indexed=True,
        )
        for i, who in enumerate(["Zed", cls.bala, cls.asha], start=1):
            Authorship.objects.create(
                publication=pub, position=i, display_name=getattr(who, "name", who), author_key=f"k{i}",
                user=who if isinstance(who, User) else None,
            )
        cls.claim = Claim.objects.create(
            owner=cls.asha, status=ClaimStatus.PAID, paper_title="Linked paper", journal_title="Journal Alpha",
            ticket_number="ERP-RAW-1", remuneration=11000, payout_month=date(2025, 8, 1), staff_id="S1",
            engineering_class="Engineering", quartile="Q1",
        )
        cls.l1 = PaidLedger.objects.create(
            claim=cls.claim, payout_month=date(2025, 8, 1), amount=11000, faculty_name="Asha Rao", staff_id="S1",
            department="CSE", paper_title="Linked paper", journal_title="Journal Alpha", voucher_number="V1",
            raw_json=json.dumps({"ISSN": "12345678.0", "Document Type": "Journal", "Indexing Status": "Indexed",
                                 "DOI": "10.1/linked"}),
        )
        cls.l2 = PaidLedger.objects.create(
            payout_month=date(2026, 2, 1), amount=6000, faculty_name="Bala Iyer", staff_id="S2", department="ECE",
            paper_title="Sheet only", journal_title="Journal Beta",
            raw_json=json.dumps({"ISSN": "2345-6789", "SNIP Value": "0.8", "SJR Quartile": "Q3",
                                 "Engineering Classification": "Non-Engineering", "Total No of Authors": "3",
                                 "Author Position": "2", "Document Type": "Conference Proceeding",
                                 "Indexing Status": "Not yet indexed", "DOI": "10.2/sheet",
                                 "col24": "Student Publication. No Remuneration. Only for count"}),
        )
        cls.l3 = PaidLedger.objects.create(
            payout_month=date(2026, 3, 1), amount=0, faculty_name="Asha Rao", staff_id="S1", department="CSE",
            paper_title="Nothing known", raw_json=json.dumps({"SNIP Value": "N/A", "SJR Quartile": "Others"}),
        )

    def setUp(self):
        cache.clear()

    def rows(self, user, **definition):
        return report_engine.run(user, definition)["rows"]

    def by_title(self, user, dataset, columns):
        out = self.rows(user, dataset=dataset, columns=["paper", *columns], limit=100)
        return {r["paper"]: r for r in out}


class StudioFieldTests(Fields):
    def test_payments_carry_the_owners_list_typed(self):
        described = report_engine.ds_mod.DATASETS["payments"].describe(report_engine.ds_mod.viewer_for(self.office))
        fields = {f["label"]: f for f in described["fields"]}
        for label in OWNERS_LIST + THE_REST:
            self.assertIn(label, fields, label)
        self.assertEqual(fields["Amount paid"]["type"], "money")
        for label in ("SNIP", "Total number of authors", "Author position"):
            self.assertEqual(fields[label]["type"], "number", label)
        self.assertEqual(fields["Quartile"]["enum_values"], ["Q1", "Q2", "Q3", "Q4"])
        self.assertEqual(fields["Category (Engineering / Non-engineering)"]["enum_values"],
                         ["Engineering", "Non-engineering"])

    def test_claims_carry_them_too(self):
        described = report_engine.ds_mod.DATASETS["claims"].describe(report_engine.ds_mod.viewer_for(self.office))
        labels = {f["label"] for f in described["fields"]}
        for label in OWNERS_LIST + ["Faculty", "Staff ID", "Department", "Month paid", "Academic year", "DOI",
                                    "Document type", "Indexing (Scopus)", "Claim number", "Status", "Remark"]:
            self.assertIn(label, labels, label)

    def test_a_row_has_the_same_values_in_the_studio_the_resolver_and_the_statement(self):
        got = self.by_title(self.office, "payments", [
            "issn", "category", "quartile", "snip", "total_authors", "author_position", "doi", "document_type",
            "indexing", "claim_no", "status", "remark",
        ])
        sheet = got["Sheet only"]
        self.assertEqual(
            (sheet["issn"], sheet["category"], sheet["quartile"], sheet["snip"], sheet["total_authors"],
             sheet["author_position"], sheet["doi"], sheet["document_type"], sheet["indexing"], sheet["status"]),
            ("2345-6789", "Non-engineering", "Q3", 0.8, 3, 2, "10.2/sheet", "Conference Proceeding",
             "Not yet indexed", "Paid"),
        )
        self.assertEqual(sheet["remark"], "Student Publication. No Remuneration. Only for count")
        linked = got["Linked paper"]
        self.assertEqual(linked["claim_no"], "ERP-RAW-1")
        # Claim first (Q1, not the publication's Q2); the claim's 1 of 1 default is not a fact, so the
        # publication's Scopus order answers: 3 authors, and Asha is the third.
        self.assertEqual((linked["quartile"], linked["total_authors"], linked["author_position"]), ("Q1", 3, 3))
        self.assertEqual((linked["issn"], linked["snip"], linked["indexing"]), ("1234-5678", 1.25, "Indexed"))
        # The same answer from the resolver and from the statement.
        self.assertEqual(paper_fields.for_ledger_row(self.l1)["quartile"], linked["quartile"])
        from core.services import payout_statement

        line = next(r for r in payout_statement.statement("2025-08")["rows"] if r["ledger_id"] == self.l1.pk)
        for key in ("issn", "quartile", "snip", "total_authors", "author_position", "category"):
            self.assertEqual(line["figures"][key], linked[key], key)
        self.assertEqual(line["figures"]["academic_year"], "2025-26")

    def test_unknown_is_empty_never_a_word(self):
        row = self.by_title(self.office, "payments", ["quartile", "snip", "category", "total_authors", "remark"])[
            "Nothing known"]
        for key in ("quartile", "snip", "category", "total_authors", "remark"):
            self.assertIsNone(row[key], key)

    def test_filter_group_and_sort_on_a_resolved_field(self):
        q3 = self.rows(self.office, dataset="payments", columns=["paper"],
                       filters=[{"field": "quartile", "op": "eq", "value": "Q3"}])
        self.assertEqual([r["paper"] for r in q3], ["Sheet only"])
        grouped = self.rows(self.office, dataset="payments", group_by=["category"],
                            aggregates=[{"field": "amount", "fn": "sum"}])
        self.assertIn({"category": "Non-engineering", "sum_amount": 6000.0}, grouped)
        self.assertIn({"category": "Engineering", "sum_amount": 11000.0}, grouped)
        top = self.rows(self.office, dataset="payments", columns=["paper", "snip"],
                        filters=[{"field": "snip", "op": "not_empty"}], sort=[{"field": "snip", "dir": "desc"}])
        self.assertEqual([r["paper"] for r in top], ["Linked paper", "Sheet only"])
        avg = self.rows(self.office, dataset="payments", aggregates=[{"field": "snip", "fn": "avg"}])
        self.assertAlmostEqual(avg[0]["avg_snip"], (1.25 + 0.8) / 2, places=3)

    def test_claims_quartile_still_groups_and_falls_back_to_the_publication(self):
        blank = Claim.objects.create(owner=self.asha, status=ClaimStatus.SUBMITTED, paper_title="Linked paper",
                                     ticket_number="FP-9", authors_json='["Asha Rao"]')
        out = {r["claim_no"]: r for r in self.rows(self.office, dataset="claims", columns=["claim_no", "quartile"])}
        self.assertEqual(out["FP-9"]["quartile"], "Q2")
        self.assertEqual(out["ERP-RAW-1"]["quartile"], "Q1")
        grouped = self.rows(self.office, dataset="claims", group_by=["quartile"])
        self.assertEqual({r["quartile"]: r["count"] for r in grouped}, {"Q1": 1, "Q2": 1})
        blank.delete()


class RegisterTemplateTests(Fields):
    def test_the_register_has_the_owners_columns_in_the_owners_order(self):
        templates = {t["key"]: t for t in report_templates.for_user(self.office)}
        register = templates["paid-papers-register"]
        self.assertEqual(register["name"], "Paid papers register")
        result = report_engine.run(self.office, register["definition"])
        self.assertEqual([c["label"] for c in result["columns"]], OWNERS_LIST + THE_REST)
        self.assertEqual(result["total_rows"], 3)

    def test_the_file_ends_with_a_total_and_an_average(self):
        definition = {r["key"]: r for r in report_templates.for_user(self.office)}["paid-papers-register"]["definition"]
        body, _name, _ctype, _result = report_studio.render_file(self.office, definition, "csv", "Paid papers register")
        rows = list(csv.reader(io.StringIO(body.decode("utf-8-sig"))))
        header = next(i for i, r in enumerate(rows) if r and r[0] == "Title")
        self.assertEqual(rows[header][:9], OWNERS_LIST)
        total, average = rows[-2], rows[-1]
        self.assertEqual(total[0], "Total of 3 rows")
        self.assertEqual(float(total[OWNERS_LIST.index("Amount paid")]), 17000.0)
        self.assertAlmostEqual(float(total[OWNERS_LIST.index("SNIP")]), 2.05, places=3)
        self.assertEqual(average[0], "Average")
        self.assertAlmostEqual(float(average[OWNERS_LIST.index("SNIP")]), 1.025, places=3)
        self.assertAlmostEqual(float(average[OWNERS_LIST.index("Amount paid")]), 17000 / 3, places=1)

    def test_a_head_of_department_is_not_offered_it_and_gets_no_amount_anywhere(self):
        keys = {t["key"] for t in report_templates.for_user(self.hod)}
        self.assertNotIn("paid-papers-register", keys)
        with self.assertRaises(report_engine.ReportError) as ctx:
            report_engine.run(self.hod, {"dataset": "payments"})
        self.assertEqual(ctx.exception.status, 403)
        described = report_engine.ds_mod.DATASETS["claims"].describe(report_engine.ds_mod.viewer_for(self.hod))
        labels = {f["label"] for f in described["fields"]}
        for money in ("Amount", "Amount paid", "Month paid", "Academic year", "Paid on"):
            self.assertNotIn(money, labels, money)
        for kept in ("Title", "Quartile", "SNIP", "Total number of authors", "Author position", "ISSN"):
            self.assertIn(kept, labels, kept)
        for field in ("amount_paid", "month_paid"):
            with self.assertRaisesMessage(report_engine.ReportError, "do not see money"):
                report_engine.run(self.hod, {"dataset": "claims", "columns": [field]})

    def test_a_faculty_member_sees_only_their_own_rows_with_the_same_figures(self):
        out = self.by_title(self.bala, "payments", ["quartile", "category"])
        self.assertEqual(set(out), {"Sheet only"})
        self.assertEqual(out["Sheet only"]["quartile"], "Q3")


class ApiTests(Fields):
    def get(self, user, path):
        _token, secret = api_tokens.create(user, "t", api_tokens.scopes_for_role(user.role), None)
        return Client().get(path, HTTP_AUTHORIZATION=f"Bearer {secret}")

    def test_payments_feed_has_the_fields_and_hides_the_amount_from_nobody_who_may_see_it(self):
        body = self.get(self.office, "/api/v1/payments?page_size=50").json()
        rows = {r["title"]: r for r in body["data"]}
        sheet = rows["Sheet only"]
        for key in ("issn", "category", "quartile", "snip", "total_authors", "author_position", "doi",
                    "document_type", "indexing", "claim_no", "status", "remark", "academic_year", "amount"):
            self.assertIn(key, sheet, key)
        self.assertEqual((sheet["quartile"], sheet["category"], sheet["academic_year"], sheet["amount"]),
                         ("Q3", "Non-engineering", "2025-26", 6000))
        self.assertIsNone(rows["Nothing known"]["quartile"])
        self.assertEqual(rows["Linked paper"]["total_authors"], 3)

    def test_claims_feed_agrees_with_the_studio(self):
        body = self.get(self.office, "/api/v1/claims").json()
        row = next(r for r in body["data"] if r["claim_no"] == "ERP-RAW-1")
        self.assertEqual((row["quartile"], row["total_authors"], row["author_position"], row["issn"]),
                         ("Q1", 3, 3, "1234-5678"))
        studio = self.by_title(self.office, "claims", ["quartile", "total_authors"])["Linked paper"]
        self.assertEqual((studio["quartile"], studio["total_authors"]), (row["quartile"], row["total_authors"]))

    def test_a_head_gets_the_claims_without_money_and_is_refused_the_payments(self):
        body = self.get(self.hod, "/api/v1/claims").json()
        for r in body["data"]:
            self.assertNotIn("amount", r)
            self.assertNotIn("paid_on", r)
            self.assertIn("quartile", r)
        self.assertEqual(self.get(self.hod, "/api/v1/payments").status_code, 403)

    def test_the_meta_lists_the_new_fields(self):
        meta = self.get(self.office, "/api/v1/meta").json()
        payments = next(e for e in meta["endpoints"] if e["name"] == "payments")
        names = {f["name"] for f in payments["fields"]}
        self.assertTrue({"issn", "category", "quartile", "snip", "total_authors", "author_position"} <= names)


class FilesAndRegisterTests(Fields):
    def test_the_claims_export_names_the_two_categories_apart(self):
        from core.api.dashboard import _EXPORT_HEADERS

        self.assertIn("Category (Engineering / Non-engineering)", _EXPORT_HEADERS)
        self.assertIn("Pricing category", _EXPORT_HEADERS)
        self.assertNotIn("Category", _EXPORT_HEADERS)
        for name in OWNERS_LIST[:8] + ["Title"]:
            self.assertIn(name.replace("Journal name", "Journal name"), _EXPORT_HEADERS + ["Amount paid"])

    def test_the_claims_export_row_uses_the_resolver(self):
        from core.api.dashboard import _EXPORT_HEADERS, _export_row

        row = dict(zip(_EXPORT_HEADERS, _export_row(Claim.objects.get(pk=self.claim.pk))))
        self.assertEqual((row["Quartile"], row["SNIP"], row["Total number of authors"], row["Author position"]),
                         ("Q1", 1.25, 3, 3))
        self.assertEqual(row["Category (Engineering / Non-engineering)"], "Engineering")
        self.assertEqual((row["Amount paid"], row["Month paid"], row["Academic year"]), (11000, "2025-08", "2025-26"))

    def test_the_paid_register_rows_carry_the_figures(self):
        client = Client()
        client.force_login(self.finance)
        body = client.get("/api/admin/payouts", {"status": "PAID"}).json()
        figures = next(r["figures"] for r in body["results"] if r["id"] == self.claim.pk)
        self.assertEqual((figures["quartile"], figures["snip"], figures["total_authors"], figures["author_position"],
                          figures["category"], figures["academic_year"]), ("Q1", 1.25, 3, 3, "Engineering", "2025-26"))

    def test_the_statement_lines_carry_the_figures(self):
        client = Client()
        client.force_login(self.finance)
        st = client.get("/api/payouts/statement", {"month": "2026-02"}).json()
        line = st["rows"][0]
        self.assertEqual((line["figures"]["quartile"], line["figures"]["category"], line["figures"]["total_authors"]),
                         ("Q3", "Non-engineering", 3))


class LedgerTests(Fields):
    def test_the_ledger_rows_and_file_carry_the_figures(self):
        client = Client()
        client.force_login(self.finance)
        body = client.get("/api/admin/ledger").json()
        row = next(r for r in body["results"] if r["paper_title"] == "Sheet only")
        self.assertEqual((row["figures"]["quartile"], row["figures"]["category"], row["figures"]["academic_year"]),
                         ("Q3", "Non-engineering", "2025-26"))
        linked = next(r for r in body["results"] if r["paper_title"] == "Linked paper")
        self.assertEqual(linked["claim_no"], "ERP-RAW-1")
        file = client.get("/api/admin/ledger/export")
        rows = list(csv.reader(io.StringIO(file.content.decode("utf-8-sig"))))
        head = rows[0]
        # The original columns keep their places; the figures come after.
        self.assertEqual(head[:3], ["payout_month", "department", "faculty_name"])
        self.assertEqual(head[head.index("scheme") + 1:][:3], ["ISSN", "Category (Engineering / Non-engineering)", "Quartile"])
        line = dict(zip(head, next(r for r in rows[1:] if r[head.index("paper_title")] == "Sheet only")))
        self.assertEqual((line["Quartile"], line["SNIP"], line["Total number of authors"], line["Author position"]),
                         ("Q3", "0.8", "3", "2"))
        blank = dict(zip(head, next(r for r in rows[1:] if r[head.index("paper_title")] == "Nothing known")))
        self.assertEqual((blank["Quartile"], blank["SNIP"], blank["Category (Engineering / Non-engineering)"]), ("", "", ""))
