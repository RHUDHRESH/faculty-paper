"""The 2026 final-year project workbook: two sheets, a row per student.

Every workbook here is built with openpyxl, in the layout of the real one (read
once, read-only, to learn its headers and placeholders). The real file carries
students' names and is never copied into the repository, nor are any of its
rows: the people below are invented.
"""
from __future__ import annotations

import io
from datetime import datetime
from io import StringIO

import openpyxl
from django.core.management import call_command
from django.test import TestCase

from core.models import Role, Team, User
from core.services.fyp_roster import RosterError, import_roster, read_roster
from core.test_fyp_scheme import roster_row, roster_workbook

SEC_HEADER = [
    "Department", "Team No", "Name", "Faculty ID", "Reg No - 1", "Name - 1",
    "Project Title", "Article Title", "Source Title", "Document Type", "ISSN",
    "Publication Date", "Scopus EID", "DOI", "Scopus Article Link",
    "Article Link", "Team Members", "Reference Article Link",
]
SCOFT_HEADER = [
    "S.No.", "Register No", "Learners Name", "Learner Moodle Name",
    "Mentor Name", "Mentor-code", "Mentor Moodle Name", "TeamNo", "Column1",
    "Dept", "ProjectTitle", "Cont-type", "Column 1", "Column 2",
]


def sec_row(dept, team, mentor, faculty_id, reg, name, title="A title", **pub):
    row = [dept, team, mentor, faculty_id, reg, name, title] + [None] * 11
    for k, v in pub.items():
        row[[h.lower() for h in SEC_HEADER].index(k.replace("_", " "))] = v
    return row


def scoft_row(n, reg, name, mentor, code, team_no, column1, dept="CSE",
              title="projecttiteanotfound"):
    return [n, reg, name, f"{name} moodle", mentor, code, f"{mentor} moodle",
            team_no, column1, dept, title, "conttypenotfound", None, None]


def workbook(*sheets) -> io.BytesIO:
    """sheets: (title, header, rows) triples."""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for title, header, rows in sheets:
        ws = wb.create_sheet(title)
        ws.append(header)
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


def _person(email, name, **extra):
    return User.objects.create_user(
        email=email, password="pass", name=name, role=Role.FACULTY, **extra
    )


