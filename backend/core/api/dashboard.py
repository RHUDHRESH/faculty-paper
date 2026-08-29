"""dashboards.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _csv_row, api, session_auth
from core.api.deps import _format_payout_month, claim_to_dict, require_user
from core.api.claims import _claims_queryset, _refuse_hod_money_screens

import csv
import io
import json
import re
import time
from typing import Any, Optional
from django.db.models import Count, Q, Sum
from django.http import HttpRequest, HttpResponse
from django.utils import timezone
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimReason, ClaimStatus, PAYABLE_STATUSES, User
from core.services import rbac
from core.services import exporters
from core.services.remuneration import CATEGORY_LABELS

# ---------- dashboard ----------


@api.get("/dashboard", auth=session_auth)
def dashboard(request: HttpRequest):
    user = require_user(request)
    # Returns total_paid and a remuneration on every recent row. /claims and
    # /claims/{id} both refuse a head here and this one did not, which held
    # only while a head owned no claims -- the condition the guard's own
    # docstring says must never be relied on.
    _refuse_hod_money_screens(user)
    qs = _claims_queryset(user)
    counts = {row["status"]: row["n"] for row in qs.values("status").annotate(n=Count("id"))}
    by_status = {s: counts.get(s, 0) for s in ClaimStatus.values}
    recent = [claim_to_dict(c) for c in qs.order_by("-updated_at")[:10]]
    total_paid = (
        qs.filter(status=ClaimStatus.PAID).aggregate(total=Sum("remuneration"))["total"] or 0
    )
    return {"by_status": by_status, "recent": recent, "total_paid": total_paid}


def _reports_queryset(
    user: User,
    year: Optional[int],
    department: Optional[str],
    month: Optional[str] = None,
):
    qs = _claims_queryset(user).exclude(status=ClaimStatus.DRAFT)
    if year:
        qs = qs.filter(publication_year=year)
    if department:
        qs = qs.filter(owner__department__iexact=department)
    if month:
        # "2026-03": the payout month, which is what the college settles in
        # and what finance reconciles against -- not the publication date.
        try:
            y, m = (int(part) for part in month.split("-", 1))
        except (TypeError, ValueError):
            raise HttpError(400, "Month must look like 2026-03")
        if not 1 <= m <= 12:
            raise HttpError(400, "Month must look like 2026-03")
        qs = qs.filter(payout_month__year=y, payout_month__month=m)
    return qs


def _payout_months(user: User) -> list[str]:
    """Every month the college has actually settled something in, newest first."""
    seen = (
        _claims_queryset(user)
        .exclude(payout_month__isnull=True)
        .dates("payout_month", "month", order="DESC")
    )
    return [d.strftime("%Y-%m") for d in seen]


def _pipeline_stages(qs) -> list[dict[str, Any]]:
    """How much work sits at each stage, and how long it has sat there.

    Deliberately not "average time from submission to payment": the imported
    history carries one timestamp per row, so any duration computed across it
    would be zero and would read as instant processing. Age of what is waiting
    now is a real measurement, and it is the one an admin can act on.
    """
    now = timezone.now()
    stages = [
        ("DRAFT", "Draft", "started, not yet submitted"),
        ("SUBMITTED", "Awaiting clearance", "with the research cell"),
        ("CLEARED", "Awaiting payment", "with finance"),
        ("PAID", "Paid", "settled"),
        ("REJECTED", "Returned", "sent back to the claimant"),
    ]
    out = []
    for status, label, blurb in stages:
        rows_ = list(
            qs.filter(status=status).values_list("updated_at", "remuneration")
        )
        if not rows_ and status not in ("SUBMITTED", "CLEARED"):
            continue
        ages = sorted(
            (now - u).days for u, _ in rows_ if u is not None
        )
        median = ages[len(ages) // 2] if ages else 0
        out.append(
            {
                "key": status,
                "label": label,
                "blurb": blurb,
                "count": len(rows_),
                "amount": round(sum(a or 0 for _, a in rows_), 2),
                "median_age_days": median,
                "oldest_age_days": ages[-1] if ages else 0,
            }
        )
    return out


def _multi_rows(source, field: str) -> list[dict[str, Any]]:
    """Count a comma-separated set field once per member.

    The rows overlap -- one paper in both Scopus and SCIE is counted under
    each -- so the total across the bars exceeds the number of papers. That is
    the honest shape of the question, and the caption says as much.
    """
    buckets: dict[str, dict[str, Any]] = {}
    for value, amount in source.values_list(field, "remuneration"):
        parts = [p.strip() for p in (value or "").split(",") if p.strip()]
        for part in parts or ["Not stated"]:
            slot = buckets.setdefault(part, {"key": part, "count": 0, "amount": 0.0})
            slot["count"] += 1
            # Amount is deliberately not divided between the indexes: each bar
            # answers "money on papers listed here", not a share of a total.
            slot["amount"] += amount or 0
    return sorted(
        (
            {"key": b["key"], "count": b["count"], "amount": round(b["amount"], 2)}
            for b in buckets.values()
        ),
        key=lambda b: -b["count"],
    )


def _people_rows(source) -> list[dict[str, Any]]:
    """One row per person, carrying the id the screen needs to link to them."""
    rows = [
        {
            "key": r["owner__name"] or "Unknown",
            "id": r["owner_id"],
            "department": r["owner__department"],
            "count": r["n"],
            "amount": round(r["total"] or 0, 2),
        }
        for r in source.values("owner_id", "owner__name", "owner__department")
        .annotate(n=Count("id"), total=Sum("remuneration"))
        .order_by("-n")
    ]
    return sorted(rows, key=lambda r: -r["count"])


def _capped(bucket_rows: list[dict[str, Any]], limit: int) -> dict[str, Any]:
    """The top rows, and an honest account of what was left out.

    A silently truncated top-15 reads as "these are all of them", and the
    reader draws a conclusion about a tail they were never shown.
    """
    kept = bucket_rows[:limit]
    rest = bucket_rows[limit:]
    return {
        "rows": kept,
        "hidden": len(rest),
        "hidden_count": sum(r["count"] for r in rest),
        "hidden_amount": round(sum(r["amount"] for r in rest), 2),
    }


def _per_paper(paid_qs) -> dict[str, Any]:
    """What one paid paper is worth -- mean, median, and the range.

    The mean alone is misleading here: the scheme pays a few Q1 papers many
    times what it pays a Q4 one, so the average sits above almost every actual
    payment. The median is the figure that describes a typical claim.
    """
    amounts = sorted(
        a for a in paid_qs.values_list("remuneration", flat=True) if a is not None
    )
    if not amounts:
        return {"count": 0, "mean": 0, "median": 0, "min": 0, "max": 0}
    mid = len(amounts) // 2
    median = (
        amounts[mid] if len(amounts) % 2 else (amounts[mid - 1] + amounts[mid]) / 2
    )
    return {
        "count": len(amounts),
        "mean": round(sum(amounts) / len(amounts), 2),
        "median": round(median, 2),
        "min": round(amounts[0], 2),
        "max": round(amounts[-1], 2),
    }


#: How long something has sat, in words a reader can act on.
AGE_BUCKETS = [
    (0, 7, "Up to a week"),
    (8, 14, "1–2 weeks"),
    (15, 30, "2–4 weeks"),
    (31, 90, "1–3 months"),
    (91, 10_000, "Over 3 months"),
]


def _ageing_rows(qs):
    """The unfinished work, by how long it has been waiting.

    Only what is still in flight: a paid ticket has stopped ageing, and
    including it would bury the eleven that need chasing under three thousand
    that do not.
    """
    live = qs.exclude(status__in=[ClaimStatus.PAID, ClaimStatus.REJECTED, ClaimStatus.DRAFT])
    buckets = {label: {"key": label, "count": 0, "amount": 0.0} for _, _, label in AGE_BUCKETS}
    oldest = None
    # No .only() here: the base queryset select_related's the owner, and
    # deferring it makes Django refuse the join. The live set is under a
    # hundred rows anyway, so there was nothing to save.
    for claim in live:
        days = _waiting_days(claim)
        if days is None:
            continue
        for low, high, label in AGE_BUCKETS:
            if low <= days <= high:
                buckets[label]["count"] += 1
                buckets[label]["amount"] += claim.remuneration or 0
                break
        if oldest is None or days > oldest:
            oldest = days
    # Order is the reader's, not the data's: a bucket with nothing in it is
    # still worth showing, because "nothing over three months" is the answer
    # somebody wanted.
    return [buckets[label] for _, _, label in AGE_BUCKETS], oldest


def _ageing_payload(qs) -> dict[str, Any]:
    rows, oldest = _ageing_rows(qs)
    return {"rows": rows, "oldest_days": oldest, "total": sum(r["count"] for r in rows)}


def _breadth_rows(qs) -> list[dict[str, Any]]:
    """Per year: how many people, and how concentrated.

    Output can rise because more people published or because the same people
    published more, and a total cannot tell those apart. The top-ten share
    says which happened.
    """
    per_year: dict[int, dict[str, Any]] = {}
    for year, owner_id in qs.exclude(publication_year__isnull=True).values_list(
        "publication_year", "owner_id"
    ):
        slot = per_year.setdefault(year, {"count": 0, "people": {}})
        slot["count"] += 1
        slot["people"][owner_id] = slot["people"].get(owner_id, 0) + 1

    out = []
    for year in sorted(per_year):
        slot = per_year[year]
        counts = sorted(slot["people"].values(), reverse=True)
        people = len(counts)
        top_ten = sum(counts[:10])
        out.append(
            {
                "key": str(year),
                "count": slot["count"],
                "people": people,
                "per_person": round(slot["count"] / people, 2) if people else 0,
                "top_ten_share": round(top_ten / slot["count"] * 100) if slot["count"] else 0,
            }
        )
    return out


def _year_on_year_rows(qs) -> list[dict[str, Any]]:
    """Each department against its own previous year.

    Compared on publication year rather than payout month: a department is
    judged on what it published, not on when the college got round to paying
    for it.
    """
    years = sorted(
        {
            y
            for y in qs.exclude(publication_year__isnull=True).values_list(
                "publication_year", flat=True
            )
        }
    )
    if len(years) < 2:
        return []
    this_year, last_year = years[-1], years[-2]

    def counts_for(year: int) -> dict[str, int]:
        return {
            (r["owner__department"] or "No department"): r["n"]
            for r in qs.filter(publication_year=year)
            .values("owner__department")
            .annotate(n=Count("id"))
        }

    now, before = counts_for(this_year), counts_for(last_year)
    rows = []
    for department in sorted(set(now) | set(before)):
        current, previous = now.get(department, 0), before.get(department, 0)
        rows.append(
            {
                "key": department,
                "count": current,
                "previous": previous,
                "change": current - previous,
                # A department that published nothing last year has no
                # percentage change; reporting one would divide by zero and
                # print an infinity where a reader expects a figure.
                "percent": round((current - previous) / previous * 100) if previous else None,
            }
        )
    rows.sort(key=lambda r: -r["count"])
    # The current year is not over. Comparing eight months of 2026 against
    # twelve of 2025 makes every department look like it is collapsing --
    # ECE reads -59% on this data -- and a reader who is not told will
    # believe it. The comparison is still the one people ask for, so it is
    # shown with the caveat rather than quietly swapped for an older pair.
    today = timezone.localdate()
    partial = this_year >= today.year
    return {
        "this_year": this_year,
        "last_year": last_year,
        "this_year_is_partial": partial,
        "months_elapsed": today.month if partial else 12,
        "rows": rows,
    }



@api.get("/reports", auth=session_auth)
def reports(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    month: Optional[str] = None,
):
    """Institutional publication and payout figures.

    The scheme counts every publication but pays only some of them, so the two
    numbers are reported side by side — a department's output and its spend are
    different questions and were previously answerable only by exporting the
    ledger and pivoting it by hand.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    qs = _reports_queryset(user, year, department, month)
    paid = qs.filter(status=ClaimStatus.PAID)
    payable = qs.filter(status__in=PAYABLE_STATUSES)

    #: Values that mean "nothing was recorded" rather than a real category.
    _BLANKISH = {"", "-", "--", "n/a", "na", "none", "null", "nil", "—", "–"}

    def rows(field: str, source=qs, label_blank: str = "Not recorded"):
        """Group by a field, folding the ways a blank can be spelt.

        Grouping on the raw column split one idea across several bars: the
        quartile chart carried "No quartile" (22), "No Quartile" (1) and "-" (1)
        as three separate rows, so no line in the report was the real total.
        """
        buckets: dict[str, dict[str, Any]] = {}
        for r in (
            source.values(field)
            .annotate(count=Count("id"), amount=Sum("remuneration"))
            .order_by("-count")
        ):
            raw = (r[field] or "").strip() if isinstance(r[field], str) else r[field]
            label = label_blank if (raw is None or str(raw).strip().lower() in _BLANKISH) else str(raw)
            slot = buckets.setdefault(
                label.casefold(), {"key": label, "count": 0, "amount": 0.0, "top": 0}
            )
            # Keep the spelling that most rows actually used.
            if r["count"] > slot["top"]:
                slot["key"] = label
                slot["top"] = r["count"]
            slot["count"] += r["count"]
            slot["amount"] += r["amount"] or 0
        out = [
            {"key": b["key"], "count": b["count"], "amount": round(b["amount"], 2)}
            for b in buckets.values()
        ]
        out.sort(key=lambda b: -b["count"])
        return out

    # A publication counts institutionally even when it carries no money.
    count_only = qs.filter(
        Q(claim_reason=ClaimReason.COUNT_ONLY) | Q(is_student_publication=True)
    ).count()

    year_rows = {
        int(r["publication_year"]): {
            "key": str(r["publication_year"]),
            "count": r["count"],
            "amount": round(r["amount"] or 0, 2),
        }
        for r in (
            qs.exclude(publication_year__isnull=True)
            .values("publication_year")
            .annotate(count=Count("id"), amount=Sum("remuneration"))
            .order_by("publication_year")
        )
    }
    # A year with nothing in it is a real answer, and leaving it out of the
    # series draws a straight climb from 2019 to 2023 across four years that
    # never happened. Plotted as the zeros they were.
    by_year = [
        year_rows.get(y, {"key": str(y), "count": 0, "amount": 0.0})
        for y in range(min(year_rows), max(year_rows) + 1)
    ] if year_rows else []

    by_month = []
    for r in (
        paid.exclude(payout_month__isnull=True)
        .values("payout_month")
        .annotate(count=Count("id"), amount=Sum("remuneration"))
        .order_by("payout_month")
    ):
        by_month.append(
            {
                "key": r["payout_month"].strftime("%Y-%m"),
                "count": r["count"],
                "amount": round(r["amount"] or 0, 2),
            }
        )

    return {
        "filters": {"year": year, "department": department},
        "totals": {
            "publications": qs.count(),
            "count_only": count_only,
            "paid_claims": paid.count(),
            "paid_amount": round(paid.aggregate(s=Sum("remuneration"))["s"] or 0, 2),
            "awaiting_payment": payable.count(),
            "committed_amount": round(payable.aggregate(s=Sum("remuneration"))["s"] or 0, 2),
        },
        "by_department": rows("owner__department", label_blank="No department"),
        "by_quartile": rows("quartile", label_blank="No quartile"),
        "by_category": [
            {**r, "label": CATEGORY_LABELS.get(str(r["key"]), str(r["key"]))}
            for r in rows("remuneration_category", label_blank="Not calculated")
        ],
        "by_engineering": rows("engineering_class", label_blank="Unclassified"),
        "by_status": rows("status"),
        "by_month": by_month,
        "by_year": by_year,
        "by_type": rows("aggregation_type", label_blank="Not stated"),
        "by_indexing": _multi_rows(qs, "indexing_level"),
        "by_designation": rows("owner__designation", label_blank="Not recorded"),
        # Three cuts the page could not make. See the helpers above for what
        # each answers and, in the ageing case, why it is measured from the
        # live workflow rather than from the imported timestamps.
        "ageing": _ageing_payload(qs),
        "breadth": _breadth_rows(qs),
        "year_on_year": _year_on_year_rows(qs),
        # Long tails, so these are cut to what a chart can carry legibly. The
        # cut is reported rather than left to look like the whole set.
        "by_journal": _capped(rows("journal_title", label_blank="Not recorded"), 15),
        # Carrying the id, so a name in a report can open that person's record
        # rather than being a dead end the reader has to retype into a search.
        "top_by_publications": _capped(_people_rows(qs), 15),
        "top_by_amount": _capped(
            sorted(_people_rows(paid), key=lambda r: -r["amount"]), 15
        ),
        "per_paper": _per_paper(paid),
        "pipeline": _pipeline_stages(qs),
        "years": sorted(
            {
                y
                for y in _claims_queryset(user)
                .exclude(publication_year__isnull=True)
                .values_list("publication_year", flat=True)
                .distinct()
            },
            reverse=True,
        ),
        # The months the college has actually settled in, so the picker offers
        # real ones rather than a calendar of mostly-empty options.
        "payout_months": _payout_months(user),
    }


