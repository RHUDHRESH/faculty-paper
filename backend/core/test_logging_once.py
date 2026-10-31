"""Each log line is written once.

`core`, `core.api` and `core.log` each had the console handler, and the two
children still passed every record up to `core`, so every request line (and with
`LOG_FORMAT=json`, every JSON object) came out twice on a free log quota.
"""
from __future__ import annotations

import io
import logging

from django.test import Client, TestCase

from core.models import Role, User


class _Console:
    """The configured console handler, writing into a buffer for the length of a test."""

    def __enter__(self) -> io.StringIO:
        self.handler = logging.getLogger("core").handlers[0]
        self.buffer = io.StringIO()
        self.previous = self.handler.setStream(self.buffer)
        return self.buffer

    def __exit__(self, *exc) -> None:
        self.handler.setStream(self.previous)


class EachLineOnce(TestCase):
    def test_a_line_from_any_core_logger_comes_out_once(self):
        for name in ("core", "core.api", "core.log", "core.log.child", "core.services.anything", "core.api.deep.child"):
            with self.subTest(logger=name), _Console() as out:
                logging.getLogger(name).info("said once from %s", name)
                self.assertEqual(out.getvalue().count(f"said once from {name}"), 1, out.getvalue())

    def test_a_request_is_logged_once(self):
        user = User.objects.create_user(email="a@x.edu", password=None, name="A", role=Role.FACULTY)
        client = Client()
        client.force_login(user)
        with _Console() as out:
            client.get("/api/auth/me")
        lines = [line for line in out.getvalue().splitlines() if "request GET /api/auth/me" in line]
        self.assertEqual(len(lines), 1, lines)

    def test_the_format_is_unchanged(self):
        """One line: time, level, logger, message."""
        with _Console() as out:
            logging.getLogger("core.log").info("request GET /x -> 200 in 3ms user=None")
        line = out.getvalue().strip()
        self.assertRegex(line, r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} INFO core\.log request GET /x -> 200 in 3ms user=None$")

    def test_a_warning_from_a_child_still_reaches_the_console(self):
        with _Console() as out:
            logging.getLogger("core.api.child").warning("still heard")
        self.assertIn("still heard", out.getvalue())
