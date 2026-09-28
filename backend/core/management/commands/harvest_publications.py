"""Harvest the college's publication record from OpenAlex.

    python manage.py harvest_publications                 # everything, all years
    python manage.py harvest_publications --since 2024    # works published from 2024
    python manage.py harvest_publications --limit 200     # a trial run
    python manage.py harvest_publications --no-expand     # skip matched authors' other works
    python manage.py harvest_publications --refresh-citations   # the weekly job, now

Idempotent upsert: a second run changes only citation counts. The same work
is queued from POST /api/admin/publications/harvest.
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from core.services import publications


class Command(BaseCommand):
    help = "Harvest college publications from OpenAlex, link records, match authors (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument("--since", type=int, default=None, help="First publication year to harvest.")
        parser.add_argument("--limit", type=int, default=None, help="Stop after this many college works.")
        parser.add_argument("--no-expand", action="store_true", help="Do not pull matched authors' other works.")
        parser.add_argument("--refresh-citations", action="store_true", help="Only refresh citation counts.")

    def handle(self, *args, since=None, limit=None, no_expand=False, refresh_citations=False, **opts):
        if refresh_citations:
            out = publications.refresh_citations()
        else:
            out = publications.run_harvest(
                since=since, limit=limit, expand=not no_expand, log=lambda m: self.stdout.write(m)
            )
        self.stdout.write(json.dumps(out, indent=2, default=str))
