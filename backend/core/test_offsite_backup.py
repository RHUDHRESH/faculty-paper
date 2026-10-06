"""The daily off-site backup (core.services.backup.store_offsite)."""
from __future__ import annotations

import tempfile
from unittest import mock

from django.core.files.base import ContentFile
from django.core.files.storage import FileSystemStorage
from django.test import TestCase, override_settings

from core.models import AuditLog
from core.services import backup


class OffsiteBackupTests(TestCase):
    @override_settings(S3_BUCKET_NAME="")
    def test_without_a_bucket_it_does_nothing_and_says_so(self):
        out = backup.store_offsite()
        self.assertFalse(out["ok"])
        self.assertIn("S3_BUCKET_NAME", out["reason"])

    @override_settings(S3_BUCKET_NAME="test-bucket")
    def test_a_copy_lands_in_the_store_and_reads_back_as_a_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = FileSystemStorage(location=tmp)
            with mock.patch("django.core.files.storage.default_storage", store):
                out = backup.store_offsite("daily")
                self.assertTrue(out["ok"])
                self.assertTrue(out["name"].startswith(backup.OFFSITE_DIR))
                with store.open(out["name"], "rb") as fh:
                    self.assertGreaterEqual(backup.verify(fh.read()), 0)
        self.assertTrue(AuditLog.objects.filter(action="BACKUP_OFFSITE_STORED").exists())

    @override_settings(S3_BUCKET_NAME="test-bucket")
    def test_only_the_newest_copies_are_kept(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = FileSystemStorage(location=tmp)
            with mock.patch("django.core.files.storage.default_storage", store):
                for i in range(backup.OFFSITE_KEEP + 3):
                    store.save(f"{backup.OFFSITE_DIR}daily-20260101-0000{i:02d}-000000.json.gz",
                               ContentFile(b"old"))
                backup.store_offsite("daily")
                _dirs, files = store.listdir(backup.OFFSITE_DIR.rstrip("/"))
                self.assertEqual(len([f for f in files if f.endswith(".json.gz")]), backup.OFFSITE_KEEP)