def _search_queryset(user: User, **f):
    """Every filter the query screen offers, applied to what the user may see."""
    qs = _claims_queryset(user).exclude(status=ClaimStatus.DRAFT).select_related("owner")
    if f.get("q"):
        term = f["q"].strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(doi__icontains=term)
            | Q(issn__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(owner__email__icontains=term)
            | Q(staff_id__icontains=term)
        )
    if f.get("department"):
        qs = qs.filter(owner__department__iexact=f["department"])
    if f.get("status"):
        qs = qs.filter(status=f["status"])
    if f.get("quartile"):
        qs = qs.filter(quartile__iexact=f["quartile"])
    if f.get("category"):
        qs = qs.filter(remuneration_category=f["category"])
    if f.get("engineering_class"):
        qs = qs.filter(engineering_class__iexact=f["engineering_class"])
    if f.get("indexing"):
        qs = qs.filter(indexing_level__icontains=f["indexing"])
    if f.get("year"):
        qs = qs.filter(publication_year=f["year"])
    if f.get("year_from"):
        qs = qs.filter(publication_year__gte=f["year_from"])
    if f.get("year_to"):
        qs = qs.filter(publication_year__lte=f["year_to"])
    if f.get("min_amount") is not None:
        qs = qs.filter(remuneration__gte=f["min_amount"])
    # Narrowing to one person or one journal is what every drill-down from a
    # record page needs. Without them a chart on Dr X's page linked to the
    # college's Q1 papers rather than to hers, which is a worse answer than
    # no link at all.
    if f.get("owner"):
        qs = qs.filter(owner_id=f["owner"])
    if f.get("journal"):
        qs = qs.filter(journal_title__iexact=f["journal"])
    # The last three dimensions the reports draw that nothing could open. A
    # figure the reader cannot get behind is a figure they have to take on
    # trust, and these are the ones people query in meetings: which grade is
    # publishing, what kind of thing it was, and which month it was settled.
    if f.get("designation"):
        blank = f["designation"] in {"Not recorded", "Not stated", "—"}
        qs = (
            qs.filter(Q(owner__designation__isnull=True) | Q(owner__designation=""))
            if blank
            else qs.filter(owner__designation__iexact=f["designation"])
        )
    if f.get("publication_type"):
        blank = f["publication_type"] in {"Not stated", "Not recorded", "—"}
        qs = (
            qs.filter(Q(aggregation_type__isnull=True) | Q(aggregation_type=""))
            if blank
            else qs.filter(aggregation_type__iexact=f["publication_type"])
        )
    if f.get("month"):
        # "2026-08" — the month the college settled it, which is how the
        # payout chart is keyed and how Finance talks about a run.
        try:
            year_s, month_s = str(f["month"]).split("-")[:2]
            qs = qs.filter(payout_month__year=int(year_s), payout_month__month=int(month_s))
        except (ValueError, TypeError):
            raise HttpError(400, "A month looks like 2026-08.")
    return qs