class SecSheetTests(TestCase):
    """"SEC (3)": Team No, Name + Faculty ID for the mentor, Reg No - 1 and
    Name - 1 for ONE student, so a team is several rows."""

    def _read(self, rows, **kw):
        return read_roster(workbook(("SEC (3)", SEC_HEADER, rows)), **kw)

    def test_the_rows_of_one_team_number_are_one_team_with_all_its_students(self):
        roster = self._read([
            sec_row("MBA", "26PBA001", "Dr. Ann", "TSBA001", 212224410001, "Asha K", "Bidding"),
            sec_row("MBA", "26PBA001", "Dr. Ann", "TSBA001", 212224410002, "Bala M", "Bidding"),
            sec_row("MBA", "26PBA002", "Dr. Ann", "TSBA001", 212224410003, "Chitra R", "Stock"),
        ])
        self.assertEqual([r.code for r in roster.rows], ["26PBA001", "26PBA002"])
        team = roster.rows[0]
        self.assertEqual(team.students, [("212224410001", "Asha K"), ("212224410002", "Bala M")])
        self.assertEqual((team.mentor_name, team.mentor_staff_id), ("Dr. Ann", "TSBA001"))
        self.assertEqual((team.department, team.title), ("MBA", "Bidding"))
        report = roster.reports[0]
        self.assertEqual(
            (report.rows_read, report.teams, report.students, report.mentors, report.skipped),
            (3, 2, 3, 1, 0),
        )

    def test_the_year_is_2025_26_unless_one_is_given(self):
        rows = [sec_row("MBA", "26PBA001", "Dr. Ann", "TSBA001", 1, "A")]
        self.assertEqual(self._read(rows).rows[0].academic_year, "2025-26")
        self.assertEqual(self._read(rows, academic_year="2026-27").rows[0].academic_year, "2026-27")

    def test_a_student_whose_mentor_differs_does_not_choose_the_teams_mentor(self):
        """Three students, three mentors: the commonest wins, the first named
        on a tie, and the others are kept so the office can see the conflict."""
        roster = self._read([
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A"),
            sec_row("CSE", "26UEC001", "Dr. Two", "TSEC002", 2, "B"),
            sec_row("CSE", "26UEC001", "Dr. Two", "TSEC002", 3, "C"),
            sec_row("CSE", "26UEC002", "Dr. One", "TSEC001", 4, "D"),
            sec_row("CSE", "26UEC002", "Dr. Two", "TSEC002", 5, "E"),
        ])
        first, second = roster.rows
        self.assertEqual(first.mentor_staff_id, "TSEC002")
        self.assertEqual([m[0] for m in first.mentors], ["TSEC002", "TSEC001"])
        self.assertEqual(second.mentor_staff_id, "TSEC001")  # a tie: first named
        self.assertEqual(first.mentor_of[("2", "B")], "Dr. Two")

    def test_the_publication_columns_stay_on_the_team_with_excel_dates_read(self):
        roster = self._read([
            sec_row(
                "CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A",
                article_title="A Sensor Study", source_title="Lecture Notes",
                document_type="Book Series", issn=23673370, publication_date=46023,
                scopus_eid="2-s2.0-105047323637", doi="10.1007/978-3-032-28307-8_23",
                scopus_article_link="https://www.scopus.com/x",
                article_link="https://drive.example/y",
            ),
            # The same article on the team's second student's row: one article.
            sec_row(
                "CSE", "26UEC001", "Dr. One", "TSEC001", 2, "B",
                article_title="A Sensor Study", scopus_eid="2-s2.0-105047323637",
                publication_date=datetime(2026, 1, 1),
            ),
            # Stray cells in the DOI and date columns that are not a DOI or a date.
            sec_row("CSE", "26UEC002", "Dr. One", "TSEC001", 3, "C",
                    article_title="Other", doi=46235, publication_date="Linked"),
        ])
        (pub,) = roster.rows[0].publications
        self.assertEqual(pub["publication_date"], "2026-01-01")
        self.assertEqual(pub["issn"], "2367-3370")
        self.assertEqual(pub["doi"], "10.1007/978-3-032-28307-8_23")
        self.assertEqual(pub["scopus_eid"], "2-s2.0-105047323637")
        self.assertEqual(pub["article_link"], "https://drive.example/y")
        (other,) = roster.rows[1].publications
        self.assertEqual(other, {"article_title": "Other"})
        self.assertEqual(roster.reports[0].publications, 2)

    def test_a_row_with_no_team_no_or_no_student_is_skipped_and_counted(self):
        roster = self._read([
            sec_row("CSE", None, "Dr. One", "TSEC001", 1, "Orphan"),
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", None, None),
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 2, "Kept"),
        ])
        self.assertEqual([(r.code, r.students) for r in roster.rows], [("26UEC001", [("2", "Kept")])])
        report = roster.reports[0]
        self.assertEqual(report.skipped, 2)
        self.assertEqual(report.skipped_because, {"no team code": 1, "no student on the row": 1})
        self.assertEqual(len(roster.skipped), 2)

    def test_a_student_listed_twice_on_a_team_is_one_student(self):
        roster = self._read([
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A"),
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A"),
        ])
        self.assertEqual(roster.rows[0].students, [("1", "A")])
        self.assertEqual(roster.reports[0].students, 1)
        self.assertEqual(roster.reports[0].skipped, 1)

    def test_headers_are_found_whatever_the_case_spacing_or_punctuation(self):
        header = [h.upper().replace(" ", "_").replace("-", "") for h in SEC_HEADER]
        header = ["TEAM  NO" if h == "TEAM_NO" else h for h in header]
        header = ["Faculty-ID" if h == "FACULTY_ID" else h for h in header]
        roster = read_roster(workbook(("Sheet1", header, [
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A")
        ])))
        self.assertEqual(roster.rows[0].mentor_staff_id, "TSEC001")


