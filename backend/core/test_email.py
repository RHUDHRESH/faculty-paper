"""Email worth receiving: every kind renders, no desk leaks to a claimant,
preferences hold, empty digests are skipped, and the hourly limit batches.

All mail goes to Django's locmem outbox (the test runner's default backend).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.core import mail
from django.test import Client, TestCase, override_settings

from core.models import (
    Authorship, Claim, ClaimStatus, DepartmentTarget, Notification,
    NotificationPreference, Publication, Role, User,
)
from core.services import digest
from core.services import notify as notify_service
from core.services.notify import notify

IST = ZoneInfo("Asia/Kolkata")
MONDAY = datetime(2026, 9, 28, 8, 0, tzinfo=IST)


def _person(email, name="Asha Menon", role=Role.FACULTY, dept="Mechanical", **extra):
    return User.objects.create_user(email=email, password=None, name=name, role=role,
                                    department=dept, **extra)


def _emails_to(user):
    return [m for m in mail.outbox if m.to == [user.email]]


@override_settings(EMAIL_HOST="smtp.test", APP_BASE_URL="https://app.test",
                   EMAIL_HOURLY_PER_PERSON=0, EMAIL_DAILY_CAP=0)
class RenderTests(TestCase):
    def setUp(self):
        self.faculty = _person("f@test.edu")
        self.officer = _person("o@test.edu", "Office", role=Role.SUPER_ADMIN, dept=None)

    def test_every_kind_renders_html_and_text_with_one_button_and_the_settings_link(self):
        for key, spec in notify_service.KINDS.items():
            user = self.officer if spec.audience in ("staff", "principal") else self.faculty
            NotificationPreference.objects.update_or_create(user=user, kind=key, defaults={"level": "email"})
            mail.outbox.clear()
            notify(user, key, f"Title for {key}", "One clear sentence.", "/papers/abc")
            [m] = _emails_to(user)
            html = m.alternatives[0][0]
            self.assertIn("https://app.test/papers/abc", html, key)
            self.assertIn(notify_service.EMAIL_ACTIONS[key], html, key)
            self.assertIn("Change what you get emailed", html, key)
            self.assertIn("https://app.test/settings/notifications", m.body, key)
            self.assertIn("One clear sentence.", m.body, key)

    def test_a_claimant_email_never_names_a_desk_or_person_holding_it(self):
        notify(self.faculty, "claim_approved", "Approved by the Principal",
               "Your paper is approved. The Principal signed it off. Payment follows.", "/papers/1")
        [m] = _emails_to(self.faculty)
        text = (m.subject + m.body + m.alternatives[0][0]).lower()
        for word in notify_service.DESK_WORDS:
            self.assertNotIn(word, text.replace("change what you get emailed", ""), word)
        self.assertIn("Payment follows.", m.body)

    def test_an_officer_email_may_name_the_desk(self):
        NotificationPreference.objects.create(user=self.officer, kind="desk", level="email")
        notify(self.officer, "desk", "A paper is waiting at clearing", "At your desk.", "/admin/clearing")
        [m] = _emails_to(self.officer)
        self.assertIn("clearing", m.subject)


@override_settings(EMAIL_HOST="smtp.test", EMAIL_HOURLY_PER_PERSON=0, EMAIL_DAILY_CAP=0)
class PreferenceTests(TestCase):
    def test_in_app_and_off_send_no_email(self):
        me = _person("me@test.edu")
        NotificationPreference.objects.create(user=me, kind="citation", level="in_app")
        NotificationPreference.objects.create(user=me, kind="claim_paid", level="off")
        notify(me, "citation", "Cited again")
        notify(me, "claim_paid", "Paid")
        self.assertEqual(len(mail.outbox), 0)
        self.assertFalse(Notification.objects.filter(user=me, kind="claim_paid").exists())

    def test_digest_email_is_opt_in(self):
        self.assertEqual(notify_service.KINDS["digest"].default, "in_app")


@override_settings(EMAIL_HOST="smtp.test", EMAIL_HOURLY_PER_PERSON=0, EMAIL_DAILY_CAP=0)
class DigestRoleTests(TestCase):
    def test_empty_digests_are_skipped(self):
        quiet = _person("q@test.edu", dept="Nowhere")
        NotificationPreference.objects.create(user=quiet, kind="digest", level="email")
        _person("fin@test.edu", "Money", role=Role.FINANCE, dept=None)
        summary = digest.send_weekly_digest(now=MONDAY)
        self.assertEqual(summary["sent"], 0)
        self.assertEqual(len(mail.outbox), 0)

    def test_faculty_hear_of_papers_found_on_their_record_and_progress(self):
        me = _person("me@test.edu")
        NotificationPreference.objects.create(user=me, kind="digest", level="email")
        pub = Publication.objects.create(title="Found Paper", year=2026)
        Authorship.objects.create(publication=pub, display_name="Asha Menon", author_key="asha", user=me)
        Claim.objects.create(owner=me, paper_title="In Flight", status=ClaimStatus.CLEARED,
                             submitted_at=MONDAY - timedelta(days=3))
        digest.send_weekly_digest(now=MONDAY)
        [m] = _emails_to(me)
        html = m.alternatives[0][0]
        self.assertIn("Found Paper", html)
        self.assertIn("In Flight", html)
        self.assertIn("Being checked", html)
        for word in ("principal", "clearing", "desk"):
            self.assertNotIn(word, (m.subject + m.body).lower())

    def test_hod_sees_pace_and_who_needs_a_push(self):
        hod = _person("h@test.edu", "Head", role=Role.HOD)
        _person("idle@test.edu", "Idle Ian")
        DepartmentTarget.objects.create(department="Mechanical", year=2026,
                                        metric=DepartmentTarget.Metric.PUBLICATIONS, target=20)
        d = digest.build_for(hod, MONDAY)
        self.assertEqual(d["pace"]["target"], 20)
        self.assertIn("Idle Ian", d["pace"]["push"])
        self.assertIn("behind pace", d["pace"]["line"])

    def test_officers_hear_what_waits_on_their_desk_and_for_how_long(self):
        principal = _person("p@test.edu", "Prin", role=Role.PRINCIPAL, dept=None)
        owner = _person("x@test.edu")
        c = Claim.objects.create(owner=owner, paper_title="Waiting", status=ClaimStatus.CLEARED)
        Claim.objects.filter(pk=c.pk).update(updated_at=MONDAY - timedelta(days=9))
        d = digest.build_for(principal, MONDAY)
        self.assertEqual(d["desk"]["count"], 1)
        self.assertEqual(d["desk"]["oldest_days"], 9)
        self.assertEqual(d["desk"]["href"], "/principal")


@override_settings(EMAIL_HOST="smtp.test", EMAIL_HOURLY_PER_PERSON=2, EMAIL_DAILY_CAP=0)
class RateLimitTests(TestCase):
    def test_past_the_hourly_limit_alerts_wait_for_one_batched_email(self):
        me = _person("me@test.edu")
        for i in range(5):
            notify(me, "citation", f"Cited {i}", "", "/papers/x")
        self.assertEqual(len(_emails_to(me)), 2)
        self.assertEqual(Notification.objects.filter(user=me, emailed_at__isnull=True).count(), 3)
        # Still inside the hour: the batch waits.
        self.assertEqual(notify_service.flush_held_emails()["people"], 0)
        Notification.objects.filter(user=me).exclude(emailed_at=None).update(
            emailed_at=MONDAY - timedelta(hours=3))
        summary = notify_service.flush_held_emails()
        self.assertEqual(summary, {"people": 1, "alerts": 3})
        batch = _emails_to(me)[-1]
        self.assertIn("3 updates", batch.subject)
        self.assertIn("Cited 4", batch.alternatives[0][0])
        self.assertFalse(Notification.objects.filter(user=me, emailed_at__isnull=True).exists())
        # The batch counts as one email, not three.
        self.assertEqual(notify_service.emails_this_hour(me), 1)


class TestEmailButtonTests(TestCase):
    def setUp(self):
        self.admin = _person("admin@test.edu", "Admin", role=Role.SUPER_ADMIN, dept=None)
        self.c = Client()
        self.c.force_login(self.admin)

    @override_settings(EMAIL_HOST="", EMAIL_NOTIFICATIONS=False)
    def test_says_plainly_when_smtp_is_not_configured(self):
        body = self.c.post("/api/notifications/test-email").json()
        self.assertFalse(body["sent"])
        self.assertIn("not set up", body["message"])
        prefs = self.c.get("/api/notifications/preferences").json()
        self.assertFalse(prefs["smtp"]["configured"])
        self.assertEqual(len(mail.outbox), 0)

    @override_settings(EMAIL_HOST="smtp-relay.brevo.com", EMAIL_PORT=2525)
    def test_sends_to_myself_when_configured(self):
        body = self.c.post("/api/notifications/test-email").json()
        self.assertTrue(body["sent"])
        [m] = mail.outbox
        self.assertEqual(m.to, ["admin@test.edu"])
        self.assertIn("2525", body["smtp"]["line"])

    def test_only_the_super_admin(self):
        c = Client()
        c.force_login(_person("f@test.edu"))
        self.assertEqual(c.post("/api/notifications/test-email").status_code, 403)
        self.assertIsNone(c.get("/api/notifications/preferences").json()["smtp"])
