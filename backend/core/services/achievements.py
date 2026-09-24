"""Badges and department milestones: noticed from real records, told once.

Two jobs, one rule. **A badge or a celebration is only ever for something that
actually happened**, read off the recognised papers in `core.services.records`
-- never for opening the app, never for a streak kept alive by a nag, and never
with a figure of money anywhere near it.

Badges
------
`award_badges` works out every badge each person has earned and writes the
ones not yet written. It is safe to run any number of times: `(user, key)` is
unique, a second run finds the row and leaves it alone, and nobody is told
twice. It runs hourly (the schedule in migration 0047) and straight after a
paper is authorised or paid (`on_claim_moved`, called from `_transition`).

A badge whose evidence has gone -- a voided payment, a corrected staff id --
is withdrawn on the next run, because a badge nobody can point to a paper for
is not a real achievement. A place in a department's top ten is the exception:
it was reached, and a colleague overtaking you later does not undo that.

Fresh or old
------------
A badge dated within `FRESH_DAYS`, or earned by the paper that just moved, is
news: it gets a notification and a one-time celebration on the person's home
screen. A badge dated earlier is history the engine has only now noticed --
the whole 2024 ledger, on the day this shipped -- and is filed quietly, with
one notification per person saying their record has badges on it now. Forty
celebrations for work done two years ago would be noise, not news.

Department milestones
---------------------
`check_milestones` compares each department's targets for the current year
with where they stand, counted the way the head's own targets screen counts
(`core.api.hod._target_progress`), except that a paper sent back or not
accepted is not counted towards a celebration. Crossing 50, 75 or 100 per cent
is recorded once (`DepartmentMilestone`); everybody in the department gets a
one-time celebration and the Principal gets a notification. When several
thresholds are crossed at once, only the highest is celebrated.
"""
from __future__ import annotations

import logging
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date
from functools import partial
from typing import Iterable, Optional

from django.db import IntegrityError, transaction
from django.utils import timezone

from core.models import (
    Badge,
    Celebration,
    Claim,
    ClaimStatus,
    DepartmentMilestone,
    DepartmentTarget,
    Notification,
    Role,
    User,
)
from core.services import rbac
from core.services.records import RECOGNISED_STATUSES, PaperRecord, paper_records

logger = logging.getLogger(__name__)

#: A badge dated within this many days of today is news; older is history.
FRESH_DAYS = 30

#: Papers-so-far badges.
PAPER_COUNTS = (5, 10, 25)
#: Semesters-in-a-row badges.
STREAKS = (3, 6)
#: Size of the department top ten, and the fewest people who must have
#: published that year for "top ten" to be a cut rather than everybody.
TOP_N = 10
#: Department target thresholds, in per cent.
THRESHOLDS = (50, 75, 100)

#: Kinds that stay once earned even if the records later say otherwise.
STICKY_KINDS = frozenset({"TOP10_DEPARTMENT"})

#: What each kind is called and what it means, in plain sentence case.
CATALOGUE: dict[str, tuple[str, str]] = {
    "FIRST_PAPER": ("First paper", "The first paper the college recognised."),
    "FIRST_Q1": ("First Q1 paper", "A paper in a top-quartile journal."),
    "PAPERS_5": ("5 papers", "Five papers recognised by the college."),
    "PAPERS_10": ("10 papers", "Ten papers recognised by the college."),
    "PAPERS_25": ("25 papers", "Twenty-five papers recognised by the college."),
    "FIRST_AUTHOR": ("First author", "A paper led as first author."),
    "CROSS_DEPARTMENT": (
        "Across departments",
        "A paper written with a colleague from another department.",
    ),
    "QUOTA_MET": ("Research quota met", "The year's research quota, reached."),
    "TOP10_DEPARTMENT": (
        "Top 10 in the department",
        "Among the ten strongest publication records in the department that year, "
        "with Q1 papers weighted most.",
    ),
    "STREAK_3": ("Three semesters running", "Papers in three semesters in a row."),
    "STREAK_6": ("Six semesters running", "Papers in six semesters in a row."),
    "FIRST_CITATION": ("First citation", "Somebody cited this work."),
}

