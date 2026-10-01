"""Move research faculty from the old papers-a-year quota to the rupee threshold.

Run once after the migration that adds the threshold. It changes no money that
has been paid. It does three things and reports each:

1. Counts research faculty who still carry the old papers-a-year quota and have
   no rupee threshold: they show as "old rule, please set a rupee threshold"
   until the research coordinator sets one. No amount is invented for them.
2. Re-prices claims that are still on their way and were held at nothing by the
   old rule (`quota_applied` with no rupees absorbed), because that rule no
   longer decides anything.
3. Re-decides what the threshold absorbs across every research faculty
   member's open claims.

`--dry-run` reports without writing.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.api.common import _apply_calc
from core.models import Claim, ClaimStatus, User
from core.services import research_threshold as rt


class Command(BaseCommand):
    help = "Carry research faculty over from the papers-a-year quota to the rupee threshold."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, dry_run=False, **options):
        research = User.objects.filter(faculty_type="RESEARCH")
        old = [u for u in research if u.research_quota and rt.threshold_on(rt.history(u.id), rt.today()) is None]
        self.stdout.write(f"research faculty: {research.count()}")
        self.stdout.write(f"  still on the old quota with no rupee threshold: {len(old)}")
        for u in old:
            self.stdout.write(f"    {u.name} ({u.department or 'no department'}): {u.research_quota} papers a year")

        stuck = Claim.objects.filter(quota_applied=True, research_absorbed=0).exclude(
            status__in=[ClaimStatus.PAID, ClaimStatus.REJECTED, ClaimStatus.DRAFT]
        )
        self.stdout.write(f"claims on their way held at nothing by the old rule: {stuck.count()}")
        if dry_run:
            return
        fixed = 0
        for claim in stuck.select_related("owner"):
            _apply_calc(claim)
            claim.save()
            fixed += 1
        moved = sum(rt.refresh_open_claims(u) for u in research)
        self.stdout.write(f"re-priced {fixed} claims; re-decided {moved} more under the threshold")
