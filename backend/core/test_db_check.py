"""`manage.py db_check`: the report, the critical findings, the exit code."""

from contextlib import nullcontext
from io import StringIO
from unittest.mock import MagicMock, patch

from django.core.management import call_command
from django.test import SimpleTestCase

from core.services import db_report


def healthy(**over):
    base = {
        "latency_ms": 2.0,
        "server_version": "17.2",
        "server_major": 17,
        "size_bytes": 10 * 1048576,
        "connections_used": 10,
        "connections_max": 100,
        "largest_tables": [{"table": "core_claim", "bytes": 5 * 1048576, "rows": 1200}],
        "unindexed_foreign_keys": [],
        "unused_indexes": [],
        "bloated_tables": [],
        "long_queries": [],
        "pg_stat_statements": True,
    }
    base.update(over)
    return base


class CriticalFindingTests(SimpleTestCase):
    def test_a_healthy_server_has_none(self):
        self.assertEqual(db_report.critical_findings(healthy()), [])

    def test_a_server_older_than_15_is_critical_and_15_is_not(self):
        self.assertEqual(len(db_report.critical_findings(healthy(server_major=14, server_version="14.9"))), 1)
        self.assertEqual(db_report.critical_findings(healthy(server_major=15)), [])

    def test_an_unreadable_version_is_critical(self):
        self.assertEqual(len(db_report.critical_findings(healthy(server_major=None))), 1)

    def test_latency_over_100_ms_is_critical_but_100_is_not(self):
        self.assertEqual(len(db_report.critical_findings(healthy(latency_ms=100.5))), 1)
        self.assertEqual(db_report.critical_findings(healthy(latency_ms=100.0)), [])

    def test_connections_over_80_percent_are_critical_but_80_are_not(self):
        self.assertEqual(len(db_report.critical_findings(healthy(connections_used=81))), 1)
        self.assertEqual(db_report.critical_findings(healthy(connections_used=80)), [])

    def test_unknown_connection_counts_are_not_critical(self):
        self.assertEqual(
            db_report.critical_findings(healthy(connections_used=None, connections_max=None)), []
        )

    def test_several_problems_are_all_listed(self):
        r = healthy(server_major=13, latency_ms=300, connections_used=99)
        self.assertEqual(len(db_report.critical_findings(r)), 3)


class ScriptedCursor:
    """Returns canned rows keyed by a distinctive fragment of each query."""

    def __init__(self, rows):
        self.rows = rows
        self.executed = []
        self._current = []

    def execute(self, sql, params=None):
        self.executed.append(sql)
        s = " ".join(sql.split())
        for needle, rows in self.rows:
            if needle in s:
                self._current = rows
                return
        self._current = [(1,)]

    def fetchone(self):
        return self._current[0] if self._current else None

    def fetchall(self):
        return self._current


class CollectReportTests(SimpleTestCase):
    def cursor(self, **over):
        rows = [
            ("SHOW server_version_num", [("160002",)]),
            ("SHOW server_version", [("16.2",)]),
            ("pg_database_size", [(31457280,)]),
            ("count(*) FROM pg_stat_activity", [(12,)]),
            ("SHOW max_connections", [("100",)]),
            ("FROM pg_class c", [("core_claim", 2097152, 500), ("core_user", 1048576, -1)]),
            ("contype = 'f'", [("core_x", "core_x_fk")]),
            ("idx_scan = 0", [("core_x", "core_x_idx", 3145728)]),
            ("n_dead_tup", [("core_y", 1000, 3000)]),
            ("interval '60 seconds'", [(4242, 75, "SELECT   *\n  FROM big")]),
            ("pg_extension", []),
        ]
        rows = [(k, over.get(k, v)) for k, v in rows]
        return ScriptedCursor(rows)

    def test_it_gathers_every_section(self):
        c = self.cursor()
        r = db_report.collect_report(c)
        self.assertEqual(r["server_major"], 16)
        self.assertEqual(r["connections_used"], 12)
        self.assertEqual(r["largest_tables"][0], {"table": "core_claim", "bytes": 2097152, "rows": 500})
        self.assertEqual(r["largest_tables"][1]["rows"], 0)  # reltuples is -1 before the first analyze
        self.assertEqual(r["unindexed_foreign_keys"], [{"table": "core_x", "constraint": "core_x_fk"}])
        self.assertEqual(r["unused_indexes"][0]["bytes"], 3145728)
        self.assertEqual(r["bloated_tables"][0]["ratio"], 0.75)
        self.assertEqual(r["long_queries"][0]["query"], "SELECT * FROM big")
        self.assertFalse(r["pg_stat_statements"])

    def test_every_query_it_sends_is_a_read(self):
        c = self.cursor()
        db_report.collect_report(c)
        for sql in c.executed:
            first = sql.strip().split()[0].upper()
            self.assertIn(first, {"SELECT", "SHOW"}, sql)


class CommandTests(SimpleTestCase):
    def run_command(self, report=None, postgres=True):
        out = StringIO()
        conn = MagicMock(vendor="postgresql" if postgres else "sqlite")
        with patch("core.management.commands.db_check.connection", conn), patch(
            "core.management.commands.db_check.transaction"
        ) as tx, patch.object(db_report, "collect_report", return_value=report):
            tx.atomic.return_value = nullcontext()
            call_command("db_check", stdout=out)
        return out.getvalue(), conn

    def test_on_sqlite_it_says_so_and_exits_zero(self):
        out = StringIO()
        call_command("db_check", stdout=out)  # the test database is SQLite
        self.assertIn("not PostgreSQL", out.getvalue())

    def test_a_healthy_report_prints_the_sections_and_exits_zero(self):
        out, conn = self.run_command(healthy(
            unindexed_foreign_keys=[{"table": "core_x", "constraint": "core_x_fk"}],
            unused_indexes=[{"table": "core_x", "index": "core_x_idx", "bytes": 2097152}],
            bloated_tables=[{"table": "core_y", "live": 100, "dead": 1000, "ratio": 0.909}],
            long_queries=[{"pid": 7, "seconds": 90, "query": "SELECT 1"}],
        ))
        for text in ("17.2", "10 of", "core_claim", "core_x_fk", "core_x_idx", "core_y", "pid 7",
                     "pg_stat_statements  installed", "No critical findings"):
            self.assertIn(text, out)
        # the check runs inside a read-only transaction
        executed = [c.args[0] for c in conn.cursor.return_value.__enter__.return_value.execute.call_args_list]
        self.assertEqual(executed, ["SET TRANSACTION READ ONLY"])

    def test_a_critical_finding_exits_one_after_printing_the_report(self):
        out = StringIO()
        conn = MagicMock(vendor="postgresql")
        with patch("core.management.commands.db_check.connection", conn), patch(
            "core.management.commands.db_check.transaction"
        ) as tx, patch.object(db_report, "collect_report", return_value=healthy(server_major=14, server_version="14.1")):
            tx.atomic.return_value = nullcontext()
            with self.assertRaises(SystemExit) as cm:
                call_command("db_check", stdout=out)
        self.assertEqual(cm.exception.code, 1)
        self.assertIn("CRITICAL", out.getvalue())
        self.assertIn("14.1", out.getvalue())
        self.assertIn("core_claim", out.getvalue())
