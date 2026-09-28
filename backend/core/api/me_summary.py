"""The faculty home's hero in one call, and the sign-in page's live stats line.

`/me/summary` exists so the Home hero does not race four requests (impact,
claims, payments, calendar) to draw one band (docs/ux/01-landing-home.md).

**Where the paper count comes from.** `core.services.person_record`: the
publication record plus claims-only papers -- the one count Home, My research
and the Impact card share, so they cannot disagree. `papers_source` is
"record".

`/public/stats` is unauthenticated: three whole-college counts for the
sign-in page, no names and no money, cached for an hour.
"""
from __future__ import annotations

from collections import Counter
from datetime import date
from typing import Any, Optional

from django.core.cache import cache
from django.db.models import Count, Sum
from django.http import HttpRequest
from django.utils import timezone

from core.api.common import api, require_user, session_auth
from core.api.my_payments import academic_year_start, ledger_for
from core.models import Claim, ClaimStatus, Role, User
from core.services.person_record import Paper, department_of
from core.services.records import collect

#: Months of history the Record strip draws.
STRIP_MONTHS = 120

#: Statuses that are neither the claimant's homework nor finished: the paper
#: is moving. Includes the legacy ERP statuses the client groups the same way.
MOVING_STATUSES = (
    ClaimStatus.SUBMITTED,
    ClaimStatus.CLEARED,
    ClaimStatus.PRINCIPAL_APPROVED,
    ClaimStatus.DIRECTOR_APPROVED,
    "HOD_APPROVED",
    "RESEARCH_APPROVED",
    ClaimStatus.FINANCE_APPROVED,
)

#: The roles counted as "faculty" on the sign-in stats line: people who file.
FACULTY_ROLES = (Role.FACULTY, Role.HOD)

PUBLIC_STATS_KEY = "public-stats:v1"
PUBLIC_STATS_SECONDS = 60 * 60


def _record_for(user: User) -> tuple[list[Paper], dict[str, list[Paper]]]:
    """The person's papers, and their department's (for the rank)."""
    return department_of(user)


def _unclaimed(user: User) -> Optional[int]:
    from core.api.publications import unclaimed_count
    from core.models import Authorship

    if not Authorship.objects.filter(user=user).exists():
        return None
    return unclaimed_count(user)


def h_index(citations: list[int]) -> int:
    """The largest h with h papers cited at least h times each."""
    ranked = sorted((c for c in citations if c), reverse=True)
    return sum(1 for i, c in enumerate(ranked, start=1) if c >= i)


def _rank(scores: dict[str, int], uid: str) -> Optional[int]:
    if uid not in scores:
        return None
    return 1 + sum(1 for s in scores.values() if s > scores[uid])


def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _when(r) -> Optional[date]:
    """The month a paper counts in: its filing day when the row has one, else
    its publication date, else January of its year."""
    d = getattr(r, "filed_on", None) or getattr(r, "on", None)
    if d:
        return d
    year = getattr(r, "year", None)
    return date(year, 1, 1) if year else None


def strip_of(mine, today: date) -> list[dict[str, Any]]:
    """Papers per month for the last STRIP_MONTHS months, sparse, oldest first."""
    first = today.year * 12 + today.month - STRIP_MONTHS
    counts: Counter = Counter()
    for r in mine:
        d = _when(r)
        if d and first < d.year * 12 + d.month <= today.year * 12 + today.month:
            counts[_month_key(d)] += 1
    return [{"month": m, "papers": n} for m, n in sorted(counts.items())]


@api.get("/me/summary", auth=session_auth)
def my_summary(request: HttpRequest):
    user = require_user(request)
    today = timezone.localdate()
    since = academic_year_start(today)
    mine, records = _record_for(user)
    department = (user.department or "").strip()

    known = [r.citations for r in mine if r.citations is not None]

    dept_rank = None
    if department and mine:
        scores = {uid: sum(r.points for r in recs) for uid, recs in records.items() if recs}
        before = {
            uid: sum(r.points for r in recs if (_when(r) or since) < since)
            for uid, recs in records.items()
            if any((_when(r) or since) < since for r in recs)
        }
        rank = _rank(scores, user.id)
        was = _rank(before, user.id)
        dept_rank = {
            "rank": rank,
            "of": len(scores),
            "dept": department,
            # Places gained since the academic year began; None when the
            # person had nothing ranked then.
            "delta": (was - rank) if (was is not None and rank is not None) else None,
        }

    own = Claim.objects.filter(owner=user)
    by_status = dict(own.values_list("status").annotate(n=Count("id")).values_list("status", "n"))
    moving = own.filter(status__in=MOVING_STATUSES)
    paid_rows = ledger_for(user).filter(amount__gt=0)
    to_date = paid_rows.aggregate(t=Sum("amount"))["t"] or 0
    this_year = paid_rows.filter(payout_month__gte=since).aggregate(t=Sum("amount"))["t"] or 0

    return {
        "papers": len(mine),
        "papers_source": "record",
        "citations": sum(known) if known else None,
        "h_index": h_index(known) if known else None,
        "dept_rank": dept_rank,
        "strip": strip_of(mine, today),
        # Eligible papers on the record with no live claim (the same rule as
        # the My papers "Not claimed" tab). None while the person has no
        # authorships, so the client hides the row rather than showing 0.
        "unclaimed": _unclaimed(user),
        "returned": by_status.get(ClaimStatus.REJECTED, 0),
        "drafts": by_status.get(ClaimStatus.DRAFT, 0),
        "on_the_way": moving.count(),
        "money": {
            "this_year": round(this_year, 2),
            "on_the_way": round(moving.aggregate(t=Sum("remuneration"))["t"] or 0, 2),
            "to_date": round(to_date, 2),
        },
        "since": since.isoformat(),
    }


def public_stats_now() -> dict[str, int]:
    records = collect(include_unmatched=True)
    papers = len({r.key for r in records if r.key})
    faculty = User.objects.filter(active=True, role__in=FACULTY_ROLES).count()
    departments = len(
        {
            d.strip().lower()
            for d in User.objects.filter(active=True, role__in=FACULTY_ROLES)
            .exclude(department__isnull=True)
            .values_list("department", flat=True)
            if d and d.strip()
        }
    )
    return {"papers": papers, "faculty": faculty, "departments": departments}


@api.get("/public/stats")
def public_stats(request: HttpRequest):
    """Whole-college counts for the sign-in page. No personal data."""
    stats = cache.get(PUBLIC_STATS_KEY)
    if stats is None:
        stats = public_stats_now()
        cache.set(PUBLIC_STATS_KEY, stats, PUBLIC_STATS_SECONDS)
    return stats


__all__ = ["my_summary", "public_stats", "h_index", "strip_of", "public_stats_now"]
