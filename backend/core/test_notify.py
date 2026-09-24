"""Alerts people can trust and switch off: the notify service and its settings.

Every alert goes through `core.services.notify.notify`, which is where the
three promises are kept:

- **Every kind can be switched off, per person.** "Off" means nothing is
  written and nothing is sent -- and a row some older code path wrote
  directly under a kind the person turned off is hidden from their bell too.
- **Email is optional twice over.** It goes only when the deployment has a
  mail server (EMAIL_HOST) and the person asked for that kind by email. With
  no server configured the in-app alert still arrives and nothing raises.
- **Social alerts group.** Three likes on one post are one line, "Asha Menon
  and 2 others liked your post", not three.
"""
from __future__ import annotations

import json
from datetime import timedelta
from unittest.mock import patch

from django.core import mail
from django.test import Client, TestCase, override_settings
from django.utils import timezone

from core.models import (
    Notification,
    NotificationPreference,
    Role,
    SocialSettings,
    User,
)
from core.services import notify as notify_service
from core.services.notify import notify

EMAIL_ON = {"EMAIL_HOST": "smtp.test", "APP_BASE_URL": "https://app.test"}


def _person(email, name="Asha Menon", role=Role.FACULTY, **extra):
    return User.objects.create_user(email=email, password=None, name=name, role=role, **extra)


class NotifyServiceTests(TestCase):
    def setUp(self):
        self.me = _person("me@test.edu")

    def test_writes_an_in_app_alert_under_its_kind(self):
        note = notify(self.me, "claim_status", "On hold", "Your paper is on hold.", "/papers/x")
        self.assertIsNotNone(note)
        row = Notification.objects.get(user=self.me)
        self.assertEqual(row.kind, "claim_status")
        self.assertEqual(row.title, "On hold")
        self.assertEqual(row.href, "/papers/x")

    def test_off_writes_nothing_and_sends_nothing(self):
        NotificationPreference.objects.create(user=self.me, kind="citation", level="off")
        with override_settings(**EMAIL_ON):
            self.assertIsNone(notify(self.me, "citation", "Cited", "Your paper was cited."))
        self.assertFalse(Notification.objects.exists())
        self.assertEqual(len(mail.outbox), 0)

    @override_settings(**EMAIL_ON)
    def test_in_app_level_does_not_email(self):
        NotificationPreference.objects.create(user=self.me, kind="claim_paid", level="in_app")
        notify(self.me, "claim_paid", "Paid", "The incentive was paid.")
        self.assertEqual(Notification.objects.count(), 1)
        self.assertEqual(len(mail.outbox), 0)

    @override_settings(**EMAIL_ON)
    def test_email_level_sends_one_html_email_with_an_unsubscribe_link_for_that_kind(self):
        notify(self.me, "claim_paid", "FP-1 · Paid", "Rs 12,000 for your paper has been paid.", "/papers/p1")
        self.assertEqual(len(mail.outbox), 1)
        msg = mail.outbox[0]
        self.assertEqual(msg.to, ["me@test.edu"])
        self.assertEqual(msg.subject, "FP-1 · Paid")
        html = msg.alternatives[0][0]
        self.assertIn("Saveetha Engineering College", html)
        self.assertIn("https://app.test/papers/p1", html)
        self.assertIn("https://app.test/api/notifications/unsubscribe/", html)
        self.assertIn("List-Unsubscribe", msg.extra_headers)
        self.assertIn("Rs 12,000", msg.body)
        # Recorded, so the daily cap can count what went out.
        self.assertIsNotNone(Notification.objects.get().emailed_at)

    @override_settings(EMAIL_HOST="", EMAIL_NOTIFICATIONS=False)
    def test_no_mail_server_means_in_app_only_and_no_error(self):
        notify(self.me, "claim_paid", "Paid", "Paid.")
        self.assertEqual(Notification.objects.count(), 1)
        self.assertEqual(len(mail.outbox), 0)
        self.assertIsNone(Notification.objects.get().emailed_at)

    @override_settings(**EMAIL_ON, EMAIL_DAILY_CAP=1)
    def test_the_daily_email_cap_stops_email_but_not_the_alert(self):
        other = _person("other@test.edu", "Ravi Kumar")
        notify(self.me, "claim_paid", "Paid", "Paid.")
        notify(other, "claim_paid", "Paid", "Paid.")
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(Notification.objects.count(), 2)

    @override_settings(**EMAIL_ON)
    def test_a_failing_mail_server_does_not_lose_the_alert(self):
        with patch("django.core.mail.EmailMultiAlternatives.send", side_effect=OSError("down")):
            notify(self.me, "claim_paid", "Paid", "Paid.")
        row = Notification.objects.get()
        self.assertIsNone(row.emailed_at)

    def test_an_unknown_kind_is_filed_as_general_rather_than_failing(self):
        notify(self.me, "made_up_kind", "Hello", "Body")
        self.assertEqual(Notification.objects.get().kind, "general")

    def test_likes_on_one_post_group_into_one_line(self):
        a, b, c = (_person(f"{n}@test.edu", n) for n in ("Asha", "Ravi", "Meera"))
        for who in (a, b, c):
            notify(self.me, "reaction", verb="liked your post", actor=who,
                   href="/discussions/t1", group_key="like:post1")
        rows = list(Notification.objects.filter(user=self.me))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].group_count, 3)
        self.assertEqual(rows[0].title, "Meera and 2 others liked your post")
        self.assertEqual([x["name"] for x in rows[0].actors], ["Meera", "Ravi", "Asha"])

    def test_the_same_person_twice_is_not_two_people(self):
        a = _person("a@test.edu", "Asha")
        for _ in range(2):
            notify(self.me, "reaction", verb="liked your post", actor=a, group_key="like:p")
        row = Notification.objects.get(user=self.me)
        self.assertEqual(row.group_count, 1)
        self.assertEqual(row.title, "Asha liked your post")

    def test_two_people_are_named_both(self):
        a, b = _person("a@test.edu", "Asha"), _person("b@test.edu", "Ravi")
        notify(self.me, "reaction", verb="liked your post", actor=a, group_key="like:p")
        notify(self.me, "reaction", verb="liked your post", actor=b, group_key="like:p")
        self.assertEqual(Notification.objects.get().title, "Ravi and Asha liked your post")

    def test_a_read_group_is_closed_and_the_next_like_starts_a_new_line(self):
        a, b = _person("a@test.edu", "Asha"), _person("b@test.edu", "Ravi")
        notify(self.me, "reaction", verb="liked your post", actor=a, group_key="like:p")
        Notification.objects.update(read=True)
        notify(self.me, "reaction", verb="liked your post", actor=b, group_key="like:p")
        self.assertEqual(Notification.objects.filter(user=self.me).count(), 2)

    @override_settings(**EMAIL_ON)
    def test_joining_a_group_does_not_send_another_email(self):
        NotificationPreference.objects.create(user=self.me, kind="reaction", level="email")
        a, b = _person("a@test.edu", "Asha"), _person("b@test.edu", "Ravi")
        notify(self.me, "reaction", verb="liked your post", actor=a, group_key="like:p")
        notify(self.me, "reaction", verb="liked your post", actor=b, group_key="like:p")
        self.assertEqual(len(mail.outbox), 1)


