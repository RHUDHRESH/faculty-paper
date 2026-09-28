"""Fill empty profile photos, bios and designations from a college-site scrape.

    python manage.py import_college_site "D:/Faculty Paper/data/scraped" [--dry-run]

Idempotent: it never overwrites what a person set, and fills each field for a
person once (so a photo somebody removed is not put back).
"""
import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from core.services.college_site import FolderSource, ZipSource, import_site


class Command(BaseCommand):
    help = "Import faculty photos/bios and department descriptions from a college-site scrape folder or zip."

    def add_arguments(self, parser):
        parser.add_argument("folder")
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--json", action="store_true", help="Print the full report as JSON.")

    def handle(self, folder, dry_run=False, json=False, **_):  # noqa: A002
        path = Path(folder)
        if path.is_file() and path.suffix.lower() == ".zip":
            source = ZipSource(path.read_bytes())
        elif path.is_dir():
            source = FolderSource(path)
        else:
            raise CommandError(f"{folder} is neither a folder nor a .zip")
        try:
            report = import_site(source, dry_run=dry_run).as_dict()
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        if json:
            self.stdout.write(_json.dumps(report, indent=1, ensure_ascii=False))
            return
        for key in ("scraped", "matched", "unmatched_count", "photos", "bios", "designations",
                    "interests", "departments"):
            self.stdout.write(f"{key:>16}: {report[key]}")
        self.stdout.write(f"{'conflicts':>16}: {len(report['conflicts'])}")
        if dry_run:
            self.stdout.write("(dry run: nothing saved)")


_json = json
