"""Match harvested authors to college members, and recompute metrics.

    python manage.py match_authors               # ORCID -> records -> OpenAlex id -> name
    python manage.py match_authors --link        # tie claims / ledger rows to papers first
    python manage.py match_authors --ambiguous   # list the names left unmatched on purpose
    python manage.py match_authors --scopus-profile "Scopus Profile_V3.1.xlsx"

Rows a person corrected (`match_locked`) are never touched.
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from core.services import publications


class Command(BaseCommand):
    help = "Match publication authors to users and refresh per-user publication metrics."

    def add_arguments(self, parser):
        parser.add_argument("--link", action="store_true", help="Link claims and ledger rows first.")
        parser.add_argument("--ambiguous", action="store_true", help="Print every ambiguous name.")
        parser.add_argument("--scopus-profile", default=None, help="Import a Scopus profile workbook first.")

    def handle(self, *args, link=False, ambiguous=False, scopus_profile=None, **opts):
        if scopus_profile:
            from core.services.scopus_profile import import_workbook

            self.stdout.write(json.dumps(import_workbook(scopus_profile), indent=2, default=str))
        if link:
            self.stdout.write(json.dumps(publications.link_records()))
        out = publications.match_authors()
        people = publications.refresh_metrics()
        listed = out.pop("ambiguous")
        out["ambiguous"] = len(listed)
        out["people_with_metrics"] = people
        self.stdout.write(json.dumps(out, indent=2))
        if ambiguous:
            for item in listed:
                self.stdout.write(f"{item['name']}  ->  {', '.join(item['candidates'])}")
