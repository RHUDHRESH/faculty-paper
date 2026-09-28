"""Scopus author profiles, read out of the office's profile workbook.

A sheet per author. What is on each, as the college's workbook lays it out:

- "Scopus ID" in A1, the id in B1;
- a Metric | Value table at the left (Author Name, Scopus Author ID,
  Affiliation, Total Publications, Total Citations, H-Index) and a second one
  far to the right (Total Publications, Total Citations, Average Citations per
  Paper), with a Year | Publications table under it;
- the author's document list, under a header row starting Year | Title.

Nothing here depends on those tables being at those cells. Each is found by
its heading, so a sheet with the right-hand table moved, or a metric added,
is read the same way; every Metric | Value pair is kept, not only the ones
with a column of their own.

Profiles are linked to accounts by Scopus id -- the account's own, or the one
the faculty master carries for the account's staff id -- and never by name. A
name is only used by the verification report, to point out an account whose
stored id differs from the sheet named after them.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import IO, Any

from django.db import transaction
from django.utils import timezone

from core.management.commands.import_erp_excel import _id, _s
from core.models import AuditLog, Authorship, FacultyMaster, Role, ScopusProfile, User
from core.services.fyp_roster import staff_key
from core.services.normalize import normalize_issn
from core.services.publications import _Index
from core.services.scopus_profile import record_rows
from core.services.scopus import author_profile_url, extract_author_id

#: The roles whose accounts are expected to carry a Scopus id.
FACULTY_ROLES = (Role.FACULTY, Role.HOD)

#: Words in a name that are titles, not the name.
_TITLES = {
    "mr", "mrs", "ms", "miss", "dr", "prof", "professor", "er", "shri", "sri",
    "smt", "thiru", "tmt",
}


class ProfileWorkbookError(ValueError):
    """The file is not a profile workbook this importer can read. Says why."""


@dataclass
class ParsedProfile:
    sheet: str
    scopus_id: str | None
    author_name: str | None
    affiliation: str | None
    total_publications: int | None
    total_citations: int | None
    h_index: int | None
    metrics: dict[str, Any] = field(default_factory=dict)
    documents: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ---- cells ------------------------------------------------------------------


def normalize_scopus_id(value: Any) -> str | None:
    """A Scopus author id as the digits it is, from whatever held it.

    A float from a spreadsheet (57527550200.0), the same float as text, or a
    profile link with `authorId=` in it. Anything that does not come out as
    digits is not an id.
    """
    text = _id(value)
    if not text:
        return None
    found = _id(extract_author_id(text))
    return found if found and found.isascii() and found.isdigit() else None


def _plain(value: Any) -> Any:
    """A cell as something JSON can hold, with whole-number floats as ints."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    if isinstance(value, (int, str)):
        return value.strip() if isinstance(value, str) else value
    if isinstance(value, (datetime, date)):
        # A page range such as "1-13" that Excel took for a date. Kept as the
        # date it became, as text: guessing the range back is not safe.
        return value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    return str(value)


