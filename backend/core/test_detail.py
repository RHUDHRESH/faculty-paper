"""The detail panels: paper, journal, person card and "what's behind this number".

Pinned: the owner gets 200; a stranger is refused the paper; the metric
endpoint is the caller's own record; and no rupee key reaches anybody,
heads of department included.
"""

from __future__ import annotations

import json
from datetime import date

from django.test import Client, TestCase

from core.models import Authorship, Claim, ClaimStatus, Publication, Role, User
from core.test_search import money_keys_in


def pub(title, year, *, cites=0, quartile="", venue="Journal A", topics=()):
    return Publication.objects.create(title=title, year=year, date=date(year, 3, 1), citations=cites,
                                      quartile=quartile, venue=venue, topics_json=json.dumps(list(topics)),
                                      doi=f"10.1/{title[:4].lower()}")


def on(p, user=None, position=1, name="X"):
    return Authorship.objects.create(publication=p, user=user, position=position,
                                     display_name=user.name if user else name,
                                     author_key=f"u:{user.id}" if user else f"n:{name.lower()}",
                                     is_college=bool(user))


class DetailTests(TestCase):
    def setUp(self):
        mk = lambda e, n, d, role=Role.FACULTY: User.objects.create_user(  # noqa: E731
            email=e, password="p", name=n, role=role, staff_id=e[:3], department=d)
        self.me = mk("me@x.edu", "Me Author", "EEE")
        self.co = mk("co@x.edu", "Co Author", "EEE")
        self.stranger = mk("st@x.edu", "Stranger", "ECE")
        self.hod = mk("hd@x.edu", "Head Person", "EEE", Role.HOD)
        self.a = pub("Grid inverter control", 2019, cites=12, quartile="Q1", venue="IEEE Power",
                     topics=["Power systems"])
        on(self.a, self.me, 1)
        on(self.a, self.co, 2)
        on(self.a, name="Outside Prof", position=3)
        self.b = pub("Solar harvesting", 2026, cites=3, venue="IEEE Power", topics=["Solar energy"])
        on(self.b, self.me, 2)
        Claim.objects.create(owner=self.me, paper_title="Grid inverter control",
                             normalized_title="grid inverter control", doi=self.a.doi,
                             status=ClaimStatus.PAID, remuneration=25000)

    def client_for(self, user):
        c = Client()
        c.force_login(user)
        return c

    def test_paper_detail_for_an_author(self):
        r = self.client_for(self.me).get(f"/api/papers/{self.a.id}/detail")
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual(money_keys_in(d), [])
        self.assertEqual([a["name"] for a in d["authors"]], ["Me Author", "Co Author", "Outside Prof"])
        self.assertEqual(d["authors"][1]["user_id"], self.co.id)
        self.assertEqual(d["venue"], "IEEE Power")
        self.assertEqual(d["mine"]["stage"], "Paid")
        self.assertEqual(d["links"]["doi"], f"https://doi.org/{self.a.doi}")

    def test_paper_detail_refuses_a_stranger_and_a_missing_paper(self):
        c = self.client_for(self.stranger)
        self.assertEqual(c.get(f"/api/papers/{self.a.id}/detail").status_code, 403)
        self.assertEqual(c.get("/api/papers/nope/detail").status_code, 404)

    def test_head_of_department_sees_no_money(self):
        r = self.client_for(self.hod).get(f"/api/papers/{self.a.id}/detail")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(money_keys_in(r.json()), [])
        self.assertIsNone(r.json()["mine"])
        for path in ("/api/journals/detail?name=IEEE%20Power", f"/api/people/{self.me.id}/card"):
            r = self.client_for(self.hod).get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertEqual(money_keys_in(r.json()), [], path)

    def test_journal_detail_for_faculty(self):
        r = self.client_for(self.me).get("/api/journals/detail?name=IEEE Power")
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual(d["college"]["count"], 2)
        self.assertEqual(len(d["mine"]), 2)
        self.assertEqual([p["name"] for p in d["colleagues"]], ["Co Author"])
        self.assertIsNone(d["watch"])
        self.assertEqual(self.client_for(self.me).get("/api/journals/detail?name=Nowhere%20Weekly").status_code, 404)

    def test_person_card(self):
        r = self.client_for(self.stranger).get(f"/api/people/{self.me.id}/card")
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual((d["papers"], d["citations"]), (2, 15))
        self.assertIn("Power systems", d["topics"])
        self.assertEqual(self.client_for(self.me).get("/api/people/nobody/card").status_code, 404)

    def test_my_metrics(self):
        c = self.client_for(self.me)
        h = c.get("/api/me/metric/h_index").json()
        self.assertEqual(h["title"], "h-index 2")
        self.assertEqual([p["title"] for p in h["papers"]], ["Grid inverter control", "Solar harvesting"])
        self.assertEqual(c.get("/api/me/metric/year?year=2026").json()["count"], 1)
        self.assertEqual(c.get("/api/me/metric/quartile?value=Q1").json()["papers"][0]["id"], self.a.id)
        self.assertEqual(c.get("/api/me/metric/first_author").json()["count"], 1)
        self.assertEqual(c.get("/api/me/metric/topic?value=solar energy").json()["count"], 1)
        unfiled = c.get("/api/me/metric/unfiled").json()
        self.assertEqual([p["title"] for p in unfiled["papers"]], ["Solar harvesting"])
        self.assertEqual(money_keys_in(unfiled), [])
        self.assertEqual(c.get("/api/me/metric/salary").status_code, 404)
        # Somebody else's metric shows their own record, never mine.
        self.assertEqual(self.client_for(self.stranger).get("/api/me/metric/papers").json()["count"], 0)
