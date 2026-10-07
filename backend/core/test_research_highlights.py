"""The research showcase: what the record shows has happened lately, counted, with no money in it."""
from __future__ import annotations

import json
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from core import hod
from core.models import Authorship, PaidLedger, Publication, Role, User
from core.services import honours_board, research_picture


def ago(days: int):
    return timezone.localdate() - timedelta(days=days)


def pub(title, when, *, quartile="", cites=0, venue="Signal Journal"):
    return Publication.objects.create(
        title=title, year=when.year if when else 2024, date=when, quartile=quartile, citations=cites,
        venue=venue, topics_json="[]", source="record",
    )


def by(p, *people, outsiders=()):
    for i, user in enumerate(people, start=1):
        Authorship.objects.create(
            publication=p, user=user, position=i, display_name=user.name,
            author_key=f"u:{user.id}", is_college=True,
        )
    for j, name in enumerate(outsiders, start=len(people) + 1):
        Authorship.objects.create(
            publication=p, user=None, position=j, display_name=name, author_key=f"n:{name.lower()}",
        )


def walk(body):
    """Every key and every string in a payload."""
    if isinstance(body, dict):
        for k, v in body.items():
            yield k
            yield from walk(v)
    elif isinstance(body, list):
        for v in body:
            yield from walk(v)
    elif isinstance(body, str):
        yield body


