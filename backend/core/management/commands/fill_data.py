"""Fill the gaps in the record from what the college has already given.

    python manage.py fill_data                        # dry run of every fix: counts, writes nothing
    python manage.py fill_data --apply                # apply every safe fix
    python manage.py fill_data --only user_department ledger_department
    python manage.py fill_data --list                 # the fixes and what each does

Reads the database only (the faculty list and settled claims are there once imported).
A fix only fills blank or stand-in values and lists every disagreement as a
conflict. Money is never touched. See core/services/data_fill.py.
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand, CommandError

from core.services import data_fill


class Command(BaseCommand):
    help = "Fill blank departments, designations, journal fields and author matches from the college's own files."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write the fixes (the default is a dry run).")
        parser.add_argument("--only", nargs="+", metavar="FIX", help="Run only these fixes.")
        parser.add_argument("--list", action="store_true", help="List the fixes and exit.")
        parser.add_argument("--json", action="store_true", help="Print the full result as JSON.")

    def handle(self, *args, apply=False, only=None, list=False,
               json=False, **opts):
        import json as _json

        if list:
            for f in data_fill.FIXES:
                self.stdout.write(f"{f.key:38} {f.kind:8} {f.label}")
            return
        try:
            results = data_fill.run(only, apply=apply)
        except data_fill.UnknownFix as exc:
            raise CommandError(f"No such fix: {exc}. Use --list.") from exc
        if json:
            self.stdout.write(_json.dumps([r.as_dict() for r in results], indent=2, default=str))
            return
        mode = "APPLIED" if apply else "DRY RUN (nothing written)"
        self.stdout.write(f"fill_data {mode}")
        self.stdout.write(f"{'fix':38} {'gap':>7} {'fills':>7} {'left':>7} {'conflicts':>9}")
        for r in results:
            self.stdout.write(f"{r.key:38} {r.gap_rows:7} {r.rows:7} {r.unresolved:7} {r.conflict_count:9}")
            for reason, n in sorted(r.reasons.items(), key=lambda kv: -kv[1])[:4]:
                self.stdout.write(f"    left: {n:5}  {reason}")
        self.stdout.write("")
        self.stdout.write("Money amounts are never changed. Conflicts are listed, not overwritten.")
