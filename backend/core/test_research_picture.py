"""My research, the college picture and Discover's For-you feed.

Pinned: metrics and timeline come from the publication record; "this year"
compares with last year to the same date; every idea has a reason and a
"counted" source; the college tab marks the reader's own topics; the feed
keeps its rhythm; nothing carries money.
"""

from __future__ import annotations

import json
from datetime import date
from unittest.mock import patch

from django.test import Client, TestCase

from core.models import Authorship, Publication, ResearchGoal, Role, User
from core.test_search import money_keys_in

TODAY = date(2026, 9, 24)


def pub(title, year, topics, *, cites=0, quartile="", venue="Journal A", month=3, kind="article"):
    return Publication.objects.create(
        title=title, year=year, date=date(year, month, 1), topics_json=json.dumps(topics), citations=cites,
        quartile=quartile, venue=venue, type=kind,
    )


def on(p, user=None, position=1, name="X", college=True, inst=""):
    return Authorship.objects.create(
        publication=p, user=user, position=position, display_name=user.name if user else name,
        author_key=f"u:{user.id}" if user else f"n:{name.lower()}", is_college=college,
        institution_name=inst,
    )


class ResearchPictureTests(TestCase):
    def setUp(self):
        mk = lambda e, n, d: User.objects.create_user(  # noqa: E731
            email=e, password="p", name=n, role=Role.FACULTY, staff_id=e[:3], department=d)
        self.me = mk("me@x.edu", "Me Author", "EEE")
        self.co = mk("co@x.edu", "Co Author", "EEE")
        self.far = mk("far@x.edu", "Far Person", "ECE")
        a = pub("Grid inverter control", 2019, ["Power systems"], cites=12, quartile="Q1", venue="IEEE Power")
        on(a, self.me, 1)
        on(a, name="Outside Prof", college=False, inst="IIT Madras", position=2)
        b = pub("Solar harvesting", 2025, ["Power systems", "Solar energy"], cites=3, month=2)
        on(b, self.me, 2)
        on(b, self.co, 1)
        c = pub("Late last year", 2025, ["Solar energy"], month=11)
        on(c, self.me, 1)
        d = pub("This year", 2026, ["Solar energy", "Scientific and Engineering Research Topics"], month=5)
        on(d, self.me, 3)
        # Colleagues' work next to mine: a rising neighbour topic and a Q1 venue I have not used.
        for i in range(3):
            e = pub(f"Batteries {i}", 2026, ["Solar energy", "Battery storage"], month=4, quartile="Q1",
                    venue="Energy Q1 Journal")
            on(e, self.far, 1)
            on(e, self.co, 2)
        self.c = Client()
        self.c.force_login(self.me)
        ResearchGoal.objects.create(user=self.me, year=2026, metric=ResearchGoal.Metric.PAPERS, target=4)
        patcher = patch("core.services.research_picture._today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_my_research(self):
        r = self.c.get("/api/me/research")
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertEqual(money_keys_in(data), [])
        m = data["metrics"]
        self.assertEqual((m["papers"], m["citations"], m["h_index"], m["q1"], m["first_author"]), (4, 15, 2, 1, 2))
        kinds = {e["kind"] for e in data["timeline"]}
        self.assertTrue({"first_paper", "first_q1", "most_cited", "external_coauthor"} <= kinds)
        self.assertEqual(data["topics"][0]["label"], "Solar energy")
        self.assertNotIn("Scientific and Engineering Research Topics", [t["label"] for t in data["topics"]])
        self.assertIn("Solar energy", data["headline"])
        ty = data["this_year"]
        self.assertEqual((ty["papers"], ty["same_date_last_year"], ty["last_year_total"], ty["target"]),
                         (1, 1, 2, 4))
        self.assertEqual(data["coauthors"]["inside"][0]["name"], "Co Author")
        self.assertEqual(data["coauthors"]["outside_count"], 1)
        cy = {row["year"]: row["count"] for row in data["citations_by_year"]}
        self.assertEqual((cy[2019], cy[2025], cy[2020]), (12, 3, 0))
        ideas = {i["kind"]: i for i in data["ideas"]}
        self.assertEqual(ideas["topic"]["title"], "Battery storage")
        self.assertEqual(ideas["venue"]["title"], "Energy Q1 Journal")
        self.assertEqual(ideas["person"]["title"], "Far Person")
        self.assertIn("Co Author", ideas["person"]["reason"])
        for i in data["ideas"]:
            self.assertEqual(i["source"], "counted")
            self.assertTrue(i["reason"])

    def test_empty_record_says_nothing_false(self):
        fresh = User.objects.create_user(email="n@x.edu", password="p", name="New", role=Role.FACULTY)
        c = Client()
        c.force_login(fresh)
        data = c.get("/api/me/research").json()
        self.assertEqual(data["metrics"]["papers"], 0)
        self.assertIsNone(data["metrics"]["citations"])
        self.assertIsNone(data["headline"])
        self.assertEqual(data["ideas"], [])

    def test_college(self):
        data = self.c.get("/api/college/research").json()
        self.assertEqual(money_keys_in(data), [])
        self.assertEqual(data["totals"]["papers"], 7)
        mine = {t["label"]: t["mine"] for t in data["topics"]}
        self.assertTrue(mine["Solar energy"])
        self.assertFalse(mine["Battery storage"])
        self.assertIn("Battery storage", [t["label"] for t in data["rising"]])
        self.assertEqual({d["name"] for d in data["departments"]}, {"EEE", "ECE"})
        self.assertEqual(data["near_me"][0]["name"], "Co Author")

    def test_for_you_feed(self):
        data = self.c.get("/api/discover/for-you").json()
        self.assertEqual(money_keys_in(data), [])
        items = data["items"]
        self.assertTrue(items)
        self.assertEqual(items[0]["kind"], "direction")
        self.assertTrue(all(i["why"] and i["source"] == "counted" for i in items))
        papers = [i for i in items if i["kind"] == "paper"]
        self.assertTrue(papers and all("Batteries" in p["title"] for p in papers))

    def test_signed_out(self):
        for path in ("/api/me/research", "/api/college/research", "/api/discover/for-you"):
            self.assertEqual(Client().get(path).status_code, 401)
