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
"""
from __future__ import annotations

import csv
import io
from datetime import date

from django.test import Client, TestCase
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
        cls.cell = _person("fd-cell@test.edu", "Research Cell", Role.RESEARCH_CELL, department="Research")
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
