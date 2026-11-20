"""Offline regression tests: python -m unittest discover -s scripts -p 'test_*.py'."""

import contextlib
import io
import json
import subprocess
import unittest
from unittest.mock import Mock, patch

import keepalive


class ProbeTests(unittest.TestCase):
    def response(self, body, *, status="200", returncode=0):
        return subprocess.CompletedProcess([], returncode, f"{body}\n{status}", "")

    def check_response(self, response):
        with patch.object(keepalive.subprocess, "run", return_value=response) as run:
            result = keepalive.probe("https://example.invalid/api/health")
        args = run.call_args
        self.assertEqual(args.kwargs["timeout"], 95)
        self.assertEqual(args.kwargs["errors"], "replace")
        self.assertIn("--max-time", args.args[0])
        self.assertIn("--max-filesize", args.args[0])
        return result

    def test_healthy_api(self):
        body = json.dumps({"ok": True, "db": True, "service": "faculty-paper-api"})
        self.assertTrue(self.check_response(self.response(body))[0])

    def test_wake_up_page_is_not_healthy(self):
        self.assertFalse(self.check_response(self.response("<html>Loading</html>"))[0])

    def test_non_utf8_error_page_is_not_healthy(self):
        body = b"\xff\xfeNot JSON".decode("utf-8", errors="replace")
        self.assertFalse(self.check_response(self.response(body))[0])

    def test_failed_or_wrong_payload(self):
        for data in [None, [], {}, {"ok": True},
                     {"ok": True, "db": False, "service": "faculty-paper-api"},
                     {"ok": "true", "db": True, "service": "faculty-paper-api"},
                     {"ok": True, "db": True, "service": "another-app"}]:
            with self.subTest(data=data):
                self.assertFalse(self.check_response(self.response(json.dumps(data)))[0])

    def test_http_error_redirect_and_transport_failure(self):
        for status, code in [("503", 22), ("302", 0), ("000", 28)]:
            with self.subTest(status=status):
                self.assertFalse(self.check_response(self.response("", status=status, returncode=code))[0])

    def test_timeout_and_missing_curl(self):
        for error in [subprocess.TimeoutExpired("curl", 95), FileNotFoundError()]:
            with self.subTest(error=error), patch.object(keepalive.subprocess, "run", side_effect=error):
                self.assertFalse(keepalive.probe("https://example.invalid")[0])


class MonitorTests(unittest.TestCase):
    def run_monitor(self, results):
        now = [0]
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds

        check = Mock(side_effect=results)
        with contextlib.redirect_stdout(io.StringIO()) as output:
            code = keepalive.monitor("https://example.invalid", duration=10, interval=4,
                                     check=check, clock=lambda: now[0], sleep=sleep)
        self.assertEqual(check.call_count, 3)
        self.assertEqual(sleeps, [4, 4, 2])
        return code, output.getvalue()

    def test_all_healthy_succeeds(self):
        code, output = self.run_monitor([(True, "healthy")] * 3)
        self.assertEqual(code, 0)
        self.assertIn("3/3 passed", output)

    def test_failure_is_not_swallowed_even_after_recovery(self):
        code, output = self.run_monitor([(False, "timeout"), (True, "healthy"), (True, "healthy")])
        self.assertEqual(code, 1)
        self.assertIn("::error::1 of 3", output)

    def test_persistent_outage_finishes_window_and_fails(self):
        code, output = self.run_monitor([(False, "timeout")] * 3)
        self.assertEqual(code, 1)
        self.assertIn("0/3 passed", output)

    def test_no_probes_cannot_pass(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(keepalive.monitor("unused", duration=0), 1)


if __name__ == "__main__":
    unittest.main()
