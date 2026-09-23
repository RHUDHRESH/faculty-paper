"""Files kept in the database, and restoring an export into a fresh install."""
import json
import os
import tempfile

from django.core.files.base import ContentFile
from django.core.management import call_command
from django.test import Client, TestCase, override_settings

from core.models import Claim, ClaimStatus, Role, StoredFile, User
from core.storage_db import DatabaseStorage


class DatabaseStorageTests(TestCase):
    def test_a_file_round_trips(self):
        s = DatabaseStorage()
        name = s.save("claims/a.pdf", ContentFile(b"%PDF-1.4 hello"))
        self.assertTrue(s.exists(name))
        self.assertEqual(s.size(name), len(b"%PDF-1.4 hello"))
        self.assertEqual(s.open(name).read(), b"%PDF-1.4 hello")
        self.assertEqual(s.listdir("claims")[1], ["a.pdf"])
        s.delete(name)
        self.assertFalse(s.exists(name))
        self.assertFalse(StoredFile.objects.exists())


@override_settings(MEDIA_ROOT=tempfile.mkdtemp())
class RestoreEndpointTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        self.c = Client()

    def _post(self, confirm="RESTORE", body=b"[]", name="dump.json"):
        f = ContentFile(body, name=name)
        return self.c.post("/api/admin/restore", {"file": f, "confirm": confirm})

    def test_only_a_super_admin_may_restore(self):
        u = User.objects.create_user(email="f@x.edu", password="p", name="F", role=Role.FACULTY)
        self.c.force_login(u)
        self.assertEqual(self._post().status_code, 403)

    def test_it_must_be_confirmed(self):
        self.c.force_login(self.admin)
        self.assertEqual(self._post(confirm="").status_code, 400)

    def test_it_refuses_an_installation_that_holds_claims(self):
        Claim.objects.create(owner=self.admin, status=ClaimStatus.SUBMITTED, paper_title="x")
        self.c.force_login(self.admin)
        self.assertEqual(self._post().status_code, 409)

    def test_the_task_loads_an_export(self):
        from core.tasks import run_restore

        person = User.objects.create_user(email="p@x.edu", password="p", name="P", role=Role.FACULTY)
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        call_command("dumpdata", "core.user", "--natural-foreign", "--natural-primary", "-o", path)
        person.delete()
        result = run_restore(path, self.admin.id)
        self.assertTrue(result["ok"])
        self.assertTrue(User.objects.filter(email="p@x.edu").exists())
        self.assertFalse(os.path.exists(path))
