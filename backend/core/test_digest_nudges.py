"""The weekly summary and the deadline and goal nudges.

Both jobs take `now`, so every test pins the day it runs on instead of
freezing a clock.

Weekly summary (Monday 8am IST): a person's rank movement, their department's
new publications, one suggested collaborator who is never an existing
co-author, and their open items. Nobody with nothing to say is sent one, and
nobody is sent two in a week.

Nudges (daily): "3 days left to file for this month's run" to people with
drafts, when the college has set a filing cutoff day; "one paper away from
your quota" to research faculty. At most one nudge per person per week.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from django.core import mail
from django.test import Client, TestCase, override_settings

from core.models import (
    Claim,
    ClaimStatus,
    FormulaConfig,
    Notification,
    NotificationPreference,
    Role,
    User,
)
from core.services import digest, nudges, paper_facts, standing
from core.services.remuneration import DEFAULT_AUTHOR_POINTS

IST = ZoneInfo("Asia/Kolkata")
#: A Monday, 8am IST, in the 2026-27 academic year (which began 1 June 2026).
MONDAY = datetime(2026, 9, 28, 8, 0, tzinfo=IST)


def _person(email, name, role=Role.FACULTY, dept="Mechanical", **extra):
    return User.objects.create_user(
        email=email, password=None, name=name, role=role, department=dept, **extra
    )


def _paper(owner, title, *, days_ago=30, quartile=None, status=ClaimStatus.SUBMITTED,
           journal="Journal of Heat", doi=None, published_days_ago=None, **extra):
    published = MONDAY - timedelta(days=days_ago if published_days_ago is None else published_days_ago)
    return Claim.objects.create(
        owner=owner, paper_title=title, journal_title=journal, quartile=quartile,
        status=status, doi=doi, submitted_at=MONDAY - timedelta(days=days_ago),
        publication_year=published.year, publication_date=published.date().isoformat(),
        indexing_level="Scopus", **extra,
    )


class StandingTests(TestCase):
    """The summary's rank is the leaderboard's rank (core.services.leaderboard):
    the same weighting and the same academic year, so the two never disagree.
    Movement is against the ranks the last summary went out with."""

    def setUp(self):
        paper_facts.forget()
        self.addCleanup(paper_facts.forget)

    def test_the_rank_is_the_leaderboards(self):
        a, b = _person("a@t.edu", "Asha"), _person("b@t.edu", "Bala")
        _paper(a, "One", quartile="Q1")  # 4 on the leaderboard
        _paper(b, "Two", quartile="Q2")  # 3
        _paper(b, "Three", quartile="Q4")  # 1
        place = standing.movement(MONDAY)
        self.assertEqual(place[b.id]["rank"], 1)
        self.assertEqual(place[b.id]["score"], 4)
        self.assertEqual(place[a.id]["rank"], 1)  # joint
        self.assertEqual(place[a.id]["of"], 2)

    def test_nobody_with_nothing_this_year_is_ranked(self):
        a = _person("a@t.edu", "Asha")
        _paper(a, "Draft", status=ClaimStatus.DRAFT)
        _paper(a, "Back", status=ClaimStatus.REJECTED)
        _paper(a, "Old", published_days_ago=200)  # before 1 June
        self.assertNotIn(a.id, standing.movement(MONDAY))

    def test_movement_is_against_last_weeks_summary(self):
        a, b, c = (_person(f"{n}@t.edu", n) for n in ("a", "b", "c"))
        _paper(a, "A1", quartile="Q1")
        _paper(b, "B1", quartile="Q2")
        _paper(c, "C1", quartile="Q4")
        last_monday = MONDAY - timedelta(days=7)
        standing.remember(last_monday, standing.movement(last_monday))
        # This week c files two Q1 papers and goes from third to first.
        _paper(c, "C2", quartile="Q1")
        _paper(c, "C3", quartile="Q1")
        paper_facts.forget()
        move = standing.movement(MONDAY)
        self.assertEqual(move[c.id], {"rank": 1, "was": 3, "of": 3, "score": 9})
        self.assertEqual((move[a.id]["rank"], move[a.id]["was"]), (2, 1))

    def test_a_second_run_in_the_same_week_still_compares_with_last_week(self):
        a = _person("a@t.edu", "Asha")
        _paper(a, "A1", quartile="Q1")
        standing.remember(MONDAY - timedelta(days=7), {a.id: {"rank": 4}})
        standing.remember(MONDAY, standing.movement(MONDAY))
        self.assertEqual(standing.movement(MONDAY)[a.id]["was"], 4)

    def test_the_sentence(self):
        self.assertEqual(
            standing.sentence({"rank": 3, "was": 5, "of": 40}),
            "You are 3rd of 40 this academic year, up 2 places since last week.",
        )
        self.assertEqual(
            standing.sentence({"rank": 3, "was": None, "of": 40}),
            "You are 3rd of 40 this academic year.",
        )


class DigestBase(TestCase):
    def setUp(self):
        paper_facts.forget()
        self.addCleanup(paper_facts.forget)
        FormulaConfig.objects.create(author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True)
        self.me = _person("me@t.edu", "Asha Menon")
        self.colleague = _person("col@t.edu", "Ravi Kumar")
        self.coauthor = _person("co@t.edu", "Meera Pillai", dept="Civil")
        self.stranger = _person("str@t.edu", "Kiran Rao", dept="Civil")
        self.named = _person("named@t.edu", "Latha Iyer", dept="Civil")
        # My papers: one with Meera (she filed the same DOI), one naming Latha.
        _paper(self.me, "Mine One", doi="10.1/one", journal="Journal of Heat", days_ago=20,
               remuneration=48213.0)
        _paper(self.coauthor, "Mine One", doi="10.1/one", journal="Journal of Heat", days_ago=20)
        _paper(self.me, "Mine Two", journal="Energy Letters", days_ago=20,
               authors_json=json.dumps(["Asha Menon", "Latha Iyer"]))
        _paper(self.named, "Latha's", journal="Energy Letters", days_ago=25)
        # Kiran publishes where I publish and has never written with me.
        _paper(self.stranger, "Kiran's", journal="Journal of Heat", days_ago=25)
        # My department this week, and last month.
        _paper(self.colleague, "Ravi This Week", days_ago=2, journal="Thermal Science")
        _paper(self.colleague, "Ravi Last Month", days_ago=30, journal="Thermal Science")
        # Open items.
        _paper(self.me, "My Draft", status=ClaimStatus.DRAFT, days_ago=5)
        _paper(self.me, "Sent Back", status=ClaimStatus.REJECTED, days_ago=9,
               status_note="Attach the published version")


class DigestContentTests(DigestBase):
    def test_the_summary_has_the_four_parts(self):
        d = digest.build_for(self.me, MONDAY)
        self.assertEqual(d["standing"]["rank"], 1)
        self.assertEqual([p["title"] for p in d["department"]["papers"]], ["Ravi This Week"])
        self.assertEqual(d["department"]["papers"][0]["person"], "Ravi Kumar")
        self.assertEqual(d["collaborator"]["name"], "Kiran Rao")
        self.assertIn("Journal of Heat", d["collaborator"]["why"])
        titles = {i["title"]: i for i in d["open_items"]}
        self.assertEqual(set(titles), {"My Draft", "Sent Back"})
        self.assertEqual(titles["Sent Back"]["reason"], "Attach the published version")

    def test_never_suggests_a_co_author_by_filing_or_by_name(self):
        # Every candidate, not only this week's pick: the pick rotates, so a
        # co-author who merely lost this week's rotation would slip through.
        ctx = digest.context(MONDAY)
        names = [c[2] for c in digest.collaborator_candidates(self.me, ctx)]
        self.assertEqual(names, ["Kiran Rao"])
        # And from the other side: Latha named me on nothing, but I named her.
        latha = [c[2] for c in digest.collaborator_candidates(self.named, ctx)]
        self.assertNotIn("Asha Menon", latha)

    def test_carries_no_money(self):
        text = json.dumps(digest.build_for(self.me, MONDAY))
        self.assertNotIn("48213", text)
        for key in ('"remuneration"', '"amount"', '"owner_id"', '"status"'):
            self.assertNotIn(key, text)

    def test_the_preview_endpoint_is_the_same_summary(self):
        c = Client()
        c.force_login(self.me)
        body = c.get("/api/notifications/digest").json()
        self.assertTrue(body["eligible"])
        self.assertIn("standing", body)

    def test_staff_have_no_summary(self):
        office = _person("o@t.edu", "Office", role=Role.SUPER_ADMIN, dept=None)
        c = Client()
        c.force_login(office)
        self.assertFalse(c.get("/api/notifications/digest").json()["eligible"])


@override_settings(EMAIL_HOST="smtp.test", APP_BASE_URL="https://app.test")
class DigestSendTests(DigestBase):
    def test_sends_one_per_person_with_something_to_say_in_app_and_by_email(self):
        quiet = _person("quiet@t.edu", "Quiet One", dept="Nowhere")
        summary = digest.send_weekly_digest(now=MONDAY)
        mine = Notification.objects.get(user=self.me, kind="digest")
        self.assertEqual(mine.href, "/notifications?tab=week")
        self.assertFalse(Notification.objects.filter(user=quiet).exists())
        emails = [m for m in mail.outbox if m.to == [self.me.email]]
        self.assertEqual(len(emails), 1)
        html = emails[0].alternatives[0][0]
        for text in ("Saveetha Engineering College", "Ravi This Week", "Kiran Rao", "My Draft",
                     "/api/notifications/unsubscribe/"):
            self.assertIn(text, html)
        self.assertGreaterEqual(summary["sent"], 1)

    def test_a_second_run_the_same_week_sends_nothing(self):
        digest.send_weekly_digest(now=MONDAY)
        mail.outbox.clear()
        digest.send_weekly_digest(now=MONDAY + timedelta(hours=3))
        self.assertEqual(Notification.objects.filter(user=self.me, kind="digest").count(), 1)
        self.assertEqual(len(mail.outbox), 0)

    def test_switched_off_means_none(self):
        NotificationPreference.objects.create(user=self.me, kind="digest", level="off")
        digest.send_weekly_digest(now=MONDAY)
        self.assertFalse(Notification.objects.filter(user=self.me, kind="digest").exists())

    def test_staff_and_inactive_accounts_get_none(self):
        _person("o@t.edu", "Office", role=Role.SUPER_ADMIN, dept="Mechanical")
        gone = _person("gone@t.edu", "Gone", active=False)
        _paper(gone, "Gone's paper")
        digest.send_weekly_digest(now=MONDAY)
        roles = set(Notification.objects.filter(kind="digest").values_list("user__role", flat=True))
        self.assertEqual(roles, {Role.FACULTY})
        self.assertFalse(Notification.objects.filter(user=gone).exists())


class NudgeTests(TestCase):
    def setUp(self):
        self.policy = FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True, filing_cutoff_day=25,
        )
        self.drafter = _person("d@t.edu", "Has Draft")
        _paper(self.drafter, "Unfinished", status=ClaimStatus.DRAFT)
        self.clean = _person("c@t.edu", "No Draft")
        _paper(self.clean, "Filed")

    def _day(self, d):
        return datetime(2026, 9, d, 9, 0, tzinfo=IST)

    def test_three_days_before_the_cutoff_people_with_drafts_are_reminded(self):
        summary = nudges.send_nudges(now=self._day(22))
        note = Notification.objects.get(user=self.drafter)
        self.assertEqual(note.kind, "nudge_cutoff")
        self.assertIn("3 days left", note.title)
        self.assertIn("25 September", note.body)
        self.assertFalse(Notification.objects.filter(user=self.clean).exists())
        self.assertEqual(summary["cutoff"], 1)

    def test_not_a_week_early_and_not_after_the_cutoff(self):
        nudges.send_nudges(now=self._day(15))
        nudges.send_nudges(now=self._day(26))
        self.assertFalse(Notification.objects.exists())

    def test_no_cutoff_set_means_no_deadline_reminder(self):
        FormulaConfig.objects.update(filing_cutoff_day=None)
        nudges.send_nudges(now=self._day(22))
        self.assertFalse(Notification.objects.exists())

    def test_a_missed_day_is_caught_up_once(self):
        nudges.send_nudges(now=self._day(23))  # two days left
        nudges.send_nudges(now=self._day(24))
        self.assertEqual(Notification.objects.filter(user=self.drafter).count(), 1)
        self.assertIn("2 days left", Notification.objects.get(user=self.drafter).title)

    def test_one_paper_from_quota(self):
        r = _person("r@t.edu", "Research Person", faculty_type="RESEARCH", research_quota=3)
        _paper(r, "Q one", quota_position=1)
        _paper(r, "Q two", quota_position=2)
        regular = _person("reg@t.edu", "Regular")
        _paper(regular, "R one", quota_position=None)
        FormulaConfig.objects.update(filing_cutoff_day=None)
        summary = nudges.send_nudges(now=self._day(10))
        note = Notification.objects.get(user=r)
        self.assertEqual(note.kind, "nudge_quota")
        self.assertEqual(note.title, "One paper away from your research quota")
        self.assertIn("2 of the 3", note.body)
        self.assertEqual(summary["quota"], 1)

    def test_quota_already_met_or_far_off_is_not_nudged(self):
        met = _person("m@t.edu", "Met", faculty_type="RESEARCH", research_quota=1)
        _paper(met, "Done", quota_position=1)
        far = _person("f@t.edu", "Far", faculty_type="RESEARCH", research_quota=5)
        _paper(far, "Start", quota_position=1)
        FormulaConfig.objects.update(filing_cutoff_day=None)
        nudges.send_nudges(now=self._day(10))
        self.assertFalse(Notification.objects.exists())

    def test_at_most_one_nudge_a_week(self):
        both = _person("b@t.edu", "Both", faculty_type="RESEARCH", research_quota=2)
        _paper(both, "Q one", quota_position=1)
        _paper(both, "Draft", status=ClaimStatus.DRAFT)
        nudges.send_nudges(now=self._day(22))
        self.assertEqual(Notification.objects.filter(user=both).count(), 1)
        self.assertEqual(Notification.objects.get(user=both).kind, "nudge_cutoff")
        nudges.send_nudges(now=self._day(27))  # five days later: still the same week
        self.assertEqual(Notification.objects.filter(user=both).count(), 1)
        nudges.send_nudges(now=self._day(30))  # eight days later
        self.assertEqual(
            list(Notification.objects.filter(user=both).order_by("created_at").values_list("kind", flat=True)),
            ["nudge_cutoff", "nudge_quota"],
        )

    def test_the_quota_nudge_is_not_repeated_for_the_same_count(self):
        r = _person("r@t.edu", "R", faculty_type="RESEARCH", research_quota=2)
        _paper(r, "Q one", quota_position=1)
        FormulaConfig.objects.update(filing_cutoff_day=None)
        nudges.send_nudges(now=self._day(1))
        nudges.send_nudges(now=self._day(20))
        self.assertEqual(Notification.objects.filter(user=r).count(), 1)


class PolicyCutoffTests(TestCase):
    def setUp(self):
        self.admin = _person("a@t.edu", "Admin", role=Role.SUPER_ADMIN, dept=None)
        self.c = Client()
        self.c.force_login(self.admin)
        FormulaConfig.objects.create(author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True)

    def _put(self, day):
        body = {"snip_multiplier": 55000, "qf_q1": 50000, "qf_q2": 30000, "qf_q3": 15000,
                "qf_q4": 7000, "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS),
                "filing_cutoff_day": day}
        return self.c.put("/api/admin/formula", data=json.dumps(body), content_type="application/json")

    def test_the_cutoff_day_is_a_policy_setting(self):
        self.assertIsNone(self.c.get("/api/admin/formula").json()["filing_cutoff_day"])
        self.assertEqual(self._put(25).status_code, 200)
        self.assertEqual(self.c.get("/api/admin/formula").json()["filing_cutoff_day"], 25)
        self.assertEqual(self._put(None).status_code, 200)
        self.assertIsNone(self.c.get("/api/admin/formula").json()["filing_cutoff_day"])

    def test_a_client_that_leaves_it_out_does_not_clear_it(self):
        self._put(20)
        body = {"snip_multiplier": 55000, "qf_q1": 50000, "qf_q2": 30000, "qf_q3": 15000,
                "qf_q4": 7000, "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS)}
        r = self.c.put("/api/admin/formula", data=json.dumps(body), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.c.get("/api/admin/formula").json()["filing_cutoff_day"], 20)

    def test_only_days_every_month_has(self):
        self.assertEqual(self._put(29).status_code, 400)
        self.assertEqual(self._put(0).status_code, 400)


class ScheduleTests(TestCase):
    def test_the_three_jobs_are_scheduled_by_migration(self):
        from django_q.models import Schedule

        from core import tasks

        jobs = {s.name: s for s in Schedule.objects.filter(
            name__in=("citation-check", "weekly-digest", "daily-nudges"))}
        self.assertEqual(set(jobs), {"citation-check", "weekly-digest", "daily-nudges"})
        self.assertEqual(jobs["weekly-digest"].schedule_type, Schedule.WEEKLY)
        first = jobs["weekly-digest"].next_run.astimezone(IST)
        self.assertEqual((first.weekday(), first.hour, first.minute), (0, 8, 0))
        self.assertEqual(jobs["citation-check"].schedule_type, Schedule.DAILY)
        self.assertEqual(jobs["daily-nudges"].schedule_type, Schedule.DAILY)
        for s in jobs.values():
            name = s.func.removeprefix("core.tasks.")
            self.assertTrue(callable(getattr(tasks, name)), s.func)
