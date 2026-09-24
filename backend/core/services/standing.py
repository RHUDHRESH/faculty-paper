"""Where a person stands this academic year, for the weekly summary.

The rank is the leaderboard's (core.services.leaderboard, the "This academic
year" people board): the same weighting, the same dates, the same ties. A
summary saying "3rd" while the leaderboard says "5th" would make one of them a
liar, so there is no second ranking here.

Movement is "since last week", and the leaderboard cannot say where somebody
stood a week ago -- it ranks by publication date, and a paper filed this week
may have been published in July. So each Monday's run remembers the ranks it
sent (`remember`), and the next compares with them. Before the first run, and
for somebody new to the board, there is no movement to report.

Only people with something on the board this year are ranked: everybody with
nothing shares the bottom place, and "You are 140th of 140" tells nobody
anything.
"""
from __future__ import annotations

from datetime import datetime

from django.utils import timezone

from core.models import SystemSetting

SNAPSHOT_KEY = "digest_ranks"
#: Weeks of snapshots kept: this week's (a re-run) and the one before.
WEEKS_KEPT = 2
SCORING = (
    "The leaderboard's score for this academic year: a Q1 paper counts four, "
    "Q2 three, Q3 two, Q4 or any other indexed paper one."
)


def week_label(now: datetime) -> str:
    year, week, _ = timezone.localtime(now).isocalendar()
    return f"{year}-W{week:02d}"


def placement(now: datetime) -> dict[str, dict]:
    """Each ranked person's place on the leaderboard as it stands."""
    from core.services import leaderboard, paper_facts

    board = leaderboard.people_board(
        paper_facts.load(), period="academic", on=timezone.localtime(now).date()
    )
    of = len(board["rows"])
    return {
        r["id"]: {"rank": r["rank"], "of": of, "score": r["score"]}
        for r in board["rows"]
        if r["score"]
    }


def _snapshots() -> dict[str, dict[str, int]]:
    row = SystemSetting.objects.filter(key=SNAPSHOT_KEY).first()
    value = row.value if row and isinstance(row.value, dict) else {}
    return {k: v for k, v in value.items() if isinstance(v, dict)}


def remember(now: datetime, places: dict[str, dict]) -> None:
    """Keep the ranks a run sent, for next week's movement."""
    snapshots = _snapshots()
    snapshots[week_label(now)] = {pid: p["rank"] for pid, p in places.items()}
    kept = dict(sorted(snapshots.items())[-WEEKS_KEPT:])
    SystemSetting.objects.update_or_create(key=SNAPSHOT_KEY, defaults={"value": kept})


def movement(now: datetime) -> dict[str, dict]:
    """Rank now, and the rank the last summary before this week went out with."""
    this_week = week_label(now)
    earlier = [w for w in _snapshots() if w < this_week]
    before = _snapshots()[max(earlier)] if earlier else {}
    return {
        pid: {**place, "was": before.get(pid)}
        for pid, place in placement(now).items()
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
        return f"{head}."
    moved = was - place["rank"]
    if moved == 0:
        return f"{head}, the same as last week."
    places = "place" if abs(moved) == 1 else "places"
    return f"{head}, {'up' if moved > 0 else 'down'} {abs(moved)} {places} since last week."