_SEARCH_SORTS = {
    "recent": "-updated_at",
    "amount": "-remuneration",
    "year": "-publication_year",
    "faculty": "owner__name",
    "department": "owner__department",
}


# Under /reports, not /claims: "/claims/search" is swallowed by the
# "/claims/{claim_id}" route registered above it and 404s.
#: Scimago writes a subject's own quartile into the label -- "Signal
#: Processing (Q4)" -- so the same field carries two facts joined by a
#: bracket. Splitting them means "Signal Processing" is one area with a
#: quartile rather than four areas that happen to share a name.
_SUBJECT_QUARTILE = re.compile(r"\s*\((Q[1-4])\)\s*$", re.IGNORECASE)


def _split_subjects(raw: str | None) -> list[tuple[str, str | None]]:
    """One stored subjects string -> [(area, quartile or None), ...].

    The column is named `subjects_json` and holds no JSON: it is a
    semicolon-separated list, and every reader of it has to know that. Parsing
    it in one place is the only thing stopping three screens from each
    inventing their own split.
    """
    out: list[tuple[str, str | None]] = []
    for part in (raw or "").split(";"):
        label = part.strip()
        if not label:
            continue
        found = _SUBJECT_QUARTILE.search(label)
        quartile = found.group(1).upper() if found else None
        area = _SUBJECT_QUARTILE.sub("", label).strip()
        # "(miscellaneous)" is a real Scimago category and must survive; only
        # a trailing quartile is stripped, which is why this is a regex on
        # Q1-Q4 rather than "drop anything in brackets".
        if area:
            out.append((area, quartile))
    return out


