"""What counts as one of a person's papers, decided once.

Badges, goals, the impact card and the wall of fame all ask the same question
-- which papers has this person published that the college recognises? -- and
four answers to it would drift apart within a month. This module is the one
answer. A paper is:

- **A claim the college has recognised**: authorised for payment, or paid
  (plus the old chain's FINANCE_APPROVED, which meant the same). Nothing
  earlier. To a claimant every step between filing and authorisation reads
  "Under review", on purpose (`core.visibility`); a badge that arrived when the
  Principal approved would tell them which desk their paper had just passed.
- **A row of the paid ledger with no claim behind it**, matched to its person
  by staff id, case-insensitively -- the rule `/api/me/payments` uses
  (`core.api.my_payments.ledger_for`). Almost all the history, 2024 onwards,
  came from the accounts workbook and exists only there.

The amount on a ledger row is never read. A zero-amount row is a paper the
college recorded all the same, and nothing built on these records may carry a
figure: they are what other people see.

The same paper recorded twice for one person -- the claim and an ERP row, or
two ERP rows -- is one paper. Papers are identified across people by their
normalised title (`normalize_title`), which is how the wall of fame groups
co-authors and how a cross-department collaboration is recognised.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Iterable, Optional

from django.db.models.functions import Lower
from django.utils import timezone

from core.models import Claim, ClaimStatus, PaidLedger, User
from core.services.normalize import normalize_doi, normalize_title

#: Statuses at which the college has recognised a paper. See the module note
#: for why nothing earlier is here.
RECOGNISED_STATUSES = (
    ClaimStatus.DIRECTOR_APPROVED,
    ClaimStatus.PAID,
    ClaimStatus.FINANCE_APPROVED,
)

#: The only quartiles there are. The workbook also says "Others", "No
#: Quartile", "-" and, once, "Q5"; none of those is a quartile.
QUARTILES = ("Q1", "Q2", "Q3", "Q4")

#: How a paper weighs in a ranking: Q1=4, Q2=3, Q3=2, Q4=1, and 1 for any
#: other recognised paper (every one of them is indexed somewhere, or the
#: college would not have recognised it). The same weights as the leaderboard.
POINTS = {"Q1": 4, "Q2": 3, "Q3": 2, "Q4": 1}

#: Excel counts days from 30 December 1899. The workbook stores about half its
#: publication dates that way ("45366.0").
_EXCEL_EPOCH = date(1899, 12, 30)
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
_YEAR = re.compile(r"\b((?:19|20)\d{2})\b")


@dataclass(frozen=True)
class PaperRecord:
    """One recognised paper of one person. Carries no money, by construction."""

    #: None for a ledger row whose staff id matches no account (somebody who
    #: has left): still a college paper for the wall, nobody's for a badge.
    user_id: Optional[str]
    author_name: str
    department: str
    #: The paper's identity across people: its normalised title.
    key: str
    title: str
    journal: str
    quartile: Optional[str]
    year: Optional[int]
    author_position: Optional[int]
    #: When the college recognised it: the payout month, or the day it was
    #: authorised.
    on: date
    #: When it was filed, as near as the record knows. A ledger row has only
    #: its payout month.
    filed_on: date
    claim_id: Optional[str]
    #: Scopus's "cited by" count when a verification stored one, else None.
    citations: Optional[int]
    doi: Optional[str]

    @property
    def points(self) -> int:
        return POINTS.get(self.quartile or "", 1)

    @property
    def first_author(self) -> bool:
        return self.author_position == 1


def quartile_of(value) -> Optional[str]:
    q = str(value or "").strip().upper()
    return q if q in QUARTILES else None


def year_of(value, fallback: Optional[int]) -> Optional[int]:
    """A publication year from whatever the workbook put in the cell."""
    s = str(value or "").strip()
    if not s:
        return fallback
    m = _ISO_DATE.match(s)
    if m:
        return int(m.group(1))
    try:
        serial = float(s)
    except ValueError:
        serial = None
    if serial is not None:
        # Only a plausible serial: 1955 to 2118. A bare "2024" is a year.
        if 20000 < serial < 80000:
            return (_EXCEL_EPOCH + timedelta(days=int(serial))).year
        if 1900 < serial < 2200:
            return int(serial)
        return fallback
    m = _YEAR.search(s)
    return int(m.group(1)) if m else fallback


def _position(value) -> Optional[int]:
    try:
        n = int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _citations(raw_json: Optional[str]) -> Optional[int]:
    """Scopus's `citedby-count`, from the entry a verification stored."""
    if not raw_json or "citedby" not in raw_json:
        return None
    try:
        raw = json.loads(raw_json)
    except ValueError:
        return None
    if not isinstance(raw, dict):
        return None
    value = raw.get("citedby-count")
    if value is None and isinstance(raw.get("coredata"), dict):
        value = raw["coredata"].get("citedby-count")
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _day(moment) -> Optional[date]:
    if moment is None:
        return None
    if isinstance(moment, datetime):
        if timezone.is_aware(moment):
            moment = timezone.localtime(moment)
        return moment.date()
    return moment


