"""Student teams: who sees which, how they are listed and found, and the
reviewer's team check.

Every name, register number and code below is made up in the test.
"""
from __future__ import annotations

import json

from django.test import Client, TestCase
from django.utils import timezone

from core.hod import MONEY_KEYS
from core.models import Claim, ClaimReason, ClaimStatus, Role, Team, TeamMember, User
from core.services import student_teams


def _person(email, name, *, role=Role.FACULTY, **extra):
    return User.objects.create_user(email=email, password=None, name=name, role=role, **extra)


def _team(code, mentor=None, *, department="CSE", year="2025-26", title=None, students=(), articles=(),
          mentor_name=None):
    team = Team.objects.create(
        code=code, department=department, academic_year=year, title=title,
        mentor=mentor, mentor_name=mentor_name or (mentor.name if mentor else None),
        mentor_staff_id=mentor.staff_id if mentor else None,
        publications=[
            {"article_title": t, "source_title": "A Conference", "doi": d, "publication_date": "2026-03-01"}
            for t, d in articles
        ],
    )
    for reg, name in students:
        TeamMember.objects.create(team=team, name=name, register_number=reg)
    return team


def _claim(owner, team, *, status=ClaimStatus.SUBMITTED, ticket="FP-2026-000101",
           publication_type="Conference Paper", reason=ClaimReason.STUDENT_PROJECT, amount=15000.0, **kw):
    return Claim.objects.create(
        owner=owner, team=team, status=status, ticket_number=ticket, claim_reason=reason,
        publication_type=publication_type, paper_title="Synthetic conference paper",
        remuneration=amount, submitted_at=timezone.now(), **kw,
    )


class Base(TestCase):
    def setUp(self):
        self.mentor = _person("m1@test.edu", "Mentor One", department="CSE", staff_id="T001")
        self.other = _person("m2@test.edu", "Mentor Two", department="ECE", staff_id="T002")
        self.cse_mate = _person("m3@test.edu", "Mentor Three", department="CSE", staff_id="T003")
        self.hod = _person("hod@test.edu", "Head CSE", role=Role.HOD, department="CSE", staff_id="T900")
        self.office = _person("office@test.edu", "Office", role=Role.RESEARCH_CELL)
        self.principal = _person("princ@test.edu", "Principal", role=Role.PRINCIPAL)
        self.director = _person("dir@test.edu", "Director", role=Role.DIRECTOR)

        self.t1 = _team(
            "ZZ26CS0001", self.mentor, title="Alpha routing",
            students=[("900000000001", "Asha Test"), ("900000000002", "Bala Test")],
            articles=[("Routing for tiny networks", "10.9999/alpha.1")],
        )
        self.t2 = _team("ZZ26CS0002", self.cse_mate, title="Beta vision",
                        students=[("900000000003", "Charu Test")])
        self.t3 = _team("ZZ26EC0001", self.other, department="ECE", title="Gamma radio",
                        students=[("900000000004", "Dev Test")],
                        articles=[("Antenna arrays", "10.9999/gamma.1"), ("Filters", "10.9999/gamma.2")])
        self.claim1 = _claim(self.mentor, self.t1)

    def get(self, user, path, **params):
        c = Client()
        c.force_login(user)
        return c.get(path, params)


