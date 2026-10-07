"""Load a list of journals to keep away from: Scopus discontinued, hijacked, or other.

    manage.py load_journal_flags hijacked.csv --source HIJACKED

Headings are read loosely: title / journal, issn, url / domain / website, note.
The previous entries of the same list are replaced unless --append is given.
"""
from __future__ import annotations

from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from core.models import JournalFlagList
from core.services.journal_check import load_flags


class Command(BaseCommand):
    help = "Load a journal flag list (Scopus discontinued, hijacked, other) from a CSV file."

    def add_arguments(self, parser):
        parser.add_argument("csv")
        parser.add_argument("--source", required=True, choices=JournalFlagList.Source.values)
        parser.add_argument("--append", action="store_true")

    def handle(self, *args, **opts):
        path = Path(opts["csv"])
        if not path.exists():
            raise CommandError(f"No such file: {path}")
        text = path.read_text(encoding="utf-8-sig", errors="replace")
        n = load_flags(text, opts["source"], replace=not opts["append"])
        self.stdout.write(f"Loaded {n} entries into the {opts['source']} list.")
