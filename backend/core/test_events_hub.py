"""Events and research hub: seminars, who sees and posts them, going, the single-event .ics, the summary."""
from __future__ import annotations

import json
from datetime import time, timedelta

from django.test import Client, TestCase
from django.utils import timezone

from core.models import CalendarEvent, EventRsvp, Notification, Role, User


def day(offset: int) -> str:
    return (timezone.localdate() + timedelta(days=offset)).isoformat()


class EventsHubBase(TestCase):
    def setUp(self):
        mk = User.objects.create_user
        self.office = mk(email="eh-office@x.edu", name="Office", role=Role.RESEARCH_CELL)
        self.head = mk(email="eh-head@x.edu", name="Head Ece", role=Role.HOD, department="ECE")
        self.asha = mk(email="eh-asha@x.edu", name="Asha Menon", role=Role.FACULTY, department="ECE")
        self.ravi = mk(email="eh-ravi@x.edu", name="Ravi Kumar", role=Role.FACULTY, department="ECE")
        self.meera = mk(email="eh-meera@x.edu", name="Meera Pillai", role=Role.FACULTY, department="CSE")
        self.principal = mk(email="eh-principal@x.edu", name="Principal", role=Role.PRINCIPAL)
        self.finance = mk(email="eh-finance@x.edu", name="Finance", role=Role.FINANCE)

    def client_for(self, user):
        c = Client()
        c.force_login(user)
        return c

    def post(self, user, **kw):
        body = {"title": "Seminar on power electronics", "kind": "SEMINAR", "starts_on": day(3)}
        body.update(kw)
        return self.client_for(user).post("/api/events", data=json.dumps(body), content_type="application/json")

    def listing(self, user, **params):
        query = "&".join(f"{k}={v}" for k, v in params.items())
        return self.client_for(user).get("/api/events" + (f"?{query}" if query else ""))

    def titles(self, user, **params):
        r = self.listing(user, **params)
        self.assertEqual(r.status_code, 200, r.content)
        return [e["title"] for e in r.json()["results"]]

    def make(self, title="Seminar", *, by=None, **kw):
        kw.setdefault("kind", "SEMINAR")
        kw.setdefault("starts_on", timezone.localdate() + timedelta(days=2))
        kw.setdefault("visibility", "PUBLIC")
        return CalendarEvent.objects.create(title=title, created_by=by or self.office, **kw)