class HighlightsTests(TestCase):
    def setUp(self):
        research_picture._SHARED.update(sig=None, at=0.0, college=None)
        self.addCleanup(research_picture._SHARED.update, sig=None, at=0.0, college=None)
        honours_board.forget()
        self.addCleanup(honours_board.forget)
        mk = User.objects.create_user
        self.asha = mk(email="rh-asha@x.edu", name="Asha Menon", role=Role.FACULTY, department="ECE")
        self.ravi = mk(email="rh-ravi@x.edu", name="Ravi Kumar", role=Role.FACULTY, department="ECE")
        self.meera = mk(email="rh-meera@x.edu", name="Meera Pillai", role=Role.FACULTY, department="CSE")
        self.nila = mk(email="rh-nila@x.edu", name="Nila Sen", role=Role.FACULTY, department="CSE")
        self.left = mk(email="rh-left@x.edu", name="Left College", role=Role.FACULTY, department="CSE", active=False)

        # Asha: an older Q2 paper, then her first Q1 paper five days ago in a journal the college has not used.
        self.old = pub("An older paper", ago(400), quartile="Q2", cites=40, venue="Old Journal")
        by(self.old, self.asha)
        self.asha_q1 = pub("Quantum sensing at the edge", ago(5), quartile="Q1", venue="Quantum Letters")
        by(self.asha_q1, self.asha, outsiders=("Somebody Outside",))
        # Ravi: an older Q1 paper, so the new one is not his first. Meera is a co-author from another department.
        self.ravi_old_q1 = pub("Ravi earlier Q1", ago(300), quartile="Q1", venue="Signal Journal")
        by(self.ravi_old_q1, self.ravi)
        self.ravi_q1 = pub("Sparse filters for radar", ago(10), quartile="Q1", venue="Signal Journal")
        by(self.ravi_q1, self.ravi, self.meera)
        # Meera: a well-cited Q3 paper from three months ago.
        self.cited = pub("Graph kernels in practice", ago(100), quartile="Q3", cites=12, venue="Signal Journal")
        by(self.cited, self.meera)
        # Nila: her very first paper, two days ago, in a journal the college has not used.
        self.first = pub("My first paper", ago(2), venue="Fresh Journal")
        by(self.first, self.nila)
        # Things that must never appear.
        by(pub("Dated in the future", ago(-30), quartile="Q1", venue="Future Journal"), self.ravi)
        undated = Publication.objects.create(title="Year only", year=timezone.localdate().year, quartile="Q1", venue="Year Journal", source="record")
        # Meera's, not Asha's: a year-only Q1 paper sorts before any dated one in
        # its year, so on Asha it would rightly stop her new paper being her first Q1.
        by(undated, self.meera)
        by(pub("Written by somebody who left", ago(1), quartile="Q1", venue="Gone Journal"), self.left)

    def get(self, user=None, **params):
        query = "&".join(f"{k}={v}" for k, v in params.items())
        c = Client()
        if user is not False:
            c.force_login(user or self.asha)
        return c.get("/api/research/highlights" + (f"?{query}" if query else ""))

    def titles(self, body, section):
        return [p["title"] for p in body[section]]

    # ---- the sections ----

    def test_new_q1_papers_come_with_a_reason_that_is_true(self):
        body = self.get(period="month").json()
        self.assertEqual(self.titles(body, "q1"), ["Quantum sensing at the edge", "Sparse filters for radar"])
        reasons = {p["title"]: p["reason"] for p in body["q1"]}
        self.assertEqual(reasons["Quantum sensing at the edge"], "First Q1 paper for Asha Menon")
        self.assertEqual(reasons["Sparse filters for radar"], "In Signal Journal, a Q1 journal")

    def test_first_papers_are_a_journal_the_college_had_not_used_before(self):
        body = self.get(period="month").json()
        self.assertEqual(
            sorted(self.titles(body, "first_papers")), ["My first paper", "Quantum sensing at the edge"]
        )
        reasons = {p["title"]: p["reason"] for p in body["first_papers"]}
        self.assertEqual(reasons["Quantum sensing at the edge"], "The college's first paper in Quantum Letters")

    def test_most_cited_looks_back_a_year_at_least_and_says_what_the_count_means(self):
        body = self.get(period="month").json()
        self.assertEqual(self.titles(body, "most_cited"), ["Graph kernels in practice"])
        item = body["most_cited"][0]
        self.assertEqual(item["citations"], 12)
        self.assertTrue(item["reason"].startswith("Cited 12 times since it came out"), item["reason"])
        # A paper from 400 days ago is outside the year, however well it did.
        self.assertNotIn("An older paper", self.titles(body, "most_cited"))
        self.assertEqual(body["windows"]["most_cited_days"], 365)

    def test_new_names_are_people_whose_first_paper_on_the_record_is_in_the_window(self):
        body = self.get(period="month").json()
        self.assertEqual(self.titles(body, "new_names"), ["My first paper"])
        item = body["new_names"][0]
        self.assertEqual(item["reason"], "First paper on the college record for Nila Sen")
        # Somebody with an earlier paper is not new, whatever they published this month.
        self.assertNotIn("Quantum sensing at the edge", self.titles(body, "new_names"))

    def test_by_department_counts_each_paper_once_per_department(self):
        body = self.get(period="month").json()
        got = {row["department"]: (row["papers"], row["q1"]) for row in body["by_department"]}
        # ECE: the Quantum paper and the radar paper. CSE: the radar paper (Meera) and Nila's first paper.
        self.assertEqual(got, {"ECE": (2, 2), "CSE": (2, 1)})
        # Most papers first; a tie goes to the department with more Q1 papers.
        self.assertEqual([r["department"] for r in body["by_department"]], ["ECE", "CSE"])

    def test_a_longer_window_reaches_further_back(self):
        month = self.get(period="month").json()
        year = self.get(period="year").json()
        self.assertEqual(self.titles(month, "q1"), ["Quantum sensing at the edge", "Sparse filters for radar"])
        self.assertEqual(
            self.titles(year, "q1"),
            ["Quantum sensing at the edge", "Sparse filters for radar", "Ravi earlier Q1"],
        )
        quarter = self.get(period="quarter").json()
        self.assertEqual(self.titles(quarter, "q1"), self.titles(month, "q1"))
        self.assertEqual(quarter["to"], timezone.localdate().isoformat())

    def test_a_department_narrows_the_papers_to_those_with_somebody_from_it(self):
        body = self.get(period="month", department="cse").json()
        self.assertEqual(self.titles(body, "q1"), ["Sparse filters for radar"])  # Meera co-wrote it
        self.assertEqual(self.titles(body, "new_names"), ["My first paper"])
        self.assertEqual(body["department"], "CSE")
        self.assertEqual(body["departments"], ["CSE", "ECE"])
        # The sentence on the page is about the department, so its totals are too:
        # the radar paper (Meera) and Nila's first paper, by Ravi, Meera and Nila.
        self.assertEqual(body["totals"], {"papers": 2, "q1": 1, "people": 3})
        # The bars are the whole college, so the department can be seen among the rest.
        self.assertEqual({r["department"] for r in body["by_department"]}, {"ECE", "CSE"})

    def test_authors_are_the_people_here_with_a_way_to_open_them(self):
        body = self.get(period="month").json()
        radar = next(p for p in body["q1"] if p["title"] == "Sparse filters for radar")
        self.assertEqual(
            sorted((a["name"], a["department"]) for a in radar["authors"]),
            [("Meera Pillai", "CSE"), ("Ravi Kumar", "ECE")],
        )
        self.assertTrue(all(a["id"] for a in radar["authors"]))
        self.assertEqual((radar["venue"], radar["quartile"]), ("Signal Journal", "Q1"))
        self.assertEqual(radar["date"], ago(10).isoformat())
        # The outside co-author of the Quantum paper is not a college author.
        quantum = next(p for p in body["q1"] if p["title"] == "Quantum sensing at the edge")
        self.assertEqual([a["name"] for a in quantum["authors"]], ["Asha Menon"])

    def test_nothing_future_dated_undated_or_by_somebody_who_left_is_shown(self):
        body = self.get(period="year").json()
        everything = set(walk(body))
        for title in ("Dated in the future", "Year only", "Written by somebody who left"):
            self.assertNotIn(title, everything)

    # ---- emptiness, access, and money ----

    def test_an_empty_record_gives_empty_sections_and_says_so(self):
        Publication.objects.all().delete()
        research_picture._SHARED.update(sig=None, at=0.0, college=None)
        honours_board.forget()
        body = self.get(period="month").json()
        for section in ("q1", "first_papers", "most_cited", "new_names", "by_department"):
            self.assertEqual(body[section], [], section)
        self.assertTrue(body["empty"])

    def test_a_bad_period_is_refused_and_a_signed_out_reader_is_turned_away(self):
        self.assertEqual(self.get(period="decade").status_code, 400)
        self.assertEqual(self.get(False, period="month").status_code, 401)

    def test_the_default_is_the_past_year(self):
        body = self.get().json()
        self.assertEqual(body["period"], "year")
        self.assertEqual(body["from"], ago(365).isoformat())

    def test_every_role_that_can_sign_in_may_read_it(self):
        for role in (Role.HOD, Role.PRINCIPAL, Role.FINANCE, Role.RESEARCH_CELL):
            who = User.objects.create_user(email=f"rh-{role}@x.edu", name=str(role), role=role)
            self.assertEqual(self.get(who, period="month").status_code, 200, role)

    def test_no_money_is_in_it_whatever_the_ledger_holds(self):
        PaidLedger.objects.create(
            payout_month=timezone.localdate().replace(day=1), amount=123456.0, paper_title="Graph kernels in practice",
            staff_id="S-1", raw_json=json.dumps({}),
        )
        for period in ("month", "quarter", "year"):
            body = self.get(period=period).json()
            seen = set(walk(body))
            self.assertFalse(seen & hod.MONEY_KEYS, seen & hod.MONEY_KEYS)
            text = json.dumps(body, ensure_ascii=False).lower()
            for needle in ("123456", "â‚¹", "rupee", "remuneration", "incentive"):
                self.assertNotIn(needle, text)
