"""The co-author map for a prolific author, and what "college member" means.

Pinned here:
- somebody with more first-step co-authors than the map holds still gets
  second-step people (co-authors' co-authors), because a third of the seats is
  kept for them, and colleagues come before outsiders;
- someone who wrote with me is never listed as a second-step suggestion;
- `has_account` (matched to a person on this app) and `at_college` (an author
  of the college, with or without an account) are separate facts, and the old
  `is_college_member` still equals `has_account`.
"""

from __future__ import annotations

from django.test import Client, TestCase

from core.models import Authorship, Publication, Role, User
from core.services import coauthors as graph


def _paper(pid: str, year: int = 2024) -> Publication:
    return Publication.objects.create(id=pid, title=f"Paper {pid}", year=year, source="record")


def _author(pub: Publication, key: str, name: str, *, user: User | None = None, college: bool = False, pos: int = 1):
    return Authorship.objects.create(
        publication=pub, display_name=name, author_key=f"u:{user.id}" if user else key,
        user=user, is_college=college, position=pos,
    )


class ProlificEgoTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(email="me@x.edu", password=None, name="Dr Prolific", role=Role.FACULTY,
                                           department="Physics")
        # 80 first-step co-authors (each on a paper with me), the first ten also
        # wrote a paper with an outsider, and two of them with a colleague.
        for i in range(80):
            p = _paper(f"P{i:03d}")
            _author(p, "", "Dr Prolific", user=self.me)
            _author(p, f"A{i:03d}", f"Coauthor {i:03d}", pos=2)
        self.colleague = User.objects.create_user(email="col@x.edu", password=None, name="Dr Far Colleague",
                                                  role=Role.FACULTY, department="Chemistry")
        for i in range(10):
            p = _paper(f"Q{i:03d}")
            _author(p, f"A{i:03d}", f"Coauthor {i:03d}")
            _author(p, f"X{i:03d}", f"Outsider {i:03d}", pos=2)
            if i < 2:
                _author(p, "", "Dr Far Colleague", user=self.colleague, pos=3)

    def test_second_step_survives_more_than_59_coauthors(self):
        body = graph.ego(self.me)
        hops = [n["hop"] for n in body["nodes"]]
        self.assertEqual(len(body["nodes"]), 60)
        self.assertEqual(hops.count(0), 1)
        self.assertGreater(hops.count(2), 0)
        self.assertEqual(hops.count(1), 60 - 1 - hops.count(2))
        self.assertEqual(body["coauthors"], 80)
        self.assertTrue(body["capped"])

    def test_colleagues_lead_the_second_step_and_are_linked_to_who_leads_there(self):
        body = graph.ego(self.me)
        second = [n for n in body["nodes"] if n["hop"] == 2]
        self.assertEqual(second[0]["name"], "Dr Far Colleague")
        self.assertTrue(second[0]["at_college"])
        keys = {n["key"] for n in body["nodes"] if n["hop"] == 1}
        via = {l["source"] if l["target"] == second[0]["key"] else l["target"]
               for l in body["links"] if second[0]["key"] in (l["source"], l["target"])}
        self.assertTrue(via & keys, "a second-step person must be linked to a first-step one")

    def test_a_first_step_coauthor_left_out_of_the_map_is_not_called_second_step(self):
        body = graph.ego(self.me)
        second = {n["key"] for n in body["nodes"] if n["hop"] == 2}
        firsts = {f"A{i:03d}" for i in range(80)}
        self.assertFalse(second & firsts)

    def test_few_coauthors_all_appear_as_before(self):
        loner = User.objects.create_user(email="l@x.edu", password=None, name="Dr Few", role=Role.FACULTY)
        p = _paper("LONER")
        _author(p, "", "Dr Few", user=loner)
        _author(p, "A001", "Coauthor 001", pos=2)
        body = graph.ego(loner)
        self.assertEqual(sorted(n["hop"] for n in body["nodes"] if n["hop"]), [1] + [2] * (len(body["nodes"]) - 2))
        self.assertFalse(body["capped"])

    def test_the_api_serves_it_within_the_cap(self):
        c = Client()
        c.force_login(self.me)
        r = c.get("/api/people/me/ego?limit=60")
        self.assertEqual(r.status_code, 200)
        self.assertLessEqual(len(r.json()["nodes"]), 60)
        self.assertTrue(any(n["hop"] == 2 for n in r.json()["nodes"]))


class MembershipFieldTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(email="me@x.edu", password=None, name="Dr Me", role=Role.FACULTY)
        self.member = User.objects.create_user(email="m@x.edu", password=None, name="Dr Member", role=Role.FACULTY,
                                               department="Physics")
        p = _paper("M1")
        _author(p, "", "Dr Me", user=self.me)
        _author(p, "", "Dr Member", user=self.member, pos=2)
        # A colleague of the college who has no account here, and an outsider.
        _author(p, "A77", "Dr No Account", college=True, pos=3)
        _author(p, "A88", "Prof Outside", pos=4)

    def test_coauthors_say_both_facts(self):
        body = graph.coauthors(self.me)
        by_name = {c["name"]: c for c in body["inside"] + body["outside"]}
        member, ghost, outsider = by_name["Dr Member"], by_name["Dr No Account"], by_name["Prof Outside"]
        self.assertEqual((member["has_account"], member["at_college"]), (True, True))
        self.assertEqual((ghost["has_account"], ghost["at_college"]), (False, True))
        self.assertEqual((outsider["has_account"], outsider["at_college"]), (False, False))
        self.assertIn(ghost, body["inside"])
        self.assertIn(outsider, body["outside"])

    def test_the_old_field_still_means_has_an_account(self):
        body = graph.coauthors(self.me)
        for c in body["inside"] + body["outside"]:
            self.assertEqual(c["is_college_member"], c["has_account"], c["name"])

    def test_ego_and_paths_carry_the_same_fields(self):
        nodes = {n["name"]: n for n in graph.ego(self.me)["nodes"]}
        self.assertEqual(nodes["Dr No Account"]["has_account"], False)
        self.assertEqual(nodes["Dr No Account"]["at_college"], True)
        self.assertEqual(nodes["Dr No Account"]["is_college_member"], False)
        self.assertEqual(nodes["Dr Member"]["is_college_member"], True)
        path = graph.connection(f"u:{self.me.id}", "A77")["paths"][0]["people"]
        self.assertEqual([(s["has_account"], s["at_college"], s["is_college_member"]) for s in path],
                         [(True, True, True), (False, True, False)])
