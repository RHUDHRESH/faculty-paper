"""Messages as one inbox (docs/ux/10): office threads merged into `/api/dm`
with their own unread counts, and a context card on a conversation."""
from __future__ import annotations

from core.models import ClaimStatus, Thread
from core.test_social_plus import Base


class OfficeInInboxTests(Base):
    def _ask_office(self, who, title="Why was ERP-72 sent back?"):
        return self._json("post", who, "/api/threads", {
            "title": title, "body": "Please explain.", "visibility": "OFFICE",
        })

    def test_office_threads_join_the_one_list(self):
        t = self._ask_office(self.asha)
        chat = self._json("post", self.asha, f"/api/dm/with/{self.ravi.id}")
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "Hi"})
        rows = self._json("get", self.asha, "/api/dm")["results"]
        kinds = {r["id"]: r["kind"] for r in rows}
        self.assertEqual(kinds[t["id"]], "office")
        self.assertEqual(kinds[chat["id"]], "person")
        office = next(r for r in rows if r["kind"] == "office")
        self.assertEqual(office["href"], f"/messages/o/{t['id']}")
        self.assertEqual(office["unread"], 0)

    def test_an_office_reply_is_unread_until_the_thread_is_opened(self):
        t = self._ask_office(self.asha)
        self._json("post", self.admin, f"/api/threads/{t['id']}/posts", {"body": "Missing DOI."})
        listing = self._json("get", self.asha, "/api/dm")
        office = next(r for r in listing["results"] if r["id"] == t["id"])
        self.assertEqual(office["unread"], 1)
        self.assertEqual(listing["office_unread"], 1)
        self.assertEqual(self._json("get", self.asha, "/api/dm/unread")["unread"], 1)
        self._json("get", self.asha, f"/api/threads/{t['id']}")
        self.assertEqual(self._json("get", self.asha, "/api/dm/unread")["unread"], 0)

    def test_office_threads_stay_private_to_the_asker_and_the_office(self):
        t = self._ask_office(self.asha)
        for outsider in (self.ravi, self.meera):
            ids = [r["id"] for r in self._json("get", outsider, "/api/dm")["results"]]
            self.assertNotIn(t["id"], ids)
        ids = [r["id"] for r in self._json("get", self.admin, "/api/dm")["results"]]
        self.assertIn(t["id"], ids)


class ContextTests(Base):
    def test_a_paper_context_is_offered_then_attached_by_the_first_message(self):
        paper = self._paper(self.ravi, "ERP-1", title="Enhanced ML Framework")
        opened = self._json(
            "post", self.asha, f"/api/dm/with/{self.ravi.id}?context_kind=paper&context_id={paper.id}"
        )
        self.assertEqual(opened["pending_context"]["title"], "Enhanced ML Framework")
        self.assertIsNone(opened["context"])
        self._json("post", self.asha, f"/api/dm/{opened['id']}/messages", {
            "body": "About your paper", "context": {"kind": "paper", "id": paper.id},
        })
        seen = self._json("get", self.ravi, f"/api/dm/{opened['id']}")
        self.assertEqual(seen["context"]["kind"], "paper")
        self.assertEqual(seen["context"]["href"], f"/papers/{paper.id}")
        self.assertNoMoney(seen)

    def test_context_on_a_new_conversation(self):
        convo = self._json("post", self.asha, "/api/dm", {
            "participant_ids": [self.ravi.id], "body": "Intro?",
            "context": {"kind": "person", "id": self.meera.id},
        })
        self.assertEqual(convo["context"]["title"], "Meera Pillai")

    def test_an_unpublished_paper_does_not_resolve_for_others(self):
        draft = self._paper(self.ravi, "ERP-2", status=ClaimStatus.DRAFT, title="Secret draft")
        self._json(
            "post", self.asha, f"/api/dm/with/{self.ravi.id}?context_kind=paper&context_id={draft.id}",
            status=404,
        )
        self._json("post", self.asha, f"/api/dm/with/{self.ravi.id}?context_kind=nonsense&context_id=x", status=400)

    def test_the_context_is_only_read_by_participants(self):
        paper = self._paper(self.ravi, "ERP-3")
        convo = self._json("post", self.asha, "/api/dm", {
            "participant_ids": [self.ravi.id], "body": "Hi",
            "context": {"kind": "paper", "id": paper.id},
        })
        self.assertIsNotNone(Thread.objects.get(pk=convo["id"]).context)
        for outsider in (self.meera, self.admin):
            self._json("get", outsider, f"/api/dm/{convo['id']}", status=404)