class KindsAndFieldsTests(EventsHubBase):
    def test_the_five_new_kinds_exist_with_plain_labels(self):
        labels = {k.value: k.label for k in CalendarEvent.Kind}
        self.assertEqual(labels["SEMINAR"], "Seminar")
        self.assertEqual(labels["WORKSHOP"], "Workshop")
        self.assertEqual(labels["CONFERENCE"], "Conference")
        self.assertEqual(labels["FDP"], "Faculty development programme")
        self.assertEqual(labels["CALL_FOR_PAPERS"], "Call for papers")

    def test_every_field_round_trips(self):
        r = self.post(
            self.head, kind="WORKSHOP", ends_on=day(4), starts_at="15:00", ends_at="17:30",
            venue="Seminar Hall 2", speaker="Dr Leela Nair", organiser="Department of ECE",
            link="https://example.org/register", description="Hands-on session.",
            visibility="PUBLIC",
        )
        self.assertEqual(r.status_code, 200, r.content)
        e = r.json()
        self.assertEqual(
            (e["kind"], e["kind_label"], e["venue"], e["speaker"], e["organiser"], e["link"]),
            ("WORKSHOP", "Workshop", "Seminar Hall 2", "Dr Leela Nair", "Department of ECE", "https://example.org/register"),
        )
        self.assertEqual((e["starts_at"], e["ends_at"], e["all_day"], e["ends_on"]), ("15:00", "17:30", False, day(4)))
        row = CalendarEvent.objects.get(pk=e["id"])
        self.assertEqual((row.venue, row.speaker, row.organiser, row.link), ("Seminar Hall 2", "Dr Leela Nair", "Department of ECE", "https://example.org/register"))
        # And it comes back from the listing in the same shape.
        listed = self.listing(self.ravi).json()["results"]
        self.assertEqual([x["venue"] for x in listed], ["Seminar Hall 2"])

    def test_each_new_kind_is_accepted_and_an_unknown_one_is_not(self):
        for kind in ("SEMINAR", "WORKSHOP", "CONFERENCE", "FDP", "CALL_FOR_PAPERS", "OTHER"):
            self.assertEqual(self.post(self.head, kind=kind, visibility="PUBLIC").status_code, 200, kind)
        self.assertEqual(self.post(self.head, kind="BIRTHDAY").status_code, 400)
        self.assertEqual(self.post(self.head, kind="PAYOUT_RUN").status_code, 400)

    def test_a_link_must_be_a_web_address(self):
        for bad in ("javascript:alert(1)", "ftp://x.org/a", "not a link", "//evil.example"):
            self.assertEqual(self.post(self.head, link=bad).status_code, 400, bad)

    def test_a_title_is_needed_and_dates_must_run_forwards(self):
        self.assertEqual(self.post(self.head, title=" a ").status_code, 400)
        self.assertEqual(self.post(self.head, starts_on=day(5), ends_on=day(4)).status_code, 400)
        self.assertEqual(self.post(self.head, starts_on="soon").status_code, 400)

    def test_the_calendar_still_lists_the_new_kinds_and_labels_them(self):
        self.make("Open seminar", kind="SEMINAR", visibility="PUBLIC")
        r = self.client_for(self.ravi).get("/api/calendar?start=" + day(-1) + "&end=" + day(20))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        got = {e["title"]: e for e in body["results"]}
        self.assertEqual(got["Open seminar"]["kind_label"], "Seminar")
        self.assertTrue({"SEMINAR", "WORKSHOP", "CONFERENCE", "FDP", "CALL_FOR_PAPERS"} <= {k["key"] for k in body["kinds"]})

    def test_the_subscription_feed_carries_the_new_kinds_with_their_place(self):
        self.make("Open seminar", venue="Seminar Hall 2", speaker="Dr Leela Nair", link="https://example.org/x")
        link = self.client_for(self.ravi).get("/api/calendar/feed-link").json()["url"]
        from urllib.parse import urlparse

        body = Client().get(urlparse(link).path).content.decode()
        self.assertIn("SUMMARY:Open seminar", body)
        self.assertIn("CATEGORIES:Seminar", body)
        self.assertIn("LOCATION:Seminar Hall 2", body)


class WhoMayPostTests(EventsHubBase):
    def test_a_faculty_member_posts_a_seminar_for_their_own_department(self):
        r = self.post(self.asha)  # no audience given: their department
        self.assertEqual(r.status_code, 200, r.content)
        e = r.json()
        self.assertEqual((e["visibility"], e["department"], e["can_edit"]), ("DEPARTMENT", "ECE", True))
        self.assertIn("Seminar on power electronics", self.titles(self.ravi))
        self.assertNotIn("Seminar on power electronics", self.titles(self.meera))

    def test_a_faculty_member_cannot_post_for_the_college_or_another_department(self):
        self.assertEqual(self.post(self.asha, visibility="PUBLIC").status_code, 403)
        self.assertEqual(self.post(self.asha, visibility="DEPARTMENT", department="CSE").status_code, 403)
        self.assertEqual(self.post(self.asha, visibility="OFFICE").status_code, 400)
        self.assertEqual(self.post(self.asha, visibility="PRIVATE").status_code, 400)

    def test_a_head_the_principal_and_the_office_may_post_college_wide(self):
        for user in (self.head, self.principal, self.office):
            self.assertEqual(self.post(user, visibility="PUBLIC", title=f"By {user.name}").status_code, 200, user.name)
        self.assertEqual(len(self.titles(self.meera)), 3)

    def test_the_office_may_post_for_any_department(self):
        r = self.post(self.office, visibility="DEPARTMENT", department="CSE")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["department"], "CSE")
        self.assertIn("Seminar on power electronics", self.titles(self.meera))
        self.assertNotIn("Seminar on power electronics", self.titles(self.ravi))

    def test_somebody_with_no_department_cannot_post_for_one(self):
        self.assertEqual(self.post(self.finance, visibility="DEPARTMENT").status_code, 403)

    def test_the_listing_says_which_audiences_this_person_may_choose(self):
        faculty = self.listing(self.asha).json()
        self.assertTrue(faculty["can_add"])
        self.assertEqual([a["key"] for a in faculty["audiences"]], ["DEPARTMENT"])
        head = self.listing(self.head).json()
        self.assertEqual([a["key"] for a in head["audiences"]], ["DEPARTMENT", "PUBLIC"])
        nobody = self.listing(self.finance).json()
        self.assertFalse(nobody["can_add"])

    def test_nobody_signed_out_posts_or_reads(self):
        c = Client()
        self.assertEqual(c.get("/api/events").status_code, 401)
        self.assertEqual(
            c.post("/api/events", data=json.dumps({"title": "x y z", "starts_on": day(1)}), content_type="application/json").status_code,
            401,
        )