#: What a report can be broken down by: the key a caller asks for, the
#: heading it prints under, and the column it groups on. "area" is the odd
#: one and is handled separately, because a paper belongs to several subject
#: areas at once and no single column holds that.
REPORT_DIMENSIONS: dict[str, tuple[str, str | None]] = {
    "year": ("Year", "publication_year"),
    "department": ("Department", "owner__department"),
    "quartile": ("Quartile", "quartile"),
    "journal": ("Journal", "journal_title"),
    "type": ("Publication type", "aggregation_type"),
    "indexing": ("Indexing", "indexing_level"),
    "designation": ("Designation", "owner__designation"),
    "status": ("Stage", "status"),
    "engineering": ("Engineering class", "engineering_class"),
    "category": ("Payout category", "remuneration_category"),
    "person": ("Person", "owner__name"),
    "area": ("Subject area", None),
}

_BLANKISH_LABELS = {"", "-", "--", "n/a", "na", "none", "null", "nil", "\u2014", "\u2013"}

#: Dimensions where one paper belongs to several rows at once -- a paper in
#: three subject areas, a journal indexed by both Scopus and SCIE.
#:
#: Counting the paper under each is the honest answer to "how much work do we
#: do in this area". Adding up the *money* the same way is not: the same
#: rupee is counted once per area, and the college's 2.8 crore of payouts
#: totalled 12.6 crore across subject areas. Per-row amounts are still
#: meaningful -- "papers in this area were worth this much" -- so they stay;
#: it is the column total that is a fiction, and it is withheld rather than
#: printed with a caveat nobody reads.
OVERLAPPING_DIMENSIONS = {"area", "indexing"}


