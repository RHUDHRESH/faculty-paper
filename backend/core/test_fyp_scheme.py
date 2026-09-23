"""The final-year project scheme: the roster of teams, and the claim filed on one.

The college decided (2026-09-23) that a student-project conference paper is
not paid under the faculty publication remuneration scheme. It is a scheme of
its own: a fixed amount per team per conference paper, claimed once, by the
team's mentor, from a roster the office imports out of the department's
workbook.

Every workbook here is built in the test with openpyxl, in the shape of the
real one -- a blank first row, the header on row 2, register numbers as the
whole numbers Excel stores them as. The real file carries students' names and
is never copied into the repository.
"""
from __future__ import annotations

import io
import json
from io import StringIO

import openpyxl
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import Client, TestCase

from core.models import AuditLog, Role, Team, TeamMember, User

HEADER = [
    "Department", "Team ID", "Name", "Faculty ID",
    "Reg No - 1", "Name - 1", "Reg No - 2", "Name - 2",
    "Reg No - 3", "Name - 3", "Reg No - 4", "Name - 4",
    "Project Title",
]


def roster_row(code, *, faculty_id="TSCH001", mentor="Dr. Kumar A",
               department="Chemical", students=(), title="A project"):
    """One line of the roster, students padded out to the four slots."""
    slots: list = []
    for reg, name in list(students)[:4]:
        slots += [reg, name]
    slots += [None] * (8 - len(slots))
    return [department, code, mentor, faculty_id, *slots, title]


def roster_workbook(rows, *, sheet="25-26") -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append([None] * len(HEADER))  # the real file's first row is blank
    ws.append(HEADER)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _person(email, name, *, role=Role.FACULTY, **extra):
    return User.objects.create_user(
        email=email, password="pass", name=name, role=role, **extra
    )