class WhoSeesWhatTests(EventsHubBase):
    def test_a_department_event_is_hidden_from_other_departments_but_not_the_office(self):
        self.make("ECE only", visibility="DEPARTMENT", department="ECE")
        self.make("Whole college", visibility="PUBLIC")
        self.assertEqual(sorted(self.titles(self.asha)), ["ECE only", "Whole college"])
        self.assertEqual(self.titles(self.meera), ["Whole college"])
        self.assertEqual(sorted(self.titles(self.office)), ["ECE only", "Whole college"])

    def test_a_private_entry_stays_private_whatever_its_kind(self):
        mine = self.make("My secret seminar", visibility="PRIVATE", by=self.asha)
        self.assertNotIn("My secret seminar", self.titles(self.meera))
        self.assertNotIn("My secret seminar", self.titles(self.office))
        self.assertNotIn("My secret seminar", self.titles(self.asha))  # a diary entry is not an event to show off
        c = self.client_for(self.meera)
        self.assertEqual(c.get(f"/api/events/{mine.id}.ics").status_code, 404)
        self.assertEqual(c.post(f"/api/events/{mine.id}/going").status_code, 404)

    def test_the_calendar_only_kinds_are_not_events_to_show_here(self):
        self.make("Payment run", kind="PAYOUT_RUN")
        self.make("Department meeting", kind="MEETING")
        self.make("Reminder", kind="OTHER")
        self.assertEqual(self.titles(self.asha), ["Reminder"])

    def test_the_office_only_kind_of_audience_is_not_seen_by_faculty(self):
        self.make("Office only", visibility="OFFICE")
        self.assertEqual(self.titles(self.asha), [])
        self.assertEqual(self.titles(self.office), ["Office only"])


class ListingTests(EventsHubBase):
    def setUp(self):
        super().setUp()
        self.make("Next week workshop", kind="WORKSHOP", starts_on=timezone.localdate() + timedelta(days=9))
        self.make("Tomorrow seminar", starts_on=timezone.localdate() + timedelta(days=1), venue="Seminar Hall 2")
        self.make("Yesterday seminar", starts_on=timezone.localdate() - timedelta(days=1))
        self.make("Last month conference", kind="CONFERENCE", starts_on=timezone.localdate() - timedelta(days=40))
        self.make(
            "Running conference", kind="CONFERENCE",
            starts_on=timezone.localdate() - timedelta(days=1), ends_on=timezone.localdate() + timedelta(days=2),
        )
        self.make("Paper call", kind="CALL_FOR_PAPERS", starts_on=timezone.localdate() + timedelta(days=12), speaker="")

    def test_upcoming_is_the_default_soonest_first_and_keeps_what_is_still_running(self):
        self.assertEqual(
            self.titles(self.asha),
            ["Running conference", "Tomorrow seminar", "Next week workshop", "Paper call"],
        )

    def test_past_is_newest_first(self):
        self.assertEqual(self.titles(self.asha, when="past"), ["Yesterday seminar", "Last month conference"])

    def test_week_is_the_next_seven_days_including_what_is_running(self):
        self.assertEqual(self.titles(self.asha, when="week"), ["Running conference", "Tomorrow seminar"])

    def test_month_is_whatever_touches_this_calendar_month(self):
        today = timezone.localdate()
        first = today.replace(day=1)
        last = (first + timedelta(days=32)).replace(day=1) - timedelta(days=1)
        touching = [
            e.title for e in CalendarEvent.objects.all()
            if e.starts_on <= last and (e.ends_on or e.starts_on) >= first
        ]
        self.assertTrue(touching)  # the fixtures are not all in other months
        self.assertEqual(sorted(self.titles(self.asha, when="month")), sorted(touching))

    def test_kind_department_and_search_narrow_it(self):
        self.assertEqual(self.titles(self.asha, kind="CONFERENCE"), ["Running conference"])
        self.assertEqual(self.titles(self.asha, q="hall"), ["Tomorrow seminar"])  # venue is searched too
        self.make("ECE guest lecture", visibility="DEPARTMENT", department="ECE", organiser="IEEE chapter")
        self.assertEqual(self.titles(self.asha, department="ece"), ["ECE guest lecture"])
        self.assertEqual(self.titles(self.asha, q="ieee"), ["ECE guest lecture"])

    def test_limit_is_respected_and_a_bad_value_is_refused(self):
        self.assertEqual(len(self.titles(self.asha, limit=2)), 2)
        self.assertEqual(self.listing(self.asha, when="someday").status_code, 400)

    def test_counts_by_kind_ignore_the_kind_filter_so_the_chips_can_show_them(self):
        r = self.listing(self.asha, kind="WORKSHOP").json()
        self.assertEqual(r["counts"], {"CONFERENCE": 1, "SEMINAR": 1, "WORKSHOP": 1, "CALL_FOR_PAPERS": 1})
        self.assertEqual([k["key"] for k in r["kinds"]], ["SEMINAR", "WORKSHOP", "CONFERENCE", "FDP", "CALL_FOR_PAPERS", "OTHER"])

    def test_seminars_so_far_this_year_counts_finished_ones_the_reader_may_see(self):
        today = timezone.localdate()
        past_this_year = [
            e for e in CalendarEvent.objects.filter(kind="SEMINAR")
            if e.starts_on.year == today.year and (e.ends_on or e.starts_on) < today
        ]
        self.assertEqual(self.listing(self.asha).json()["seminars_this_year"], len(past_this_year))

    def test_the_departments_to_choose_from_come_from_the_people(self):
        self.assertEqual(self.listing(self.asha).json()["departments"], ["CSE", "ECE"])


