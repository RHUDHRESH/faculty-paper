"""The social layer's second storey: reactions, sharing, direct messages,
collaboration requests, following topics and journals, "For you", pinned
papers and profile completeness, skills and endorsements, the collaboration
graph, and a person's own statistics.

The rules every test here leans on, whatever feature it is about:

- Money never reaches anything another person sees -- a shared paper, a
  reaction list, a "For you" card, a graph node, a stats page.
- A department-only post stays in its department: reacting to it, listing who
  reacted, finding it in "For you" all answer as if it did not exist.
- A direct conversation is readable by the people in it and nobody else, the
  super admin included.
- A person's statistics are theirs alone; nobody else can ask for them.
- Every notification this layer sends can be switched off, one kind at a time.
"""
from __future__ import annotations

import json
from datetime import timedelta

from django.test import Client, TestCase
from django.utils import timezone

from core.hod import MONEY_KEYS
from core.models import (
    Claim,
    ClaimStatus,
    Collaboration,
    FeedPost,
    Notification,
    PostView,
    ProfileVisit,
    ResearchInterest,
    Role,
    User,
)

FIGURES = ("48000", "24000", "12000")


def _keys(value) -> set[str]:
    found: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            found.add(k)
            found |= _keys(v)
    elif isinstance(value, list):
        for v in value:
            found |= _keys(v)
    return found


class Base(TestCase):
    def setUp(self):
        self.asha = self._user("asha@x.edu", "Asha Menon", department="Physics")
        self.ravi = self._user("ravi@x.edu", "Ravi Kumar", department="Physics")
        self.meera = self._user("meera@x.edu", "Meera Pillai", department="Chemistry")
        self.admin = self._user("admin@x.edu", "The Admin", role=Role.SUPER_ADMIN, department=None)
        self.c = Client()

    def _user(self, email, name, *, role=Role.FACULTY, department="Physics", **extra):
        return User.objects.create_user(
            email=email, password=None, name=name, role=role, department=department, **extra
        )

    def _as(self, user):
        self.c.force_login(user)
        return self.c

    def _paper(self, owner, ticket, *, status=ClaimStatus.PAID, quartile="Q1", doi=None,
               title=None, journal="Journal of Tests", subjects="Condensed Matter Physics (Q1)",
               amount=48000.0, year=2025):
        return Claim.objects.create(
            owner=owner, status=status, ticket_number=ticket,
            paper_title=title or f"Paper {ticket}", journal_title=journal,
            quartile=quartile, author_position=1, total_authors=3,
            publication_year=year, remuneration=amount, qf_amount=amount / 2,
            base_amount=amount / 4, doi=doi, subjects_json=subjects,
        )

    def _post(self, author, body="Hello, college", **fields):
        r = self._as(author).post("/api/feed/posts", data={"body": body, "visibility": "EVERYONE", **fields})
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _json(self, method, user, path, payload=None, status=200):
        client = self._as(user)
        call = getattr(client, method)
        if payload is None:
            r = call(path)
        else:
            r = call(path, data=json.dumps(payload), content_type="application/json")
        self.assertEqual(r.status_code, status, (path, r.content))
        return r.json() if r.content else None

    def assertNoMoney(self, payload, raw: str | None = None):
        leaked = _keys(payload) & (MONEY_KEYS | {"remuneration", "qf_amount", "base_amount", "amount"})
        self.assertFalse(leaked, f"money keys leaked: {sorted(leaked)}")
        text = raw if raw is not None else json.dumps(payload)
        for figure in FIGURES:
            self.assertNotIn(figure, text)


# ---------------------------------------------------------------- reactions --


