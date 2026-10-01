"""Deadline and goal nudges, checked once a day (schedule "daily-nudges").

One nudge, at most one per person per week:

- **Filing deadline.** When the payout policy sets a filing cutoff day
  (FormulaConfig.filing_cutoff_day), anybody with a draft is told in the
  three days before it: "3 days left to file for this month's run". Once a
  month per person; a day the job missed is caught up inside the window. No
  cutoff set means no reminder -- a deadline nobody decided is fake urgency.
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

KINDS = ("nudge_cutoff",)
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
    }
    logger.info("nudges %s", summary)
    return summary
