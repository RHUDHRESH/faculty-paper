"""Put the papers the cleanup took off faculty records to their owners, to confirm or reject.

The cleanup of 2026-10-24 removed the links the name matcher had made without
the person's word (removed-links-2026-10-24.csv). Each removed link becomes a
pending candidate on the person's own page. Nothing is linked to them until
they confirm it.

    python manage.py seed_paper_candidates --log removed-links-2026-10-24.csv --dry-run
    python manage.py seed_paper_candidates --log removed-links-2026-10-24.csv

Idempotent: a person and paper that already have a candidate are left alone,
whatever its status. A row whose person or paper cannot be found is counted as
unresolved and skipped. The author row named in the log is kept on the
candidate only when that row exists on the same paper.
"""

from __future__ import annotations

import csv
import json

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import Authorship, PaperCandidate, Publication, User

SOURCE = "cleanup-2026-10-24"
REASON = "Matched by name, but not on your Scopus profile"


class Command(BaseCommand):
    help = "Create pending paper candidates from the cleanup's removed-links log."

    def add_arguments(self, parser):
        parser.add_argument("--log", required=True, help="The removed-links CSV from the cleanup.")
        parser.add_argument("--dry-run", action="store_true", help="Count what would be created; write nothing.")

    def handle(self, *args, log, dry_run=False, **opts):
        try:
            with open(log, newline="", encoding="utf-8-sig") as fh:
                rows = list(csv.DictReader(fh))
        except OSError as exc:
            raise CommandError(f"Cannot read {log}: {exc}") from exc
        people = {
            (u.staff_id or "").strip().lower(): u
            for u in User.objects.exclude(staff_id__isnull=True).exclude(staff_id="")
        }
        counts = {"created": 0, "skipped": 0, "unresolved": 0}
        seen: set[tuple[str, str]] = set()
        with transaction.atomic():
            for row in rows:
                user = people.get((row.get("staff_id") or "").strip().lower())
                pub_id = (row.get("publication_id") or "").strip()
                pub = Publication.objects.filter(id=pub_id).first() if pub_id else None
                if user is None or pub is None:
                    counts["unresolved"] += 1
                    continue
                key = (user.id, pub.id)
                if key in seen or PaperCandidate.objects.filter(user=user, publication=pub).exists():
                    counts["skipped"] += 1
                    continue
                seen.add(key)
                auth_id = (row.get("authorship_id") or "").strip()
                authorship_id = (
                    int(auth_id)
                    if auth_id.isdigit() and Authorship.objects.filter(id=int(auth_id), publication=pub).exists()
                    else None
                )
                if not dry_run:
                    PaperCandidate.objects.create(
                        user=user, publication=pub, authorship_id=authorship_id, source=SOURCE, reason=REASON,
                    )
                counts["created"] += 1
        self.stdout.write(json.dumps({**counts, "rows": len(rows), "dry_run": dry_run}, indent=2))