class ReactionTests(Base):
    def test_four_kinds_are_counted_separately_and_one_person_can_give_several(self):
        post = self._post(self.asha)
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/congrats")
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/like")
        r = self._json("post", self.meera, f"/api/feed/posts/{post['id']}/reactions/interested")
        self.assertEqual(r["reactions"], {"LIKE": 1, "CONGRATS": 1, "INTERESTED": 1, "COLLABORATE": 0})

        seen = self._json("get", self.ravi, f"/api/feed/posts/{post['id']}")
        self.assertEqual(sorted(seen["my_reactions"]), ["CONGRATS", "LIKE"])
        self.assertEqual(seen["like_count"], 1)
        self.assertTrue(seen["liked"])

    def test_reacting_twice_is_still_once_and_it_can_be_taken_back(self):
        post = self._post(self.asha)
        path = f"/api/feed/posts/{post['id']}/reactions/congrats"
        self._json("post", self.ravi, path)
        self._json("post", self.ravi, path)
        r = self._json("delete", self.ravi, path)
        self.assertEqual(r["reactions"]["CONGRATS"], 0)
        self.assertEqual(r["my_reactions"], [])

    def test_the_old_like_endpoint_still_means_like(self):
        post = self._post(self.asha)
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/like")
        r = self._json("get", self.ravi, f"/api/feed/posts/{post['id']}")
        self.assertEqual(r["reactions"]["LIKE"], 1)

    def test_an_unknown_reaction_is_refused(self):
        post = self._post(self.asha)
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/angry", status=400)

    def test_who_reacted_lists_people_and_kinds(self):
        post = self._post(self.asha)
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/congrats")
        self._json("post", self.meera, f"/api/feed/posts/{post['id']}/reactions/collaborate")
        body = self._json("get", self.asha, f"/api/feed/posts/{post['id']}/reactions")
        pairs = {(row["person"]["name"], row["kind"]) for row in body["results"]}
        self.assertEqual(pairs, {("Ravi Kumar", "CONGRATS"), ("Meera Pillai", "COLLABORATE")})
        only = self._json("get", self.asha, f"/api/feed/posts/{post['id']}/reactions?kind=collaborate")
        self.assertEqual([row["person"]["name"] for row in only["results"]], ["Meera Pillai"])

    def test_a_department_post_cannot_be_reacted_to_or_inspected_from_outside(self):
        post = self._post(self.asha, visibility="DEPARTMENT")
        self._json("post", self.meera, f"/api/feed/posts/{post['id']}/reactions/congrats", status=404)
        self._json("get", self.meera, f"/api/feed/posts/{post['id']}/reactions", status=404)
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/congrats")

    def test_congrats_tells_the_author_once_and_a_like_does_not(self):
        post = self._post(self.asha)
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/like")
        self.assertFalse(Notification.objects.filter(user=self.asha).exists())
        path = f"/api/feed/posts/{post['id']}/reactions/congrats"
        self._json("post", self.ravi, path)
        self._json("delete", self.ravi, path)
        self._json("post", self.ravi, path)
        self.assertEqual(Notification.objects.filter(user=self.asha).count(), 1)

    def test_reaction_notifications_can_be_switched_off(self):
        self._json("put", self.asha, "/api/people/me/social-settings", {"muted": ["reaction"]})
        post = self._post(self.asha)
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/congrats")
        self.assertFalse(Notification.objects.filter(user=self.asha).exists())


# ------------------------------------------------------------------ sharing --


class ShareTests(Base):
    def test_the_share_draft_carries_the_paper_and_college_coauthors_and_no_money(self):
        paper = self._paper(self.asha, "SH1", doi="10.9/shared", title="Shared Result")
        self._paper(self.ravi, "SH2", doi="10.9/shared", title="Shared Result")
        r = self._as(self.asha).get(f"/api/feed/share/{paper.id}")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["paper"]["title"], "Shared Result")
        self.assertEqual(body["paper"]["quartile"], "Q1")
        self.assertEqual([c["name"] for c in body["paper"]["coauthors"]], ["Ravi Kumar"])
        self.assertIn("Shared Result", body["body"])
        # The composer's own form, so the name renders as a link in the post.
        self.assertIn('@user:"Ravi Kumar"', body["body"])
        self.assertEqual(body["mention_ids"], [self.ravi.id])
        self.assertNoMoney(body, r.content.decode())

    def test_only_the_owner_can_share_their_paper(self):
        paper = self._paper(self.asha, "SH3")
        self.assertEqual(self._as(self.ravi).get(f"/api/feed/share/{paper.id}").status_code, 404)

    def test_a_draft_or_refused_paper_cannot_be_shared(self):
        draft = self._paper(self.asha, "SH4", status=ClaimStatus.DRAFT)
        refused = self._paper(self.asha, "SH5", status=ClaimStatus.REJECTED)
        for p in (draft, refused):
            self.assertEqual(self._as(self.asha).get(f"/api/feed/share/{p.id}").status_code, 404)

    def test_an_approved_or_paid_notification_offers_to_share_the_paper(self):
        paper = self._paper(self.asha, "NS1")
        theirs = self._paper(self.ravi, "NS2")
        for title, claim in (("NS1 · Paid", paper), ("NS1 · Approved for payment", paper),
                             ("NS1 · Under review", paper), ("NS2 · Paid", theirs)):
            Notification.objects.create(user=self.asha, title=title, href="/faculty", claim_id=claim.id)
        rows = {r["title"]: r for r in self._json("get", self.asha, "/api/notifications")}
        self.assertEqual(rows["NS1 · Paid"]["share_paper_id"], paper.id)
        self.assertEqual(rows["NS1 · Approved for payment"]["share_paper_id"], paper.id)
        self.assertIsNone(rows["NS1 · Under review"]["share_paper_id"])
        # Somebody else's paper is never offered, whatever the title says.
        self.assertIsNone(rows["NS2 · Paid"]["share_paper_id"])

    def test_posting_the_draft_mentions_and_tells_the_coauthors(self):
        paper = self._paper(self.asha, "SH8", doi="10.9/told", title="Told Paper")
        self._paper(self.ravi, "SH9", doi="10.9/told", title="Told Paper")
        draft = self._json("get", self.asha, f"/api/feed/share/{paper.id}")
        post = self._post(self.asha, body=draft["body"], paper_id=paper.id,
                          mention_ids=draft["mention_ids"])
        self.assertEqual([m["user_id"] for m in post["mentions"]], [self.ravi.id])
        self.assertTrue(Notification.objects.filter(user=self.ravi).exists())

    def test_a_shared_post_shows_the_rich_card_with_linked_coauthors(self):
        paper = self._paper(self.asha, "SH6", doi="10.9/card", title="Card Paper")
        self._paper(self.ravi, "SH7", doi="10.9/card", title="Card Paper")
        post = self._post(self.asha, body="Out now", paper_id=paper.id)
        self.assertEqual(post["paper"]["coauthors"], [{"id": self.ravi.id, "name": "Ravi Kumar"}])
        feed = self._json("get", self.meera, "/api/feed?tab=everyone")
        card = feed["results"][0]["paper"]
        self.assertEqual(card["coauthors"][0]["id"], self.ravi.id)
        self.assertNoMoney(feed)


