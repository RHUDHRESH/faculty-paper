"""One record per person per paper, from everything the college holds.

Two sources describe the college's publications, and neither is enough alone:

- **Claims** -- papers filed through this app. They carry the author order,
  a verified quartile and a status, but there are only a few dozen of them.
- **The ledger's historic rows** -- ~3,000 papers imported from the accounts
  workbook, with no claim behind them. They are most of the record. The
  model has no quartile column for them, but every row keeps the workbook row
  it came from in ``raw_json``, and that row has the SJR quartile, the
  publication date, the DOI, the indexing status and the subject areas. So
  they are read from there rather than counted as quartile-less.

Rules, each of them a place the numbers could quietly go wrong:

- **What counts.** A claim counts once it is filed -- under review, approved
  or paid -- and not as a draft or once rejected. A ledger row counts when it
  has no claim (a row with a claim is that claim's payment, already counted).
- **Whose it is.** A claim is its owner's. A ledger row is the person whose
  staff id it carries, compared case-insensitively -- the same rule
  ``my_payments.ledger_for`` uses, and for the same reason biometric ids are
  not trusted. Only people on the current roster (active faculty and heads of
  department) are credited; rows for anybody else are counted in
  ``left_out`` so a screen can say how many, rather than dropping them.
- **One paper is one paper.** Identity is the DOI where there is one and the
  normalised title otherwise, resolved across *both* keys: a claim with a DOI
  and a DOI-less ledger copy of it under the same title are one paper. A
  person is credited once per paper; a claim wins over a ledger row, because
  it knows the author order.
- **When.** The publication date. A year on its own counts from 1 January;
  a ledger row with no date counts from the month the college recorded it.

No money is read. The ledger's amount column and the claims' remuneration are
never selected, so nothing built from these records can leak one.

Built in three queries (roster, claims, ledger) and kept for five minutes:
a board or a suggestion list is arithmetic over the result.

Kept in this process rather than in Django's cache. The only cache configured
is the per-process memory one anyway, and it pickles: reading 2,700 records
back out of it cost 60 ms on a laptop -- the better part of a second on the
free plan's tenth of a CPU, on every page view -- to return an object this
process already had. Gunicorn runs one worker, so one memo is the deployment.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from django.utils import timezone

from core.management.commands.rebuild_from_erp import BLANKISH, s as _cell, when as _when
from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.services.normalize import normalize_doi, normalize_title
from core.services.trends import split_subjects

KEEP_SECONDS = 300

#: Who is ranked and credited: the people who write papers.
RANKED_ROLES = (Role.FACULTY, Role.HOD)

#: A claim in either of these is not a paper the college has.
NOT_COUNTED = (ClaimStatus.DRAFT, ClaimStatus.REJECTED)

QUARTILES = frozenset({"Q1", "Q2", "Q3", "Q4"})


@dataclass(frozen=True, slots=True)
class Person:
    id: str
    name: str
    department: str
    designation: str
    role: str


@dataclass(frozen=True, slots=True)
class Fact:
    """One paper, credited to one person."""

    person_id: str
    #: The paper's identity, shared by everybody credited with it.
    key: str
    title: str
    journal: str
    quartile: str | None
    indexed: bool
    published: date | None
    #: None where the source never recorded author order (the ledger).
    first_author: bool | None
    subjects: tuple[str, ...]
    source: str  # "claim" | "ledger"


@dataclass(frozen=True)
class Facts:
    people: dict[str, Person]
    facts: tuple[Fact, ...]
    from_claims: int
    from_ledger: int
    #: Rows describing a paper by somebody not on the roster.
    left_out: int
    built_at: datetime


_MEMO: tuple[float, Facts] | None = None
_MEMO_LOCK = threading.Lock()


def load() -> Facts:
    """The facts, as built within the last five minutes."""
    global _MEMO
    now = time.monotonic()
    memo = _MEMO
    if memo is not None and memo[0] > now:
        return memo[1]
    with _MEMO_LOCK:
        # Somebody else may have built it while this request waited.
        if _MEMO is not None and _MEMO[0] > time.monotonic():
            return _MEMO[1]
        built = build()
        _MEMO = (time.monotonic() + KEEP_SECONDS, built)
        return built


def forget() -> None:
    global _MEMO
    with _MEMO_LOCK:
        _MEMO = None


# --------------------------------------------------------------------------- #
# Reading one row                                                             #
# --------------------------------------------------------------------------- #


def _quartile(text: Any) -> str | None:
    q = (str(text or "")).strip().upper()
    return q if q in QUARTILES else None


#: Where the stored subject strings were cut, measured on the live data: the
#: ledger's "Subject Area" cells stop at 100 characters (1,068 rows sit at
#: exactly 100, ending in fragments like "Signal Processing ("), and the
#: claims' `subject_category` column at its 255-character limit.
LEDGER_SUBJECT_CUT = 100
CLAIM_CATEGORY_CUT = 255


def _areas(raw: Any, *, cut: int | None = None) -> tuple[str, ...]:
    text = str(raw or "")
    parts = text.split(";")
    # A string at its cut length ends in a fragment unless the cut happened
    # to land just after a whole "(Q1)". A fragment is dropped, not guessed.
    if cut and len(text) >= cut and not parts[-1].strip().endswith(")"):
        text = ";".join(parts[:-1])
    # "-" and "N/A" are the workbook's ways of saying nothing, not areas --
    # the same spellings the importer treats as blank.
    return tuple(
        area
        for area, _q in split_subjects(text)
        if any(ch.isalpha() for ch in area) and area.strip().casefold() not in BLANKISH
    )


def _as_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    parsed = _when(value)
    return parsed.date() if parsed else None


def _claim_date(published: Any, year: Any, submitted: Any, created: Any) -> date | None:
    found = _as_date(published)
    if found:
        return found
    if isinstance(year, int) and 1900 < year < 2200:
        return date(year, 1, 1)
    return _as_date(submitted) or _as_date(created)


def _claim_indexed(level: Any, status: Any, quartile: str | None) -> bool:
    said = (str(status or "")).strip().lower()
    if said.startswith("not"):
        return False
    return bool((str(level or "")).strip() or said or quartile)


class _Identity:
    """Paper identity across DOIs and titles, so either one finds the other.

    A title joins two rows only when that does not contradict a DOI: a claim
    with a DOI and a DOI-less ledger copy of it are one paper, but a
    conference paper and its journal version -- same title, two DOIs -- are
    two. Rows without any DOI still meet on title alone; that is the only
    identity they have.
    """

    def __init__(self) -> None:
        self._by_doi: dict[str, str] = {}
        self._by_title: dict[str, list[str]] = {}
        self._doi_of: dict[str, str | None] = {}

    def of(self, doi: Any, title: Any, fallback: str) -> str:
        d = normalize_doi(str(doi)) if doi and _cell(doi) else None
        t = normalize_title(str(title or ""))
        key = self._by_doi.get(d) if d else None
        if key is None and t:
            for candidate in self._by_title.get(t, ()):
                bound = self._doi_of.get(candidate)
                if d is None or bound is None or bound == d:
                    key = candidate
                    break
        if key is None:
            key = f"doi:{d}" if d else (f"title:{t}" if t else f"row:{fallback}")
            if key in self._doi_of:
                key = f"{key}#{fallback}"
            self._doi_of[key] = None
        if d:
            self._by_doi.setdefault(d, key)
            if self._doi_of.get(key) is None:
                self._doi_of[key] = d
        if t and key not in self._by_title.setdefault(t, []):
            self._by_title[t].append(key)
        return key


# --------------------------------------------------------------------------- #
# The build                                                                   #
# --------------------------------------------------------------------------- #


def build() -> Facts:
    people: dict[str, Person] = {}
    by_staff_id: dict[str, str | None] = {}
    for pk, name, department, designation, role, staff_id in User.objects.filter(
        active=True, role__in=RANKED_ROLES
    ).values_list("id", "name", "department", "designation", "role", "staff_id"):
        people[pk] = Person(
            id=pk,
            name=name or "",
            department=(department or "").strip(),
            designation=designation or "",
            role=role,
        )
        sid = (staff_id or "").strip().casefold()
        if sid:
            # Two people sharing a staff id is a data fault; neither is
            # credited with the other's rows.
            by_staff_id[sid] = None if sid in by_staff_id else pk

    identity = _Identity()
    credited: dict[tuple[str, str], Fact] = {}
    left_out = 0

    claims = (
        Claim.objects.exclude(status__in=NOT_COUNTED)
        .values_list(
            "id", "owner_id", "doi", "paper_title", "journal_title", "quartile",
            "indexing_level", "indexing_status", "publication_date", "publication_year",
            "submitted_at", "created_at", "author_position", "subjects_json",
            "subject_category",
        )
        .iterator(chunk_size=2000)
    )
    for (
        pk, owner_id, doi, title, journal, quartile, level, status, published, year,
        submitted, created, position, subjects, category,
    ) in claims:
        if owner_id not in people:
            left_out += 1
            continue
        q = _quartile(quartile)
        key = identity.of(doi, title, f"claim:{pk}")
        credited.setdefault(
            (owner_id, key),
            Fact(
                person_id=owner_id,
                key=key,
                title=(title or "").strip(),
                journal=(journal or "").strip(),
                quartile=q,
                indexed=_claim_indexed(level, status, q),
                published=_claim_date(published, year, submitted, created),
                first_author=None if position is None else position == 1,
                subjects=_areas(subjects) if subjects else _areas(category, cut=CLAIM_CATEGORY_CUT),
                source="claim",
            ),
        )

    ledger = (
        PaidLedger.objects.filter(claim__isnull=True)
        .values_list("id", "staff_id", "paper_title", "journal_title", "payout_month", "raw_json")
        .iterator(chunk_size=2000)
    )
    for pk, staff_id, title, journal, month, raw_json in ledger:
        person_id = by_staff_id.get((staff_id or "").strip().casefold())
        if not person_id:
            left_out += 1
            continue
        try:
            row = json.loads(raw_json or "{}")
        except (json.JSONDecodeError, TypeError):
            row = {}
        if not isinstance(row, dict):
            row = {}
        title = title or _cell(row.get("Scopus Article Title"))
        key = identity.of(_cell(row.get("DOI")), title, f"ledger:{pk}")
        if (person_id, key) in credited:
            continue
        indexing = (_cell(row.get("Indexing Status")) or "").lower()
        credited[(person_id, key)] = Fact(
            person_id=person_id,
            key=key,
            title=(title or "").strip(),
            journal=(journal or _cell(row.get("Source Title")) or "").strip(),
            quartile=_quartile(_cell(row.get("SJR Quartile"))),
            indexed=not indexing.startswith("not"),
            published=_as_date(row.get("Publication Date")) or _as_date(month),
            first_author=None,
            subjects=_areas(row.get("Subject Area"), cut=LEDGER_SUBJECT_CUT),
            source="ledger",
        )

    facts = tuple(credited.values())
    return Facts(
        people=people,
        facts=facts,
        from_claims=sum(1 for f in facts if f.source == "claim"),
        from_ledger=sum(1 for f in facts if f.source == "ledger"),
        left_out=left_out,
        built_at=timezone.now(),
    )
