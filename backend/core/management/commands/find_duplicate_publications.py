"""Report (and optionally merge) publications recorded twice.

    manage.py find_duplicate_publications                 # dry run: report only
    manage.py find_duplicate_publications --person <id>   # one person's record
    manage.py find_duplicate_publications --json out.json
    manage.py find_duplicate_publications --apply --reason same_doi

Nothing changes without --apply, and --apply only merges the reasons named
with --reason (default: same_doi, the only unambiguous one). Every merge is
audit-logged and can be undone from the super admin's Record quality screen.
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand

from core.services import record_quality as rq


class Command(BaseCommand):
    help = "Find publications recorded twice (same DOI, same title and year, preprint vs published)."

    def add_arguments(self, parser):
        parser.add_argument("--person", default=None, help="Only pairs on this user's record")
        parser.add_argument("--json", default=None, help="Write every pair to this file")
        parser.add_argument("--apply", action="store_true", help="Merge the pairs (default: dry run)")
        parser.add_argument("--reason", action="append", choices=sorted(rq.REASONS), default=None,
                            help="With --apply: which kinds to merge (repeatable; default same_doi)")
        parser.add_argument("--limit", type=int, default=20, help="Pairs to print")

    def handle(self, *args, person=None, json=None, apply=False, reason=None, limit=20, **opts):
        pairs = rq.find_duplicates(user_id=person)
        s = rq.summary(pairs)
        self.stdout.write(f"{s['pairs']} duplicate pairs; people affected: {s['people_affected']}")
        for k, n in sorted(s["by_reason"].items()):
            self.stdout.write(f"  {rq.REASONS[k]}: {n}")
        for p in pairs[:limit]:
            self.stdout.write(
                f"- [{p['reason_label']}] keep {p['keep']['id']} ({p['keep']['year']}, {p['keep']['doi'] or 'no DOI'}) "
                f"drop {p['drop']['id']} ({p['drop']['year']}, {p['drop']['doi'] or 'no DOI'}): {p['keep']['title'][:80]}"
            )
        if json:
            import json as _json

            with open(json, "w", encoding="utf-8") as fh:
                _json.dump({"summary": s, "pairs": pairs}, fh, indent=1)
            self.stdout.write(f"Wrote {json}")
        if not apply:
            self.stdout.write("Dry run: nothing changed. Review on /data/record, or rerun with --apply.")
            return
        kinds = set(reason or ["same_doi"])
        done = 0
        for p in pairs:
            if p["reason"] not in kinds:
                continue
            try:
                rq.merge(p["keep"]["id"], p["drop"]["id"], None, reason=p["reason"])
                done += 1
            except rq.MergeError as exc:  # an earlier merge in this run removed one side
                self.stdout.write(f"  skipped {p['key']}: {exc}")
        self.stdout.write(f"Merged {done} pairs.")
