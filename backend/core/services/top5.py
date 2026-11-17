"""The Top 5 boards and the standings: cumulative SNIP, incentive paid, and papers settled.

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
paid (a paper the college paid twice counts once and is paid in full both
times; `paid_more_than_once` counts such papers), and cumulative SNIP is the SNIP of those distinct papers, read from the
ledger row's `raw_json` ("SNIP Value") or the claim's `snip`; a value that is
not a number adds nothing. A correction row's SNIP is only a hint: it fills a
paper whose payment row carries none.

One pass makes both the totals and the papers behind them. `settle()` returns,
for each person, the list of papers (`Paper`) and the three totals are *sums of
that list*, so the Top 5, the standings and the "how this is counted" page can
never disagree: a person can add the columns of their own breakdown and reach
the number on the board.

* `Paper.amount` adds to the incentive, whatever the row is.
* `Paper.snip` is what the row adds to the SNIP total: the paper's SNIP on the
  row that supplied it, and 0 on a repeat of that paper or a paper with no
  number.
* A row adds to the count unless it is a repeat (`duplicate_of` is set) or a
  correction, which moves money and never counts a paper.

A staff id nobody in the app holds is kept, under the name the ledger carries.

Money-blind roles (a head of department) never receive a `remuneration` key;
the callers leave it out, they do not null it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from django.conf import settings
from django.utils import timezone

from core.models import Claim, ClaimStatus, PaidLedger, User
from core.services import paper_fields
from core.services.fyp_roster import staff_key
from core.services.normalize import normalize_title

PERIODS = ("all", "year", "month")
SIZE = 5
LISTS = ("snip", "remuneration", "count")

#: Where a paper's SNIP came from, in the words a person reads.
FROM_SHEET = "settled sheet"
FROM_CLAIM = "claim"
FROM_NOTHING = "none"

#: What a row is counted as.
PAID = "paid"
COUNT_ONLY = "count only"
CORRECTION = "correction"


def today() -> date:
    return timezone.localdate()


# ------------------------------------------------------------------ periods --


@dataclass(frozen=True)
class Span:
    """A period resolved to dates: `start <= payout month < end`, or all time."""

    period: str
    start: date | None
    end: date | None
    label: str
    month: str | None = None  # "2026-09" for a month
    year: int | None = None  # the first year of an academic year, or the calendar year
    academic: bool = True

    def holds(self, d: date | None) -> bool:
        return self.start is None or (d is not None and self.start <= d < self.end)


def parse_month(text: str) -> date:
    """"2026-09" as the first day of that month. Raises ValueError otherwise."""
    y, m = text.strip().split("-")
    if len(y) != 4:
        raise ValueError(text)
    return date(int(y), int(m), 1)


def span(
    period: str,
    on: date,
    *,
    year: int | None = None,
    month: str | None = None,
    academic: bool = True,
    latest: date | None = None,
) -> Span:
    """The dates of a period.

    * `month`: the named month, else the latest month the college paid in (else
      the month of `on`). Months are by payout month.
    * `year`: the academic year (1 June to 31 May) starting in `year`, the
      current one when omitted; or, with `academic` false, the calendar year.
    * `all`: no bounds.
    """
    if period == "month":
        first = parse_month(month) if month else (latest or date(on.year, on.month, 1))
        first = first.replace(day=1)
        end = date(first.year + (first.month == 12), first.month % 12 + 1, 1)
        return Span("month", first, end, first.strftime("%B %Y"), first.strftime("%Y-%m"))
    if period == "year":
        if not academic:
            y = year or on.year
            return Span("year", date(y, 1, 1), date(y + 1, 1, 1), f"Calendar year {y}", None, y, False)
        from core.api.my_payments import academic_year_start  # the college's 1 June rule

        start = date(year, 6, 1) if year else academic_year_start(on)
        return Span(
            "year", start, date(start.year + 1, 6, 1),
            f"Academic year {start.year}-{str(start.year + 1)[2:]}", None, start.year, True,
        )
    return Span("all", None, None, "All time")


def window(period: str, year: int | None, on: date) -> tuple[date | None, date | None, str]:
    """(first day, last day, label) of a period. All time has no bounds."""
    s = span(period, on, year=year)
    return s.start, s.end, s.label


# -------------------------------------------------------------- the numbers --


#: One SNIP rule for the boards, the resolver and the Report studio.
_snip = paper_fields.parse_snip
_raw_snip = paper_fields.raw_snip


def _raw(raw_json: str | None) -> dict | None:
    """The settled sheet's row, when it holds anything this module reads."""
    if not raw_json:
        return None
    low = raw_json.lower()
    if "snip" not in low and "issn" not in low and "doi" not in low:
        return None
    try:
        row = json.loads(raw_json)
    except (ValueError, TypeError):
        return None
    return row if isinstance(row, dict) else None