class ChangingAndRemovingTests(EventsHubBase):
    def test_the_creator_and_the_office_may_edit_or_remove_nobody_else(self):
        eid = self.post(self.asha).json()["id"]
        body = {"title": "Renamed seminar", "kind": "SEMINAR", "starts_on": day(4), "venue": "Room 5"}

        def patch(user):
            return self.client_for(user).patch(f"/api/events/{eid}", data=json.dumps(body), content_type="application/json")

        self.assertEqual(patch(self.ravi).status_code, 403)
        r = patch(self.asha)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()["title"], r.json()["venue"], r.json()["visibility"]), ("Renamed seminar", "Room 5", "DEPARTMENT"))
        self.assertEqual(patch(self.office).status_code, 200)
        self.assertEqual(self.client_for(self.ravi).delete(f"/api/events/{eid}").status_code, 403)
        self.assertEqual(self.client_for(self.asha).delete(f"/api/events/{eid}").status_code, 200)
        self.assertFalse(CalendarEvent.objects.filter(pk=eid).exists())

    def test_can_edit_is_true_only_for_the_creator_and_the_office(self):
        self.post(self.asha)
        flags = {u.name: self.listing(u).json()["results"][0]["can_edit"] for u in (self.asha, self.ravi, self.office)}
        self.assertEqual(flags, {"Asha Menon": True, "Ravi Kumar": False, "Office": True})


class GoingTests(EventsHubBase):
    def test_going_toggles_and_counts_people_once(self):
        e = self.make("Open seminar")
        a, r = self.client_for(self.asha), self.client_for(self.ravi)
        first = a.post(f"/api/events/{e.id}/going")
        self.assertEqual((first.status_code, first.json()), (200, {"going": True, "going_count": 1}))
        self.assertEqual(a.post(f"/api/events/{e.id}/going").json()["going_count"], 1)  # pressing twice is not twice
        self.assertEqual(r.post(f"/api/events/{e.id}/going").json()["going_count"], 2)
        listed = self.listing(self.asha).json()["results"][0]
        self.assertEqual((listed["going"], listed["going_count"]), (True, 2))
        self.assertEqual(self.listing(self.meera).json()["results"][0]["going"], False)
        gone = a.delete(f"/api/events/{e.id}/going")
        self.assertEqual(gone.json(), {"going": False, "going_count": 1})
        self.assertEqual(a.delete(f"/api/events/{e.id}/going").json()["going_count"], 1)  # leaving twice is fine
        self.assertEqual(EventRsvp.objects.filter(event=e).count(), 1)

    def test_one_row_per_person_per_event_is_enforced_by_the_database(self):
        from django.db import IntegrityError, transaction

        e = self.make("Open seminar")
        EventRsvp.objects.create(event=e, user=self.asha)
        with self.assertRaises(IntegrityError), transaction.atomic():
            EventRsvp.objects.create(event=e, user=self.asha)

    def test_you_cannot_say_you_are_going_to_what_you_cannot_see_or_what_is_over(self):
        hidden = self.make("ECE only", visibility="DEPARTMENT", department="ECE")
        over = self.make("Done seminar", starts_on=timezone.localdate() - timedelta(days=3))
        c = self.client_for(self.meera)
        self.assertEqual(c.post(f"/api/events/{hidden.id}/going").status_code, 404)
        self.assertEqual(self.client_for(self.asha).post(f"/api/events/{over.id}/going").status_code, 400)

    def test_going_goes_when_the_event_does(self):
        e = self.make("Open seminar")
        EventRsvp.objects.create(event=e, user=self.asha)
        e.delete()
        self.assertEqual(EventRsvp.objects.count(), 0)


