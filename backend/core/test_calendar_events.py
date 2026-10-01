"""Personal events, who may add what, and the ICS subscription feed."""
from __future__ import annotations
from django.conf import settings
from urllib.parse import urlparse

import json
import re
from datetime import date

from django.test import Client, TestCase
from django.utils import timezone

from core.models import CalendarEvent, Claim, ClaimStatus, PaidLedger, Role, User
from core.services import ics


class CalendarEventTests(TestCase):
    def setUp(self):
        self.office = User.objects.create_user(
            email="ce-office@x.edu", password="p", name="Office", role=Role.RESEARCH_CELL
        )
        self.me = User.objects.create_user(
            email="ce-me@x.edu", password="p", name="Me", role=Role.FACULTY,
            staff_id="S-ME-1", department="ECE",
        )
        self.other = User.objects.create_user(
            email="ce-other@x.edu", password="p", name="Other", role=Role.FACULTY,
            department="ECE",
        )
        self.head = User.objects.create_user(
            email="ce-head@x.edu", password="p", name="Head", role=Role.HOD, department="ECE",
        )

    def client_for(self, user):
        c = Client()
        c.force_login(user)
        return c

    def add(self, user, **kw):
        body = {"title": "Write the intro", "kind": "OTHER", "starts_on": "2026-09-24"}
        body.update(kw)
        return self.client_for(user).post(
            "/api/calendar", data=json.dumps(body), content_type="application/json"
        )

    def listed(self, user):
        r = self.client_for(user).get("/api/calendar?start=2026-09-01&end=2026-09-30")
        return {e["title"] for e in r.json()["results"]}

    # ---- who may add what ----

    def test_faculty_add_private_reminders_with_times(self):
        r = self.add(self.me, all_day=False, starts_at="10:00", ends_at="11:30")
        self.assertEqual(r.status_code, 200, r.content)
        e = r.json()
        self.assertEqual((e["visibility"], e["starts_at"], e["ends_at"], e["all_day"]),
                         ("PRIVATE", "10:00", "11:30", False))

    def test_faculty_cannot_announce_to_the_department_or_college(self):
        for vis in ("PUBLIC", "DEPARTMENT", "OFFICE"):
            r = self.add(self.me, visibility=vis, department="ECE")
            self.assertEqual(r.status_code, 403, (vis, r.content))

    def test_a_head_may_tell_their_department_but_not_the_college(self):
        self.assertEqual(self.add(self.head, visibility="DEPARTMENT").status_code, 200)
        self.assertEqual(self.add(self.head, visibility="PUBLIC").status_code, 403)
        self.assertIn("Write the intro", self.listed(self.other))

    def test_a_private_reminder_is_nobody_elses_not_even_the_office(self):
        eid = self.add(self.me, title="My secret").json()["id"]
        self.assertIn("My secret", self.listed(self.me))
        self.assertNotIn("My secret", self.listed(self.other))
        self.assertNotIn("My secret", self.listed(self.office))
        for who in (self.other, self.office):
            c = self.client_for(who)
            self.assertEqual(c.delete(f"/api/calendar/{eid}").status_code, 404)
            r = c.patch(f"/api/calendar/{eid}", data=json.dumps(
                {"title": "Hijacked", "starts_on": "2026-09-24"}), content_type="application/json")
            self.assertEqual(r.status_code, 404)

    def test_owner_edits_and_deletes(self):
        eid = self.add(self.me).json()["id"]
        c = self.client_for(self.me)
        r = c.patch(f"/api/calendar/{eid}", data=json.dumps({
            "title": "Renamed", "starts_on": "2026-09-25", "all_day": False,
            "starts_at": "09:00", "kind": "OTHER"}), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["title"], r.json()["starts_at"]), ("Renamed", "09:00"))
        self.assertEqual(c.delete(f"/api/calendar/{eid}").status_code, 200)
        self.assertFalse(CalendarEvent.objects.filter(pk=eid).exists())

    def test_the_office_event_is_not_faculty_to_change(self):
        eid = self.add(self.office, visibility="PUBLIC").json()["id"]
        self.assertEqual(self.client_for(self.me).delete(f"/api/calendar/{eid}").status_code, 403)

    def test_a_reminder_links_only_to_my_own_paper(self):
        mine = Claim.objects.create(owner=self.me, status=ClaimStatus.SUBMITTED, paper_title="Mine")
        theirs = Claim.objects.create(owner=self.other, status=ClaimStatus.SUBMITTED, paper_title="T")
        r = self.add(self.me, claim_id=mine.id)
        self.assertEqual((r.status_code, r.json()["claim_title"]), (200, "Mine"))
        self.assertEqual(self.add(self.me, claim_id=theirs.id).status_code, 404)

    def test_the_listing_says_which_audiences_I_may_choose(self):
        r = self.client_for(self.me).get("/api/calendar?start=2026-09-01&end=2026-09-30")
        self.assertEqual(r.json()["visibilities"], ["PRIVATE"])


