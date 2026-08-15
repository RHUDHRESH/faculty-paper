"""Publish the Publication Processing Workflow's Step 8 policy as a new version.

The live FormulaConfig predates that document: it carries the older author
weightage table and a 5,000 Q4 incentive. Rates are versioned rather than
edited so already-paid claims keep the snapshot they were calculated under.

    python manage.py apply_policy_document          # show the diff, change nothing
    python manage.py apply_policy_document --apply  # publish it
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone

from core.models import FormulaConfig
from core.services.remuneration import (
    DEFAULT_AUTHOR_POINTS,
    DEFAULT_PUB_TYPE_MULTIPLIERS,
    MAX_ELIGIBLE_AUTHORS,
    MIN_SEC_REFERENCES,
)

#: Step 8 of the workflow document, verbatim.
POLICY = {
    "snip_multiplier": 55000,
    "qf_q1": 50000,
    "qf_q2": 30000,
    "qf_q3": 15000,
    "qf_q4": 7000,
    "fixed_journal_no_snip": 5000,
    "fixed_other_no_snip": 4000,
    "fixed_web_of_science": 5000,
    "max_authors": MAX_ELIGIBLE_AUTHORS,
    "min_sec_references": MIN_SEC_REFERENCES,
}


class Command(BaseCommand):
    help = "Publish the workflow document's remuneration policy as a new version."

    def add_arguments(self, parser):
        parser.add_argument(
            "--apply",
            action="store_true",
            help="Write the new version. Without it, only the differences are printed.",
        )

    def handle(self, *args, **opts):
        current = FormulaConfig.objects.filter(active=True).order_by("-version").first()
        points_json = json.dumps(DEFAULT_AUTHOR_POINTS)

        changes: list[str] = []
        for key, value in POLICY.items():
            now = getattr(current, key, None) if current else None
            if now is None or float(now) != float(value):
                changes.append(f"  {key}: {now} -> {value}")
        if not current or (current.author_point_json or "") != points_json:
            changes.append("  author_point_json: replaced with the policy weightage table")

        if not changes:
            self.stdout.write(self.style.SUCCESS("Live policy already matches the document."))
            return

        self.stdout.write("Differences from the live policy:")
        for line in changes:
            self.stdout.write(line)

        if not opts["apply"]:
            self.stdout.write(
                self.style.WARNING("\nDry run. Re-run with --apply to publish this version.")
            )
            return

        with transaction.atomic():
            next_version = (current.version + 1) if current else 1
            FormulaConfig.objects.filter(active=True).update(active=False)
            cfg = FormulaConfig.objects.create(
                name=f"Publication Processing Workflow v{next_version}",
                version=next_version,
                effective_from=timezone.now().date(),
                author_point_json=points_json,
                publication_type_multipliers_json=json.dumps(DEFAULT_PUB_TYPE_MULTIPLIERS),
                notes="Step 8 of the Publication Processing Workflow document.",
                active=True,
                **POLICY,
            )
        self.stdout.write(
            self.style.SUCCESS(f"\nPublished '{cfg.name}' (version {cfg.version}) and made it live.")
        )
        self.stdout.write("Claims already paid keep the snapshot they were calculated under.")
