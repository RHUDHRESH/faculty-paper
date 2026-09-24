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
    NotificationSettings,
    ProfileView,
    Role,
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
            notify(self.me, "social_like", verb="liked your post", actor=who,
                   href="/discussions/t1", group_key="like:post1")
        rows = list(Notification.objects.filter(user=self.me))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].group_count, 3)
        self.assertEqual(rows[0].title, "Meera and 2 others liked your post")
        self.assertEqual([x["name"] for x in rows[0].actors], ["Meera", "Ravi", "Asha"])

    def test_the_same_person_twice_is_not_two_people(self):
        a = _person("a@test.edu", "Asha")
        for _ in range(2):
            notify(self.me, "social_like", verb="liked your post", actor=a, group_key="like:p")
        row = Notification.objects.get(user=self.me)
        self.assertEqual(row.group_count, 1)
        self.assertEqual(row.title, "Asha liked your post")

    def test_two_people_are_named_both(self):
        a, b = _person("a@test.edu", "Asha"), _person("b@test.edu", "Ravi")
        notify(self.me, "social_like", verb="liked your post", actor=a, group_key="like:p")
        notify(self.me, "social_like", verb="liked your post", actor=b, group_key="like:p")
        self.assertEqual(Notification.objects.get().title, "Ravi and Asha liked your post")

    def test_a_read_group_is_closed_and_the_next_like_starts_a_new_line(self):
        a, b = _person("a@test.edu", "Asha"), _person("b@test.edu", "Ravi")
        notify(self.me, "social_like", verb="liked your post", actor=a, group_key="like:p")
        Notification.objects.update(read=True)
        notify(self.me, "social_like", verb="liked your post", actor=b, group_key="like:p")
        self.assertEqual(Notification.objects.filter(user=self.me).count(), 2)

    @override_settings(**EMAIL_ON)
    def test_joining_a_group_does_not_send_another_email(self):
        NotificationPreference.objects.create(user=self.me, kind="social_like", level="email")
        a, b = _person("a@test.edu", "Asha"), _person("b@test.edu", "Ravi")
        notify(self.me, "social_like", verb="liked your post", actor=a, group_key="like:p")
        notify(self.me, "social_like", verb="liked your post", actor=b, group_key="like:p")
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

    def test_profile_view_sharing_and_whatsapp_consent_are_saved(self):
        r = self._put({"share_profile_views": False, "whatsapp_opt_in": True})
        self.assertEqual(r.status_code, 200, r.content)
        s = NotificationSettings.objects.get(user=self.me)
        self.assertFalse(s.share_profile_views)
        self.assertTrue(s.whatsapp_opt_in)

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
        notify(self.me, "social_like", verb="liked your post", actor=a, group_key="like:p")
        notify(self.me, "claim_paid", "Paid", "Paid.")
        rows = self.c.get("/api/notifications").json()
        by_kind = {r["kind"]: r for r in rows}
        self.assertEqual(by_kind["social_like"]["section"], "people")
        self.assertEqual(by_kind["social_like"]["count"], 1)
        self.assertEqual(by_kind["social_like"]["actors"], ["Asha"])
        self.assertEqual(by_kind["claim_paid"]["section"], "papers")

    def test_filters_by_section_and_unread(self):
        notify(self.me, "claim_paid", "Paid", "Paid.")
        n2 = notify(self.me, "social_follow", "Ravi followed you")
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


class ProfileViewTests(TestCase):
    def setUp(self):
        self.me = _person("me@test.edu", "Me")
        self.viewer = _person("v@test.edu", "Asha")
        self.c = Client()
        self.c.force_login(self.viewer)

    def _view(self, who):
        return self.c.post(
            "/api/profile-views", data=json.dumps({"viewed_id": who.id}),
            content_type="application/json",
        )

    def test_a_view_is_recorded_and_the_person_told(self):
        self.assertEqual(self._view(self.me).status_code, 200)
        self.assertEqual(ProfileView.objects.filter(viewer=self.viewer, viewed=self.me).count(), 1)
        note = Notification.objects.get(user=self.me)
        self.assertEqual(note.kind, "profile_view")
        self.assertEqual(note.title, "Asha viewed your profile")

    def test_looking_at_yourself_is_not_a_view(self):
        self.c.force_login(self.me)
        self._view(self.me)
        self.assertFalse(ProfileView.objects.exists())
        self.assertFalse(Notification.objects.exists())

    def test_a_viewer_who_opted_out_is_not_recorded(self):
        NotificationSettings.objects.create(user=self.viewer, share_profile_views=False)
        self._view(self.me)
        self.assertFalse(ProfileView.objects.exists())
        self.assertFalse(Notification.objects.exists())

    def test_one_viewer_counts_once_a_day(self):
        self._view(self.me)
        self._view(self.me)
        self.assertEqual(ProfileView.objects.count(), 1)

    def test_views_group_into_one_line(self):
        self._view(self.me)
        other = _person("o@test.edu", "Ravi")
        self.c.force_login(other)
        self._view(self.me)
        note = Notification.objects.get(user=self.me)
        self.assertEqual(note.title, "Ravi and Asha viewed your profile")

    def test_you_can_see_who_looked_this_month(self):
        self._view(self.me)
        ProfileView.objects.create(
            viewer=_person("old@test.edu", "Old"), viewed=self.me,
            at=timezone.now() - timedelta(days=45),
        )
        self.c.force_login(self.me)
        body = self.c.get("/api/profile-views/me").json()
        self.assertEqual(body["count"], 1)
        self.assertEqual([v["name"] for v in body["viewers"]], ["Asha"])