class PreferencesApiTests(TestCase):
    def setUp(self):
        self.me = _person("me@test.edu")
        self.c = Client()
        self.c.force_login(self.me)

    def _get(self):
        r = self.c.get("/api/notifications/preferences")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _put(self, body):
        return self.c.put(
            "/api/notifications/preferences", data=json.dumps(body), content_type="application/json"
        )

    def test_a_claimant_sees_their_paper_kinds_and_not_the_desk(self):
        body = self._get()
        keys = {k["key"] for k in body["kinds"]}
        self.assertTrue({"claim_paid", "claim_sent_back", "citation", "digest"} <= keys)
        self.assertNotIn("desk", keys)
        # Only research faculty have a quota to be nudged about.
        self.assertNotIn("nudge_quota", keys)
        paid = next(k for k in body["kinds"] if k["key"] == "claim_paid")
        self.assertEqual(paid["level"], "email")
        self.assertEqual({lv["value"] for lv in body["levels"]}, {"email", "in_app", "off"})

    def test_staff_see_the_desk_kind(self):
        office = _person("office@test.edu", "Office", Role.SUPER_ADMIN)
        self.c.force_login(office)
        keys = {k["key"] for k in self._get()["kinds"]}
        self.assertIn("desk", keys)
        self.assertNotIn("claim_paid", keys)

    def test_research_faculty_see_the_quota_nudge(self):
        self.me.faculty_type = "RESEARCH"
        self.me.research_quota = 3
        self.me.save()
        self.assertIn("nudge_quota", {k["key"] for k in self._get()["kinds"]})

    def test_saving_levels_is_remembered(self):
        r = self._put({"levels": {"citation": "off", "claim_paid": "in_app"}})
        self.assertEqual(r.status_code, 200, r.content)
        levels = {k["key"]: k["level"] for k in self._get()["kinds"]}
        self.assertEqual(levels["citation"], "off")
        self.assertEqual(levels["claim_paid"], "in_app")
        self.assertEqual(NotificationPreference.objects.filter(user=self.me).count(), 2)

    def test_a_bad_level_or_kind_is_refused(self):
        self.assertEqual(self._put({"levels": {"citation": "loud"}}).status_code, 400)
        self.assertEqual(self._put({"levels": {"nonsense": "off"}}).status_code, 400)

    def test_visit_counting_and_whatsapp_consent_are_saved(self):
        r = self._put({"count_my_visits": False, "whatsapp_opt_in": True})
        self.assertEqual(r.status_code, 200, r.content)
        s = SocialSettings.objects.get(user=self.me)
        self.assertFalse(s.count_my_visits)
        self.assertTrue(s.whatsapp_opt_in)
        self.assertFalse(self._get()["count_my_visits"])

    def test_moderation_cannot_be_switched_off(self):
        self.assertEqual(self._put({"levels": {"moderation": "off"}}).status_code, 400)
        self.assertEqual(self._put({"levels": {"moderation": "email"}}).status_code, 200)

    @override_settings(EMAIL_HOST="")
    def test_says_when_email_is_not_set_up(self):
        self.assertFalse(self._get()["email_available"])

    @override_settings(EMAIL_HOST="smtp.test")
    def test_says_when_email_is_set_up(self):
        self.assertTrue(self._get()["email_available"])


