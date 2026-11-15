"""`manage.py db_compare`: the stats, the comparison, the exit code, no passwords."""

import os
from datetime import datetime, timezone
from io import StringIO
from unittest.mock import MagicMock, patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, TestCase

from core.models import AuditLog, StoredFile
from core.services import db_compare as dbc


class UrlHandlingTests(SimpleTestCase):
    def test_redact_drops_the_password_and_the_query(self):
        out = dbc.redact_url("postgresql://app:p%40ss@db.example.com:5432/prod?sslmode=require")
        self.assertEqual(out, "app@db.example.com:5432/prod")
        self.assertNotIn("p%40ss", out)
        self.assertNotIn("sslmode", out)

    def test_redact_a_sqlite_path(self):
        self.assertEqual(dbc.redact_url("sqlite:///C:/tmp/a.sqlite3"), "sqlite:C:/tmp/a.sqlite3")

    def test_scrub_removes_the_password_from_an_error(self):
        url = "postgres://u:s3cret!@h/db"
        self.assertEqual(dbc.scrub("login failed for s3cret!", url), "login failed for ***")

    def test_scrub_removes_an_encoded_password_in_both_forms(self):
        url = "postgres://u:p%40ss@h/db"
        self.assertEqual(dbc.scrub("bad p@ss and p%40ss", url), "bad *** and ***")

    def test_hide_passwords_blanks_any_url_in_text(self):
        self.assertEqual(
            dbc.hide_passwords("could not connect to postgres://u:hunter2@h:5432/db"),
            "could not connect to postgres://u:***@h:5432/db",
        )

    def test_settings_for_sqlite_and_postgres_and_nonsense(self):
        self.assertEqual(dbc.settings_for("sqlite:///x.db")["NAME"], "x.db")
        pg = dbc.settings_for("postgres://u:p@db.example.com/app")
        self.assertEqual(pg["OPTIONS"]["application_name"], "faculty-paper-db-compare")
        self.assertEqual(pg["CONN_MAX_AGE"], 0)
        with self.assertRaises(ValueError):
            dbc.settings_for("mysql://u:p@h/db")

    def test_a_postgres_session_is_made_read_only(self):
        conn = MagicMock(vendor="postgresql")
        with patch.object(dbc, "ConnectionHandler", return_value={"default": conn}):
            dbc.open_connection("postgres://u:p@db.example.com/app")
        executed = conn.cursor.return_value.__enter__.return_value.execute.call_args_list
        self.assertEqual(executed[0].args[0], "SET default_transaction_read_only = on")


class TimestampTests(SimpleTestCase):
    def test_both_engines_give_the_same_text(self):
        aware = datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc)
        from_pg = dbc.normalise_timestamp(aware)
        from_sqlite = dbc.normalise_timestamp("2026-01-02 03:04:05.678000")
        self.assertEqual(from_pg, from_sqlite)

    def test_offsets_are_converted_to_utc(self):
        self.assertEqual(
            dbc.normalise_timestamp("2026-01-02T08:34:05+05:30"),
            dbc.normalise_timestamp("2026-01-02T03:04:05+00:00"),
        )

    def test_none_stays_none(self):
        self.assertIsNone(dbc.normalise_timestamp(None))


class CompareTests(SimpleTestCase):
    def test_equal_stats_have_no_difference(self):
        s = {"core_a": {"rows": 3, "newest": "t1"}, "core_b": {"rows": 0, "newest": None}}
        self.assertEqual(dbc.compare(s, dict(s)), [])

    def test_a_row_count_difference_is_reported_with_its_size(self):
        d = dbc.compare({"core_a": {"rows": 3, "newest": "t"}}, {"core_a": {"rows": 5, "newest": "t"}})
        self.assertEqual(len(d), 1)
        self.assertIn("+2", d[0]["why"])

    def test_a_newer_timestamp_alone_is_a_difference(self):
        d = dbc.compare({"core_a": {"rows": 3, "newest": "t1"}}, {"core_a": {"rows": 3, "newest": "t2"}})
        self.assertEqual(d[0]["why"], "newest timestamp differs")

    def test_a_table_missing_on_one_side(self):
        s = {"core_a": {"rows": 1, "newest": None}}
        self.assertIn("target", dbc.compare(s, {})[0]["why"])
        self.assertIn("source", dbc.compare({}, s)[0]["why"])
        self.assertIn("target", dbc.compare(s, {"core_a": {"error": "ProgrammingError"}})[0]["why"])
        self.assertIn("source", dbc.compare({"core_a": {"error": "X"}}, s)[0]["why"])


