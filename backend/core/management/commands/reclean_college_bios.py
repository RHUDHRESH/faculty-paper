"""Re-clean bios the college-site import filled, leaving user-written ones alone.

    python manage.py reclean_college_bios [--dry-run]
"""
from django.core.management.base import BaseCommand

from core.services.college_site import reclean_imported_bios


class Command(BaseCommand):
    help = "Strip PDF table leftovers from bios the college-site import filled."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, dry_run=False, **_):
        report = reclean_imported_bios(dry_run=dry_run)
        for s in report["samples"]:
            self.stdout.write(f"- {s['name']}\n    before: {s['before']}\n    after:  {s['after']}")
        self.stdout.write(f"checked {report['checked']}, changed {report['changed']}"
                          + (" (dry run: nothing saved)" if dry_run else ""))
