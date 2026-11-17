"""Standings: cumulative SNIP, incentive paid and papers settled for any faculty member.

The Top 5 shows five people; this shows everybody, and how each number is made.
Both read `core.services.top5`, one pass that makes a person's totals as the
sums of the papers behind them, so a figure here is never a different figure
from the board's.

Who may ask
-----------
* **The office, the Principal, the Director, Finance, the Super admin** (and a
  Vice principal role, should the college add one): everybody.
* **A head of department**: their own department, and *never* an incentive.
  Every field that carries money is left out, not nulled, and so is whether a
  paper was paid or only counted (`counted_in`).
* **Faculty**: their own row and their own papers, and their own place in the
  college's order. Nobody else's name, number or paper.

Ranks are `1` for the best, ties broken by name (the order the Top 5 uses),
and nobody with a zero under a measure is ranked on it. They are ranked within
what the reader is looking at: the college, the department filter, or the
head's own department. A faculty member's rank is their place in the college.
"""

from __future__ import annotations

from typing import Any, Optional

from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import Role, User
from core.services import rbac, top5
from core.services.search.money import may_see_money

SORTS = ("snip", "remuneration", "count", "name", "department")
MAX_PAGE_SIZE = 2000

#: Written the way the college says it: what each number is, in one paragraph.
RULES = (
    "A paper is counted once, however many times it was paid or listed: papers are told apart by their title, "
    "ignoring capitals and punctuation. Papers settled is the number of those papers, and it includes a paper "
    "the college counted but paid nothing for. The incentive is the sum of the amounts paid for the papers in "
    "this period; a payment that was voided is not counted. SNIP is the sum of the SNIP of those papers, read "
    "from the settled sheet, or from the claim when the sheet has none; a paper with no SNIP number adds 0. "
    "A month or a year means the month the money was paid."
)

VICE_PRINCIPAL = getattr(Role, "VICE_PRINCIPAL", None)


def _scope(user: User) -> str:
    """`college`, `department` or `self`: how much of the college this reader is shown."""
    if rbac.can_view_college_wide(user.role) or (VICE_PRINCIPAL and user.role == VICE_PRINCIPAL):
        return "college"
    if user.role == Role.HOD:
        if not (user.department or "").strip():
            raise HttpError(403, "Your account has no department yet.")
        return "department"
    return "self"


def _period(period: str, year: Optional[int], month: Optional[str]) -> None:
    if period not in top5.PERIODS:
        raise HttpError(400, "Choose all time, a year or a month.")
    if year is not None and not 1990 <= year <= 2100:
        raise HttpError(400, "Give the year as four digits.")
    if month:
        try:
            top5.parse_month(month)
        except ValueError:
            raise HttpError(400, "Give the month as YYYY-MM, for example 2026-09.") from None


def _meta(sp: top5.Span) -> dict[str, Any]:
    return {"period": sp.period, "label": sp.label, "month": sp.month, "year": sp.year, "academic": sp.academic}


def _row(p: dict[str, Any], rank: dict[str, dict[str, int]], money: bool) -> dict[str, Any]:
    row = {
        "key": p["key"],
        "rank_snip": rank["snip"].get(p["key"]),
        "rank_count": rank["count"].get(p["key"]),
        "user_id": p["user_id"],
        "staff_id": p["staff_id"],
        "name": p["name"],
        "department": p["department"] or None,
        "designation": p["designation"],
        "photo": p["photo"],
        "snip": p["snip"],
        "count": p["count"],
    }
    if money:
        row["rank_remuneration"] = rank["remuneration"].get(p["key"])
        row["remuneration"] = p["remuneration"]
    return row


def _totals(pool: list[dict[str, Any]], money: bool) -> dict[str, Any]:
    out: dict[str, Any] = {
        "snip": round(sum(p["snip"] for p in pool), 2),
        "count": sum(p["count"] for p in pool),
    }
    if money:
        out["remuneration"] = round(sum(p["remuneration"] for p in pool), 2)
    return out


def _read(user: User, period: str, year, month, academic: bool, department: str):
    """The people the reader may see, the ranks they hold, and the period: one place for the rules."""
    scope = _scope(user)
    money = may_see_money(user.role)
    on = top5.today()
    rec, sp = top5.resolve(on, period, year, month, academic)
    everyone = top5.cards(rec, sp)
    mine = f"u:{user.pk}"
    dept = (department or "").strip()
    if scope == "department":
        own = (user.department or "").strip()
        if dept.casefold() not in ("", own.casefold()):
            raise HttpError(403, "You can see your own department only.")
        dept = own
    if scope == "self":
        # Their place is their place in the college; nobody else's row leaves this function.
        rank = top5.ranks(everyone, money)
        row = next((p for p in everyone if p["key"] == mine), None) or top5.zero_card(user)
        pool = [row]
        return scope, money, rec, sp, pool, rank, dept, on
    pool = top5.in_department(everyone + top5.idle({p["key"] for p in everyone}), dept)
    rank = top5.ranks(pool, money)
    return scope, money, rec, sp, pool, rank, dept, on


