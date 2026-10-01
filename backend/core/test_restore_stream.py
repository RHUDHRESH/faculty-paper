"""The streamed, resumable restore (core/services/restore.py and POST /api/admin/restore)."""
import gzip
import hashlib
import json
import os
import tempfile
from datetime import date, datetime, timezone as dt_tz
from unittest import mock

from django.core.files.base import ContentFile
from django.core.management import call_command
from django.test import Client, TestCase, override_settings

from core.models import (
    Authorship, Claim, ClaimStatus, FormulaConfig, PaidLedger, Post, Publication, PublicationMetrics,
    Role, StoredFile, SystemSetting, Thread, User,
)
from core.services import restore


def _write(lines, name="x.jsonl", gz=False, array=False):
    d = tempfile.mkdtemp()
    path = os.path.join(d, name)
    text = ("[\n" + ",\n".join(lines) + "\n]\n") if array else ("\n".join(lines) + "\n")
    if gz:
        with gzip.open(path, "wb") as f:
            f.write(text.encode("utf-8"))
    else:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return path


def _dump(*labels, natural_primary=False, fmt="jsonl", gz=True):
    d = tempfile.mkdtemp()
    path = os.path.join(d, f"d.{fmt}" + (".gz" if gz else ""))
    args = ["dumpdata", *labels, "--natural-foreign", "--format", fmt, "-o", path]
    if natural_primary:
        args.append("--natural-primary")
    call_command(*args)
    return path


def _populate():
    """A small college: people, a paid claim with a ledger row, a publication linked to it."""
    owner = User.objects.create_user(email="o@x.edu", password="pw", name="Owner", staff_id="S1")
    other = User.objects.create_user(email="p@x.edu", password="pw", name="Other", staff_id="S2")
    claim = Claim.objects.create(owner=owner, status=ClaimStatus.PAID, paper_title="Paper", remuneration=5000, doi="10.1/x")
    PaidLedger.objects.create(claim=claim, payout_month=date(2025, 1, 1), amount=5000, staff_id="S1")
    pub = Publication.objects.create(title="Paper", year=2024, doi="10.1/x")
    pub.claims.add(claim)
    for n in range(5):
        Authorship.objects.create(publication=pub, user=owner if n == 0 else None, display_name=f"A{n}",
                                  author_key=f"k{n}", position=n + 1)
    FormulaConfig.objects.create(author_point_json="{}", active=True, name="College policy")
    return owner, other, claim, pub


def _empty_install():
    for m in (Authorship, Publication, PaidLedger, Claim, FormulaConfig, SystemSetting, User):
        m.objects.all().delete()
    admin = User.objects.create_user(email="restorer@x.edu", password="p", name="R", role=Role.SUPER_ADMIN)
    default = FormulaConfig.objects.create(author_point_json="{}", active=True, name="Default")
    return admin, default


class ReaderTests(TestCase):
    OBJS = [
        json.dumps({"model": "core.systemsetting", "pk": f"k{i}", "fields": {"value": {"n": i, "s": "é x"}}})
        for i in range(5)
    ]

    def test_every_accepted_shape_reads_the_same_objects(self):
        want = [json.loads(o) for o in self.OBJS]
        for name, kw in (("a.jsonl", {}), ("a.jsonl.gz", {"gz": True}), ("a.json", {"array": True}),
                         ("a.json.gz", {"array": True, "gz": True})):
            got = [o for _, o, _ in restore.iter_objects(_write(self.OBJS, name, **kw))]
            self.assertEqual(got, want, name)
            self.assertEqual(restore.count_objects(_write(self.OBJS, name, **kw)), 5, name)

    def test_a_gzip_is_recognised_by_its_bytes_not_its_name(self):
        path = _write(self.OBJS, "misnamed.json", gz=True)
        self.assertEqual(len(list(restore.iter_objects(path))), 5)

    def test_an_array_with_one_huge_line_streams_across_chunks(self):
        big = json.dumps({"model": "core.systemsetting", "pk": "big", "fields": {"value": {"t": "x" * 3_000_000}}})
        path = _write([self.OBJS[0], big, self.OBJS[1]], "a.json", array=True)
        got = [o["pk"] for _, o, _ in restore.iter_objects(path)]
        self.assertEqual(got, ["k0", "big", "k1"])

    def test_skip_and_only(self):
        path = _write(self.OBJS + [json.dumps({"model": "core.badge", "pk": 1, "fields": {}})], "a.jsonl")
        self.assertEqual([i for i, _, _ in restore.iter_objects(path, skip=3)], [3, 4, 5])
        self.assertEqual([i for i, _, _ in restore.iter_objects(path, only={"core.badge"})], [5])

    def test_garbage_is_refused(self):
        with self.assertRaises(restore.RestoreError):
            restore.sniff(_write(["hello"], "a.jsonl"))
        with self.assertRaises(restore.RestoreError):
            list(restore.iter_objects(_write(['{"model": "x", broken'], "a.jsonl")))


