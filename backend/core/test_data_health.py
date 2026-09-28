"""Data health: the integrity audit, its fixes, write validation, the
constraints of migration 0062, and backup -> restore."""
import gzip
import importlib
import json
import os
import tempfile
from datetime import date
from unittest import mock

from django.db import IntegrityError, transaction
from django.test import Client, TestCase

from core.models import (
    AuditLog, Authorship, Budget, Claim, ClaimStatus, FormulaConfig, Notification, PaidLedger,
    Publication, Role, StoredFile, User,
)
from core.services import backup, integrity, validation


def _finding(report, key):
    return next(f for f in report["findings"] if f["key"] == key)


class AuditTests(TestCase):
    def setUp(self):
        self.a = User.objects.create_user(email="a@x.edu", password="p", name="A", staff_id="S1", biometric_id="B1")
        self.b = User.objects.create_user(email="b@x.edu", password="p", name="B", staff_id="S2", biometric_id="B1")

    def test_a_clean_database_has_no_errors(self):
        User.objects.filter(pk=self.b.pk).update(biometric_id="B2")
        report = integrity.run_audit()
        self.assertEqual(report["problems"]["error"], 0, [f for f in report["findings"] if f["count"] and f["severity"] == "error"])

    def test_it_finds_what_contradicts_itself(self):
        paid = Claim.objects.create(owner=self.a, status=ClaimStatus.PAID, paper_title="No ledger", remuneration=5000)
        off = Claim.objects.create(owner=self.a, status=ClaimStatus.PAID, paper_title="Off", remuneration=5000)
        PaidLedger.objects.create(claim=off, payout_month=date(2025, 1, 1), amount=4000, staff_id="S1")
        PaidLedger.objects.create(payout_month=date(2025, 1, 1), amount=100, staff_id="NOBODY")
        Publication.objects.create(title="", year=None)
        Publication.objects.create(title="One", year=2020, doi="10.1/dup")
        Publication.objects.create(title="Two", year=2020, doi="10.1/dup")
        Notification.objects.create(user=self.a, title="gone", claim_id="doesnotexist")
        self.b.active = False
        self.b.save()
        Claim.objects.create(owner=self.b, status=ClaimStatus.SUBMITTED, paper_title="Orphaned")

        report = integrity.run_audit()
        self.assertEqual(_finding(report, "dup_biometric_id")["count"], 1)
        self.assertEqual(_finding(report, "paid_without_ledger")["count"], 1)
        self.assertEqual(_finding(report, "paid_without_ledger")["rows"][0]["id"], paid.pk)
        self.assertEqual(_finding(report, "ledger_amount_mismatch")["count"], 1)
        self.assertEqual(_finding(report, "ledger_unlinked_person")["count"], 1)
        self.assertEqual(_finding(report, "pub_missing_title_year")["count"], 1)
        self.assertEqual(_finding(report, "pub_duplicate_doi")["count"], 1)
        self.assertEqual(_finding(report, "notification_dangling_claim")["count"], 1)
        self.assertEqual(_finding(report, "claim_owner_inactive")["count"], 1)

    def test_fixes_change_only_what_they_name_and_are_audited(self):
        Notification.objects.create(user=self.a, title="gone", claim_id="doesnotexist")
        keep = Notification.objects.create(user=self.a, title="kept")
        n = integrity.apply_fix("delete_dangling_notifications", self.a)
        self.assertEqual(n, 1)
        self.assertTrue(Notification.objects.filter(pk=keep.pk).exists())
        self.assertTrue(AuditLog.objects.filter(action="DATA_HEALTH_FIX", entity_id="delete_dangling_notifications").exists())

    def test_normalise_dois_fix(self):
        p = Publication.objects.create(title="T", year=2020)
        Publication.objects.filter(pk=p.pk).update(doi="https://doi.org/10.1/ABC")  # bypasses save-time tidy
        self.assertEqual(_finding(integrity.run_audit(), "doi_not_normalised")["count"], 1)
        integrity.apply_fix("normalise_dois", None)
        p.refresh_from_db()
        self.assertEqual(p.doi, "10.1/abc")