@api.get("/dashboard/standings", auth=session_auth)
def dashboard_standings(
    request: HttpRequest,
    period: str = "all",
    month: Optional[str] = None,
    year: Optional[int] = None,
    academic: bool = True,
    department: str = "",
    q: str = "",
    sort: str = "snip",
    dir: str = "",
    page: int = 1,
    page_size: int = 50,
):
    """Everybody's cumulative SNIP, incentive paid and papers settled for a period.

    `period` is `all`, `year` (the academic year starting 1 June of `year`, or
    the calendar year when `academic` is false) or `month` (`YYYY-MM`, the
    latest month with payments when omitted); months and years are by month
    paid. `q` finds a name or staff id. `sort` is snip, remuneration, count,
    name or department, best first unless `dir=asc`.
    """
    user = require_user(request)
    _period(period, year, month)
    if sort not in SORTS:
        raise HttpError(400, f"Sort by one of: {', '.join(SORTS)}.")
    scope, money, rec, sp, pool, rank, dept, on = _read(user, period, year, month, academic, department)
    if sort == "remuneration" and not money:
        raise HttpError(403, "Incentive is not shown to your role.")
    direction = dir if dir in ("asc", "desc") else ("asc" if sort in ("name", "department") else "desc")

    text = q.strip().casefold()
    shown = [
        p for p in pool
        if not text or text in (p["name"] or "").casefold() or text in (p["staff_id"] or "").casefold()
    ]

    def name(p):
        return ((p["name"] or "").casefold(), p["key"])

    if sort in ("name", "department"):
        key = (lambda p: ((p["department"] or "~").casefold(), *name(p))) if sort == "department" else name
        shown.sort(key=key, reverse=direction == "desc")
    else:
        sign = -1 if direction == "desc" else 1
        shown.sort(key=lambda p: (sign * p[sort], *name(p)))

    page_size = max(1, min(int(page_size), MAX_PAGE_SIZE))
    page = max(1, int(page))
    window = shown[(page - 1) * page_size : page * page_size]
    return {
        **_meta(sp),
        "scope": scope,
        "money": money,
        "department": dept or None,
        "generated_at": timezone.now().isoformat(),
        "choices": top5.choices(rec, on),
        "page": page,
        "page_size": page_size,
        "total": len(shown),
        "totals": _totals(pool, money),
        "rows": [_row(p, rank, money) for p in window],
    }


def _paper(p: top5.Paper, money: bool) -> dict[str, Any]:
    row: dict[str, Any] = {
        "title": p.title,
        "journal": p.journal,
        "issn": p.issn,
        "doi": p.doi,
        "month_paid": p.month_paid.isoformat() if p.month_paid else None,
        "snip": p.snip,
        "snip_source": p.snip_source,
        "duplicate_of": p.duplicate_of,
        "counted": p.counts,
    }
    if money:
        row["amount"] = p.amount
        row["counted_in"] = p.counted_in
        row["paid_again"] = p.paid_again
    return row


@api.get("/dashboard/standings/{user_id}/papers", auth=session_auth)
def dashboard_standing_papers(
    request: HttpRequest,
    user_id: str,
    period: str = "all",
    month: Optional[str] = None,
    year: Optional[int] = None,
    academic: bool = True,
):
    """The papers behind one person's numbers, and the three sums, so they can be checked by hand.

    Every row is one settled payment or paid claim. `snip` and `amount` are what
    the row adds to the totals, so each total is the sum of its column; `counted`
    says whether the row adds one to the papers settled (a repeat of a title does
    not, and says which paper it repeats in `duplicate_of`). `{user_id}` is a
    person's id, or the `key` a row carries for someone who left no account.
    """
    user = require_user(request)
    _period(period, year, month)
    scope = _scope(user)
    money = may_see_money(user.role)
    key = user_id if user_id[:2] in ("s:", "n:") else f"u:{user_id}"

    person = None if key[:2] != "u:" else get_object_or_404(User, pk=key[2:])
    if scope == "self" and key != f"u:{user.pk}":
        raise HttpError(403, "You can see your own papers only.")
    on = top5.today()
    rec, sp = top5.resolve(on, period, year, month, academic)
    who = rec.people.get(key)
    if scope == "department":
        own = (user.department or "").strip().casefold()
        theirs = ((person.department if person else who.department) if (person or who) else "") or ""
        if own != theirs.strip().casefold():
            raise HttpError(403, "You can see your own department only.")
    if person is None and who is None:
        raise HttpError(404, "Nobody by that id has anything settled.")

    standing = top5.settle(rec, sp).get(key)
    papers = standing.papers if standing else []
    card = top5.card(
        standing or top5.Standing(who or top5.Who(key, person.pk, person.staff_id, person.name, person.department or "")),
        top5.users_by_id(),
    )
    totals = _totals([card], money)
    out: dict[str, Any] = {
        **_meta(sp),
        "money": money,
        "person": {
            "user_id": card["user_id"], "key": key, "staff_id": card["staff_id"], "name": card["name"],
            "department": card["department"] or None, "designation": card["designation"], "photo": card["photo"],
        },
        "papers": [_paper(p, money) for p in papers],
        "totals": totals,
        "rules": RULES,
    }
    if money:
        out["voided"] = [
            {"title": v["title"], "month_paid": v["month_paid"].isoformat() if v["month_paid"] else None,
             "amount": v["amount"]}
            for v in top5.voided_in(rec, key, sp)
        ]
    return out


__all__ = ["dashboard_standings", "dashboard_standing_papers"]
