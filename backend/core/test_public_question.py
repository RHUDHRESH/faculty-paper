"""A public question ("Ask a question" on the Threads tab of Discussions).

Pinned: any signed-in member may open a thread for everybody, it is readable
and answerable by other departments, it carries the asker's face, and neither
the response nor the list carries anything from the desk (a claim, money, a
private thread).
"""

from __future__ import annotations

import json

from django.test import Client, TestCase

from core.models import Claim, Role, Thread, User
from core.test_search import money_keys_in


class PublicQuestionTests(TestCase):
    def setUp(self):
        mk = lambda e, n, role, d: User.objects.create_user(  # noqa: E731
            email=e, password="p", name=n, role=role, department=d)
        self.asker = mk("asker@x.edu", "Asha Rao", Role.FACULTY, "ECE")
        self.other = mk("other@x.edu", "Ravi Nair", Role.FACULTY, "MECH")
        self.hod = mk("hod@x.edu", "Head Person", Role.HOD, "CSE")
        self.office = mk("office@x.edu", "Office Person", Role.SUPER_ADMIN, "")
        self.asker.photo = "avatars/asha.jpg"
        self.asker.save()
        self.client = Client()

    def ask(self, actor, **over):
        self.client.force_login(actor)
        body = {"title": "Which journals turn papers around fastest?", "body": "Looking for a quick Q2.",
                "visibility": "PUBLIC", **over}
        return self.client.post("/api/threads", data=json.dumps(body), content_type="application/json")

    def test_every_role_that_can_sign_in_may_open_one(self):
        for actor in (self.asker, self.hod, self.office):
            r = self.ask(actor)
            self.assertEqual(r.status_code, 200, actor.role)
            self.assertEqual(r.json()["visibility"], "PUBLIC")

    def test_it_is_public_when_the_visibility_is_left_out(self):
        self.client.force_login(self.asker)
        r = self.client.post("/api/threads", data=json.dumps({"title": "A question here", "body": "Well?"}),
                             content_type="application/json")
        self.assertEqual(r.json()["visibility"], "PUBLIC")

    def test_a_colleague_in_another_department_sees_it_and_can_answer(self):
        tid = self.ask(self.asker).json()["id"]
        self.client.force_login(self.other)
        listed = self.client.get("/api/threads").json()["results"]
        self.assertIn(tid, [t["id"] for t in listed])
        self.assertEqual(self.client.get(f"/api/threads/{tid}").status_code, 200)
        r = self.client.post(f"/api/threads/{tid}/posts", data=json.dumps({"body": "Try IEEE Access."}),
                             content_type="application/json")
        self.assertEqual(r.status_code, 200)

    def test_the_asker_has_a_face_in_the_list_and_the_thread(self):
        tid = self.ask(self.asker).json()["id"]
        self.client.force_login(self.other)
        row = next(t for t in self.client.get("/api/threads").json()["results"] if t["id"] == tid)
        self.assertEqual(row["created_by"], "Asha Rao")
        self.assertTrue(row["created_by_photo_url"].endswith("avatars/asha.jpg"))
        self.assertEqual(row["created_by_initials"], "AR")
        self.assertEqual(self.client.get(f"/api/threads/{tid}").json()["created_by_photo_url"], row["created_by_photo_url"])

    def test_nothing_from_the_desk_or_from_private_threads_comes_with_it(self):
        # A private line and an office thread exist beside the public one.
        self.client.force_login(self.hod)
        self.client.post("/api/threads", content_type="application/json", data=json.dumps({
            "title": "Private to Asha", "body": "hi", "visibility": "DIRECT", "participant_ids": [self.asker.id]}))
        self.ask(self.hod, title="Why was my paper sent back?", visibility="OFFICE")
        tid = self.ask(self.asker).json()["id"]

        self.client.force_login(self.other)
        listing = self.client.get("/api/threads").json()
        titles = {t["title"] for t in listing["results"]}
        self.assertEqual(titles, {"Which journals turn papers around fastest?"})
        self.assertEqual(money_keys_in(listing), [])
        detail = self.client.get(f"/api/threads/{tid}").json()
        self.assertEqual(money_keys_in(detail), [])
        self.assertIsNone(detail["claim_id"])
        self.assertIsNone(detail["ticket_number"])

    def test_a_public_question_cannot_carry_somebody_elses_claim(self):
        claim = Claim.objects.create(owner=self.asker, paper_title="Private claim")
        r = self.ask(self.asker, claim_id=claim.id)
        self.assertEqual(r.status_code, 400)
        self.assertFalse(Thread.objects.filter(claim=claim).exists())
        # The same claim on an office thread is still the way to ask about it.
        self.assertEqual(self.ask(self.asker, visibility="OFFICE", claim_id=claim.id).status_code, 200)

    def test_it_needs_a_title_and_something_said_and_a_sign_in(self):
        self.assertEqual(self.ask(self.asker, title="Hi").status_code, 400)
        self.assertEqual(self.ask(self.asker, body="  ").status_code, 400)
        self.assertEqual(self.ask(self.asker, visibility="EVERYBODY").status_code, 400)
        self.assertIn(Client().post("/api/threads", data="{}", content_type="application/json").status_code, (401, 403))