class BellListTests(TestCase):
    def setUp(self):
        self.me = _person("me@test.edu")
        self.c = Client()
        self.c.force_login(self.me)

    def test_rows_carry_kind_section_and_group(self):
        a = _person("a@test.edu", "Asha")
        notify(self.me, "reaction", verb="liked your post", actor=a, group_key="like:p")
        notify(self.me, "claim_paid", "Paid", "Paid.")
        rows = self.c.get("/api/notifications").json()
        by_kind = {r["kind"]: r for r in rows}
        self.assertEqual(by_kind["reaction"]["section"], "people")
        self.assertEqual(by_kind["reaction"]["count"], 1)
        self.assertEqual(by_kind["reaction"]["actors"], ["Asha"])
        self.assertEqual(by_kind["claim_paid"]["section"], "papers")

    def test_filters_by_section_and_unread(self):
        notify(self.me, "claim_paid", "Paid", "Paid.")
        n2 = notify(self.me, "follow", "Ravi followed you")
        notify(self.me, "citation", "Cited", "Cited.")
        Notification.objects.filter(pk=n2.pk).update(read=True)
        papers = self.c.get("/api/notifications?section=papers").json()
        self.assertEqual({r["kind"] for r in papers}, {"claim_paid", "citation"})
        unread = self.c.get("/api/notifications?unread=true").json()
        self.assertEqual({r["kind"] for r in unread}, {"claim_paid", "citation"})

    def test_a_kind_switched_off_is_hidden_even_if_older_code_wrote_it_directly(self):
        Notification.objects.create(user=self.me, title="Assigned to you", kind="general")
        Notification.objects.create(user=self.me, title="Legacy row")  # kind defaults to general
        notify(self.me, "claim_paid", "Paid", "Paid.")
        NotificationPreference.objects.create(user=self.me, kind="general", level="off")
        rows = self.c.get("/api/notifications").json()
        self.assertEqual([r["kind"] for r in rows], ["claim_paid"])
        self.assertEqual(self.c.get("/api/notifications/unread-count").json()["unread"], 1)

    def test_mark_all_read_still_works(self):
        notify(self.me, "claim_paid", "Paid", "Paid.")
        self.c.post("/api/notifications/read-all")
        self.assertEqual(self.c.get("/api/notifications/unread-count").json()["unread"], 0)


