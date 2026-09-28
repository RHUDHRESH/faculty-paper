"""The college's papers and payouts, counted from the records that hold them.

`/reports` used to count claims only, so it described the few months the app
has been running and called that the college: 95 papers and 2.4 lakh paid,
against a ledger of 3,000+ payments since 2024 and a publication record of
thousands of papers. Two sources are the truth:

- **Money paid** is the `PaidLedger`. Paying a claim in the app writes a ledger
  row carrying the claim, so claims are not added again; the only claims added
  are PAID ones with no ledger row at all (older data, a test fixture), keyed
  by claim id so nothing counts twice.
- **Papers** are the publication record -- every `Publication` with a college
  `Authorship` (flagged `is_college`, or matched to an account) -- plus the
  recognised claim/ledger papers the record does not hold yet, found the way
  `person_record` finds them: not linked to a record publication, and matching
  none by DOI or normalised title.

Filters: `year` is the publication year for papers and the payout year for
money (a ledger row carries no reliable publication year); `department` is the
author's account department, else the department the ledger row was filed
under. A head of department never reaches these: `/reports` refuses the role.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any, Optional

from django.db.models import F, Q
from django.db.models.functions import Coalesce

from core.services.record_dates import ledger_month_recorded
from core.models import Authorship, Claim, ClaimStatus, PaidLedger, Publication
from core.services.normalize import normalize_doi, normalize_title
from core.services.records import collect

NO_DEPARTMENT = "Department not recorded"


def _dept(value: Optional[str]) -> str:
    return (value or "").strip() or NO_DEPARTMENT


def _month_bounds(month: Optional[str]) -> Optional[tuple[int, int]]:
    if not month:
        return None
    y, m = (int(p) for p in month.split("-", 1))
    return y, m


def payments(year: Optional[int] = None, department: Optional[str] = None,
             month: Optional[str] = None) -> list[dict[str, Any]]:
    """Cached `_payments`: the same for every reader, rebuilt on any write."""
    from core.services.aggregate_cache import cached

    return cached("college_totals.payments", {"y": year, "d": department, "m": month},
                  lambda: _payments(year, department, month))


def _payments(year: Optional[int] = None, department: Optional[str] = None,
              month: Optional[str] = None) -> list[dict[str, Any]]:
    """Every payment once: {month (date), department, amount, owner_id, name}."""
    ledger = PaidLedger.objects.annotate(
        dept=Coalesce(F("claim__owner__department"), F("department")),
    )
    orphans = Claim.objects.filter(
        status=ClaimStatus.PAID, ledger_rows__isnull=True,
    )
    if year:
        ledger = ledger.filter(payout_month__year=year)
        orphans = orphans.filter(payout_month__year=year)
    if department:
        ledger = ledger.filter(dept__iexact=department)
        orphans = orphans.filter(owner__department__iexact=department)
    ym = _month_bounds(month)
    if ym:
        ledger = ledger.filter(payout_month__year=ym[0], payout_month__month=ym[1])
        orphans = orphans.filter(payout_month__year=ym[0], payout_month__month=ym[1])
    out = [
        {"month": r["payout_month"], "department": _dept(r["dept"]), "amount": r["amount"] or 0,
         "owner_id": r["claim__owner_id"], "name": r["claim__owner__name"] or r["faculty_name"],
         # The "Processed" sheet names no month; the one stored is the import's.
         "month_recorded": ledger_month_recorded(r["raw_json"])}
        for r in ledger.values("payout_month", "dept", "amount", "claim__owner_id",
                               "claim__owner__name", "faculty_name", "raw_json")
    ]
    out += [
        {"month": r["payout_month"], "department": _dept(r["owner__department"]),
         "amount": r["remuneration"] or 0, "owner_id": r["owner_id"], "name": r["owner__name"], "month_recorded": True}
        for r in orphans.values("payout_month", "owner__department", "remuneration",
                                "owner_id", "owner__name")
    ]
    return out


def payout_months() -> list[str]:
    """Every month with a payment on the ledger or a paid claim, newest first."""
    seen = {d.strftime("%Y-%m") for d in PaidLedger.objects.dates("payout_month", "month")}
    seen |= {
        d.strftime("%Y-%m")
        for d in Claim.objects.filter(status=ClaimStatus.PAID)
        .exclude(payout_month__isnull=True).dates("payout_month", "month")
    }
    return sorted(seen, reverse=True)


def papers(year: Optional[int] = None, department: Optional[str] = None) -> list[dict[str, Any]]:
    """Cached `_papers`. Reading every college authorship costs seconds on the
    real record; the answer is the same for every reader and any write moves
    the aggregate generation, so it is worked out once per change."""
    from core.services.aggregate_cache import cached

    return cached("college_totals.papers", {"y": year, "d": department},
                  lambda: _papers(year, department))


def _papers(year: Optional[int] = None, department: Optional[str] = None) -> list[dict[str, Any]]:
    """Every college paper once: {year, departments (set)}."""
    college = Q(is_college=True) | Q(user__isnull=False)
    depts: dict[str, set[str]] = defaultdict(set)
    years: dict[str, Optional[int]] = {}
    all_dois: set[str] = set()
    all_titles: set[str] = set()
    for pid, pyear, udept, doi, ntitle, title in Authorship.objects.filter(college).values_list(
        "publication_id", "publication__year", "user__department",
        "publication__doi", "publication__normalized_title", "publication__title",
    ):
        years[pid] = pyear
        if udept and udept.strip():
            depts[pid].add(udept.strip())
        depts[pid]  # every record paper gets an entry, departments or not
        d = normalize_doi(doi) if doi else None
        if d:
            all_dois.add(d)
        t = (ntitle or normalize_title(title or ""))[:512]
        if t:
            all_titles.add(t)

    out: list[dict[str, Any]] = []
    for pid, pyear in years.items():
        ds = depts[pid] or {NO_DEPARTMENT}
        out.append({"year": pyear, "departments": ds, "source": "record"})

    linked = set(Publication.claims.through.objects.filter(
        publication_id__in=list(years)).values_list("claim_id", flat=True))
    # Claim/ledger papers the record does not hold, once per paper.
    for r in collect(include_unmatched=True):
        if r.claim_id and r.claim_id in linked:
            continue
        if (r.doi and r.doi in all_dois) or (r.key and r.key[:512] in all_titles):
            continue
        if not r.key:
            continue
        all_titles.add(r.key[:512])
        if r.doi:
            all_dois.add(r.doi)
        out.append({"year": r.year, "departments": {_dept(r.department)}, "source": "claims"})

    if year:
        out = [p for p in out if p["year"] == year]
    if department:
        want = department.strip().casefold()
        out = [p for p in out if any(d.casefold() == want for d in p["departments"])]
    return out
