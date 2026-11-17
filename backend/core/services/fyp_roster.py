"""The final-year project roster: the department's workbook, loaded as teams.

Two layouts are read, found by their header text (case, spaces and
punctuation ignored), in as many sheets of a workbook as carry one:

- One row per team, with a Team ID column: department, team id, the mentor's
  name and Faculty ID, up to four students as register number and name, and
  the project title. One sheet per academic year ("25-26").
- One row per student (the 2026 workbook): a team number or code, the mentor
  (name and Faculty ID / Mentor-code), a student (Reg No - 1 / Register No and
  Name - 1 / Learners Name), department, project title and, on some sheets,
  the team's publication columns. Rows sharing a team code are one team.
  "teamentrynotfound" and the like are the department's placeholders for a
  blank, and are read as blank.

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

#: A 2026-layout workbook that names no year is read as this one.
DEFAULT_ACADEMIC_YEAR = "2025-26"

#: Rows of the mixed-mentor list returned by an import.
MAX_CONFLICTS_LISTED = 200

#: What a team code looks like in the 2026 workbook: "26PBA001", "26USF351".
_TEAM_CODE = re.compile(r"^\d{2}[A-Z]{2,5}\d{2,4}$")

#: Header aliases, compared after `_key`: case, spaces and punctuation ignored.
_TEAM_KEYS = ("teamid", "teamno", "teamnumber", "teamcode")
_MENTOR_NAME_KEYS = ("name", "mentorname", "facultyname", "mentor")
_MENTOR_ID_KEYS = ("facultyid", "mentorcode", "mentorid", "facultycode", "staffid")
_DEPARTMENT_KEYS = ("department", "dept")
_TITLE_KEYS = ("projecttitle",)
_REG_KEYS = ("registerno", "registernumber", "regno", "registrationno")
_STUDENT_NAME_KEYS = ("learnersname", "learnername", "studentname")

_PLACEHOLDERS = {"na", "nan", "nil", "none", "null", "tbd", "notavailable", "notapplicable"}

TEAM_PER_ROW = "one row per team"
STUDENT_PER_ROW = "one row per student"


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
    #: Every sheet this team was read from (a team can be on two).
    sheets: list[str] = field(default_factory=list)
    #: Each student's own mentor, where the sheet gives one per student.
    mentor_of: dict[tuple[str | None, str], str | None] = field(default_factory=dict)
    #: Every (Faculty ID, name) the team's students named, commonest first.
    mentors: list[tuple[str | None, str | None]] = field(default_factory=list)
    #: The publication columns of the rows that carried any: article title,
    #: source title, document type, ISSN, publication date, Scopus EID, DOI and
    #: links. Read and reported but not stored: Team has no field for them, and
    #: adding one is a migration.
    publications: list[dict[str, str]] = field(default_factory=list)


@dataclass
class SheetReport:
    """What one sheet gave, for the person who has to trust the import."""

    sheet: str
    layout: str
    academic_year: str | None = None
    rows_read: int = 0
    teams: int = 0
    students: int = 0
    mentors: int = 0
    publications: int = 0
    skipped: int = 0
    skipped_because: dict[str, int] = field(default_factory=dict)

    def skip(self, why: str) -> None:
        self.skipped += 1
        self.skipped_because[why] = self.skipped_because.get(why, 0) + 1


@dataclass
class Roster:
    #: Every sheet that was read as a roster, in workbook order.
    sheets: list[str] = field(default_factory=list)
    rows: list[RosterRow] = field(default_factory=list)
    #: One sentence per row that was not loaded, naming the sheet and row.
    skipped: list[str] = field(default_factory=list)
    reports: list[SheetReport] = field(default_factory=list)

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


def _placeholder(text: str) -> bool:
    """"teamentrynotfound", "projecttiteanotfound", "NA", "-": a cell that
    says there is nothing here, in the department's own words."""
    k = _key(text)
    return not k or k.endswith("notfound") or k in _PLACEHOLDERS


def _text(val: Any, n: int | None = None) -> str | None:
    s = _s(val, None)
    if s is None or _placeholder(s):
        return None
    return s[:n] if n else s


