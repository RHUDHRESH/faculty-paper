"""The daily check, the audit trail, the bank file, the migration and the imports.

One class per risk in docs/ops/safeguards.md that is not about one request:
the check that recomputes the money from the rows, the audit log that cannot
be rewritten, the bank file that cannot be sent twice, a migration that must
not fail on data that is already wrong, and the importers that must not undo
any of it.
"""
from __future__ import annotations

import json
import tempfile
from datetime import date, timedelta
from io import StringIO
from unittest import skipUnless

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone

from core.models import (
    AuditLog,
    BankExport,
    Claim,
    ClaimAction,
    ClaimStatus,
    DuplicateFinding,
    ImmutableRecord,
    Notification,
    PaidLedger,
    ResearchThreshold,
    Role,
    SystemSetting,
    User,
)
from core.services import safeguards
from core.test_chain_rules import ChainBase


def drop_index(name: str) -> None:
    """Take a database safeguard away, to build the data it exists to prevent."""
    with connection.cursor() as cur:
        cur.execute(f"DROP INDEX {name}")


class SgChecks(ChainBase):
    def result(self, key):
        report = safeguards.run_audit()
        return next(c for c in report["checks"] if c["key"] == key)

    def paid(self, ticket, amount=None, ledger="match", **extra):
        # Set after creation: the fixture prices the claim and, for research
        # faculty, re-decides the threshold, which would undo what a check needs.
        post = {k: extra.pop(k) for k in ("research_absorbed",) if k in extra}
        claim = self._claim(ClaimStatus.PAID, ticket=ticket, paid_at=timezone.now(),
                            payout_month=date(2026, 9, 1), **extra)
        if amount is not None:
            post["remuneration"] = amount
        if post:
            Claim.objects.filter(pk=claim.pk).update(**post)
            claim.refresh_from_db()
        if ledger == "match":
            PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=claim.remuneration or 0)
        elif ledger is not None:
            PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=ledger)
        ClaimAction.objects.create(claim=claim, actor=self.finance, action="MARK_PAID",
                                   from_status=ClaimStatus.DIRECTOR_APPROVED, to_status=ClaimStatus.PAID)
        return claim

    def test_a_clean_database_passes_every_check(self):
        self.paid("SC-OK")
        report = safeguards.run_audit()
        self.assertEqual(report["problems"], {"error": 0, "warning": 0, "info": 0}, [
            (c["key"], c["count"]) for c in report["checks"] if c["count"]])

    def test_paid_with_no_ledger_row(self):
        self.paid("SC-NL", amount=5000, ledger=None)
        got = self.result("paid_no_ledger")
        self.assertEqual((got["count"], got["status"]), (1, "problem"))
        self.assertIn("SC-NL", got["rows"][0]["label"])
        self.assertTrue(got["rows"][0]["href"].startswith("/papers/"))
        self.assertEqual(got["fix_to"], "/ledger?problem=no-ledger")

    def test_ledger_total_different_from_the_amount(self):
        self.paid("SC-MM", amount=5000, ledger=4000)
        got = self.result("ledger_mismatch")
        self.assertEqual(got["count"], 1)
        self.assertIn("claim ₹5,000, ledger ₹4,000", got["rows"][0]["label"])

    def test_money_on_the_ledger_for_a_claim_not_paid(self):
        claim = self._claim(ClaimStatus.DIRECTOR_APPROVED, ticket="SC-LU", director_approved_at=timezone.now())
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=700)
        self.assertEqual(self.result("ledger_unpaid")["count"], 1)

    def test_a_payment_made_here_whose_claim_is_gone(self):
        claim = self._claim(ClaimStatus.PAID, ticket="SC-GONE", paid_at=timezone.now())
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=900, faculty_name="Asha")
        # Imported history has no claim and a workbook row: that is not a fault.
        PaidLedger.objects.create(payout_month=date(2025, 1, 1), amount=400, raw_json='{"Month": "2025-01"}')
        claim.delete()
        got = self.result("orphan_ledger")
        self.assertEqual(got["count"], 1)
        self.assertIn("Asha", got["rows"][0]["label"])

    def test_duplicate_live_payments_are_found_when_the_database_rule_was_bypassed(self):
        drop_index("one_payment_per_claim_cycle")
        claim = self.paid("SC-DUP", amount=5000)
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=5000)
        got = self.result("dup_payment")
        self.assertEqual((got["count"], got["status"]), (1, "problem"))
        self.assertIn("2 payments", got["rows"][0]["label"])
        # ...and the check that the rule is in the database says it is not.
        missing = self.result("db_constraints")
        self.assertEqual(missing["count"], 1)
        self.assertIn("one_payment_per_claim_cycle", missing["rows"][0]["label"])

    def test_a_void_and_a_second_payment_are_not_duplicates(self):
        claim = self.paid("SC-REPAID", amount=5000)
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=-5000, kind="REVERSAL", cycle=1)
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=5000, kind="PAYMENT", cycle=2)
        self.assertEqual(self.result("dup_payment")["count"], 0)
        self.assertEqual(self.result("ledger_mismatch")["count"], 0)

    def test_the_same_paper_filed_twice_by_one_person(self):
        drop_index("one_filed_claim_per_person_per_doi")
        self._claim(ClaimStatus.SUBMITTED, ticket="SC-F1", doi="10.1000/twice", owner=self.faculty)
        self._claim(ClaimStatus.CLEARED, ticket="SC-F2", doi="10.1000/TWICE", owner=self.faculty)
        # Imported history is left to the sweep, not this check.
        self._claim(ClaimStatus.PAID, ticket="ERP-X-1", doi="10.1000/twice", owner=self.faculty)
        got = self.result("dup_filed")
        self.assertEqual((got["count"], got["scope"]), (2, "claims"))

    def test_authorised_amount_that_no_longer_prices_the_same(self):
        claim = self._claim(ClaimStatus.DIRECTOR_APPROVED, ticket="SC-AD", director_approved_at=timezone.now())
        Claim.objects.filter(pk=claim.pk).update(authorised_amount=(claim.remuneration or 0) + 500)
        got = self.result("authorised_drift")
        self.assertEqual(got["count"], 1)
        self.assertIn("authorised", got["rows"][0]["label"])

    def test_authorised_claim_of_a_person_who_has_left(self):
        claim = self._claim(ClaimStatus.DIRECTOR_APPROVED, ticket="SC-IN", director_approved_at=timezone.now())
        User.objects.filter(pk=claim.owner_id).update(active=False)
        self.assertEqual(self.result("payable_inactive")["count"], 1)

    def test_paid_by_the_person_who_authorised_it(self):
        claim = self.paid("SC-SP", amount=5000, director_approved_by=self.finance)
        self.assertEqual(self.result("self_paid")["count"], 1)
        claim.refresh_from_db()

    def test_paid_with_no_record_of_who_paid(self):
        claim = self.paid("SC-NA", amount=5000)
        ClaimAction.objects.filter(claim=claim).delete()
        self.assertEqual(self.result("paid_no_audit")["count"], 1)

    def test_a_warning_set_aside_with_no_second_approver(self):
        self._claim(ClaimStatus.PRINCIPAL_APPROVED, ticket="SC-OV", duplicate_warning=True, override_duplicate=True,
                    cleared_by=self.cell, cleared_at=timezone.now(), principal_approved_at=timezone.now())
        self.assertEqual(self.result("override_unseconded")["count"], 1)

    def test_papers_paid_twice_come_from_the_sweep(self):
        DuplicateFinding.objects.create(kind="SAME_PERSON", match_key="k", faculty_name="Asha", paper_title="A paper",
                                        rows_json="[]", payment_count=2, extra_amount=400)
        got = self.result("repeat_payments")
        self.assertEqual((got["count"], got["scope"]), (1, "claims"))
        self.assertIn("₹400 repeated", got["rows"][0]["label"])

    def test_a_month_sent_to_the_bank_twice(self):
        BankExport.objects.create(month="2026-09", created_by=self.finance, row_count=3, scope="all")
        BankExport.objects.create(month="2026-09", created_by=self.finance, row_count=3, scope="all",
                                  reason="The first file was lost in transit")
        got = self.result("bank_reexport")
        self.assertEqual(got["count"], 1)
        self.assertIn("2 files", got["rows"][0]["label"])

    def test_research_threshold_absorbed_more_than_it_allows(self):
        person = User.objects.create_user(email="rt@t.edu", password=None, name="Dr Research", role=Role.FACULTY,
                                          department="CSE", staff_id="RT1", faculty_type="RESEARCH")
        ResearchThreshold.objects.create(user=person, amount=100000, effective_from=date(2020, 1, 1))
        for n in (1, 2):
            self.paid(f"SC-RT{n}", amount=0, owner=person, doi=f"10.1000/rt{n}",
                      research_absorbed=60000, ledger=0)
        got = self.result("threshold_absorbed")
        self.assertEqual(got["count"], 1)
        self.assertIn("₹120,000 absorbed, threshold ₹100,000", got["rows"][0]["label"])

    def test_a_threshold_that_absorbed_exactly_what_it_allows_is_fine(self):
        person = User.objects.create_user(email="rt2@t.edu", password=None, name="Dr Research", role=Role.FACULTY,
                                          department="CSE", staff_id="RT2", faculty_type="RESEARCH")
        ResearchThreshold.objects.create(user=person, amount=100000, effective_from=date(2020, 1, 1))
        self.paid("SC-RT3", amount=0, owner=person, doi="10.1000/rt3", research_absorbed=100000, ledger=0)
        self.assertEqual(self.result("threshold_absorbed")["count"], 0)

    def test_one_check_that_cannot_run_does_not_hide_the_rest(self):
        from unittest.mock import patch

        self.paid("SC-NL2", amount=5000, ledger=None)
        def broken():
            raise RuntimeError("boom")

        with patch.object(safeguards, "CHECKS", [broken, safeguards.check_paying_twice]):
            report = safeguards.run_audit()
        keys = {c["key"] for c in report["checks"]}
        self.assertIn("paid_no_ledger", keys)
        self.assertTrue(any("could not run" in c["title"] for c in report["checks"]))