class RosterImportTests(TestCase):
    """`import_fyp_teams`: the department's workbook, loaded as teams."""

    def setUp(self):
        self.kumar = _person(
            "kumar@test.edu", "Kumar A", department="Chemical", staff_id="TSCH001"
        )

    def _import(self, rows, **kw):
        from core.services.fyp_roster import import_roster, read_roster

        return import_roster(read_roster(io.BytesIO(roster_workbook(rows, **kw))))

    def test_a_team_arrives_with_its_students_and_its_mentor_linked_by_staff_id(self):
        result = self._import([
            roster_row(
                "PR26CH0001",
                students=[(212222210012, "Mohamed Ahamed Meeran"), (212222210013, "Basith Ali A")],
                title="Phytochemical analysis of Canna indica",
            )
        ])

        self.assertEqual(result["created"], 1)
        team = Team.objects.get(code="PR26CH0001")
        self.assertEqual(team.mentor_id, self.kumar.id)
        self.assertEqual(team.mentor_staff_id, "TSCH001")
        self.assertEqual(team.mentor_name, "Dr. Kumar A")
        self.assertEqual(team.department, "Chemical")
        self.assertEqual(team.title, "Phytochemical analysis of Canna indica")
        self.assertIsNotNone(team.imported_at)
        self.assertEqual(
            sorted(team.members.values_list("register_number", "name")),
            [("212222210012", "Mohamed Ahamed Meeran"), ("212222210013", "Basith Ali A")],
        )

    def test_register_numbers_are_digits_whether_excel_gave_an_int_or_a_float(self):
        """Excel stores a register number as a number. As a float it would
        read back "212222210012.0", which is nobody's register number."""
        self._import([
            roster_row("PR26CH0002", students=[(212222210006, "Hemamalini S"),
                                               (212222210009.0, "Kowsika G")])
        ])
        self.assertEqual(
            sorted(TeamMember.objects.values_list("register_number", flat=True)),
            ["212222210006", "212222210009"],
        )

    def test_the_academic_year_is_read_off_the_sheet_name(self):
        self._import([roster_row("PR26CH0003", students=[(1, "A")])], sheet="25-26")
        self.assertEqual(Team.objects.get(code="PR26CH0003").academic_year, "2025-26")

    def test_an_unmatched_mentor_keeps_the_raw_id_and_name_and_is_reported(self):
        result = self._import([
            roster_row("PR26ME0029", faculty_id="TSME134", mentor="DR SELVAM",
                       department="MECHANICAL", students=[(212222086001, "SHREERAM RG")]),
        ])
        team = Team.objects.get(code="PR26ME0029")
        self.assertIsNone(team.mentor_id)
        self.assertEqual(team.mentor_staff_id, "TSME134")
        self.assertEqual(team.mentor_name, "DR SELVAM")
        self.assertEqual(
            result["mentors_unmatched"],
            [{"code": "PR26ME0029", "faculty_id": "TSME134", "mentor_name": "DR SELVAM",
              "department": "MECHANICAL"}],
        )

    def test_the_faculty_id_is_matched_however_it_was_typed(self):
        self._import([roster_row("PR26CH0004", faculty_id=" tsch001 ", students=[(1, "A")])])
        self.assertEqual(Team.objects.get(code="PR26CH0004").mentor_id, self.kumar.id)

    def test_a_second_import_of_the_same_file_changes_nothing(self):
        rows = [roster_row("PR26CH0001", students=[(1, "A"), (2, "B")])]
        first = self._import(rows)
        again = self._import(rows)
        self.assertEqual((first["created"], first["updated"]), (1, 0))
        self.assertEqual((again["created"], again["updated"], again["unchanged"]), (0, 0, 1))
        self.assertEqual(Team.objects.count(), 1)
        self.assertEqual(TeamMember.objects.count(), 2)

    def test_a_re_import_updates_the_team_by_its_id(self):
        self._import([roster_row("PR26CH0001", students=[(1, "A"), (2, "B")], title="Old")])
        result = self._import(
            [roster_row("pr26ch0001", students=[(1, "A"), (3, "C")], title="New")]
        )
        self.assertEqual((result["created"], result["updated"]), (0, 1))
        team = Team.objects.get()
        self.assertEqual(team.title, "New")
        self.assertEqual(
            sorted(team.members.values_list("name", flat=True)), ["A", "C"]
        )

    def test_a_row_with_no_team_id_is_skipped_and_said_so(self):
        result = self._import([
            roster_row("", students=[(1, "Orphan")]),
            roster_row("PR26CH0005", students=[(2, "Kept")]),
        ])
        self.assertEqual(result["created"], 1)
        self.assertEqual(len(result["skipped"]), 1)
        self.assertIn("Team ID", result["skipped"][0])

    def test_a_workbook_without_the_roster_header_is_refused(self):
        from core.services.fyp_roster import RosterError, read_roster

        wb = openpyxl.Workbook()
        wb.active.append(["Something", "Else"])
        buf = io.BytesIO()
        wb.save(buf)
        with self.assertRaises(RosterError):
            read_roster(io.BytesIO(buf.getvalue()))

    def test_something_that_is_not_a_workbook_is_refused(self):
        from core.services.fyp_roster import RosterError, read_roster

        with self.assertRaises(RosterError):
            read_roster(io.BytesIO(b"Department,Team ID\nx,y\n"))


class RosterCommandTests(TestCase):
    def test_the_command_imports_and_prints_the_counts_and_the_unmatched(self):
        _person("kumar@test.edu", "Kumar A", staff_id="TSCH001")
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "roster.xlsx"
            path.write_bytes(roster_workbook([
                roster_row("PR26CH0001", students=[(1, "A")]),
                roster_row("PR26ME0029", faculty_id="TSME134", mentor="DR SELVAM",
                           students=[(2, "B")]),
            ]))
            out = StringIO()
            call_command("import_fyp_teams", str(path), stdout=out)

        text = out.getvalue()
        self.assertIn("created: 2", text)
        self.assertIn("updated: 0", text)
        self.assertIn("mentors unmatched: 1", text)
        self.assertIn("PR26ME0029", text)
        self.assertIn("TSME134", text)
        self.assertEqual(Team.objects.count(), 2)


