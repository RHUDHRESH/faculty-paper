"""The DEBUG-only test helpers cannot run on a live (DJANGO_DEBUG=false) site."""
import json
import os
import tempfile
from unittest import mock

from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings

from core.models import User
from core.services.search import upstream


@override_settings(DEBUG=False)
class ProductionGuardTests(TestCase):
    def test_password_free_session_commands_refuse(self):
        for cmd, kw in [("e2e_session", {"role": "FACULTY"}), ("e2e_year", {}),
                        ("seed_demo_faculty", {}), ("seed_demo_finance", {}), ("seed_demo_hod", {})]:
            with self.subTest(cmd=cmd), self.assertRaises(CommandError):
                call_command(cmd, **kw)
        self.assertFalse(User.objects.filter(email__iendswith="@e2e.invalid").exists())

    def test_upstream_fixtures_ignored_without_debug(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump({"doi.org": {"canned": True}}, fh)
        try:
            with mock.patch.dict(os.environ, {"E2E_UPSTREAM_FIXTURES": fh.name}):
                self.assertIs(upstream._canned("https://api.crossref.org/works/doi.org/x"), upstream._MISS)
                with override_settings(DEBUG=True):
                    self.assertEqual(upstream._canned("https://doi.org/x"), {"canned": True})
        finally:
            os.unlink(fh.name)