# ------------------------------------------------------------ follow topics --


class FollowTopicTests(Base):
    def test_follow_a_topic_and_a_journal_and_list_them(self):
        self._json("post", self.meera, "/api/follows/topics", {"topic": "Condensed Matter Physics"})
        self._json("post", self.meera, "/api/follows/journals", {"journal": "Journal of Tests"})
        body = self._json("get", self.meera, "/api/follows")
        self.assertEqual(body["topics"], ["Condensed Matter Physics"])
        self.assertEqual(body["journals"], ["Journal of Tests"])

    def test_following_twice_is_once_and_unfollow_removes_it(self):
        for _ in range(2):
            self._json("post", self.meera, "/api/follows/topics", {"topic": "Optics"})
        self._json("delete", self.meera, "/api/follows/topics?topic=Optics")
        self.assertEqual(self._json("get", self.meera, "/api/follows")["topics"], [])

    def test_an_empty_topic_is_refused(self):
        self._json("post", self.meera, "/api/follows/topics", {"topic": "  "}, status=400)

    def test_following_tab_includes_posts_about_followed_topics_and_journals(self):
        cm = self._paper(self.asha, "T1", subjects="Condensed Matter Physics (Q1)")
        other = self._paper(self.ravi, "T2", subjects="Organic Chemistry (Q2)", journal="Other Journal")
        by_topic = self._post(self.asha, body="topic post", paper_id=cm.id)
        by_journal = self._post(self.ravi, body="journal post", paper_id=other.id)
        self._post(self.ravi, body="unrelated")

        self._json("post", self.meera, "/api/follows/topics", {"topic": "Condensed Matter Physics"})
        ids = {p["id"] for p in self._json("get", self.meera, "/api/feed?tab=following")["results"]}
        self.assertEqual(ids, {by_topic["id"]})

        self._json("post", self.meera, "/api/follows/journals", {"journal": "other journal"})
        ids = {p["id"] for p in self._json("get", self.meera, "/api/feed?tab=following")["results"]}
        self.assertEqual(ids, {by_topic["id"], by_journal["id"]})

    def test_feed_can_be_filtered_to_one_topic_or_journal(self):
        cm = self._paper(self.asha, "T3", subjects="Condensed Matter Physics (Q1)")
        hit = self._post(self.asha, body="about CM", paper_id=cm.id)
        self._post(self.ravi, body="nothing")
        ids = [p["id"] for p in self._json(
            "get", self.meera, "/api/feed?tab=everyone&topic=Condensed%20Matter%20Physics")["results"]]
        self.assertEqual(ids, [hit["id"]])
        ids = [p["id"] for p in self._json(
            "get", self.meera, "/api/feed?tab=everyone&journal=Journal%20of%20Tests")["results"]]
        self.assertEqual(ids, [hit["id"]])

    def test_a_followed_topic_never_surfaces_another_departments_private_post(self):
        cm = self._paper(self.asha, "T4", subjects="Condensed Matter Physics (Q1)")
        self._post(self.asha, body="dept only", paper_id=cm.id, visibility="DEPARTMENT")
        self._json("post", self.meera, "/api/follows/topics", {"topic": "Condensed Matter Physics"})
        self.assertEqual(self._json("get", self.meera, "/api/feed?tab=following")["results"], [])


