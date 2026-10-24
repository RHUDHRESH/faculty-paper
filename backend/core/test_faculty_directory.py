"""The faculty directory and the faculty record: who may open them, and what each may read.

The rules under test:

* Faculty never see the directory; they open their own record and nobody's.
* The office, the Principal, the Director and Finance see everybody; only
  those who may read reports (and the person) see a rupee figure.
* A head of department sees their own department and no money but their own,
  at the source and again through the renderer.
* Nobody outside the desks receives a discrepancy flag through this route.
* "What is missing" is the office's.
* The CSV goes through the cell-safe writer and carries no money for a head.
* Scopus-linked counts are the record's own, the summary is the whole role
  scope, and the `scopus` filter narrows the list but never the summary.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime
from datetime import timezone as dt_timezone

from django.core.cache import cache
from django.db import connection
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core.models import (
    Authorship,
    Claim,
    ClaimStatus,
    PaidLedger,
    Publication,
    PublicationMetrics,
    Role,
    User,
)
from core.visibility import FLAG_KEYS


def _person(email, name, role=Role.FACULTY, **extra):
    return User.objects.create_user(email=email, password=None, name=name, role=role, **extra)


def _walk(value):
    """Every key anywhere in a JSON payload."""
    if isinstance(value, dict):
        for k, v in value.items():
            yield k
            yield from _walk(v)
    elif isinstance(value, list):
        for v in value:
            yield from _walk(v)


class DirectoryFixture(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.year = timezone.localdate().year
        cls.admin = _person("fd-admin@test.edu", "Office Admin", Role.SUPER_ADMIN)
        cls.cell = _person("fd-cell@test.edu", "Research Office", Role.RESEARCH_CELL, department="Research")
        cls.principal = _person("fd-prin@test.edu", "Principal", Role.PRINCIPAL, department="Admin")
        cls.director = _person("fd-dir@test.edu", "Director", Role.DIRECTOR, department="Admin")
        cls.finance = _person("fd-fin@test.edu", "Finance", Role.FINANCE, department="Accounts")
        cls.head = _person(
            "fd-head@test.edu", "Dr Head Cse", Role.HOD, department="CSE", staff_id="H1",
            designation="Professor", scopus_author_id="111",
        )
        cls.colleague = _person(
            "fd-col@test.edu", "Dr Colleague Cse", department="CSE", staff_id="C1",
            designation="Assistant Professor", scopus_author_id="222", photo="avatars/x.jpg",
        )
        cls.elsewhere = _person(
            "fd-ece@test.edu", "Dr Elsewhere Ece", department="ECE", staff_id="E1", designation="Professor",
        )
        cls.researcher = _person(
            "fd-res@test.edu", "Dr Research Cse", department="CSE", staff_id="R1", designation="Professor",
            faculty_type="RESEARCH", research_quota=4,
        )
        cls.bare = _person("fd-bare@test.edu", "Bare Record")  # no department, designation, photo, Scopus

        # A paid paper for the colleague and for the head, so both have money.
        for owner, amount in ((cls.colleague, 7777), (cls.head, 5555)):
            claim = Claim.objects.create(
                owner=owner, status=ClaimStatus.PAID, remuneration=amount, paper_title=f"Paper of {owner.name}",
                journal_title="J", publication_year=cls.year, ticket_number=f"FP-T-{owner.staff_id}",
                paid_at=timezone.now(),
            )
            PaidLedger.objects.create(
                claim=claim, payout_month=date(cls.year, 1, 1), faculty_name=owner.name, staff_id=owner.staff_id,
                paper_title=claim.paper_title, amount=amount,
            )
        pub = Publication.objects.create(title="A Record Paper", year=cls.year, date=date(cls.year, 2, 1), venue="J")
        Authorship.objects.create(publication=pub, position=1, display_name="Dr Colleague Cse",
                                  author_key="n:colleague", user=cls.colleague, is_college=True)
        PublicationMetrics.objects.create(user=cls.colleague, total_publications=1, total_citations=9, h_index=1)

    def get(self, user, path):
        c = Client()
        c.force_login(user)
        return c.get(path)

    def json(self, user, path):
        r = self.get(user, path)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()


class WhoMayOpenTests(DirectoryFixture):
    def test_faculty_do_not_see_the_directory_or_the_gaps_or_the_export(self):
        for path in ("/api/directory/faculty", "/api/directory/faculty/gaps", "/api/directory/faculty/export.csv"):
            self.assertEqual(self.get(self.colleague, path).status_code, 403, path)

    def test_faculty_open_their_own_record_and_nobody_elses(self):
        self.assertEqual(self.get(self.colleague, f"/api/directory/faculty/{self.colleague.id}").status_code, 200)
        self.assertEqual(self.get(self.colleague, "/api/directory/faculty/me").status_code, 200)
        self.assertEqual(self.get(self.colleague, f"/api/directory/faculty/{self.head.id}").status_code, 403)

    def test_the_office_principal_director_and_finance_see_everybody(self):
        for who in (self.admin, self.cell, self.principal, self.director, self.finance):
            body = self.json(who, "/api/directory/faculty?limit=100")
            names = {r["name"] for r in body["results"]}
            self.assertIn("Dr Elsewhere Ece", names, who.role)
            self.assertIn("Dr Colleague Cse", names, who.role)
            self.assertEqual(body["scope"], "college")

    def test_a_head_sees_their_own_department_only(self):
        body = self.json(self.head, "/api/directory/faculty?limit=100")
        names = {r["name"] for r in body["results"]}
        self.assertIn("Dr Colleague Cse", names)
        self.assertNotIn("Dr Elsewhere Ece", names)
        self.assertEqual(body["scope"], "department")
        # A department chosen in the query cannot widen it.
        widened = self.json(self.head, "/api/directory/faculty?department=ECE")
        self.assertEqual(widened["total"], 0)
        self.assertEqual(self.get(self.head, f"/api/directory/faculty/{self.elsewhere.id}").status_code, 403)
        self.assertEqual(self.get(self.head, f"/api/directory/faculty/{self.colleague.id}").status_code, 200)


class MoneyTests(DirectoryFixture):
    def test_roles_that_read_reports_see_incentives_in_the_directory(self):
        for who in (self.admin, self.principal, self.director, self.finance):
            body = self.json(who, "/api/directory/faculty?limit=100")
            self.assertTrue(body["money"], who.role)
            row = next(r for r in body["results"] if r["id"] == self.colleague.id)
            self.assertEqual(row["incentive"]["total_amount"], 7777, who.role)
            self.assertEqual(row["incentive"]["amount"], 7777, who.role)

    def test_a_head_is_money_blind_in_the_directory_except_on_their_own_row(self):
        r = self.get(self.head, "/api/directory/faculty?limit=100&sort=paid&dir=desc")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertFalse(body["money"])
        colleague = next(x for x in body["results"] if x["id"] == self.colleague.id)
        self.assertNotIn("incentive", colleague)
        self.assertNotIn("7777", r.content.decode(), "a colleague's amount appears nowhere in the payload")
        own = next(x for x in body["results"] if x["id"] == self.head.id)
        self.assertEqual(own["incentive"]["total_amount"], 5555)

    def test_a_head_sees_no_money_on_a_colleague_record_and_all_of_their_own(self):
        r = self.get(self.head, f"/api/directory/faculty/{self.colleague.id}")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIsNone(body["payments"])
        self.assertFalse(body["viewer"]["money"])
        self.assertNotIn("7777", r.content.decode())
        self.assertFalse({"amount", "total_amount", "incentive"} & set(_walk(body)))
        # Their claims are still listed, with a word for where each is and no figure.
        self.assertEqual([c["stage"] for c in body["claims"]], ["Completed"])

        own = self.json(self.head, f"/api/directory/faculty/{self.head.id}")
        self.assertEqual(own["payments"]["total_amount"], 5555)
        self.assertEqual(own["claims"][0]["amount"], 5555)

    def test_faculty_see_their_own_money_and_the_office_sees_it_on_the_record(self):
        mine = self.json(self.colleague, "/api/directory/faculty/me")
        self.assertEqual(mine["payments"]["total_amount"], 7777)
        seen = self.json(self.finance, f"/api/directory/faculty/{self.colleague.id}")
        self.assertEqual(seen["payments"]["total_amount"], 7777)
        self.assertEqual(seen["payments"]["rows"][0]["amount"], 7777)

    def test_the_research_threshold_value_is_a_term_of_pay(self):
        office = self.json(self.admin, "/api/directory/faculty?faculty_type=RESEARCH")
        self.assertEqual(office["results"][0]["threshold"], 4)
        head = self.json(self.head, "/api/directory/faculty?faculty_type=RESEARCH")
        row = head["results"][0]
        self.assertTrue(row["threshold_set"], "a head is told it is set")
        self.assertNotIn("threshold", row, "and not what it is")
        rec = self.json(self.head, f"/api/directory/faculty/{self.researcher.id}")
        self.assertNotIn("threshold", rec["person"])
        self.assertEqual(self.json(self.admin, f"/api/directory/faculty/{self.researcher.id}")["person"]["threshold"], 4)


class NoFlagsTests(DirectoryFixture):
    def test_nobody_receives_a_flag_key_through_the_record_or_the_directory(self):
        path = f"/api/directory/faculty/{self.colleague.id}"
        for who in (self.director, self.finance, self.head, self.colleague, self.admin):
            self.assertFalse(set(_walk(self.json(who, path))) & FLAG_KEYS, who.role)
            self.assertFalse(set(_walk(self.json(who, "/api/directory/faculty/me" if who == self.colleague
                                                  else "/api/directory/faculty?limit=100"
                                                  if who != self.head else path))) & FLAG_KEYS, who.role)

    def test_a_faculty_members_own_claims_say_the_step_not_the_desk(self):
        Claim.objects.create(owner=self.colleague, status=ClaimStatus.CLEARED, paper_title="In flight",
                             ticket_number="FP-T-INFLIGHT", submitted_at=timezone.now())
        body = self.json(self.colleague, "/api/directory/faculty/me")
        stages = {c["stage"] for c in body["claims"]}
        self.assertTrue(stages <= {"Paid", "Under review", "Approved for payment", "Submitted", "Draft"}, stages)
        staff = self.json(self.admin, f"/api/directory/faculty/{self.colleague.id}")
        self.assertIn("Cleared", {c["stage"] for c in staff["claims"]})
        inflight = next(c for c in staff["claims"] if c["claim_no"] == "FP-T-INFLIGHT")
        self.assertTrue(inflight["review_path"].startswith("/review/"))
        own = next(c for c in body["claims"] if c["claim_no"] == "FP-T-INFLIGHT")
        self.assertIsNone(own["review_path"], "nobody opens their own claim at a desk")


class FiltersAndGapsTests(DirectoryFixture):
    def test_filters(self):
        missing_photo = self.json(self.admin, "/api/directory/faculty?missing=photo&limit=100")
        ids = {r["id"] for r in missing_photo["results"]}
        self.assertIn(self.bare.id, ids)
        self.assertNotIn(self.colleague.id, ids)
        none_this_year = self.json(self.admin, "/api/directory/faculty?no_papers_year=true&limit=100")
        ids = {r["id"] for r in none_this_year["results"]}
        self.assertIn(self.elsewhere.id, ids)
        self.assertNotIn(self.colleague.id, ids)
        self.assertEqual(self.json(self.admin, "/api/directory/faculty?q=E1")["results"][0]["id"], self.elsewhere.id)
        self.assertEqual(self.json(self.admin, "/api/directory/faculty?department=ece")["total"], 1)

    def test_the_paper_count_and_metrics_come_from_the_record(self):
        row = next(r for r in self.json(self.admin, "/api/directory/faculty?limit=100")["results"]
                   if r["id"] == self.colleague.id)
        self.assertEqual(row["papers"], 2)  # the publication + the paid claim not linked to it
        self.assertEqual(row["papers_year"], 2)
        self.assertEqual(row["citations"], 9)
        self.assertEqual(row["claims_done"], 1)
        self.assertEqual(row["scopus_url"], "https://www.scopus.com/authid/detail.uri?authorId=222")

    def test_names_sort_without_their_titles(self):
        names = [r["name"] for r in self.json(self.admin, "/api/directory/faculty?limit=100")["results"]]
        self.assertLess(names.index("Bare Record"), names.index("Dr Colleague Cse"))

    def test_gaps_are_the_offices_alone(self):
        for who in (self.admin, self.cell):
            body = self.json(who, "/api/directory/faculty/gaps")
            cats = {c["key"]: c for c in body["categories"]}
            self.assertIn(self.bare.id, {p["id"] for p in cats["photo"]["people"]})
            self.assertIn(self.bare.id, {p["id"] for p in cats["department"]["people"]})
            self.assertGreaterEqual(cats["scopus"]["count"], 1)
            self.assertNotIn(self.colleague.id, {p["id"] for p in cats["photo"]["people"]})
            fix = next(p for p in cats["scopus"]["people"] if p["id"] == self.bare.id)
            self.assertEqual(fix["fix_path"], f"/people/{self.bare.id}")
        for who in (self.head, self.principal, self.director, self.finance, self.colleague):
            self.assertEqual(self.get(who, "/api/directory/faculty/gaps").status_code, 403, who.role)


class ExportTests(DirectoryFixture):
    def test_the_csv_is_cell_safe_and_has_a_bom(self):
        User.objects.filter(pk=self.elsewhere.pk).update(name="=HYPERLINK(\"http://x\")")
        r = self.get(self.admin, "/api/directory/faculty/export.csv")
        self.assertEqual(r.status_code, 200)
        text = r.content.decode("utf-8")
        self.assertTrue(text.startswith("﻿"))
        rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
        self.assertIn("'=HYPERLINK(\"http://x\")", {row[0] for row in rows})
        self.assertIn("Incentives paid in total (₹)", rows[0])

    def test_a_heads_csv_has_no_money_columns(self):
        r = self.get(self.head, "/api/directory/faculty/export.csv")
        self.assertEqual(r.status_code, 200)
        text = r.content.decode("utf-8")
        self.assertNotIn("₹", text)
        self.assertNotIn("7777", text)
        header = next(csv.reader(io.StringIO(text.lstrip("﻿"))))
        self.assertIn(f"Claims completed in {self.year}", header)
        self.assertNotIn("Dr Elsewhere Ece", text)


SYNC_EARLY = datetime(2026, 10, 1, 9, 0, tzinfo=dt_timezone.utc)
SYNC_MID = datetime(2026, 10, 10, 9, 0, tzinfo=dt_timezone.utc)
SYNC_LATE = datetime(2026, 10, 20, 9, 0, tzinfo=dt_timezone.utc)


def _paper(owner, title, *, indexed=False, eid=None):
    """A publication on `owner`'s record, with the Scopus flags the sync sets."""
    year = timezone.localdate().year
    pub = Publication.objects.create(
        title=title, year=year, date=date(year, 2, 1), venue="J", scopus_indexed=indexed, eid=eid,
    )
    Authorship.objects.create(
        publication=pub, position=1, display_name=owner.name, author_key=f"n:{owner.staff_id}",
        user=owner, is_college=True,
    )
    return pub