#: Where a badge notification takes its reader: their profile, which carries
#: the shelf.
BADGE_HREF = "/me"


def notify(user: User, title: str, body: str, href: str) -> None:
    """The one place this module tells somebody something.

    A generic notification service is being built; when it lands, this body is
    the only line to change.
    """
    Notification.objects.create(user=user, title=title[:255], body=body, href=href)


# ---------------------------------------------------------------------------
# Working out what each person has earned
# ---------------------------------------------------------------------------


@dataclass
class Candidate:
    kind: str
    key: str
    record: PaperRecord
    detail: str = ""
    on: Optional[date] = None

    @property
    def earned_on(self) -> date:
        return self.on or self.record.on


@dataclass
class _Context:
    """What one person's badges need to know about everybody else's papers."""

    records: dict[str, list[PaperRecord]]
    departments: dict[str, str]
    #: paper key -> {department (lower) -> department as written}
    paper_departments: dict[str, dict[str, str]] = field(default_factory=dict)
    #: (department lower, year) -> {user id: points}
    points: dict[tuple[str, int], dict[str, int]] = field(default_factory=dict)

    @classmethod
    def build(cls, records: dict[str, list[PaperRecord]], people: Iterable[User]) -> "_Context":
        departments = {u.id: (u.department or "").strip() for u in people}
        ctx = cls(records=records, departments=departments)
        for uid, recs in records.items():
            dept = departments.get(uid, "")
            for r in recs:
                if dept:
                    ctx.paper_departments.setdefault(r.key, {})[dept.lower()] = dept
                    if r.year:
                        slot = ctx.points.setdefault((dept.lower(), r.year), {})
                        slot[uid] = slot.get(uid, 0) + r.points
        return ctx


def _semester(d: date) -> int:
    """Jan-Jun and Jul-Dec, numbered so consecutive semesters differ by one."""
    return d.year * 2 + (0 if d.month <= 6 else 1)


def _candidates(user: User, recs: list[PaperRecord], ctx: _Context) -> list[Candidate]:
    if not recs:
        return []
    out: list[Candidate] = [Candidate("FIRST_PAPER", "FIRST_PAPER", recs[0])]

    q1 = next((r for r in recs if r.quartile == "Q1"), None)
    if q1:
        out.append(Candidate("FIRST_Q1", "FIRST_Q1", q1))

    for n in PAPER_COUNTS:
        if len(recs) >= n:
            out.append(Candidate(f"PAPERS_{n}", f"PAPERS_{n}", recs[n - 1]))

    led = next((r for r in recs if r.first_author), None)
    if led:
        out.append(Candidate("FIRST_AUTHOR", "FIRST_AUTHOR", led))

    mine = (user.department or "").strip().lower()
    if mine:
        for r in recs:
            others = {k: v for k, v in ctx.paper_departments.get(r.key, {}).items() if k != mine}
            if others:
                names = ", ".join(sorted(others.values()))
                out.append(Candidate(
                    "CROSS_DEPARTMENT", "CROSS_DEPARTMENT", r, detail=f"With a colleague in {names}"
                ))
                break

    if user.faculty_type == "RESEARCH" and (user.research_quota or 0) > 0:
        by_year: dict[int, list[PaperRecord]] = defaultdict(list)
        for r in recs:
            if r.year:
                by_year[r.year].append(r)
        for year, papers in sorted(by_year.items()):
            if len(papers) >= user.research_quota:
                out.append(Candidate(
                    "QUOTA_MET", f"QUOTA_MET:{year}", papers[user.research_quota - 1],
                    detail=f"{user.research_quota} papers in {year}",
                ))

    if mine:
        out.extend(_top_ten(user, recs, ctx))

    out.extend(_streaks(recs))

    cited = next((r for r in recs if (r.citations or 0) > 0), None)
    if cited:
        out.append(Candidate("FIRST_CITATION", "FIRST_CITATION", cited))
    return out