class ScoftSheetTests(TestCase):
    """"SCOFT-...": a row per student, a placeholder for the team number, and
    the real team code in a column the department left named "Column1"."""

    def _read(self, rows, **kw):
        return read_roster(workbook(("SCOFT-CSE-IT", SCOFT_HEADER, rows)), **kw)

    def test_students_are_grouped_by_the_team_code_when_the_team_no_is_a_placeholder(self):
        roster = self._read([
            scoft_row(1, 2122, "Asha K", "Dr. One", "TSCS001", "teamentrynotfound", "26USF351"),
            scoft_row(2, 2123, "Bala M", "Dr. One", "TSCS001", "teamentrynotfound", "26USF351"),
            scoft_row(3, 2124, "Chitra R", "Dr. Two", "TSCS002", "teamentrynotfound", "26USF352"),
        ])
        self.assertEqual([r.code for r in roster.rows], ["26USF351", "26USF352"])
        self.assertEqual(
            roster.rows[0].students, [("2122", "Asha K"), ("2123", "Bala M")]
        )
        report = roster.reports[0]
        self.assertEqual((report.teams, report.students, report.mentors), (2, 3, 2))

    def test_the_code_shaped_value_beats_a_numbered_team_label(self):
        """"TEAMNO201" labels the row; "26USF201" is the code SEC's sheet uses
        for the same team, so it is the one the team is keyed on."""
        roster = self._read([
            scoft_row(1, 1, "A", "Dr. One", "TSCS001", "TEAMNO201", "26USF201"),
        ])
        self.assertEqual(roster.rows[0].code, "26USF201")

    def test_a_real_team_no_is_used_when_column1_is_no_team_code(self):
        roster = self._read([
            scoft_row(1, 1, "A", "Dr. One", "TSCS001", "TEAMNO201", "something else"),
            scoft_row(2, 2, "B", "Dr. One", "TSCS001", "teamentrynotfound", "also not a code"),
        ])
        self.assertEqual([r.code for r in roster.rows], ["TEAMNO201"])
        self.assertEqual(roster.reports[0].skipped_because, {"no team code": 1})

    def test_placeholders_are_blanks(self):
        roster = self._read([
            scoft_row(1, 1, "A", "Dr. One", "TSCS001", "teamentrynotfound", "26USF351"),
            scoft_row(2, 2, "B", "Dr. One", "TSCS001", "teamentrynotfound", "26USF351",
                      title="Smart Incubator"),
        ])
        self.assertEqual(roster.rows[0].title, "Smart Incubator")  # not "projecttiteanotfound"
        lonely = self._read([scoft_row(1, 1, "A", "Dr. One", "TSCS001", "x", "26USF351")])
        self.assertIsNone(lonely.rows[0].title)

    def test_the_department_is_read_from_dept_and_the_mentor_from_mentor_name(self):
        roster = self._read([
            scoft_row(1, 1, "A", "Dr. One", "TSCS001", "x", "26USF351", dept="AIDS"),
        ])
        row = roster.rows[0]
        self.assertEqual((row.department, row.mentor_name, row.mentor_staff_id),
                         ("AIDS", "Dr. One", "TSCS001"))


