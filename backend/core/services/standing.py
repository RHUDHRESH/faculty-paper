"""Where a person stands this academic year, for the weekly summary.

A deliberately small ranking, separate from any leaderboard screen: the
summary only needs "you are 12th of 140, up 3 since last week".

Score: every paper filed since 1 June (the academic year, as the faculty
home counts it) counts one, a Q1 paper three and a Q2 paper two. Drafts and
papers sent back or not accepted do not count. Equal scores share a rank.
No money is involved: a count-only paper counts like any other.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, time, timedelta

from django.utils import timezone

from core.api.my_payments import academic_year_start
from core.models import Claim, ClaimStatus

WEIGHTS = {"Q1": 3, "Q2": 2}
_NOT_COUNTED = (ClaimStatus.DRAFT, ClaimStatus.REJECTED)
SCORING = (
    "Papers filed since 1 June. A Q1 paper counts three, a Q2 paper two, "
    "any other paper one."
)


def _year_start(now) -> datetime:
    start = academic_year_start(timezone.localtime(now).date())
    return timezone.make_aware(datetime.combine(start, time.min))


def scores(now, *, as_of=None) -> dict[str, int]:
    """Each person's score for the academic year `now` falls in, counting
    papers filed before `as_of` (default `now`)."""
    as_of = as_of or now
    out: dict[str, int] = defaultdict(int)
    for owner_id, quartile in (
        Claim.objects.exclude(status__in=_NOT_COUNTED)
        .filter(owner__active=True, submitted_at__gte=_year_start(now), submitted_at__lt=as_of)
        .values_list("owner_id", "quartile")
    ):
        out[owner_id] += WEIGHTS.get((quartile or "").strip().upper(), 1)
    return dict(out)


def ranks(score_by_person: dict[str, int]) -> dict[str, int]:
    """Competition ranking: two people on the same score share a place, and
    the next place after them is skipped (1, 1, 3)."""
    ordered = sorted(score_by_person.values(), reverse=True)
    first_at: dict[int, int] = {}
    for i, value in enumerate(ordered, start=1):
        first_at.setdefault(value, i)
    return {pid: first_at[s] for pid, s in score_by_person.items()}


def movement(now) -> dict[str, dict]:
    """Rank now and a week ago, for everybody ranked now."""
    current = scores(now)
    before = ranks(scores(now, as_of=now - timedelta(days=7)))
    now_ranks = ranks(current)
    return {
        pid: {"rank": rank, "was": before.get(pid), "of": len(current), "score": current[pid]}
        for pid, rank in now_ranks.items()
    }


def ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def sentence(place: dict | None) -> str | None:
    """"You are 3rd of 40 this academic year, up 2 places since last week."."""
    if not place:
        return None
    head = f"You are {ordinal(place['rank'])} of {place['of']} this academic year"
    was = place.get("was")
    if was is None:
        return f"{head}, new to the ranking this week."
    moved = was - place["rank"]
    if moved == 0:
        return f"{head}, the same as last week."
    places = "place" if abs(moved) == 1 else "places"
    return f"{head}, {'up' if moved > 0 else 'down'} {abs(moved)} {places} since last week."
