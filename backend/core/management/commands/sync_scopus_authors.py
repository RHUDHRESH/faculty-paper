"""Pull every member's papers from Scopus (Search API, AU-ID query).

    python manage.py sync_scopus_authors [--limit N] [--staff TSEE023 ...]

Needs SCOPUS_API_KEY. Oldest-synced people first; stops cleanly at the quota
and resumes on the next run.
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand, CommandError

from core.models import User
from core.services.scopus_sync import sync_scopus_authors


class Command(BaseCommand):
    help = "Upsert each member's Scopus papers into the publication record."

    def add_arguments(self, parser):
        parser.add_argument("--limit", type=int, default=None, help="At most this many people.")
        parser.add_argument("--staff", nargs="*", default=None, help="Only these staff ids.")

    def handle(self, *args, limit=None, staff=None, **opts):
        from django.conf import settings

        if not getattr(settings, "SCOPUS_API_KEY", ""):
            raise CommandError("SCOPUS_API_KEY is not set.")
        users = None
        if staff:
            users = list(User.objects.filter(staff_id__in=staff).exclude(scopus_author_id__isnull=True)
                         .exclude(scopus_author_id=""))
        out = sync_scopus_authors(users=users, limit=limit, log=self.stdout.write)
        per = out.pop("per_user")
        self.stdout.write(json.dumps(out, indent=2))
        for name, got in per.items():
            self.stdout.write(f"  {name}: Scopus total {got['total']}, seen {got['seen']}, new {got['created']}")