class TheReportAndWhoSeesIt(ChainBase):
    def get(self, who):
        return self._as(who).get("/api/safeguards")

    def test_run_now_stores_the_report_audits_it_and_tells_the_super_admins_of_new_errors(self):
        claim = self._claim(ClaimStatus.PAID, ticket="SR-1", paid_at=timezone.now())  # paid, no ledger row
        r = self._post(self.admin, "/api/safeguards/run")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertGreaterEqual(body["report"]["problems"]["error"], 1)
        self.assertEqual(SystemSetting.objects.get(key=safeguards.REPORT_KEY).value["ran_at"], body["report"]["ran_at"])
        self.assertTrue(AuditLog.objects.filter(action="SAFEGUARD_CHECK", actor=self.admin).exists())
        self.assertTrue(Notification.objects.filter(user=self.admin, title__startswith="Money safeguards").exists())
        # The same problem the next night is not announced again.
        Notification.objects.all().delete()
        self._post(self.admin, "/api/safeguards/run")
        self.assertFalse(Notification.objects.filter(title__startswith="Money safeguards").exists())
        self.assertEqual(len(self.get(self.admin).json()["report"]["history"]), 2)
        claim.refresh_from_db()

    def test_nobody_but_the_super_admin_runs_it(self):
        for who in (self.finance, self.faculty, self.cell, self.director, self.principal, self.coordinator):
            self.assertEqual(self._post(who, "/api/safeguards/run").status_code, 403, who.role)

    def test_who_may_read_it(self):
        for who, code in ((self.admin, 200), (self.finance, 200), (self.faculty, 403), (self.director, 403),
                          (self.principal, 403), (self.cell, 403), (self.hod, 403)):
            self.assertEqual(self.get(who).status_code, code, who.role)

    def test_finance_sees_the_money_checks_only_with_their_own_counts(self):
        # One money problem and two doubts about papers.
        self._claim(ClaimStatus.PAID, ticket="SR-M", paid_at=timezone.now())
        DuplicateFinding.objects.create(kind="SAME_PERSON", match_key="k", faculty_name="Asha", paper_title="A paper",
                                        rows_json="[]", payment_count=2, extra_amount=400)
        self._claim(ClaimStatus.PRINCIPAL_APPROVED, ticket="SR-W", duplicate_warning=True, override_duplicate=True,
                    cleared_by=self.cell, cleared_at=timezone.now(), principal_approved_at=timezone.now())
        self._post(self.admin, "/api/safeguards/run")
        full = self.get(self.admin).json()
        scoped = self.get(self.finance).json()
        self.assertEqual((full["scope"], scoped["scope"]), ("all", "money"))
        self.assertFalse(scoped["can_run"])
        self.assertTrue({c["scope"] for c in scoped["report"]["checks"]} <= {"money"})
        text = json.dumps(scoped).lower()
        for hidden in ("duplicate", "override", "co-author", "repeat_payments", "dup_filed", "flag"):
            self.assertNotIn(hidden, text.replace("duplicate_", "x"), hidden)
        self.assertLess(scoped["report"]["problems"]["error"], full["report"]["problems"]["error"])
        self.assertEqual(scoped["report"]["history"], [])

    def test_the_readiness_checklist_and_the_faults_screen_show_it(self):
        def item():
            by = {i["key"]: i for i in self._as(self.admin).get("/api/admin/readiness").json()["items"]}
            return by["safeguards"]

        self.assertFalse(item()["ok"])  # never run
        self._post(self.admin, "/api/safeguards/run")
        self.assertTrue(item()["ok"], item())
        self._claim(ClaimStatus.PAID, ticket="SR-F", paid_at=timezone.now())
        self._post(self.admin, "/api/safeguards/run")
        self.assertFalse(item()["ok"])
        self.assertEqual(item()["severity"], "critical")
        faults = self._as(self.admin).get("/api/admin/faults").json()
        group = next(g for g in faults["groups"] if g["key"] == "safeguards")
        self.assertIn("sg_paid_no_audit", {f["key"] for f in group["faults"] if f["count"]})
        listed = self._as(self.admin).get("/api/admin/faults/sg_paid_no_audit").json()
        self.assertEqual(listed["total"], 1)

    def test_a_daily_schedule_is_registered_and_runnable(self):
        from django_q.models import Schedule

        sched = Schedule.objects.get(name="safeguards-daily")
        self.assertEqual((sched.func, sched.schedule_type), ("core.tasks.run_safeguard_check", "D"))
        from core import tasks

        out = tasks.run_safeguard_check()
        self.assertTrue(out["ok"])
        self.assertIsNotNone(safeguards.last_report())


