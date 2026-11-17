"""The Top 5 boards: cumulative SNIP, incentive paid, and papers settled.

Built from the college's settled history, not from a new definition of it:

* **The ledger** (`PaidLedger`) is what the college has paid. A `PAYMENT` row
  is one paper settled for one person, including a zero-amount row, which is a
  paper the college counts but paid nothing for. The person is read from the
  staff id exactly as `paper_facts` and `my_payments.ledger_for` read it
  (`staff_key`: no spaces, one case), and a row whose claim is in the app is
  that claim's owner's.
* **A payment that was voided** (a `REVERSAL` for the same claim and cycle)
  is not a settled paper and its money is not paid, so both are left out.
* **Paid claims** (`Claim` in `PAID`) that the ledger does not already hold,
  by claim or by the same person and normalised title, are added from the
  claim's own `remuneration` and `snip`.

For each person: count is distinct papers (normalised title, as the importer
and the leaderboard identify a paper), remuneration is the sum of the amounts
paid, and cumulative SNIP is the SNIP of those distinct papers, read from the
ledger row's `raw_json` ("SNIP Value") or the claim's `snip`; a value that is
not a number adds nothing.

A staff id nobody in the app holds is kept, under the name the ledger carries.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from datetime import date
from typing import Any

from django.conf import settings
from django.utils import timezone

from core.management.commands.rebuild_from_erp import num
from core.models import Claim, ClaimStatus, PaidLedger, User
from core.services.fyp_roster import staff_key
from core.services.normalize import normalize_title

PERIODS = ("all", "year", "month")
SIZE = 5
LISTS = ("snip", "remuneration", "count")


def today() -> date:
    return timezone.localdate()


def window(period: str, year: int | None, on: date) -> tuple[date | None, date | None, str]:
    """(first day, last day, label) of a period. All time has no bounds."""
    if period == "month":
        end = date(on.year + (on.month == 12), on.month % 12 + 1, 1)
        return date(on.year, on.month, 1), end, on.strftime("%B %Y")
    if period == "year":
        from core.api.my_payments import academic_year_start  # the college's 1 June rule

        start = date(year, 6, 1) if year else academic_year_start(on)
        return start, date(start.year + 1, 6, 1), f"Academic year {start.year}-{str(start.year + 1)[2:]}"
    return None, None, "All time"


def _snip(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        n = float(value)
    else:
        n = num(value)
    return n if n is not None and math.isfinite(n) else None


def _raw_snip(raw_json: str | None) -> float | None:
    if not raw_json or "SNIP" not in raw_json:
        return None
    try:
        row = json.loads(raw_json)
    except (ValueError, TypeError):
        return None
    return _snip(row.get("SNIP Value")) if isinstance(row, dict) else None


class _Person:
    __slots__ = ("key", "user_id", "name", "department", "papers", "amount")

    def __init__(self, key: str, user_id: str | None, name: str, department: str):
        self.key, self.user_id, self.name, self.department = key, user_id, name, department
        self.papers: dict[str, float | None] = {}  # normalised title -> SNIP
        self.amount = 0.0

    def add(self, title: str, snip: float | None, amount: float, count: bool = True) -> None:
        if count:
            if title not in self.papers or self.papers[title] is None:
                self.papers[title] = snip if snip is not None else self.papers.get(title)
        self.amount += amount


def people(on: date, period: str = "all", year: int | None = None) -> list[dict[str, Any]]:
    """Every person with something settled in the period: totals, unranked."""
    start, end, _label = window(period, year, on)

    def inside(d: date | None) -> bool:
        return start is None or (d is not None and start <= d < end)

    users = {u.pk: u for u in User.objects.all().only("id", "name", "department", "staff_id", "photo")}
    by_staff: dict[str, str | None] = {}
    for u in users.values():
        k = staff_key(u.staff_id)
        if k:
            # Two people sharing a staff id is a data fault: neither is credited.
            by_staff[k] = None if k in by_staff else u.pk

    found: dict[str, _Person] = {}

    def person(user_id: str | None, staff: str, name: str, dept: str) -> _Person | None:
        if user_id and user_id in users:
            u = users[user_id]
            key, name, dept = f"u:{u.pk}", u.name or name, (u.department or dept or "").strip()
            hit = found.get(key)
            if hit is None:
                hit = found[key] = _Person(key, u.pk, name, dept)
            return hit
        key = f"s:{staff}" if staff else (f"n:{name.casefold()}" if name else "")
        if not key:
            return None
        hit = found.get(key)
        if hit is None:
            hit = found[key] = _Person(key, None, name, dept)
        return hit

    rows = list(
        PaidLedger.objects.order_by("payout_month", "created_at").values(
            "id", "kind", "claim_id", "claim__owner_id", "cycle", "staff_id", "faculty_name",
            "department", "paper_title", "amount", "payout_month", "raw_json",
        )
    )
    voided = {(r["claim_id"], r["cycle"]) for r in rows if r["kind"] == PaidLedger.Kind.REVERSAL and r["claim_id"]}
    in_ledger_claims: set[str] = set()
    seen_titles: set[tuple[str, str]] = set()

    for r in rows:
        if r["kind"] == PaidLedger.Kind.REVERSAL:
            continue
        if r["claim_id"] and (r["claim_id"], r["cycle"]) in voided:
            continue
        staff = staff_key(r["staff_id"])
        owner = r["claim__owner_id"] if r["claim_id"] else by_staff.get(staff)
        who = person(owner, staff, (r["faculty_name"] or "").strip(), (r["department"] or "").strip())
        if who is None:
            continue
        title = normalize_title(r["paper_title"]) or f"row:{r['id']}"
        if r["claim_id"]:
            in_ledger_claims.add(r["claim_id"])
        seen_titles.add((who.key, title))
        if not inside(r["payout_month"]):
            continue
        counted = r["kind"] == PaidLedger.Kind.PAYMENT
        who.add(title, _raw_snip(r["raw_json"]) if counted else None, float(r["amount"] or 0), counted)

    claims = Claim.objects.filter(status=ClaimStatus.PAID).values(
        "id", "owner_id", "paper_title", "remuneration", "snip", "payout_month", "paid_at"
    )
    for c in claims.iterator(chunk_size=2000):
        if c["id"] in in_ledger_claims:
            continue
        who = person(c["owner_id"], "", "", "")
        if who is None:
            continue
        title = normalize_title(c["paper_title"]) or f"claim:{c['id']}"
        if (who.key, title) in seen_titles:
            continue
        paid_on = c["payout_month"] or (timezone.localtime(c["paid_at"]).date() if c["paid_at"] else None)
        if not inside(paid_on):
            continue
        who.add(title, _snip(c["snip"]), float(c["remuneration"] or 0))

    out = []
    for p in found.values():
        if not p.papers and not p.amount:
            continue
        out.append({
            "user_id": p.user_id,
            "staff_id": (users[p.user_id].staff_id if p.user_id else p.key[2:] if p.key.startswith("s:") else None),
            "name": p.name,
            "department": p.department,
            "photo": (f"{settings.MEDIA_URL}{users[p.user_id].photo}" if p.user_id and users[p.user_id].photo else None),
            "snip": round(sum(v for v in p.papers.values() if v is not None), 2),
            "remuneration": round(p.amount, 2),
            "count": len(p.papers),
        })
    return out


def top(everyone: list[dict[str, Any]], *, department: str = "", money: bool = True) -> dict[str, Any]:
    """The three lists of five, ties broken by name."""
    want = department.strip().casefold()
    pool = [p for p in everyone if not want or (p["department"] or "").strip().casefold() == want]
    out: dict[str, Any] = {}
    for name in LISTS:
        if name == "remuneration" and not money:
            out[name] = None
            continue
        ranked = sorted(
            (p for p in pool if p[name] > 0),
            key=lambda p: (-p[name], (p["name"] or "").casefold()),
        )[:SIZE]
        out[name] = [
            {
                "rank": i + 1,
                "user_id": p["user_id"],
                "staff_id": p["staff_id"],
                "name": p["name"],
                "department": p["department"] or None,
                "photo": p["photo"],
                "value": p[name],
            }
            for i, p in enumerate(ranked)
        ]
    return out