def _claim_record(c: dict, owner: User) -> PaperRecord:
    on = (
        c["payout_month"]
        or _day(c["paid_at"])
        or _day(c["director_approved_at"])
        or _day(c["updated_at"])
    )
    submitted = _day(c["submitted_at"])
    title = (c["paper_title"] or "").strip()
    return PaperRecord(
        user_id=owner.id,
        author_name=owner.name,
        department=(owner.department or "").strip(),
        key=normalize_title(title),
        title=title,
        journal=(c["journal_title"] or "").strip(),
        quartile=quartile_of(c["quartile"]),
        year=c["publication_year"],
        author_position=c["author_position"],
        on=on,
        filed_on=min(submitted, on) if submitted else on,
        claim_id=c["id"],
        citations=_citations(c["scopus_raw_json"]),
        doi=normalize_doi(c["doi"]),
    )


def _ledger_record(row: dict, owner: Optional[User]) -> PaperRecord:
    try:
        raw = json.loads(row["raw_json"] or "{}")
    except ValueError:
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    month = row["payout_month"]
    title = (row["paper_title"] or "").strip()
    return PaperRecord(
        user_id=owner.id if owner else None,
        author_name=owner.name if owner else (row["faculty_name"] or "").strip(),
        department=((owner.department if owner else row["department"]) or "").strip(),
        key=normalize_title(title),
        title=title,
        journal=(row["journal_title"] or raw.get("Source Title") or "").strip(),
        quartile=quartile_of(raw.get("SJR Quartile")),
        year=year_of(raw.get("Publication Date"), month.year if month else None),
        author_position=_position(raw.get("Author Position")),
        on=month,
        filed_on=month,
        claim_id=None,
        citations=None,
        doi=normalize_doi(raw.get("DOI")) if raw.get("DOI") not in (None, "-", "N/A") else None,
    )


_CLAIM_FIELDS = (
    "id", "owner_id", "paper_title", "journal_title", "quartile", "publication_year",
    "author_position", "doi", "payout_month", "paid_at", "director_approved_at",
    "submitted_at", "updated_at", "scopus_raw_json",
)
_LEDGER_FIELDS = (
    "staff_id", "faculty_name", "department", "paper_title", "journal_title",
    "payout_month", "raw_json",
)


def collect(
    users: Optional[Iterable[User]] = None, *, include_unmatched: bool = False
) -> list[PaperRecord]:
    """Every recognised paper of `users` (everybody when None), one per person.

    `include_unmatched` adds ledger rows whose staff id matches no account --
    the wall of fame shows those; a badge has nobody to go to.
    """
    people = list(users) if users is not None else list(User.objects.all())
    by_id = {u.id: u for u in people}
    by_staff: dict[str, list[User]] = defaultdict(list)
    for u in people:
        sid = (u.staff_id or "").strip().lower()
        if sid:
            by_staff[sid].append(u)

    found: list[PaperRecord] = []

    claims = Claim.objects.filter(status__in=RECOGNISED_STATUSES).exclude(paper_title__isnull=True)
    if users is not None:
        claims = claims.filter(owner_id__in=list(by_id))
    for c in claims.values(*_CLAIM_FIELDS):
        owner = by_id.get(c["owner_id"]) or User.objects.filter(pk=c["owner_id"]).first()
        if owner is not None and (c["paper_title"] or "").strip():
            found.append(_claim_record(c, owner))

    ledger = (
        PaidLedger.objects.filter(claim__isnull=True)
        .exclude(paper_title__isnull=True)
        .exclude(paper_title="")
        .annotate(sid=Lower("staff_id"))
    )
    if users is not None and not include_unmatched:
        ledger = ledger.filter(sid__in=list(by_staff))
    for row in ledger.values(*_LEDGER_FIELDS, "sid"):
        if row["payout_month"] is None:
            continue
        owners = by_staff.get((row["sid"] or "").strip())
        if owners:
            found.extend(_ledger_record(row, owner) for owner in owners)
        elif include_unmatched:
            found.append(_ledger_record(row, None))

    return _one_per_person(found)


def _one_per_person(found: list[PaperRecord]) -> list[PaperRecord]:
    """Drop the second recording of a paper a person already has.

    A claim is kept over a ledger row for the same paper, because it knows
    more (the author position, the claim to link to).
    """
    found.sort(key=lambda r: (r.claim_id is None, r.on, r.title))
    seen_keys: dict[object, set[str]] = defaultdict(set)
    seen_dois: dict[object, set[str]] = defaultdict(set)
    kept: list[PaperRecord] = []
    for r in found:
        who = r.user_id or ("unmatched", r.author_name.lower())
        if not r.key or r.key in seen_keys[who] or (r.doi and r.doi in seen_dois[who]):
            continue
        seen_keys[who].add(r.key)
        if r.doi:
            seen_dois[who].add(r.doi)
        kept.append(r)
    kept.sort(key=lambda r: (r.on, r.title))
    return kept


def paper_records(users: Optional[Iterable[User]] = None) -> dict[str, list[PaperRecord]]:
    """Each person's recognised papers, oldest first, keyed by user id."""
    people = list(users) if users is not None else None
    grouped: dict[str, list[PaperRecord]] = defaultdict(list)
    for r in collect(people):
        if r.user_id:
            grouped[r.user_id].append(r)
    for u in people or ():
        grouped.setdefault(u.id, [])
    return grouped