class LoadTests(TestCase):
    def test_jsonl_round_trip_keeps_rows_links_and_stamps(self):
        owner, other, claim, pub = _populate()
        stamp = datetime(2024, 3, 4, 5, 6, 7, 123000, tzinfo=dt_tz.utc)
        Claim.objects.filter(pk=claim.pk).update(created_at=stamp, updated_at=stamp)
        path = _dump()
        before = {m: m.objects.count() for m in (User, Claim, PaidLedger, Publication, Authorship)}
        admin, default = _empty_install()
        out = restore.execute(path, admin.id)
        self.assertTrue(out["ok"])
        for m, n in before.items():
            self.assertEqual(m.objects.count(), n + (1 if m is User else 0), m.__name__)
        restored = Claim.objects.get(pk=claim.pk)
        self.assertEqual(restored.owner_id, owner.pk)
        self.assertEqual(restored.created_at, stamp)       # auto_now_add did not run
        self.assertEqual(restored.updated_at, stamp)
        self.assertEqual(list(Publication.objects.get(pk=pub.pk).claims.values_list("pk", flat=True)), [claim.pk])
        self.assertTrue(User.objects.get(pk=owner.pk).check_password("pw"))
        self.assertEqual(list(FormulaConfig.objects.filter(active=True).values_list("name", flat=True)), ["College policy"])
        self.assertTrue(FormulaConfig.objects.filter(pk=default.pk, active=False).exists())
        self.assertFalse(os.path.exists(path))
        run = restore.get_run()
        self.assertEqual((run["status"], run["done"]), ("done", run["total"]))
        self.assertGreaterEqual(run["links"], 1)

    def test_json_array_file_and_in_app_backup_load_too(self):
        from core.services import backup

        owner, other, claim, pub = _populate()
        data = backup.build_bytes()
        path = os.path.join(tempfile.mkdtemp(), "b.json.gz")
        with open(path, "wb") as f:
            f.write(data)
        admin, _ = _empty_install()
        restore.execute(path, admin.id)
        self.assertEqual(Claim.objects.count(), 1)
        self.assertEqual(list(Publication.objects.get(pk=pub.pk).claims.values_list("pk", flat=True)), [claim.pk])

    def test_export_without_natural_primary_keeps_ids_with_it_users_are_new_but_linked(self):
        owner, other, claim, pub = _populate()
        path = _dump(natural_primary=True)
        admin, _ = _empty_install()
        restore.execute(path, admin.id)
        self.assertEqual(Claim.objects.get(pk=claim.pk).owner.email, "o@x.edu")

    def test_a_stored_file_binary_survives(self):
        StoredFile.objects.create(name="claims/a.pdf", content=b"%PDF \x00\xff", size=7)
        path = _dump("core.storedfile")
        StoredFile.objects.all().delete()
        admin = User.objects.create_user(email="r@x.edu", password="p", name="R", role=Role.SUPER_ADMIN)
        restore.execute(path, admin.id)
        self.assertEqual(bytes(StoredFile.objects.get(name="claims/a.pdf").content), b"%PDF \x00\xff")

    def test_the_account_setup_made_is_kept_and_references_follow_it(self):
        owner, other, claim, pub = _populate()
        path = _dump()
        # The new install's first admin has the SAME email as a restored person, but another id.
        for m in (Authorship, Publication, PaidLedger, Claim, FormulaConfig, User):
            m.objects.all().delete()
        admin = User.objects.create_user(email="o@x.edu", password="newpw", name="Setup", role=Role.SUPER_ADMIN)
        self.assertNotEqual(admin.pk, owner.pk)
        restore.execute(path, admin.id)
        self.assertEqual(User.objects.filter(email="o@x.edu").count(), 1)
        self.assertTrue(User.objects.get(email="o@x.edu").check_password("newpw"))
        self.assertEqual(Claim.objects.get(pk=claim.pk).owner_id, admin.pk)
        self.assertEqual(restore.get_run()["kept_existing"], 1)

    def test_a_reference_to_a_later_row_is_filled_in_at_the_end(self):
        admin = User.objects.create_user(email="r@x.edu", password="p", name="R", role=Role.SUPER_ADMIN)
        lines = [
            json.dumps({"model": "core.thread", "pk": "t1", "fields": {"title": "T", "created_at": "2025-01-01T00:00:00Z",
                                                                          "last_post_at": "2025-01-01T00:00:00Z"}}),
            json.dumps({"model": "core.post", "pk": "p1", "fields": {"thread": "t1", "body": "a", "reply_to": "p2",
                                                                       "created_at": "2025-01-01T00:00:00Z"}}),
            json.dumps({"model": "core.post", "pk": "p2", "fields": {"thread": "t1", "body": "b", "reply_to": None,
                                                                       "created_at": "2025-01-01T00:00:01Z"}}),
        ]
        with mock.patch.object(restore, "BATCH", 1):
            restore.execute(_write(lines), admin.id)
        self.assertEqual(Post.objects.get(pk="p1").reply_to_id, "p2")
        self.assertEqual(restore.get_run()["fixups"], [])

    def test_a_required_reference_to_nothing_is_a_clear_failure(self):
        admin = User.objects.create_user(email="r@x.edu", password="p", name="R", role=Role.SUPER_ADMIN)
        lines = [json.dumps({"model": "core.post", "pk": "p1", "fields": {"thread": "gone", "body": "a"}})]
        with self.assertRaises(restore.RestoreError):
            restore.execute(_write(lines), admin.id)
        run = restore.get_run()
        self.assertEqual(run["status"], "failed")
        self.assertIn("gone", run["error"])

    def test_metrics_of_users_the_file_does_not_hold_are_dropped_and_counted(self):
        admin = User.objects.create_user(email="r@x.edu", password="p", name="R", role=Role.SUPER_ADMIN)
        lines = [json.dumps({"model": "core.publicationmetrics", "pk": "0" * 32,
                             "fields": {"total_publications": 1}})]
        restore.execute(_write(lines), admin.id)
        self.assertEqual(PublicationMetrics.objects.count(), 0)
        self.assertEqual(restore.get_run()["dropped"], {"core.publicationmetrics": 1})

    def test_unfiltered_dumps_do_not_trip_over_content_types(self):
        admin = User.objects.create_user(email="r@x.edu", password="p", name="R", role=Role.SUPER_ADMIN)
        lines = [json.dumps({"model": "contenttypes.contenttype", "pk": 1, "fields": {"app_label": "x", "model": "y"}}),
                 json.dumps({"model": "sessions.session", "pk": "a", "fields": {}})]
        out = restore.execute(_write(lines), admin.id)
        self.assertTrue(out["ok"])


