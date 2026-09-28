"""Fixes from the social audit (docs/jtbd/social-audit.md)."""
from __future__ import annotations

import json

from django.test import Client, TestCase

from core.models import Role, User
from core.social_notify import plain


class SocialAuditTests(TestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.test", password=None, name="Asha Rao",
                                          role=Role.FACULTY, department="CSE")
        self.b = User.objects.create_user(email="b@x.test", password=None, name="Bala Kumar",
                                          role=Role.FACULTY, department="ECE")
        self.c = Client()

    def _notes(self, user):
        self.c.force_login(user)
        return self.c.get("/api/notifications").json()

    def test_plain_flattens_mention_codes(self):
        self.assertEqual(plain('Hi @"Asha Rao", see @journal:"Nature" and @user:bala'),
                         "Hi @Asha Rao, see @Nature and @bala")
        self.assertEqual(plain("no mentions @ all"), "no mentions @ all")

    def test_mention_notification_is_readable_has_a_face_and_opens_the_post(self):
        self.c.force_login(self.a)
        r = self.c.post("/api/feed/posts", {"body": 'Question for @"Bala Kumar" about antennas',
                                             "mention_ids": [self.b.id]})
        self.assertEqual(r.status_code, 200, r.content)
        post_id = r.json()["id"]
        rows = self._notes(self.b)
        rows = rows.get("items", rows) if isinstance(rows, dict) else rows
        mention = next(n for n in rows if n["kind"] == "mention")
        self.assertNotIn('"', mention["body"])
        self.assertIn("@Bala Kumar", mention["body"])
        self.assertEqual(mention["actor"]["user_id"], self.a.id)
        self.assertIn(post_id, mention["href"])

    def test_message_notification_names_the_sender_with_a_face(self):
        self.c.force_login(self.a)
        r = self.c.post("/api/dm", json.dumps({"participant_ids": [self.b.id], "body": "Hello"}),
                        content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        rows = self._notes(self.b)
        rows = rows.get("items", rows) if isinstance(rows, dict) else rows
        msg = next(n for n in rows if n["kind"] == "message")
        self.assertEqual(msg["actor"]["name"], "Asha Rao")
        self.assertTrue(msg["href"].startswith("/messages/"))

    def test_faculty_can_open_a_colleague_profile(self):
        self.c.force_login(self.a)
        self.assertEqual(self.c.get(f"/api/people/{self.b.id}").status_code, 200)