class DataHealthApiTests(TestCase):
    def setUp(self):
        self.sa = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        self.cell = User.objects.create_user(email="rc@x.edu", password="p", name="RC", role=Role.RESEARCH_CELL)
        self.c = Client()

    def test_super_admin_only(self):
        self.c.force_login(self.cell)
        self.assertEqual(self.c.get("/api/admin/data-health").status_code, 403)
        self.assertEqual(self.c.get("/api/admin/backups").status_code, 403)
        self.c.force_login(self.sa)
        r = self.c.get("/api/admin/data-health?fresh=true")
        self.assertEqual(r.status_code, 200)
        self.assertIn("findings", r.json()["report"])
        # Stored for the next plain GET.
        self.assertIsNotNone(self.c.get("/api/admin/data-health").json()["report"])

    def test_fix_endpoint(self):
        self.c.force_login(self.sa)
        self.assertEqual(self.c.post("/api/admin/data-health/fix/nope").status_code, 404)
        r = self.c.post("/api/admin/data-health/fix/recount_threads")
        self.assertEqual(r.status_code, 200)

    def test_stored_backup_downloads(self):
        self.c.force_login(self.sa)
        out = backup.store_weekly("manual")
        self.assertTrue(out["ok"])
        listed = self.c.get("/api/admin/backups").json()["backups"]
        self.assertEqual(listed[0]["name"], out["name"])
        r = self.c.get(f"/api/admin/backups/download?name={out['name']}")
        self.assertEqual(r.status_code, 200)
        self.assertGreater(backup.verify(b"".join(r.streaming_content)), 0)
        self.assertEqual(self.c.get("/api/admin/backups/download?name=claims/x.pdf").status_code, 404)


