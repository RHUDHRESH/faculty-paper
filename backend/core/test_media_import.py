"""Putting the photos and files back from a zip: what is let in, what is refused, and that names survive.

The live site has every row but none of the files, so the zip comes off one
person's laptop and goes through the Admin page. Everything in the zip is
untrusted: the names, the sizes it declares, and what the bytes really are.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import stat
import struct
import tempfile
import zipfile
from unittest import mock

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import CommandError, call_command
from django.db import connection
from django.test import Client, TestCase, override_settings
from django.test.utils import CaptureQueriesContext

from core.models import AuditLog, Claim, ClaimAttachment, ClaimStatus, Role, StoredFile, User
from core.services import media_import

JPG = b"\xff\xd8\xff\xe0" + b"a real enough jpeg"
PNG = b"\x89PNG\r\n\x1a\n" + b"png"
GIF = b"GIF89a" + b"gif"
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 "
PDF = b"%PDF-1.4\n" + b"a real enough pdf"
SVG = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'


def hexname(i: int, ext: str = "jpg") -> str:
    """The shape of every name the app itself writes: 32 hex digits and an extension."""
    return f"{i:032x}.{ext}"


def build(*entries: tuple[str, bytes], compression=zipfile.ZIP_STORED) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression) as zf:
        for name, data in entries:
            zf.writestr(name, data)
    buf.seek(0)
    return buf


def stored(folder: str) -> list[str]:
    try:
        return default_storage.listdir(folder)[1]
    except FileNotFoundError:
        return []


class _Storage:
    """Every behaviour below holds for each place files can live, so each runs on disk and in the database."""

    backend = ""

    def setUp(self):
        super().setUp()
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        storages = {**settings.STORAGES, "default": {"BACKEND": self.backend}}
        override = override_settings(MEDIA_ROOT=tmp, STORAGES=storages)
        override.enable()
        self.addCleanup(override.disable)

    def all_names(self) -> list[str]:
        return sorted(f"{f}/{n}" for f in media_import.FOLDERS for n in stored(f))

    def read(self, name: str) -> bytes:
        with default_storage.open(name, "rb") as fh:
            return fh.read()

    # -- what comes in -------------------------------------------------------

    def test_good_files_are_filed_under_their_exact_names(self):
        entries = [
            (f"avatars/{hexname(1)}", JPG),
            (f"claims/{hexname(2, 'pdf')}", PDF),
            (f"feed/{hexname(3, 'png')}", PNG),
            (f"site/{hexname(4, 'webp')}", WEBP),
            (f"feed/{hexname(5, 'gif')}", GIF),
        ]
        report = media_import.import_zip(build(*entries))
        self.assertEqual(report["added"], 5)
        self.assertEqual(report["skipped"], 0)
        self.assertEqual(report["rejected"], [])
        self.assertEqual(report["bytes"], sum(len(d) for _, d in entries))
        self.assertEqual(self.all_names(), sorted(n for n, _ in entries))
        for name, data in entries:
            self.assertEqual(self.read(name), data)

    def test_a_zip_made_by_windows_powershell_is_accepted(self):
        # Compress-Archive in Windows PowerShell 5.1 writes "avatars\name.jpg".
        # Python on Windows folds the slash itself; on the Linux host it does not.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            info = zipfile.ZipInfo("placeholder")
            info.filename = f"avatars\\{hexname(1)}"
            zf.writestr(info, JPG)
        buf.seek(0)
        report = media_import.import_zip(buf)
        self.assertEqual(report["added"], 1)
        self.assertEqual(self.all_names(), [f"avatars/{hexname(1)}"])

    def test_folder_entries_are_not_files_and_are_not_a_problem(self):
        report = media_import.import_zip(build(("avatars/", b""), (f"avatars/{hexname(1)}", JPG)))
        self.assertEqual(report["added"], 1)
        self.assertEqual(report["rejected"], [])

    # -- what is refused -----------------------------------------------------

    def test_names_that_climb_out_or_point_elsewhere_are_refused(self):
        bad = [
            f"../{hexname(1)}",
            f"avatars/../../{hexname(1)}",
            f"/avatars/{hexname(1)}",
            f"C:/avatars/{hexname(1)}",
            f"avatars//{hexname(1)}",
            f"avatars/./{hexname(1)}",
            "avatars/" + "a" * 200 + ".jpg",
        ]
        report = media_import.import_zip(build(*[(n, JPG) for n in bad], (f"avatars/{hexname(9)}", JPG)))
        self.assertEqual(report["added"], 1)
        self.assertEqual(len(report["rejected"]), len(bad))
        self.assertTrue(all(r["why"] for r in report["rejected"]))
        self.assertEqual(self.all_names(), [f"avatars/{hexname(9)}"])

    def test_every_backslash_trick_is_judged_after_the_slashes_are_straightened(self):
        for raw in (
            f"..\\{hexname(1)}",
            f"avatars\\..\\..\\{hexname(1)}",
            f"\\avatars\\{hexname(1)}",
            f"C:\\avatars\\{hexname(1)}",
            f"avatars\\\\{hexname(1)}",
            f"avatars/\x00{hexname(1)}",  # zipfile cuts a name at a NUL itself; the check does not rely on that
            f"avatars/a\tb{hexname(1)}",
            "",
        ):
            with self.subTest(raw=raw), self.assertRaises(media_import.NotAccepted):
                media_import.member_path(raw)
        self.assertEqual(media_import.member_path(f"avatars\\{hexname(1)}"), f"avatars/{hexname(1)}")
        self.assertEqual(media_import.member_path(f"claims/{hexname(1, 'pdf')}"), f"claims/{hexname(1, 'pdf')}")

    def test_only_the_four_media_folders_and_only_names_this_app_uses(self):
        bad = [
            hexname(1),  # top level
            f"imports/{hexname(1)}",
            f"__MACOSX/avatars/{hexname(1)}",
            "avatars/me.jpg",  # not a name the media view would ever serve
            f"avatars/{hexname(1).upper()}",
            f"avatars/nested/{hexname(1)}",
            "avatars/.DS_Store",
        ]
        report = media_import.import_zip(build(*[(n, JPG) for n in bad]))
        self.assertEqual(report["added"], 0)
        self.assertEqual([r["name"] for r in report["rejected"]], bad)
        self.assertEqual(self.all_names(), [])

    def test_a_file_whose_contents_are_not_what_its_name_says_is_refused(self):
        entries = [
            (f"avatars/{hexname(1)}", PDF),  # a PDF called .jpg
            (f"claims/{hexname(2, 'pdf')}", b"just some text"),
            (f"feed/{hexname(3, 'png')}", JPG),
            (f"avatars/{hexname(4, 'exe')}", b"MZ\x90\x00"),
            (f"claims/{hexname(5, 'docx')}", b"PK\x03\x04word/"),
            (f"avatars/{hexname(6)}", b""),
            (f"avatars/{hexname(7, 'pdf')}", PDF),  # a PDF has no business in the photos
        ]
        report = media_import.import_zip(build(*entries, (f"avatars/{hexname(8)}", JPG)))
        self.assertEqual(report["added"], 1)
        self.assertEqual([r["name"] for r in report["rejected"]], [n for n, _ in entries])
        self.assertTrue(all(r["why"] for r in report["rejected"]))
        self.assertEqual(self.all_names(), [f"avatars/{hexname(8)}"])

    def test_svg_only_under_site_and_never_with_script_in_it(self):
        report = media_import.import_zip(build(
            (f"site/{hexname(1, 'svg')}", SVG),
            (f"avatars/{hexname(2, 'svg')}", SVG),
            (f"claims/{hexname(3, 'svg')}", SVG),
            (f"site/{hexname(4, 'svg')}", b"<svg><script>alert(1)</script></svg>"),
            (f"site/{hexname(5, 'svg')}", b"<svg onload=\"alert(1)\"></svg>"),
            (f"site/{hexname(6, 'svg')}", b"not an svg at all"),
        ))
        self.assertEqual(report["added"], 1)
        self.assertEqual(self.all_names(), [f"site/{hexname(1, 'svg')}"])
        self.assertEqual(len(report["rejected"]), 5)

    def test_one_entry_over_the_per_file_limit_is_refused_and_the_rest_still_go_in(self):
        big = b"%PDF" + b"\0" * media_import.MAX_FILE  # past the limit; deflated it is a few kilobytes
        report = media_import.import_zip(
            build((f"claims/{hexname(1, 'pdf')}", big), (f"claims/{hexname(2, 'pdf')}", PDF),
                  compression=zipfile.ZIP_DEFLATED)
        )
        self.assertEqual(report["added"], 1)
        self.assertEqual([r["name"] for r in report["rejected"]], [f"claims/{hexname(1, 'pdf')}"])
        self.assertIn("20 MB", report["rejected"][0]["why"])
        self.assertEqual(self.all_names(), [f"claims/{hexname(2, 'pdf')}"])

    def test_a_link_in_the_zip_is_refused(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            link = zipfile.ZipInfo(f"avatars/{hexname(1)}")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(link, "../../etc/passwd")
        buf.seek(0)
        report = media_import.import_zip(buf)
        self.assertEqual(report["added"], 0)
        self.assertIn("link", report["rejected"][0]["why"])

    def test_a_folder_that_carries_data_is_refused(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(zipfile.ZipInfo("claims/"), b"data in a folder")
        buf.seek(0)
        report = media_import.import_zip(buf)
        self.assertEqual(report["added"], 0)
        self.assertEqual(len(report["rejected"]), 1)

    def test_a_password_protected_entry_is_refused_not_a_crash(self):
        raw = bytearray(build((f"claims/{hexname(1, 'pdf')}", PDF)).getvalue())
        for sig, at in ((b"PK\x01\x02", 8), (b"PK\x03\x04", 6)):
            struct.pack_into("<H", raw, raw.find(sig) + at, 0x1)
        report = media_import.import_zip(io.BytesIO(bytes(raw)))
        self.assertEqual(report["added"], 0)
        self.assertIn("password", report["rejected"][0]["why"])

    def test_a_header_that_lies_about_the_size_is_not_believed(self):
        raw = bytearray(build((f"claims/{hexname(1, 'pdf')}", PDF + b"A" * 100)).getvalue())
        struct.pack_into("<L", raw, raw.find(b"PK\x01\x02") + 24, 20)
        struct.pack_into("<L", raw, raw.find(b"PK\x03\x04") + 22, 20)
        report = media_import.import_zip(io.BytesIO(bytes(raw)))
        self.assertEqual(report["added"], 0)
        self.assertEqual(len(report["rejected"]), 1)
        self.assertEqual(self.all_names(), [])

    def test_the_same_name_twice_files_the_first_and_says_so(self):
        with self.assertWarns(UserWarning):  # zipfile itself warns about the duplicate
            report = media_import.import_zip(build((f"avatars/{hexname(1)}", JPG), (f"avatars/{hexname(1)}", PNG)))
        self.assertEqual(report["added"], 1)
        self.assertEqual(self.read(f"avatars/{hexname(1)}"), JPG)
        self.assertEqual(len(report["rejected"]), 1)

    # -- the whole archive ---------------------------------------------------

    def test_something_that_is_not_a_zip_is_refused_with_a_plain_message(self):
        for blob in (b"hello", b"", b"PK\x03\x04 but then nothing sensible"):
            with self.subTest(blob=blob[:8]), self.assertRaisesMessage(media_import.MediaImportError, "not a zip"):
                media_import.import_zip(io.BytesIO(blob))

    def test_more_than_5000_entries_is_refused_before_anything_is_written(self):
        entries = [(f"avatars/{hexname(i)}", JPG) for i in range(media_import.MAX_ENTRIES + 1)]
        with self.assertRaisesMessage(media_import.MediaImportError, "5,000"):
            media_import.import_zip(build(*entries))
        self.assertEqual(self.all_names(), [])

    def test_a_zip_that_declares_a_giant_directory_is_refused_without_being_opened(self):
        # zipfile builds an object per listed entry the moment it opens a zip; on a
        # 512 MB host that must not happen for a list far longer than 5,000 names.
        raw = bytearray(build((f"avatars/{hexname(1)}", JPG)).getvalue())
        struct.pack_into("<L", raw, raw.rfind(b"PK\x05\x06") + 12, 50 * 1024 * 1024)
        with mock.patch.object(media_import.zipfile, "ZipFile") as opened:
            with self.assertRaisesMessage(media_import.MediaImportError, "5,000"):
                media_import.import_zip(io.BytesIO(bytes(raw)))
        opened.assert_not_called()

    def test_a_zip_that_would_unpack_past_the_total_limit_is_refused_before_anything_is_written(self):
        zipped = build((f"avatars/{hexname(1)}", JPG + b"\0" * 400), (f"avatars/{hexname(2)}", JPG + b"\0" * 400),
                       compression=zipfile.ZIP_DEFLATED)
        with mock.patch.object(media_import, "MAX_UNCOMPRESSED", 500):
            with self.assertRaisesMessage(media_import.MediaImportError, "Unpacked"):
                media_import.import_zip(zipped)
        self.assertEqual(self.all_names(), [])

    def test_the_running_total_stops_a_read_that_outgrows_the_limit(self):
        # The sizes a zip declares can pass the up-front check and still be wrong;
        # counting what is really read is what holds the line.
        entries = [(f"avatars/{hexname(i)}", JPG + b"\0" * 100) for i in range(1, 6)]
        with mock.patch.object(media_import, "_check_declared_sizes"), \
                mock.patch.object(media_import, "MAX_UNCOMPRESSED", 2 * (len(JPG) + 100) + 1):
            report = media_import.import_zip(build(*entries))
        self.assertEqual(report["added"], 2)
        self.assertEqual([r["name"] for r in report["rejected"]], [n for n, _ in entries[2:]])
        self.assertIn("unpacks past", report["rejected"][0]["why"])
        self.assertEqual(self.all_names(), sorted(n for n, _ in entries[:2]))

    def test_an_archive_over_the_size_limit_is_refused(self):
        zipped = build((f"avatars/{hexname(1)}", JPG))
        with mock.patch.object(media_import, "MAX_ARCHIVE", 50):
            with self.assertRaisesMessage(media_import.MediaImportError, "Split it"):
                media_import.import_zip(zipped)
        self.assertEqual(self.all_names(), [])

    # -- already there -------------------------------------------------------

    def test_a_file_that_is_already_there_is_skipped_and_left_alone(self):
        name = f"avatars/{hexname(1)}"
        default_storage.save(name, ContentFile(b"what was here first"))
        report = media_import.import_zip(build((name, JPG), (f"avatars/{hexname(2)}", JPG)))
        self.assertEqual((report["added"], report["skipped"]), (1, 1))
        self.assertEqual(self.read(name), b"what was here first")
        self.assertEqual(report["bytes"], len(JPG))

    def test_overwrite_replaces_the_content_and_keeps_the_exact_name(self):
        name = f"avatars/{hexname(1)}"
        default_storage.save(name, ContentFile(b"old"))
        report = media_import.import_zip(build((name, JPG)), overwrite=True)
        self.assertEqual((report["added"], report["skipped"]), (1, 0))
        self.assertEqual(self.read(name), JPG)
        # Django would call the new file avatars/<name>_AbC123.jpg if it were handed over as is.
        self.assertEqual(self.all_names(), [name])

    def test_importing_the_same_zip_twice_changes_nothing_the_second_time(self):
        entries = [(f"avatars/{hexname(i)}", JPG) for i in range(1, 8)]
        media_import.import_zip(build(*entries))
        again = media_import.import_zip(build(*entries))
        self.assertEqual((again["added"], again["skipped"], again["bytes"]), (0, 7, 0))
        self.assertEqual(self.all_names(), sorted(n for n, _ in entries))

    # -- and then the app serves it -----------------------------------------

    def test_an_imported_photo_is_served_by_the_media_view_to_a_signed_in_person(self):
        owner = User.objects.create_user(email="o@x.edu", password="p", name="O", role=Role.FACULTY)
        viewer = User.objects.create_user(email="v@x.edu", password="p", name="V", role=Role.FACULTY)
        photo, header = f"avatars/{hexname(7)}", f"site/{hexname(8)}"
        User.objects.filter(pk=owner.pk).update(photo=photo)
        c = Client()
        c.force_login(viewer)
        self.assertEqual(c.get(f"/media/{photo}").status_code, 404)  # the live site today
        media_import.import_zip(build((photo, JPG), (header, JPG)))
        for name in (photo, header):
            r = c.get(f"/media/{name}")
            self.assertEqual(r.status_code, 200, name)
            self.assertEqual(r["Content-Type"], "image/jpeg")
            self.assertEqual(b"".join(r.streaming_content), JPG)
        self.assertEqual(Client().get(f"/media/{photo}").status_code, 401)

    def test_an_imported_claim_file_is_served_to_the_person_who_filed_it(self):
        owner = User.objects.create_user(email="o@x.edu", password="p", name="O", role=Role.FACULTY)
        name = f"claims/{hexname(3, 'pdf')}"
        claim = Claim.objects.create(owner=owner, status=ClaimStatus.SUBMITTED, paper_title="A paper")
        ClaimAttachment.objects.create(claim=claim, kind="PUBLISHED_PAPER", url=f"{settings.MEDIA_URL}{name}")
        c = Client()
        c.force_login(owner)
        self.assertEqual(c.get(f"/media/{name}").status_code, 404)
        media_import.import_zip(build((name, PDF)))
        r = c.get(f"/media/{name}")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r["Content-Type"], "application/pdf")
        self.assertEqual(b"".join(r.streaming_content), PDF)


class FilesOnDisk(_Storage, TestCase):
    backend = "django.core.files.storage.FileSystemStorage"


class FilesInTheDatabase(_Storage, TestCase):
    backend = "core.storage_db.DatabaseStorage"

    def test_a_whole_zip_costs_a_handful_of_queries_not_several_per_file(self):
        # The host is a tenth of a CPU talking to a database across the network; a
        # round trip per file is what turns 800 files into a timeout.
        entries = [(f"avatars/{hexname(i)}", JPG) for i in range(120)]
        with CaptureQueriesContext(connection) as q:
            report = media_import.import_zip(build(*entries))
        self.assertEqual(report["added"], 120)
        self.assertLess(len(q), 30, [x["sql"][:80] for x in q.captured_queries])
        self.assertEqual(StoredFile.objects.count(), 120)
        with CaptureQueriesContext(connection) as q:
            again = media_import.import_zip(build(*entries))
        self.assertEqual(again["skipped"], 120)
        self.assertLess(len(q), 10)
        with CaptureQueriesContext(connection) as q:
            media_import.import_zip(build(*entries), overwrite=True)
        self.assertLess(len(q), 30, [x["sql"][:80] for x in q.captured_queries])
        self.assertEqual(StoredFile.objects.count(), 120)

    def test_a_backup_kept_beside_the_photos_is_never_touched(self):
        StoredFile.objects.create(name="backups/b.json.gz", content=b"keep", size=4)
        media_import.import_zip(build((f"avatars/{hexname(1)}", JPG)), overwrite=True)
        self.assertEqual(bytes(StoredFile.objects.get(name="backups/b.json.gz").content), b"keep")


# -- the Admin page's endpoint and the command -------------------------------


def _upload(data: io.BytesIO, name="media.zip") -> SimpleUploadedFile:
    return SimpleUploadedFile(name, data.getvalue(), content_type="application/zip")


class Endpoint(TestCase):
    URL = "/api/admin/media-import"

    def setUp(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        override = override_settings(MEDIA_ROOT=tmp)
        override.enable()
        self.addCleanup(override.disable)
        self.admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        self.c = Client()
        self.c.force_login(self.admin)
        self.name = f"avatars/{hexname(1)}"

    def post(self, data=None, **form):
        return self.c.post(self.URL, {"file": _upload(data or build((self.name, JPG))), **form})

    def test_only_a_super_admin_may_load_files(self):
        for role in (Role.FACULTY, Role.RESEARCH_COORDINATOR, Role.DIRECTOR, Role.FINANCE, Role.PRINCIPAL):
            who = User.objects.create_user(email=f"{role}@x.edu", password="p", name=str(role), role=role)
            c = Client()
            c.force_login(who)
            r = c.post(self.URL, {"file": _upload(build((self.name, JPG)))})
            self.assertEqual(r.status_code, 403, role)
        self.assertEqual(Client().post(self.URL, {"file": _upload(build((self.name, JPG)))}).status_code, 401)
        self.assertFalse(default_storage.exists(self.name))
        self.assertFalse(AuditLog.objects.filter(action="MEDIA_IMPORTED").exists())

    def test_it_files_the_zip_and_answers_with_the_report(self):
        r = self.post(build((self.name, JPG), (f"avatars/{hexname(2, 'exe')}", b"MZ")))
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual((body["added"], body["skipped"], body["bytes"]), (1, 0, len(JPG)))
        self.assertEqual([x["name"] for x in body["rejected"]], [f"avatars/{hexname(2, 'exe')}"])
        self.assertEqual(default_storage.open(self.name).read(), JPG)

    def test_overwrite_is_off_unless_asked_for(self):
        default_storage.save(self.name, ContentFile(b"old"))
        self.assertEqual(self.post().json()["skipped"], 1)
        self.assertEqual(default_storage.open(self.name).read(), b"old")
        self.assertEqual(self.post(overwrite="true").json()["added"], 1)
        self.assertEqual(default_storage.open(self.name).read(), JPG)

    def test_one_audit_row_carries_counts_and_no_file_names(self):
        self.post(build((self.name, JPG), (f"avatars/{hexname(2, 'exe')}", b"MZ")))
        row = AuditLog.objects.get(action="MEDIA_IMPORTED")
        self.assertEqual(row.actor, self.admin)
        self.assertEqual(
            json.loads(row.detail_json),
            {"added": 1, "replaced": 0, "skipped": 0, "rejected": 1, "bytes": len(JPG), "overwrite": False},
        )
        self.assertNotIn(hexname(1), row.detail_json)

    def test_a_file_that_is_not_a_zip_is_a_plain_400_and_changes_nothing(self):
        r = self.c.post(self.URL, {"file": SimpleUploadedFile("media.zip", b"hello")})
        self.assertEqual(r.status_code, 400)
        self.assertIn("not a zip", r.json()["detail"])
        self.assertFalse(AuditLog.objects.filter(action="MEDIA_IMPORTED").exists())

    def test_a_zip_big_enough_to_be_spooled_to_disk_is_read_just_the_same(self):
        # Over 2.5 MB Django hands the view a temporary file, not bytes in memory.
        chunks = [(f"avatars/{hexname(i)}", JPG + os.urandom(900_000)) for i in range(1, 5)]
        r = self.post(build(*chunks, compression=zipfile.ZIP_DEFLATED))
        self.assertEqual(r.json()["added"], 4)
        self.assertEqual(default_storage.open(f"avatars/{hexname(3)}").read(), chunks[2][1])


class Command(TestCase):
    def setUp(self):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        override = override_settings(MEDIA_ROOT=tmp)
        override.enable()
        self.addCleanup(override.disable)
        self.zip = os.path.join(tmp, "media.zip")
        with open(self.zip, "wb") as fh:
            fh.write(build((f"avatars/{hexname(1)}", JPG), (f"avatars/{hexname(2, 'exe')}", b"MZ")).getvalue())

    def run_command(self, *args):
        out = io.StringIO()
        call_command("import_media", *args, stdout=out)
        return out.getvalue()

    def test_it_uses_the_same_service_and_says_what_happened(self):
        said = self.run_command(self.zip)
        self.assertIn("Added: 1", said)
        self.assertIn("Skipped: 0", said)
        self.assertIn(f"avatars/{hexname(2, 'exe')}", said)
        self.assertTrue(default_storage.exists(f"avatars/{hexname(1)}"))

    def test_overwrite_is_a_flag(self):
        default_storage.save(f"avatars/{hexname(1)}", ContentFile(b"old"))
        self.assertIn("Skipped: 1", self.run_command(self.zip))
        self.assertIn("Added: 1", self.run_command(self.zip, "--overwrite"))
        self.assertEqual(default_storage.open(f"avatars/{hexname(1)}").read(), JPG)

    def test_a_missing_file_or_a_non_zip_is_an_error_not_a_traceback(self):
        with self.assertRaises(CommandError):
            self.run_command(self.zip + ".nope")
        bad = self.zip + ".txt"
        with open(bad, "wb") as fh:
            fh.write(b"not a zip")
        with self.assertRaisesMessage(CommandError, "not a zip"):
            self.run_command(bad)
