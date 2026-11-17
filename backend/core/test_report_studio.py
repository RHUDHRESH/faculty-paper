"""The Report studio's datasets and engine: whitelists, aggregates, pivots and who sees what.

Synthetic data only. Every person, paper and rupee here is made up.
"""
from datetime import date, timedelta

from django.test import TestCase
from django.utils import timezone

from core.models import (
    Authorship, Claim, ClaimStatus, FacultyMaster, PaidLedger, Publication, PublicationMetrics, Role,
    SnipSource, Team, TeamMember, User,
)
from core.services import report_datasets, report_engine
from core.services.report_engine import ReportError


def person(email, name, role=Role.FACULTY, dept="CSE", staff_id=None, **extra):
    return User.objects.create_user(
        email=email, password="p", name=name, role=role, department=dept,
        staff_id=staff_id or email.split("@")[0].upper(), **extra,
    )


def paper(title, year, authors, *, venue="Journal of Tests", issn="1234-5678", quartile="Q1",
          citations=0, scopus=False, when=None):
    p = Publication.objects.create(
        title=title, year=year, date=when or date(year, 6, 15), venue=venue, issn=issn,
        quartile=quartile, citations=citations, scopus_indexed=scopus, source="record",
    )
    for i, who in enumerate(authors, start=1):
        Authorship.objects.create(
            publication=p, position=i, display_name=who.name, author_key=f"n:{who.name.lower()}",
            user=who, is_college=True,
        )
    return p


def claim(owner, status, amount=None, *, title="A paper", ticket=None, filed_days_ago=None, **extra):
    submitted = timezone.now() - timedelta(days=filed_days_ago) if filed_days_ago is not None else None
    return Claim.objects.create(
        owner=owner, status=status, remuneration=amount, paper_title=title,
        ticket_number=ticket, submitted_at=submitted, **extra,
    )


def ledger(owner_name, dept, month, amount, **extra):
    return PaidLedger.objects.create(
        payout_month=month, amount=amount, faculty_name=owner_name, department=dept,
        paper_title=extra.pop("paper_title", "Ledger paper"), **extra,
    )


class Studio(TestCase):
    """A small college: three departments, a head, a few papers and rupees."""

    @classmethod
    def setUpTestData(cls):
        cls.office = person("office@t.edu", "Office Person", Role.RESEARCH_COORDINATOR, dept="Research")
        cls.finance = person("fin@t.edu", "Finance Person", Role.FINANCE, dept="Accounts")
        cls.principal = person("prin@t.edu", "Principal Person", Role.PRINCIPAL, dept="Admin")
        cls.admin = person("root@t.edu", "Root Admin", Role.SUPER_ADMIN, dept="Admin")
        cls.hod = person("hod@t.edu", "Head Cse", Role.HOD, dept="CSE")
        cls.priya = person("priya@t.edu", "Priya Raman", dept="CSE", scopus_author_id="5701", designation="Professor")
        cls.arun = person("arun@t.edu", "Arun Kumar", dept="CSE", designation="Assistant Professor")
        cls.meera = person("meera@t.edu", "Meera Das", dept="ECE", scopus_author_id="5702", designation="Professor",
                           faculty_type="RESEARCH")
        cls.old = person("old@t.edu", "Gone Person", dept="CSE", active=False)

        SnipSource.objects.create(title="Journal of Tests", print_issn="1234-5678", snip=1.8, sjr=0.9, year=2025)
        cls.p1 = paper("Graph methods", 2025, [cls.priya, cls.arun], citations=10, scopus=True)
        cls.p2 = paper("Signal paths", 2025, [cls.meera], quartile="Q2", citations=4, issn="9999-0000",
                       venue="Other Journal")
        cls.p3 = paper("Older work", 2023, [cls.priya], quartile="", citations=1, issn="")
        PublicationMetrics.objects.create(user=cls.priya, total_publications=2, total_citations=11, h_index=2)

        cls.c1 = claim(cls.priya, ClaimStatus.PAID, 20000, title="Graph methods", ticket="FP-1",
                       filed_days_ago=40, quartile="Q1", snip=1.8, paid_at=timezone.now())
        cls.c2 = claim(cls.arun, ClaimStatus.SUBMITTED, 15000, title="Draft thoughts", ticket="FP-2",
                       filed_days_ago=12, quartile="Q2", snip=1.1)
        cls.c3 = claim(cls.meera, ClaimStatus.CLEARED, 9000, title="Signal paths", ticket="FP-3",
                       filed_days_ago=5, quartile="Q2", snip=0.7)
        cls.c4 = claim(cls.priya, ClaimStatus.DRAFT, None, title="Half typed")
        cls.c5 = claim(cls.arun, ClaimStatus.DIRECTOR_APPROVED, 12000, title="Authorised one", ticket="FP-5",
                       filed_days_ago=20, quartile="Q1", snip=2.4)

        ledger("Priya Raman", "CSE", date(2025, 4, 1), 20000, claim=cls.c1, staff_id="PRIYA")
        ledger("Arun Kumar", "CSE", date(2025, 4, 1), 5000, staff_id="ARUN")
        ledger("Meera Das", "ECE", date(2025, 7, 1), 8000, staff_id="MEERA")
        ledger("Meera Das", "ECE", date(2026, 2, 1), 3000, staff_id="MEERA")

        cls.team = Team.objects.create(code="T1", title="Smart grid", department="CSE", academic_year="2025-26",
                                       mentor=cls.priya, mentor_name="Priya Raman")
        TeamMember.objects.create(team=cls.team, name="S One", register_number="R1")
        TeamMember.objects.create(team=cls.team, name="S Two", register_number="R2")
        Team.objects.create(code="T2", title="Crop sensing", department="ECE", academic_year="2025-26",
                            mentor_name="Meera Das")
        claim(cls.priya, ClaimStatus.SUBMITTED, 4000, title="Smart grid article", ticket="FP-6", filed_days_ago=3,
              team=cls.team, doi="10.1/grid")

    def run_as(self, user, **definition):
        return report_engine.run(user, definition)

    def rows(self, user, **definition):
        return self.run_as(user, **definition)["rows"]


