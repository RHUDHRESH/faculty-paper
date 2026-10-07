"""Slice B: ERP-imported claims closed as handled in the old system, and the
office homes counting only what somebody can act on now."""
import io
import json
from datetime import timedelta

from django.core.cache import cache
from django.core.management import call_command
from django.test import Client, TestCase
from django.utils import timezone

from core.api.operations import _faults_now
from core.api.research_cell import clearing_report
from core.models import AuditLog, Claim, ClaimFlag, ClaimStatus, DuplicateFinding, Role, User
from core.visibility import ERP_CLOSED_NOTE, ERP_CLOSED_STAGE, faculty_stage


def make(role, n):
    return User.objects.create_user(
        email=f"b{n}@x.edu", password="p", name=f"Person {n}", role=role, department="CSE"
    )


class CloseErpImported(TestCase):
    def setUp(self):
        self.faculty = make(Role.FACULTY, 1)
        old = timezone.now() - timedelta(days=90)
        mk = lambda t, s: Claim.objects.create(
            owner=self.faculty, status=s, ticket_number=t, paper_title=t, submitted_at=old
        )
        self.raw = [mk("ERP-RAW-1", ClaimStatus.SUBMITTED), mk("ERP-RAW-2", ClaimStatus.SUBMITTED)]
        self.raw_paid = mk("ERP-RAW-3", ClaimStatus.PAID)
        self.processed = mk("ERP-PROCESSED-4", ClaimStatus.SUBMITTED)
        self.app = mk("SIMATS-2026-0001", ClaimStatus.SUBMITTED)

    def _run(self, *args):
        out = io.StringIO()
        call_command("close_erp_imported", *args, stdout=out)
        return out.getvalue()

    def test_dry_run_changes_nothing(self):
        out = self._run()
        self.assertIn("ERP-RAW-1", out)
        self.assertIn("Dry run", out)
        self.assertEqual(Claim.objects.filter(status=ClaimStatus.REJECTED).count(), 0)
        self.assertFalse(AuditLog.objects.filter(action="CLAIM_CLOSED_OLD_SYSTEM").exists())

    def test_apply_closes_only_waiting_erp_raw_claims(self):
        out = self._run("--apply")
        self.assertIn("Closed 2 claim(s)", out)
        for c in self.raw:
            c.refresh_from_db()
            self.assertEqual(c.status, ClaimStatus.REJECTED)
            self.assertTrue(c.rejected_outright)
            self.assertEqual(c.status_note, ERP_CLOSED_NOTE)
        for c, st in ((self.raw_paid, ClaimStatus.PAID), (self.processed, ClaimStatus.SUBMITTED),
                      (self.app, ClaimStatus.SUBMITTED)):
            c.refresh_from_db()
            self.assertEqual(c.status, st, c.ticket_number)
        logs = AuditLog.objects.filter(action="CLAIM_CLOSED_OLD_SYSTEM")
        self.assertEqual({l.entity_id for l in logs}, {c.id for c in self.raw})
        self.assertEqual(json.loads(logs[0].detail_json)["note"], ERP_CLOSED_NOTE)
        # Run again: nothing left to close.
        self.assertIn("No ERP-imported claims are waiting", self._run("--apply"))

    def test_the_claimant_reads_closed_old_system(self):
        self._run("--apply")
        c = Claim.objects.get(pk=self.raw[0].pk)
        self.assertEqual(
            faculty_stage(c.status, rejected_outright=c.rejected_outright,
                          ticket_number=c.ticket_number, status_note=c.status_note),
            ERP_CLOSED_STAGE,
        )
        # A real refusal still reads as one.
        self.assertEqual(faculty_stage(ClaimStatus.REJECTED, rejected_outright=True), "Not accepted")

    def test_the_monthly_report_counts_no_refusals(self):
        self._run("--apply")
        month = clearing_report(None)
        self.assertEqual(month["not_accepted"], 0)
        self.assertEqual(month["sent_back"], 0)
        self.assertEqual(month["decided"], 0)
        self.assertEqual(month["waiting_now"], 2)  # ERP-PROCESSED-4 and the app claim


class LegacyCounts(TestCase):
    def setUp(self):
        cache.clear()
        self.faculty = make(Role.FACULTY, 1)
        self.paid_erp = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.PAID, ticket_number="ERP-PROCESSED-1",
            paper_title="Old", remuneration=1000, override_duplicate=True,
        )
        self.live = Claim.objects.create(
            owner=self.faculty, status=ClaimStatus.CLEARED, ticket_number="SIMATS-1",
            paper_title="New", remuneration=1000, override_duplicate=True,
        )

    def test_faults_on_paid_erp_claims_are_counted_apart_and_still_listed(self):
        body = _faults_now()
        f = {x["key"]: x for g in body["groups"] for x in g["faults"]}["duplicate_override"]
        self.assertEqual((f["count"], f["legacy"], f["actionable"]), (2, 1, 1))
        self.assertEqual(body["total"] - body["legacy"], body["actionable"])
        self.assertGreaterEqual(body["legacy"], 1)
        admin = make(Role.SUPER_ADMIN, 2)
        cl = Client()
        cl.force_login(admin)
        items = cl.get("/api/admin/faults/duplicate_override").json()
        self.assertEqual(items["total"], 2)
        att = {i["key"]: i for i in cl.get("/api/admin/attention").json()["items"]}
        self.assertEqual(att["fault_duplicate_override"]["count"], 1)
        self.assertEqual(att["fault_duplicate_override"]["legacy"], 1)

    def test_flags_on_paid_claims_are_legacy_and_new_ones_actionable(self):
        from core.services import legacy

        ClaimFlag.objects.create(claim=self.paid_erp, kind="OTHER", note="old")
        ClaimFlag.objects.create(claim=self.live, kind="OTHER", note="new")
        open_ = ClaimFlag.objects.filter(resolved_at__isnull=True)
        self.assertEqual(open_.filter(legacy.claim_q("claim__")).count(), 1)
        self.assertEqual(open_.exclude(legacy.claim_q("claim__")).get().claim_id, self.live.id)
        # Nothing is resolved on the way.
        self.assertEqual(open_.count(), 2)

    def test_duplicate_findings_only_among_erp_payments_are_legacy(self):
        from core.services import legacy

        DuplicateFinding.objects.create(
            kind="SAME_PERSON", match_key="a", rows_json=json.dumps([
                {"source": "prior", "reference": "X1"}, {"source": "claim", "reference": "ERP-PROCESSED-1"}]),
        )
        DuplicateFinding.objects.create(
            kind="SAME_PERSON", match_key="b", rows_json=json.dumps([
                {"source": "claim", "reference": "ERP-PROCESSED-1"}, {"source": "claim", "reference": "SIMATS-1"}]),
        )
        self.assertEqual(legacy.open_duplicates_split(), (1, 1))