# --------------------------------------------------------- direct messages --


class DirectMessageTests(Base):
    def _chat(self, a, b):
        return self._json("post", a, f"/api/dm/with/{b.id}")

    def test_a_one_to_one_chat_is_found_again_rather_than_opened_twice(self):
        first = self._chat(self.asha, self.ravi)
        again = self._chat(self.ravi, self.asha)
        self.assertEqual(first["id"], again["id"])
        self.assertFalse(first["is_group"])

    def test_you_cannot_message_yourself_or_nobody(self):
        self._json("post", self.asha, f"/api/dm/with/{self.asha.id}", status=400)
        self._json("post", self.asha, "/api/dm/with/nobody", status=404)

    def test_messages_arrive_and_count_as_unread_until_read(self):
        chat = self._chat(self.asha, self.ravi)
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "Coffee at 4?"})
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "Or 5"})

        unread = self._json("get", self.ravi, "/api/dm/unread")
        self.assertEqual((unread["unread"], unread["conversations"]), (2, 1))
        listing = self._json("get", self.ravi, "/api/dm")
        self.assertEqual(listing["results"][0]["unread"], 2)
        self.assertEqual(listing["results"][0]["last"]["body"], "Or 5")
        self.assertEqual(listing["results"][0]["people"][0]["name"], "Asha Menon")

        convo = self._json("get", self.ravi, f"/api/dm/{chat['id']}?read=1")
        self.assertEqual([m["body"] for m in convo["messages"]], ["Coffee at 4?", "Or 5"])
        self.assertEqual(self._json("get", self.ravi, "/api/dm/unread")["unread"], 0)

    def test_polling_without_read_does_not_mark_anything_read(self):
        chat = self._chat(self.asha, self.ravi)
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "Hi"})
        self._json("get", self.ravi, f"/api/dm/{chat['id']}")
        self.assertEqual(self._json("get", self.ravi, "/api/dm/unread")["unread"], 1)

    def test_read_receipts_show_when_the_other_person_read(self):
        chat = self._chat(self.asha, self.ravi)
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "Seen?"})
        before = self._json("get", self.asha, f"/api/dm/{chat['id']}")
        ravi_row = next(p for p in before["participants"] if p["id"] == self.ravi.id)
        self.assertIsNone(ravi_row["last_read_at"])
        self._json("post", self.ravi, f"/api/dm/{chat['id']}/read")
        after = self._json("get", self.asha, f"/api/dm/{chat['id']}")
        ravi_row = next(p for p in after["participants"] if p["id"] == self.ravi.id)
        self.assertIsNotNone(ravi_row["last_read_at"])

    def test_a_chat_is_private_to_its_people_including_from_the_super_admin(self):
        chat = self._chat(self.asha, self.ravi)
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "Private"})
        for outsider in (self.meera, self.admin):
            self._json("get", outsider, f"/api/dm/{chat['id']}", status=404)
            self._json("post", outsider, f"/api/dm/{chat['id']}/messages", {"body": "hi"}, status=404)
            self._json("post", outsider, f"/api/dm/{chat['id']}/read", status=404)
            self.assertEqual(self._json("get", outsider, "/api/dm")["results"], [])

    def test_a_small_group_chat(self):
        group = self._json("post", self.asha, "/api/dm", {
            "participant_ids": [self.ravi.id, self.meera.id], "title": "Seminar plan",
            "body": "Shall we?",
        })
        self.assertTrue(group["is_group"])
        self.assertEqual(group["title"], "Seminar plan")
        for member in (self.ravi, self.meera):
            listing = self._json("get", member, "/api/dm")
            self.assertEqual(listing["results"][0]["id"], group["id"])
        self._json("get", self.admin, f"/api/dm/{group['id']}", status=404)

    def test_new_messages_notify_once_until_read(self):
        chat = self._chat(self.asha, self.ravi)
        for text in ("one", "two", "three"):
            self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": text})
        self.assertEqual(Notification.objects.filter(user=self.ravi).count(), 1)

    def test_message_notifications_can_be_switched_off(self):
        self._json("put", self.ravi, "/api/people/me/social-settings", {"muted": ["message"]})
        chat = self._chat(self.asha, self.ravi)
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "quiet"})
        self.assertFalse(Notification.objects.filter(user=self.ravi).exists())

    def test_an_empty_message_is_refused(self):
        chat = self._chat(self.asha, self.ravi)
        self._json("post", self.asha, f"/api/dm/{chat['id']}/messages", {"body": "  "}, status=400)


# ------------------------------------------------------ collaboration requests --