class TheAuditTrail(ChainBase):
    """Risk: money moved with no record, or a record rewritten afterwards."""

    def make(self):
        return AuditLog.objects.create(actor=self.admin, action="TEST", entity="Claim", entity_id="x")

    def test_an_existing_row_cannot_be_edited_or_deleted_through_the_model(self):
        row = self.make()
        row.action = "CHANGED"
        with self.assertRaises(ImmutableRecord):
            row.save()
        with self.assertRaises(ImmutableRecord):
            row.delete()
        self.assertEqual(AuditLog.objects.get(pk=row.pk).action, "TEST")

    def test_nor_through_a_queryset(self):
        self.make()
        with self.assertRaises(ImmutableRecord):
            AuditLog.objects.all().update(action="X")
        with self.assertRaises(ImmutableRecord):
            AuditLog.objects.all().delete()
        with self.assertRaises(ImmutableRecord):
            AuditLog.objects.filter(action="TEST").delete()
        self.assertEqual(AuditLog.objects.filter(action="TEST").count(), 1)

    def test_removing_a_person_still_works_and_keeps_the_row(self):
        person = User.objects.create_user(email="gone@t.edu", password=None, name="Gone", role=Role.FACULTY)
        row = AuditLog.objects.create(actor=person, action="TEST2", entity="User")
        person.delete()
        row.refresh_from_db()
        self.assertIsNone(row.actor_id)

    def test_no_api_route_edits_or_deletes_the_audit_log(self):
        from core.api import api

        paths = api.get_openapi_schema()["paths"]
        for path, methods in paths.items():
            if "audit" in path.lower():
                self.assertEqual(set(methods) - {"get"}, set(), path)

    def test_every_money_moving_action_writes_its_own_audit_row(self):
        from core.test_safeguards_pay import SgBase

        claim = SgBase._authorised(self, "SA-1")
        self.assertEqual(self._post(self.finance, f"/api/claims/{claim.id}/mark-paid",
                                    {"expected_amount": claim.remuneration}).status_code, 200)
        row = PaidLedger.objects.get(claim=claim)
        pay = AuditLog.objects.get(action="LEDGER_PAYMENT", entity_id=row.id)
        self.assertEqual(json.loads(pay.detail_json)["amount"], claim.remuneration)
        self.assertTrue(AuditLog.objects.filter(action="MARK_PAID", entity_id=claim.id).exists())
        self.assertEqual(self._post(self.admin, f"/api/claims/{claim.id}/void-payment",
                                    {"note": "Paid against the wrong voucher"}).status_code, 200)
        self.assertTrue(AuditLog.objects.filter(action="LEDGER_REVERSAL", actor=self.admin).exists())
        self.assertTrue(AuditLog.objects.filter(action="VOID_PAYMENT", entity_id=claim.id).exists())

    @skipUnless(connection.vendor == "postgresql", "the trigger is PostgreSQL only")
    def test_postgres_refuses_a_raw_update_and_delete(self):
        row = self.make()
        with self.assertRaises(DatabaseError), transaction.atomic(), connection.cursor() as cur:
            cur.execute("UPDATE core_auditlog SET action = 'X' WHERE id = %s", [row.pk])
        with self.assertRaises(DatabaseError), transaction.atomic(), connection.cursor() as cur:
            cur.execute("DELETE FROM core_auditlog WHERE id = %s", [row.pk])


