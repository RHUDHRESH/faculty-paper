"""A read-only health check of the PostgreSQL server behind the app.

Exits 1 when something critical is found (server older than 15, a round trip
over 100 ms, more than 80% of the connection limit in use). Everything else it
prints is advice. On SQLite it says so and exits 0. It only reads: the work
runs in a read-only transaction, so it cannot change anything even by mistake.
"""

import sys

from django.core.management.base import BaseCommand
from django.db import connection, transaction

from core.services import db_health, db_report


def _mb(n):
    return "unknown" if n is None else f"{n / 1048576:,.1f} MB"


class Command(BaseCommand):
    help = (
        "Read-only PostgreSQL checks: version, size, connections, largest tables, "
        "unindexed foreign keys, unused indexes, dead rows, slow queries, latency."
    )

    def handle(self, *args, **options):
        if not db_health.is_postgres(connection):
            self.stdout.write("not PostgreSQL: nothing to check.")
            return
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SET TRANSACTION READ ONLY")
            report = db_report.collect_report(cursor)
        critical = self.render(report)
        self.stdout.write("")
        if critical:
            self.stdout.write(self.style.ERROR("CRITICAL"))
            for line in critical:
                self.stdout.write(self.style.ERROR(f"  - {line}"))
            self.stdout.flush()
            sys.exit(1)
        self.stdout.write(self.style.SUCCESS("No critical findings."))

    def render(self, r):
        w = self.stdout.write
        w(f"Server version      {r['server_version']}")
        w(f"Database size       {_mb(r['size_bytes'])}")
        w(f"Connections         {r['connections_used']} of {r['connections_max']} in use")
        w(f"Round trip          {r['latency_ms']} ms (median of 3)")
        w(
            "pg_stat_statements  "
            + ("installed" if r["pg_stat_statements"] else "not installed (no per-query timings)")
        )
        w("")
        w("10 largest tables (with indexes)")
        for t in r["largest_tables"]:
            w(f"  {t['table']:<40} {_mb(t['bytes']):>12}  ~{t['rows']:,} rows")
        self._section(
            "Foreign keys with no covering index",
            [f"{x['table']}  ({x['constraint']})" for x in r["unindexed_foreign_keys"]],
        )
        self._section(
            "Indexes never used and over 1 MB (unique and primary keys left out)",
            [f"{x['table']}.{x['index']}  {_mb(x['bytes'])}" for x in r["unused_indexes"]],
        )
        self._section(
            "Tables with over 20% dead rows (at least 1,000)",
            [
                f"{x['table']}  {x['dead']:,} dead of {x['live'] + x['dead']:,}  ({x['ratio']:.0%})"
                for x in r["bloated_tables"]
            ],
        )
        self._section(
            "Queries running over 60 seconds",
            [f"pid {x['pid']}  {x['seconds']} s  {x['query']}" for x in r["long_queries"]],
        )
        return db_report.critical_findings(r)

    def _section(self, title, lines):
        self.stdout.write("")
        self.stdout.write(f"{title}: {len(lines) or 'none'}")
        for line in lines:
            self.stdout.write(f"  {line}")