def _build_rows(qs, dimension: str) -> list[dict[str, Any]]:
    """One dimension, grouped, counted and summed.

    Blanks are folded the same way `/reports` folds them. Grouping on the raw
    column split one idea across several rows -- the quartile breakdown
    carried "No quartile", "No Quartile" and "-" as three separate lines, so
    no row in the report was the real total.
    """
    if dimension == "area":
        buckets: dict[str, dict[str, Any]] = {}
        for raw, amount in qs.values_list("subjects_json", "remuneration"):
            for area, _quartile in _split_subjects(raw):
                slot = buckets.setdefault(area, {"key": area, "count": 0, "amount": 0.0})
                slot["count"] += 1
                slot["amount"] += amount or 0
        return sorted(buckets.values(), key=lambda r: (-r["count"], r["key"]))

    if dimension == "indexing":
        buckets = {}
        for raw, amount in qs.values_list("indexing_level", "remuneration"):
            parts = [p.strip() for p in (raw or "").split(",") if p.strip()] or ["Not stated"]
            for part in parts:
                slot = buckets.setdefault(part, {"key": part, "count": 0, "amount": 0.0})
                slot["count"] += 1
                slot["amount"] += amount or 0
        return sorted(buckets.values(), key=lambda r: (-r["count"], r["key"]))

    _label, field = REPORT_DIMENSIONS[dimension]
    assert field
    buckets = {}
    for row in (
        qs.values(field).annotate(count=Count("id"), amount=Sum("remuneration"))
    ):
        raw = row[field]
        text = str(raw).strip() if raw is not None else ""
        label = "Not recorded" if text.lower() in _BLANKISH_LABELS else text
        slot = buckets.setdefault(label, {"key": label, "count": 0, "amount": 0.0})
        slot["count"] += row["count"]
        slot["amount"] += row["amount"] or 0
    ordered = sorted(buckets.values(), key=lambda r: (-r["count"], r["key"]))
    if dimension == "year":
        # A time axis reads forwards, not by size.
        ordered.sort(key=lambda r: r["key"])
    return ordered


