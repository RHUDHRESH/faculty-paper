"""`manage.py seed_demo`: the demo college (`seed --demo`) plus the tickets
a research cell has to catch: affiliation missing, a DOI already claimed, a
quartile claimed higher than the record, and a journal on the watch-list.

Idempotent: every extra ticket is keyed by its ticket number.
"""
from __future__ import annotations

from datetime import timedelta

from django.core.management import call_command
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from core.api.common import _apply_calc
from core.models import Claim, ClaimStatus, JournalWatch, Role, User


class Command(BaseCommand):
    help = "Seed the demo college plus suspicious claims for the research cell."

    def handle(self, *args, **opts):
        # Its own guard, not only `seed`'s: it writes demo tickets and a
        # watch-list entry that must never land in a live college's data.
        if not settings.DEBUG:
            raise CommandError("seed_demo runs only with DJANGO_DEBUG=true.")
        call_command("seed", demo=True)
        base = Claim.objects.filter(ticket_number__startswith="DEMO-", issn__isnull=False).first()
        if base is None:
            self.stdout.write("No demo claim to copy from; skipped the suspicious tickets.")
            return
        people = list(User.objects.filter(role=Role.FACULTY).exclude(pk=base.owner_id)[:3]) or [base.owner]
        cell = User.objects.filter(role=Role.RESEARCH_CELL).first()

        def make(ticket, owner, days, title, **extra):
            if Claim.objects.filter(ticket_number=ticket).exists():
                return
            fields = {
                f.name: getattr(base, f.name)
                for f in Claim._meta.concrete_fields
                if f.name in {
                    "journal_title", "issn", "publication_year", "publication_type", "aggregation_type",
                    "indexing_level", "engineering_class", "quartile", "quartile_source", "scimago_verified",
                    "scimago_sjr", "scimago_dataset_year", "snip", "snip_source", "snip_year",
                    "indexing_status", "linkage_status",
                }
            }
            fields.update(
                owner=owner, status=ClaimStatus.SUBMITTED, ticket_number=ticket, paper_title=title,
                doi=f"10.5555/demo.sus.{ticket[-2:]}", total_authors=3, author_position=1,
                affiliation_ok=True, verification_ok=True,
                submitted_at=timezone.now() - timedelta(days=days),
            )
            fields.update(extra)
            c = Claim.objects.create(**fields)
            _apply_calc(c)
            c.save()

        make("SUS-2025-01", people[0], 4, "Edge Caching for Rural Telemedicine Networks",
             affiliation_ok=False, verification_ok=False,
             verification_snapshot_json='{"issues": ["This college is not in the paper\'s affiliations"]}')
        make("SUS-2025-02", people[-1], 9, base.paper_title + " (co-author claim)",
             doi=base.doi, duplicate_warning=True,
             duplicate_matches_json='[{"source": "claim", "title": "%s", "who": "%s"}]'
             % (base.paper_title.replace('"', ""), base.owner.name))
        make("SUS-2025-03", people[min(1, len(people) - 1)], 21, "Graph Neural Networks for Power Grid Fault Location",
             self_reported_quartile="Q1", quartile="Q3")
        make("SUS-2025-04", people[0], 36, "Blockchain Voting on Low-Cost IoT Nodes",
             journal_title="International Journal of Advanced Research in Everything", issn="9999-0001",
             quartile=None, snip=None, scimago_verified=False)
        if not JournalWatch.objects.filter(issn="9999-0001").exists():
            JournalWatch.objects.create(
                issn="9999-0001", title="International Journal of Advanced Research in Everything",
                reason="Cloned site; the real title was discontinued from Scopus in 2024.", added_by=cell,
            )
        self.stdout.write("Suspicious tickets and the watch-list entry are in place.")
        from core.management.commands._demo_social import seed_social
        seed_social(self.stdout)