class TheBankFile(ChainBase):
    """Risk: the same month's bank file generated, and sent, twice."""

    URL = "/api/payouts/statement.csv?month=2026-08"

    def setUp(self):
        super().setUp()
        self.rows = [
            PaidLedger.objects.create(payout_month=date(2026, 8, 1), amount=100 * i, department="CSE",
                                      faculty_name=f"P{i}", staff_id=f"S{i}")
            for i in (1, 2)
        ]

    def get(self, who, extra=""):
        return self._as(who).get(self.URL + extra)

    def test_the_first_file_is_plain_and_is_recorded_against_the_rows_it_carried(self):
        r = self.get(self.finance)
        self.assertEqual(r.status_code, 200, r.content)
        export = BankExport.objects.get()
        self.assertEqual((export.month, export.row_count, export.total_amount, export.created_by), ("2026-08", 2, 300, self.finance))
        self.assertEqual(PaidLedger.objects.filter(bank_export=export).count(), 2)
        self.assertEqual(len(export.sha256), 64)
        audit = AuditLog.objects.get(action="BANK_EXPORT")
        self.assertEqual(json.loads(audit.detail_json)["repeat"], False)

    def test_a_second_file_is_refused_until_the_person_says_which_one_they_want(self):
        self.get(self.finance)
        r = self.get(self.finance)
        self.assertEqual(r.status_code, 409, r.content)
        body = r.json()
        self.assertEqual(body["code"], "already_exported")
        self.assertIn("already generated", body["detail"])
        self.assertIn("August 2026", body["detail"])
        self.assertEqual((body["new_count"], body["all_count"]), (0, 2))
        self.assertEqual(BankExport.objects.count(), 1)

    def test_only_the_new_payments_can_be_downloaded_after_the_first_file(self):
        self.get(self.finance)
        self.assertEqual(self.get(self.finance, "&scope=new").status_code, 400, "nothing new to send")
        PaidLedger.objects.create(payout_month=date(2026, 8, 1), amount=777, department="CSE",
                                  faculty_name="Late", staff_id="S9")
        r = self.get(self.finance, "&scope=new")
        self.assertEqual(r.status_code, 200)
        text = r.content.decode("utf-8-sig")
        self.assertIn("Late", text)
        self.assertNotIn("P1", text)
        self.assertEqual(BankExport.objects.order_by("created_at").last().scope, "new")
        self.assertEqual(PaidLedger.objects.filter(bank_export__isnull=True).count(), 0)

    def test_the_whole_month_again_needs_a_reason_and_is_recorded_as_a_repeat(self):
        self.get(self.finance)
        self.assertEqual(self.get(self.finance, "&scope=all").status_code, 400)
        self.assertEqual(self.get(self.finance, "&scope=all&reason=short").status_code, 400)
        r = self.get(self.finance, "&scope=all&reason=The+first+file+never+reached+the+bank")
        self.assertEqual(r.status_code, 200)
        self.assertIn("P1", r.content.decode("utf-8-sig"))
        repeat = AuditLog.objects.filter(action="BANK_EXPORT").order_by("created_at").last()
        detail = json.loads(repeat.detail_json)
        self.assertTrue(detail["repeat"])
        self.assertIn("never reached the bank", detail["reason"])
        self.assertIn("-all-", r["Content-Disposition"])

    def test_the_statement_screen_can_ask_before_offering_the_file(self):
        before = self._as(self.finance).get("/api/payouts/bank-exports?month=2026-08").json()
        self.assertEqual((before["exports"], before["new_count"], before["all_count"]), ([], 2, 2))
        self.get(self.finance)
        after = self._as(self.finance).get("/api/payouts/bank-exports?month=2026-08").json()
        self.assertEqual((len(after["exports"]), after["new_count"], after["all_count"]), (1, 0, 2))
        self.assertEqual(after["exports"][0]["by"], self.finance.name)
        for who in (self.director, self.principal, self.faculty):
            self.assertEqual(self._as(who).get("/api/payouts/bank-exports?month=2026-08").status_code, 403)