@api.get("/reports/build", auth=session_auth)
def reports_build(
    request: HttpRequest,
    dimensions: str = "department",
    year: Optional[int] = None,
    department: Optional[str] = None,
    month: Optional[str] = None,
    fmt: Optional[str] = None,
    limit: int = 100,
):
    """A report the reader assembled, previewed and downloaded from one place.

    The preview and the file come out of this same call: ask without `fmt` and
    it answers JSON for the screen, ask with one and it answers the workbook.
    That is the whole point of it being one endpoint rather than two. A screen
    and a download built by separate code paths drift, and the way anybody
    finds out is a board meeting where the printed figure and the projected
    one disagree.

    Money is stripped for a role that may not see it -- but `can_view_reports`
    already excludes a head of department outright, so in practice this is a
    belt-and-braces guard rather than a live path.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    wanted = [d.strip() for d in (dimensions or "").split(",") if d.strip()]
    if not wanted:
        raise HttpError(400, "Choose at least one breakdown")
    unknown = [d for d in wanted if d not in REPORT_DIMENSIONS]
    if unknown:
        raise HttpError(
            400,
            f"No breakdown called {unknown[0]!r}. "
            f"Available: {', '.join(sorted(REPORT_DIMENSIONS))}",
        )

    qs = _reports_queryset(user, year, department, month)
    limit = max(1, min(int(limit), 1000))

    scope_bits = [
        f"publication year {year}" if year else "all years on record",
        department or "every department",
    ]
    if month:
        scope_bits.append(f"payout month {month}")
    subtitle = "Saveetha Engineering College \u00b7 " + " \u00b7 ".join(scope_bits)

    tables = []
    for key in wanted:
        label, _field = REPORT_DIMENSIONS[key]
        rows = _build_rows(qs, key)
        overlapping = key in OVERLAPPING_DIMENSIONS
        tables.append({
            "key": key,
            "label": label,
            "rows": [
                {**r, "amount": round(r["amount"], 2)} for r in rows[:limit]
            ],
            "row_count": len(rows),
            "truncated": max(0, len(rows) - limit),
            # One paper sits in several rows here, so neither total is a
            # total of anything real. The count is still worth showing as a
            # sum of appearances; the money is not, and is null.
            "overlapping": overlapping,
            "totals": {
                "count": sum(r["count"] for r in rows),
                "amount": None if overlapping else round(sum(r["amount"] for r in rows), 2),
            },
        })

    if not fmt:
        return {
            "tables": tables,
            "filters": {"year": year, "department": department, "month": month},
            "subtitle": subtitle,
            "available": [
                {"key": k, "label": v[0]} for k, v in REPORT_DIMENSIONS.items()
            ],
            "years": sorted(
                {y for y in qs.values_list("publication_year", flat=True) if y},
                reverse=True,
            ),
        }

    if fmt not in exporters.FORMATS:
        raise HttpError(400, f"Format must be one of: {', '.join(exporters.FORMATS)}.")

    # The pack is built from the very rows the preview returned, so the file
    # cannot disagree with the screen about anything except how it is dressed.
    pack: dict[str, dict[str, Any]] = {}
    for table in tables:
        body = [[r["key"], r["count"], r["amount"]] for r in table["rows"]]
        if table["overlapping"]:
            # No money total, and the sheet says why rather than leaving a
            # blank cell that reads as a bug.
            body.append([
                "Total (appearances)", table["totals"]["count"], None,
            ])
            body.append([
                "One paper appears under every area it belongs to, so these "
                "add to more than the number of papers and the amounts "
                "cannot be summed.",
                None, None,
            ])
        else:
            body.append(["Total", table["totals"]["count"], table["totals"]["amount"]])
        pack[table["label"]] = {
            "columns": [table["label"], "Publications", "Amount"],
            "rows": body,
        }

    body = exporters.render(
        pack, fmt, title="Publication report", subtitle=subtitle
    )
    stem = "report-" + "-".join(wanted) + f"-{year or 'all'}"
    res = HttpResponse(body, content_type=exporters.CONTENT_TYPES[fmt])
    res["Content-Disposition"] = f'attachment; filename="{exporters.filename(stem, fmt)}"'
    AuditLog.objects.create(
        actor=user, action="REPORT_BUILD", entity="Report", entity_id=stem,
        detail_json=json.dumps({"dimensions": wanted, "fmt": fmt, "year": year}),
    )
    return res


@api.get("/reports/areas", auth=session_auth)
def reports_areas(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    limit: int = 40,
):
    """What the college researches, by subject area.

    Nothing else in the system answers this. `subject_category` is a column
    that exists and is empty on every one of the 3,226 filed claims; the real
    answer lives in `subjects_json`, which Scimago fills in for a journal we
    recognise.

    Which is exactly why `coverage` is returned and must be shown. Subjects
    are only known for a paper whose journal we could match, so an area chart
    silently describes that subset and not the college. Presented without the
    denominator it reads as "this is what we do" when it means "this is what
    we do, among the half of our output we can classify" -- and a director
    setting research priorities off the difference would be reading a
    conclusion the data cannot support.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    qs = _reports_queryset(user, year, department)
    rows = list(qs.values_list("subjects_json", "remuneration", "publication_year"))

    areas: dict[str, dict[str, Any]] = {}
    classified = 0
    for raw, amount, _pub_year in rows:
        parsed = _split_subjects(raw)
        if not parsed:
            continue
        classified += 1
        for area, quartile in parsed:
            slot = areas.setdefault(
                area,
                {"key": area, "count": 0, "amount": 0.0, "quartiles": {}},
            )
            # A paper counts once per area it belongs to, so the bars sum to
            # more than the number of papers. That is the honest shape of a
            # question about a multi-disciplinary body of work, and the
            # caption on the screen says so.
            slot["count"] += 1
            slot["amount"] += amount or 0
            if quartile:
                slot["quartiles"][quartile] = slot["quartiles"].get(quartile, 0) + 1

    ordered = sorted(areas.values(), key=lambda r: (-r["count"], r["key"]))
    total = len(rows)
    limit = max(1, min(int(limit), 200))

    return {
        "areas": [
            {**r, "amount": round(r["amount"], 2)} for r in ordered[:limit]
        ],
        "distinct": len(ordered),
        "shown": min(limit, len(ordered)),
        "coverage": {
            "classified": classified,
            "total": total,
            "unclassified": total - classified,
            "fraction": round(classified / total, 4) if total else 0,
        },
        "filters": {"year": year, "department": department},
        "years": sorted(
            {y for y in qs.values_list("publication_year", flat=True) if y}, reverse=True
        ),
    }