class UnsubscribeTests(TestCase):
    def setUp(self):
        self.me = _person("me@test.edu")
        self.c = Client()

    def _token(self, kind="citation"):
        return notify_service.unsubscribe_token(self.me, kind)

    def test_the_link_asks_before_it_changes_anything(self):
        r = self.c.get(f"/api/notifications/unsubscribe/{self._token()}")
        self.assertEqual(r.status_code, 200)
        self.assertIn("New citations", r.content.decode())
        self.assertFalse(NotificationPreference.objects.exists())

    def test_confirming_stops_the_email_and_keeps_the_bell(self):
        r = self.c.post(f"/api/notifications/unsubscribe/{self._token()}")
        self.assertEqual(r.status_code, 200)
        pref = NotificationPreference.objects.get(user=self.me, kind="citation")
        self.assertEqual(pref.level, "in_app")

    def test_a_tampered_token_is_refused(self):
        r = self.c.post(f"/api/notifications/unsubscribe/{self._token()}x")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(NotificationPreference.objects.exists())


class OnePreferenceStoreTests(TestCase):
    """The social layer's switches and the settings page are one store: a kind
    switched off on either is off on both, and every helper honours it."""

    def setUp(self):
        self.me = _person("me@test.edu", "Me")
        self.other = _person("o@test.edu", "Asha")
        self.c = Client()
        self.c.force_login(self.me)

    def _social_put(self, body):
        return self.c.put(
            "/api/people/me/social-settings", data=json.dumps(body),
            content_type="application/json",
        )

    def _levels(self):
        body = self.c.get("/api/notifications/preferences").json()
        return {k["key"]: k["level"] for k in body["kinds"]}

    def test_muting_on_the_social_panel_is_off_on_the_settings_page(self):
        self.assertEqual(self._social_put({"muted": ["mention"]}).status_code, 200)
        self.assertEqual(self._levels()["mention"], "off")
        self.assertEqual(self._levels()["follow"], "in_app")

    def test_off_on_the_settings_page_is_muted_on_the_social_panel(self):
        self.c.put(
            "/api/notifications/preferences", data=json.dumps({"levels": {"follow": "off"}}),
            content_type="application/json",
        )
        panel = self.c.get("/api/people/me/social-settings").json()
        on = {n["kind"]: n["on"] for n in panel["notifications"]}
        self.assertFalse(on["follow"])
        self.assertTrue(on["mention"])

    def test_unmuting_keeps_an_email_choice_that_was_never_muted(self):
        notify_service.set_preferences(self.me, {"mention": "email", "follow": "off"})
        self._social_put({"muted": []})
        levels = self._levels()
        self.assertEqual(levels["mention"], "email")
        self.assertEqual(levels["follow"], "in_app")

    def test_the_social_helper_honours_the_one_store(self):
        from core import social_notify

        notify_service.set_preferences(self.me, {"comment": "off"})
        self.assertFalse(social_notify.notify(self.me.id, "comment", "Asha commented", "x", "/p/1"))
        self.assertTrue(social_notify.notify(self.me.id, "mention", "Asha named you", "x", "/p/1"))
        note = Notification.objects.get(user=self.me)
        self.assertEqual(note.kind, "mention")

    @override_settings(**EMAIL_ON)
    def test_a_social_kind_can_be_had_by_email(self):
        from core import social_notify

        notify_service.set_preferences(self.me, {"message": "email"})
        social_notify.notify(self.me.id, "message", "Asha sent you a message", "Hello", "/messages/1")
        self.assertEqual(len(mail.outbox), 1)

    def test_social_coalescing_still_holds_back_a_second_unread_message(self):
        from core import social_notify

        self.assertTrue(social_notify.notify(self.me.id, "message", "One", "", "/m/1", coalesce=True))
        self.assertFalse(social_notify.notify(self.me.id, "message", "Two", "", "/m/1", coalesce=True))

    def test_badges_go_through_the_one_store(self):
        from core.services import achievements

        achievements.notify(self.me, "New badge", "First paper", "/me")
        self.assertEqual(Notification.objects.get(user=self.me).kind, "badge")
        notify_service.set_preferences(self.me, {"badge": "off"})
        achievements.notify(self.me, "New badge", "Second", "/me")
        self.assertEqual(Notification.objects.filter(user=self.me).count(), 1)

    def test_moderation_rows_show_even_with_other_updates_off(self):
        Notification.objects.create(user=self.me, kind="moderation", title="Your post was hidden")
        notify_service.set_preferences(self.me, {"general": "off"})
        rows = self.c.get("/api/notifications").json()
        self.assertEqual([r["title"] for r in rows], ["Your post was hidden"])
