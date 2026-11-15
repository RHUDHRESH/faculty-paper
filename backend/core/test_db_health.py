"""The database facts behind `/api/health?deep=1`."""

from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings

from core.services import db_health


class FakeCursor:
    """Answers the few read-only queries db_health asks, from a dict."""

    def __init__(self, answers):
        self.answers = answers
        self.sql = []
        self._last = None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.sql.append(sql)
        self._last = sql
        for needle, value in self.answers.items():
            if needle in sql:
                if isinstance(value, Exception):
                    raise value
                self._row = (value,)
                return
        self._row = (1,)

    def fetchone(self):
        return self._row


class FakeConnection:
    def __init__(self, answers, vendor="postgresql"):
        self.vendor = vendor
        self.cursor_obj = FakeCursor(answers)

    def cursor(self):
        return self.cursor_obj


PG = {
    "SHOW server_version_num": "170002",
    "SHOW server_version": "17.2 (Debian 17.2-1)",
    "pg_database_size": 52428800,
    "pg_stat_activity": 7,
    "SHOW max_connections": "97",
}


class MedianLatencyTests(SimpleTestCase):
    def test_it_is_the_median_of_three_round_trips_in_milliseconds(self):
        # three trips of 10 ms, 90 ms and 30 ms -> the median is 30
        clock = iter([0.0, 0.010, 1.0, 1.090, 2.0, 2.030])
        with patch.object(db_health.time, "perf_counter", side_effect=lambda: next(clock)):
            ms = db_health.median_latency_ms(FakeCursor({}))
        self.assertEqual(ms, 30.0)

    def test_it_asks_select_one_three_times(self):
        c = FakeCursor({})
        db_health.median_latency_ms(c)
        self.assertEqual(c.sql, ["SELECT 1"] * 3)


class DatabaseDetailsTests(SimpleTestCase):
    def details(self, answers=PG, latency=3.0, vendor="postgresql"):
        conn = FakeConnection(answers, vendor)
        with patch.object(db_health, "median_latency_ms", return_value=latency):
            return db_health.database_details(conn)

    def test_a_postgres_report_has_version_size_and_connections(self):
        d = self.details()
        self.assertEqual(d["latency_ms"], 3.0)
        self.assertEqual(d["server_version"], "17.2 (Debian 17.2-1)")
        self.assertEqual(d["size_mb"], 50.0)
        self.assertEqual(d["connections"], {"used": 7, "max": 97})
        self.assertNotIn("latency_warning", d)
        self.assertNotIn("hint", d)

    def test_slow_round_trips_carry_a_warning_and_a_hint(self):
        d = self.details(latency=51.0)
        self.assertTrue(d["latency_warning"])
        self.assertIn("region", d["hint"])

    def test_exactly_fifty_milliseconds_is_not_a_warning(self):
        self.assertNotIn("latency_warning", self.details(latency=50.0))

    def test_a_fact_that_cannot_be_read_becomes_null_not_an_error(self):
        d = self.details({**PG, "pg_database_size": RuntimeError("permission denied")})
        self.assertIsNone(d["size_mb"])
        self.assertEqual(d["connections"]["max"], 97)

    def test_sqlite_reports_latency_and_engine_version_only(self):
        d = self.details(vendor="sqlite")
        self.assertIn("latency_ms", d)
        self.assertIn("server_version", d)
        self.assertNotIn("connections", d)

    def test_a_broken_connection_never_raises(self):
        class Broken:
            vendor = "postgresql"

            def cursor(self):
                raise RuntimeError("down")

        d = db_health.database_details(Broken())
        self.assertIn("error", d)


@override_settings(GS_BUCKET_NAME="test-bucket")
class DeepHealthDetailsTests(TestCase):
    def test_the_deep_report_carries_db_details_and_keeps_db_a_boolean(self):
        body = self.client.get("/api/health?deep=1").json()
        self.assertIs(body["db"], True)
        self.assertIn("latency_ms", body["db_details"])

    def test_a_slow_database_is_flagged_in_the_deep_report(self):
        with patch.object(db_health, "median_latency_ms", return_value=80.0):
            body = self.client.get("/api/health?deep=1").json()
        self.assertTrue(body["db_details"]["latency_warning"])
        self.assertNotIn("warnings", body)  # the media warning list is not reused

    def test_the_plain_check_still_asks_the_database_nothing(self):
        with self.assertNumQueries(0):
            body = self.client.get("/api/health").json()
        self.assertNotIn("db_details", body)
        self.assertNotIn("db", body)

    def test_details_that_blow_up_do_not_fail_the_probe(self):
        with patch.object(db_health, "database_details", side_effect=RuntimeError("x")):
            r = self.client.get("/api/health?deep=1")
        # database_details itself never raises; if it somehow did, the probe
        # would be wrong to call a reachable database down.
        self.assertEqual(r.status_code, 200)