@api.get("/reports/search", auth=session_auth)
def search_claims(
    request: HttpRequest,
    q: Optional[str] = None,
    department: Optional[str] = None,
    status: Optional[str] = None,
    quartile: Optional[str] = None,
    category: Optional[str] = None,
    engineering_class: Optional[str] = None,
    indexing: Optional[str] = None,
    year: Optional[int] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    min_amount: Optional[float] = None,
    owner: Optional[str] = None,
    journal: Optional[str] = None,
    designation: Optional[str] = None,
    publication_type: Optional[str] = None,
    month: Optional[str] = None,
    sort: str = "recent",
    limit: int = 100,
    offset: int = 0,
):
    """Query every publication the user may see, across the whole college.

    The oversight portals could list and eyeball a pipeline but not ask it
    anything — "which Q1 Engineering papers in ECE went unpaid last year" meant
    exporting the ledger. This answers that directly, and reports the total and
    sum for the matched set rather than only the page.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    qs = _search_queryset(
        user,
        q=q, department=department, status=status, quartile=quartile,
        category=category, engineering_class=engineering_class,
        indexing=indexing, year=year, year_from=year_from, year_to=year_to,
        min_amount=min_amount, owner=owner, journal=journal,
        designation=designation, publication_type=publication_type, month=month,
    )
    total = qs.count()
    total_amount = qs.aggregate(s=Sum("remuneration"))["s"] or 0
    order = _SEARCH_SORTS.get(sort, "-updated_at")
    limit = max(1, min(limit, 500))
    rows = qs.order_by(order, "-id")[offset : offset + limit]
    return {
        "total": total,
        "total_amount": round(total_amount, 2),
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in rows],
    }


_EXPORT_HEADERS = [
    "Ticket", "Status", "Faculty", "Department", "Staff ID",
    "Paper title", "Journal", "ISSN", "DOI", "Year",
    "Publication type", "Indexed in", "Quartile", "SNIP",
    "Engineering class", "Authors", "Position", "Author point",
    "Category", "Base amount", "QF amount", "Remuneration",
    "Payout month", "Voucher",
]


#: Roughly the width each column needs to be read without adjustment, in the
#: order of _EXPORT_HEADERS.
_EXPORT_WIDTHS = [
    14, 12, 26, 22, 12, 60, 40, 14, 28, 8, 20, 18, 10, 8,
    18, 9, 9, 12, 14, 13, 12, 14, 13, 14,
]


def _export_row(c: Claim) -> list:
    return [
        c.ticket_number, c.status, c.owner.name, c.owner.department,
        c.staff_id, c.paper_title, c.journal_title, c.issn, c.doi,
        c.publication_year, c.publication_type, c.indexing_level,
        c.quartile, c.snip, c.engineering_class, c.total_authors,
        c.author_position, c.author_point, c.remuneration_category,
        c.base_amount, c.qf_amount, c.remuneration,
        _format_payout_month(c.payout_month), c.voucher_number,
    ]


def _claims_file(rows, stem: str, fmt: str) -> HttpResponse:
    """The same rows as a workbook or as CSV, named the same either way."""
    if fmt == "xlsx":
        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        ws.title = "Publications"
        ws.append(_EXPORT_HEADERS)
        for c in rows:
            # openpyxl treats a leading "=" as a formula, so the same
            # injection guard as the CSV path applies.
            ws.append(["" if v is None else v for v in _csv_row(_export_row(c))])
        ws.freeze_panes = "A2"
        # Enough width to read a paper title without widening every column by
        # hand, which is what the office did to every export it received.
        for column, width in zip(ws.columns, _EXPORT_WIDTHS):
            ws.column_dimensions[column[0].column_letter].width = width
        out = io.BytesIO()
        wb.save(out)
        res = HttpResponse(
            out.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        res["Content-Disposition"] = f'attachment; filename="{stem}.xlsx"'
        return res

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(_csv_row(_EXPORT_HEADERS))
    for c in rows:
        w.writerow(_csv_row(_export_row(c)))
    res = HttpResponse(buf.getvalue(), content_type="text/csv")
    res["Content-Disposition"] = f'attachment; filename="{stem}.csv"'
    return res


@api.get("/reports/search/export", auth=session_auth)
def search_export(
    request: HttpRequest,
    q: Optional[str] = None,
    department: Optional[str] = None,
    status: Optional[str] = None,
    quartile: Optional[str] = None,
    category: Optional[str] = None,
    engineering_class: Optional[str] = None,
    indexing: Optional[str] = None,
    year: Optional[int] = None,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
    min_amount: Optional[float] = None,
    owner: Optional[str] = None,
    journal: Optional[str] = None,
    designation: Optional[str] = None,
    publication_type: Optional[str] = None,
    month: Optional[str] = None,
    sort: str = "recent",
    fmt: str = "xlsx",
):
    """Exactly the rows on screen, as a file.

    The existing export takes a year, a department and a month, which is the
    monthly filing. It cannot express "Q1 Engineering papers in ECE that went
    unpaid", so anyone looking at that set had to rebuild it by hand in Excel
    after exporting something wider. Same filters as the query screen, same
    ordering, so the file matches what was being read.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = _search_queryset(
        user,
        q=q, department=department, status=status, quartile=quartile,
        category=category, engineering_class=engineering_class,
        indexing=indexing, year=year, year_from=year_from, year_to=year_to,
        min_amount=min_amount, owner=owner, journal=journal,
        designation=designation, publication_type=publication_type, month=month,
    )
    rows = qs.order_by(_SEARCH_SORTS.get(sort, "-updated_at"), "-id")[:5000]
    stem = "publications-" + (
        "-".join(
            str(v).replace(" ", "-")
            for v in [department, designation, publication_type, quartile, status, year, month]
            if v
        )
        or "all"
    )
    return _claims_file(rows, stem[:80], fmt)