class FeedTests(TestCase):
    def setUp(self):
        self.me = User.objects.create_user(
            email="feed-me@x.edu", password="p", name="Me", role=Role.FACULTY,
            staff_id="STAFF-777", department="ECE",
        )
        self.c = Client()
        self.c.force_login(self.me)

    def link(self):
        return self.c.get("/api/calendar/feed-link").json()

    def test_the_link_is_stable_and_points_google_at_webcal(self):
        a, b = self.link(), self.link()
        self.assertEqual(a, b)
        self.assertTrue(a["webcal"].startswith("webcal://"))
        self.assertTrue(a["google_subscribe_url"].startswith(
            "https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2F"))

    def test_feed_is_valid_ics_with_stable_uids_and_no_money(self):
        today = timezone.localdate()
        ev = CalendarEvent.objects.create(
            title="Review; draft, with \\ backslash\nand newline " + "x" * 90,
            starts_on=today, visibility="PRIVATE", created_by=self.me,
        )
        PaidLedger.objects.create(
            payout_month=today.replace(day=1), amount=123456.0, paper_title="Paid paper",
            staff_id="STAFF-777",
            raw_json=json.dumps({"Month": f"{today.replace(day=1).isoformat()} 00:00:00"}),
        )
        url = self.link()["url"]
        path = urlparse(url).path
        self.assertTrue(url.startswith(settings.APP_BASE_URL))
        anon = Client()
        r = anon.get(path)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r["Content-Type"].startswith("text/calendar"))
        self.assertEqual(r["Cache-Control"], "max-age=900")
        body = r.content.decode("utf-8")
        self.assertTrue(body.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))
        self.assertTrue(body.endswith("END:VCALENDAR\r\n"))
        # Every physical line within 75 octets; CRLF only.
        for line in body.split("\r\n"):
            self.assertLessEqual(len(line.encode()), 75, line)
        self.assertNotIn("\n", body.replace("\r\n", ""))
        unfolded = body.replace("\r\n ", "")
        self.assertIn(f"UID:event-{ev.id}@faculty-paper", unfolded)
        self.assertIn("SUMMARY:Review\\; draft\\, with \\\\ backslash\\nand newline", unfolded)
        self.assertEqual(unfolded.count("BEGIN:VEVENT"), unfolded.count("END:VEVENT"))
        self.assertIn("SUMMARY:Paid for Paid paper", unfolded)
        # No money and no staff id leave in the feed.
        self.assertNotIn("123456", body)
        self.assertNotIn("1,23,456", body)
        self.assertNotIn("STAFF-777", body)
        # Same UIDs on a second fetch.
        uids = lambda b: sorted(re.findall(r"^UID:.*$", b.replace("\r\n ", ""), re.M))
        self.assertEqual(uids(body), uids(anon.get(path).content.decode()))

    def test_reset_revokes_the_old_link(self):
        old = urlparse(self.link()["url"]).path
        self.assertEqual(Client().get(old).status_code, 200)
        new = urlparse(self.c.post("/api/calendar/feed-link/reset").json()["url"]).path
        self.assertNotEqual(old, new)
        self.assertEqual(Client().get(old).status_code, 404)
        self.assertEqual(Client().get(new).status_code, 200)

    def test_an_unknown_token_is_404(self):
        self.assertEqual(Client().get("/api/calendar/feed/nope.ics").status_code, 404)

    def test_all_day_end_is_exclusive(self):
        lines = ics.vevent("u", "Window", date(2026, 10, 1), date(2026, 10, 3))
        self.assertIn("DTSTART;VALUE=DATE:20261001", lines)
        self.assertIn("DTEND;VALUE=DATE:20261004", lines)

    def test_timed_event_is_written_in_utc(self):
        from datetime import time
        lines = ics.vevent("u", "Talk", date(2026, 10, 1), None, time(10, 0), time(11, 0))
        self.assertIn("DTSTART:20261001T043000Z", lines)
        self.assertIn("DTEND:20261001T053000Z", lines)