class TwoSheetWorkbookTests(TestCase):
    """The real workbook lists the SCOFT teams on both sheets."""

    def _wb(self):
        return workbook(
            ("SEC (3)", SEC_HEADER, [
                sec_row("CSE", "26USF351", "Dr. One", "TSCS001", 2122, "Asha K"),
                sec_row("CSE", "26USF351", "Dr. One", "TSCS001", 2123, "Bala M"),
                sec_row("MBA", "26PBA001", "Dr. Ann", "TSBA001", 3001, "Dev N",
                        article_title="Paper", scopus_eid="2-s2.0-1"),
            ]),
            ("SCOFT-CSE-IT", SCOFT_HEADER, [
                scoft_row(1, 2122, "Asha K", "Dr. One", "TSCS001", "teamentrynotfound",
                          "26USF351", title="Smart Incubator"),
                scoft_row(2, 2123, "Bala M", "Dr. One", "TSCS001", "teamentrynotfound",
                          "26USF351", title="Smart Incubator"),
                scoft_row(3, 2124, "Chitra R", "Dr. Two", "TSCS002", "teamentrynotfound",
                          "26USF351", title="Smart Incubator"),
            ]),
        )

    def test_a_team_on_both_sheets_is_one_team_with_its_students_merged(self):
        roster = read_roster(self._wb())
        self.assertEqual(sorted(r.code for r in roster.rows), ["26PBA001", "26USF351"])
        team = next(r for r in roster.rows if r.code == "26USF351")
        self.assertEqual(sorted(reg for reg, _ in team.students), ["2122", "2123", "2124"])
        self.assertEqual(team.sheets, ["SEC (3)", "SCOFT-CSE-IT"])
        self.assertEqual(team.title, "Smart Incubator")
        self.assertEqual([(r.sheet, r.teams, r.students) for r in roster.reports],
                         [("SEC (3)", 2, 3), ("SCOFT-CSE-IT", 1, 3)])

    def test_the_result_reports_each_sheet_and_the_mentors_with_no_account(self):
        _person("one@test.edu", "One", staff_id="TSCS001")
        result = import_roster(read_roster(self._wb()))
        self.assertEqual((result["teams"], result["created"]), (2, 2))
        by_sheet = {s["sheet"]: s for s in result["sheets"]}
        sec, scoft = by_sheet["SEC (3)"], by_sheet["SCOFT-CSE-IT"]
        # TSBA001 has no account; TSCS001 (the team's commonest mentor) has.
        self.assertEqual(
            (sec["teams"], sec["students"], sec["teams_mentor_unmatched"],
             sec["mentor_ids_unmatched"]),
            (2, 3, 1, 1),
        )
        self.assertEqual((scoft["teams"], scoft["teams_mentor_unmatched"]), (1, 0))
        self.assertEqual([m["faculty_id"] for m in result["mentors_unmatched"]], ["TSBA001"])
        self.assertEqual(
            [c["code"] for c in result["mentor_conflicts"]], ["26USF351"]
        )  # Dr. Two named one student of three
        self.assertEqual(result["publications_read"], 1)
        team = Team.objects.get(code="26USF351")
        self.assertEqual(team.mentor.staff_id, "TSCS001")
        self.assertEqual(team.academic_year, "2025-26")
        self.assertEqual(team.members.get(register_number="2124").mentor_name, "Dr. Two")

    def test_importing_the_same_workbook_again_changes_nothing(self):
        import_roster(read_roster(self._wb()))
        again = import_roster(read_roster(self._wb()))
        self.assertEqual((again["created"], again["updated"], again["unchanged"]), (0, 0, 2))
        self.assertEqual(Team.objects.count(), 2)

    def test_a_changed_student_updates_the_team_by_its_code(self):
        import_roster(read_roster(self._wb()))
        wb = openpyxl.load_workbook(self._wb())
        wb["SCOFT-CSE-IT"].append(
            scoft_row(4, 2125, "Esha T", "Dr. One", "TSCS001", "teamentrynotfound", "26USF351")
        )
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        again = import_roster(read_roster(buf))
        self.assertEqual((again["created"], again["updated"], again["unchanged"]), (0, 1, 1))
        self.assertEqual(Team.objects.get(code="26USF351").members.count(), 4)

    def test_the_command_prints_a_report_per_sheet(self):
        import tempfile
        from pathlib import Path

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "roster.xlsx"
            path.write_bytes(self._wb().getvalue())
            out = StringIO()
            call_command("import_fyp_teams", str(path), stdout=out)
        text = out.getvalue()
        self.assertIn("[SEC (3)] one row per student: 3 rows, 2 teams, 3 students", text)
        self.assertIn("[SCOFT-CSE-IT]", text)
        self.assertIn("mentors unmatched", text)
        self.assertIn("2025-26", text)


class OldLayoutStillReadTests(TestCase):
    def test_the_team_id_layout_is_unchanged_and_reported_as_one_row_per_team(self):
        roster = read_roster(io.BytesIO(roster_workbook([
            roster_row("PR26CH0001", students=[(1, "A"), (2, "B")]),
            roster_row("PR26CH0002", students=[(3, "C")]),
        ])))
        self.assertEqual([r.code for r in roster.rows], ["PR26CH0001", "PR26CH0002"])
        self.assertEqual(roster.rows[0].academic_year, "2025-26")  # from the sheet name
        (report,) = roster.reports
        self.assertEqual((report.layout, report.teams, report.students), ("one row per team", 2, 3))

    def test_an_old_sheet_and_a_new_sheet_in_one_workbook_are_both_read(self):
        wb = openpyxl.load_workbook(io.BytesIO(roster_workbook(
            [roster_row("PR26CH0001", students=[(1, "A")])]
        )))
        ws = wb.create_sheet("SEC (3)")
        ws.append(SEC_HEADER)
        ws.append(sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 9, "Z"))
        buf = io.BytesIO()
        wb.save(buf)
        roster = read_roster(buf)
        self.assertEqual(sorted(r.code for r in roster.rows), ["26UEC001", "PR26CH0001"])

    def test_a_workbook_that_is_neither_layout_is_refused_and_says_what_is_needed(self):
        with self.assertRaises(RosterError) as caught:
            read_roster(workbook(("S", ["Team No", "Name", "Marks"], [["26UEC001", "A", 5]])))
        self.assertIn("Faculty ID", str(caught.exception))


