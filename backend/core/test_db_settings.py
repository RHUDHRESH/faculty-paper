"""The database connection settings the URL parser produces.

Tests run on SQLite, so the Postgres settings are checked as dictionaries:
what Django would be handed, not a live connection.
"""

import os
from unittest.mock import patch

from django.test import SimpleTestCase

from config.settings import _database_from_url, _with_statement_timeout

_ENV_NAMES = (
    "DB_CONN_MAX_AGE", "CONN_MAX_AGE", "DB_CONNECT_TIMEOUT", "DB_APP_NAME",
    "DB_SSLMODE", "DB_SSLROOTCERT",
)


class DatabaseSettingsTests(SimpleTestCase):
    def setUp(self):
        env = {k: v for k, v in os.environ.items() if k not in _ENV_NAMES}
        p = patch.dict(os.environ, env, clear=True)
        p.start()
        self.addCleanup(p.stop)

    def parse(self, url, **env):
        with patch.dict(os.environ, env):
            return _database_from_url(url)

    def test_defaults_for_a_remote_host(self):
        d = self.parse("postgres://u:p@db.example.com/app")
        self.assertEqual(d["CONN_MAX_AGE"], 60)
        self.assertTrue(d["CONN_HEALTH_CHECKS"])
        o = d["OPTIONS"]
        self.assertEqual(o["connect_timeout"], 10)
        self.assertEqual(o["application_name"], "faculty-paper-api")
        self.assertEqual(o["sslmode"], "require")
        self.assertEqual(
            (o["keepalives"], o["keepalives_idle"], o["keepalives_interval"], o["keepalives_count"]),
            (1, 30, 10, 5),
        )
        self.assertEqual(d["PORT"], "5432")
        self.assertNotIn("DISABLE_SERVER_SIDE_CURSORS", d)

    def test_environment_overrides(self):
        d = self.parse(
            "postgres://u:p@db.example.com/app",
            DB_CONN_MAX_AGE="300", DB_CONNECT_TIMEOUT="3", DB_APP_NAME="faculty-paper-worker",
        )
        self.assertEqual(d["CONN_MAX_AGE"], 300)
        self.assertEqual(d["OPTIONS"]["connect_timeout"], 3)
        self.assertEqual(d["OPTIONS"]["application_name"], "faculty-paper-worker")

    def test_the_old_conn_max_age_name_still_works_and_the_new_one_wins(self):
        d = self.parse("postgres://u:p@db.example.com/app", CONN_MAX_AGE="120")
        self.assertEqual(d["CONN_MAX_AGE"], 120)
        d = self.parse("postgres://u:p@db.example.com/app", CONN_MAX_AGE="120", DB_CONN_MAX_AGE="5")
        self.assertEqual(d["CONN_MAX_AGE"], 5)

    def test_a_garbled_number_falls_back_to_the_default(self):
        d = self.parse("postgres://u:p@db.example.com/app", DB_CONN_MAX_AGE="soon")
        self.assertEqual(d["CONN_MAX_AGE"], 60)

    def test_a_blank_app_name_is_not_used(self):
        d = self.parse("postgres://u:p@db.example.com/app", DB_APP_NAME="  ")
        self.assertEqual(d["OPTIONS"]["application_name"], "faculty-paper-api")

    def test_neon_and_supabase_keep_ssl_and_channel_binding(self):
        d = self.parse("postgresql://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require")
        self.assertEqual(d["OPTIONS"]["sslmode"], "require")
        self.assertEqual(d["OPTIONS"]["channel_binding"], "require")
        d = self.parse("postgres://u:p@db.abcd.supabase.co:5432/postgres")
        self.assertEqual(d["OPTIONS"]["sslmode"], "require")

    def test_render_postgres_gets_ssl_without_being_named(self):
        d = self.parse("postgres://u:p@dpg-abc123-a.singapore-postgres.render.com/app")
        self.assertEqual(d["OPTIONS"]["sslmode"], "require")

    def test_local_hosts_are_not_forced_onto_tls(self):
        for host in ("localhost", "127.0.0.1", "db"):
            with self.subTest(host=host):
                d = self.parse(f"postgres://u:p@{host}:5432/app")
                self.assertNotIn("sslmode", d["OPTIONS"])
                self.assertEqual(d["OPTIONS"]["keepalives"], 1)

    def test_an_explicit_sslmode_in_the_url_wins_over_the_default(self):
        d = self.parse("postgres://u:p@db.example.com/app?sslmode=prefer")
        self.assertEqual(d["OPTIONS"]["sslmode"], "prefer")

    def test_db_sslmode_env_overrides(self):
        d = self.parse("postgres://u:p@db.example.com/app?sslmode=prefer", DB_SSLMODE="verify-ca")
        self.assertEqual(d["OPTIONS"]["sslmode"], "verify-ca")

    def test_a_root_certificate_turns_on_full_verification(self):
        d = self.parse("postgres://u:p@db.example.com/app", DB_SSLROOTCERT="/etc/ca.pem")
        self.assertEqual(d["OPTIONS"]["sslmode"], "verify-full")
        self.assertEqual(d["OPTIONS"]["sslrootcert"], "/etc/ca.pem")

    def test_a_root_certificate_overrides_a_weaker_url_sslmode_but_not_verify_ca(self):
        d = self.parse("postgres://u:p@db.example.com/app?sslmode=require", DB_SSLROOTCERT="/ca.pem")
        self.assertEqual(d["OPTIONS"]["sslmode"], "verify-full")
        d = self.parse("postgres://u:p@db.example.com/app?sslmode=verify-ca", DB_SSLROOTCERT="/ca.pem")
        self.assertEqual(d["OPTIONS"]["sslmode"], "verify-ca")

    def test_the_transaction_pooler_port_closes_connections_and_drops_cursors(self):
        d = self.parse("postgres://u:p@aws-0.pooler.supabase.com:6543/postgres", DB_CONN_MAX_AGE="300")
        self.assertTrue(d["DISABLE_SERVER_SIDE_CURSORS"])
        self.assertEqual(d["CONN_MAX_AGE"], 0)
        self.assertTrue(d["CONN_HEALTH_CHECKS"])

    def test_the_cloud_sql_socket_path_is_untouched(self):
        d = self.parse("postgres://u:p@/appdb?host=/cloudsql/proj:asia-south1:inst")
        self.assertEqual(d["HOST"], "/cloudsql/proj:asia-south1:inst")
        self.assertEqual(d["PORT"], "")
        o = d["OPTIONS"]
        self.assertNotIn("sslmode", o)
        self.assertNotIn("keepalives", o)
        self.assertNotIn("sslrootcert", o)
        self.assertEqual(o["connect_timeout"], 10)
        self.assertNotIn("DISABLE_SERVER_SIDE_CURSORS", d)

    def test_a_socket_ignores_the_pooler_port_rule(self):
        d = self.parse("postgres://u:p@:6543/appdb?host=/tmp")
        self.assertNotIn("DISABLE_SERVER_SIDE_CURSORS", d)
        self.assertEqual(d["CONN_MAX_AGE"], 60)

    def test_statement_timeout_is_added_only_when_set(self):
        d = _with_statement_timeout(self.parse("postgres://u:p@db.example.com/app"), 120000)
        self.assertEqual(d["OPTIONS"]["options"], "-c statement_timeout=120000")
        d = _with_statement_timeout(self.parse("postgres://u:p@db.example.com/app"), 0)
        self.assertNotIn("options", d["OPTIONS"])

    def test_the_password_survives_and_is_url_decoded(self):
        d = self.parse("postgres://u:p%40ss@db.example.com/app")
        self.assertEqual(d["PASSWORD"], "p@ss")
