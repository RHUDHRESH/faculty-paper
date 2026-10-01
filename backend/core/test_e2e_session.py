"""The fixture accounts the browser tests sign in as."""
import json
from io import StringIO

from django.core.management import call_command
from django.test import TestCase, override_settings

from core.models import User


@override_settings(DEBUG=True)
class E2ESessionTests(TestCase):
    def _session(self, role: str) -> dict:
        out = StringIO()
        call_command("e2e_session", role=role, json=True, stdout=out)
        return json.loads(out.getvalue())

    def test_fixture_has_already_seen_the_welcome(self):
        # The first-sign-in dialog opens over the page and takes the first
        # click of every spec that is not about the dialog.
        info = self._session("FACULTY")
        self.assertIsNotNone(User.objects.get(pk=info["user_id"]).welcome_seen_at)

    def test_asking_twice_keeps_the_first_seen_time(self):
        info = self._session("RESEARCH_CELL")
        first = User.objects.get(pk=info["user_id"]).welcome_seen_at
        self._session("RESEARCH_CELL")
        self.assertEqual(User.objects.get(pk=info["user_id"]).welcome_seen_at, first)
