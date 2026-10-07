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

import re
from collections import Counter, defaultdict
from typing import Any, Callable, Optional

from django.db.models import F, Q
from django.db.models.functions import Coalesce

from core.services.record_dates import ledger_month_recorded
from core.models import Authorship, Claim, ClaimStatus, PaidLedger, Publication, User
from core.services.normalize import normalize_doi, normalize_title
from core.services.records import collect

NO_DEPARTMENT = "Department not recorded"


def _dept(value: Optional[str]) -> str:
    return (value or "").strip() or NO_DEPARTMENT


#: Stand-ins the workbooks use for "no department". They are not departments.
_NOT_A_DEPARTMENT = {"notfound", "none", "na", "nil", "unknown", "notrecorded", "departmentnotrecorded"}


def _dept_key(value: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9&]+", "", (value or "").casefold())


def canonical_departments() -> Callable[[Optional[str]], str]:
    """A function that maps any spelling of a department to the roll's own.

    The ledger and the claims spell departments as their workbook did: "Civil"
    and "CIVIL", "S&H - Maths" and "S&H-MATHS", and "Not Found" for nobody. Left
    alone, each spelling is its own row on the Principal's table with no
    teachers and a few papers, and the department it belongs to looks smaller.
    The spelling of the active people is the one kept.
    """
    spellings: dict[str, Counter] = defaultdict(Counter)
    for d in User.objects.filter(active=True).values_list("department", flat=True):
        d = (d or "").strip()
        if d and _dept_key(d) not in _NOT_A_DEPARTMENT:
            spellings[_dept_key(d)][d] += 1
    canon = {k: c.most_common(1)[0][0] for k, c in spellings.items()}

    def canonical(value: Optional[str]) -> str:
        v = (value or "").strip()
        k = _dept_key(v)
        if not v or k in _NOT_A_DEPARTMENT:
            return NO_DEPARTMENT
        return canon.get(k, v)

    return canonical


def _month_bounds(month: Optional[str]) -> Optional[tuple[int, int]]:
    if not month:
        return None
    y, m = (int(p) for p in month.split("-", 1))
    return y, m


def payments(year: Optional[int] = None, department: Optional[str] = None,
             month: Optional[str] = None) -> list[dict[str, Any]]:
    """Cached `_payments`: the same for every reader, rebuilt on any write."""
    from core.services.aggregate_cache import shared as cached

    return cached("college_totals.payments", {"y": year, "d": department, "m": month},
                  lambda: _payments(year, department, month))


def _payments(year: Optional[int] = None, department: Optional[str] = None,
              month: Optional[str] = None) -> list[dict[str, Any]]:
    """Every payment once: {month (date), department, amount, owner_id, name, staff_id}."""
    canon = canonical_departments()
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
    # `staff_id` lets a reader put a name to a historic row with no claim
    # behind it, by the rule `paper_facts` uses (case-insensitive staff id).
    out = [
        {"month": r["payout_month"], "department": canon(r["dept"]), "amount": r["amount"] or 0,
         "owner_id": r["claim__owner_id"], "name": r["claim__owner__name"] or r["faculty_name"],
         "staff_id": r["staff_id"] or "",
         # The "Processed" sheet names no month; the one stored is the import's.
         "month_recorded": ledger_month_recorded(r["raw_json"])}
        for r in ledger.values("payout_month", "dept", "amount", "claim__owner_id",
                               "claim__owner__name", "faculty_name", "staff_id", "raw_json")
    ]
    out += [
        {"month": r["payout_month"], "department": canon(r["owner__department"]),
         "amount": r["remuneration"] or 0, "owner_id": r["owner_id"], "name": r["owner__name"],
         "staff_id": r["owner__staff_id"] or "", "month_recorded": True}
        for r in orphans.values("payout_month", "owner__department", "remuneration",
                                "owner_id", "owner__name", "owner__staff_id")
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
    from core.services.aggregate_cache import shared as cached

    # One unfiltered copy shared by every filter: the filters below are the
    # same ones `_papers` applies last, and they cost milliseconds in Python.
    out = cached("college_totals.papers", {}, lambda: _papers(None, None))
    if year:
        out = [p for p in out if p["year"] == year]
    if department:
        want = canonical_departments()(department).casefold()
        out = [p for p in out if any(d.casefold() == want for d in p["departments"])]
    return out


def _papers(year: Optional[int] = None, department: Optional[str] = None) -> list[dict[str, Any]]:
    """Every college paper once: {year, departments (set)}."""
    canon = canonical_departments()
    college = Q(is_college=True) | Q(user__isnull=False)
    depts: dict[str, set[str]] = defaultdict(set)
    years: dict[str, Optional[int]] = {}
    all_dois: set[str] = set()
    all_titles: set[str] = set()
    quartiles: dict[str, str] = {}
    for pid, pyear, udept, doi, ntitle, title, pq in Authorship.objects.filter(college).values_list(
        "publication_id", "publication__year", "user__department",
        "publication__doi", "publication__normalized_title", "publication__title",
        "publication__quartile",
    ):
        years[pid] = pyear
        quartiles[pid] = (pq or "").strip().upper()
        if udept and udept.strip() and canon(udept) != NO_DEPARTMENT:
            depts[pid].add(canon(udept))
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
        q = quartiles.get(pid, "")
        out.append({"year": pyear, "departments": ds, "source": "record", "id": pid,
                    "quartile": q if q in ("Q1", "Q2", "Q3", "Q4") else ""})

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
        out.append({"year": r.year, "departments": {canon(r.department)}, "source": "claims",
                    "id": f"claim:{r.claim_id or r.key[:64]}", "quartile": r.quartile or "",
                    "title": r.title, "journal": r.journal, "author": r.author_name,
                    "author_id": r.user_id, "claim_id": r.claim_id, "doi": r.doi})

    if year:
        out = [p for p in out if p["year"] == year]
    if department:
        want = canonical_departments()(department).casefold()
        out = [p for p in out if any(d.casefold() == want for d in p["departments"])]
    return out
