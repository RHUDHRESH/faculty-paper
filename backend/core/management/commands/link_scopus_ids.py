"""Set every faculty account's Scopus author id from the ERP workbook.

    python manage.py link_scopus_ids "Publication_Processing_ERP_V3.0.xlsx" [--dry-run]

Idempotent; a different id already on an account is reported, never overwritten.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core.services.erp_scopus import link_scopus_ids, read_erp_scopus


class Command(BaseCommand):
    help = "Link faculty accounts to their Scopus author ids from the ERP workbook."

    def add_arguments(self, parser):
        parser.add_argument("path")
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        try:
            entries = read_erp_scopus(opts["path"])
        except OSError as exc:
            raise CommandError(f"Cannot open {opts['path']}: {exc}") from exc
        r = link_scopus_ids(entries, dry_run=opts["dry_run"])
        w = self.stdout.write
        w(f"people with a Scopus id in the workbook: {r['entries']}")
        w(f"  set: {r['set']}")
        w(f"  already the same: {r['same']}")
        w(f"  conflicts: {len(r['conflicts'])}")
        for c in r["conflicts"]:
            w(f"    {c['staff_id']} {c['user']}: account {c['account']} vs ERP {c['erp']} ({c['source']})")
        w(f"  unmatched: {len(r['unmatched'])}")
        for u in r["unmatched"]:
            w(f"    {u['staff_id'] or u['bio_id']} {u['name']} {u['scopus_id']}")
        if opts["dry_run"]:
            w(self.style.WARNING("dry run: nothing saved"))