class TheMigrationIsSafeOnBadData(TransactionTestCase):
    """Risk: the migration that adds the database rules fails the deploy because
    the data already breaks them."""

    BEFORE = [("core", "0074_merge_20260930_1112")]

    def migrate(self, target):
        ex = MigrationExecutor(connection)
        ex.migrate(target)
        return ex.loader.project_state(target).apps

    def tearDown(self):
        # Leave the test database exactly as the other tests expect it: every
        # rule present. Clear what the test planted, go back, go forward.
        with connection.cursor() as cur:
            for table in ("core_paidledger", "core_claimaction", "core_claim", "core_user"):
                cur.execute(f"DELETE FROM {table}")
        self.migrate(self.BEFORE)
        ex = MigrationExecutor(connection)
        ex.migrate(ex.loader.graph.leaf_nodes())
        super().tearDown()

    def test_duplicates_are_reported_not_fatal_and_old_rows_get_their_kind_and_cycle(self):
        old = self.migrate(self.BEFORE)
        User, Claim, Ledger = old.get_model("core", "User"), old.get_model("core", "Claim"), old.get_model("core", "PaidLedger")
        owner = User.objects.create(email="m@t.edu", name="M", role="FACULTY", password="x")

        def claim(n, status="PAID", doi=None, **kw):
            return Claim.objects.create(owner=owner, status=status, ticket_number=f"M-{n}", doi=doi,
                                        paper_title=f"Paper {n}", total_authors=1, author_position=1, **kw)

        clock = [timezone.now()]

        def row(c, amount, voucher=None, raw=None):
            # Rows written in one instant have no order; real ones are seconds apart.
            clock[0] += timedelta(seconds=5)
            made = Ledger.objects.create(claim=c, payout_month=date(2026, 9, 1), amount=amount,
                                         voucher_number=voucher, raw_json=raw)
            Ledger.objects.filter(pk=made.pk).update(created_at=clock[0])
            return made

        doubled = claim(1)           # paid twice: a real duplicate
        row(doubled, 100)
        row(doubled, 100)
        repaid = claim(2)            # paid, voided, paid again: legitimate
        row(repaid, 50)
        row(repaid, -50, "V-VOID")
        row(repaid, 50)
        adjusted = claim(3)          # paid, then corrected
        row(adjusted, 80)
        row(adjusted, 20, "V-ADJ")
        waiting = claim(4, status="DIRECTOR_APPROVED", director_approved_at=timezone.now(),
                        remuneration=900, research_absorbed=100)
        claim(5, status="SUBMITTED", doi="10.1000/m")   # the same paper filed twice
        claim(6, status="CLEARED", doi="10.1000/M")

        new = self.migrate(MigrationExecutor(connection).loader.graph.leaf_nodes())

        Ledger2 = new.get_model("core", "PaidLedger")
        kinds = lambda c: [(r.kind, r.cycle) for r in Ledger2.objects.filter(claim_id=c.pk).order_by("created_at", "id")]
        self.assertEqual(kinds(repaid), [("PAYMENT", 1), ("REVERSAL", 1), ("PAYMENT", 2)])
        self.assertEqual(kinds(adjusted), [("PAYMENT", 1), ("ADJUSTMENT", 1)])
        self.assertEqual(kinds(doubled), [("PAYMENT", 1), ("PAYMENT", 1)], "the duplicate is left for the check to report")
        self.assertEqual(new.get_model("core", "Claim").objects.get(pk=waiting.pk).authorised_amount, 1000.0)

        # The constraints the data allowed are in; the two it broke are not.
        with connection.cursor() as cur:
            have = connection.introspection.get_constraints(cur, "core_paidledger")
            have_claim = connection.introspection.get_constraints(cur, "core_claim")
        self.assertIn("one_reversal_per_claim_cycle", have)
        self.assertNotIn("one_payment_per_claim_cycle", have)
        self.assertNotIn("one_filed_claim_per_person_per_doi", have_claim)

        # ...and the daily check says so, and finds the doubled rows.
        missing = safeguards.check_database()[0]
        self.assertEqual(missing.count, 2, [r["label"] for r in missing.rows])
        self.assertEqual(safeguards.check_paying_twice()[0].count, 1)
        self.assertEqual(safeguards.check_claimed_twice()[0].count, 2)