class CollaborationTests(Base):
    def _ask(self, a, b, **extra):
        payload = {"to_id": b.id, "topic": "Thin films", "journal": "Journal of Tests",
                   "message": "Would you like to write this together?", **extra}
        return self._json("post", a, "/api/collaborations/requests", payload)

    def test_a_request_lands_in_the_chat_as_a_card(self):
        sent = self._ask(self.asha, self.ravi)
        convo = self._json("get", self.ravi, f"/api/dm/{sent['conversation_id']}")
        card = next(m["collab"] for m in convo["messages"] if m["collab"])
        self.assertEqual(card["topic"], "Thin films")
        self.assertEqual(card["state"], "PENDING")
        self.assertTrue(card["may_respond"])
        mine = self._json("get", self.asha, f"/api/dm/{sent['conversation_id']}")
        card = next(m["collab"] for m in mine["messages"] if m["collab"])
        self.assertFalse(card["may_respond"])

    def test_accepting_creates_a_collaboration_on_both_profiles(self):
        sent = self._ask(self.asha, self.ravi)
        done = self._json("post", self.ravi,
                          f"/api/collaborations/requests/{sent['request']['id']}/respond",
                          {"action": "accept"})
        self.assertEqual(done["state"], "ACCEPTED")
        self.assertEqual(Collaboration.objects.count(), 1)
        for person in (self.asha, self.ravi):
            profile = self._json("get", self.meera, f"/api/people/{person.id}")
            topics = [c["topic"] for c in profile["collaborations"]]
            self.assertEqual(topics, ["Thin films"])

    def test_only_the_recipient_may_answer_and_only_once(self):
        sent = self._ask(self.asha, self.ravi)
        path = f"/api/collaborations/requests/{sent['request']['id']}/respond"
        self._json("post", self.asha, path, {"action": "accept"}, status=403)
        self._json("post", self.meera, path, {"action": "accept"}, status=404)
        self._json("post", self.ravi, path, {"action": "decline"})
        self._json("post", self.ravi, path, {"action": "accept"}, status=400)
        self.assertFalse(Collaboration.objects.exists())

    def test_suggesting_a_call_keeps_the_request_open(self):
        sent = self._ask(self.asha, self.ravi)
        path = f"/api/collaborations/requests/{sent['request']['id']}/respond"
        r = self._json("post", self.ravi, path, {"action": "call", "note": "Thursday at 3?"})
        self.assertEqual(r["state"], "CALL")
        self._json("post", self.ravi, path, {"action": "accept"})

    def test_a_collaboration_can_be_ended_by_a_member_only(self):
        sent = self._ask(self.asha, self.ravi)
        self._json("post", self.ravi, f"/api/collaborations/requests/{sent['request']['id']}/respond",
                   {"action": "accept"})
        collab = Collaboration.objects.get()
        self._json("delete", self.meera, f"/api/collaborations/{collab.id}", status=404)
        self._json("delete", self.asha, f"/api/collaborations/{collab.id}")
        self.assertEqual(self._json("get", self.meera, f"/api/people/{self.asha.id}")["collaborations"], [])

    def test_a_topic_is_needed_and_not_to_yourself(self):
        self._json("post", self.asha, "/api/collaborations/requests",
                   {"to_id": self.ravi.id, "topic": ""}, status=400)
        self._json("post", self.asha, "/api/collaborations/requests",
                   {"to_id": self.asha.id, "topic": "x"}, status=400)


# ---------------------------------------------------- pins and completeness --