class ResumeTests(TestCase):
    def setUp(self):
        _populate()
        self.path = _dump()
        self.copy = os.path.join(tempfile.mkdtemp(), "copy.jsonl.gz")
        with open(self.path, "rb") as a, open(self.copy, "wb") as b:
            b.write(a.read())
        self.admin, _ = _empty_install()
        self.queued = []
        patcher = mock.patch.object(restore, "queue_next", lambda p, a: self.queued.append((p, a)) or "job")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_job_out_of_time_saves_its_place_and_queues_itself(self):
        with mock.patch.object(restore, "BATCH", 2):
            out = restore.execute(self.path, self.admin.id, budget=0)
        self.assertTrue(out["continued"])
        self.assertEqual(self.queued, [(self.path, self.admin.id)])
        run = restore.get_run()
        self.assertEqual(run["status"], "queued")
        self.assertTrue(0 < run["done"] < run["total"])
        self.assertEqual(Authorship.objects.count() + Claim.objects.count() + Publication.objects.count()
                         + PaidLedger.objects.count() + FormulaConfig.objects.count() - 1 + User.objects.count() - 1,
                         run["loaded"])
        # the next job carries on
        with mock.patch.object(restore, "BATCH", 2):
            while True:
                out = restore.execute(self.path, self.admin.id, budget=0)
                if not out.get("continued"):
                    break
        self.assertTrue(out["ok"])
        self.assertEqual(Authorship.objects.count(), 5)
        self.assertEqual(Claim.objects.count(), 1)
        self.assertEqual(restore.get_run()["status"], "done")
        self.assertGreater(restore.get_run()["chain"], 1)

    def test_a_crash_resumes_from_the_last_whole_batch_without_repeating_rows(self):
        real = restore.Loader._insert_batch
        calls = []

        def flaky(loader, info, objs, last):
            calls.append(info.label)
            if len(calls) == 4:
                raise RuntimeError("the host was restarted")
            return real(loader, info, objs, last)

        with mock.patch.object(restore, "BATCH", 2), mock.patch.object(restore.Loader, "_insert_batch", flaky):
            with self.assertRaises(RuntimeError):
                restore.execute(self.path, self.admin.id)
        run = restore.get_run()
        self.assertEqual(run["status"], "failed")
        done = run["done"]
        self.assertGreater(done, 0)
        counts = {m: m.objects.count() for m in (Authorship, Claim, User)}
        with mock.patch.object(restore, "BATCH", 2):
            out = restore.execute(self.path, self.admin.id)
        self.assertTrue(out["ok"])
        self.assertEqual(Authorship.objects.count(), 5)
        self.assertEqual(Claim.objects.count(), 1)
        self.assertGreaterEqual(Authorship.objects.count(), counts[Authorship])
        # objects before the checkpoint were not read again: nothing was loaded twice
        wanted = sum(1 for _, o, _ in restore.iter_objects(self.copy) if restore.Loader(restore.new_run("", "", 0, "", None)).info(o["model"]))
        self.assertEqual(restore.get_run()["loaded"], wanted)

    def test_rows_already_there_do_not_stop_a_resume(self):
        # the checkpoint is lost (e.g. restored from an old copy): rows are found, not duplicated
        restore.execute(self.path, self.admin.id)
        SystemSetting.objects.filter(key=restore.KEY).delete()
        _again = os.path.join(tempfile.mkdtemp(), "again.jsonl.gz")
        with open(self.copy, "rb") as a, open(_again, "wb") as b:
            b.write(a.read())
        out = restore.execute(_again, self.admin.id)
        self.assertTrue(out["ok"])
        self.assertEqual(Authorship.objects.count(), 5)
        self.assertEqual(Claim.objects.count(), 1)

    def test_finished_file_is_not_loaded_again(self):
        restore.execute(self.path, self.admin.id)
        self.assertEqual(restore.execute(self.copy, self.admin.id), {"ok": True, "already": True})

    def test_a_live_run_is_not_started_twice(self):
        run = restore.new_run(*restore.fingerprint(self.path), "p", self.path, self.admin.id)
        run["status"] = "running"
        restore.save_run(run)
        self.assertEqual(restore.execute(self.path, self.admin.id), {"ok": False, "busy": True})
        run = restore.get_run()
        run["updated_at"] = "2000-01-01T00:00:00+00:00"
        SystemSetting.objects.filter(key=restore.KEY).update(value=run)
        self.assertTrue(restore.execute(self.path, self.admin.id)["ok"])   # a dead one is taken over

    def test_progress_is_readable_while_it_runs(self):
        seen = []
        real = restore.save_run

        def spy(run):
            seen.append(restore.public(dict(run)))
            return real(run)

        with mock.patch.object(restore, "BATCH", 2), mock.patch.object(restore, "save_run", spy):
            restore.execute(self.path, self.admin.id)
        mid = [p for p in seen if p["phase"] == "load" and p["done"]]
        self.assertTrue(mid)
        self.assertTrue(all(p["total"] and 0 <= p["percent"] <= 100 for p in mid))
        self.assertTrue(any(p["model"] for p in mid))
        self.assertEqual(restore.public(restore.get_run())["percent"], 100)
        self.assertNotIn("saved_path", restore.public(restore.get_run()))


