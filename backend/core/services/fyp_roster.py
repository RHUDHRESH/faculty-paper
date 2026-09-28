"""The final-year project roster: the department's workbook, loaded as teams.

One sheet per academic year ("25-26"), a header row with a Team ID column,
and one row per team: department, team id, the mentor's name and Faculty ID,
up to four students as register number and name, and the project title.

The roster is what makes a student-project claim payable -- the scheme pays a
fixed amount per team, to that team's mentor -- so it is loaded by the office
and re-loaded when the department sends a corrected copy. Re-loading is
idempotent: a team is found again by its id, and changes only if the row says
something different.

The mentor is linked to an account by `User.staff_id`. A Faculty ID with no
account is not an error: the team is still loaded with the raw id and name,
and reported, so the office can see whose account is missing rather than
finding out when that mentor cannot file.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import IO, Any

from django.db import transaction
from django.utils import timezone

from core.management.commands.import_erp_excel import _id, _s
from core.models import AuditLog, Team, TeamMember, User


class RosterError(ValueError):
    """The file is not a roster this importer can read. Says why."""


@dataclass
class RosterRow:
    sheet: str
    row_number: int
    #: From the row's own sheet: a workbook carries one sheet per year.
    academic_year: str | None
    code: str
    department: str | None
    title: str | None
    mentor_name: str | None
    mentor_staff_id: str | None
    #: (register number, name), in the order the roster lists them.
    students: list[tuple[str | None, str]]


@dataclass
class Roster:
    #: Every sheet that carried a Team ID column, in workbook order.
    sheets: list[str] = field(default_factory=list)
    rows: list[RosterRow] = field(default_factory=list)
    #: One sentence per row that was not loaded, naming the sheet and row.
    skipped: list[str] = field(default_factory=list)

    @property
    def sheet(self) -> str:
        return ", ".join(self.sheets)

    @property
    def academic_year(self) -> str | None:
        years = sorted({r.academic_year for r in self.rows if r.academic_year})
        return ", ".join(years) or None


def _key(header: Any) -> str:
    """A header reduced to letters and digits: "Reg No - 1" -> "regno1"."""
    return re.sub(r"[^a-z0-9]", "", str(header or "").lower())


def _academic_year(text: str | None) -> str | None:
    """"25-26", "2025-26" or "2025-2026" as "2025-26"; anything else, None."""
    m = re.fullmatch(r"\s*(?:20)?(\d{2})\s*[-/]\s*(?:20)?(\d{2})\s*", text or "")
    return f"20{m.group(1)}-{m.group(2)}" if m else None


def staff_key(staff_id: str | None) -> str:
    """How a Faculty ID is compared: no spaces, one case."""
    return re.sub(r"\s+", "", staff_id or "").upper()


def _find_header(rows: list[tuple]) -> tuple[int, dict[str, int]] | None:
    for i, row in enumerate(rows[:15]):
        columns = {_key(v): j for j, v in enumerate(row) if _key(v)}
        if "teamid" in columns:
            return i, columns
    return None


def read_roster(source: str | IO[bytes], *, academic_year: str | None = None) -> Roster:
    """Read the roster out of a workbook, without touching the database.

    Every sheet with a Team ID column is read, each row taking its academic
    year from its own sheet's name; `academic_year` overrides that for all of
    them.
    """
    import openpyxl

    try:
        wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    except Exception as exc:  # a CSV, a PDF, a truncated upload: all unreadable
        raise RosterError(
            "That file is not an Excel workbook (.xlsx). Upload the roster "
            "workbook itself, not an export of it."
        ) from exc
    override = _academic_year(academic_year) or (academic_year or "").strip()[:9] or None
    roster = Roster()
    seen: dict[str, int] = {}
    try:
        for ws in wb.worksheets:
            rows = list(ws.iter_rows(values_only=True))
            found = _find_header(rows)
            if found is None:
                continue
            header_at, columns = found
            roster.sheets.append(ws.title)
            _read_sheet(
                roster,
                seen,
                ws.title,
                rows[header_at + 1 :],
                columns,
                first_row_number=header_at + 2,
                academic_year=override or _academic_year(ws.title),
            )
    finally:
        wb.close()
    if not roster.sheets:
        raise RosterError(
            "No sheet in that workbook has a \"Team ID\" column, so it is not the "
            "final-year project roster."
        )
    return roster


def _read_sheet(
    roster: Roster,
    seen: dict[str, int],
    sheet: str,
    rows: list[tuple],
    columns: dict[str, int],
    *,
    first_row_number: int,
    academic_year: str | None,
) -> None:
    """Add one sheet's rows to `roster`. `seen` spans sheets: a team id that
    appears twice anywhere in the workbook is loaded once, from its later row."""

    def cell(row: tuple, key: str) -> Any:
        j = columns.get(key)
        return row[j] if j is not None and j < len(row) else None

    for offset, row in enumerate(rows):
        number = first_row_number + offset
        if not any(v is not None and str(v).strip() for v in row):
            continue
        code = _s(cell(row, "teamid"), 64, drop_na=False)
        if not code:
            roster.skipped.append(
                f"Sheet {sheet} row {number}: no Team ID, so it was not loaded."
            )
            continue

        students: list[tuple[str | None, str]] = []
        slot = 1
        while f"name{slot}" in columns or f"regno{slot}" in columns:
            reg = _id(cell(row, f"regno{slot}"), 64)
            name = _s(cell(row, f"name{slot}"), 255)
            if reg or name:
                students.append((reg, name or "Name not on the roster"))
            slot += 1

        parsed = RosterRow(
            sheet=sheet,
            row_number=number,
            academic_year=academic_year,
            code=code,
            department=_s(cell(row, "department"), 255),
            title=_s(cell(row, "projecttitle"), 300),
            mentor_name=_s(cell(row, "name"), 255),
            mentor_staff_id=_s(cell(row, "facultyid"), 64),
            students=students,
        )
        earlier = seen.get(code.upper())
        if earlier is not None:
            before = roster.rows[earlier]
            roster.skipped.append(
                f"Sheet {sheet} row {number}: Team ID {code} already appeared on "
                f"sheet {before.sheet} row {before.row_number}; the later row was used."
            )
            roster.rows[earlier] = parsed
            continue
        seen[code.upper()] = len(roster.rows)
        roster.rows.append(parsed)


def _mentor_index() -> dict[str, list[User]]:
    index: dict[str, list[User]] = {}
    for user in User.objects.exclude(staff_id__isnull=True).exclude(staff_id=""):
        index.setdefault(staff_key(user.staff_id), []).append(user)
    return index


def _pick_mentor(index: dict[str, list[User]], staff_id: str | None) -> User | None:
    """The one account this Faculty ID names, or nobody.

    Two accounts on one staff id is ambiguous; an active one is preferred to a
    deactivated leaver, but if that still leaves more than one, the team is
    left unlinked and reported rather than paid against a guess.
    """
    matches = index.get(staff_key(staff_id), []) if staff_id else []
    if len(matches) > 1:
        matches = [u for u in matches if u.active]
    return matches[0] if len(matches) == 1 else None


def _members_of(students: list[tuple[str | None, str]]) -> list[tuple[str | None, str]]:
    """The students, with a register number listed twice kept once."""
    out: list[tuple[str | None, str]] = []
    regs: set[str] = set()
    for reg, name in students:
        if reg and reg in regs:
            continue
        if reg:
            regs.add(reg)
        out.append((reg, name))
    return out


def _member_order(member: tuple[str | None, str]) -> tuple[str, str]:
    return (member[0] or "", member[1])


def import_roster(roster: Roster, *, actor: User | None = None) -> dict[str, Any]:
    """Create or update a team per roster row. All of it, or none of it."""
    index = _mentor_index()
    now = timezone.now()
    created = updated = unchanged = 0
    unmatched: list[dict[str, Any]] = []

    with transaction.atomic():
        for row in roster.rows:
            team = Team.objects.filter(code__iexact=row.code).first()
            mentor = _pick_mentor(index, row.mentor_staff_id)
            mentor_id = mentor.id if mentor else None
            if (
                mentor_id is None
                and team is not None
                and team.mentor_id
                and staff_key(team.mentor_staff_id) == staff_key(row.mentor_staff_id)
            ):
                # The Faculty ID matches no account, and the office linked this
                # team's mentor by hand for that same Faculty ID. The roster has
                # not changed its mind, so neither does the import.
                mentor_id = team.mentor_id
            if mentor_id is None:
                unmatched.append({
                    "code": row.code,
                    "faculty_id": row.mentor_staff_id,
                    "mentor_name": row.mentor_name,
                    "department": row.department,
                })
            members = _members_of(row.students)
            wanted = {
                "title": row.title,
                "department": row.department,
                "mentor_id": mentor_id,
                "mentor_name": row.mentor_name,
                "mentor_staff_id": row.mentor_staff_id,
            }
            if row.academic_year:
                wanted["academic_year"] = row.academic_year

            if team is None:
                team = Team.objects.create(code=row.code, imported_at=now, **wanted)
                created += 1
            else:
                held = [(m.register_number, m.name) for m in team.members.all()]
                same = sorted(held, key=_member_order) == sorted(
                    members, key=_member_order
                ) and all(getattr(team, k) == v for k, v in wanted.items())
                if same:
                    Team.objects.filter(pk=team.pk).update(imported_at=now)
                    unchanged += 1
                    continue
                for k, v in wanted.items():
                    setattr(team, k, v)
                team.imported_at = now
                team.save()
                team.members.all().delete()
                updated += 1
            TeamMember.objects.bulk_create(
                [TeamMember(team=team, register_number=reg, name=name) for reg, name in members]
            )

        result = {
            "sheet": roster.sheet,
            "academic_year": roster.academic_year,
            "teams": len(roster.rows),
            "created": created,
            "updated": updated,
            "unchanged": unchanged,
            "mentors_unmatched": unmatched,
            "skipped": roster.skipped,
        }
        AuditLog.objects.create(
            actor=actor,
            action="FYP_TEAMS_IMPORT",
            entity="Team",
            detail_json=json.dumps({
                k: result[k] for k in ("sheet", "academic_year", "teams", "created", "updated", "unchanged")
            } | {"mentors_unmatched": len(unmatched), "skipped": len(roster.skipped)}),
        )
    return result
