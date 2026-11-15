"""Compare two databases, table by table, without writing to either.

    manage.py db_compare --source URL --target URL

Each URL may instead come from SOURCE_DATABASE_URL / TARGET_DATABASE_URL.
Prints the tables that differ (row count, or newest updated_at/created_at) and
exits 1 if there are any. Rows a restore legitimately adds are left out:
AuditLog lines named RESTORE_* and StoredFile names starting with backups/.
Passwords are never printed.
"""

import os
import sys

from django.core.management.base import BaseCommand, CommandError

from core.services import db_compare as dbc


def _cell(side, key):
    if side is None:
        return "-"
    if "error" in side:
        return "no table"
    value = side[key]
    return "-" if value is None else str(value)


class Command(BaseCommand):
    help = "Compare row counts and newest timestamps of every core table in two databases (read-only)."

    def add_arguments(self, parser):
        parser.add_argument("--source", help="The original database URL (or SOURCE_DATABASE_URL).")
        parser.add_argument("--target", help="The copy's database URL (or TARGET_DATABASE_URL).")
        parser.add_argument("--all", action="store_true", help="Print every table, not only the differing ones.")

    def handle(self, *args, source=None, target=None, all=False, **options):
        source = (source or os.getenv("SOURCE_DATABASE_URL") or "").strip()
        target = (target or os.getenv("TARGET_DATABASE_URL") or "").strip()
        if not source or not target:
            raise CommandError(
                "Give --source and --target, or set SOURCE_DATABASE_URL and TARGET_DATABASE_URL."
            )
        if source == target:
            raise CommandError("Source and target are the same database; there is nothing to compare.")

        stats = {}
        for label, url in (("source", source), ("target", target)):
            conn = None
            try:
                conn = dbc.open_connection(url)
                stats[label] = dbc.table_stats(conn)
            except Exception as exc:
                message = dbc.hide_passwords(dbc.scrub(str(exc), url)).strip().splitlines()
                raise CommandError(
                    f"Could not read the {label} database ({dbc.redact_url(url)}): "
                    f"{type(exc).__name__}: {message[0] if message else ''}"
                ) from None
            finally:
                if conn is not None:
                    conn.close()

        w = self.stdout.write
        w(f"source  {dbc.redact_url(source)}")
        w(f"target  {dbc.redact_url(target)}")
        w("ignored: AuditLog actions RESTORE_*, StoredFile names backups/*")
        w("")
        diffs = dbc.compare(stats["source"], stats["target"])
        differing = {d["table"]: d for d in diffs}
        tables = sorted(set(stats["source"]) | set(stats["target"]))
        rows = [
            (
                t,
                _cell(stats["source"].get(t), "rows"), _cell(stats["target"].get(t), "rows"),
                _cell(stats["source"].get(t), "newest"), _cell(stats["target"].get(t), "newest"),
                differing[t]["why"] if t in differing else "same",
            )
            for t in tables
            if all or t in differing
        ]
        if rows:
            header = ("table", "src rows", "tgt rows", "src newest", "tgt newest", "result")
            widths = [max(len(str(r[i])) for r in [header, *rows]) for i in range(len(header))]
            for r in [header, *rows]:
                w("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)).rstrip())
            w("")
        w(f"{len(tables)} tables compared, {len(diffs)} differ.")
        if diffs:
            self.stdout.flush()
            sys.exit(1)
        w(self.style.SUCCESS("The two databases agree."))