def _int(value: Any) -> int | None:
    plain = _plain(value)
    if isinstance(plain, int) and not isinstance(plain, bool):
        return plain if plain >= 0 else None
    try:
        number = float(str(plain).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return int(number) if number >= 0 and number.is_integer() else None


def _label(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _squash(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


# ---- reading a sheet -------------------------------------------------------


def _cell(rows: list[tuple], r: int, c: int) -> Any:
    return rows[r][c] if 0 <= r < len(rows) and 0 <= c < len(rows[r]) else None


def _headed(rows: list[tuple], left: str, right: str) -> list[tuple[int, int]]:
    """Every (row, column) whose cell reads `left` with `right` beside it."""
    return [
        (r, c)
        for r, row in enumerate(rows)
        for c, v in enumerate(row)
        if _squash(v) == left and _squash(_cell(rows, r, c + 1)) == right
    ]


def _pairs_below(rows: list[tuple], r: int, c: int) -> list[tuple[Any, Any]]:
    out = []
    for rr in range(r + 1, len(rows)):
        key = _cell(rows, rr, c)
        if key is None or not str(key).strip():
            break
        out.append((key, _cell(rows, rr, c + 1)))
    return out


def _metric(metrics: dict[str, Any], *names: str) -> Any:
    wanted = {_squash(n) for n in names}
    for key, value in metrics.items():
        if _squash(key) in wanted:
            return value
    return None


def _read_documents(rows: list[tuple]) -> list[dict[str, Any]]:
    found = _headed(rows, "year", "title")
    if not found:
        return []
    r, c = found[0]
    headers: list[str] = []
    while _label(_cell(rows, r, c + len(headers))):
        headers.append(_label(_cell(rows, r, c + len(headers))))
    docs = []
    for rr in range(r + 1, len(rows)):
        values = [_cell(rows, rr, c + i) for i in range(len(headers))]
        if not any(v is not None and str(v).strip() for v in values):
            break
        doc = {h: _plain(v) for h, v in zip(headers, values, strict=True)}
        for key in list(doc):
            if _squash(key) == "issn" and doc[key] is not None:
                doc[key] = normalize_issn(str(doc[key])) or str(doc[key])
        docs.append(doc)
    return docs


def read_sheet(title: str, rows: list[tuple]) -> ParsedProfile | None:
    """One profile, or None when the sheet carries no Scopus id at all."""
    metrics: dict[str, Any] = {}
    warnings: list[str] = []
    for r, c in _headed(rows, "metric", "value"):
        for key, value in _pairs_below(rows, r, c):
            label = _label(key)
            if label not in metrics:
                metrics[label] = _plain(value)
    by_year: dict[str, int] = {}
    for r, c in _headed(rows, "year", "publications"):
        for year, n in _pairs_below(rows, r, c):
            y, count = _int(year), _int(n)
            if y is not None and count is not None:
                by_year[str(y)] = count
    if by_year:
        metrics["Publications by year"] = by_year

    # "Scopus ID" at the head of the sheet, with the id beside it.
    header_id = next(
        (
            normalize_scopus_id(_cell(rows, r, c + 1))
            for r, row in enumerate(rows[:5])
            for c, v in enumerate(row)
            if _squash(v) == "scopusid"
        ),
        None,
    )
    metric_id = normalize_scopus_id(_metric(metrics, "Scopus Author ID"))
    if header_id and metric_id and header_id != metric_id:
        warnings.append(
            f"Sheet {title!r}: the Scopus ID at the top ({header_id}) and the one in "
            f"the table ({metric_id}) differ; the one at the top was used."
        )
    scopus_id = header_id or metric_id
    if not scopus_id:
        return None

    return ParsedProfile(
        sheet=title,
        scopus_id=scopus_id,
        author_name=_s(_metric(metrics, "Author Name"), 255),
        affiliation=_s(_metric(metrics, "Affiliation"), 512),
        total_publications=_int(_metric(metrics, "Total Publications", "Documents")),
        total_citations=_int(_metric(metrics, "Total Citations", "Citations")),
        h_index=_int(_metric(metrics, "H-Index", "h index", "hindex")),
        metrics=metrics,
        documents=_read_documents(rows),
        warnings=warnings,
    )


def read_profiles(source: str | IO[bytes]) -> list[ParsedProfile]:
    """Every profile in the workbook, in sheet order. Touches no database."""
    import openpyxl

    try:
        wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    except Exception as exc:  # a CSV, a PDF, a truncated upload
        raise ProfileWorkbookError(
            "That file is not an Excel workbook (.xlsx). Upload the Scopus "
            "profile workbook itself."
        ) from exc
    try:
        profiles = [
            p
            for ws in wb.worksheets
            if (p := read_sheet(ws.title, list(ws.iter_rows(values_only=True)))) is not None
        ]
    finally:
        wb.close()
    if not profiles:
        raise ProfileWorkbookError(
            "No sheet in that workbook carries a Scopus ID, so it is not the "
            "Scopus profile workbook."
        )
    return profiles


# ---- which account is whose ---------------------------------------------------


def _own_ids(user: User) -> set[str]:
    return {
        i
        for i in (
            normalize_scopus_id(user.scopus_author_id),
            normalize_scopus_id(user.scopus_author_url),
        )
        if i
    }


def account_index() -> dict[str, list[User]]:
    """Scopus id -> the accounts that carry it.

    An account's own id (the stored id, or the one in its profile link) is
    what it is matched on. The faculty master's id for its staff id is used
    only for an account that carries no id of its own -- the same rule as
    `ids_for` -- so a stale id left in the master cannot give somebody a
    second profile beside their own. Deactivated accounts are dropped
    wherever an active one carries the same id.
    """
    direct: dict[str, list[User]] = {}
    by_staff: dict[str, list[User]] = {}
    for user in User.objects.all():
        own = _own_ids(user)
        for sid in own:
            direct.setdefault(sid, []).append(user)
        if user.staff_id and not own:
            by_staff.setdefault(staff_key(user.staff_id), []).append(user)
    index = dict(direct)
    for fm in FacultyMaster.objects.exclude(scopus_author_id__isnull=True).exclude(
        scopus_author_id=""
    ):
        sid = normalize_scopus_id(fm.scopus_author_id)
        if not sid or sid in direct or not fm.staff_id:
            continue
        for user in by_staff.get(staff_key(fm.staff_id), []):
            if user not in index.setdefault(sid, []):
                index[sid].append(user)
    for sid, users in index.items():
        active = [u for u in users if u.active]
        if active and len(active) < len(users):
            index[sid] = active
    return index


def ids_for(user: User) -> set[str]:
    """The Scopus ids that are this person's: their own, else the master's.

    The master is matched on staff id the way `account_index` matches it
    (`staff_key`: no spaces, one case), so a person's page and their
    department's totals cannot disagree about whose id it is.
    """
    own = _own_ids(user)
    if own or not user.staff_id:
        return own
    key = staff_key(user.staff_id)
    return {
        sid
        for staff_id, raw in FacultyMaster.objects.exclude(scopus_author_id__isnull=True)
        .exclude(scopus_author_id="")
        .values_list("staff_id", "scopus_author_id")
        if staff_id and staff_key(staff_id) == key and (sid := normalize_scopus_id(raw))
    }


def profile_for(user: User) -> ScopusProfile | None:
    """The profile for the id this person carries now.

    Not the link recorded at import time: after the office corrects an id,
    that link points at somebody else's profile until the next import, and
    showing it would present another author's citations as this person's.
    """
    ids = ids_for(user)
    if not ids:
        return None
    return ScopusProfile.objects.filter(scopus_id__in=ids).order_by("-imported_at").first()


def profile_dict(profile: ScopusProfile | None) -> dict[str, Any] | None:
    """What a screen shows of a profile. Figures only; no money anywhere."""
    if profile is None:
        return None
    return {
        "scopus_id": profile.scopus_id,
        "url": author_profile_url(profile.scopus_id),
        "author_name": profile.author_name,
        "affiliation": profile.affiliation,
        "publications": profile.total_publications,
        "citations": profile.total_citations,
        "h_index": profile.h_index,
        "publications_by_year": (profile.metrics or {}).get("Publications by year") or {},
        # The papers themselves live in the publication record, not here.
        "documents_listed": (
            Authorship.objects.filter(user_id=profile.user_id).count() if profile.user_id else 0
        ),
        "source_sheet": profile.source_sheet,
        "imported_at": profile.imported_at.isoformat() if profile.imported_at else None,
    }


def linked_profiles() -> list[tuple[User, ScopusProfile]]:
    """Each profile with the one account it belongs to, matched now.

    A profile whose id matches no account, or more than one, is left out:
    counting it towards a department would be a guess. The document list and
    the raw metrics are not loaded -- every caller wants three integers.
    """
    index = account_index()
    out = []
    for profile in ScopusProfile.objects.defer("metrics"):
        users = index.get(profile.scopus_id, [])
        if len(users) == 1:
            out.append((users[0], profile))
    return out


def department_totals(department: str | None = None) -> list[dict[str, Any]]:
    """Scopus publications and citations per department, from linked profiles.

    The department's current faculty: active accounts in the faculty roles,
    the same people its head sees listed. A leaver's career does not count
    towards the department they left.
    """
    rows: dict[str, dict[str, Any]] = {}
    for user, profile in linked_profiles():
        if not user.active or user.role not in FACULTY_ROLES:
            continue
        dept = (user.department or "").strip() or "No department"
        if department and dept.casefold() != department.strip().casefold():
            continue
        slot = rows.setdefault(
            dept.casefold(),
            {"department": dept, "people_with_profile": 0, "publications": 0, "citations": 0,
             "highest_h_index": None},
        )
        slot["people_with_profile"] += 1
        slot["publications"] += profile.total_publications or 0
        slot["citations"] += profile.total_citations or 0
        if profile.h_index is not None:
            slot["highest_h_index"] = max(slot["highest_h_index"] or 0, profile.h_index)
    return sorted(rows.values(), key=lambda r: (-r["citations"], r["department"]))


# ---- importing ---------------------------------------------------------------


def import_profiles(
    profiles: list[ParsedProfile], *, actor: User | None = None, source_file: str | None = None
) -> dict[str, Any]:
    """Create or update a profile per sheet, keyed by Scopus id, and link it."""
    index = account_index()
    now = timezone.now()
    created = updated = 0
    linked = 0
    unmatched: list[dict[str, Any]] = []
    ambiguous: list[dict[str, Any]] = []
    warnings: list[str] = [w for p in profiles for w in p.warnings]

    record_index = _Index()
    papers_matched = papers_added = 0
    with transaction.atomic():
        for p in profiles:
            users = index.get(p.scopus_id, [])
            user = users[0] if len(users) == 1 else None
            summary = {"scopus_id": p.scopus_id, "sheet": p.sheet, "author_name": p.author_name}
            if user is not None:
                linked += 1
            elif users:
                ambiguous.append({**summary, "accounts": sorted(u.name for u in users)})
            else:
                unmatched.append(summary)
            _, was_created = ScopusProfile.objects.update_or_create(
                scopus_id=p.scopus_id,
                defaults={
                    "user": user,
                    "author_name": p.author_name,
                    "affiliation": p.affiliation,
                    "total_publications": p.total_publications,
                    "total_citations": p.total_citations,
                    "h_index": p.h_index,
                    "metrics": p.metrics,
                    "source_sheet": p.sheet[:255],
                    "source_file": (source_file or "")[:255] or None,
                    "imported_at": now,
                },
            )
            created += was_created
            updated += not was_created
            if user is not None and p.documents:
                record = record_rows(user, p.documents, record_index)
                papers_matched += record["matched_existing"]
                papers_added += record["created"]

        result = {
            "sheets": len(profiles),
            "created": created,
            "updated": updated,
            "linked": linked,
            "papers_matched": papers_matched,
            "papers_added": papers_added,
            "unmatched": unmatched,
            "ambiguous": ambiguous,
            "warnings": warnings,
        }
        AuditLog.objects.create(
            actor=actor,
            action="SCOPUS_PROFILES_IMPORT",
            entity="ScopusProfile",
            detail_json=json.dumps({
                "file": source_file, "sheets": len(profiles), "created": created,
                "updated": updated, "linked": linked, "unmatched": len(unmatched),
                "ambiguous": len(ambiguous),
            }),
        )
    return result


# ---- the office's verification report -------------------------------------------


def name_key(name: str | None) -> tuple[str, ...]:
    """A name as a set of words, titles dropped: "Mr. S. Joyal Isac" and
    "Joyal Isac S" come out the same."""
    words = re.findall(r"[a-z]+", (name or "").lower())
    return tuple(sorted(w for w in words if w not in _TITLES))


def _account_named(sheet: str, people: list[User]) -> User | None:
    """The one account the sheet's name is, or None when that is not certain.

    Tried with initials and then without them; either way it must be exactly
    one account, or the sheet is treated as naming nobody.
    """
    key = name_key(sheet)
    if len(key) < 2:
        return None
    for strip_initials in (False, True):
        want = tuple(w for w in key if len(w) > 1) if strip_initials else key
        if len(want) < 2:
            continue
        hits = [
            u
            for u in people
            if (
                tuple(w for w in name_key(u.name) if len(w) > 1)
                if strip_initials
                else name_key(u.name)
            )
            == want
        ]
        if len(hits) == 1:
            return hits[0]
        if len(hits) > 1:
            return None
    return None


def _person_row(user: User) -> dict[str, Any]:
    return {
        "user_id": user.id,
        "name": user.name,
        "email": user.email,
        "department": user.department,
        "staff_id": user.staff_id,
    }


def verification_report() -> dict[str, Any]:
    """What the office has to put right, as three lists it can work through.

    - Profiles whose Scopus id matches no account (or more than one).
    - Faculty accounts that carry no Scopus id at all, with the faculty
      master's id beside them where it has one -- the likely fix.
    - Accounts whose stored id differs from the profile on the sheet named
      after them. Only where the sheet's name picks out exactly one account;
      a sheet such as "General" names nobody and is not guessed at.
    """
    index = account_index()
    profiles = list(ScopusProfile.objects.all().order_by("source_sheet"))
    faculty = list(User.objects.filter(role__in=FACULTY_ROLES, active=True).order_by("name"))

    without_account, ambiguous = [], []
    for p in profiles:
        users = index.get(p.scopus_id, [])
        row = {
            "scopus_id": p.scopus_id,
            "url": author_profile_url(p.scopus_id),
            "sheet": p.source_sheet,
            "author_name": p.author_name,
            "publications": p.total_publications,
            "citations": p.total_citations,
        }
        if not users:
            without_account.append(row)
        elif len(users) > 1:
            ambiguous.append({**row, "accounts": [_person_row(u) for u in users]})

    master_ids: dict[str, str] = {}
    for staff_id, sid in FacultyMaster.objects.exclude(scopus_author_id__isnull=True).values_list(
        "staff_id", "scopus_author_id"
    ):
        norm = normalize_scopus_id(sid)
        if staff_id and norm:
            master_ids[staff_key(staff_id)] = norm
    without_scopus = [
        {**_person_row(u), "faculty_master_scopus_id": master_ids.get(staff_key(u.staff_id))}
        for u in faculty
        if not _own_ids(u)
    ]

    mismatches = []
    for p in profiles:
        named = _account_named(p.source_sheet, faculty)
        if named is None:
            continue
        own = _own_ids(named)
        if p.scopus_id in own:
            continue
        mismatches.append({
            **_person_row(named),
            "stored_scopus_id": ", ".join(sorted(own)) or None,
            "sheet_scopus_id": p.scopus_id,
            "sheet": p.source_sheet,
            "sheet_url": author_profile_url(p.scopus_id),
        })

    last = max((p.imported_at for p in profiles), default=None)
    return {
        "profiles": len(profiles),
        "last_imported_at": last.isoformat() if last else None,
        "profiles_without_account": without_account,
        "ambiguous": ambiguous,
        "faculty_without_scopus": without_scopus,
        "name_mismatches": mismatches,
    }
