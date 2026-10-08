"""Finding and inviting people to an event: who matches its topics, who may be invited, and what they are told.

No test reaches a network: the model is `ai.ask_json` patched, and readiness is
`ai.health` patched (as in core/test_batch_check.py).
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from unittest import mock

from django.db import IntegrityError, connection, transaction
from django.test import Client, TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone

from core import hod
from core.models import (
    AuditLog,
    Authorship,
    CalendarEvent,
    EventInvite,
    EventRsvp,
    Notification,
    Publication,
    ResearchInterest,
    Role,
    User,
)
from core.services import ai, event_people
from core.services import research_picture as picture

READY = {"ready": True, "fast_ready": True, "code": "ready", "model": "llama-test", "host": "api.example.test", "hosted": True}
OFF = {"ready": False, "fast_ready": False, "code": "not_configured", "model": "", "host": "", "hosted": False}


def day(offset: int) -> date:
    return timezone.localdate() + timedelta(days=offset)


def pub(title, topics, *, venue="Journal A", quartile="Q1"):
    year = timezone.localdate().year
    return Publication.objects.create(
        title=title, year=year, date=date(year, 3, 1), topics_json=json.dumps(topics), citations=0,
        quartile=quartile, venue=venue, type="article",
    )


def on(p, user=None, name="Anon"):
    return Authorship.objects.create(
        publication=p, user=user, position=1, display_name=user.name if user else name,
        author_key=f"u:{user.id}" if user else f"n:{name.lower()}", is_college=True, institution_name="",
    )


def keys_of(value):
    found: set[str] = set()
    if isinstance(value, dict):
        for k, v in value.items():
            found.add(str(k))
            found |= keys_of(v)
    elif isinstance(value, list):
        for v in value:
            found |= keys_of(v)
    return found


class EventPeopleBase(TestCase):
    def setUp(self):
        patcher = mock.patch.object(ai, "health", return_value=OFF)
        patcher.start()
        self.addCleanup(patcher.stop)

        mk = User.objects.create_user
        self.office = mk(email="ep-office@x.edu", password="p", name="Office Admin", role=Role.SUPER_ADMIN)
        self.asha = mk(email="ep-asha@x.edu", password="p", name="Asha Menon", role=Role.FACULTY, department="ECE")
        self.ravi = mk(email="ep-ravi@x.edu", password="p", name="Ravi Kumar", role=Role.FACULTY, department="ECE")
        self.meera = mk(email="ep-meera@x.edu", password="p", name="Meera Pillai", role=Role.FACULTY, department="CSE")
        self.nina = mk(email="ep-nina@x.edu", password="p", name="Nina Rao", role=Role.FACULTY, department="ECE")
        self.gone = mk(email="ep-gone@x.edu", password="p", name="Gone Person", role=Role.FACULTY, department="ECE")
        self.gone.active = False
        self.gone.save()

        on(pub("Speech recognition for Tamil", ["Speech recognition", "Natural language processing"]), self.ravi)
        on(pub("Acoustic models for speech", ["Speech recognition"]), self.ravi)
        on(pub("Battery packs for EVs", ["Battery management"]), self.meera)
        on(pub("Speech in noisy rooms", ["Speech recognition"]), self.meera)
        on(pub("Old speech work", ["Speech recognition"]), self.asha)
        on(pub("Speech in the office", ["Speech recognition"]), self.office)
        on(pub("Speech from a closed account", ["Speech recognition"]), self.gone)
        ResearchInterest.objects.create(user=self.nina, domain="Speech recognition")

        self.event = CalendarEvent.objects.create(
            title="Seminar on speech recognition", kind="SEMINAR", starts_on=day(9),
            description="Deep learning for noisy speech", speaker="Dr Leela Nair", venue="Seminar Hall 2",
            visibility="PUBLIC", created_by=self.asha,
        )

    def ece_event(self, title="ECE seminar on speech recognition"):
        return CalendarEvent.objects.create(
            title=title, kind="SEMINAR", starts_on=day(9), visibility="DEPARTMENT", department="ECE",
            created_by=self.asha,
        )

    def client_for(self, user):
        c = Client()
        c.force_login(user)
        return c

    def invite(self, user, body, event=None):
        return self.client_for(user).post(
            f"/api/events/{(event or self.event).id}/invite", data=json.dumps(body), content_type="application/json",
        )

    def people(self, user, event=None, **params):
        query = "&".join(f"{k}={v}" for k, v in params.items())
        url = f"/api/events/{(event or self.event).id}/people" + (f"?{query}" if query else "")
        return self.client_for(user).get(url)


class EventPeopleSuggestTests(EventPeopleBase):
    def test_counted_path_picks_the_topic_the_event_is_about(self):
        out = event_people.suggest(self.event, self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], ["Speech recognition"])
        self.assertEqual((out["ai"], out["counted"]), (False, True))

    def test_people_are_those_with_papers_or_an_interest_on_the_topic(self):
        people = event_people.suggest(self.event, self.asha)["people"]
        self.assertEqual([p["name"] for p in people], ["Ravi Kumar", "Meera Pillai", "Nina Rao"])
        self.assertEqual([p["score"] for p in people], [2, 1, 1])
        self.assertEqual([p["papers_on_topic"] for p in people], [2, 1, 1])
        self.assertEqual([p["why"] for p in people], [
            "2 papers on Speech recognition",
            "1 paper on Speech recognition",
            "Lists Speech recognition as a research area",
        ])

    def test_a_department_event_suggests_only_people_who_can_see_it(self):
        names = [p["name"] for p in event_people.suggest(self.ece_event(), self.asha)["people"]]
        self.assertEqual(names, ["Ravi Kumar", "Nina Rao"])

    def test_department_and_name_filters_narrow_the_people(self):
        only_cse = event_people.suggest(self.event, self.asha, department="CSE")
        self.assertEqual([p["name"] for p in only_cse["people"]], ["Meera Pillai"])
        self.assertEqual(event_people.suggest(self.event, self.asha, q="RAV")["people"][0]["name"], "Ravi Kumar")
        self.assertEqual(event_people.suggest(self.event, self.asha, q="zzz")["total"], 0)

    def test_total_counts_every_match_and_the_limit_only_trims_the_list(self):
        out = event_people.suggest(self.event, self.asha, limit=2)
        self.assertEqual((len(out["people"]), out["total"]), (2, 3))

    def test_status_is_going_over_invited_over_none(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id]})
        EventRsvp.objects.create(event=self.event, user=self.ravi)
        EventRsvp.objects.create(event=self.event, user=self.meera)
        statuses = {p["name"]: p["status"] for p in event_people.suggest(self.event, self.asha)["people"]}
        self.assertEqual(statuses, {"Ravi Kumar": "going", "Meera Pillai": "going", "Nina Rao": "invited"})

    def test_ai_picks_are_limited_to_the_topics_the_record_holds(self):
        reply = {"topics": [{"name": "Speech recognition"}, {"name": "Physics"}]}
        with mock.patch.object(ai, "health", return_value=READY), \
                mock.patch.object(ai, "ask_json", return_value=reply) as asked:
            out = event_people.suggest(self.event, self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], ["Speech recognition"])
        self.assertEqual((out["ai"], out["counted"]), (True, False))
        self.assertEqual(asked.call_count, 1)
        self.assertNotIn("Physics", json.dumps(out))

    def test_with_ai_off_the_model_is_never_asked(self):
        with mock.patch.object(ai, "ask_json") as asked:
            out = event_people.suggest(self.event, self.asha)
        asked.assert_not_called()
        self.assertEqual((out["ai"], out["counted"]), (False, True))

    def test_a_failed_ai_answer_falls_back_to_the_count(self):
        with mock.patch.object(ai, "health", return_value=READY), \
                mock.patch.object(ai, "ask_json", side_effect=ai.AIError("It took too long.", code="timeout")):
            out = event_people.suggest(self.event, self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], ["Speech recognition"])
        self.assertEqual((out["ai"], out["counted"]), (True, True))

    def test_an_ai_answer_naming_no_listed_topic_falls_back_to_the_count(self):
        reply = {"topics": [{"name": "Physics"}]}
        with mock.patch.object(ai, "health", return_value=READY), \
                mock.patch.object(ai, "ask_json", return_value=reply):
            out = event_people.suggest(self.event, self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], ["Speech recognition"])
        self.assertTrue(out["counted"])


class CountedMatchingTests(TestCase):
    def setUp(self):
        patcher = mock.patch.object(ai, "health", return_value=OFF)
        patcher.start()
        self.addCleanup(patcher.stop)
        picture._SHARED.update(sig=None, college=None)
        self.addCleanup(picture._SHARED.update, sig=None, college=None)
        self.asha = User.objects.create_user(email="cm-asha@x.edu", password="p", name="Asha Menon", role=Role.FACULTY, department="ECE")

    def test_at_most_six_topics_are_chosen_by_paper_count(self):
        for i in range(1, 9):
            for _ in range(i):
                on(pub(f"Zeolite catalysis paper {i}", [f"Zeolite catalysis {i}"]), name="Anon")
        event = CalendarEvent.objects.create(
            title="Zeolite seminar", kind="SEMINAR", starts_on=day(3), visibility="PUBLIC", created_by=self.asha,
        )
        out = event_people.suggest(event, self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], [f"Zeolite catalysis {i}" for i in range(8, 2, -1)])
        self.assertEqual(out["topics"][0]["papers"], 8)

    def publish(self, topics):
        """Each (topic, papers) pair becomes that many papers on the one topic."""
        for name, papers in topics:
            for i in range(papers):
                on(pub(f"{name} paper {i}", [name]), name="Anon")

    def seminar(self, title):
        return CalendarEvent.objects.create(
            title=title, kind="SEMINAR", starts_on=day(3), visibility="PUBLIC", created_by=self.asha,
        )

    def test_a_rarer_shared_word_outranks_common_ones_whatever_their_paper_counts(self):
        self.publish([
            ("Energy Efficient Wireless Sensor Networks", 3), ("Energy Storage Batteries", 3),
            ("Energy Harvesting Devices", 3), ("Nonlinear Optical Materials Research", 3),
            ("Ceramic Materials Processing", 3), ("Polymer Materials Chemistry", 3),
            ("Perovskite Solar Cells", 1),
        ])
        out = event_people.suggest(self.seminar("Seminar on solar cells and energy materials"), self.asha)
        self.assertEqual(out["topics"][0]["name"], "Perovskite Solar Cells")

    def test_with_thirteen_topics_a_topic_sharing_only_common_words_is_dropped(self):
        self.publish([
            ("Perovskite Solar Cells", 1), ("Energy Efficient Wireless Sensor Networks", 2),
            ("Energy Storage Batteries", 2), ("Nonlinear Optical Materials Research", 2),
            ("Ceramic Materials Processing", 2), ("Zeolite catalysis", 1), ("Marine ecology", 1),
            ("Glacier dynamics", 1), ("Volcanic petrology", 1), ("Coral reefs", 1), ("Desert climate", 1),
            ("Arctic ice", 1), ("Tidal rhythms", 1),
        ])
        out = event_people.suggest(self.seminar("Seminar on solar cells and energy materials"), self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], ["Perovskite Solar Cells"])

    def test_a_topic_sharing_only_a_common_word_is_dropped_beside_one_sharing_two_rarer_words(self):
        self.publish([
            ("TiO2 Photocatalysis and Solar Cells", 1), ("Nonlinear Optical Materials Research", 2),
            ("Ceramic Materials Processing", 2),
        ])
        out = event_people.suggest(self.seminar("Seminar on solar cells and energy materials"), self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], ["TiO2 Photocatalysis and Solar Cells"])

    def test_with_twelve_topics_a_common_word_topic_within_half_the_best_still_counts(self):
        self.publish([
            ("Solar Panels", 1), ("Nonlinear Optical Materials Research", 2), ("Ceramic Materials Processing", 2),
            ("Zeolite catalysis", 1), ("Marine ecology", 1), ("Glacier dynamics", 1), ("Volcanic petrology", 1),
            ("Coral reefs", 1), ("Desert climate", 1), ("Arctic ice", 1), ("Tidal rhythms", 1), ("Ocean currents", 1),
        ])
        out = event_people.suggest(self.seminar("Seminar on solar cells and energy materials"), self.asha)
        self.assertEqual(
            {t["name"] for t in out["topics"]},
            {"Solar Panels", "Nonlinear Optical Materials Research", "Ceramic Materials Processing"},
        )

    def test_a_singular_word_in_the_event_matches_the_plural_in_a_topic(self):
        self.publish([("Stem Cells", 1)])
        out = event_people.suggest(self.seminar("Seminar on cell repair"), self.asha)
        self.assertEqual([t["name"] for t in out["topics"]], ["Stem Cells"])

    def test_the_candidates_are_the_120_most_common_topics_most_common_first(self):
        for i in range(125):
            on(pub(f"Paper {i}", [f"Topic {i:03d}"]), name="Anon")
        for _ in range(2):
            on(pub("Extra paper", ["Topic 000"]), name="Anon")
        names = event_people.candidate_topics(picture.shared_college())
        self.assertEqual(len(names), 120)
        self.assertEqual(names[0], {"name": "Topic 000", "papers": 3})
        self.assertNotIn("Topic 124", [n["name"] for n in names])


class ReasonTextTests(TestCase):
    def test_a_reason_names_two_topics_and_counts_the_rest(self):
        speech = ["Speech recognition", "Acoustic models", "Language models", "Speaker diarisation"]
        self.assertEqual(event_people._why(54, speech, []), "54 papers on Speech recognition, Acoustic models and 2 more")
        self.assertEqual(event_people._why(3, speech[:3], []), "3 papers on Speech recognition, Acoustic models and 1 more")
        self.assertEqual(event_people._why(2, speech[:2], []), "2 papers on Speech recognition and Acoustic models")
        self.assertEqual(
            event_people._why(0, [], speech[:3]),
            "Lists Speech recognition, Acoustic models and 1 more as research areas",
        )


class EditorsOnlyTests(EventPeopleBase):
    def test_only_whoever_may_edit_the_event_sees_the_people(self):
        self.assertEqual(self.people(self.ravi).status_code, 403)
        self.assertEqual(self.people(self.asha).status_code, 200)
        self.assertEqual(self.people(self.office).status_code, 200)

    def test_only_an_editor_may_invite_or_see_the_invitees(self):
        self.assertEqual(self.invite(self.ravi, {"user_ids": [self.nina.id]}).status_code, 403)
        self.assertEqual(self.client_for(self.ravi).get(f"/api/events/{self.event.id}/invites").status_code, 403)
        self.assertFalse(EventInvite.objects.exists())
        self.assertEqual(self.invite(self.asha, {"user_ids": [self.nina.id]}).status_code, 200)

    def test_an_event_you_cannot_see_is_not_found_whatever_you_try(self):
        hidden = self.ece_event()
        c = self.client_for(self.meera)
        self.assertEqual(c.get(f"/api/events/{hidden.id}/people").status_code, 404)
        self.assertEqual(self.invite(self.meera, {"user_ids": [self.nina.id]}, event=hidden).status_code, 404)
        self.assertEqual(c.get(f"/api/events/{hidden.id}/invites").status_code, 404)

    def test_nobody_signed_out_is_let_in(self):
        c = Client()
        self.assertEqual(c.get(f"/api/events/{self.event.id}/people").status_code, 401)
        self.assertEqual(c.get(f"/api/events/{self.event.id}/invites").status_code, 401)


class InviteTests(EventPeopleBase):
    def test_invite_creates_a_row_for_each_person_named(self):
        r = self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id], "note": "Please come"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json(), {"invited": 2, "already": 0, "skipped": 0})
        rows = EventInvite.objects.filter(event=self.event)
        self.assertEqual(set(rows.values_list("user_id", flat=True)), {self.ravi.id, self.nina.id})
        self.assertEqual(set(rows.values_list("invited_by_id", flat=True)), {self.asha.id})
        self.assertEqual(set(rows.values_list("note", flat=True)), {"Please come"})

    def test_a_repeat_skips_the_already_invited_the_unknown_the_closed_and_yourself(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id]})
        r = self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id, "no-such-person", self.gone.id, self.asha.id]})
        self.assertEqual(r.json(), {"invited": 1, "already": 1, "skipped": 3})
        self.assertEqual(EventInvite.objects.filter(event=self.event).count(), 2)

    def test_one_invite_per_person_per_event_is_enforced_by_the_database(self):
        EventInvite.objects.create(event=self.event, user=self.ravi, invited_by=self.asha)
        with self.assertRaises(IntegrityError), transaction.atomic():
            EventInvite.objects.create(event=self.event, user=self.ravi, invited_by=self.asha)

    def test_each_newly_invited_person_is_told_once_and_a_repeat_tells_nobody(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id]})
        told = Notification.objects.filter(kind="event")
        self.assertEqual(set(told.values_list("user__email", flat=True)), {self.ravi.email, self.nina.email})
        note = told.get(user=self.ravi)
        self.assertEqual(note.title, "Asha Menon invites you: Seminar on speech recognition")
        self.assertEqual(note.href, f"/events?event={self.event.id}")
        self.assertIn("Seminar Hall 2", note.body)
        self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id]})
        self.assertEqual(Notification.objects.filter(kind="event").count(), 2)

    def test_the_invite_writes_one_audit_row_with_counts_and_no_names(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id]})
        rows = list(AuditLog.objects.filter(action="EVENT_INVITES_SENT"))
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0].actor_id, rows[0].entity, rows[0].entity_id), (self.asha.id, "CalendarEvent", self.event.id))
        self.assertEqual(json.loads(rows[0].detail_json), {"invited": 2, "already": 0, "skipped": 0})
        self.assertNotIn(self.ravi.id, rows[0].detail_json)

    def test_a_person_who_cannot_see_the_event_is_skipped_not_invited(self):
        hidden = self.ece_event()
        r = self.invite(self.asha, {"user_ids": [self.meera.id, self.nina.id]}, event=hidden)
        self.assertEqual(r.json(), {"invited": 1, "already": 0, "skipped": 1})
        self.assertFalse(EventInvite.objects.filter(user=self.meera).exists())

    def test_an_invite_names_between_one_and_two_hundred_people_and_a_short_note(self):
        self.assertEqual(self.invite(self.asha, {"user_ids": []}).status_code, 400)
        self.assertEqual(self.invite(self.asha, {"user_ids": [f"x{i}" for i in range(201)]}).status_code, 400)
        self.assertEqual(self.invite(self.asha, {"user_ids": [self.ravi.id], "note": "x" * 501}).status_code, 400)
        self.assertFalse(EventInvite.objects.exists())


class InviteesTests(EventPeopleBase):
    def test_the_invitees_say_who_is_going_and_who_invited_them(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id]})
        EventRsvp.objects.create(event=self.event, user=self.ravi)
        r = self.client_for(self.asha).get(f"/api/events/{self.event.id}/invites")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["counts"], {"invited": 2, "going": 1})
        self.assertEqual({p["name"]: p["going"] for p in body["people"]}, {"Ravi Kumar": True, "Nina Rao": False})
        self.assertEqual({p["invited_by_name"] for p in body["people"]}, {"Asha Menon"})
        self.assertEqual({p["name"]: p["initials"] for p in body["people"]}, {"Ravi Kumar": "RK", "Nina Rao": "NR"})
        self.assertEqual(
            set(body["people"][0]),
            {"id", "name", "department", "photo_url", "initials", "invited_at", "invited_by_name", "going"},
        )


class PeopleEndpointTests(EventPeopleBase):
    def test_the_people_endpoint_returns_the_matches_with_their_faces(self):
        body = self.people(self.asha).json()
        self.assertEqual(set(body), {"event_id", "topics", "ai", "counted", "people", "total"})
        self.assertEqual(body["event_id"], self.event.id)
        ravi = body["people"][0]
        self.assertEqual(
            set(ravi),
            {"id", "name", "department", "designation", "photo_url", "initials", "why", "score", "papers_on_topic", "status"},
        )
        self.assertEqual((ravi["initials"], ravi["photo_url"], ravi["status"]), ("RK", None, "none"))

    def test_the_filters_reach_the_matching(self):
        body = self.people(self.asha, department="CSE").json()
        self.assertEqual([p["name"] for p in body["people"]], ["Meera Pillai"])


class EventPayloadTests(EventPeopleBase):
    def listing(self, user):
        return self.client_for(user).get("/api/events").json()["results"]

    def test_the_invitee_sees_who_invited_them_and_no_count(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id]})
        mine = self.listing(self.ravi)[0]
        self.assertEqual(mine["invited_by"], {"id": self.asha.id, "name": "Asha Menon"})
        self.assertEqual(mine["invited_count"], 0)
        self.assertIsNone(self.listing(self.nina)[0]["invited_by"])

    def test_the_editor_sees_how_many_were_invited_and_the_office_too(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id]})
        self.assertEqual(self.listing(self.asha)[0]["invited_count"], 2)
        self.assertIsNone(self.listing(self.asha)[0]["invited_by"])
        self.assertEqual(self.listing(self.office)[0]["invited_count"], 2)

    def test_the_summary_carries_the_same_fields(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id]})
        summary = self.client_for(self.ravi).get("/api/events/summary").json()
        self.assertEqual(summary["upcoming"][0]["invited_by"], {"id": self.asha.id, "name": "Asha Menon"})

    def test_the_listing_takes_no_query_per_event(self):
        def queries():
            with CaptureQueriesContext(connection) as ctx:
                r = self.client_for(self.asha).get("/api/events")
            self.assertEqual(r.status_code, 200)
            return len(ctx)

        one = queries()
        for i in range(6):
            e = CalendarEvent.objects.create(
                title=f"Workshop {i} on speech", kind="WORKSHOP", starts_on=day(12 + i), visibility="PUBLIC",
                created_by=self.asha,
            )
            EventInvite.objects.create(event=e, user=self.ravi, invited_by=self.asha)
            EventRsvp.objects.create(event=e, user=self.nina)
        self.assertEqual(queries(), one)


class NoMoneyTests(EventPeopleBase):
    def test_no_payload_carries_a_money_field(self):
        self.invite(self.asha, {"user_ids": [self.ravi.id, self.nina.id]})
        responses = [
            self.people(self.asha),
            self.client_for(self.asha).get(f"/api/events/{self.event.id}/invites"),
            self.client_for(self.asha).get("/api/events"),
            self.client_for(self.ravi).get("/api/events"),
        ]
        keys: set[str] = set()
        for r in responses:
            self.assertEqual(r.status_code, 200, r.content)
            keys |= keys_of(r.json())
        self.assertEqual(keys & hod.MONEY_KEYS, set())


class AudienceEvalTests(TestCase):
    def test_the_audience_evals_all_pass_offline(self):
        from core import ai_evals

        results = ai_evals.run_all(only="events.audience")
        # 7 injections, a forged fence, hidden text, an oversized block, the golden case, and the four of our own.
        self.assertGreaterEqual(len(results), 15)
        self.assertEqual([(r.case.id, r.failures) for r in results if not r.passed], [])