class RestoringAnOldBackup(ChainBase):
    """Risk: a backup from before the ledger had kinds cannot be restored."""

    def test_old_ledger_rows_are_given_their_kind_and_cycle_before_loading(self):
        from core.services import restore_upgrade

        def rec(pk, amount, voucher, created):
            return {"model": "core.paidledger", "pk": pk,
                    "fields": {"claim": "c1", "amount": amount, "voucher_number": voucher, "raw_json": None,
                               "created_at": created}}

        records = [rec("a", 100, "V", "2026-01-01"), rec("b", -100, "V-VOID", "2026-01-02"),
                   rec("c", 100, "V", "2026-01-03"), rec("d", 10, "V-ADJ", "2026-01-04"),
                   {"model": "core.paidledger", "pk": "e", "fields": {"claim": None, "amount": 5, "created_at": "x"}},
                   {"model": "core.paidledger", "pk": "f", "fields": {"claim": "c2", "kind": "PAYMENT", "cycle": 3}}]
        self.assertEqual(restore_upgrade.upgrade_records(records), 4)
        got = {r["pk"]: (r["fields"].get("kind"), r["fields"].get("cycle")) for r in records}
        self.assertEqual(got, {"a": ("PAYMENT", 1), "b": ("REVERSAL", 1), "c": ("PAYMENT", 2), "d": ("ADJUSTMENT", 2),
                               "e": (None, None), "f": ("PAYMENT", 3)})

    def test_a_file_is_upgraded_beside_the_original_and_one_already_current_is_left_alone(self):
        from core.services import restore_upgrade

        with tempfile.TemporaryDirectory() as d:
            old = f"{d}/old.json"
            with open(old, "w", encoding="utf-8") as fh:
                json.dump([{"model": "core.paidledger", "pk": "a", "fields": {"claim": "c", "amount": 1, "created_at": "1"}}], fh)
            out = restore_upgrade.upgraded_path(old)
            self.assertNotEqual(out, old)
            self.assertEqual(json.load(open(out, encoding="utf-8"))[0]["fields"]["kind"], "PAYMENT")
            current = f"{d}/new.json"
            with open(current, "w", encoding="utf-8") as fh:
                json.dump([{"model": "core.paidledger", "pk": "a", "fields": {"claim": "c", "kind": "PAYMENT", "cycle": 1}}], fh)
            self.assertEqual(restore_upgrade.upgraded_path(current), current)


