"""Put photos and files back from a zip of the media folders.

    python manage.py import_media data/media-2026-10-07.zip [--overwrite]

The twin of the Admin page's "Photos and files" step, for a machine with a shell.
Files that are already held are left alone unless --overwrite is given.
"""
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from core.services import media_import


class Command(BaseCommand):
    help = "File the photos and files in a zip of backend/media (avatars, claims, feed, site) under their own names."

    def add_arguments(self, parser):
        parser.add_argument("zip", help="The zip made from the avatars, claims, feed and site folders.")
        parser.add_argument("--overwrite", action="store_true", help="Replace files that already exist.")

    def handle(self, zip, overwrite=False, **_):  # noqa: A002
        path = Path(zip)
        if not path.is_file():
            raise CommandError(f"{zip} is not a file")
        try:
            with path.open("rb") as handle:
                report = media_import.import_zip(handle, overwrite=overwrite)
        except media_import.MediaImportError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(f"Added: {report['added']} ({report['replaced']} replaced)")
        self.stdout.write(f"Skipped: {report['skipped']}")
        self.stdout.write(f"Bytes: {report['bytes']:,}")
        problems = report["rejected_count"]
        self.stdout.write(f"Problems: {problems}")
        for row in report["rejected"]:
            self.stdout.write(f"  {row['name']}: {row['why']}")
        if problems > len(report["rejected"]):
            self.stdout.write(f"  and {problems - len(report['rejected'])} more")