class WhitelistTests(Studio):
    def test_unknown_dataset_field_and_op_are_refused_with_a_sentence(self):
        with self.assertRaisesMessage(ReportError, "no dataset 'users'"):
            self.run_as(self.office, dataset="users")
        with self.assertRaisesMessage(ReportError, "no field 'password'"):
            self.run_as(self.office, dataset="faculty", columns=["name", "password"])
        with self.assertRaisesMessage(ReportError, "no field 'owner__password'"):
            self.run_as(self.office, dataset="claims", filters=[{"field": "owner__password", "op": "eq", "value": "x"}])
        with self.assertRaisesMessage(ReportError, "not a filter operator"):
            self.run_as(self.office, dataset="faculty", filters=[{"field": "name", "op": "regex", "value": ".*"}])
        with self.assertRaisesMessage(ReportError, "cannot be filtered with 'contains'"):
            self.run_as(self.office, dataset="faculty", filters=[{"field": "citations", "op": "contains", "value": 1}])
        with self.assertRaisesMessage(ReportError, "no field 'no_such'"):
            self.run_as(self.office, dataset="faculty", group_by=["no_such"])

    def test_sql_in_a_value_is_just_text(self):
        got = self.rows(self.office, dataset="faculty", columns=["name"],
                        filters=[{"field": "name", "op": "eq", "value": "x'; DROP TABLE core_user; --"}])
        self.assertEqual(got, [])
        self.assertTrue(User.objects.exists())

    def test_bad_values_and_shapes_are_refused(self):
        bad = [
            {"dataset": "claims", "filters": [{"field": "amount", "op": "gt", "value": "lots"}]},
            {"dataset": "claims", "filters": [{"field": "filed", "op": "gt", "value": "tomorrow"}]},
            {"dataset": "claims", "filters": [{"field": "amount", "op": "between", "value": [1]}]},
            {"dataset": "claims", "filters": [{"field": "status", "op": "in", "value": []}]},
            {"dataset": "claims", "group_by": ["status", "stage", "department", "quartile"]},
            {"dataset": "claims", "limit": 20001},
            {"dataset": "claims", "limit": 0},
            {"dataset": "claims", "date_bucket": "decade", "group_by": ["filed"]},
            {"dataset": "claims", "date_bucket": "month", "group_by": ["status"]},
            {"dataset": "claims", "aggregates": [{"field": "status", "fn": "sum"}]},
            {"dataset": "claims", "aggregates": [{"field": "amount", "fn": "median"}]},
            {"dataset": "claims", "aggregates": [{"fn": "sum"}]},
            {"dataset": "claims", "top_n": 5},
            {"dataset": "claims", "sort": [{"field": "amount", "dir": "up"}]},
            {"dataset": "claims", "group_by": ["status"], "sort": [{"field": "amount", "dir": "asc"}]},
            {"dataset": "claims", "pivot": {"rows": "status", "columns": "status", "value": {"fn": "count"}}},
            {"dataset": "claims", "pivot": {"rows": "status", "columns": "department", "value": {"fn": "count"}},
             "group_by": ["status"]},
            "not a dict",
        ]
        for definition in bad:
            with self.subTest(definition=definition), self.assertRaises(ReportError):
                report_engine.run(self.office, definition)

    def test_a_python_field_can_only_be_a_column(self):
        with self.assertRaises(ReportError):
            self.run_as(self.office, dataset="faculty", group_by=["date_of_joining"])
        with self.assertRaises(ReportError):
            self.run_as(self.office, dataset="faculty", filters=[{"field": "date_of_joining", "op": "is_empty"}])