def _top_ten(user: User, recs: list[PaperRecord], ctx: _Context) -> list[Candidate]:
    """A place in the department's top ten for a year, conservatively.

    Only where more than ten people in the department published that year --
    otherwise everybody is in the top ten and it says nothing -- and only when
    no more than ten people score at least as much as this person. A tie
    straddling tenth place awards nobody in the tie: "one of fourteen people on
    the same score" is not a top ten.
    """
    dept = (user.department or "").strip()
    out = []
    for year in sorted({r.year for r in recs if r.year}):
        scores = ctx.points.get((dept.lower(), year), {})
        mine = scores.get(user.id)
        if not mine or len(scores) <= TOP_N:
            continue
        if sum(1 for s in scores.values() if s >= mine) > TOP_N:
            continue
        that_year = [r for r in recs if r.year == year]
        best = max(that_year, key=lambda r: (r.points, -r.on.toordinal()))
        out.append(Candidate(
            "TOP10_DEPARTMENT", f"TOP10_DEPARTMENT:{year}", best,
            detail=f"Top 10 in {dept} for {year}",
            on=max(r.on for r in that_year),
        ))
    return out


def _streaks(recs: list[PaperRecord]) -> list[Candidate]:
    """Papers filed in N semesters in a row, dated by the paper that made it N."""
    first_in: dict[int, PaperRecord] = {}
    for r in sorted(recs, key=lambda r: (r.filed_on, r.title)):
        first_in.setdefault(_semester(r.filed_on), r)
    out: list[Candidate] = []
    run, previous = 0, None
    for sem in sorted(first_in):
        run = run + 1 if previous is not None and sem == previous + 1 else 1
        previous = sem
        for n in STREAKS:
            if run == n:
                out.append(Candidate(f"STREAK_{n}", f"STREAK_{n}", first_in[sem]))
    return out


# ---------------------------------------------------------------------------
# Writing them down
# ---------------------------------------------------------------------------


@dataclass
class AwardResult:
    created: int = 0
    removed: int = 0
    by_kind: Counter = field(default_factory=Counter)
    people: int = 0


def label_of(badge_kind: str, key: str = "", detail: str = "") -> str:
    label = CATALOGUE.get(badge_kind, (badge_kind.replace("_", " ").capitalize(), ""))[0]
    if badge_kind == "TOP10_DEPARTMENT" and detail:
        return detail
    if badge_kind == "QUOTA_MET" and ":" in key:
        return f"{label}, {key.split(':', 1)[1]}"
    return label


def award_badges(
    users: Optional[Iterable[User]] = None,
    *,
    today: Optional[date] = None,
    news_claim_ids: Iterable[str] = (),
) -> AwardResult:
    """Write every badge `users` (everybody when None) have earned and lack.

    The records of the whole college are read either way: whether a paper
    crossed departments, or where somebody stands in their department, is a
    question about other people's papers too.
    """
    today = today or timezone.localdate()
    news = set(news_claim_ids)
    everybody = list(User.objects.all())
    records = paper_records(everybody)
    ctx = _Context.build(records, everybody)

    if users is None:
        with_badges = set(Badge.objects.values_list("user_id", flat=True))
        targets = [u for u in everybody if records.get(u.id) or u.id in with_badges]
    else:
        wanted = {u.id for u in users}
        targets = [u for u in everybody if u.id in wanted]

    result = AwardResult()
    for user in targets:
        _award_one(user, _candidates(user, records.get(user.id, []), ctx), today, news, result)
    return result