def _ident(val: Any, n: int | None = None) -> str | None:
    s = _id(val, None)
    if s is None or _placeholder(s):
        return None
    return s[:n] if n else s


Columns = dict[str, list[int]]


def _columns(row: tuple) -> Columns:
    """Header key -> every column carrying it ("Column1" and "Column 1" both)."""
    out: Columns = {}
    for j, v in enumerate(row):
        k = _key(v)
        if k:
            out.setdefault(k, []).append(j)
    return out


def _has(columns: Columns, *keys: str) -> bool:
    return any(k in columns for k in keys)


def _student_pairs(columns: Columns) -> list[tuple[int | None, int | None]]:
    """(register-number column, name column) for each student the sheet lists:
    "Reg No - 1"/"Name - 1" ... "Reg No - n"/"Name - n", or a single
    "Register No"/"Learners Name" pair."""
    pairs: list[tuple[int | None, int | None]] = []
    slot = 1
    while f"name{slot}" in columns or f"regno{slot}" in columns:
        pairs.append((
            columns.get(f"regno{slot}", [None])[0],
            columns.get(f"name{slot}", [None])[0],
        ))
        slot += 1
    if not pairs:
        reg = next((columns[k][0] for k in _REG_KEYS if k in columns), None)
        name = next((columns[k][0] for k in _STUDENT_NAME_KEYS if k in columns), None)
        if reg is not None or name is not None:
            pairs.append((reg, name))
    return pairs


def _layout_of(columns: Columns) -> str | None:
    """Which roster layout a header row is, or None if it is not one.

    The old layout is recognised by its "Team ID" column. The 2026 layouts
    have none: a team number or team code, the mentor's id, and students.
    """
    if "teamid" in columns:
        return TEAM_PER_ROW
    has_team = _has(columns, *_TEAM_KEYS) or "column1" in columns
    if has_team and _has(columns, *_MENTOR_ID_KEYS) and _student_pairs(columns):
        return STUDENT_PER_ROW
    return None


def _find_header(rows: list[tuple]) -> tuple[int, Columns, str] | None:
    for i, row in enumerate(rows[:15]):
        columns = _columns(row)
        layout = _layout_of(columns)
        if layout:
            return i, columns, layout
    return None


def _date(val: Any) -> str | None:
    """A publication date as ISO text: a datetime, an Excel serial, or text."""
    from datetime import date, datetime

    if isinstance(val, datetime):
        return val.date().isoformat()
    if isinstance(val, date):
        return val.isoformat()
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        if 20000 < val < 80000:  # 1954 .. 2118 as an Excel serial
            from openpyxl.utils.datetime import from_excel

            return from_excel(val).date().isoformat()
        return None
    s = _text(val, 40)
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d %B %Y", "%B %Y", "%b %Y", "%Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _doi(val: Any) -> str | None:
    s = _text(val, 200)
    if not s:
        return None
    s = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", s, flags=re.I)
    return s if s.startswith("10.") else None


def _issn(val: Any) -> str | None:
    s = _id(val, 32)
    if s is None or _placeholder(s):
        return None
    digits = re.sub(r"[-\s]", "", s)
    if re.fullmatch(r"\d{7,8}|\d{7}[Xx]", digits):
        digits = digits.upper().zfill(8)
        return f"{digits[:4]}-{digits[4:]}"
    return s


def _link(val: Any) -> str | None:
    s = _text(val, 500)
    return s if s and s.lower().startswith("http") else None


def _publication(cell) -> dict[str, str]:
    """The publication columns of one row, only those that hold something."""
    got = {
        "article_title": _text(cell("articletitle"), 500),
        "source_title": _text(cell("sourcetitle"), 300),
        "document_type": _text(cell("documenttype"), 100),
        "issn": _issn(cell("issn")),
        "publication_date": _date(cell("publicationdate")),
        "scopus_eid": _text(cell("scopuseid"), 64),
        "doi": _doi(cell("doi")),
        "scopus_link": _link(cell("scopusarticlelink")),
        "article_link": _link(cell("articlelink")),
    }
    out = {k: v for k, v in got.items() if v}
    # A date or a link on its own says nothing about which article it is.
    return out if any(k in out for k in ("article_title", "scopus_eid", "doi")) else {}


