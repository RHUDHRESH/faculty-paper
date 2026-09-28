"""Award every badge earned and check every department target, now.

The same work the hourly job does (`core.tasks.award_badges_and_milestones`),
run by hand -- after an ERP import, or to see what the engine makes of a
database before switching it on:

    python manage.py award_badges
    python manage.py award_badges --report     # and how many people hold each badge

Safe to repeat: a second run writes nothing it has already written and tells
nobody anything twice.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db.models import Count

from core.models import Badge
from core.services.achievements import CATALOGUE, run_all


class Command(BaseCommand):
    help = "Award badges and check department target milestones (idempotent)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--report",
            action="store_true",
            help="Also print how many people hold each kind of badge.",
        )

    def handle(self, *args, **options):
        result = run_all()
        self.stdout.write(
            f"badges created: {result['badges_created']}, withdrawn: {result['badges_removed']}, "
            f"department milestones: {result['milestones']}"
        )
        for kind, n in sorted(result["by_kind"].items()):
            self.stdout.write(f"  new {kind}: {n}")
        if options["report"]:
            self.stdout.write("held, by kind (people):")
            rows = Badge.objects.values("kind").annotate(people=Count("user", distinct=True))
            for row in sorted(rows, key=lambda r: list(CATALOGUE).index(r["kind"]) if r["kind"] in CATALOGUE else 99):
                self.stdout.write(f"  {row['kind']:<18} {row['people']}")
            self.stdout.write(
                f"people with at least one badge: {Badge.objects.values('user').distinct().count()}"
            )