class TableStatsTests(TestCase):
    """Run against the test database (SQLite): the SQL is plain SELECTs."""

    def stats(self):
        from django.db import connection

        return dbc.table_stats(connection)

    def test_every_core_table_is_covered_including_link_tables(self):
        stats = self.stats()
        self.assertIn("core_claim", stats)
        self.assertIn("core_user", stats)
        self.assertTrue(all("rows" in v for v in stats.values()), stats)

    def test_restore_audit_lines_and_backup_files_are_left_out(self):
        before = self.stats()
        AuditLog.objects.create(action="RESTORE_DONE", entity="Export")
        AuditLog.objects.create(action="RESTORE_FAILED", entity="Export")
        StoredFile.objects.create(name="backups/weekly.json.gz", content=b"x", size=1)
        after = self.stats()
        self.assertEqual(after["core_auditlog"], before["core_auditlog"])
        self.assertEqual(after["core_storedfile"], before["core_storedfile"])

    def test_other_audit_lines_and_files_still_count(self):
        before = self.stats()
        AuditLog.objects.create(action="CLAIM_SUBMITTED", entity="Claim")
        AuditLog.objects.create(action="RESTOREX", entity="Claim")  # not a RESTORE_ prefix
        StoredFile.objects.create(name="evidence/a.pdf", content=b"x", size=1)
        after = self.stats()
        self.assertEqual(after["core_auditlog"]["rows"], before["core_auditlog"]["rows"] + 2)
        self.assertEqual(after["core_storedfile"]["rows"], before["core_storedfile"]["rows"] + 1)
        self.assertIsNotNone(after["core_auditlog"]["newest"])

    def test_the_underscore_in_restore_is_literal(self):
        before = self.stats()
        AuditLog.objects.create(action="RESTOREX_DONE", entity="Export")
        self.assertEqual(self.stats()["core_auditlog"]["rows"], before["core_auditlog"]["rows"] + 1)

    def test_a_missing_table_is_an_error_entry_not_a_crash(self):
        from django.db import connection

        with patch.object(connection, "cursor", side_effect=RuntimeError("no such table")):
            stats = dbc.table_stats(connection)
        self.assertEqual(stats["core_claim"], {"error": "RuntimeError"})


class CommandTests(SimpleTestCase):
    SRC = "postgresql://app:topsecret@old.example.com:5432/prod"
    DST = "postgresql://app:topsecret@new.example.com:5432/prod"

    def run_cmd(self, source_stats, target_stats, *args, **kw):
        out = StringIO()
        with patch.object(dbc, "open_connection", return_value=MagicMock()), patch.object(
            dbc, "table_stats", side_effect=[source_stats, target_stats]
        ):
            call_command("db_compare", *args, stdout=out, **kw)
        return out.getvalue()

    def test_agreement_exits_zero(self):
        s = {"core_a": {"rows": 1, "newest": "t"}}
        out = self.run_cmd(s, dict(s), "--source", self.SRC, "--target", self.DST)
        self.assertIn("1 tables compared, 0 differ", out)
        self.assertIn("agree", out)

    def test_a_difference_prints_a_table_and_exits_one(self):
        out = StringIO()
        src = {"core_a": {"rows": 10, "newest": "t"}, "core_b": {"rows": 1, "newest": None}}
        dst = {"core_a": {"rows": 8, "newest": "t"}, "core_b": {"rows": 1, "newest": None}}
        with patch.object(dbc, "open_connection", return_value=MagicMock()), patch.object(
            dbc, "table_stats", side_effect=[src, dst]
        ):
            with self.assertRaises(SystemExit) as cm:
                call_command("db_compare", "--source", self.SRC, "--target", self.DST, stdout=out)
        self.assertEqual(cm.exception.code, 1)
        text = out.getvalue()
        self.assertIn("core_a", text)
        self.assertNotIn("core_b", text)  # only differences are listed
        self.assertIn("-2", text)
        self.assertIn("2 tables compared, 1 differ", text)

    def test_the_output_never_holds_the_password(self):
        s = {"core_a": {"rows": 1, "newest": "t"}}
        out = self.run_cmd(s, dict(s), "--source", self.SRC, "--target", self.DST)
        self.assertNotIn("topsecret", out)
        self.assertIn("app@old.example.com:5432/prod", out)

    def test_a_connection_error_hides_the_password(self):
        leak = RuntimeError("could not connect to postgresql://app:topsecret@old.example.com/prod")
        with patch.object(dbc, "open_connection", side_effect=leak):
            with self.assertRaises(CommandError) as cm:
                call_command("db_compare", "--source", self.SRC, "--target", self.DST)
        self.assertNotIn("topsecret", str(cm.exception))
        self.assertIn("source", str(cm.exception))

    def test_urls_may_come_from_the_environment(self):
        s = {"core_a": {"rows": 1, "newest": "t"}}
        env = {"SOURCE_DATABASE_URL": self.SRC, "TARGET_DATABASE_URL": self.DST}
        with patch.dict(os.environ, env):
            out = self.run_cmd(s, dict(s))
        self.assertIn("agree", out)

    def test_missing_or_identical_urls_are_refused(self):
        with patch.dict(os.environ):
            os.environ.pop("SOURCE_DATABASE_URL", None)
            os.environ.pop("TARGET_DATABASE_URL", None)
            with self.assertRaises(CommandError):
                call_command("db_compare", "--source", self.SRC)
        with self.assertRaises(CommandError):
            call_command("db_compare", "--source", self.SRC, "--target", self.SRC)

    def test_all_prints_the_matching_tables_too(self):
        s = {"core_a": {"rows": 1, "newest": "t"}}
        out = self.run_cmd(s, dict(s), "--source", self.SRC, "--target", self.DST, "--all")
        self.assertIn("core_a", out)
        self.assertIn("same", out)
