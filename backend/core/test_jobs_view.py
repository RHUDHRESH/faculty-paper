"""The super admin's Jobs view: recent and failed django-q2 jobs, and a
retry only where running the job again is harmless."""
from __future__ import annotations

from datetime import timedelta
from unittest import mock

from django.test import Client, TestCase
from django.utils import timezone
from django_q.models import Task as QTask

from core.models import AuditLog, Role, User


def _task(id_, func, success, result=None, args=()):
    now = timezone.now()
    return QTask.objects.create(
        id=id_, name=id_, func=func, args=args, kwargs={}, result=result,
        started=now - timedelta(seconds=30), stopped=now, success=success,
    )


class JobsViewTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_user(
            email="sa@x.edu", password="p", name="Sys Admin", role=Role.SUPER_ADMIN
        )
        _task("a" * 32, "core.tasks.run_stored_backup", True, {"filename": "b.json.gz"}, ("manual",))
        _task("b" * 32, "core.tasks.harvest_publications", False,
              "Traceback (most recent call last):\n  x\nConnectionError: OpenAlex timed out")
        _task("c" * 32, "core.tasks.run_restore", False, "boom")
        self.c = Client()
        self.c.force_login(self.admin)

    def test_lists_named_jobs_with_duration_and_result(self):
        d = self.c.get("/api/admin/jobs").json()
        self.assertEqual(d["failed_count"], 2)
        by = {j["func"]: j for j in d["jobs"]}
        self.assertEqual(by["core.tasks.run_stored_backup"]["name"], "Backup")
        self.assertEqual(by["core.tasks.run_stored_backup"]["duration_s"], 30.0)
        self.assertEqual(by["core.tasks.harvest_publications"]["result"],
                         "ConnectionError: OpenAlex timed out")
        self.assertTrue(by["core.tasks.harvest_publications"]["retry_safe"])
        self.assertFalse(by["core.tasks.run_restore"]["retry_safe"])

    def test_running_tasks_are_split_from_queued(self):
        from django_q.models import OrmQ
        from django_q.signing import SignedPackage

        now = timezone.now()
        for tid, func, lock in (("r" * 32, "core.tasks.run_scout", now + timedelta(seconds=60)),
                                ("q" * 32, "core.tasks.run_stored_backup", now - timedelta(seconds=5))):
            OrmQ.objects.create(key="default", lock=lock,
                                payload=SignedPackage.dumps({"id": tid, "name": tid, "func": func}))
        d = self.c.get("/api/admin/jobs").json()
        self.assertEqual([r["name"] for r in d["running"]], ["Research scout"])
        self.assertIn("running_s", d["running"][0])
        self.assertEqual([q["name"] for q in d["queued"]], ["Backup"])

    def test_failed_filter(self):
        d = self.c.get("/api/admin/jobs?failed=true").json()
        self.assertEqual(len(d["jobs"]), 2)
        self.assertTrue(all(not j["success"] for j in d["jobs"]))

    def test_retry_safe_job_requeues_with_same_args_and_audits(self):
        with mock.patch("django_q.tasks.async_task", return_value="new-id") as m:
            r = self.c.post(f"/api/admin/jobs/{'a' * 32}/retry")
        self.assertEqual(r.status_code, 200, r.content)
        m.assert_called_once_with("core.tasks.run_stored_backup", "manual")
        self.assertTrue(AuditLog.objects.filter(action="JOB_RETRY", entity_id="new-id").exists())

    def test_restore_is_never_retried(self):
        r = self.c.post(f"/api/admin/jobs/{'c' * 32}/retry")
        self.assertEqual(r.status_code, 400)

    def test_only_super_admin(self):
        u = User.objects.create_user(email="rc@x.edu", password=None, name="RC", role=Role.RESEARCH_CELL)
        c = Client()
        c.force_login(u)
        self.assertEqual(c.get("/api/admin/jobs").status_code, 403)
        self.assertEqual(c.post(f"/api/admin/jobs/{'a' * 32}/retry").status_code, 403)
