"""Indexes the performance audit asked for, and that the schema agrees with the models.

* `AuditLog` only grows and is read newest-first (`/admin/audit`, the hub's
  "last 24 hours" count) and by entity (a claim's history).
* `PriorPayment.employee_id` and `PaidLedger.staff_id` are looked up with
  `__iexact`. On PostgreSQL that is `UPPER(col) = UPPER(value)`, which neither a
  plain index nor the `Lower(staff_id)` constraint serves; the expression index
  does. (SQLite compiles `iexact` to `LIKE`, which no index serves, so on the
  local database these are present and idle.)
"""
from __future__ import annotations

from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase

WANTED = {
    "core_auditlog": {"audit_when", "audit_entity"},
    "core_priorpayment": {"priorpay_emp_upper"},
    "core_paidledger": {"ledger_staff_upper"},
}


def _indexes(table: str) -> set[str]:
    with connection.cursor() as cur:
        if connection.vendor == "postgresql":
            cur.execute("SELECT indexname FROM pg_indexes WHERE tablename = %s", [table])
        else:
            cur.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = %s", [table])
        return {r[0] for r in cur.fetchall()}


class TheIndexesExist(TestCase):
    def test_each_table_has_the_indexes_the_audit_asked_for(self):
        for table, names in WANTED.items():
            with self.subTest(table=table):
                self.assertLessEqual(names, _indexes(table))

    def test_the_models_and_the_migrations_agree(self):
        # Raises SystemExit(1) when a model change has no migration.
        call_command("makemigrations", "--check", "--dry-run", verbosity=0)

    def test_the_audit_log_is_still_append_only(self):
        from core.models import AuditLog, ImmutableRecord

        row = AuditLog.objects.create(action="X", entity="Claim", entity_id="1")
        with self.assertRaises(ImmutableRecord):
            row.save()


class TheMigrationCanBeUndone(TransactionTestCase):
    """Backwards drops exactly the new indexes; forwards makes them again."""

    def _migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.migrate([target])

    def test_back_and_forth(self):
        executor = MigrationExecutor(connection)
        latest = [n for n in executor.loader.graph.leaf_nodes() if n[0] == "core"][0]
        previous = next(iter(executor.loader.graph.node_map[latest].parents)).key
        self.assertTrue(latest[1].startswith("0087"), latest)
        try:
            self._migrate(previous)
            for table, names in WANTED.items():
                self.assertFalse(names & _indexes(table), table)
        finally:
            self._migrate(latest)
        for table, names in WANTED.items():
            self.assertLessEqual(names, _indexes(table), table)