class SingleEventIcsTests(EventsHubBase):
    def test_it_is_a_valid_one_event_calendar_with_the_place_and_the_speaker(self):
        e = self.make(
            "Power electronics; the next decade, in brief", starts_at=time(15, 0), ends_at=time(16, 30),
            venue="Seminar Hall 2, Block A", speaker="Dr Leela Nair", organiser="IEEE student chapter",
            link="https://example.org/register", description="Open to all.\nBring a laptop.",
        )
        r = self.client_for(self.asha).get(f"/api/events/{e.id}.ics")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r["Content-Type"].startswith("text/calendar"))
        self.assertIn("attachment", r["Content-Disposition"])
        self.assertIn(".ics", r["Content-Disposition"])
        body = r.content.decode("utf-8")
        self.assertTrue(body.startswith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))
        self.assertTrue(body.endswith("END:VCALENDAR\r\n"))
        self.assertEqual(body.count("BEGIN:VEVENT"), 1)
        self.assertEqual(body.count("END:VEVENT"), 1)
        for line in body.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75, line)
        unfolded = body.replace("\r\n ", "")
        self.assertIn(f"UID:event-{e.id}@", unfolded)
        self.assertIn("SUMMARY:Power electronics\\; the next decade\\, in brief", unfolded)
        self.assertIn("LOCATION:Seminar Hall 2\\, Block A", unfolded)
        self.assertIn("URL:https://example.org/register", unfolded)
        self.assertIn("Speaker: Dr Leela Nair", unfolded)
        self.assertIn("Organised by: IEEE student chapter", unfolded)
        self.assertIn("DTSTART:", unfolded)
        self.assertIn("DTEND:", unfolded)
        self.assertNotIn("\n", body.replace("\r\n", ""))  # CRLF only

    def test_an_all_day_event_uses_dates_not_times(self):
        e = self.make("Call for papers closes", kind="CALL_FOR_PAPERS")
        body = self.client_for(self.asha).get(f"/api/events/{e.id}.ics").content.decode()
        self.assertIn("DTSTART;VALUE=DATE:", body)

    def test_it_is_only_for_somebody_who_may_see_the_event_and_signed_in(self):
        e = self.make("ECE only", visibility="DEPARTMENT", department="ECE")
        self.assertEqual(self.client_for(self.meera).get(f"/api/events/{e.id}.ics").status_code, 404)
        self.assertEqual(Client().get(f"/api/events/{e.id}.ics").status_code, 401)
        self.assertEqual(self.client_for(self.asha).get("/api/events/nonesuch.ics").status_code, 404)


class SummaryTests(EventsHubBase):
    def test_the_shape_is_this_week_next_the_first_three_and_counts_by_kind(self):
        for i in range(5):
            self.make(f"This week {i}", starts_on=timezone.localdate() + timedelta(days=i))
        self.make("Later workshop", kind="WORKSHOP", starts_on=timezone.localdate() + timedelta(days=20))
        r = self.client_for(self.asha).get("/api/events/summary")
        self.assertEqual(r.status_code, 200, r.content)
        s = r.json()
        self.assertEqual(set(s), {"today", "this_week", "this_week_count", "next", "upcoming", "counts", "total"})
        self.assertEqual([e["title"] for e in s["this_week"]], ["This week 0", "This week 1", "This week 2"])
        self.assertEqual(s["this_week_count"], 5)
        self.assertEqual(s["next"]["title"], "This week 0")
        self.assertEqual([e["title"] for e in s["upcoming"]], ["This week 0", "This week 1", "This week 2"])
        self.assertEqual(s["counts"], {"SEMINAR": 5, "WORKSHOP": 1})
        self.assertEqual(s["total"], 6)
        self.assertEqual(s["today"], timezone.localdate().isoformat())

    def test_with_nothing_coming_it_says_so_with_empty_values_not_errors(self):
        s = self.client_for(self.asha).get("/api/events/summary").json()
        self.assertEqual((s["this_week"], s["next"], s["upcoming"], s["counts"], s["total"]), ([], None, [], {}, 0))

    def test_it_follows_the_same_visibility_and_carries_my_going_flag(self):
        self.make("ECE only", visibility="DEPARTMENT", department="ECE")
        e = self.make("Open seminar")
        EventRsvp.objects.create(event=e, user=self.asha)
        asha = self.client_for(self.asha).get("/api/events/summary").json()
        meera = self.client_for(self.meera).get("/api/events/summary").json()
        self.assertEqual(asha["total"], 2)
        self.assertEqual([x["title"] for x in meera["upcoming"]], ["Open seminar"])
        going = {x["title"]: x["going"] for x in asha["upcoming"]}
        self.assertEqual(going["Open seminar"], True)


