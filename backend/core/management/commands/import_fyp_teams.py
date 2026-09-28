"""Load the final-year project roster: one team per row, students and mentor.

    python manage.py import_fyp_teams "Final Year Project Teams - AY 2025 - 2026.xlsx"
    python manage.py import_fyp_teams roster.xlsx --academic-year 2025-26

Safe to run again on a corrected copy: a team is found by its Team ID and
changes only where the row says something different. Mentors whose Faculty ID
matches no account's staff id are loaded with the raw id and name and listed
at the end, so the missing accounts can be created and the file re-run.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core.services.fyp_roster import RosterError, import_roster, read_roster


class Command(BaseCommand):
    help = "Import final-year project teams from the department's roster workbook."

    def add_arguments(self, parser):
        parser.add_argument("path", help="The roster workbook (.xlsx)")
        parser.add_argument(
            "--academic-year",
            default=None,
            help='As "2025-26". Read off the sheet name ("25-26") when not given.',
        )

    def handle(self, *args, **opts):
        try:
            with open(opts["path"], "rb") as fh:
                roster = read_roster(fh, academic_year=opts["academic_year"])
        except OSError as exc:
            raise CommandError(f"Cannot open {opts['path']}: {exc}") from exc
        except RosterError as exc:
            raise CommandError(str(exc)) from exc

        result = import_roster(roster)
        out = self.stdout
        out.write(
            f"Sheet {result['sheet']!r}, academic year {result['academic_year'] or 'not stated'}: "
            f"{result['teams']} teams read."
        )
        out.write(f"  created: {result['created']}")
        out.write(f"  updated: {result['updated']}")
        out.write(f"  unchanged: {result['unchanged']}")
        out.write(f"  mentors unmatched: {len(result['mentors_unmatched'])}")
        for m in result["mentors_unmatched"]:
            out.write(
                f"    {m['code']}  {m['faculty_id'] or '(no Faculty ID)'}  "
                f"{m['mentor_name'] or '(no name)'}  {m['department'] or ''}".rstrip()
            )
        if result["skipped"]:
            out.write(f"  rows skipped: {len(result['skipped'])}")
            for line in result["skipped"]:
                out.write(f"    {line}")
        out.write(self.style.SUCCESS("Done."))