class ValidationTests(TestCase):
    def setUp(self):
        self.sa = User.objects.create_user(email="sa@x.edu", password="p", name="SA", role=Role.SUPER_ADMIN)
        self.me = User.objects.create_user(email="f@x.edu", password="p", name="F", role=Role.FACULTY)
        self.c = Client()

    def test_normalised_on_save(self):
        u = User.objects.create_user(email="Mixed.Case@X.EDU ", password="p", name="M", staff_id=" S9 ",
                                     scopus_author_id="57193456789.0")
        u.refresh_from_db()
        self.assertEqual((u.email, u.staff_id, u.scopus_author_id), ("mixed.case@x.edu", "S9", "57193456789"))
        c = Claim.objects.create(owner=u, doi=" https://doi.org/10.1016/J.X ", issn="2728842")
        c.refresh_from_db()
        self.assertEqual((c.doi, c.issn), ("10.1016/j.x", "0272-8842"))

    def test_claim_filing_refuses_malformed_identifiers(self):
        self.c.force_login(self.me)
        r = self.c.post("/api/claims", {"paper_title": "X", "doi": "not a doi"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("DOI", r.json()["detail"])
        r = self.c.post("/api/claims", {"paper_title": "X", "issn": "12345"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        r = self.c.post("/api/claims", {"paper_title": "X", "total_authors": 2, "author_position": 3},
                        content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("past the 2 authors", r.json()["detail"])

    def test_account_edit_refuses_bad_ids(self):
        self.c.force_login(self.sa)
        r = self.c.patch(f"/api/admin/users/{self.me.pk}", {"scopus_author_id": "abc"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        r = self.c.patch(f"/api/admin/users/{self.me.pk}", {"staff_id": "S 1 !"}, content_type="application/json")
        self.assertEqual(r.status_code, 400)
        r = self.c.patch(f"/api/admin/users/{self.me.pk}", {"staff_id": "TSEC-153"}, content_type="application/json")
        self.assertEqual(r.status_code, 200)

    def test_checks(self):
        validation.check_orcid("0000-0002-1825-0097")
        with self.assertRaises(validation.FieldProblem):
            validation.check_orcid("0000-0002-1825-0098")
        with self.assertRaises(validation.FieldProblem):
            validation.check_year("publication_year", 1800)
        with self.assertRaises(validation.FieldProblem):
            validation.check_amount("x", -1)
        validation.check_eid("2-s2.0-85123456789")


class ConstraintTests(TestCase):
    def test_database_refuses_impossible_rows(self):
        u = User.objects.create_user(email="a@x.edu", password="p", name="A", staff_id="S1")
        cases = [
            lambda: User.objects.filter(pk=User.objects.create_user(email="b@x.edu", password="p", name="B").pk).update(email="A@X.EDU"),
            lambda: User.objects.create_user(email="c@x.edu", password="p", name="C", staff_id="S1"),
            lambda: Claim.objects.create(owner=u, remuneration=-1),
            lambda: Claim.objects.create(owner=u, total_authors=0),
            lambda: Budget.objects.create(financial_year="2030-2031", amount=-1),
            lambda: [FormulaConfig.objects.create(author_point_json="{}", active=True) for _ in range(2)],
        ]
        for case in cases:
            with self.assertRaises(IntegrityError):
                with transaction.atomic():
                    case()
        # Blank staff ids are not duplicates of each other.
        User.objects.create_user(email="d@x.edu", password="p", name="D", staff_id="")
        User.objects.create_user(email="e@x.edu", password="p", name="E", staff_id="")

    def test_migration_skips_a_constraint_the_data_violates(self):
        mig = importlib.import_module("core.migrations.0062_integrity_constraints")
        _, constraint, _ = mig.CONSTRAINTS[2]
        forwards, _ = mig._adder("budget", constraint, lambda apps: 3)
        editor = mock.Mock()
        forwards(mock.Mock(), editor)
        editor.add_constraint.assert_not_called()
        self.assertIn(constraint.name, mig.SKIPPED)
        mig.SKIPPED.discard(constraint.name)


class BackupRoundTripTests(TestCase):
    def test_backup_restores_into_an_empty_installation(self):
        from core.tasks import run_restore

        owner = User.objects.create_user(email="o@x.edu", password="p", name="Owner", staff_id="S1")
        claim = Claim.objects.create(owner=owner, status=ClaimStatus.PAID, paper_title="Paper", remuneration=5000,
                                     doi="10.1/x")
        PaidLedger.objects.create(claim=claim, payout_month=date(2025, 1, 1), amount=5000, staff_id="S1")
        pub = Publication.objects.create(title="Paper", year=2024, doi="10.1/x")
        pub.claims.add(claim)
        Authorship.objects.create(publication=pub, user=owner, display_name="Owner", author_key="u:1", position=1)
        StoredFile.objects.create(name="claims/a.pdf", content=b"%PDF-1.4 \x00\xff", size=11)
        StoredFile.objects.create(name="backups/old.json.gz", content=b"x", size=1)
        owner.user_permissions.add(*__import__("django.contrib.auth.models", fromlist=["Permission"]).Permission.objects.all()[:2])

        data = backup.build_bytes()
        objects = json.loads(gzip.decompress(data))
        self.assertFalse(any(o["model"] in ("sessions.session", "contenttypes.contenttype", "auth.permission") for o in objects))
        self.assertFalse(any(o["fields"].get("name", "").startswith("backups/") for o in objects if o["model"] == "core.storedfile"))

        # An empty installation.
        for m in (Authorship, Publication, PaidLedger, Claim, StoredFile, User):
            m.objects.all().delete()

        path = os.path.join(tempfile.mkdtemp(), "b.json.gz")
        with open(path, "wb") as f:
            f.write(data)
        out = run_restore(path)
        self.assertEqual((out["users"], out["claims"], out["ledger_rows"]), (1, 1, 1))
        restored = Claim.objects.get(pk=claim.pk)
        self.assertEqual(restored.owner_id, owner.pk)
        self.assertEqual(list(Publication.objects.get(pk=pub.pk).claims.values_list("pk", flat=True)), [claim.pk])
        self.assertEqual(bytes(StoredFile.objects.get(name="claims/a.pdf").content), b"%PDF-1.4 \x00\xff")
        self.assertEqual(User.objects.get(pk=owner.pk).user_permissions.count(), 2)
        self.assertTrue(User.objects.get(pk=owner.pk).check_password("p"))

    def test_weekly_keeps_the_newest_four(self):
        for _ in range(6):
            backup.store_weekly()
        self.assertEqual(StoredFile.objects.filter(name__startswith="backups/").count(), backup.KEEP)