_EMPTY = {"", "nan", "none", "null", "-", "n/a"}


def _raw_text(row: dict | None, *names: str) -> str | None:
    if not row:
        return None
    wanted = {n.casefold() for n in names}
    for k, v in row.items():
        if isinstance(k, str) and k.strip().casefold() in wanted and v is not None:
            text = str(v).strip()
            if text.casefold() not in _EMPTY:
                return text[:512]
    return None


@dataclass(slots=True)
class Who:
    key: str
    user_id: str | None
    staff_id: str | None
    name: str
    department: str


@dataclass(slots=True)
class Line:
    """One settled row, before any period is applied."""

    who: str  # Who.key
    title_key: str
    title: str
    journal: str | None
    issn: str | None
    doi: str | None
    month: date | None
    snip: float | None
    snip_source: str
    amount: float
    kind: str  # PAID, COUNT_ONLY or CORRECTION
    counts: bool  # settles a paper (a payment or a paid claim), as against a correction
    voided: bool = False


@dataclass(slots=True)
class Record:
    """Everything settled, all time: the one read of the ledger and the claims."""

    people: dict[str, Who]
    lines: list[Line]  # in the order they are counted: the ledger by month, then claims
    latest: date | None  # the latest month with a payment
    voided: list[Line] = field(default_factory=list)  # payments voided: shown, never counted