@override_settings(MEDIA_ROOT=tempfile.mkdtemp())
class EndpointTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        self.c = Client()
        self.c.force_login(self.admin)
        p = mock.patch("django_q.tasks.async_task", return_value="job-1")
        self.async_task = p.start()
        self.addCleanup(p.stop)

    def _post(self, body=b'{"model": "core.badge", "pk": 1, "fields": {}}\n', name="d.jsonl", confirm="RESTORE"):
        return self.c.post("/api/admin/restore", {"file": ContentFile(body, name=name), "confirm": confirm})

    def test_jsonl_and_jsonl_gz_are_accepted_and_queued(self):
        for name, body in (("d.jsonl", b'{"model": "core.badge", "pk": 1, "fields": {}}\n'),
                           ("d.jsonl.gz", gzip.compress(b'{"model": "core.badge", "pk": 1, "fields": {}}\n'))):
            SystemSetting.objects.filter(key=restore.KEY).delete()
            r = self._post(body, name)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()["job_id"], "job-1")
            run = restore.get_run()
            self.assertEqual(run["sha"], hashlib.sha256(body).hexdigest())
            self.assertEqual(run["status"], "queued")
            self.assertTrue(os.path.exists(run["saved_path"]))
        self.assertEqual(self.async_task.call_args[0][0], "core.tasks.run_restore")

    def test_other_extensions_and_non_json_are_refused(self):
        self.assertEqual(self._post(name="d.csv").status_code, 400)
        self.assertEqual(self._post(b"hello", "d.jsonl").status_code, 400)
        self.assertEqual(self._post(b"not gzip", "d.jsonl.gz").status_code, 400)
        self.assertFalse(SystemSetting.objects.filter(key=restore.KEY).exists())

    def test_guards(self):
        faculty = User.objects.create_user(email="f@x.edu", password="p", name="F", role=Role.FACULTY)
        other = Client()
        other.force_login(faculty)
        r = other.post("/api/admin/restore", {"file": ContentFile(b"{}", name="d.jsonl"), "confirm": "RESTORE"})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(other.get("/api/admin/restore/status").status_code, 403)
        self.assertEqual(self._post(confirm="").status_code, 400)

    def test_claims_block_a_new_file_but_not_the_same_unfinished_one(self):
        Claim.objects.create(owner=self.admin, status=ClaimStatus.SUBMITTED, paper_title="x")
        self.assertEqual(self._post().status_code, 409)           # no restore in progress: a plain refusal
        body = b'{"model": "core.badge", "pk": 1, "fields": {}}\n'
        run = restore.new_run(hashlib.sha256(body).hexdigest(), "d.jsonl", len(body), "/gone", self.admin.id)
        run.update(status="failed", done=50, phase="load")
        restore.save_run(run)
        r = self._post(body)                                       # the same file: continue
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["resumed"])
        self.assertEqual(restore.get_run()["done"], 50)            # the checkpoint was kept
        self.assertEqual(self._post(b'{"model": "core.badge", "pk": 2, "fields": {}}\n').status_code, 409)

    def test_a_restore_that_finished_cannot_be_run_again(self):
        body = b'{"model": "core.badge", "pk": 1, "fields": {}}\n'
        run = restore.new_run(hashlib.sha256(body).hexdigest(), "d.jsonl", len(body), "/gone", None)
        run["status"] = "done"
        restore.save_run(run)
        self.assertEqual(self._post(body).status_code, 409)

    def test_a_running_restore_is_not_doubled(self):
        body = b'{"model": "core.badge", "pk": 1, "fields": {}}\n'
        run = restore.new_run(hashlib.sha256(body).hexdigest(), "d.jsonl", len(body), "/gone", None)
        run["status"] = "running"
        restore.save_run(run)
        self.assertEqual(self._post(body).status_code, 409)

    def test_the_90_mb_cap_still_holds_and_is_enough_for_the_real_export(self):
        from core.api import restore as api_restore

        self.assertEqual(api_restore.MAX_BYTES, 90 * 1024 * 1024)
        self.assertGreater(api_restore.MAX_BYTES, 28.5 * 1024 * 1024 * 3)   # the real export, gzipped, three times over
        with mock.patch.object(api_restore, "MAX_BYTES", 10):
            self.assertEqual(self._post(b"x" * 100).status_code, 400)

    def test_status_and_resume_endpoints(self):
        self.assertEqual(self.c.get("/api/admin/restore/status").json(), {"run": None})
        self.assertEqual(self.c.post("/api/admin/restore/resume").status_code, 404)
        path = os.path.join(tempfile.mkdtemp(), "kept.jsonl")
        open(path, "w").write("{}\n")
        run = restore.new_run("a" * 64, "d.jsonl", 3, path, self.admin.id)
        run.update(status="failed", done=10, total=40, phase="load", model="core.claim", error="boom")
        restore.save_run(run)
        st = self.c.get("/api/admin/restore/status").json()["run"]
        self.assertEqual((st["status"], st["done"], st["total"], st["percent"], st["file_kept"], st["error"]),
                         ("failed", 10, 40, 25, True, "boom"))
        self.assertNotIn("saved_path", st)
        r = self.c.post("/api/admin/restore/resume")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.async_task.call_args[0][1], path)
        self.assertEqual(restore.get_run()["status"], "queued")
        self.assertEqual(self.c.post("/api/admin/restore/resume").status_code, 409)   # now live
        os.remove(path)
        run = restore.get_run()
        run["status"] = "failed"
        restore.save_run(run)
        self.assertEqual(self.c.post("/api/admin/restore/resume").status_code, 410)    # file gone: upload again