class RowsTests(Studio):
    def test_default_columns_and_the_shape(self):
        out = self.run_as(self.office, dataset="papers")
        self.assertEqual([c["key"] for c in out["columns"]],
                         ["title", "journal", "year", "quartile", "faculty", "department"])
        self.assertEqual(out["total_rows"], 4)  # three papers; one has two college authors
        self.assertFalse(out["truncated"])
        self.assertEqual(out["chart_hint"]["kind"], "none")
        row = next(r for r in out["rows"] if r["title"] == "Signal paths")
        self.assertEqual(row["faculty"], "Meera Das")
        self.assertEqual(row["year"], 2025)

    def test_papers_have_snip_sjr_and_dates(self):
        out = self.rows(self.office, dataset="papers",
                        columns=["title", "snip", "sjr", "publication_date", "indexed_in_scopus", "doi", "citations"],
                        sort=[{"field": "title", "dir": "asc"}])
        first = out[0]
        self.assertEqual(first["title"], "Graph methods")
        self.assertEqual((first["snip"], first["sjr"]), (1.8, 0.9))
        self.assertEqual(first["publication_date"], "2025-06-15")
        self.assertIs(first["indexed_in_scopus"], True)
        self.assertIsNone(first["doi"])
        # No ISSN, no SNIP; an ISSN the dump lacks, none either.
        by_title = {r["title"]: r for r in out}
        self.assertIsNone(by_title["Older work"]["snip"])
        self.assertIsNone(by_title["Signal paths"]["snip"])

    def test_one_row_per_paper_and_person_even_when_matched_twice(self):
        Authorship.objects.create(publication=self.p3, position=2, display_name="P Raman", author_key="n:p raman",
                                  user=self.priya, is_college=True)
        out = self.rows(self.office, dataset="papers", columns=["title", "faculty"],
                        filters=[{"field": "title", "op": "eq", "value": "Older work"}])
        self.assertEqual(len(out), 1)

    def test_every_filter_operator(self):
        def titles(*filters):
            return sorted(r["title"] for r in self.rows(
                self.office, dataset="papers", columns=["title"], filters=list(filters)))

        def f(field, op, value=None):
            return {"field": field, "op": op, "value": value}

        self.assertEqual(titles(f("year", "eq", 2023)), ["Older work"])
        self.assertEqual(titles(f("year", "ne", 2025)), ["Older work"])
        self.assertEqual(titles(f("year", "gt", 2023)), ["Graph methods", "Graph methods", "Signal paths"])
        self.assertEqual(titles(f("year", "gte", 2025), f("year", "lt", 2026), f("citations", "lte", 4)), ["Signal paths"])
        self.assertEqual(titles(f("year", "between", [2026, 2023])),
                         ["Graph methods", "Graph methods", "Older work", "Signal paths"])
        self.assertEqual(titles(f("title", "contains", "path")), ["Signal paths"])
        self.assertEqual(titles(f("faculty", "in", ["priya raman", "MEERA DAS"])),
                         ["Graph methods", "Older work", "Signal paths"])
        self.assertEqual(titles(f("department", "not_in", ["CSE"])), ["Signal paths"])
        self.assertEqual(titles(f("quartile", "is_empty")), ["Older work"])
        self.assertEqual(titles(f("quartile", "not_empty"), f("department", "eq", "ece")), ["Signal paths"])
        self.assertEqual(titles(f("indexed_in_scopus", "eq", True)), ["Graph methods", "Graph methods"])
        self.assertEqual(titles(f("indexed_in_scopus", "ne", True)), ["Older work", "Signal paths"])
        self.assertEqual(titles(f("publication_date", "between", ["2025-01-01", "2025-12-31"]), f("snip", "gt", 1)),
                         ["Graph methods", "Graph methods"])
        self.assertEqual(titles(f("snip", "is_empty")), ["Older work", "Signal paths"])

    def test_sort_and_top_n_in_rows(self):
        out = self.rows(self.office, dataset="claims", columns=["claim_no", "amount"],
                        filters=[{"field": "amount", "op": "not_empty"}],
                        sort=[{"field": "amount", "dir": "desc"}], top_n=2)
        self.assertEqual([r["claim_no"] for r in out], ["FP-1", "FP-2"])
        full = self.run_as(self.office, dataset="claims", columns=["claim_no"],
                           sort=[{"field": "amount", "dir": "desc"}], top_n=2)
        self.assertEqual(full["total_rows"], 2)

    def test_limit_marks_the_answer_truncated(self):
        out = self.run_as(self.office, dataset="papers", limit=2)
        self.assertEqual((len(out["rows"]), out["total_rows"], out["truncated"]), (2, 4, True))

    def test_faculty_directory(self):
        out = self.rows(self.office, dataset="faculty",
                        columns=["name", "scopus_linked", "scopus_papers", "papers_this_year", "papers_total",
                                 "citations", "h_index", "last_paper_date", "type", "date_of_joining"],
                        sort=[{"field": "name", "dir": "asc"}])
        names = [r["name"] for r in out]
        self.assertNotIn("Gone Person", names)           # inactive people are not the directory
        self.assertNotIn("Root Admin", names)            # the admin account is not a claimant
        priya = next(r for r in out if r["name"] == "Priya Raman")
        self.assertEqual(priya["papers_total"], 2)
        self.assertEqual(priya["scopus_papers"], 1)
        self.assertEqual((priya["citations"], priya["h_index"]), (11, 2))
        self.assertTrue(priya["scopus_linked"])
        self.assertEqual(priya["last_paper_date"], "2025-06-15")
        self.assertEqual(next(r for r in out if r["name"] == "Meera Das")["type"], "Research")
        self.assertEqual(next(r for r in out if r["name"] == "Arun Kumar")["citations"], 0)
        Publication.objects.filter(pk=self.p3.pk).update(year=timezone.localdate().year)
        out = self.rows(self.office, dataset="faculty", columns=["name", "papers_this_year"],
                        filters=[{"field": "papers_this_year", "op": "eq", "value": 0}])
        self.assertIn("Arun Kumar", [r["name"] for r in out])
        self.assertNotIn("Priya Raman", [r["name"] for r in out])

    def test_date_of_joining_comes_from_the_faculty_master(self):
        FacultyMaster.objects.create(name="Priya Raman", staff_id="PRIYA", raw_json='{"doj_date": "2015-07-01"}')
        FacultyMaster.objects.create(name="Arun Kumar", staff_id="ARUN", raw_json="not json")
        out = self.rows(self.office, dataset="faculty", columns=["staff_id", "date_of_joining"],
                        filters=[{"field": "name", "op": "in", "value": ["Priya Raman", "Arun Kumar"]}])
        self.assertEqual({r["staff_id"]: r["date_of_joining"] for r in out}, {"PRIYA": "2015-07-01", "ARUN": None})

    def test_teams(self):
        out = self.rows(self.office, dataset="teams", sort=[{"field": "team", "dir": "asc"}])
        t1 = out[0]
        self.assertEqual((t1["team"], t1["mentor"], t1["students"], t1["project_title"]),
                         ("T1", "Priya Raman", 2, "Smart grid"))
        self.assertEqual((t1["article_title"], t1["doi"]), ("Smart grid article", "10.1/grid"))
        self.assertEqual((out[1]["students"], out[1]["article_title"]), (0, None))
        with_papers = self.rows(self.office, dataset="teams", filters=[{"field": "article_title", "op": "not_empty"}])
        self.assertEqual([r["team"] for r in with_papers], ["T1"])

    def test_claims_status_stage_and_days_waiting(self):
        out = {r["claim_no"]: r for r in self.rows(
            self.office, dataset="claims", columns=["claim_no", "status", "stage", "days_waiting", "filed", "paid"],
            filters=[{"field": "claim_no", "op": "not_empty"}])}
        self.assertEqual((out["FP-1"]["status"], out["FP-1"]["stage"], out["FP-1"]["days_waiting"]),
                         ("Paid", "Done", None))
        self.assertEqual((out["FP-2"]["status"], out["FP-2"]["stage"]), ("Filed", "With research cell"))
        self.assertEqual(out["FP-2"]["days_waiting"], 12)
        self.assertEqual((out["FP-3"]["status"], out["FP-3"]["stage"]), ("Cleared", "With Principal"))
        self.assertEqual((out["FP-5"]["status"], out["FP-5"]["stage"]), ("Authorised", "With Finance"))
        self.assertEqual(out["FP-2"]["filed"], timezone.localtime(timezone.now() - timedelta(days=12)).date().isoformat())
        self.assertIsNotNone(out["FP-1"]["paid"])

    def test_nobody_but_the_owner_sees_a_draft(self):
        titles = [r["paper"] for r in self.rows(self.office, dataset="claims", columns=["paper"])]
        self.assertNotIn("Half typed", titles)
        mine = [r["paper"] for r in self.rows(self.priya, dataset="claims", columns=["paper"])]
        self.assertIn("Half typed", mine)