def _build() -> Record:
    users = {u.pk: u for u in User.objects.all().only("id", "name", "department", "staff_id")}
    by_staff: dict[str, str | None] = {}
    for u in users.values():
        k = staff_key(u.staff_id)
        if k:
            # Two people sharing a staff id is a data fault: neither is credited.
            by_staff[k] = None if k in by_staff else u.pk

    found: dict[str, Who] = {}

    def person(user_id: str | None, staff: str, name: str, dept: str) -> Who | None:
        if user_id and user_id in users:
            u = users[user_id]
            key = f"u:{u.pk}"
            hit = found.get(key)
            if hit is None:
                hit = found[key] = Who(key, u.pk, u.staff_id or None, u.name or name, (u.department or dept or "").strip())
            return hit
        key = f"s:{staff}" if staff else (f"n:{name.casefold()}" if name else "")
        if not key:
            return None
        hit = found.get(key)
        if hit is None:
            hit = found[key] = Who(key, None, staff or None, name, dept)
        return hit

    rows = list(
        PaidLedger.objects.order_by("payout_month", "created_at").values(
            "id", "kind", "claim_id", "claim__owner_id", "cycle", "staff_id", "faculty_name",
            "department", "paper_title", "journal_title", "amount", "payout_month", "raw_json",
            "claim__snip", "claim__issn", "claim__doi", "claim__journal_title",
        )
    )
    voided = {(r["claim_id"], r["cycle"]) for r in rows if r["kind"] == PaidLedger.Kind.REVERSAL and r["claim_id"]}
    gone: list[Line] = []
    in_ledger_claims: set[str] = set()
    seen_titles: set[tuple[str, str]] = set()
    lines: list[Line] = []

    for r in rows:
        if r["kind"] == PaidLedger.Kind.REVERSAL:
            continue
        if r["claim_id"] and (r["claim_id"], r["cycle"]) in voided:
            if r["kind"] == PaidLedger.Kind.PAYMENT:
                who = person(r["claim__owner_id"], staff_key(r["staff_id"]), (r["faculty_name"] or "").strip(),
                             (r["department"] or "").strip())
                if who is not None:
                    gone.append(Line(
                        who.key, "", (r["paper_title"] or "").strip() or "Title not recorded", None, None, None,
                        r["payout_month"], None, FROM_NOTHING, float(r["amount"] or 0), PAID, True, True,
                    ))
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
        counted = r["kind"] == PaidLedger.Kind.PAYMENT
        amount = float(r["amount"] or 0)
        snip, source = None, FROM_NOTHING
        raw = _raw(r["raw_json"])
        snip = _raw_snip(r["raw_json"])
        if snip is not None:
            source = FROM_SHEET
        elif r["claim_id"]:
            # A claim paid through the ledger keeps its own SNIP when the row has none.
            snip = _snip(r["claim__snip"])
            if snip is not None:
                source = FROM_CLAIM
        lines.append(Line(
            who=who.key, title_key=title,
            title=(r["paper_title"] or "").strip() or "Title not recorded",
            journal=(r["journal_title"] or r["claim__journal_title"] or "").strip() or None,
            issn=(r["claim__issn"] or _raw_text(raw, "ISSN", "ISSN No", "ISSN Number") or "").strip() or None,
            doi=(r["claim__doi"] or _raw_text(raw, "DOI", "DOI Number") or "").strip() or None,
            month=r["payout_month"], snip=snip, snip_source=source, amount=amount,
            kind=(CORRECTION if not counted else (COUNT_ONLY if not amount else PAID)),
            counts=counted,
        ))

    claims = (
        Claim.objects.filter(status=ClaimStatus.PAID)
        .order_by("payout_month", "paid_at", "id")
        .values(
            "id", "owner_id", "paper_title", "journal_title", "issn", "doi", "remuneration", "snip",
            "payout_month", "paid_at",
        )
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
        snip = _snip(c["snip"])
        amount = float(c["remuneration"] or 0)
        lines.append(Line(
            who=who.key, title_key=title, title=(c["paper_title"] or "").strip() or "Title not recorded",
            journal=(c["journal_title"] or "").strip() or None,
            issn=(c["issn"] or "").strip() or None, doi=(c["doi"] or "").strip() or None,
            month=paid_on, snip=snip, snip_source=FROM_CLAIM if snip is not None else FROM_NOTHING,
            amount=amount, kind=PAID if amount else COUNT_ONLY, counts=True,
        ))

    paid_months = [ln.month for ln in lines if ln.counts and ln.month]
    return Record(found, lines, max(paid_months) if paid_months else None, gone)


def record() -> Record:
    """The whole settled record, worked out once and shared until something is written."""
    from core.services.aggregate_cache import shared

    return shared("top5-record", {}, _build)


@dataclass(slots=True)
class Paper:
    """One row behind a person's numbers."""

    title: str
    journal: str | None
    issn: str | None
    doi: str | None
    month_paid: date | None
    snip: float  # what this row adds to the SNIP total
    snip_source: str
    amount: float  # what this row adds to the incentive
    counted_in: str
    duplicate_of: str | None
    counts: bool  # adds one to the paper count
    paid_again: bool = False  # a paper the college paid more than once: this row is one of those payments


@dataclass(slots=True)
class Standing:
    who: Who
    papers: list[Paper] = field(default_factory=list)
    paid_more_than_once: int = 0  # papers counted once above, paid for in full more than once

    @property
    def snip(self) -> float:
        return round(sum(p.snip for p in self.papers), 2)

    @property
    def remuneration(self) -> float:
        return round(sum(p.amount for p in self.papers), 2)

    @property
    def count(self) -> int:
        return sum(1 for p in self.papers if p.counts)


def settle(rec: Record, sp: Span) -> dict[str, Standing]:
    """Every person with something settled in the period, and the papers behind each total.

    A paper is counted once per period: the first row for a normalised title
    counts, later rows for it are marked `duplicate_of` and add no paper. The
    SNIP of a paper is the first number among its rows; a correction row's SNIP
    only fills a paper whose payment rows have none. Money always adds, and a
    paper paid more than once is counted once and has every payment marked
    `paid_again`.
    """
    out: dict[str, Standing] = {}
    first: dict[tuple[str, str], str] = {}  # (person, title) -> the title as first counted
    supplied: set[tuple[str, str]] = set()  # papers whose SNIP is already taken
    head: dict[tuple[str, str], Paper] = {}  # the row that counted each paper
    hint: dict[tuple[str, str], tuple[float, str]] = {}  # SNIP read off a correction row
    paid: dict[tuple[str, str], list[Paper]] = {}  # the rows with money on them, per paper
    for ln in rec.lines:
        if not sp.holds(ln.month):
            continue
        who = rec.people[ln.who]
        slot = out.get(who.key)
        if slot is None:
            slot = out[who.key] = Standing(who)
        mark = (who.key, ln.title_key)
        counts, dup, snip, source = False, None, 0.0, FROM_NOTHING
        if not ln.counts and ln.snip is not None:
            hint.setdefault(mark, (ln.snip, ln.snip_source))
        if ln.counts:
            if mark in first:
                dup = first[mark]
            else:
                first[mark] = ln.title
                counts = True
            if ln.snip is not None and mark not in supplied:
                supplied.add(mark)
                snip, source = ln.snip, ln.snip_source
        row = Paper(ln.title, ln.journal, ln.issn, ln.doi, ln.month, snip, source, ln.amount, ln.kind, dup, counts)
        slot.papers.append(row)
        if counts:
            head[mark] = row
        if ln.counts and ln.amount > 0:
            paid.setdefault(mark, []).append(row)
    for mark, (snip, source) in hint.items():
        row = head.get(mark)
        if row is not None and mark not in supplied:
            row.snip, row.snip_source = snip, source
    for (key, _), rows in paid.items():
        if len(rows) > 1:
            out[key].paid_more_than_once += 1
            for row in rows:
                row.paid_again = True
    for slot in out.values():
        slot.papers.sort(key=lambda p: (p.month_paid or date.min))  # stable: ties keep counting order
    return {k: v for k, v in out.items() if v.papers and (v.count or v.remuneration)}


def voided_in(rec: Record, key: str, sp: Span) -> list[dict[str, Any]]:
    """The person's payments that were voided in the period: listed so they can be seen, never counted."""
    return [
        {"title": ln.title, "month_paid": ln.month, "amount": ln.amount}
        for ln in rec.voided
        if ln.who == key and sp.holds(ln.month)
    ]


def resolve(on: date, period: str = "all", year: int | None = None, month: str | None = None,
            academic: bool = True) -> tuple[Record, Span]:
    rec = record()
    return rec, span(period, on, year=year, month=month, academic=academic, latest=rec.latest)


def card(standing: Standing, users: dict[str, Any]) -> dict[str, Any]:
    who = standing.who
    u = users.get(who.user_id) if who.user_id else None
    return {
        "key": who.key,
        "user_id": who.user_id,
        "staff_id": (u.staff_id if u else who.staff_id),
        "name": (u.name if u and u.name else who.name),
        "department": (u.department if u and u.department else who.department) or "",
        "designation": (u.designation if u else None) or None,
        "photo": (f"{settings.MEDIA_URL}{u.photo}" if u and u.photo else None),
        "snip": standing.snip,
        "remuneration": standing.remuneration,
        "count": standing.count,
        "paid_more_than_once": standing.paid_more_than_once,
    }


def users_by_id() -> dict[str, User]:
    return {u.pk: u for u in User.objects.all().only("id", "name", "department", "staff_id", "photo", "designation")}


def people(on: date, period: str = "all", year: int | None = None, month: str | None = None,
           academic: bool = True) -> list[dict[str, Any]]:
    """Every person with something settled in the period: totals, unranked."""
    rec, sp = resolve(on, period, year, month, academic)
    return cards(rec, sp)


def cards(rec: Record, sp: Span) -> list[dict[str, Any]]:
    users = users_by_id()
    return [card(s, users) for s in settle(rec, sp).values()]


def choices(rec: Record, on: date) -> dict[str, Any]:
    """What a period picker offers: the months paid in, and the years around them, newest first."""
    months = sorted({ln.month.replace(day=1) for ln in rec.lines if ln.month}, reverse=True)
    from core.api.my_payments import academic_year_start

    academic = {academic_year_start(m).year for m in months} | {academic_year_start(on).year}
    calendar = {m.year for m in months} | {on.year}
    return {
        "months": [m.strftime("%Y-%m") for m in months],
        "academic_years": sorted(academic, reverse=True),
        "calendar_years": sorted(calendar, reverse=True),
    }


def totals_by_user(on: date) -> dict[str, dict[str, dict[str, Any]]]:
    """Every matched person's all-time and this-academic-year totals, for a record page or a directory column."""
    from core.services.aggregate_cache import shared

    def work():
        return {
            name: {p["user_id"]: p for p in people(on, period) if p["user_id"]}
            for name, period in (("all", "all"), ("year", "year"))
        }

    return shared("top5-totals", {"day": on.isoformat()}, work)


def standing_of(user_id: str, every: dict[str, dict[str, dict[str, Any]]], *, money: bool) -> dict[str, Any]:
    """One person's three numbers, all time and this academic year, out of `totals_by_user`.

    No incentive unless `money`. The caller reads `totals_by_user` once and passes it in,
    because a shared figure is copied out of the cache each time it is asked for.
    """
    out: dict[str, Any] = {}
    for name in ("all", "year"):
        p = every[name].get(user_id)
        block: dict[str, Any] = {"snip": p["snip"] if p else 0.0, "count": p["count"] if p else 0}
        if money:
            block["remuneration"] = p["remuneration"] if p else 0.0
        out[name] = block
    return out


def breakdown(on: date, key: str, period: str = "all", year: int | None = None, month: str | None = None,
              academic: bool = True) -> tuple[Span, Standing | None]:
    """The papers behind one person's numbers, from the same pass as `people`."""
    rec, sp = resolve(on, period, year, month, academic)
    return sp, settle(rec, sp).get(key)


def zero_card(u: User) -> dict[str, Any]:
    """A person with nothing settled in the period, read as zero rather than missing."""
    return {
        "key": f"u:{u.pk}", "user_id": u.pk, "staff_id": u.staff_id or None, "name": u.name,
        "department": (u.department or "").strip(), "designation": u.designation or None,
        "photo": f"{settings.MEDIA_URL}{u.photo}" if u.photo else None,
        "snip": 0.0, "remuneration": 0.0, "count": 0, "paid_more_than_once": 0,
    }


def idle(have: set[str]) -> list[dict[str, Any]]:
    """Current faculty with nothing settled in the period, so they can be found and read as zero."""
    from core.services import rbac

    return [
        zero_card(u)
        for u in User.objects.filter(role__in=rbac.CLAIMANT_ROLES, active=True).only(
            "id", "name", "department", "staff_id", "photo", "designation"
        )
        if f"u:{u.pk}" not in have
    ]


# ------------------------------------------------------------------ ranking --


def ranked(pool: list[dict[str, Any]], metric: str) -> list[dict[str, Any]]:
    """Who has something under `metric`, best first, ties broken by name. The one order."""
    return sorted(
        (p for p in pool if p[metric] > 0),
        key=lambda p: (-p[metric], (p["name"] or "").casefold(), p["key"]),
    )


def ranks(pool: list[dict[str, Any]], money: bool = True) -> dict[str, dict[str, int]]:
    """metric -> person key -> rank (1 is best). Nobody with nothing is ranked."""
    out: dict[str, dict[str, int]] = {}
    for metric in LISTS:
        if metric == "remuneration" and not money:
            continue
        out[metric] = {p["key"]: i + 1 for i, p in enumerate(ranked(pool, metric))}
    return out


def in_department(pool: list[dict[str, Any]], department: str) -> list[dict[str, Any]]:
    want = (department or "").strip().casefold()
    return [p for p in pool if not want or (p["department"] or "").strip().casefold() == want]


def top(everyone: list[dict[str, Any]], *, department: str = "", money: bool = True) -> dict[str, Any]:
    """The three lists of five. A money-blind reader gets two: the key is left out."""
    pool = in_department(everyone, department)
    out: dict[str, Any] = {}
    for name in LISTS:
        if name == "remuneration" and not money:
            # Omitted, not nulled: the money-blind roles never get the key at all.
            continue
        out[name] = [
            {
                "rank": i + 1,
                "user_id": p["user_id"],
                "staff_id": p["staff_id"],
                "name": p["name"],
                "department": p["department"] or None,
                "photo": p["photo"],
                "value": p[name],
                # The money list only: it says which of the money is for a paper paid again.
                **({"paid_more_than_once": p["paid_more_than_once"]} if name == "remuneration" else {}),
            }
            for i, p in enumerate(ranked(pool, name)[:SIZE])
        ]
    return out