class ProfileCompletenessTests(Base):
    def test_pin_up_to_three_of_your_own_published_papers(self):
        papers = [self._paper(self.asha, f"P{i}") for i in range(4)]
        body = self._json("put", self.asha, "/api/people/me/pins",
                          {"paper_ids": [papers[2].id, papers[0].id]})
        self.assertEqual([p["id"] for p in body["pinned"]], [papers[2].id, papers[0].id])
        self._json("put", self.asha, "/api/people/me/pins",
                   {"paper_ids": [p.id for p in papers]}, status=400)
        profile = self._json("get", self.meera, f"/api/people/{self.asha.id}")
        self.assertEqual([p["id"] for p in profile["pinned"]], [papers[2].id, papers[0].id])
        self.assertNoMoney(profile)

    def test_you_cannot_pin_somebody_elses_or_an_unpublished_paper(self):
        theirs = self._paper(self.ravi, "PX")
        draft = self._paper(self.asha, "PD", status=ClaimStatus.DRAFT)
        for pid in (theirs.id, draft.id):
            self._json("put", self.asha, "/api/people/me/pins", {"paper_ids": [pid]}, status=400)

    def test_completeness_is_shown_to_the_owner_only_with_next_steps(self):
        mine = self._json("get", self.asha, "/api/people/me")["completeness"]
        self.assertEqual(mine["score"], 0)
        keys = {i["key"] for i in mine["items"]}
        self.assertEqual(keys, {"photo", "bio", "interests", "orcid", "scopus", "pinned", "skills"})
        self.assertTrue(all(i["next_step"] for i in mine["items"]))
        self.assertIsNone(self._json("get", self.ravi, f"/api/people/{self.asha.id}")["completeness"])

    def test_completeness_rises_as_the_profile_fills_in(self):
        self.asha.bio = "I study thin films."
        self.asha.orcid_id = "0000-0002-1825-0097"
        self.asha.save()
        ResearchInterest.objects.create(user=self.asha, domain="Optics")
        score = self._json("get", self.asha, "/api/people/me")["completeness"]["score"]
        self.assertEqual(score, round(100 * 3 / 7))

    def test_a_complete_profile_ranks_higher_in_people_search(self):
        # Alphabetically first, but empty.
        self._user("aaron@x.edu", "Aaron Abel", department="Physics")
        full = self._user("zed@x.edu", "Zed Zulu", department="Physics", bio="Hello",
                          orcid_id="0000-0002-1825-0097", scopus_author_id="123")
        ResearchInterest.objects.create(user=full, domain="Optics")
        body = self._json("get", self.meera, "/api/people?department=Physics")
        self.assertEqual(body["results"][0]["name"], "Zed Zulu")


# ------------------------------------------------------ skills and endorsements --


class SkillTests(Base):
    def test_list_a_skill_and_have_a_colleague_endorse_it(self):
        skill = self._json("post", self.asha, "/api/people/me/skills", {"name": "X-ray diffraction"})
        r = self._json("post", self.ravi, f"/api/skills/{skill['id']}/endorse")
        self.assertEqual(r["count"], 1)
        profile = self._json("get", self.meera, f"/api/people/{self.asha.id}")
        self.assertEqual(profile["skills"][0]["name"], "X-ray diffraction")
        self.assertEqual(profile["skills"][0]["count"], 1)
        self.assertFalse(profile["skills"][0]["endorsed_by_me"])
        self.assertTrue(self._json("get", self.ravi, f"/api/people/{self.asha.id}")["skills"][0]["endorsed_by_me"])

    def test_a_skill_is_listed_once_whatever_the_case(self):
        self._json("post", self.asha, "/api/people/me/skills", {"name": "Python"})
        self._json("post", self.asha, "/api/people/me/skills", {"name": "python"}, status=400)

    def test_you_cannot_endorse_yourself_and_endorsing_twice_is_once(self):
        skill = self._json("post", self.asha, "/api/people/me/skills", {"name": "SEM"})
        self._json("post", self.asha, f"/api/skills/{skill['id']}/endorse", status=400)
        self._json("post", self.ravi, f"/api/skills/{skill['id']}/endorse")
        r = self._json("post", self.ravi, f"/api/skills/{skill['id']}/endorse")
        self.assertEqual(r["count"], 1)
        r = self._json("delete", self.ravi, f"/api/skills/{skill['id']}/endorse")
        self.assertEqual(r["count"], 0)

    def test_a_coauthors_endorsement_is_marked_as_one(self):
        self._paper(self.asha, "K1", doi="10.5/k")
        self._paper(self.ravi, "K2", doi="10.5/k")
        skill = self._json("post", self.asha, "/api/people/me/skills", {"name": "Spectroscopy"})
        self._json("post", self.ravi, f"/api/skills/{skill['id']}/endorse")
        self._json("post", self.meera, f"/api/skills/{skill['id']}/endorse")
        row = self._json("get", self.meera, f"/api/people/{self.asha.id}")["skills"][0]
        self.assertEqual((row["count"], row["coauthor_count"]), (2, 1))

    def test_people_search_finds_somebody_by_a_skill(self):
        self._json("post", self.meera, "/api/people/me/skills", {"name": "Chromatography"})
        body = self._json("get", self.asha, "/api/people?q=chromato")
        self.assertEqual([p["name"] for p in body["results"]], ["Meera Pillai"])

    def test_removing_a_skill_takes_its_endorsements_with_it(self):
        skill = self._json("post", self.asha, "/api/people/me/skills", {"name": "NMR"})
        self._json("post", self.ravi, f"/api/skills/{skill['id']}/endorse")
        self._json("delete", self.asha, f"/api/people/me/skills/{skill['id']}")
        self.assertEqual(self._json("get", self.ravi, f"/api/people/{self.asha.id}")["skills"], [])

    def test_only_the_owner_can_remove_a_skill(self):
        skill = self._json("post", self.asha, "/api/people/me/skills", {"name": "AFM"})
        self._json("delete", self.ravi, f"/api/people/me/skills/{skill['id']}", status=404)


