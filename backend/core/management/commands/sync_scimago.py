"""Refresh the SCImago quartile dump.

    python manage.py sync_scimago --year 2024
    python manage.py sync_scimago --year 2024 --year 2023
"""
from __future__ import annotations

from datetime import date

from django.core.management.base import BaseCommand, CommandError

from core.services.scimago_sync import ScimagoSyncError, sync_year


class Command(BaseCommand):
    help = "Download the official SCImago journal rank dump and load the quartiles."

    def add_arguments(self, parser):
        parser.add_argument(
            "--year",
            type=int,
            action="append",
            dest="years",
            help="Dataset year. Repeat for several. Defaults to last year.",
        )

    def handle(self, *args, **opts):
        # The current year's dump is published well into the following year.
        years = opts.get("years") or [date.today().year - 1]
        failures = 0
        for year in years:
            self.stdout.write(f"Fetching SCImago {year}…")
            try:
                result = sync_year(year)
            except ScimagoSyncError as e:
                failures += 1
                self.stderr.write(self.style.ERROR(f"{year}: {e}"))
                continue
            self.stdout.write(
                self.style.SUCCESS(
                    f"{year}: {result['imported']} journals loaded, {result['skipped']} skipped"
                )
            )
        if failures:
            raise CommandError(f"{failures} of {len(years)} year(s) failed")