def _claim_only_paper(owner, title, ticket):
    """A paid claim whose paper is not on the record: a paper in the count, never a Publication."""
    year = timezone.localdate().year
    claim = Claim.objects.create(
        owner=owner, status=ClaimStatus.PAID, remuneration=1000, paper_title=title, journal_title="J",
        publication_year=year, ticket_number=ticket, paid_at=timezone.now(),
    )
    PaidLedger.objects.create(
        claim=claim, payout_month=date(year, 1, 1), faculty_name=owner.name, staff_id=owner.staff_id,
        paper_title=title, amount=1000,
    )


ACTIVE_NAMES = {
    "Dr Alpha Cse", "Dr Bravo Cse", "Dr Charlie Cse", "Dr Delta Ece", "Dr Echo Ece", "Dr Foxtrot Cse", "Dr Head Cse",
}


class ScopusTests(TestCase):
    """The Scopus-linked counts, the `scopus` filter and the summary, over one small college.

    Current staff (the leaver is left out of every count unless asked for):

    * Alpha, CSE, id 111, synced late: papers indexed, EID-only, neither; the indexed one listed twice.
    * Bravo, CSE, id 222, never synced: one paper, neither.
    * Charlie, CSE, no id: one paper with only an EID.
    * Foxtrot, CSE, id 555, synced mid: one indexed paper.
    * Delta, ECE, id 333, synced early: one indexed paper and one paid claim not on the record.
    * Echo, ECE, blank id: nothing.
    * Head, CSE, no id: nothing (a head is in the population too).
    """

    @classmethod
    def setUpTestData(cls):
        cls.office = _person("sc-office@test.edu", "Office Admin", Role.SUPER_ADMIN)
        cls.head = _person(
            "sc-head@test.edu", "Dr Head Cse", Role.HOD, department="CSE", staff_id="SH1", designation="Professor",
        )
        cls.alpha = _person(
            "sc-alpha@test.edu", "Dr Alpha Cse", department="CSE", staff_id="SA1", designation="Professor",
            scopus_author_id="111", scopus_synced_at=SYNC_LATE,
        )
        cls.bravo = _person(
            "sc-bravo@test.edu", "Dr Bravo Cse", department="CSE", staff_id="SB1", designation="Professor",
            scopus_author_id="222",
        )
        cls.charlie = _person(
            "sc-charlie@test.edu", "Dr Charlie Cse", department="CSE", staff_id="SC1", designation="Professor",
        )
        cls.foxtrot = _person(
            "sc-foxtrot@test.edu", "Dr Foxtrot Cse", department="CSE", staff_id="SF1", designation="Professor",
            scopus_author_id="555", scopus_synced_at=SYNC_MID,
        )
        cls.gone = _person(
            "sc-gone@test.edu", "Dr Gone Cse", department="CSE", staff_id="SG1", designation="Professor", active=False,
        )
        cls.delta = _person(
            "sc-delta@test.edu", "Dr Delta Ece", department="ECE", staff_id="SD1", designation="Professor",
            scopus_author_id="333", scopus_synced_at=SYNC_EARLY,
        )
        cls.echo = _person(
            "sc-echo@test.edu", "Dr Echo Ece", department="ECE", staff_id="SE1", designation="Professor",
            scopus_author_id="",
        )

        indexed = _paper(cls.alpha, "Alpha indexed", indexed=True)
        Authorship.objects.create(
            publication=indexed, position=2, display_name=cls.alpha.name, author_key="n:SA1",
            user=cls.alpha, is_college=True,
        )
        _paper(cls.alpha, "Alpha EID only", eid="2-s2.0-ALPHA")
        _paper(cls.alpha, "Alpha neither")
        _paper(cls.bravo, "Bravo neither")
        _paper(cls.charlie, "Charlie EID only", eid="2-s2.0-CHARLIE")
        _paper(cls.foxtrot, "Foxtrot indexed", indexed=True)
        _paper(cls.delta, "Delta indexed", indexed=True)
        _claim_only_paper(cls.delta, "Delta paid, not on the record", "FP-SCOPUS-DELTA")
        _paper(cls.gone, "Gone indexed", indexed=True)

    def get(self, user, path):
        c = Client()
        c.force_login(user)
        r = c.get(path)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def names(self, user, query=""):
        return {r["name"] for r in self.get(user, f"/api/directory/faculty?limit=100&{query}")["results"]}

    def summary(self, body):
        """The summary without its date, and the date (None when nobody has synced)."""
        s = dict(body["scopus_summary"])
        last = s.pop("last_synced_at")
        return s, (datetime.fromisoformat(last) if last else None)

    def test_each_row_counts_its_scopus_linked_papers(self):
        rows = {r["name"]: r for r in self.get(self.office, "/api/directory/faculty?limit=100")["results"]}
        alpha = rows["Dr Alpha Cse"]
        # Three papers on the record, one listed twice: the indexed and the EID-only count, the bare one does not.
        self.assertEqual((alpha["papers"], alpha["scopus_papers"]), (3, 2))
        self.assertEqual(datetime.fromisoformat(alpha["scopus_synced_at"]), SYNC_LATE)
        self.assertEqual(rows["Dr Bravo Cse"]["scopus_papers"], 0)
        # An EID alone counts, and no Scopus author id is needed for it to.
        self.assertEqual(rows["Dr Charlie Cse"]["scopus_papers"], 1)
        self.assertIsNone(rows["Dr Charlie Cse"]["scopus_synced_at"])
        # The paid claim is a paper in the count but not a Publication, so it is never Scopus-linked.
        self.assertEqual((rows["Dr Delta Ece"]["papers"], rows["Dr Delta Ece"]["scopus_papers"]), (2, 1))
        for name, r in rows.items():
            self.assertLessEqual(r["scopus_papers"], r["papers"], name)

    def test_the_csv_carries_the_scopus_papers_and_the_sync_day(self):
        c = Client()
        c.force_login(self.office)
        r = c.get("/api/directory/faculty/export.csv")
        self.assertEqual(r.status_code, 200)
        rows = list(csv.reader(io.StringIO(r.content.decode("utf-8").lstrip("ï»¿"))))
        header = rows[0]
        i_id = header.index("Scopus ID")
        self.assertEqual(header[i_id + 1 : i_id + 3], ["Scopus papers", "Scopus last synced"])
        alpha = next(row for row in rows if row[0] == "Dr Alpha Cse")
        self.assertEqual(alpha[i_id + 1], "2")
        self.assertEqual(alpha[i_id + 2], SYNC_LATE.date().isoformat())
        charlie = next(row for row in rows if row[0] == "Dr Charlie Cse")
        self.assertEqual(charlie[i_id + 2], "")

    def test_the_scopus_filter_returns_the_right_people(self):
        self.assertEqual(self.names(self.office, "scopus=linked"),
                         {"Dr Alpha Cse", "Dr Bravo Cse", "Dr Delta Ece", "Dr Foxtrot Cse"})
        self.assertEqual(self.names(self.office, "scopus=no_id"), {"Dr Charlie Cse", "Dr Echo Ece", "Dr Head Cse"})
        self.assertEqual(self.names(self.office, "scopus=never_synced"), {"Dr Bravo Cse"})
        self.assertEqual(self.names(self.office, "scopus=gap"), {"Dr Alpha Cse", "Dr Bravo Cse", "Dr Delta Ece"})

    def test_an_unknown_or_empty_scopus_value_is_ignored(self):
        self.assertEqual(self.names(self.office, "scopus=bogus"), ACTIVE_NAMES)
        self.assertEqual(self.names(self.office, "scopus="), ACTIVE_NAMES)

    def test_the_scopus_filter_combines_with_search_and_department(self):
        self.assertEqual(self.names(self.office, "scopus=linked&department=ECE"), {"Dr Delta Ece"})
        self.assertEqual(self.names(self.office, "scopus=linked&q=Foxtrot"), {"Dr Foxtrot Cse"})
        self.assertEqual(self.names(self.office, "scopus=no_id&q=Echo"), {"Dr Echo Ece"})
        # A head's filter stays inside the department, whatever department they name.
        self.assertEqual(self.names(self.head, "scopus=gap"), {"Dr Alpha Cse", "Dr Bravo Cse"})
        self.assertEqual(self.names(self.head, "scopus=gap&department=ECE"), set())

    def test_the_summary_covers_the_whole_role_scope_whatever_the_list_shows(self):
        body = self.get(self.office, "/api/directory/faculty?limit=100&scopus=gap&q=Alpha")
        self.assertEqual([r["name"] for r in body["results"]], ["Dr Alpha Cse"])
        s, last = self.summary(body)
        self.assertEqual(s, {
            "faculty": 7, "with_id": 4, "without_id": 3, "never_synced": 1, "papers": 8, "scopus_papers": 5,
        })
        self.assertEqual(last, SYNC_LATE)

    def test_the_summary_follows_the_list_on_leavers(self):
        s, _ = self.summary(self.get(self.office, "/api/directory/faculty?limit=100"))
        self.assertEqual(s["faculty"], 7)
        s, _ = self.summary(self.get(self.office, "/api/directory/faculty?limit=100&include_left=true"))
        self.assertEqual((s["faculty"], s["without_id"], s["papers"], s["scopus_papers"]), (8, 4, 9, 6))

    def test_a_heads_summary_covers_their_department_only(self):
        body = self.get(self.head, "/api/directory/faculty?limit=100")
        self.assertEqual(body["scope"], "department")
        s, last = self.summary(body)
        self.assertEqual(s, {
            "faculty": 5, "with_id": 3, "without_id": 2, "never_synced": 1, "papers": 6, "scopus_papers": 4,
        })
        self.assertEqual(last, SYNC_LATE)