# -------------------------------------------------------------------- graph --


class GraphTests(Base):
    def test_a_persons_graph_holds_their_coauthors_and_collaborators(self):
        self._paper(self.asha, "G1", doi="10.7/g")
        self._paper(self.ravi, "G2", doi="10.7/g")
        req = self._json("post", self.asha, "/api/collaborations/requests",
                         {"to_id": self.meera.id, "topic": "Catalysis"})
        self._json("post", self.meera, f"/api/collaborations/requests/{req['request']['id']}/respond",
                   {"action": "accept"})
        graph = self._json("get", self.meera, f"/api/people/{self.asha.id}/graph")
        ids = {n["id"] for n in graph["nodes"]}
        self.assertEqual(ids, {self.asha.id, self.ravi.id, self.meera.id})
        kinds = {(l["kind"], frozenset((l["source"], l["target"]))) for l in graph["links"]}
        self.assertIn(("coauthor", frozenset((self.asha.id, self.ravi.id))), kinds)
        self.assertIn(("collab", frozenset((self.asha.id, self.meera.id))), kinds)
        self.assertNoMoney(graph)

    def test_the_college_network_links_everybody_connected(self):
        self._paper(self.asha, "N1", doi="10.7/n")
        self._paper(self.ravi, "N2", doi="10.7/n")
        graph = self._json("get", self.meera, "/api/network")
        self.assertEqual({n["id"] for n in graph["nodes"]}, {self.asha.id, self.ravi.id})
        self.assertEqual(len(graph["links"]), 1)
        self.assertNoMoney(graph)


# -------------------------------------------------------------------- stats --


class StatsTests(Base):
    def test_visiting_a_profile_is_counted_once_a_day_and_not_your_own(self):
        for _ in range(3):
            self._as(self.ravi).get(f"/api/people/{self.asha.id}")
        self._as(self.asha).get("/api/people/me")
        self._as(self.asha).get(f"/api/people/{self.asha.id}")
        self.assertEqual(ProfileVisit.objects.filter(profile=self.asha).count(), 1)

    def test_a_person_can_choose_not_to_be_counted(self):
        self._json("put", self.ravi, "/api/people/me/social-settings", {"count_my_visits": False})
        self._as(self.ravi).get(f"/api/people/{self.asha.id}")
        self.assertFalse(ProfileVisit.objects.exists())

    def test_stats_are_yours_and_add_up(self):
        self._json("post", self.ravi, f"/api/follows/people/{self.asha.id}")
        self._as(self.ravi).get(f"/api/people/{self.asha.id}")
        self._as(self.meera).get(f"/api/people/{self.asha.id}")
        post = self._post(self.asha, body="My best post")
        self._post(self.asha, body="A quieter post")
        self._json("get", self.ravi, "/api/feed?tab=everyone")
        self._json("get", self.meera, "/api/feed?tab=everyone")
        self._json("post", self.ravi, f"/api/feed/posts/{post['id']}/reactions/congrats")
        self._as(self.meera).post(f"/api/feed/posts/{post['id']}/comments",
                                  data=json.dumps({"body": "Well done"}), content_type="application/json")

        stats = self._json("get", self.asha, "/api/people/me/stats")
        self.assertEqual(stats["followers"], 1)
        self.assertEqual(stats["profile_views_30d"], 2)
        self.assertEqual(stats["posts"]["count"], 2)
        top = stats["top_posts"][0]
        self.assertEqual(top["id"], post["id"])
        self.assertEqual((top["reach"], top["reactions"], top["comments"]), (2, 1, 1))
        self.assertEqual(sum(d["count"] for d in stats["views_by_day"]), 2)
        self.assertNoMoney(stats)

    def test_your_own_views_of_your_posts_are_not_reach(self):
        self._post(self.asha)
        self._json("get", self.asha, "/api/feed?tab=everyone")
        self.assertFalse(PostView.objects.exists())

    def test_nobody_else_can_ask_for_your_stats(self):
        self.assertEqual(self._as(self.ravi).get(f"/api/people/{self.asha.id}/stats").status_code, 404)
        profile = self._json("get", self.ravi, f"/api/people/{self.asha.id}")
        self.assertIsNone(profile["stats"])
        self.assertNotIn("profile_views_30d", json.dumps(profile))
        self.assertIsNotNone(self._json("get", self.asha, "/api/people/me")["stats"])

    def test_signed_out_gets_nothing(self):
        self.assertEqual(Client().get("/api/people/me/stats").status_code, 401)


# ------------------------------------------------------------------ for you --