class AggregateTests(Studio):
    def test_each_aggregate(self):
        out = self.rows(self.office, dataset="claims",
                        filters=[{"field": "amount", "op": "not_empty"}],
                        aggregates=[
                            {"fn": "count"},
                            {"field": "amount", "fn": "sum"},
                            {"field": "amount", "fn": "avg"},
                            {"field": "amount", "fn": "min"},
                            {"field": "amount", "fn": "max"},
                            {"field": "department", "fn": "count_distinct"},
                            {"field": "filed", "fn": "max", "label": "Latest filing"},
                        ])
        self.assertEqual(len(out), 1)
        row = out[0]
        self.assertEqual(row["count"], 5)
        self.assertEqual(row["sum_amount"], 60000.0)
        self.assertEqual(row["avg_amount"], 12000.0)
        self.assertEqual((row["min_amount"], row["max_amount"]), (4000.0, 20000.0))
        self.assertEqual(row["count_distinct_department"], 2)
        self.assertIsInstance(row["max_filed"], str)
        cols = {c["key"]: c for c in self.run_as(self.office, dataset="claims", aggregates=[
            {"field": "amount", "fn": "sum"}, {"field": "snip", "fn": "avg"}, {"fn": "count"},
            {"field": "filed", "fn": "min", "label": "First"}])["columns"]}
        self.assertEqual((cols["sum_amount"]["type"], cols["avg_snip"]["type"], cols["count"]["type"]),
                         ("money", "number", "number"))
        self.assertEqual((cols["min_filed"]["type"], cols["min_filed"]["label"]), ("date", "First"))

    def test_an_aggregate_over_nothing_is_one_row_of_zeros(self):
        out = self.rows(self.office, dataset="claims", filters=[{"field": "status", "op": "eq", "value": "Rejected"}],
                        aggregates=[{"fn": "count"}, {"field": "amount", "fn": "sum"}])
        self.assertEqual(out, [{"count": 0, "sum_amount": None}])

    def test_group_by_with_default_count_and_sort(self):
        out = self.run_as(self.office, dataset="papers", group_by=["department", "quartile"],
                          sort=[{"field": "count", "dir": "desc"}, {"field": "department", "dir": "asc"}])
        self.assertEqual([c["key"] for c in out["columns"]], ["department", "quartile", "count"])
        self.assertEqual(out["rows"][0], {"department": "CSE", "quartile": "Q1", "count": 2})
        blank = [r for r in out["rows"] if r["quartile"] == report_engine.NOT_RECORDED]
        self.assertEqual(blank, [{"department": "CSE", "quartile": "Not recorded", "count": 1}])
        self.assertEqual(out["chart_hint"]["kind"], "bar")
        self.assertEqual(out["chart_hint"]["x"], "department")

    def test_top_n_after_grouping_defaults_to_the_biggest(self):
        out = self.run_as(self.office, dataset="payments", group_by=["faculty"],
                          aggregates=[{"field": "amount", "fn": "sum"}], top_n=2)
        self.assertEqual([r["faculty"] for r in out["rows"]], ["Priya Raman", "Meera Das"])
        self.assertEqual(out["rows"][1]["sum_amount"], 11000.0)
        self.assertEqual((out["total_rows"], out["truncated"]), (2, False))

    def test_chart_hints(self):
        pie = self.run_as(self.office, dataset="papers", group_by=["quartile"])
        self.assertEqual(pie["chart_hint"]["kind"], "pie")
        line = self.run_as(self.office, dataset="payments", group_by=["month"], date_bucket="month",
                           aggregates=[{"field": "amount", "fn": "sum"}])
        self.assertEqual(line["chart_hint"], {"kind": "line", "x": "month", "y": ["sum_amount"]})

    def test_date_buckets(self):
        def buckets(kind):
            out = self.run_as(self.office, dataset="payments", group_by=["month"], date_bucket=kind,
                              aggregates=[{"field": "amount", "fn": "sum"}])
            return [(r["month"], r["sum_amount"]) for r in out["rows"]]

        self.assertEqual(buckets("month"), [("2025-04", 25000.0), ("2025-07", 8000.0), ("2026-02", 3000.0)])
        self.assertEqual(buckets("quarter"), [("2025-Q2", 25000.0), ("2025-Q3", 8000.0), ("2026-Q1", 3000.0)])
        self.assertEqual(buckets("year"), [("2025", 33000.0), ("2026", 3000.0)])
        # The year starts in June: April 2025 is in 2024-25, July 2025 and Feb 2026 in 2025-26.
        self.assertEqual(buckets("academic_year"), [("2024-25", 25000.0), ("2025-26", 11000.0)])

    def test_academic_year_is_also_a_field(self):
        out = self.rows(self.office, dataset="payments", group_by=["academic_year", "department"],
                        aggregates=[{"field": "amount", "fn": "sum"}])
        self.assertIn({"academic_year": "2025-26", "department": "ECE", "sum_amount": 11000.0}, out)

    def test_payments_net_out_reversals(self):
        PaidLedger.objects.create(payout_month=date(2025, 4, 1), amount=-5000, faculty_name="Arun Kumar",
                                  department="CSE", kind="REVERSAL", staff_id="ARUN")
        out = self.rows(self.office, dataset="payments", aggregates=[{"field": "amount", "fn": "sum"}],
                        filters=[{"field": "faculty", "op": "eq", "value": "Arun Kumar"}])
        self.assertEqual(out[0]["sum_amount"], 0.0)

    def test_pivot_shape(self):
        out = self.run_as(self.office, dataset="payments",
                          pivot={"rows": "department", "columns": "academic_year",
                                 "value": {"field": "amount", "fn": "sum"}})
        self.assertEqual([c["label"] for c in out["columns"]], ["Department", "2024-25", "2025-26", "Total"])
        self.assertEqual(out["rows"], [
            {"department": "CSE", "c0": 25000.0, "c1": None, "total": 25000.0},
            {"department": "ECE", "c0": None, "c1": 11000.0, "total": 11000.0},
        ])
        self.assertEqual(out["chart_hint"], {"kind": "bar", "x": "department", "y": ["c0", "c1"]})
        counted = self.run_as(self.office, dataset="papers",
                              pivot={"rows": "department", "columns": "quartile", "value": {"fn": "count"}},
                              sort=[{"field": "total", "dir": "desc"}], top_n=1)
        self.assertEqual(len(counted["rows"]), 1)
        self.assertEqual(counted["rows"][0]["department"], "CSE")
        self.assertEqual(counted["rows"][0]["total"], 3)
        averaged = self.run_as(self.office, dataset="papers",
                               pivot={"rows": "department", "columns": "quartile",
                                      "value": {"field": "citations", "fn": "avg"}})
        self.assertNotIn("Total", [c["label"] for c in averaged["columns"]])   # an average has no total

    def test_pivot_columns_are_in_order_and_dates_can_be_bucketed(self):
        out = self.run_as(self.office, dataset="payments", date_bucket="year",
                          pivot={"rows": "department", "columns": "month", "value": {"fn": "count"}})
        self.assertEqual([c["label"] for c in out["columns"]], ["Department", "2025", "2026", "Total"])
        self.assertEqual(out["rows"], [
            {"department": "CSE", "c0": 2, "c1": None, "total": 2},
            {"department": "ECE", "c0": 1, "c1": 1, "total": 2},
        ])
        # Row ECE comes after CSE in the data, yet the 2025 column leads whatever row it was first seen in.
        by_year = self.run_as(self.office, dataset="papers",
                              pivot={"rows": "department", "columns": "year", "value": {"fn": "count"}})
        self.assertEqual([c["label"] for c in by_year["columns"]][1:3], ["2023", "2025"])

    def test_sums_over_computed_fields_group_cleanly(self):
        out = self.rows(self.office, dataset="faculty", group_by=["department"],
                        aggregates=[{"field": "papers_total", "fn": "sum"}, {"field": "citations", "fn": "avg"},
                                    {"field": "scopus_linked", "fn": "count"}],
                        filters=[{"field": "department", "op": "in", "value": ["CSE", "ECE"]}])
        by_dept = {r["department"]: r for r in out}
        self.assertEqual(by_dept["CSE"]["sum_papers_total"], 3)   # Priya 2, Arun 1, the head none
        self.assertEqual(by_dept["ECE"]["sum_papers_total"], 1)
        self.assertEqual(round(by_dept["CSE"]["avg_citations"], 2), round(11 / 3, 2))

    def test_a_pivot_with_too_many_columns_is_refused(self):
        original = report_engine.MAX_PIVOT_COLUMNS
        report_engine.MAX_PIVOT_COLUMNS = 2
        try:
            with self.assertRaisesMessage(ReportError, "columns"):
                self.run_as(self.office, dataset="claims",
                            pivot={"rows": "department", "columns": "status", "value": {"fn": "count"}})
        finally:
            report_engine.MAX_PIVOT_COLUMNS = original

    def test_claims_waiting_by_stage_and_age(self):
        out = self.run_as(self.office, dataset="claims",
                          filters=[{"field": "days_waiting", "op": "not_empty"}],
                          group_by=["stage"], aggregates=[{"fn": "count"}, {"field": "days_waiting", "fn": "max"}],
                          sort=[{"field": "max_days_waiting", "dir": "desc"}])
        self.assertEqual(out["rows"][0], {"stage": "With Finance", "count": 1, "max_days_waiting": 20})


