"""Deadline and goal nudges, checked once a day (schedule "daily-nudges").

Two nudges, and at most one of either per person per week:

- **Filing deadline.** When the payout policy sets a filing cutoff day
  (FormulaConfig.filing_cutoff_day), anybody with a draft is told in the
  three days before it: "3 days left to file for this month's run". Once a
  month per person; a day the job missed is caught up inside the window. No
  cutoff set means no reminder -- a deadline nobody decided is fake urgency.
- **Research quota.** A research faculty member one paper short of their
  quota for the year is told once per count: papers up to the quota carry no
  incentive and the ones after it do, which is worth knowing and nothing more.

The deadline reminder goes first when both apply, because it is the one with
a date on it.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

from django.db.models import Count
from django.utils import timezone

from core.models import Claim, ClaimStatus, FormulaConfig, Notification, User
from core.services import rbac
from core.services.notify import notify
from core.services.standing import ordinal

logger = logging.getLogger(__name__)

KINDS = ("nudge_cutoff", "nudge_quota")
#: How many days before the cutoff the reminder may go.
WINDOW_DAYS = 3


def cutoff_day() -> int | None:
    cfg = FormulaConfig.objects.filter(active=True).order_by("-version", "-updated_at").first()
    return cfg.filing_cutoff_day if cfg else None


def _deadline_nudges(now, today: date, recently: set[str]) -> int:
    day = cutoff_day()
    if not day:
        return 0
    cutoff = date(today.year, today.month, day)
    left = (cutoff - today).days
    if not 1 <= left <= WINDOW_DAYS:
        return 0
    key = f"cutoff:{cutoff:%Y-%m}"
    done = set(
        Notification.objects.filter(kind="nudge_cutoff", group_key=key).values_list("user_id", flat=True)
    )
    drafts: dict[str, list[Claim]] = defaultdict(list)
    for claim in (
        Claim.objects.filter(
            status=ClaimStatus.DRAFT, owner__active=True, owner__role__in=rbac.CLAIMANT_ROLES
        )
        .select_related("owner")
        .order_by("-updated_at")
    ):
        drafts[claim.owner_id].append(claim)
    sent = 0
    for owner_id, claims in drafts.items():
        if owner_id in recently or owner_id in done:
            continue
        owner = claims[0].owner
        days = "1 day" if left == 1 else f"{left} days"
        first = claims[0].paper_title or "Untitled draft"
        more = f" and {len(claims) - 1} more" if len(claims) > 1 else ""
        note = notify(
            owner,
            "nudge_cutoff",
            f"{days} left to file for this month's run",
            f"Filing for this month's payment run closes on {cutoff.day} {cutoff:%B}. "
            f"You have a draft: “{first}”{more}.",
            f"/papers/{claims[0].id}/edit",
            group_key=key,
            at=now,
        )
        if note is not None:
            recently.add(owner_id)
            sent += 1
    return sent


def _quota_nudges(now, today: date, recently: set[str]) -> int:
    year = today.year
    people = {
        u.id: u
        for u in User.objects.filter(
            active=True, faculty_type="RESEARCH", research_quota__gte=2,
            role__in=rbac.CLAIMANT_ROLES,
        )
    }
    if not people:
        return 0
    counted = dict(
        Claim.objects.filter(owner_id__in=list(people), publication_year=year, quota_position__isnull=False)
        .exclude(status__in=(ClaimStatus.DRAFT, ClaimStatus.REJECTED))
        .values("owner_id")
        .annotate(n=Count("id"))
        .values_list("owner_id", "n")
    )
    sent = 0
    for pid, person in people.items():
        filed = counted.get(pid, 0)
        quota = person.research_quota
        if filed != quota - 1 or pid in recently:
            continue
        key = f"quota:{year}:{filed}"
        if Notification.objects.filter(user_id=pid, kind="nudge_quota", group_key=key).exists():
            continue
        note = notify(
            person,
            "nudge_quota",
            "One paper away from your research quota",
            f"You have filed {filed} of the {quota} papers your research post expects for {year}. "
            f"Every paper after the {ordinal(quota)} carries the incentive.",
            "/papers",
            group_key=key,
            at=now,
        )
        if note is not None:
            recently.add(pid)
            sent += 1
    return sent


def send_nudges(now=None) -> dict[str, int]:
    """One day's nudges. Returns what it did, for the task log."""
    now = now or timezone.now()
    today = timezone.localtime(now).date()
    recently = set(
        Notification.objects.filter(kind__in=KINDS, created_at__gt=now - timedelta(days=7))
        .values_list("user_id", flat=True)
    )
    summary = {
        "cutoff": _deadline_nudges(now, today, recently),
        "quota": _quota_nudges(now, today, recently),
    }
    logger.info("nudges %s", summary)
    return summary
