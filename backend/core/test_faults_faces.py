"""Faults name people as faces (id, name, photo), not bare email addresses."""
from __future__ import annotations

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Role, User


class FaultsFacesTests(TestCase):
    def test_people_samples_carry_face_fields(self):
        cache.clear()
        admin = User.objects.create_user(email="adm-f@x.edu", password="p", name="Adm", role=Role.SUPER_ADMIN)
        u = User.objects.create_user(email="nobio@x.edu", password="p", name="Dr. Asha Rao", role=Role.FACULTY, department="ECE")
        c = Client()
        c.force_login(admin)
        data = c.get("/api/admin/faults").json()
        faults = {f["key"]: f for g in data["groups"] for f in g["faults"]}
        people = faults["no_biometric"]["people"]
        me = next(p for p in people if p["user_id"] == u.id)
        self.assertEqual(me["name"], "Dr. Asha Rao")
        self.assertIn("photo_url", me)
        self.assertTrue(me["initials"])
        self.assertEqual(faults["stale_submitted"]["people"], [])

    def test_journal_authors_carry_faces(self):
        from core.models import Claim, ClaimStatus

        admin = User.objects.create_user(email="adm-j@x.edu", password="p", name="Adm", role=Role.SUPER_ADMIN)
        u = User.objects.create_user(email="jau@x.edu", password="p", name="Asha Rao", role=Role.FACULTY, department="ECE")
        Claim.objects.create(owner=u, status=ClaimStatus.SUBMITTED, paper_title="P", journal_title="Face Journal")
        c = Client()
        c.force_login(admin)
        r = c.get("/api/journals/report", {"title": "Face Journal"})
        self.assertEqual(r.status_code, 200, r.content)
        a = r.json()["authors"][0]
        self.assertEqual(a["id"], u.id)
        self.assertEqual(a["initials"], "AR")
        self.assertIn("photo_url", a)