class ForYouTests(Base):
    def setUp(self):
        super().setUp()
        ResearchInterest.objects.create(user=self.meera, domain="Condensed Matter Physics")
        self._paper(self.meera, "FY0", subjects="Condensed Matter Physics (Q1)", journal="Journal of Tests")

    def test_it_mixes_field_posts_new_papers_and_people_with_reasons(self):
        paper = self._paper(self.asha, "FY1", subjects="Condensed Matter Physics (Q1)")
        self._post(self.asha, body="CM result", paper_id=paper.id)
        # Filed, never posted about: arrives as a paper card. (A paper already
        # in a post is not shown twice.)
        self._paper(self.ravi, "FY1b", subjects="Condensed Matter Physics (Q2)")
        ResearchInterest.objects.create(user=self.ravi, domain="Condensed Matter Physics")
        body = self._json("get", self.meera, "/api/feed/for-you?seed=abc")
        kinds = {item["kind"] for item in body["items"]}
        self.assertTrue({"post", "paper", "person"} <= kinds, kinds)
        self.assertTrue(all(item["why"] for item in body["items"]))
        self.assertNoMoney(body)

    def test_the_same_seed_gives_the_same_order_and_another_may_vary(self):
        for i in range(8):
            p = self._paper(self.asha if i % 2 else self.ravi, f"FV{i}",
                            subjects="Condensed Matter Physics (Q1)")
            self._post(p.owner, body=f"post {i}", paper_id=p.id)
        first = [i.get("post", {}).get("id") or i.get("paper", {}).get("id") or i.get("person", {}).get("id")
                 for i in self._json("get", self.meera, "/api/feed/for-you?seed=one")["items"]]
        again = [i.get("post", {}).get("id") or i.get("paper", {}).get("id") or i.get("person", {}).get("id")
                 for i in self._json("get", self.meera, "/api/feed/for-you?seed=one")["items"]]
        self.assertEqual(first, again)

    def test_it_never_shows_another_departments_private_post(self):
        paper = self._paper(self.asha, "FY2", subjects="Condensed Matter Physics (Q1)")
        hidden = self._post(self.asha, body="physics only", paper_id=paper.id, visibility="DEPARTMENT")
        body = self._json("get", self.meera, "/api/feed/for-you?seed=x")
        post_ids = {i["post"]["id"] for i in body["items"] if i["kind"] == "post"}
        self.assertNotIn(hidden["id"], post_ids)

    def test_it_does_not_suggest_yourself_or_your_own_papers(self):
        body = self._json("get", self.meera, "/api/feed/for-you?seed=x")
        for item in body["items"]:
            if item["kind"] == "person":
                self.assertNotEqual(item["person"]["id"], self.meera.id)
            if item["kind"] == "paper":
                self.assertNotEqual(item["owner"]["id"], self.meera.id)

    def test_a_new_colleague_with_matching_interests_is_introduced(self):
        newbie = self._user("new@x.edu", "Nila Newcomer", department="Physics")
        ResearchInterest.objects.create(user=newbie, domain="Condensed Matter Physics")
        body = self._json("get", self.meera, "/api/feed/for-you?seed=x")
        people = [i for i in body["items"] if i["kind"] == "person"]
        match = next(i for i in people if i["person"]["id"] == newbie.id)
        self.assertTrue(match["new"])


# ------------------------------------------------------------------ settings --


class SocialSettingsTests(Base):
    def test_every_kind_is_listed_and_on_by_default(self):
        body = self._json("get", self.asha, "/api/people/me/social-settings")
        kinds = {row["kind"] for row in body["notifications"]}
        self.assertTrue({"follow", "comment", "mention", "reaction", "message", "collab",
                         "endorsement"} <= kinds)
        self.assertTrue(all(row["on"] for row in body["notifications"]))
        self.assertTrue(body["count_my_visits"])

    def test_an_unknown_kind_is_refused(self):
        self._json("put", self.asha, "/api/people/me/social-settings", {"muted": ["gossip"]}, status=400)

    def test_follow_notifications_can_be_switched_off(self):
        self._json("put", self.asha, "/api/people/me/social-settings", {"muted": ["follow"]})
        self._json("post", self.ravi, f"/api/follows/people/{self.asha.id}")
        self.assertFalse(Notification.objects.filter(user=self.asha).exists())

    def test_comment_notifications_can_be_switched_off(self):
        self._json("put", self.asha, "/api/people/me/social-settings", {"muted": ["comment"]})
        post = self._post(self.asha)
        self._as(self.ravi).post(f"/api/feed/posts/{post['id']}/comments",
                                 data=json.dumps({"body": "Nice"}), content_type="application/json")
        self.assertFalse(Notification.objects.filter(user=self.asha).exists())