def _award_one(user, candidates, today, news, result: AwardResult) -> None:
    wanted = {c.key: c for c in candidates}
    existing = {b.key: b for b in Badge.objects.filter(user=user)}

    for key, badge in existing.items():
        if key not in wanted and badge.kind not in STICKY_KINDS:
            badge.delete()
            result.removed += 1

    fresh: list[Badge] = []
    quiet: list[Badge] = []
    for key, c in wanted.items():
        if key in existing:
            continue
        try:
            with transaction.atomic():
                badge = Badge.objects.create(
                    user=user,
                    kind=c.kind,
                    key=key,
                    earned_on=c.earned_on,
                    evidence_title=c.record.title[:5000],
                    evidence_journal=c.record.journal[:512],
                    evidence_year=c.record.year,
                    evidence_claim_id=c.record.claim_id,
                    detail=c.detail[:255],
                )
        except IntegrityError:
            # Another run wrote it between our read and our write.
            continue
        result.created += 1
        result.by_kind[c.kind] += 1
        is_news = (today - c.earned_on).days <= FRESH_DAYS or (
            c.record.claim_id is not None and c.record.claim_id in news
        )
        (fresh if is_news else quiet).append(badge)

    if fresh or quiet:
        result.people += 1
    for badge in fresh:
        label = label_of(badge.kind, badge.key, badge.detail)
        Celebration.objects.get_or_create(
            user=user,
            key=f"badge:{badge.key}",
            defaults={
                "kind": Celebration.Kind.BADGE,
                "title": f"New badge: {label}",
                "body": badge.evidence_title,
                "badge": badge,
            },
        )
    if fresh:
        labels = [label_of(b.kind, b.key, b.detail) for b in fresh]
        title = f"New badge: {labels[0]}" if len(labels) == 1 else f"{len(labels)} new badges"
        notify(user, title, ", ".join(labels) + ". They are on your profile.", BADGE_HREF)
    if quiet:
        n = len(quiet)
        notify(
            user,
            "Your record has badges on it" if n > 1 else "Your record has a badge on it",
            f"{n} badge{'s' if n != 1 else ''} for papers already on your record. "
            "They are on your profile.",
            BADGE_HREF,
        )


def badge_dict(badge: Badge, *, for_owner: bool) -> dict:
    """A badge as anybody signed in may see it. No money, ever."""
    label, description = CATALOGUE.get(badge.kind, (badge.kind, ""))
    return {
        "id": badge.id,
        "kind": badge.kind,
        "key": badge.key,
        "label": label_of(badge.kind, badge.key, badge.detail),
        "description": description,
        "detail": badge.detail,
        "earned_on": badge.earned_on.isoformat(),
        "evidence": {
            "title": badge.evidence_title,
            "journal": badge.evidence_journal,
            "year": badge.evidence_year,
        },
        # Only the owner can open their own claim.
        "claim_id": badge.evidence_claim_id if for_owner else None,
    }


# ---------------------------------------------------------------------------
# Department milestones
# ---------------------------------------------------------------------------


def department_progress(department: str, year: int, metric: str) -> int:
    """How far a department target has got, as the head's own screen counts it.

    The counting rule is `core.api.hod._target_progress`, used as it is so the
    number celebrated and the number on the head's screen are worked out the
    same way. The one difference is the set it counts: a paper sent back or not
    accepted is left out here, because a celebration is for real work.
    """
    from core.api.hod import _target_progress

    qs = (
        Claim.objects.filter(owner__department__iexact=department, publication_year=year)
        .exclude(status__in=(ClaimStatus.DRAFT, ClaimStatus.REJECTED))
    )
    return _target_progress(qs, metric, None)