class TheImporters(ChainBase):
    def test_a_rebuild_refuses_to_erase_payments_made_in_this_system(self):
        claim = self._claim(ClaimStatus.PAID, ticket="IM-1", paid_at=timezone.now())
        ClaimAction.objects.create(claim=claim, actor=self.finance, action="MARK_PAID")
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as fh:
            with self.assertRaises(CommandError) as ctx:
                call_command("rebuild_from_erp", fh.name, confirm=True, stdout=StringIO())
            self.assertIn("payment record(s) made through this system", str(ctx.exception))
            # With the explicit flag it gets past that guard (and fails on the empty file instead).
            with self.assertRaises(Exception) as ctx2:
                call_command("rebuild_from_erp", fh.name, confirm=True, erase_live_payments=True, stdout=StringIO())
            self.assertNotIn("made through this system", str(ctx2.exception))
        self.assertTrue(Claim.objects.filter(pk=claim.pk).exists(), "nothing was erased")

    def test_a_rebuild_with_no_payments_made_here_is_not_blocked_by_the_guard(self):
        with tempfile.NamedTemporaryFile(suffix=".xlsx") as fh:
            with self.assertRaises(Exception) as ctx:
                call_command("rebuild_from_erp", fh.name, confirm=True, stdout=StringIO())
            self.assertNotIn("made through this system", str(ctx.exception))

    def test_the_payment_history_import_keeps_two_co_authors_and_skips_a_rerun(self):
        from openpyxl import Workbook

        from core.management.commands.import_erp_excel import Command
        from core.models import PriorPayment

        wb = Workbook()
        ws = wb.active
        ws.append(["Faculty Name", "Faculty ID", "Scopus Article Title", "DOI", "Month", "Amount"])
        ws.append(["Dr A", "S1", "A shared paper title", "10.1000/shared", "2026-03-01", 400])
        ws.append(["Dr B", "S2", "A shared paper title", "10.1000/shared", "2026-03-01", 400])
        cmd = Command()
        cmd._import_accounts(ws, self.admin, 0)
        self.assertEqual(PriorPayment.objects.count(), 2, "both co-authors were paid")
        cmd._import_accounts(ws, self.admin, 0)
        self.assertEqual(PriorPayment.objects.count(), 2, "running the workbook again adds nothing")
        self.assertEqual(PaidLedger.objects.filter(claim__isnull=True).count(), 2)

    def test_the_calculator_check_of_every_claim_writes_nothing(self):
        from core.services import calculator

        self._claim(ClaimStatus.PAID, ticket="IM-C", paid_at=timezone.now())
        before = (AuditLog.objects.count(), Claim.objects.count(), PaidLedger.objects.count(),
                  list(Claim.objects.values_list("remuneration", "updated_at")))
        calculator.check_many()
        after = (AuditLog.objects.count(), Claim.objects.count(), PaidLedger.objects.count(),
                 list(Claim.objects.values_list("remuneration", "updated_at")))
        self.assertEqual(before, after)
        # Over HTTP it is a read: a GET that changes nothing.
        self.assertEqual(self._as(self.admin).get("/api/calculator/many").status_code, 200)

    def test_a_linked_ledger_payment_for_a_claim_that_has_one_is_a_correction_not_a_second_payment(self):
        from core.services import ledger_checks

        claim = self._claim(ClaimStatus.PAID, ticket="IM-L", paid_at=timezone.now(), payout_month=date(2026, 9, 1))
        PaidLedger.objects.create(claim=claim, payout_month=date(2026, 9, 1), amount=0)
        orphan = PaidLedger.objects.create(payout_month=date(2026, 9, 1), amount=400, paper_title="x")
        ledger_checks.link_row(self.admin, orphan.id, "IM-L", "The accounts sheet paid this")
        orphan.refresh_from_db()
        self.assertEqual((orphan.kind, orphan.cycle, orphan.claim_id), ("ADJUSTMENT", 1, claim.id))
        self.assertEqual(claim.ledger_rows.filter(kind="PAYMENT").count(), 1)