class RosterUploadTests(TestCase):
    """The office's upload: same importer, over HTTP, behind the office's door."""

    def setUp(self):
        self.office = _person("cell@test.edu", "Research Cell", role=Role.RESEARCH_CELL)
        self.faculty = _person("fac@test.edu", "A Faculty", staff_id="TSCH001")
        self.client = Client()

    def _upload(self, content: bytes, name="roster.xlsx"):
        return self.client.post(
            "/api/admin/fyp-teams/import",
            data={"file": SimpleUploadedFile(name, content)},
        )

    def test_the_office_uploads_the_roster_and_gets_the_counts_back(self):
        self.client.force_login(self.office)
        r = self._upload(roster_workbook([
            roster_row("PR26CH0001", students=[(1, "A")]),
            roster_row("PR26ME0029", faculty_id="TSME134", mentor="DR SELVAM",
                       students=[(2, "B")]),
        ]))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["created"], body["updated"]), (2, 0))
        self.assertEqual(
            [m["code"] for m in body["mentors_unmatched"]], ["PR26ME0029"]
        )
        self.assertTrue(AuditLog.objects.filter(action="FYP_TEAMS_IMPORT").exists())

    def test_every_office_role_may_upload_and_nobody_else(self):
        content = roster_workbook([roster_row("PR26CH0001", students=[(1, "A")])])
        for role, allowed in (
            (Role.SUPER_ADMIN, True),
            (Role.RESEARCH_CELL, True),
            (Role.RESEARCH_COORDINATOR, True),
            (Role.FACULTY, False),
            (Role.HOD, False),
            (Role.PRINCIPAL, False),
            (Role.FINANCE, False),
        ):
            user = _person(f"{role.lower()}-up@test.edu", role.title(), role=role)
            self.client.force_login(user)
            r = self._upload(content)
            self.assertEqual(r.status_code == 200, allowed, f"{role}: {r.status_code}")

    def test_a_file_that_is_not_the_roster_is_a_400_not_a_500(self):
        self.client.force_login(self.office)
        r = self._upload(b"a,b\n1,2\n", name="probe.csv")
        self.assertEqual(r.status_code, 400, r.content)

    def test_the_office_can_read_what_is_loaded_and_who_is_unmatched(self):
        self.client.force_login(self.office)
        self._upload(roster_workbook([
            roster_row("PR26CH0001", students=[(1, "A")]),
            roster_row("PR26ME0029", faculty_id="TSME134", mentor="DR SELVAM",
                       students=[(2, "B")]),
        ]))
        r = self.client.get("/api/admin/fyp-teams")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["teams"], 2)
        self.assertEqual(body["academic_years"], ["2025-26"])
        self.assertEqual([m["code"] for m in body["mentors_unmatched"]], ["PR26ME0029"])

        self.client.force_login(self.faculty)
        self.assertEqual(self.client.get("/api/admin/fyp-teams").status_code, 403)


class TeamWritesAreTheOfficesTests(TestCase):
    """A team decides who may claim ₹15,000, so it is not self-service.

    `POST /teams` let anybody signed in create a team naming themselves as
    its mentor, or re-point an existing team's mentor at themselves -- which
    under the new scheme is a way to mint a claimable team. The roster is the
    office's; so is correcting it.
    """

    def setUp(self):
        self.faculty = _person("self@test.edu", "Self Service")
        self.office = _person("office@test.edu", "Office", role=Role.RESEARCH_CELL)
        self.client = Client()

    def _post(self, **payload):
        body = {"code": "SELF-1", "members": [{"name": "A"}], **payload}
        return self.client.post(
            "/api/teams", data=json.dumps(body), content_type="application/json"
        )

    def test_faculty_cannot_create_a_team(self):
        self.client.force_login(self.faculty)
        r = self._post(mentor_id=self.faculty.id)
        self.assertEqual(r.status_code, 403, r.content)
        self.assertFalse(Team.objects.exists())

    def test_faculty_cannot_take_over_an_imported_team(self):
        team = Team.objects.create(code="PR26CH0001", mentor=self.office)
        self.client.force_login(self.faculty)
        r = self._post(code="PR26CH0001", mentor_id=self.faculty.id)
        self.assertEqual(r.status_code, 403, r.content)
        team.refresh_from_db()
        self.assertEqual(team.mentor_id, self.office.id)

    def test_the_office_can_still_add_a_team_by_hand(self):
        self.client.force_login(self.office)
        r = self._post(mentor_id=self.faculty.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(Team.objects.get().mentor_id, self.faculty.id)