class ScopusQueryCountTests(TestCase):
    def test_the_queries_do_not_grow_with_the_faculty(self):
        office = _person("sq-office@test.edu", "Office Admin", Role.SUPER_ADMIN)
        client = Client()
        client.force_login(office)

        def add(start, stop):
            for i in range(start, stop):
                person = _person(
                    f"sq-{i}@test.edu", f"Dr Person {i:02d}", department="CSE", staff_id=f"Q{i}",
                    designation="Professor", scopus_author_id=f"{i + 1000}" if i % 2 else None,
                )
                _paper(person, f"Person {i:02d} indexed", indexed=True)
                _paper(person, f"Person {i:02d} neither")

        def measure():
            # Warm the process once, then time a cold-cache request: both measurements take the same path.
            cache.clear()
            client.get("/api/directory/faculty?limit=100")
            cache.clear()
            with CaptureQueriesContext(connection) as ctx:
                r = client.get("/api/directory/faculty?limit=100")
            self.assertEqual(r.status_code, 200, r.content)
            return len(ctx.captured_queries), r.json()

        add(0, 3)
        few, body = measure()
        self.assertEqual(body["total"], 3)
        self.assertIsNone(body["scopus_summary"]["last_synced_at"])
        add(3, 30)
        many, body = measure()
        self.assertEqual(body["total"], 30)
        self.assertEqual(many, few, f"{few} queries for 3 people, {many} for 30")