class TellingPeopleTests(EventsHubBase):
    def told(self, **where):
        return set(Notification.objects.filter(kind="event", **where).values_list("user__email", flat=True))

    def test_a_department_event_tells_the_department_but_not_the_person_who_posted_it(self):
        self.post(self.asha, venue="Seminar Hall 2", starts_at="15:00")
        self.assertEqual(self.told(), {"eh-ravi@x.edu", "eh-head@x.edu"})
        note = Notification.objects.get(kind="event", user=self.ravi)
        self.assertIn("Seminar on power electronics", note.title)
        self.assertIn("Seminar Hall 2", note.body)
        self.assertEqual(note.href, f"/events?event={CalendarEvent.objects.get().id}")

    def test_a_college_wide_event_tells_everyone_with_an_account_once(self):
        self.post(self.principal, visibility="PUBLIC")
        self.assertEqual(
            self.told(),
            {u.email for u in User.objects.filter(active=True).exclude(pk=self.principal.pk)},
        )

    def test_a_person_who_switched_these_off_is_not_told(self):
        from core.models import NotificationPreference

        NotificationPreference.objects.create(user=self.ravi, kind="event", level="off")
        self.post(self.asha)
        self.assertEqual(self.told(), {"eh-head@x.edu"})

    def test_editing_does_not_tell_everyone_again(self):
        eid = self.post(self.asha).json()["id"]
        before = Notification.objects.filter(kind="event").count()
        body = {"title": "Seminar on power electronics, moved", "kind": "SEMINAR", "starts_on": day(5)}
        self.assertEqual(
            self.client_for(self.asha).patch(f"/api/events/{eid}", data=json.dumps(body), content_type="application/json").status_code, 200
        )
        self.assertEqual(Notification.objects.filter(kind="event").count(), before)

    def test_somebody_who_asked_for_email_is_still_told_in_the_app_too(self):
        from core.models import NotificationPreference

        NotificationPreference.objects.create(user=self.ravi, kind="event", level="email")
        self.post(self.asha)
        self.assertEqual(self.told(), {"eh-ravi@x.edu", "eh-head@x.edu"})

    def test_telling_a_crowd_takes_a_handful_of_queries_not_a_few_per_person(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from core.services import notify

        crowd = [
            User.objects.create_user(email=f"eh-crowd{i}@x.edu", name=f"Crowd {i}", role=Role.FACULTY, department="ECE")
            for i in range(30)
        ]
        with CaptureQueriesContext(connection) as ctx:
            told = notify.notify_many(crowd, "event", "A seminar", "Thursday", "/events")
        self.assertEqual(told, 30)
        self.assertLess(len(ctx), 8)
        self.assertEqual(Notification.objects.filter(kind="event", title="A seminar").count(), 30)

    def test_a_crowd_skips_the_people_who_switched_it_off_and_closed_accounts(self):
        from core.models import NotificationPreference
        from core.services import notify

        NotificationPreference.objects.create(user=self.ravi, kind="event", level="off")
        self.meera.active = False
        self.meera.save()
        told = notify.notify_many([self.asha, self.ravi, self.meera], "event", "A seminar")
        self.assertEqual(told, 1)
        self.assertEqual(list(Notification.objects.filter(kind="event").values_list("user__email", flat=True)), ["eh-asha@x.edu"])

    def test_the_new_kind_is_one_the_person_can_switch_off_in_settings(self):
        from core.services import notify

        self.assertIn("event", notify.KINDS)
        self.assertIn("event", notify.EMAIL_ACTIONS)
