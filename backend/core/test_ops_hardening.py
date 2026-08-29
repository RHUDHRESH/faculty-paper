"""The production hardening: caps, request ids, JSON logs, health depth.

These pin the pieces Cloud Run depends on that no screen exercises: the
rate limiter's window arithmetic, the request id that ties a complaint to
a log line, the JSON shape Cloud Logging parses, and the health payload's
migrations fact.
"""

from __future__ import annotations

import json
import logging

from django.core.cache import cache
from django.http import HttpRequest, HttpResponse
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings

from core.api.common import rate_limit, rate_limit_for
from core.log import JsonFormatter, RequestIdFilter, RequestIdMiddleware
from core.models import User
from ninja.errors import HttpError


class RateLimitTests(TestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(
            email="cap@test.edu", password="x", name="Cap", role="FACULTY",
        )

    def _call(self, n):
        for _ in range(n):
            rate_limit_for(self.user, "ai", 2, "day", what="the AI suggestions")

    def test_up_to_the_limit_passes_and_over_it_refuses(self):
        self._call(2)
        with self.assertRaises(HttpError) as raised:
            rate_limit_for(self.user, "ai", 2, "day", what="the AI suggestions")
        self.assertEqual(raised.exception.status_code, 429)
        self.assertIn("limit is 2", raised.exception.message)

    def test_a_different_account_has_its_own_cap(self):
        other = User.objects.create_user(
            email="other@test.edu", password="x", name="Other", role="FACULTY",
        )
        self._call(2)
        rate_limit_for(other, "ai", 2, "day", what="the AI suggestions")

    def test_a_different_bucket_has_its_own_cap(self):
        self._call(2)
        rate_limit_for(self.user, "agent", 2, "day", what="asking the assistant")

    def test_endpoints_use_the_same_helper_so_the_cap_is_real(self):
        request = RequestFactory().get("/whatever")
        request.user = self.user
        rate_limit(request, "ai", 2, "day", what="the AI suggestions")
        rate_limit(request, "ai", 2, "day", what="the AI suggestions")
        with self.assertRaises(HttpError):
            rate_limit(request, "ai", 2, "day", what="the AI suggestions")


class _Recorder(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


class RequestIdTests(SimpleTestCase):
    def _listen(self, name: str) -> _Recorder:
        """Attach a recorder to the real logger the code logs through."""
        recorder = _Recorder()
        logger = logging.getLogger(name)
        logger.addHandler(recorder)
        logger.addFilter(RequestIdFilter())
        self.addCleanup(logger.removeHandler, recorder)
        return recorder

    def test_a_request_gets_an_id_that_is_echoed_and_stamped_on_its_logs(self):
        recorder = self._listen("core.log.test")
        seen = {}

        def view(request):
            logging.getLogger("core.log.test").warning("something happened")
            seen["record"] = recorder.records[-1]
            return HttpResponse("ok")

        response = RequestIdMiddleware(view)(RequestFactory().get("/x"))
        record = seen["record"]
        self.assertTrue(record.request_id)
        # With no project id in the environment, the trace field carries the
        # raw minted trace id -- the same value, so the join still works.
        self.assertEqual(record.trace, record.request_id)
        self.assertEqual(response["X-Request-ID"], record.request_id)

    def test_cloud_runs_trace_header_becomes_the_request_id(self):
        captured = {}

        def view(request):
            captured["id"] = request.request_id
            return HttpResponse("ok")

        factory = RequestFactory()
        trace = "1a2b3c4d5e6f77889900aabbccddeeff/12345;o=1"
        request = factory.get("/x", HTTP_X_CLOUD_TRACE_CONTEXT=trace)
        response = RequestIdMiddleware(view)(request)
        self.assertEqual(captured["id"], "1a2b3c4d5e6f77889900aabbccddeeff")
        self.assertEqual(response["X-Request-ID"], captured["id"])

    def test_a_server_error_still_logs_the_access_line(self):
        recorder = self._listen("core.log")

        def view(request):
            raise RuntimeError("boom")

        with self.assertRaises(RuntimeError):
            RequestIdMiddleware(view)(RequestFactory().get("/x"))
        messages = [r.getMessage() for r in recorder.records]
        self.assertTrue(any("errored" in m for m in messages), messages)


class JsonFormatterTests(SimpleTestCase):
    def _format(self, record):
        record.request_id = "abc123"
        return json.loads(JsonFormatter().format(record))

    def test_a_log_line_is_one_json_object_with_cloud_loggings_names(self):
        record = logging.LogRecord(
            "core.api", logging.WARNING, __file__, 1, "venue search slow", None, None,
        )
        out = self._format(record)
        self.assertEqual(out["severity"], "WARNING")
        self.assertEqual(out["message"], "venue search slow")
        self.assertEqual(out["request_id"], "abc123")

    def test_a_trace_lands_in_the_field_cloud_trace_joins_on(self):
        record = logging.LogRecord(
            "core.api", logging.INFO, __file__, 1, "hi", None, None,
        )
        record.trace = "projects/p/traces/abc"
        out = self._format(record)
        self.assertEqual(out["logging.googleapis.com/trace"], "projects/p/traces/abc")

    def test_a_traceback_travels_inside_the_message(self):
        try:
            raise ValueError("no")
        except ValueError:
            import sys

            record = logging.LogRecord(
                "core.api", logging.ERROR, __file__, 1, "failed", None,
                sys.exc_info(),
            )
        out = self._format(record)
        self.assertIn("ValueError: no", out["message"])
        self.assertIn("Traceback", out["message"])


@override_settings(GS_BUCKET_NAME="test-bucket")
class HealthDepthTests(TestCase):
    def test_migrations_are_reported_as_applied_on_a_migrated_database(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.json()["migrations_pending"])