def check_milestones(
    departments: Optional[Iterable[str]] = None, *, today: Optional[date] = None
) -> list[DepartmentMilestone]:
    today = today or timezone.localdate()
    targets = DepartmentTarget.objects.filter(
        person__isnull=True, year=today.year, target__gt=0
    )
    if departments is not None:
        wanted = {d.strip().lower() for d in departments if d and d.strip()}
        targets = [t for t in targets if t.department.strip().lower() in wanted]

    reached: list[DepartmentMilestone] = []
    for t in targets:
        done = department_progress(t.department, t.year, t.metric)
        crossed = [p for p in THRESHOLDS if done * 100 >= p * t.target]
        if not crossed:
            continue
        have = set(
            DepartmentMilestone.objects.filter(
                department__iexact=t.department, year=t.year, metric=t.metric, target=t.target
            ).values_list("threshold", flat=True)
        )
        new = [p for p in crossed if p not in have]
        if not new:
            continue
        rows = []
        for p in new:
            try:
                with transaction.atomic():
                    rows.append(DepartmentMilestone.objects.create(
                        department=t.department, year=t.year, metric=t.metric,
                        target=t.target, threshold=p, done=done,
                    ))
            except IntegrityError:
                continue
        if not rows:
            continue
        top = max(rows, key=lambda m: m.threshold)
        _celebrate_milestone(t, top, done)
        reached.extend(rows)
    return reached


def _milestone_words(t: DepartmentTarget, threshold: int, done: int) -> tuple[str, str]:
    what = DepartmentTarget.Metric(t.metric).label.lower() if t.metric in DepartmentTarget.Metric.values else "papers"
    if threshold >= 100:
        title = f"{t.department} reached its {t.year} target for {what}"
    elif threshold == 50:
        title = f"{t.department} is halfway to its {t.year} target for {what}"
    else:
        title = f"{t.department} is three-quarters of the way to its {t.year} target for {what}"
    return title, f"{done} of {t.target}. Every paper in the department counted."


def _celebrate_milestone(t: DepartmentTarget, m: DepartmentMilestone, done: int) -> None:
    title, body = _milestone_words(t, m.threshold, done)
    key = f"milestone:{t.department.lower()}:{t.year}:{t.metric}:{t.target}:{m.threshold}"
    members = User.objects.filter(
        department__iexact=t.department, role__in=rbac.CLAIMANT_ROLES, active=True
    )
    for person in members:
        Celebration.objects.get_or_create(
            user=person, key=key,
            defaults={"kind": Celebration.Kind.TARGET, "title": title, "body": body},
        )
    for principal in User.objects.filter(role=Role.PRINCIPAL, active=True):
        notify(principal, title, body, "/")


# ---------------------------------------------------------------------------
# The two ways in: the job, and a paper moving
# ---------------------------------------------------------------------------


def run_all(*, today: Optional[date] = None) -> dict:
    """The hourly job: every badge, every department."""
    result = award_badges(today=today)
    milestones = check_milestones(today=today)
    return {
        "badges_created": result.created,
        "badges_removed": result.removed,
        "by_kind": dict(result.by_kind),
        "milestones": len(milestones),
    }


def on_claim_moved(claim: Claim, from_status: str, to_status: str) -> None:
    """Called by `_transition` after a paper changes status.

    Runs once the change is committed, and never lets a failure here undo or
    block the transition that triggered it: a badge is a courtesy, a payment is
    not.
    """
    owner_id = claim.owner_id
    department = (getattr(claim.owner, "department", "") or "").strip()
    recognised = to_status in RECOGNISED_STATUSES or from_status in RECOGNISED_STATUSES
    transaction.on_commit(
        partial(_after_move, claim.id, owner_id, department, claim.normalized_title, recognised)
    )


def _after_move(claim_id, owner_id, department, key, recognised) -> None:
    try:
        if recognised:
            people = User.objects.filter(pk=owner_id)
            if department:
                people = people | User.objects.filter(department__iexact=department)
            if key:
                sharing = Claim.objects.filter(normalized_title=key).values("owner_id")
                people = people | User.objects.filter(pk__in=sharing)
            award_badges(people.distinct(), news_claim_ids=[claim_id])
        if department:
            check_milestones([department])
    except Exception:  # a courtesy must never break the chain
        logger.exception("achievements_after_move_failed claim=%s", claim_id)
