"""Author-match review: aliases survive a re-match, merges move everything, office only."""
from __future__ import annotations

import json

from django.test import Client, TestCase

from core.models import AuditLog, Authorship, AuthorAlias, Claim, Follow, PaidLedger, Publication, Role, User
from core.services import publications
from core.services.author_names import name_key


def _person(email, name, *, role=Role.FACULTY, **extra):
    return User.objects.create_user(email=email, password="pass", name=name, role=role, **extra)


def _paper(title, author, *, oa="A1"):
    pub = Publication.objects.create(title=title, normalized_title=title.lower(), year=2024)
    Authorship.objects.create(publication=pub, position=1, display_name=author, is_college=True,
                              author_key=oa, openalex_author_id=oa)
    return pub


class AliasTests(TestCase):
    def setUp(self):
        self.admin = _person("admin@x.edu", "Admin", role=Role.SUPER_ADMIN)
        self.lav = _person("lav@x.edu", "Dr. G. Lavanya", department="CSE")
        self.c = Client()
        self.c.force_login(self.admin)
        # "Venkat Rao" matches nobody by name.
        self.p1 = _paper("One", "Venkat Rao", oa="A9")
        self.p2 = _paper("Two", "Rao Venkat", oa="A8")

    def test_list_groups_by_normalised_name(self):
        r = self.c.get("/api/admin/author-matches").json()
        keys = {i["key"]: i for i in r["items"]}
        self.assertEqual(keys[name_key("Venkat Rao")]["papers"], 2)
        self.assertNotIn("amount", json.dumps(r))

    def test_this_is_user_links_and_survives_rematch(self):
        key = name_key("Venkat Rao")
        r = self.c.post("/api/admin/author-matches/decide", {"key": key, "status": "MATCHED", "user_id": self.lav.id},
                        content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["linked"], 2)
        self.assertTrue(AuditLog.objects.filter(action="AUTHOR_ALIAS_MATCHED").exists())
        # A fresh harvest row with the same name and a re-match: the alias applies.
        p3 = _paper("Three", "Venkat  Rao", oa="A7")
        publications.match_authors()
        row = Authorship.objects.get(publication=p3)
        self.assertEqual(row.user_id, self.lav.id)
        self.assertEqual(row.match_method, "alias")
        self.assertEqual(Authorship.objects.filter(user=self.lav).count(), 3)

    def test_not_on_roster_hides(self):
        key = name_key("Venkat Rao")
        self.c.post("/api/admin/author-matches/decide", {"key": key, "status": "NOT_ROSTER"},
                    content_type="application/json")
        open_keys = [i["key"] for i in self.c.get("/api/admin/author-matches").json()["items"]]
        self.assertNotIn(key, open_keys)
        hidden = [i["key"] for i in self.c.get("/api/admin/author-matches?status=hidden").json()["items"]]
        self.assertIn(key, hidden)

    def test_faculty_refused(self):
        c = Client()
        c.force_login(self.lav)
        self.assertEqual(c.get("/api/admin/author-matches").status_code, 403)
        self.assertEqual(c.get("/api/admin/duplicate-accounts").status_code, 403)
        r = c.post("/api/admin/duplicate-accounts/merge", {"keep_id": self.lav.id, "drop_id": self.admin.id},
                   content_type="application/json")
        self.assertEqual(r.status_code, 403)

    def test_coordinator_allowed(self):
        c = Client()
        c.force_login(_person("rc@x.edu", "Coord", role=Role.RESEARCH_COORDINATOR))
        self.assertEqual(c.get("/api/admin/author-matches").status_code, 200)


class MergeTests(TestCase):
    def setUp(self):
        self.admin = _person("admin@x.edu", "Admin", role=Role.SUPER_ADMIN)
        self.keep = _person("a@x.edu", "Dr. G. Lavanya", staff_id="S1")
        self.drop = _person("b@x.edu", "G Lavanya", biometric_id="B2", orcid_id="0000-0002-1825-0097")
        self.other = _person("o@x.edu", "Other")
        self.c = Client()
        self.c.force_login(self.admin)

    def _merge(self, **extra):
        return self.c.post("/api/admin/duplicate-accounts/merge",
                           {"keep_id": self.keep.id, "drop_id": self.drop.id, **extra},
                           content_type="application/json")

    def test_finder_lists_pair(self):
        groups = self.c.get("/api/admin/duplicate-accounts").json()["groups"]
        ids = [{a["id"] for a in g["accounts"]} for g in groups]
        self.assertIn({self.keep.id, self.drop.id}, ids)

    def test_merge_moves_everything(self):
        claim = Claim.objects.create(owner=self.drop, paper_title="X")
        pub = _paper("P", "G Lavanya")
        Authorship.objects.filter(publication=pub).update(user=self.drop, match_method="manual")
        Follow.objects.create(follower=self.drop, person=self.other)
        Follow.objects.create(follower=self.other, person=self.drop)
        AuthorAlias.objects.create(name_key="x", status=AuthorAlias.MATCHED, user=self.drop)
        r = self._merge()
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["ok"])
        claim.refresh_from_db()
        self.assertEqual(claim.owner_id, self.keep.id)
        self.assertEqual(Authorship.objects.get(publication=pub).user_id, self.keep.id)
        self.assertTrue(Follow.objects.filter(follower=self.keep, person=self.other).exists())
        self.assertTrue(Follow.objects.filter(follower=self.other, person=self.keep).exists())
        self.assertEqual(AuthorAlias.objects.get(name_key="x").user_id, self.keep.id)
        self.drop.refresh_from_db()
        self.keep.refresh_from_db()
        self.assertFalse(self.drop.active)
        self.assertEqual(self.keep.biometric_id, "B2")
        self.assertEqual(self.keep.orcid_id, "0000-0002-1825-0097")
        log = AuditLog.objects.get(action="ACCOUNT_MERGED")
        self.assertEqual(log.actor_id, self.admin.id)
        self.assertIn(self.drop.id, log.detail_json)

    def test_conflict_needs_confirm(self):
        self.drop.staff_id = "S2"
        self.drop.save()
        PaidLedger.objects.create(payout_month="2025-01-01", staff_id="S2")
        r = self._merge().json()
        self.assertFalse(r["ok"])
        self.assertEqual(r["conflicts"], ["staff_id"])
        self.drop.refresh_from_db()
        self.assertTrue(self.drop.active)
        r = self._merge(confirm=True).json()
        self.assertTrue(r["ok"])
        self.assertEqual(PaidLedger.objects.filter(staff_id="S1").count(), 1)