@api.get("/reports/export", auth=session_auth)
def reports_export(
    request: HttpRequest,
    year: Optional[int] = None,
    department: Optional[str] = None,
    month: Optional[str] = None,
    fmt: str = "csv",
):
    """One row per publication — the sheet the R&D office actually files.

    fmt=xlsx returns a real workbook: the office re-imported the CSV into
    Excel by hand every month anyway, mangling ISSNs into dates on the way.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    qs = _reports_queryset(user, year, department, month).select_related("owner")
    rows = qs.order_by("owner__department", "-publication_year")[:5000]
    stem = "-".join([
        "publications",
        str(year or "all"),
        (department or "all").replace(" ", "-"),
        *( [month] if month else [] ),
    ])

    return _claims_file(rows, stem, fmt)




__all__ = [
    'AGE_BUCKETS',
    'OVERLAPPING_DIMENSIONS',
    'REPORT_DIMENSIONS',
    '_BLANKISH_LABELS',
    '_EXPORT_HEADERS',
    '_EXPORT_WIDTHS',
    '_SEARCH_SORTS',
    '_SUBJECT_QUARTILE',
    '_ageing_payload',
    '_ageing_rows',
    '_breadth_rows',
    '_build_rows',
    '_capped',
    '_claims_file',
    '_export_row',
    '_multi_rows',
    '_payout_months',
    '_people_rows',
    '_per_paper',
    '_pipeline_stages',
    '_reports_queryset',
    '_search_queryset',
    '_split_subjects',
    '_year_on_year_rows',
    'dashboard',
    'reports',
    'reports_areas',
    'reports_build',
    'reports_export',
    'search_claims',
    'search_export',
]