class VisibilityTests(Base):
    def codes(self, user, **params):
        r = self.get(user, "/api/teams", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return [t["code"] for t in r.json()["results"]]

    def test_the_office_the_principal_and_the_director_see_every_team(self):
        for u in (self.office, self.principal, self.director):
            self.assertEqual(sorted(self.codes(u)), ["ZZ26CS0001", "ZZ26CS0002", "ZZ26EC0001"], u.role)

    def test_a_faculty_member_sees_only_the_teams_they_mentor(self):
        self.assertEqual(self.codes(self.mentor), ["ZZ26CS0001"])
        self.assertEqual(self.codes(self.other), ["ZZ26EC0001"])

    def test_a_faculty_member_cannot_search_their_way_to_somebody_else_s_team(self):
        self.assertEqual(self.codes(self.mentor, q="Gamma"), [])
        self.assertEqual(self.codes(self.mentor, q="900000000004"), [])
        self.assertEqual(self.codes(self.mentor, q="ZZ26EC0001"), [])

    def test_somebody_else_s_team_is_a_404_exactly_like_one_that_does_not_exist(self):
        self.assertEqual(self.get(self.mentor, "/api/teams/ZZ26EC0001").status_code, 404)
        self.assertEqual(self.get(self.mentor, "/api/teams/NOPE").status_code, 404)
        self.assertEqual(self.get(self.mentor, "/api/teams/zz26cs0001").status_code, 200)

    def test_a_head_sees_their_department_and_not_another(self):
        self.assertEqual(sorted(self.codes(self.hod)), ["ZZ26CS0001", "ZZ26CS0002"])
        self.assertEqual(self.get(self.hod, "/api/teams/ZZ26EC0001").status_code, 404)
        self.assertEqual(self.get(self.hod, "/api/teams").json()["scope"], "department")

    def test_a_head_sees_a_department_spelt_another_way_on_the_roster(self):
        _team("ZZ26CS0003", self.other, department="cse", students=[("900000000009", "Eli Test")])
        self.assertIn("ZZ26CS0003", self.codes(self.hod))

    def test_a_head_also_sees_a_team_they_mentor_outside_their_department(self):
        _team("ZZ26EC0002", self.hod, department="ECE")
        self.assertIn("ZZ26EC0002", self.codes(self.hod))

    def test_a_head_is_never_shown_money_or_the_payment_stage(self):
        Claim.objects.filter(pk=self.claim1.pk).update(status=ClaimStatus.PAID)
        listing = self.get(self.hod, "/api/teams").json()
        detail = self.get(self.hod, "/api/teams/ZZ26CS0001").json()
        self.assertFalse(listing["money"])
        self.assertEqual(detail["claim"]["stage"], "Completed")
        self.assertEqual(detail["claim"]["status"], "Completed")

        def keys(value):
            if isinstance(value, dict):
                for k, v in value.items():
                    yield k
                    yield from keys(v)
            elif isinstance(value, list):
                for v in value:
                    yield from keys(v)

        for body in (listing, detail):
            self.assertEqual(set(keys(body)) & MONEY_KEYS, set())
        self.assertNotIn("PAID", json.dumps([listing, detail]))

    def test_the_office_sees_the_amount_and_a_mentor_sees_their_own(self):
        for u in (self.office, self.mentor):
            row = self.get(u, "/api/teams", q="ZZ26CS0001").json()["results"][0]
            self.assertEqual(row["claim"]["amount"], 15000.0, u.role)

    def test_finance_is_not_shown_the_college_s_teams(self):
        finance = _person("fin@test.edu", "Finance", role=Role.FINANCE)
        self.assertEqual(self.codes(finance), [])

    def test_a_signed_out_reader_is_refused(self):
        self.assertIn(Client().get("/api/teams").status_code, (401, 403))


class ListTests(Base):
    def rows(self, user=None, **params):
        r = self.get(user or self.office, "/api/teams", **params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_a_row_carries_what_the_page_needs(self):
        row = next(r for r in self.rows()["results"] if r["code"] == "ZZ26CS0001")
        self.assertEqual(row["academic_year"], "2025-26")
        self.assertEqual(row["department"], "CSE")
        self.assertEqual(row["mentor"]["name"], "Mentor One")
        self.assertEqual(row["mentor"]["staff_id"], "T001")
        self.assertEqual(row["mentor"]["id"], self.mentor.id)
        self.assertEqual(sorted(s["reg_no"] for s in row["students"]), ["900000000001", "900000000002"])
        self.assertEqual(row["student_count"], 2)
        self.assertEqual(row["project_title"], "Alpha routing")
        self.assertEqual(row["publications_count"], 1)
        self.assertEqual(row["claim"]["ticket_number"], "FP-2026-000101")
        self.assertEqual(row["claim"]["id"], self.claim1.id)
        self.assertEqual(row["claim"]["stage"], "Submitted")

    def test_a_team_nobody_claimed_has_no_claim(self):
        row = next(r for r in self.rows()["results"] if r["code"] == "ZZ26CS0002")
        self.assertIsNone(row["claim"])

    def test_the_search_finds_a_team_by_its_code_a_register_number_a_name_or_a_title(self):
        def found(q):
            return [t["code"] for t in self.rows(q=q)["results"]]

        self.assertEqual(found("zz26cs0001"), ["ZZ26CS0001"])
        self.assertEqual(found("900000000003"), ["ZZ26CS0002"])
        self.assertEqual(found("bala"), ["ZZ26CS0001"])
        self.assertEqual(found("Beta vision"), ["ZZ26CS0002"])
        self.assertEqual(found("Routing for tiny"), ["ZZ26CS0001"])
        self.assertEqual(found("10.9999/gamma.2"), ["ZZ26EC0001"])
        self.assertEqual(found("T002"), ["ZZ26EC0001"])
        self.assertEqual(found("nothing like it"), [])

    def test_the_filters_narrow_by_year_department_and_mentor(self):
        _team("ZZ25CS0001", self.mentor, year="2024-25")
        self.assertEqual([t["code"] for t in self.rows(academic_year="2024-25")["results"]], ["ZZ25CS0001"])
        self.assertEqual(
            sorted(t["code"] for t in self.rows(department="ECE")["results"]), ["ZZ26EC0001"]
        )
        self.assertEqual(
            sorted(t["code"] for t in self.rows(mentor="T001")["results"]), ["ZZ25CS0001", "ZZ26CS0001"]
        )

    def test_the_status_filter(self):
        def found(status):
            return sorted(t["code"] for t in self.rows(status=status)["results"])

        self.assertEqual(found("claimed"), ["ZZ26CS0001"])
        self.assertEqual(found("unclaimed"), ["ZZ26CS0002", "ZZ26EC0001"])
        self.assertEqual(found("with_publication"), ["ZZ26CS0001", "ZZ26EC0001"])
        self.assertEqual(found("no_publication"), ["ZZ26CS0002"])
        # Together they mean "and": a team with a paper and nothing claimed.
        self.assertEqual(found("with_publication,unclaimed"), ["ZZ26EC0001"])

    def test_a_withdrawn_or_rejected_claim_no_longer_holds_the_team(self):
        Claim.objects.filter(pk=self.claim1.pk).update(status=ClaimStatus.REJECTED, rejected_outright=True)
        self.assertEqual([t["code"] for t in self.rows(status="claimed")["results"]], [])
        self.assertIsNone(self.rows(q="ZZ26CS0001")["results"][0]["claim"])

    def test_the_counts_follow_the_filters_and_the_list_is_paged(self):
        everything = self.rows()
        self.assertEqual(everything["total"], 3)
        self.assertEqual(
            everything["counts"], {"teams": 3, "students": 4, "with_publication": 2, "claimed": 1}
        )
        self.assertEqual(everything["years"], ["2025-26"])
        self.assertEqual(everything["departments"], ["CSE", "ECE"])
        page = self.rows(limit=2)
        self.assertEqual((len(page["results"]), page["total"]), (2, 3))
        later = self.rows(limit=2, offset=2)
        self.assertEqual(len(later["results"]), 1)
        self.assertEqual(self.rows(department="ECE")["counts"]["teams"], 1)

    def test_the_old_picker_is_unchanged(self):
        r = self.get(self.mentor, "/api/teams", mine="true").json()["results"]
        self.assertEqual([t["code"] for t in r], ["ZZ26CS0001"])
        self.assertEqual(r[0]["claimed_by"]["ticket_number"], "FP-2026-000101")


class DetailTests(Base):
    def test_the_detail_has_the_articles_and_the_claim_history(self):
        _claim(
            self.mentor, self.t1, status=ClaimStatus.REJECTED, ticket="FP-2026-000099",
            rejected_outright=True,
        )
        d = self.get(self.office, "/api/teams/ZZ26CS0001").json()
        self.assertEqual(d["publications"][0]["article_title"], "Routing for tiny networks")
        self.assertEqual(d["publications_count"], 1)
        history = {c["ticket_number"]: c for c in d["claims"]}
        self.assertTrue(history["FP-2026-000101"]["holds_team"])
        self.assertFalse(history["FP-2026-000099"]["holds_team"])
        self.assertEqual(history["FP-2026-000099"]["stage"], "Rejected")
        self.assertEqual(d["students"][0].keys() >= {"reg_no", "name"}, True)
        # the older keys the filing form and the importer's tests read
        self.assertEqual(len(d["members"]), 2)
        self.assertEqual(d["claim"]["id"], self.claim1.id)

    def test_somebody_s_unfiled_draft_is_not_in_the_history_an_office_reader_sees(self):
        _claim(self.mentor, self.t1, status=ClaimStatus.DRAFT, ticket=None)
        office = self.get(self.office, "/api/teams/ZZ26CS0001").json()
        mine = self.get(self.mentor, "/api/teams/ZZ26CS0001").json()
        self.assertEqual(len(office["claims"]), 1)
        self.assertEqual(len(mine["claims"]), 2)

    def test_the_claim_links_to_review_for_a_desk_and_to_the_paper_for_its_owner(self):
        office = self.get(self.office, "/api/teams/ZZ26CS0001").json()["claim"]["url"]
        owner = self.get(self.mentor, "/api/teams/ZZ26CS0001").json()["claim"]["url"]
        self.assertTrue(office.startswith(f"/review/{self.claim1.id}"), office)
        self.assertEqual(owner, f"/papers/{self.claim1.id}")

    def test_only_the_mentor_may_file_and_only_while_nothing_holds_the_team(self):
        free = self.get(self.cse_mate, "/api/teams/ZZ26CS0002").json()
        self.assertTrue(free["can_file"])
        held = self.get(self.mentor, "/api/teams/ZZ26CS0001").json()
        self.assertFalse(held["can_file"])
        self.assertIn("already claimed", held["cannot_file_because"])
        # the office and the head can look, and cannot file for the mentor from here
        for u in (self.office, self.hod, self.principal):
            d = self.get(u, "/api/teams/ZZ26CS0002").json()
            self.assertFalse(d["can_file"], u.role)
            self.assertIn("Mentor Three", d["cannot_file_because"])

    def test_a_rejected_outright_team_can_be_filed_again(self):
        Claim.objects.filter(pk=self.claim1.pk).update(status=ClaimStatus.REJECTED, rejected_outright=True)
        self.assertTrue(self.get(self.mentor, "/api/teams/ZZ26CS0001").json()["can_file"])


class ByStudentTests(Base):
    def test_a_register_number_finds_its_team(self):
        r = self.get(self.office, "/api/teams/by-student/900000000002").json()
        self.assertEqual([t["code"] for t in r["results"]], ["ZZ26CS0001"])

    def test_a_student_on_two_teams_in_two_years_finds_both_newest_first(self):
        old = _team("ZZ25CS0009", self.mentor, year="2024-25", students=[("900000000002", "Bala Test")])
        r = self.get(self.office, "/api/teams/by-student/900000000002").json()
        self.assertEqual([t["code"] for t in r["results"]], ["ZZ26CS0001", old.code])

    def test_it_answers_only_with_the_teams_the_reader_may_see(self):
        self.assertEqual(self.get(self.mentor, "/api/teams/by-student/900000000004").json()["results"], [])
        self.assertEqual(
            [t["code"] for t in self.get(self.other, "/api/teams/by-student/900000000004").json()["results"]],
            ["ZZ26EC0001"],
        )

    def test_an_unknown_number_is_an_empty_answer_not_an_error(self):
        r = self.get(self.office, "/api/teams/by-student/000")
        self.assertEqual((r.status_code, r.json()["results"]), (200, []))


class SearchTests(Base):
    def search(self, user, q):
        r = self.get(user, "/api/search/all", q=q)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def team_group(self, body):
        return next(g for g in body["groups"] if g["kind"] == "team")

    def test_a_register_number_finds_the_team_and_names_the_student(self):
        body = self.search(self.office, "900000000001")
        item = self.team_group(body)["items"][0]
        self.assertEqual(item["url"], "/teams/ZZ26CS0001")
        self.assertIn("Asha Test (900000000001)", item["subtitle"])
        self.assertEqual(body["exact"]["kind"], "team")
        self.assertEqual(body["exact"]["url"], "/teams/ZZ26CS0001")

    def test_a_team_code_is_the_exact_answer(self):
        body = self.search(self.mentor, "zz26cs0001")
        self.assertEqual(body["exact"]["kind"], "team")
        self.assertEqual(self.team_group(body)["items"][0]["title"], "Team ZZ26CS0001")

    def test_a_faculty_member_does_not_find_somebody_else_s_team(self):
        for q in ("900000000004", "ZZ26EC0001", "Dev Test"):
            body = self.search(self.mentor, q)
            self.assertEqual(self.team_group(body)["items"], [], q)
            self.assertNotEqual((body["exact"] or {}).get("kind"), "team", q)

    def test_a_head_finds_their_department_s_teams_only(self):
        self.assertEqual(len(self.team_group(self.search(self.hod, "900000000003"))["items"]), 1)
        self.assertEqual(self.team_group(self.search(self.hod, "900000000004"))["items"], [])


class TeamCheckTests(Base):
    """The reviewer's five lines on a student-project claim."""

    def check(self, claim=None, user=None):
        claim = claim or self.claim1
        r = self.get(user or self.office, f"/api/claims/{claim.id}/review")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["team_check"]

    def failing(self, check):
        return {l["key"] for l in check["lines"] if not l["ok"]}

    def test_a_sound_claim_passes_all_five(self):
        check = self.check()
        self.assertTrue(check["ok"])
        self.assertEqual([l["key"] for l in check["lines"]],
                         ["roster", "mentor", "unclaimed", "students", "conference"])
        self.assertEqual(check["team_url"], "/teams/ZZ26CS0001")
        self.assertIn("2 students", " ".join(l["text"] for l in check["lines"]))

    def test_another_kind_of_claim_has_no_team_check(self):
        plain = _claim(self.mentor, None, reason=ClaimReason.INCENTIVE, ticket="FP-2026-000102")
        self.assertIsNone(self.check(plain))

    def test_a_claim_with_no_team_fails_the_roster_line(self):
        loose = _claim(self.mentor, None, ticket="FP-2026-000103")
        check = self.check(loose)
        self.assertFalse(check["ok"])
        self.assertIn("roster", self.failing(check))

    def test_a_mentor_who_is_not_the_claimant_fails(self):
        Team.objects.filter(pk=self.t1.pk).update(mentor=self.other, mentor_name="Mentor Two")
        check = self.check()
        self.assertEqual(self.failing(check), {"mentor"})
        line = next(l for l in check["lines"] if l["key"] == "mentor")
        self.assertIn("Mentor Two", line["text"])
        self.assertIn("Mentor One", line["text"])

    def test_a_team_with_no_account_for_its_mentor_fails_the_mentor_line(self):
        Team.objects.filter(pk=self.t1.pk).update(mentor=None, mentor_name="Dr. Roster Only")
        check = self.check()
        self.assertEqual(self.failing(check), {"mentor"})

    def test_a_team_claimed_elsewhere_names_the_other_claim(self):
        Claim.objects.create(
            owner=self.mentor, team=self.t1, status=ClaimStatus.PAID, ticket_number="FP-2025-000007",
            claim_reason=ClaimReason.STUDENT_PROJECT, publication_type="Conference Paper",
            submitted_at=timezone.now() - timezone.timedelta(days=30),
        )
        check = self.check()
        self.assertEqual(self.failing(check), {"unclaimed"})
        line = next(l for l in check["lines"] if l["key"] == "unclaimed")
        self.assertIn("FP-2025-000007", line["text"])

    def test_a_team_with_no_students_fails(self):
        TeamMember.objects.filter(team=self.t1).delete()
        self.assertEqual(self.failing(self.check()), {"students"})

    def test_a_paper_that_is_not_a_conference_paper_fails(self):
        Claim.objects.filter(pk=self.claim1.pk).update(publication_type="Journal")
        check = self.check()
        self.assertEqual(self.failing(check), {"conference"})
        self.assertFalse(check["ok"])

    def test_a_paper_with_no_type_fails_too(self):
        Claim.objects.filter(pk=self.claim1.pk).update(publication_type=None)
        self.assertEqual(self.failing(self.check()), {"conference"})

    def test_the_principal_sees_it_and_a_faculty_member_cannot_ask(self):
        self.assertTrue(self.check(user=self.principal)["ok"])
        r = self.get(self.cse_mate, f"/api/claims/{self.claim1.id}/review")
        self.assertEqual(r.status_code, 403)

    def test_the_review_workspace_carries_the_same_lines(self):
        r = self.get(self.office, f"/api/claims/{self.claim1.id}/workspace")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["review"]["team_check"], self.check())

    def test_the_service_gives_the_same_answer_as_the_endpoint(self):
        self.assertEqual(student_teams.team_check(self.claim1), self.check())
