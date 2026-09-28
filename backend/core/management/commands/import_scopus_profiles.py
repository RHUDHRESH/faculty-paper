"""Load Scopus author profiles from the office's profile workbook.

    python manage.py import_scopus_profiles "Scopus Profile_V3.1.xlsx"

One profile per sheet that carries a Scopus ID, keyed by that id, so running
it again on a newer copy updates the same rows. Each profile is linked to the
account carrying its id (or the faculty master's id for the account's staff
id); the ids that match no account are listed at the end.
"""
from __future__ import annotations

from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from core.services.scopus_profiles import ProfileWorkbookError, import_profiles, read_profiles


class Command(BaseCommand):
    help = "Import Scopus author profiles (one sheet per author) from an .xlsx workbook."

    def add_arguments(self, parser):
        parser.add_argument("path", help="The Scopus profile workbook (.xlsx)")

    def handle(self, *args, **opts):
        path = Path(opts["path"])
        try:
            with path.open("rb") as fh:
                profiles = read_profiles(fh)
        except OSError as exc:
            raise CommandError(f"Cannot open {path}: {exc}") from exc
        except ProfileWorkbookError as exc:
            raise CommandError(str(exc)) from exc

        result = import_profiles(profiles, source_file=path.name)
        out = self.stdout
        out.write(f"{result['sheets']} profile sheets read from {path.name}.")
        out.write(f"  created: {result['created']}")
        out.write(f"  updated: {result['updated']}")
        out.write(f"  linked to an account: {result['linked']}")
        out.write(f"  unmatched: {len(result['unmatched'])}")
        for u in result["unmatched"]:
            out.write(f"    {u['scopus_id']}  sheet {u['sheet']!r}  {u['author_name'] or ''}".rstrip())
        if result["ambiguous"]:
            out.write(f"  on more than one account: {len(result['ambiguous'])}")
            for a in result["ambiguous"]:
                out.write(f"    {a['scopus_id']}  {', '.join(a['accounts'])}")
        for warning in result["warnings"]:
            out.write(self.style.WARNING(f"  {warning}"))
        out.write(self.style.SUCCESS("Done."))