def _publication_id(pub: dict[str, str]) -> str:
    """One article is one DOI or, with none, one title (case and punctuation
    ignored); only an article with neither falls back to its Scopus EID."""
    if pub.get("doi"):
        return "doi:" + pub["doi"].lower()
    title = _key(pub.get("article_title"))
    if title:
        return "title:" + title
    return "eid:" + pub.get("scopus_eid", "").lower()


def _same_article(held: dict[str, dict[str, str]], pub: dict[str, str]) -> str | None:
    """The held article this one repeats: the same DOI, or -- when either has
    no DOI -- the same title once case and punctuation are ignored."""
    doi = (pub.get("doi") or "").lower()
    title = _key(pub.get("article_title"))
    for pid, other in held.items():
        other_doi = (other.get("doi") or "").lower()
        if doi and other_doi:
            if doi == other_doi:
                return pid
            continue
        if title and title == _key(other.get("article_title")):
            return pid
    return None


def read_roster(source: str | IO[bytes], *, academic_year: str | None = None) -> Roster:
    """Read the roster out of a workbook, without touching the database.

    Every sheet in a roster layout is read: the old one, with a Team ID column
    and a row per team, or the 2026 ones, with a row per student whose rows
    are grouped into teams by team code. Each row takes its academic year from
    its own sheet's name; `academic_year` overrides that for all of them, and a
    2026-layout sheet whose name carries no year is 2025-26.
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
    grouped = _Grouped()
    try:
        for ws in wb.worksheets:
            rows = list(ws.iter_rows(values_only=True))
            found = _find_header(rows)
            if found is None:
                continue
            header_at, columns, layout = found
            roster.sheets.append(ws.title)
            year = override or _academic_year(ws.title)
            if layout == STUDENT_PER_ROW:
                year = year or DEFAULT_ACADEMIC_YEAR
            report = SheetReport(sheet=ws.title, layout=layout, academic_year=year)
            roster.reports.append(report)
            reader = _read_sheet if layout == TEAM_PER_ROW else _read_student_sheet
            reader(
                roster, seen, grouped, report, ws.title, rows[header_at + 1 :], columns,
                first_row_number=header_at + 2, academic_year=year,
            )
    finally:
        wb.close()
    if not roster.sheets:
        raise RosterError(
            "No sheet in that workbook looks like the final-year project roster: "
            "none has a \"Team ID\" column, nor a team number with a mentor id "
            "(Faculty ID or Mentor-code) and students (Reg No or Register No)."
        )
    _place_groups(roster, seen, grouped)
    return roster


def _cell_reader(row: tuple, columns: Columns):
    def cell(key: str) -> Any:
        j = columns.get(key, [None])[0]
        return row[j] if j is not None and j < len(row) else None

    return cell


def _read_sheet(
    roster: Roster,
    seen: dict[str, int],
    grouped: "_Grouped",
    report: SheetReport,
    sheet: str,
    rows: list[tuple],
    columns: Columns,
    *,
    first_row_number: int,
    academic_year: str | None,
) -> None:
    """Add one old-layout sheet's rows to `roster`. `seen` spans sheets: a team
    id that appears twice anywhere in the workbook is loaded once, from its
    later row."""
    pairs = _student_pairs(columns)
    codes: set[str] = set()
    mentors: set[str] = set()
    students = 0
    for offset, row in enumerate(rows):
        number = first_row_number + offset
        if not any(v is not None and str(v).strip() for v in row):
            continue
        report.rows_read += 1
        cell = _cell_reader(row, columns)
        code = _s(cell("teamid"), 64, drop_na=False)
        if code and _placeholder(code):
            code = None
        if not code:
            report.skip("no Team ID")
            roster.skipped.append(
                f"Sheet {sheet} row {number}: no Team ID, so it was not loaded."
            )
            continue

        found: list[tuple[str | None, str]] = []
        for reg_at, name_at in pairs:
            reg = _id(row[reg_at], 64) if reg_at is not None and reg_at < len(row) else None
            name = _s(row[name_at], 255) if name_at is not None and name_at < len(row) else None
            if reg or name:
                found.append((reg, name or "Name not on the roster"))

        mentor_id = _ident(cell("facultyid"), 64)
        parsed = RosterRow(
            sheet=sheet,
            row_number=number,
            academic_year=academic_year,
            code=code,
            department=_text(cell("department"), 255),
            title=_text(cell("projecttitle"), 300),
            mentor_name=_text(cell("name"), 255),
            mentor_staff_id=mentor_id,
            students=found,
            sheets=[sheet],
        )
        codes.add(code.upper())
        students += len(found)
        if mentor_id:
            mentors.add(staff_key(mentor_id))
        earlier = seen.get(code.upper())
        if earlier is not None:
            before = roster.rows[earlier]
            report.skip("Team ID repeated; the later row was used")
            roster.skipped.append(
                f"Sheet {sheet} row {number}: Team ID {code} already appeared on "
                f"sheet {before.sheet} row {before.row_number}; the later row was used."
            )
            roster.rows[earlier] = parsed
            continue
        seen[code.upper()] = len(roster.rows)
        roster.rows.append(parsed)
    report.teams = len(codes)
    report.students = students
    report.mentors = len(mentors)


@dataclass
class _StudentRead:
    reg: str | None
    name: str
    mentor_name: str | None
    mentor_id: str | None
    department: str | None
    title: str | None
    sheet: str
    row_number: int


@dataclass
class _TeamGroup:
    code: str
    academic_year: str | None
    first_sheet: str
    first_row: int
    sheets: list[str] = field(default_factory=list)
    #: By register number (or, with none, name): a student is on a team once.
    students: dict[str, _StudentRead] = field(default_factory=dict)
    publications: dict[str, dict[str, str]] = field(default_factory=dict)


class _Grouped(dict):
    """Team code (upper case) -> the student rows gathered for it, workbook-wide."""


def _team_code(columns: Columns, row: tuple) -> str | None:
    """The row's team code. A value shaped like a team code ("26USF351") wins,
    wherever it sits (TeamNo, or the sheet's unnamed "Column1"); failing that,
    a real value in a team-number column. Placeholders are nothing."""
    named = [
        v
        for k in _TEAM_KEYS
        for j in columns.get(k, [])
        if j < len(row) and (v := _text(row[j], 64))
    ]
    unnamed = [
        v
        for j in columns.get("column1", [])
        if j < len(row) and (v := _text(row[j], 64))
    ]
    for v in named + unnamed:
        if _TEAM_CODE.match(v.upper()):
            return v.upper()
    return named[0] if named else None


def _read_student_sheet(
    roster: Roster,
    seen: dict[str, int],
    grouped: _Grouped,
    report: SheetReport,
    sheet: str,
    rows: list[tuple],
    columns: Columns,
    *,
    first_row_number: int,
    academic_year: str | None,
) -> None:
    """Gather one student-per-row sheet into `grouped`, a team per code."""
    pairs = _student_pairs(columns)
    mentor_name_key = next((k for k in _MENTOR_NAME_KEYS if k in columns), "name")
    mentor_id_key = next((k for k in _MENTOR_ID_KEYS if k in columns), "facultyid")
    department_key = next((k for k in _DEPARTMENT_KEYS if k in columns), "department")
    title_key = next((k for k in _TITLE_KEYS if k in columns), "projecttitle")
    codes: set[str] = set()
    mentors: set[str] = set()
    students = 0
    publications = 0
    for offset, row in enumerate(rows):
        number = first_row_number + offset
        if not any(v is not None and str(v).strip() for v in row):
            continue
        report.rows_read += 1
        cell = _cell_reader(row, columns)
        code = _team_code(columns, row)
        if not code:
            report.skip("no team code")
            roster.skipped.append(
                f"Sheet {sheet} row {number}: no team code (the team number is "
                f"blank or a placeholder), so it was not loaded."
            )
            continue
        found: list[tuple[str | None, str]] = []
        for reg_at, name_at in pairs:
            reg = _ident(row[reg_at], 64) if reg_at is not None and reg_at < len(row) else None
            name = _text(row[name_at], 255) if name_at is not None and name_at < len(row) else None
            if reg or name:
                found.append((reg, name or "Name not on the roster"))
        if not found:
            report.skip("no student on the row")
            roster.skipped.append(
                f"Sheet {sheet} row {number}: team {code} has no student here, so "
                f"the row was not loaded."
            )
            continue

        group = grouped.get(code)
        if group is None:
            group = grouped[code] = _TeamGroup(
                code=code, academic_year=academic_year, first_sheet=sheet, first_row=number
            )
        if sheet not in group.sheets:
            group.sheets.append(sheet)
        codes.add(code)
        mentor_id = _ident(cell(mentor_id_key), 64)
        mentor_name = _text(cell(mentor_name_key), 255)
        if mentor_id:
            mentors.add(staff_key(mentor_id))
        for reg, name in found:
            skey = reg or f"name:{name.lower()}"
            before = group.students.get(skey)
            if before is not None and before.sheet == sheet:
                report.skip("student repeated on the same team")
                roster.skipped.append(
                    f"Sheet {sheet} row {number}: {name} is already on team {code} "
                    f"(row {before.row_number}); the later row was used."
                )
            else:
                students += 1
            group.students[skey] = _StudentRead(
                reg=reg,
                name=name,
                mentor_name=mentor_name,
                mentor_id=mentor_id,
                department=_text(cell(department_key), 255),
                title=_text(cell(title_key), 300),
                sheet=sheet,
                row_number=number,
            )
        pub = _publication(cell)
        if pub:
            pid = _same_article(group.publications, pub)
            if pid is None:
                pid = _publication_id(pub)
                publications += 1
            # The same article on a teammate's row: keep what either row says.
            group.publications[pid] = {**pub, **group.publications.get(pid, {})}
    report.teams = len(codes)
    report.students = students
    report.mentors = len(mentors)
    report.publications = publications


def _most_common(values: list[Any]) -> Any:
    """The commonest value (case-insensitively for text); first seen on a tie."""
    counted: dict[Any, list[Any]] = {}
    for v in values:
        if v is None:
            continue
        counted.setdefault(v.lower() if isinstance(v, str) else v, []).append(v)
    if not counted:
        return None
    return max(counted.values(), key=len)[0]  # max keeps the first of equals


def _place_groups(roster: Roster, seen: dict[str, int], grouped: _Grouped) -> None:
    """Turn each gathered team into a RosterRow.

    A student's own row names that student's mentor, title and department, and
    they do not always agree (a team of three can name three mentors). The team
    takes the commonest, the first named on a tie, and `mentors` keeps them all.
    """
    for code, group in grouped.items():
        reads = list(group.students.values())
        tally: dict[str, list[_StudentRead]] = {}
        for r in reads:
            who = staff_key(r.mentor_id) or (r.mentor_name or "").lower()
            if who:
                tally.setdefault(who, []).append(r)
        ordered = sorted(tally.values(), key=lambda rs: -len(rs))  # stable
        lead = ordered[0][0] if ordered else None
        parsed = RosterRow(
            sheet=group.first_sheet,
            row_number=group.first_row,
            academic_year=group.academic_year,
            code=code,
            department=_most_common([r.department for r in reads]),
            title=_most_common([r.title for r in reads]),
            mentor_name=lead.mentor_name if lead else None,
            mentor_staff_id=lead.mentor_id if lead else None,
            students=[(r.reg, r.name) for r in reads],
            sheets=group.sheets,
            mentor_of={(r.reg, r.name): r.mentor_name for r in reads},
            mentors=[(rs[0].mentor_id, rs[0].mentor_name) for rs in ordered],
            publications=sorted(group.publications.values(), key=_publication_id),
        )
        earlier = seen.get(code)
        if earlier is not None:
            before = roster.rows[earlier]
            roster.skipped.append(
                f"Team {code} was on sheet {before.sheet} row {before.row_number} "
                f"(one row per team) and on sheet {group.first_sheet} (one row per "
                f"student); the student rows were used."
            )
            roster.rows[earlier] = parsed
            continue
        seen[code] = len(roster.rows)
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


def _member_order(member: tuple[str | None, str, str | None]) -> tuple[str, str]:
    return (member[0] or "", member[1])


def import_roster(roster: Roster, *, actor: User | None = None) -> dict[str, Any]:
    """Create or update a team per roster row. All of it, or none of it."""
    index = _mentor_index()
    now = timezone.now()
    created = updated = unchanged = 0
    unmatched: list[dict[str, Any]] = []
    #: sheet -> codes / Faculty IDs of its teams whose mentor has no account.
    unmatched_codes: dict[str, set[str]] = {}
    unmatched_ids: dict[str, set[str]] = {}
    conflicts: list[dict[str, Any]] = []
    conflict_sheets: dict[str, int] = {}

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
                for sheet in row.sheets or [row.sheet]:
                    unmatched_codes.setdefault(sheet, set()).add(row.code)
                    if row.mentor_staff_id:
                        unmatched_ids.setdefault(sheet, set()).add(staff_key(row.mentor_staff_id))
            if len(row.mentors) > 1:
                for sheet in row.sheets or [row.sheet]:
                    conflict_sheets[sheet] = conflict_sheets.get(sheet, 0) + 1
                conflicts.append({
                    "code": row.code,
                    "sheets": row.sheets or [row.sheet],
                    "chosen": {"faculty_id": row.mentors[0][0], "name": row.mentors[0][1]},
                    "others": [{"faculty_id": m[0], "name": m[1]} for m in row.mentors[1:]],
                })
            members = [
                (reg, name, row.mentor_of.get((reg, name)))
                for reg, name in _members_of(row.students)
            ]
            wanted = {
                "title": row.title,
                "department": row.department,
                "mentor_id": mentor_id,
                "mentor_name": row.mentor_name,
                "mentor_staff_id": row.mentor_staff_id,
            }
            if row.academic_year:
                wanted["academic_year"] = row.academic_year
            if row.publications:  # a roster without articles never empties them
                wanted["publications"] = row.publications

            if team is None:
                team = Team.objects.create(code=row.code, imported_at=now, **wanted)
                created += 1
            else:
                held = [(m.register_number, m.name, m.mentor_name) for m in team.members.all()]
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
                [
                    TeamMember(team=team, register_number=reg, name=name, mentor_name=mentor)
                    for reg, name, mentor in members
                ]
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
            #: Teams whose students name different mentors, for the office to
            #: review: the one used and the others named. At most 200 here; the
            #: full count is `mentor_conflicts_total`.
            "mentor_conflicts": conflicts[:MAX_CONFLICTS_LISTED],
            "mentor_conflicts_total": len(conflicts),
            "publications_read": sum(len(r.publications) for r in roster.rows),
            "sheets": [
                {
                    "sheet": rep.sheet,
                    "layout": rep.layout,
                    "academic_year": rep.academic_year,
                    "rows_read": rep.rows_read,
                    "teams": rep.teams,
                    "students": rep.students,
                    "mentors": rep.mentors,
                    "publications": rep.publications,
                    "teams_mixed_mentors": conflict_sheets.get(rep.sheet, 0),
                    "rows_skipped": rep.skipped,
                    "skipped_because": rep.skipped_because,
                    "teams_mentor_unmatched": len(unmatched_codes.get(rep.sheet, ())),
                    "mentor_ids_unmatched": len(unmatched_ids.get(rep.sheet, ())),
                }
                for rep in roster.reports
            ],
        }
        AuditLog.objects.create(
            actor=actor,
            action="FYP_TEAMS_IMPORT",
            entity="Team",
            detail_json=json.dumps({
                k: result[k] for k in ("sheet", "academic_year", "teams", "created", "updated", "unchanged")
            } | {
                "mentors_unmatched": len(unmatched),
                "skipped": len(roster.skipped),
                "mentor_conflicts": len(conflicts),
                "publications_read": sum(len(r.publications) for r in roster.rows),
            }),
        )
    return result
