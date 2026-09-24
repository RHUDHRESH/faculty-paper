"""Badges, celebrations, goals, the impact card and the wall of fame.

Five features that reward work people have already done, and one rule over
all of them: **only real achievements, computed from real records, and never
a rupee on anything somebody else can see.**

What counts as a paper here is decided once, in `core.services.records`:

- a claim the college has *recognised* -- authorised for payment, or paid.
  Earlier stages are not recognised: to a claimant every one of them reads
  "Under review", so a badge arriving at the Principal's approval would tell
  them which desk their paper had just passed.
- a row of the paid ledger with no claim behind it, matched to its person by
  staff id -- the same rule `/api/me/payments` uses. Almost all the history
  (2024 onwards, imported from the accounts workbook) lives only there.

The amount on a ledger row is never read; a zero-amount row is a paper all
the same.
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from io import BytesIO

from django.test import Client, TestCase
from django.utils import timezone

from core.hod import MONEY_KEYS
from core.models import (
    Badge,
    Celebration,
    Claim,
    ClaimStatus,
    DepartmentMilestone,
    DepartmentTarget,
    ImpactShare,
    Notification,
    PaidLedger,
    ResearchGoal,
    Role,
    User,
    WallPin,
)
from core.services import achievements, records
from core.services.normalize import normalize_title

TODAY = date(2026, 9, 24)


def _person(email, name, department, role=Role.FACULTY, **extra):
    return User.objects.create_user(
        email=email, password="pass", name=name, role=role, department=department, **extra
    )


def _claim(owner, title, *, status=ClaimStatus.PAID, quartile=None, year=2026,
           position=2, journal="Journal of Tests", on=date(2026, 3, 1), raw=None, doi=None):
    """A claim at `status`, recognised on `on` when it got that far."""
    paid = status == ClaimStatus.PAID
    moment = timezone.make_aware(datetime(on.year, on.month, on.day, 10, 0))
    return Claim.objects.create(
        owner=owner,
        status=status,
        paper_title=title,
        normalized_title=normalize_title(title),
        journal_title=journal,
        quartile=quartile,
        publication_year=year,
        author_position=position,
        total_authors=4,
        doi=doi,
        submitted_at=moment - timedelta(days=20),
        payout_month=on if paid else None,
        paid_at=moment if paid else None,
        director_approved_at=moment if status == ClaimStatus.DIRECTOR_APPROVED else None,
        remuneration=12345.67,
        scopus_raw_json=json.dumps(raw) if raw is not None else None,
    )


def _ledger(person, title, *, month=date(2025, 1, 1), quartile="Q3",
            published="2024-11-02 00:00:00", journal="Ledger Journal", amount=5432.1,
            staff_id=None, author_position=None):
    raw = {
        "SJR Quartile": quartile,
        "Publication Date": published,
        "Source Title": journal,
        "Amount": str(amount),
    }
    if author_position is not None:
        raw["Author Position"] = str(author_position)
    return PaidLedger.objects.create(
        payout_month=month,
        department=person.department if person else "ECE",
        faculty_name=person.name if person else "Somebody Who Left",
        staff_id=staff_id if staff_id is not None else (person.staff_id if person else "GONE1"),
        paper_title=title,
        journal_title=journal,
        amount=amount,
        raw_json=json.dumps(raw),
    )


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


def _kinds(user) -> set[str]:
    return set(Badge.objects.filter(user=user).values_list("key", flat=True))


# ---------------------------------------------------------------------------
# What counts as a paper
# ---------------------------------------------------------------------------


class PaperRecordTests(TestCase):
    def setUp(self):
        self.asha = _person("asha@t.edu", "Asha", "CSE", staff_id="TSCS001")

    def test_only_recognised_claims_count(self):
        _claim(self.asha, "Paid paper", status=ClaimStatus.PAID)
        _claim(self.asha, "Authorised paper", status=ClaimStatus.DIRECTOR_APPROVED)
        for status in (ClaimStatus.DRAFT, ClaimStatus.SUBMITTED, ClaimStatus.CLEARED,
                        ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.REJECTED):
            _claim(self.asha, f"Not yet {status}", status=status)

        titles = {r.title for r in records.paper_records([self.asha])[self.asha.id]}
        self.assertEqual(titles, {"Paid paper", "Authorised paper"})

    def test_ledger_rows_without_a_claim_are_matched_by_staff_id_whatever_the_case(self):
        _ledger(self.asha, "Old paper", staff_id="tscs001")
        _ledger(None, "Somebody else's paper", staff_id="TSCS999")

        mine = records.paper_records([self.asha])[self.asha.id]
        self.assertEqual([r.title for r in mine], ["Old paper"])
        self.assertEqual(mine[0].quartile, "Q3")
        self.assertEqual(mine[0].year, 2024)
        self.assertEqual(mine[0].on, date(2025, 1, 1))

    def test_a_zero_amount_ledger_row_is_still_a_paper(self):
        _ledger(self.asha, "Unpaid but recorded", amount=0.0)
        self.assertEqual(len(records.paper_records([self.asha])[self.asha.id]), 1)

    def test_excel_serial_publication_dates_are_read(self):
        # 45366 days after 1899-12-30 is 15 March 2024.
        _ledger(self.asha, "Serial date paper", published="45366.0")
        self.assertEqual(records.paper_records([self.asha])[self.asha.id][0].year, 2024)

    def test_an_unreadable_publication_date_falls_back_to_the_payout_year(self):
        _ledger(self.asha, "No date", published="-", month=date(2025, 5, 1))
        self.assertEqual(records.paper_records([self.asha])[self.asha.id][0].year, 2025)

    def test_quartiles_outside_q1_to_q4_are_not_quartiles(self):
        for i, q in enumerate(("Others", "No Quartile", "-", "Q5", None)):
            _ledger(self.asha, f"Paper {i}", quartile=q)
        self.assertEqual(
            {r.quartile for r in records.paper_records([self.asha])[self.asha.id]}, {None}
        )

    def test_the_same_paper_from_claim_and_ledger_is_one_paper(self):
        claim = _claim(self.asha, "Twice Recorded: A Study", quartile="Q1")
        # The claim's own ledger row, and an ERP row for the same paper.
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 3, 1), staff_id="TSCS001",
            paper_title="Twice Recorded: A Study", amount=1.0,
        )
        _ledger(self.asha, "twice recorded a study")

        mine = records.paper_records([self.asha])[self.asha.id]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0].claim_id, claim.id)

    def test_records_carry_no_money(self):
        _claim(self.asha, "Paid paper")
        _ledger(self.asha, "Old paper")
        for record in records.paper_records([self.asha])[self.asha.id]:
            fields = set(vars(record))
            self.assertEqual(fields & MONEY_KEYS, set(), fields)
            self.assertNotIn("12345.67", repr(record))
            self.assertNotIn("5432.1", repr(record))


# ---------------------------------------------------------------------------
# The badge rules
# ---------------------------------------------------------------------------


class BadgeRuleTests(TestCase):
    def setUp(self):
        self.asha = _person("asha@t.edu", "Asha", "CSE", staff_id="TSCS001")

    def award(self, users=None):
        return achievements.award_badges(users, today=TODAY)

    def test_first_paper_is_the_earliest_recognised_one(self):
        _claim(self.asha, "Later", on=date(2026, 5, 1))
        _ledger(self.asha, "Earlier", month=date(2024, 2, 1))
        self.award()

        badge = Badge.objects.get(user=self.asha, key="FIRST_PAPER")
        self.assertEqual(badge.evidence_title, "Earlier")
        self.assertEqual(badge.earned_on, date(2024, 2, 1))

    def test_nothing_recognised_means_no_badges(self):
        _claim(self.asha, "Waiting", status=ClaimStatus.SUBMITTED, quartile="Q1", position=1)
        self.award()
        self.assertEqual(_kinds(self.asha), set())

    def test_first_q1(self):
        _ledger(self.asha, "Q3 paper", quartile="Q3", month=date(2024, 1, 1))
        _ledger(self.asha, "Q1 paper", quartile="Q1", month=date(2024, 6, 1))
        self.award()
        self.assertEqual(Badge.objects.get(user=self.asha, key="FIRST_Q1").evidence_title, "Q1 paper")

    def test_paper_count_milestones_name_the_paper_that_reached_them(self):
        for i in range(10):
            _ledger(self.asha, f"Paper {i:02d}", month=date(2024, 1 + i, 1))
        self.award()

        self.assertTrue({"PAPERS_5", "PAPERS_10"} <= _kinds(self.asha))
        self.assertNotIn("PAPERS_25", _kinds(self.asha))
        self.assertEqual(Badge.objects.get(user=self.asha, key="PAPERS_5").evidence_title, "Paper 04")
        self.assertEqual(Badge.objects.get(user=self.asha, key="PAPERS_10").evidence_title, "Paper 09")

    def test_four_papers_is_not_five(self):
        for i in range(4):
            _ledger(self.asha, f"Paper {i}")
        self.award()
        self.assertNotIn("PAPERS_5", _kinds(self.asha))

    def test_first_author_from_a_claim_or_a_ledger_row_that_says_so(self):
        _claim(self.asha, "Second author", position=2)
        self.award()
        self.assertNotIn("FIRST_AUTHOR", _kinds(self.asha))

        _ledger(self.asha, "Led it", author_position=1)
        self.award()
        self.assertEqual(Badge.objects.get(user=self.asha, key="FIRST_AUTHOR").evidence_title, "Led it")

    def test_cross_department_needs_a_colleague_from_another_department(self):
        same = _person("ravi@t.edu", "Ravi", "CSE", staff_id="TSCS002")
        other = _person("meena@t.edu", "Meena", "ECE", staff_id="TSEC001")
        _ledger(self.asha, "Shared within CSE")
        _ledger(same, "Shared within CSE")
        self.award()
        self.assertNotIn("CROSS_DEPARTMENT", _kinds(self.asha))

        _ledger(self.asha, "Across the corridor")
        _claim(other, "Across the corridor")
        self.award()
        badge = Badge.objects.get(user=self.asha, key="CROSS_DEPARTMENT")
        self.assertEqual(badge.evidence_title, "Across the corridor")
        self.assertIn("ECE", badge.detail)
        self.assertIn("CROSS_DEPARTMENT", _kinds(other))

    def test_research_quota_met_only_for_research_faculty(self):
        self.asha.faculty_type = "RESEARCH"
        self.asha.research_quota = 2
        self.asha.save()
        _claim(self.asha, "One", year=2026, on=date(2026, 2, 1))
        self.award()
        self.assertNotIn("QUOTA_MET:2026", _kinds(self.asha))

        _claim(self.asha, "Two", year=2026, on=date(2026, 4, 1))
        self.award()
        badge = Badge.objects.get(user=self.asha, key="QUOTA_MET:2026")
        self.assertEqual(badge.evidence_title, "Two")

        regular = _person("reg@t.edu", "Regular", "CSE", staff_id="TSCS003")
        _claim(regular, "Reg one", year=2026)
        _claim(regular, "Reg two", year=2026)
        self.award()
        self.assertFalse(any(k.startswith("QUOTA_MET") for k in _kinds(regular)))

    def _department(self, name, n, prefix):
        return [
            _person(f"{prefix}{i}@t.edu", f"{prefix} {i}", name, staff_id=f"{prefix}{i}")
            for i in range(n)
        ]

    def test_top_ten_in_department_weights_q1_papers_most(self):
        people = self._department("MECH", 12, "m")
        # Person i has i+1 Q4 papers (1 point each); person 0 has a single Q1
        # (4 points) instead. Twelve people publish, so the top ten is a real cut.
        for i, p in enumerate(people):
            if i == 0:
                _claim(p, "The Q1", quartile="Q1", year=2025)
                continue
            for j in range(i + 1):
                _claim(p, f"{p.name} paper {j}", quartile="Q4", year=2025)
        self.award()

        winners = {u.name for u in people if "TOP10_DEPARTMENT:2025" in _kinds(u)}
        # Points: person i (i>=1) has i+1; person 0 has 4, tied with person 3.
        # Ten people have 4 or more (persons 3..11 and person 0); person 2's 3
        # points is matched or beaten by eleven, so person 2 is outside.
        self.assertEqual(winners, {"m 0"} | {f"m {i}" for i in range(3, 12)})
        self.assertIn("m 0", winners, "a Q1 paper outweighs three Q4 papers")

    def test_a_tie_straddling_tenth_place_awards_nobody_in_the_tie(self):
        people = self._department("CIVIL", 14, "c")
        # Everyone has exactly one Q4 paper: fourteen-way tie for first.
        for p in people:
            _claim(p, f"{p.name} paper", quartile="Q4", year=2025)
        self.award()
        self.assertFalse(
            any("TOP10_DEPARTMENT:2025" in _kinds(p) for p in people),
            "a fourteen-way tie is not a top ten",
        )

    def test_a_department_of_ten_or_fewer_publishers_has_no_top_ten(self):
        people = self._department("BME", 6, "b")
        for i, p in enumerate(people):
            for j in range(i + 1):
                _claim(p, f"{p.name} paper {j}", year=2025)
        self.award()
        self.assertFalse(any("TOP10_DEPARTMENT:2025" in _kinds(p) for p in people))

    def test_filing_streak_counts_consecutive_semesters(self):
        # Jan-Jun and Jul-Dec. Three in a row: H1 2024, H2 2024, H1 2025.
        _ledger(self.asha, "S1", month=date(2024, 2, 1))
        _ledger(self.asha, "S2", month=date(2024, 8, 1))
        self.award()
        self.assertNotIn("STREAK_3", _kinds(self.asha))

        _ledger(self.asha, "S3", month=date(2025, 3, 1))
        self.award()
        badge = Badge.objects.get(user=self.asha, key="STREAK_3")
        self.assertEqual(badge.evidence_title, "S3")

    def test_a_gap_semester_restarts_the_streak(self):
        _ledger(self.asha, "S1", month=date(2024, 2, 1))
        _ledger(self.asha, "S2", month=date(2024, 8, 1))
        # H1 2025 empty.
        _ledger(self.asha, "S4", month=date(2025, 8, 1))
        self.award()
        self.assertNotIn("STREAK_3", _kinds(self.asha))

    def test_first_citation_reads_scopus_citation_counts_when_there_are_any(self):
        _claim(self.asha, "Uncited", raw={"citedby-count": "0"})
        self.award()
        self.assertNotIn("FIRST_CITATION", _kinds(self.asha))

        _claim(self.asha, "Cited", raw={"citedby-count": "3"}, on=date(2026, 4, 1))
        self.award()
        self.assertEqual(Badge.objects.get(user=self.asha, key="FIRST_CITATION").evidence_title, "Cited")


# ---------------------------------------------------------------------------
# Awarding: idempotent, and loud only about what is new
# ---------------------------------------------------------------------------


class AwardingTests(TestCase):
    def setUp(self):
        self.asha = _person("asha@t.edu", "Asha", "CSE", staff_id="TSCS001")

    def test_running_twice_awards_nothing_twice(self):
        _claim(self.asha, "Fresh Q1", quartile="Q1", position=1, on=TODAY - timedelta(days=3))
        first = achievements.award_badges(today=TODAY)
        counts = (Badge.objects.count(), Celebration.objects.count(), Notification.objects.count())
        second = achievements.award_badges(today=TODAY)

        self.assertGreater(first.created, 0)
        self.assertEqual(second.created, 0)
        self.assertEqual(
            (Badge.objects.count(), Celebration.objects.count(), Notification.objects.count()),
            counts,
        )

    def test_a_fresh_badge_is_celebrated_once_and_notified(self):
        _claim(self.asha, "Fresh", on=TODAY - timedelta(days=3))
        achievements.award_badges(today=TODAY)

        badge = Badge.objects.get(user=self.asha, key="FIRST_PAPER")
        celebration = Celebration.objects.get(user=self.asha, badge=badge)
        self.assertIsNone(celebration.seen_at)
        note = Notification.objects.get(user=self.asha)
        self.assertIn("First paper", note.title)

    def test_old_badges_are_filed_quietly_with_one_summary_notification(self):
        for i in range(6):
            _ledger(self.asha, f"Old {i}", month=date(2024, 1 + i, 1), quartile="Q1")
        achievements.award_badges(today=TODAY)

        self.assertGreaterEqual(Badge.objects.filter(user=self.asha).count(), 3)
        self.assertEqual(Celebration.objects.filter(user=self.asha).count(), 0)
        self.assertEqual(Notification.objects.filter(user=self.asha).count(), 1)

    def test_a_badge_whose_evidence_is_gone_is_withdrawn(self):
        claim = _claim(self.asha, "Only paper")
        achievements.award_badges(today=TODAY)
        self.assertIn("FIRST_PAPER", _kinds(self.asha))

        claim.status = ClaimStatus.CLEARED  # the payment was voided
        claim.save()
        achievements.award_badges(today=TODAY)
        self.assertNotIn("FIRST_PAPER", _kinds(self.asha))


class StatusChangeTests(TestCase):
    """Badges arrive when a paper is authorised or paid, not at a desk before."""

    def setUp(self):
        self.asha = _person("asha@t.edu", "Asha", "CSE", staff_id="TSCS001")
        self.finance = _person("fin@t.edu", "Finance", None, Role.FINANCE)

    def move(self, claim, to_status, action):
        from core.api.journals import _transition

        with self.captureOnCommitCallbacks(execute=True):
            _transition(claim, self.finance, to_status, action)

    def test_payment_awards_and_celebrates(self):
        claim = _claim(self.asha, "Just paid", status=ClaimStatus.DIRECTOR_APPROVED,
                       on=date(2025, 1, 1))
        Badge.objects.all().delete()
        claim.payout_month = date(2025, 1, 1)  # a back-dated payout month
        claim.save()
        self.move(claim, ClaimStatus.PAID, "MARK_PAID")

        badge = Badge.objects.get(user=self.asha, key="FIRST_PAPER")
        self.assertTrue(
            Celebration.objects.filter(user=self.asha, badge=badge, seen_at__isnull=True).exists(),
            "the paper that just moved is news, however old its payout month",
        )

    def test_the_quick_path_never_withdraws_what_it_cannot_see(self):
        """After a move only the owner and co-authors are looked at. A badge
        whose evidence lies outside that view must survive it."""
        other = _person("meena@t.edu", "Meena", "ECE", staff_id="TSEC001")
        _ledger(self.asha, "Shared across departments")
        _ledger(other, "Shared across departments")
        achievements.award_badges(today=TODAY)
        self.assertIn("CROSS_DEPARTMENT", _kinds(self.asha))

        claim = _claim(self.asha, "A new paper of her own", status=ClaimStatus.DIRECTOR_APPROVED)
        self.move(claim, ClaimStatus.PAID, "MARK_PAID")
        self.assertIn("CROSS_DEPARTMENT", _kinds(self.asha))

    def test_the_principals_approval_awards_nothing(self):
        claim = _claim(self.asha, "At a desk", status=ClaimStatus.CLEARED)
        self.move(claim, ClaimStatus.PRINCIPAL_APPROVED, "PRINCIPAL_APPROVE")
        self.assertEqual(_kinds(self.asha), set())

    def test_a_failure_in_the_badge_engine_never_blocks_the_transition(self):
        claim = _claim(self.asha, "Robust", status=ClaimStatus.DIRECTOR_APPROVED)
        original = achievements.award_badges

        def broken(*a, **k):
            raise RuntimeError("boom")

        achievements.award_badges = broken
        try:
            self.move(claim, ClaimStatus.PAID, "MARK_PAID")
        finally:
            achievements.award_badges = original
        claim.refresh_from_db()
        self.assertEqual(claim.status, ClaimStatus.PAID)


# ---------------------------------------------------------------------------
# Department targets: 50, 75 and 100 per cent, celebrated once
# ---------------------------------------------------------------------------


class MilestoneTests(TestCase):
    def setUp(self):
        self.year = TODAY.year
        self.head = _person("head@t.edu", "Head", "CSE", Role.HOD)
        self.members = [_person(f"f{i}@t.edu", f"F{i}", "CSE") for i in range(3)]
        self.outsider = _person("ece@t.edu", "Ece", "ECE")
        self.principal = _person("p@t.edu", "Principal", None, Role.PRINCIPAL)
        DepartmentTarget.objects.create(
            department="CSE", year=self.year, metric="PUBLICATIONS", target=4
        )

    def file(self, n, status=ClaimStatus.SUBMITTED, owner=None):
        for i in range(n):
            _claim(owner or self.members[i % 3], f"Paper {status} {i} {Claim.objects.count()}",
                   status=status, year=self.year)

    def test_crossing_half_celebrates_every_member_and_tells_the_principal(self):
        self.file(2)
        reached = achievements.check_milestones(today=TODAY)

        self.assertEqual([m.threshold for m in reached], [50])
        cse = {self.head.id} | {m.id for m in self.members}
        self.assertEqual(set(Celebration.objects.values_list("user_id", flat=True)), cse)
        self.assertIn("halfway", Celebration.objects.first().title)
        note = Notification.objects.get(user=self.principal)
        self.assertIn("CSE", note.title)
        self.assertFalse(Celebration.objects.filter(user=self.outsider).exists())

    def test_checking_again_changes_nothing(self):
        self.file(2)
        achievements.check_milestones(today=TODAY)
        counts = (Celebration.objects.count(), Notification.objects.count())
        self.assertEqual(achievements.check_milestones(today=TODAY), [])
        self.assertEqual((Celebration.objects.count(), Notification.objects.count()), counts)

    def test_crossing_three_thresholds_at_once_celebrates_only_the_highest(self):
        self.file(4)
        reached = achievements.check_milestones(today=TODAY)
        self.assertEqual(sorted(m.threshold for m in reached), [50, 75, 100])
        self.assertEqual(Celebration.objects.filter(user=self.head).count(), 1)
        self.assertIn("reached", Celebration.objects.get(user=self.head).title)
        self.assertEqual(Notification.objects.filter(user=self.principal).count(), 1)

    def test_rejected_papers_do_not_count_towards_a_celebration(self):
        self.file(2, status=ClaimStatus.REJECTED)
        self.file(1)
        self.assertEqual(achievements.check_milestones(today=TODAY), [])

    def test_last_years_target_is_not_celebrated_now(self):
        DepartmentTarget.objects.create(department="ECE", year=self.year - 1,
                                        metric="PUBLICATIONS", target=1)
        _claim(self.outsider, "Old ECE paper", year=self.year - 1)
        self.assertEqual(achievements.check_milestones(today=TODAY), [])

    def test_a_raised_target_is_a_new_target(self):
        self.file(4)
        achievements.check_milestones(today=TODAY)
        DepartmentTarget.objects.filter(department="CSE").update(target=8)
        reached = achievements.check_milestones(today=TODAY)
        self.assertEqual([m.threshold for m in reached], [50])


# ---------------------------------------------------------------------------
# The HTTP surface
# ---------------------------------------------------------------------------


class _Api(TestCase):
    def setUp(self):
        self.client = Client()
        self.asha = _person("asha@t.edu", "Asha Menon", "CSE", staff_id="TSCS001",
                            designation="Associate Professor")
        self.ravi = _person("ravi@t.edu", "Ravi Kumar", "CSE", staff_id="TSCS002")
        self.meena = _person("meena@t.edu", "Meena Iyer", "ECE", staff_id="TSEC001")
        self.head = _person("head@t.edu", "Head of CSE", "CSE", Role.HOD, staff_id="TSCS000")
        self.ece_head = _person("ehead@t.edu", "Head of ECE", "ECE", Role.HOD)
        self.principal = _person("p@t.edu", "The Principal", None, Role.PRINCIPAL)
        self.admin = _person("a@t.edu", "Admin", None, Role.SUPER_ADMIN)

    def as_(self, user):
        self.client.force_login(user)
        return self.client

    def send(self, user, method, path, body=None):
        c = self.as_(user)
        return getattr(c, method)(path, data=json.dumps(body or {}), content_type="application/json")

    def assert_no_money(self, payload, *figures):
        self.assertEqual(_keys(payload) & MONEY_KEYS, set(), "a money key reached a shared view")
        raw = json.dumps(payload)
        for figure in ("12345.67", "5432.1", "₹", *figures):
            self.assertNotIn(figure, raw)


class BadgeApiTests(_Api):
    def setUp(self):
        super().setUp()
        self.claim = _claim(self.asha, "Asha's first", quartile="Q1", on=TODAY - timedelta(days=2))
        achievements.award_badges(today=TODAY)

    def test_the_owner_sees_their_badges_with_a_link_to_the_claim(self):
        r = self.as_(self.asha).get("/api/me/badges")
        self.assertEqual(r.status_code, 200, r.content)
        badges = {b["key"]: b for b in r.json()["badges"]}
        self.assertEqual(badges["FIRST_Q1"]["evidence"]["title"], "Asha's first")
        self.assertEqual(badges["FIRST_Q1"]["claim_id"], self.claim.id)
        self.assertTrue(r.json()["catalogue"])

    def test_a_colleague_sees_them_without_money_or_a_claim_link(self):
        r = self.as_(self.ravi).get(f"/api/users/{self.asha.id}/badges")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["badges"])
        self.assertTrue(all(b["claim_id"] is None for b in body["badges"]))
        self.assert_no_money(body)

    def test_nobody_signed_out_sees_anything(self):
        self.assertEqual(Client().get(f"/api/users/{self.asha.id}/badges").status_code, 401)


class CelebrationApiTests(_Api):
    def setUp(self):
        super().setUp()
        _claim(self.asha, "Fresh paper", on=TODAY - timedelta(days=2))
        achievements.award_badges(today=TODAY)

    def test_shown_once_then_gone(self):
        r = self.as_(self.asha).get("/api/me/celebrations")
        items = r.json()["celebrations"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["badge"]["key"], "FIRST_PAPER")
        self.assert_no_money(r.json())

        r = self.send(self.asha, "post", "/api/me/celebrations/seen", {"ids": [items[0]["id"]]})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.as_(self.asha).get("/api/me/celebrations").json()["celebrations"], [])

    def test_nobody_else_can_mark_yours_seen(self):
        mine = Celebration.objects.get(user=self.asha)
        self.send(self.ravi, "post", "/api/me/celebrations/seen", {"ids": [mine.id]})
        mine.refresh_from_db()
        self.assertIsNone(mine.seen_at)


class GoalApiTests(_Api):
    def setUp(self):
        super().setUp()
        self.year = timezone.localdate().year
        _claim(self.asha, "This year Q1", quartile="Q1", year=self.year, position=1)
        _claim(self.asha, "This year Q3", quartile="Q3", year=self.year)
        _claim(self.asha, "Last year", quartile="Q1", year=self.year - 1)

    def put_goals(self, user, goals, year=None):
        return self.send(user, "put", "/api/me/goals", {"year": year or self.year, "goals": goals})

    def test_goals_show_progress_from_this_years_papers(self):
        r = self.put_goals(self.asha, [{"metric": "PAPERS", "target": 4}, {"metric": "Q1", "target": 1}])
        self.assertEqual(r.status_code, 200, r.content)
        goals = {g["metric"]: g for g in self.as_(self.asha).get("/api/me/goals").json()["goals"]}
        self.assertEqual((goals["PAPERS"]["done"], goals["PAPERS"]["target"]), (2, 4))
        self.assertFalse(goals["PAPERS"]["met"])
        self.assertEqual(goals["Q1"]["done"], 1)
        self.assertTrue(goals["Q1"]["met"])

    def test_a_zero_target_removes_the_goal(self):
        self.put_goals(self.asha, [{"metric": "PAPERS", "target": 4}])
        self.put_goals(self.asha, [{"metric": "PAPERS", "target": 0}])
        self.assertFalse(ResearchGoal.objects.filter(user=self.asha).exists())

    def test_an_unknown_metric_is_refused(self):
        self.assertEqual(self.put_goals(self.asha, [{"metric": "RUPEES", "target": 4}]).status_code, 400)

    def test_citations_say_when_there_is_nothing_to_count(self):
        self.put_goals(self.asha, [{"metric": "CITATIONS", "target": 10}])
        goal = self.as_(self.asha).get("/api/me/goals").json()["goals"][0]
        self.assertIsNone(goal["done"])
        self.assertFalse(goal["available"])

    def test_research_faculty_see_their_quota_as_a_built_in_goal(self):
        self.asha.faculty_type = "RESEARCH"
        self.asha.research_quota = 3
        self.asha.save()
        goals = self.as_(self.asha).get("/api/me/goals").json()["goals"]
        quota = [g for g in goals if g["built_in"]]
        self.assertEqual(len(quota), 1)
        self.assertEqual((quota[0]["target"], quota[0]["done"]), (3, 2))

    def test_the_head_sees_counts_only(self):
        self.put_goals(self.asha, [{"metric": "PAPERS", "target": 2}])
        self.put_goals(self.ravi, [{"metric": "PAPERS", "target": 5}])
        self.put_goals(self.meena, [{"metric": "PAPERS", "target": 9}])

        r = self.as_(self.head).get("/api/hod/goals")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["people_with_goals"], 2)
        papers = {m["metric"]: m for m in body["metrics"]}["PAPERS"]
        self.assertEqual((papers["people"], papers["met"]), (2, 1))
        raw = json.dumps(body)
        for private in (self.asha.name, self.ravi.name, self.asha.id, self.ravi.id, self.meena.name):
            self.assertNotIn(private, raw)

    def test_only_a_head_sees_the_roll_up(self):
        self.assertEqual(self.as_(self.asha).get("/api/hod/goals").status_code, 403)


class ImpactCardTests(_Api):
    def setUp(self):
        super().setUp()
        _claim(self.asha, "A Q1 paper", quartile="Q1", journal="Nature Photonics")
        _ledger(self.asha, "An older paper", quartile="Q2", journal="Optics Letters")

    def share(self, enabled):
        return self.send(self.asha, "put", "/api/me/impact/share", {"enabled": enabled})

    def test_the_summary_has_the_facts_and_no_money(self):
        r = self.as_(self.asha).get("/api/me/impact")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["name"], "Asha Menon")
        self.assertEqual((body["papers"], body["q1"]), (2, 1))
        self.assertEqual(body["top_journal"], "Nature Photonics")
        self.assertFalse(body["share"]["enabled"])
        self.assert_no_money(body)

    def test_the_card_renders_at_both_sizes(self):
        from PIL import Image

        for size, dims in (("wide", (1200, 627)), ("square", (1080, 1080))):
            r = self.as_(self.asha).get(f"/api/me/impact/card.png?size={size}")
            self.assertEqual(r.status_code, 200, r.content[:200])
            self.assertEqual(r["Content-Type"], "image/png")
            self.assertEqual(Image.open(BytesIO(r.content)).size, dims)

    def test_sharing_is_off_until_turned_on(self):
        ImpactShare.objects.filter(user=self.asha).delete()
        self.assertEqual(Client().get("/api/share/impact/nothing-here").status_code, 404)

    def test_a_shared_card_has_a_public_page_with_an_open_graph_image(self):
        r = self.share(True)
        self.assertEqual(r.status_code, 200, r.content)
        token = r.json()["token"]
        page = Client().get(f"/api/share/impact/{token}")
        self.assertEqual(page.status_code, 200)
        html = page.content.decode()
        self.assertIn('property="og:image"', html)
        self.assertIn(f"/api/share/impact/{token}/card.png", html)
        self.assertIn("Asha Menon", html)
        for private in ("12345.67", "5432.1", "₹", self.asha.email, "TSCS001"):
            self.assertNotIn(private, html)

        png = Client().get(f"/api/share/impact/{token}/card.png")
        self.assertEqual(png.status_code, 200)
        self.assertEqual(png["Content-Type"], "image/png")

    def test_turning_sharing_off_hides_the_page_and_the_image(self):
        token = self.share(True).json()["token"]
        self.share(False)
        self.assertEqual(Client().get(f"/api/share/impact/{token}").status_code, 404)
        self.assertEqual(Client().get(f"/api/share/impact/{token}/card.png").status_code, 404)

        # Back on, the same link works again.
        self.assertEqual(self.share(True).json()["token"], token)
        self.assertEqual(Client().get(f"/api/share/impact/{token}").status_code, 200)

    def test_the_private_card_needs_a_session(self):
        self.assertEqual(Client().get("/api/me/impact/card.png").status_code, 401)


class WallTests(_Api):
    def setUp(self):
        super().setUp()
        aug, jul = date(2026, 8, 1), date(2026, 7, 1)
        _ledger(self.asha, "Shared CSE paper", month=aug, quartile="Q1", journal="J One")
        _ledger(self.ravi, "Shared CSE paper", month=aug, quartile="Q1", journal="J One")
        _ledger(self.meena, "ECE paper", month=aug, quartile="Q2")
        _ledger(self.asha, "July paper", month=jul)

    def wall(self, user, query):
        return self.as_(user).get(f"/api/wall?{query}")

    def test_a_department_month_groups_co_authors_on_one_card(self):
        r = self.wall(self.meena, "department=CSE&month=2026-08")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual([c["title"] for c in body["cards"]], ["Shared CSE paper"])
        card = body["cards"][0]
        self.assertEqual({a["name"] for a in card["authors"]}, {"Asha Menon", "Ravi Kumar"})
        self.assertEqual(card["quartile"], "Q1")
        self.assert_no_money(body)

    def test_the_college_wall_has_every_department(self):
        body = self.wall(self.asha, "month=2026-08").json()
        self.assertEqual({c["title"] for c in body["cards"]}, {"Shared CSE paper", "ECE paper"})

    def test_months_are_browsable_and_the_latest_is_the_default(self):
        body = self.wall(self.asha, "department=CSE").json()
        self.assertEqual(body["month"], "2026-08")
        self.assertEqual({m["month"]: m["count"] for m in body["months"]},
                         {"2026-08": 1, "2026-07": 1})

    def pin(self, user, department, key, month="2026-08"):
        return self.send(user, "post", "/api/wall/pin",
                         {"department": department, "month": month, "key": key})

    def test_the_head_pins_a_paper_of_the_month(self):
        key = self.wall(self.head, "department=CSE&month=2026-08").json()["cards"][0]["key"]
        r = self.pin(self.head, "CSE", key)
        self.assertEqual(r.status_code, 200, r.content)
        body = self.wall(self.asha, "department=CSE&month=2026-08").json()
        self.assertEqual(body["pinned"]["title"], "Shared CSE paper")
        self.assertTrue(body["cards"][0]["pinned"])

        r = self.send(self.head, "delete", "/api/wall/pin?department=CSE&month=2026-08")
        self.assertEqual(r.status_code, 200)
        self.assertIsNone(self.wall(self.asha, "department=CSE&month=2026-08").json()["pinned"])

    def test_only_the_departments_own_head_may_pin(self):
        key = self.wall(self.head, "department=CSE&month=2026-08").json()["cards"][0]["key"]
        self.assertEqual(self.pin(self.asha, "CSE", key).status_code, 403)
        self.assertEqual(self.pin(self.ece_head, "CSE", key).status_code, 403)
        self.assertFalse(WallPin.objects.exists())

    def test_a_paper_not_on_that_wall_cannot_be_pinned(self):
        self.assertEqual(self.pin(self.head, "CSE", "ece paper").status_code, 400)

    def test_the_principal_pins_the_college_wall(self):
        key = self.wall(self.principal, "month=2026-08").json()["cards"][0]["key"]
        self.assertEqual(self.pin(self.principal, "", key).status_code, 200)

    def test_signed_out_is_refused(self):
        self.assertEqual(Client().get("/api/wall").status_code, 401)
