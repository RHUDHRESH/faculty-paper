"""Roster names spelt differently from the person's own papers.

    manage.py check_roster_names

Report only. A super admin accepts or dismisses each suggestion on the
Record quality screen (/data/record); nothing here renames anybody.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.services import record_quality as rq


class Command(BaseCommand):
    help = "Suggest roster name corrections from how each person's papers spell their name."

    def add_arguments(self, parser):
        parser.add_argument("--min-papers", type=int, default=2)

    def handle(self, *args, min_papers=2, **opts):
        rows = rq.roster_name_suggestions(min_papers=min_papers)
        self.stdout.write(f"{len(rows)} roster names to check")
        for r in rows:
            self.stdout.write(
                f"- {r['name']} ({r['department'] or 'no dept'}) -> {r['suggested']}: "
                f"{r['papers']} papers spell it '{r['spelt']}' ({r['unmatched_papers']} not linked to them), "
                f"{r['roster_spelling_papers']} spell it '{r['word']}'. e.g. {', '.join(r['samples'])}"
            )
