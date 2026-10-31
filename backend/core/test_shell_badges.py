"""One poll for the three sidebar and bell badges (`GET /api/shell/badges`).

The shell used to ask three endpoints on three clocks (stage counts every 60 s,
unread messages every 30 s, notifications every 45 s). Each answer is now one
slice of this response, and each slice must be exactly what its own endpoint
says to the same person: a badge that disagrees with the page it points at is
worse than a slow one.
"""
from __future__ import annotations

from django.test import Client

from core.models import ClaimStatus, Notification, Role
from core.services.notify import notify
from core.test_social_plus import Base


class ShellBadgesTests(Base):
    def setUp(self):
        super().setUp()
        self.office = self._user("office@x.edu", "The Office", role=Role.SUPER_ADMIN, department=None)
        # What the college's desks see: other people's filed and checked papers.
        # Asha's own paper counts for her and never for a desk she might sit at.
        self._paper(self.ravi, "T-1", status=ClaimStatus.SUBMITTED)
        self._paper(self.ravi, "T-2", status=ClaimStatus.CLEARED)
        self._paper(self.ravi, "T-3", status=ClaimStatus.DRAFT)  # nobody else sees a draft
        self._paper(self.asha, "T-4", status=ClaimStatus.SUBMITTED)
        # Two unread alerts for Asha, one of them already read.
        notify(self.asha, "claim_paid", "Paid", "Paid.")
        notify(self.asha, "follow", "Ravi followed you")
        Notification.objects.filter(user=self.asha, kind="follow").update(read=True)
        # A message from Ravi she has not opened, and an office question the
        # office has answered.
        chat = self._json("post", self.ravi, f"/api/dm/with/{self.asha.id}")
        self._json("post", self.ravi, f"/api/dm/{chat['id']}/messages", {"body": "Coffee at 4?"})
        ask = self._json("post", self.asha, "/api/threads", {
            "title": "Why was T-4 sent back?", "body": "Please explain.", "visibility": "OFFICE",
        })
        self._json("post", self.office, f"/api/threads/{ask['id']}/posts", {"body": "Missing DOI."})

    def _badges(self, user):
        return self._json("get", user, "/api/shell/badges")

    def test_each_slice_is_what_its_own_endpoint_says(self):
        for who in (self.asha, self.ravi, self.meera, self.office):
            with self.subTest(who=who.email):
                badges = self._badges(who)
                self.assertEqual(badges["stage_counts"], self._json("get", who, "/api/claims/counts"))
                self.assertEqual(badges["notifications"], self._json("get", who, "/api/notifications/unread-count"))
                self.assertEqual(badges["dm"], self._json("get", who, "/api/dm/unread"))

    def test_the_slices_differ_by_person_so_the_equality_above_means_something(self):
        asha, office, meera = self._badges(self.asha), self._badges(self.office), self._badges(self.meera)
        # Asha: her own filed paper only. The office: everybody else's, drafts excluded.
        self.assertEqual(asha["stage_counts"]["counts"]["filed"], 1)
        self.assertEqual(asha["stage_counts"]["counts"]["all"], 1)
        self.assertEqual(office["stage_counts"]["counts"]["filed"], 2)
        self.assertEqual(office["stage_counts"]["counts"]["checked"], 1)
        self.assertEqual(meera["stage_counts"]["counts"]["all"], 0)
        # Unread alerts for Asha (the paid one, and whatever the message and
        # the office's answer raised), none for Meera; and two conversations
        # holding something unread (Ravi's message and the office's answer).
        self.assertGreaterEqual(asha["notifications"]["unread"], 1)
        self.assertEqual(meera["notifications"], {"unread": 0})
        self.assertEqual((asha["dm"]["unread"], asha["dm"]["conversations"]), (2, 2))
        self.assertEqual(meera["dm"], {"unread": 0, "conversations": 0})

    def test_reading_something_moves_the_next_answer(self):
        self._json("post", self.asha, "/api/notifications/read-all")
        self.assertEqual(self._badges(self.asha)["notifications"], {"unread": 0})

    def test_a_signed_out_request_is_refused(self):
        self.assertEqual(Client().get("/api/shell/badges").status_code, 401)

    def test_it_is_cheaper_than_asking_three_times(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        self._badges(self.asha)  # warm the session and the formula
        with CaptureQueriesContext(connection) as one:
            self._badges(self.asha)
        with CaptureQueriesContext(connection) as three:
            for path in ("/api/claims/counts", "/api/notifications/unread-count", "/api/dm/unread"):
                self._json("get", self.asha, path)
        self.assertLess(len(one), len(three))