class VisibilityTests(Studio):
    def test_faculty_see_only_their_own_rows(self):
        mine = self.rows(self.arun, dataset="papers", columns=["title", "faculty"])
        self.assertEqual({(r["title"], r["faculty"]) for r in mine}, {("Graph methods", "Arun Kumar")})
        self.assertEqual([r["name"] for r in self.rows(self.arun, dataset="faculty", columns=["name"])], ["Arun Kumar"])
        claims = self.rows(self.arun, dataset="claims", columns=["claim_no", "claimant"])
        self.assertEqual({r["claimant"] for r in claims}, {"Arun Kumar"})
        pays = self.rows(self.arun, dataset="payments", columns=["faculty", "amount"])
        self.assertEqual(pays, [{"faculty": "Arun Kumar", "amount": 5000.0}])
        self.assertEqual([r["team"] for r in self.rows(self.priya, dataset="teams", columns=["team"])], ["T1"])
        self.assertEqual(self.rows(self.arun, dataset="teams", columns=["team"]), [])

    def test_a_filter_cannot_widen_what_a_person_sees(self):
        out = self.rows(self.arun, dataset="papers", columns=["faculty"],
                        filters=[{"field": "faculty", "op": "eq", "value": "Meera Das"}])
        self.assertEqual(out, [])
        out = self.rows(self.arun, dataset="papers", columns=["faculty"],
                        filters=[{"field": "department", "op": "ne", "value": "nowhere"}])
        self.assertEqual({r["faculty"] for r in out}, {"Arun Kumar"})

    def test_faculty_get_words_that_name_no_desk(self):
        out = {r["claim_no"]: r for r in self.rows(
            self.arun, dataset="claims", columns=["claim_no", "status", "stage"],
            filters=[{"field": "claim_no", "op": "not_empty"}])}
        self.assertEqual((out["FP-2"]["status"], out["FP-2"]["stage"]),
                         ("Under review", "Being checked by the college"))
        self.assertEqual(out["FP-5"]["status"], "Approved for payment")
        every_word = {v for r in out.values() for v in (r["status"], r["stage"])}
        for banned in ("research cell", "Principal", "Director", "Finance", "CLEARED"):
            self.assertFalse(any(banned in w for w in every_word), banned)

    def test_hod_sees_own_department_only(self):
        papers = self.rows(self.hod, dataset="papers", columns=["faculty", "department"])
        self.assertEqual({r["department"] for r in papers}, {"CSE"})
        self.assertEqual(sorted({r["faculty"] for r in papers}), ["Arun Kumar", "Priya Raman"])
        people = {r["name"] for r in self.rows(self.hod, dataset="faculty", columns=["name"])}
        self.assertEqual(people, {"Priya Raman", "Arun Kumar", "Head Cse"})
        self.assertEqual([r["team"] for r in self.rows(self.hod, dataset="teams", columns=["team"])], ["T1"])
        claims = self.rows(self.hod, dataset="claims", columns=["claimant", "status"])
        self.assertEqual({r["claimant"] for r in claims}, {"Priya Raman", "Arun Kumar"})
        self.assertNotIn("Half typed", [r["paper"] for r in self.rows(self.hod, dataset="claims", columns=["paper"])])

    def test_hod_cannot_use_money_anywhere(self):
        for field in ("amount", "paid"):
            for definition in (
                {"columns": [field]},
                {"filters": [{"field": field, "op": "not_empty"}]},
                {"aggregates": [{"field": field, "fn": "max"}]},
                {"group_by": [field]},
                {"columns": ["claim_no"], "sort": [{"field": field, "dir": "asc"}]},
            ):
                with self.subTest(field=field, definition=definition), \
                        self.assertRaisesMessage(ReportError, "do not see money"):
                    self.run_as(self.hod, dataset="claims", **definition)
        with self.assertRaisesMessage(ReportError, "do not see money"):
            self.run_as(self.hod, dataset="claims",
                        pivot={"rows": "department", "columns": "status", "value": {"field": "amount", "fn": "sum"}})
        with self.assertRaises(ReportError) as ctx:
            self.run_as(self.hod, dataset="payments")
        self.assertEqual(ctx.exception.status, 403)

    def test_hod_status_words_hide_the_desk_and_the_payment(self):
        out = {r["claimant"] + r["status"] for r in self.rows(self.hod, dataset="claims", columns=["claimant", "status"])}
        self.assertIn("Priya RamanCompleted", out)   # paid, said as "Completed"
        self.assertIn("Arun KumarUnder review", out)
        self.assertNotIn("Paid", {r["status"] for r in self.rows(self.hod, dataset="claims", columns=["status"])})
        with self.assertRaises(ReportError):
            self.run_as(self.hod, dataset="claims", columns=["stage"])
        viewer = report_datasets.viewer_for(self.hod)
        fields = {f["key"] for f in report_datasets.CLAIMS.describe(viewer)["fields"]}
        for hidden in ("amount", "paid", "stage"):
            self.assertNotIn(hidden, fields)

    def test_hod_papers_include_scholarly_numbers(self):
        out = self.rows(self.hod, dataset="papers", columns=["title", "snip", "quartile"],
                        filters=[{"field": "snip", "op": "gt", "value": 1}])
        self.assertEqual(out[0]["snip"], 1.8)

    def test_office_roles_see_the_whole_college(self):
        for who in (self.office, self.principal, self.finance, self.admin):
            with self.subTest(role=who.role):
                self.assertEqual(len(self.rows(who, dataset="papers", columns=["title"])), 4)
                self.assertEqual(len(self.rows(who, dataset="payments", columns=["amount"])), 4)

    def test_datasets_are_scope_aware(self):
        def names(u):
            return [d.key for d in report_datasets.offered(report_datasets.viewer_for(u))]

        self.assertEqual(names(self.office), ["papers", "claims", "payments", "faculty", "teams"])
        self.assertEqual(names(self.hod), ["papers", "claims", "faculty", "teams"])
        self.assertEqual(names(self.arun), ["papers", "claims", "payments", "faculty", "teams"])


class PerformanceTests(Studio):
    def test_twenty_thousand_rows_run_in_a_few_queries(self):
        PaidLedger.objects.bulk_create([
            PaidLedger(payout_month=date(2024 + i % 2, 1 + i % 12, 1), amount=100 + i % 7, faculty_name=f"F{i % 50}",
                       department=f"D{i % 5}", paper_title=f"P{i}", kind="PAYMENT")
            for i in range(20000)
        ])
        import time

        started = time.perf_counter()
        with self.assertNumQueries(3):  # the year-start setting, the rows, the count
            out = report_engine.run(self.office, {"dataset": "payments", "limit": 20000,
                                                  "columns": ["month", "faculty", "department", "paper", "amount"]})
        self.assertEqual(len(out["rows"]), 20000)
        self.assertGreaterEqual(out["total_rows"], 20000)
        self.assertLess(time.perf_counter() - started, 8)
        grouped = report_engine.run(self.office, {"dataset": "payments", "group_by": ["department"],
                                                  "aggregates": [{"field": "amount", "fn": "sum"}]})
        self.assertEqual(len(grouped["rows"]), 7)  # D0..D4, CSE and ECE