class StoredPublicationsAndMixedMentorTests(TestCase):
    def _wb(self, extra=()):
        return workbook(("SEC (3)", SEC_HEADER, [
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A",
                    article_title="A Sensor Study!", doi="https://doi.org/10.1007/X1",
                    scopus_eid="2-s2.0-1", publication_date=46023, issn=23673370),
            # Same DOI, typed differently, on a teammate's row: one article.
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 2, "B",
                    article_title="a sensor study", doi="10.1007/x1"),
            # No DOI: de-duplicated by normalized title.
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 3, "C",
                    article_title="Second Paper"),
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 4, "D",
                    article_title="SECOND  paper."),
            sec_row("CSE", "26UEC002", "Dr. One", "TSEC001", 5, "E"),
            *extra,
        ]))

    def test_articles_are_stored_on_the_team_and_deduplicated(self):
        import_roster(read_roster(self._wb()))
        team = Team.objects.get(code="26UEC001")
        self.assertEqual(len(team.publications), 2)
        sensor = next(p for p in team.publications if p.get("doi"))
        self.assertEqual(sensor["doi"], "10.1007/X1")
        self.assertEqual(sensor["publication_date"], "2026-01-01")
        self.assertEqual(sensor["issn"], "2367-3370")
        self.assertEqual(sensor["scopus_eid"], "2-s2.0-1")
        self.assertEqual(Team.objects.get(code="26UEC002").publications, [])

    def test_re_import_is_idempotent_and_changes_a_team_only_when_its_articles_differ(self):
        import_roster(read_roster(self._wb()))
        again = import_roster(read_roster(self._wb()))
        self.assertEqual((again["created"], again["updated"], again["unchanged"]), (0, 0, 2))
        changed = import_roster(read_roster(self._wb(extra=[
            sec_row("CSE", "26UEC002", "Dr. One", "TSEC001", 5, "E",
                    article_title="Newly Linked"),
        ])))
        self.assertEqual((changed["updated"], changed["unchanged"]), (1, 1))
        self.assertEqual(Team.objects.get(code="26UEC002").publications[0]["article_title"],
                         "Newly Linked")

    def test_a_roster_without_articles_does_not_empty_the_stored_ones(self):
        import_roster(read_roster(self._wb()))
        bare = workbook(("SEC (3)", SEC_HEADER, [
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A"),
        ]))
        import_roster(read_roster(bare))
        self.assertEqual(len(Team.objects.get(code="26UEC001").publications), 2)

    def test_the_summary_and_team_detail_expose_the_articles(self):
        from django.test import Client

        office = User.objects.create_user(
            email="cell@test.edu", password="pass", name="Cell", role=Role.RESEARCH_CELL
        )
        import_roster(read_roster(self._wb()))
        client = Client()
        client.force_login(office)
        body = client.get("/api/admin/fyp-teams").json()
        self.assertEqual((body["teams_with_publications"], body["publications"]), (1, 2))
        team = client.get("/api/teams/26UEC001").json()
        self.assertEqual(team["publications_count"], 2)
        self.assertEqual(len(team["publications"]), 2)

    def test_mixed_mentor_teams_are_listed_with_who_was_chosen_and_counted_per_sheet(self):
        wb = workbook(("SEC (3)", SEC_HEADER, [
            sec_row("CSE", "26UEC001", "Dr. One", "TSEC001", 1, "A"),
            sec_row("CSE", "26UEC001", "Dr. Two", "TSEC002", 2, "B"),
            sec_row("CSE", "26UEC001", "Dr. Two", "TSEC002", 3, "C"),
            sec_row("CSE", "26UEC002", "Dr. One", "TSEC001", 4, "D"),
        ]))
        result = import_roster(read_roster(wb))
        (conflict,) = result["mentor_conflicts"]
        self.assertEqual(conflict["code"], "26UEC001")
        self.assertEqual(conflict["chosen"], {"faculty_id": "TSEC002", "name": "Dr. Two"})
        self.assertEqual(conflict["others"], [{"faculty_id": "TSEC001", "name": "Dr. One"}])
        self.assertEqual(conflict["sheets"], ["SEC (3)"])
        self.assertEqual(result["mentor_conflicts_total"], 1)
        self.assertEqual(result["sheets"][0]["teams_mixed_mentors"], 1)

    def test_the_mixed_mentor_list_is_capped_at_200_but_the_total_is_not(self):
        rows = []
        for n in range(205):
            code = f"26UEC{n:03d}"
            rows += [sec_row("CSE", code, "Dr. One", "TSEC001", n * 2, "A"),
                     sec_row("CSE", code, "Dr. Two", "TSEC002", n * 2 + 1, "B")]
        result = import_roster(read_roster(workbook(("SEC (3)", SEC_HEADER, rows))))
        self.assertEqual(len(result["mentor_conflicts"]), 200)
        self.assertEqual(result["mentor_conflicts_total"], 205)
        self.assertEqual(result["sheets"][0]["teams_mixed_mentors"], 205)
