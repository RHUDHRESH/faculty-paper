"""Admin B: the data-fix queue, fault lists and the plain-words change history."""
from __future__ import annotations

import json
from datetime import date

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import AuditLog, Claim, ClaimStatus, PaidLedger, Role, User
from core.services import change_history, claim_fixes


class Base(TestCase):
    def setUp(self):
        cache.clear()
        self.admin = User.objects.create_user(
            email="adm-b@x.edu", password="p", name="Admin B", role=Role.SUPER_ADMIN
        )
        self.fac = User.objects.create_user(
            email="fac-b@x.edu", password="p", name="Dr. Asha Rao", role=Role.FACULTY,
            department="ECE", biometric_id="B1", scopus_author_id="1",
        )
        self.c = Client()
        self.c.force_login(self.admin)

    def paid(self, no="ERP-PROCESSED-1", amount=0.0, title="A real title", quartile="Q2", ledger=0.0, note="Accounts"):
        claim = Claim.objects.create(
            owner=self.fac, status=ClaimStatus.PAID, ticket_number=no, paper_title=title,
            quartile=quartile, remuneration=amount, status_note=note,
            payout_month=date(2026, 9, 1), journal_title="J",
        )
        if ledger is not None:
            PaidLedger.objects.create(
                claim=claim, payout_month=date(2026, 9, 1), amount=ledger,
                faculty_name="Dr. Asha Rao", paper_title=title,
            )
        return claim


class QueueTests(Base):
    def test_counts_and_one_row_per_claim(self):
        a = self.paid("ERP-PROCESSED-1", amount=0.0, title="-", quartile="Q1")
        self.paid("ERP-PROCESSED-2", amount=15000.0, title="Fine", quartile="Q1")
        self.paid("ERP-PROCESSED-3", amount=0.0, title="Fine", quartile="Q1",
                  note="Student Publication. No Remuneration. Only for count")
        Claim.objects.create(owner=self.fac, status=ClaimStatus.SUBMITTED, ticket_number="ERP-RAW-1",
                             paper_title="T", quartile=None)
        body = self.c.get("/api/admin/data-fixes").json()
        self.assertEqual(body["counts"]["paid_no_amount"], 1)
        self.assertEqual(body["counts"]["untitled"], 1)
        self.assertEqual(body["counts"]["no_quartile"], 1)
        self.assertEqual(body["counts"]["no_quartile_in_review"], 1)
        self.assertEqual(body["counts"]["claims"], 2)
        by_no = {r["ticket_number"]: r for r in body["rows"]}
        self.assertEqual(sorted(by_no["ERP-PROCESSED-1"]["issues"]), ["paid_no_amount", "untitled"])
        self.assertEqual(by_no["ERP-RAW-1"]["issues"], ["no_quartile"])
        self.assertTrue(by_no["ERP-PROCESSED-1"]["imported"])
        self.assertEqual(by_no["ERP-PROCESSED-1"]["id"], a.id)

    def test_kind_and_stage_narrow_the_rows(self):
        self.paid("ERP-PROCESSED-1", amount=0.0)
        Claim.objects.create(owner=self.fac, status=ClaimStatus.SUBMITTED, ticket_number="ERP-RAW-1",
                             paper_title="T", quartile="")
        only_q = self.c.get("/api/admin/data-fixes", {"kind": "no_quartile", "stage": "review"}).json()
        self.assertEqual([r["ticket_number"] for r in only_q["rows"]], ["ERP-RAW-1"])
        self.assertEqual(self.c.get("/api/admin/data-fixes", {"kind": "nope"}).status_code, 400)

    def test_the_fault_and_the_queue_count_the_same_claims(self):
        for i in range(3):
            self.paid(f"ERP-PROCESSED-{i}", amount=0.0)
        faults = {f["key"]: f for g in self.c.get("/api/admin/faults").json()["groups"] for f in g["faults"]}
        queue = self.c.get("/api/admin/data-fixes").json()
        self.assertEqual(faults["paid_zero"]["count"], queue["counts"]["paid_no_amount"])
        items = self.c.get("/api/admin/faults/paid_zero").json()
        self.assertEqual(items["total"], faults["paid_zero"]["count"])
        self.assertEqual(len(items["items"]), 3)

    def test_only_the_office_reads_it(self):
        c = Client()
        c.force_login(self.fac)
        self.assertEqual(c.get("/api/admin/data-fixes").status_code, 403)


class FixTests(Base):
    def test_amount_fix_writes_the_ledger_row_and_the_audit_entry(self):
        claim = self.paid(amount=0.0, ledger=0.0)
        r = self.c.post(
            f"/api/admin/data-fixes/{claim.id}",
            data=json.dumps({"amount": 18500, "reason": "From the accounts voucher register"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        claim.refresh_from_db()
        self.assertEqual(claim.remuneration, 18500)
        self.assertTrue(body["ledger"]["matches"])
        self.assertEqual(body["ledger"]["ledger_total"], 18500)
        self.assertEqual(body["row"]["issues"], [])
        log = AuditLog.objects.get(action="CLAIM_DATA_FIX", entity_id=claim.id)
        detail = json.loads(log.detail_json)
        self.assertEqual(detail["after"]["remuneration"], 18500)
        self.assertEqual(detail["reason"], "From the accounts voucher register")
        # Told in words, with the amount in rupees.
        entry = change_history.for_record("Claim", claim.id)[0]
        self.assertEqual(entry["what"], "corrected the record")
        self.assertEqual(entry["changes"][0], {"label": "Amount", "from": "₹0", "to": "₹18,500"})

    def test_a_paid_claim_with_no_ledger_row_gets_one(self):
        claim = self.paid(amount=None, ledger=None)
        r = self.c.post(
            f"/api/admin/data-fixes/{claim.id}",
            data=json.dumps({"amount": 7000, "reason": "Voucher 44 of March"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(claim.ledger_rows.count(), 1)
        self.assertTrue(r.json()["ledger"]["matches"])

    def test_title_and_quartile_on_a_settled_claim_keep_the_amount(self):
        claim = self.paid(amount=12000.0, ledger=12000.0, title="-", quartile=None)
        r = self.c.post(
            f"/api/admin/data-fixes/{claim.id}",
            data=json.dumps({"title": "Real title of the paper", "quartile": "Q3",
                             "reason": "Checked against the journal page"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.paper_title, "Real title of the paper")
        self.assertEqual(claim.quartile, "Q3")
        self.assertEqual(claim.quartile_source, "MANUAL")
        self.assertEqual(claim.remuneration, 12000.0)
        self.assertEqual(PaidLedger.objects.filter(claim=claim).count(), 1)

    def test_no_payment_due_takes_it_off_the_fault(self):
        claim = self.paid(amount=0.0)
        r = self.c.post(
            f"/api/admin/data-fixes/{claim.id}",
            data=json.dumps({"no_payment": True, "reason": "Accounts confirmed count only"}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(claim_fixes.paid_without_amount().count(), 0)

    def test_refusals_are_plain(self):
        claim = self.paid(amount=0.0)
        url = f"/api/admin/data-fixes/{claim.id}"
        post = lambda body: self.c.post(url, data=json.dumps(body), content_type="application/json")
        self.assertEqual(post({"amount": 100, "reason": "short"}).status_code, 400)
        self.assertEqual(post({"amount": -5, "reason": "A long enough reason"}).status_code, 400)
        self.assertEqual(post({"title": "Untitled", "reason": "A long enough reason"}).status_code, 400)
        self.assertEqual(post({"quartile": "Q9", "reason": "A long enough reason"}).status_code, 400)
        self.assertEqual(post({"reason": "A long enough reason"}).status_code, 400)
        draft = Claim.objects.create(owner=self.fac, status=ClaimStatus.SUBMITTED, ticket_number="X-1", paper_title="T")
        r = self.c.post(f"/api/admin/data-fixes/{draft.id}",
                        data=json.dumps({"amount": 100, "reason": "A long enough reason"}),
                        content_type="application/json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("paid claim", r.json()["detail"])

    def test_a_claim_whose_claimant_was_not_identified_is_given_to_the_right_person(self):
        nobody = User.objects.create_user(email="nf@saveetha.invalid", password="p", name="Not Found", role=Role.FACULTY)
        claim = Claim.objects.create(owner=nobody, status=ClaimStatus.SUBMITTED, ticket_number="ERP-RAW-9",
                                     paper_title="A paper", quartile="Q1")
        body = self.c.get("/api/admin/data-fixes", {"kind": "no_claimant"}).json()
        self.assertEqual([r["ticket_number"] for r in body["rows"]], ["ERP-RAW-9"])
        # The one service Home, Admin and Track read agrees with the fix page.
        self.assertEqual(body["claims_needing_a_fix"], body["counts"]["claims"])
        r = self.c.post(f"/api/admin/data-fixes/{claim.id}",
                        data=json.dumps({"owner_email": self.fac.email, "reason": "Named in the roster sheet"}),
                        content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        claim.refresh_from_db()
        self.assertEqual(claim.owner_id, self.fac.id)
        self.assertEqual(r.json()["row"]["issues"], [])
        bad = self.c.post(f"/api/admin/data-fixes/{claim.id}",
                          data=json.dumps({"owner_email": "nobody@x.edu", "reason": "Named in the roster sheet"}),
                          content_type="application/json")
        self.assertEqual(bad.status_code, 400)

    def test_only_a_super_admin_writes(self):
        claim = self.paid(amount=0.0)
        cell = User.objects.create_user(email="cell-b@x.edu", password="p", name="Cell", role=Role.RESEARCH_CELL)
        c = Client()
        c.force_login(cell)
        r = c.post(f"/api/admin/data-fixes/{claim.id}",
                   data=json.dumps({"amount": 100, "reason": "A long enough reason"}),
                   content_type="application/json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(c.get("/api/admin/data-fixes").status_code, 200)


class LedgerChecksTests(Base):
    def post(self, url, body):
        return self.c.post(url, data=json.dumps(body), content_type="application/json")

    def test_the_counts_are_real_and_separate(self):
        self.paid("ERP-PROCESSED-1", amount=5000.0, ledger=None)            # no ledger row
        self.paid("ERP-PROCESSED-2", amount=5000.0, ledger=3000.0)          # rows do not add up
        self.paid("ERP-PROCESSED-3", amount=5000.0, ledger=5000.0)          # agrees
        PaidLedger.objects.create(payout_month=date(2025, 1, 1), amount=700.0, faculty_name="X", paper_title="Old")
        body = self.c.get("/api/admin/ledger/checks").json()
        self.assertEqual(body, {"no_ledger": 1, "mismatch": 1, "no_claim": 1})

    def test_add_the_missing_row_makes_the_ledger_agree(self):
        claim = self.paid("ERP-PROCESSED-1", amount=5000.0, ledger=None)
        r = self.post(f"/api/admin/ledger/claims/{claim.id}/add-row", {"reason": "Voucher 12 of the register"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["added"], 5000.0)
        self.assertEqual(self.c.get("/api/admin/ledger/checks").json()["no_ledger"], 0)
        self.assertEqual(self.post(f"/api/admin/ledger/claims/{claim.id}/add-row", {"reason": "Voucher 12 of the register"}).status_code, 400)
        self.assertTrue(AuditLog.objects.filter(action="LEDGER_ROW_ADD", entity_id=claim.id).exists())

    def test_a_claim_with_no_amount_is_sent_to_the_data_fixes(self):
        claim = self.paid("ERP-PROCESSED-1", amount=0.0, ledger=None)
        r = self.post(f"/api/admin/ledger/claims/{claim.id}/add-row", {"reason": "Voucher 12 of the register"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("Fix imported claims", r.json()["detail"])

    def test_linking_a_row_settles_it_and_names_the_claim(self):
        claim = self.paid("ERP-PROCESSED-1", amount=400.0, ledger=None)
        row = PaidLedger.objects.create(payout_month=date(2025, 1, 1), amount=400.0, faculty_name="Dr. Asha Rao", paper_title="A real title")
        listed = self.c.get("/api/admin/ledger/problems", {"kind": "no-claim"}).json()
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["rows"][0]["candidates"][0]["ticket_number"], "ERP-PROCESSED-1")
        r = self.post(f"/api/admin/ledger/rows/{row.id}/link", {"claim": "ERP-PROCESSED-1", "reason": "Same title and person"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["claim"]["missing"], 0)
        self.assertEqual(self.c.get("/api/admin/ledger/checks").json(), {"no_ledger": 0, "mismatch": 0, "no_claim": 0})
        # A row that belongs to a claim cannot be moved by accident.
        self.assertEqual(self.post(f"/api/admin/ledger/rows/{row.id}/link", {"claim": "ERP-PROCESSED-1", "reason": "Same title and person"}).status_code, 400)

    def test_data_fix_offers_and_uses_the_payment_already_in_the_ledger(self):
        claim = self.paid("ERP-PROCESSED-1", amount=0.0, ledger=0.0, title="Machine learning based syntax")
        row = PaidLedger.objects.create(payout_month=date(2025, 3, 1), amount=400.0, faculty_name="Dr. Asha Rao",
                                        paper_title="Machine Learning-Based Syntax", voucher_number="1802")
        Claim.objects.filter(pk=claim.pk).update(paper_title="Machine Learning-Based Syntax", normalized_title="")
        from core.services.normalize import normalize_title
        Claim.objects.filter(pk=claim.pk).update(normalized_title=normalize_title("Machine Learning-Based Syntax"))
        queue = self.c.get("/api/admin/data-fixes").json()
        match = queue["rows"][0]["ledger_matches"][0]
        self.assertEqual((match["id"], match["amount"]), (row.id, 400.0))
        r = self.post(f"/api/admin/data-fixes/{claim.id}", {"amount": 400, "link_ledger_row_id": row.id, "reason": "The accounts sheet paid this"})
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["ledger"]["matches"])
        # No second row for the same money: the two rows are the ₹0 import and the ₹400 payment.
        self.assertEqual(PaidLedger.objects.filter(claim=claim).count(), 2)
        self.assertEqual(body["ledger"]["ledger_total"], 400.0)

    def test_only_a_super_admin_changes_the_ledger(self):
        claim = self.paid("ERP-PROCESSED-1", amount=5000.0, ledger=None)
        cell = User.objects.create_user(email="cell-l@x.edu", password="p", name="Cell", role=Role.RESEARCH_CELL)
        c = Client()
        c.force_login(cell)
        r = c.post(f"/api/admin/ledger/claims/{claim.id}/add-row", data=json.dumps({"reason": "Voucher 12 of the register"}), content_type="application/json")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(c.get("/api/admin/ledger/checks").status_code, 200)


class HistoryTests(Base):
    def test_history_reads_in_words(self):
        claim = self.paid(amount=100.0)
        AuditLog.objects.create(
            actor=self.admin, action="CLAIM_ADMIN_EDIT", entity="Claim", entity_id=claim.id,
            detail_json=json.dumps({"reason": "Typo", "before": {"quartile": "Q1", "remuneration": 100.0},
                                    "after": {"quartile": "Q2", "remuneration": 250000.5}}),
        )
        r = self.c.get("/api/admin/history", {"entity": "Claim", "id": claim.id})
        self.assertEqual(r.status_code, 200, r.content)
        e = r.json()["entries"][0]
        self.assertEqual(e["who"]["name"], "Admin B")
        self.assertEqual(e["reason"], "Typo")
        self.assertIn({"label": "Amount", "from": "₹100", "to": "₹2,50,000.50"}, e["changes"])

    def test_a_duplicate_decision_reads_as_a_decision(self):
        AuditLog.objects.create(
            actor=self.admin, action="DUPLICATE_REVIEW", entity="DuplicateFinding", entity_id="dup1",
            detail_json=json.dumps({"status": "CONFIRMED", "extra_amount": 93189.0, "recovered_amount": None}),
        )
        e = self.c.get("/api/admin/history", {"entity": "DuplicateFinding", "id": "dup1"}).json()["entries"][0]
        self.assertEqual(e["what"], "reviewed a possible double payment")
        self.assertEqual(e["changes"][0]["to"], "Confirmed duplicate")
        self.assertEqual(e["changes"][1], {"label": "Money at issue", "from": "Not recorded", "to": "₹93,189"})

    def test_the_audit_list_speaks_in_words_and_counts_what_it_lists(self):
        claim = self.paid(amount=100.0)
        AuditLog.objects.create(
            actor=self.admin, action="CLAIM_DATA_FIX", entity="Claim", entity_id=claim.id,
            detail_json=json.dumps({"reason": "From the register", "before": {"remuneration": 0.0},
                                    "after": {"remuneration": 18500.0}}),
        )
        AuditLog.objects.create(actor=None, action="BACKUP_STORED", entity="Backup", entity_id="b1")
        body = self.c.get("/api/admin/audit").json()
        by_action = {r["action"]: r for r in body["results"]}
        fix = by_action["CLAIM_DATA_FIX"]
        self.assertEqual(fix["who"]["name"], "Admin B")
        self.assertEqual(fix["what"], "corrected the record")
        self.assertEqual(fix["record"]["label"], "Claim ERP-PROCESSED-1")
        self.assertEqual(fix["changes"][0]["to"], "₹18,500")
        self.assertIsNone(by_action["BACKUP_STORED"]["who"])
        self.assertEqual(by_action["BACKUP_STORED"]["what"], "stored a backup")
        s = body["summary"]
        self.assertEqual(s["by_people"] + s["by_system"], body["total"])
        self.assertEqual(s["by_system"], 1)

    def test_publishing_a_policy_records_what_moved_in_words(self):
        from core.models import FormulaConfig
        from core.services.remuneration import DEFAULT_AUTHOR_POINTS

        FormulaConfig.objects.create(
            author_point_json=json.dumps(DEFAULT_AUTHOR_POINTS), active=True, qf_q1=50000, snip_multiplier=55000
        )
        body = {"snip_multiplier": 55000, "qf_q1": 55000, "qf_q2": 30000, "qf_q3": 15000, "qf_q4": 7000,
                "author_point_json": json.dumps(DEFAULT_AUTHOR_POINTS), "notes": "Q1 raised by the council"}
        r = self.c.put("/api/admin/formula", data=json.dumps(body), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        entry = self.c.get("/api/admin/audit", {"action": "FORMULA_UPDATE"}).json()["results"][0]
        self.assertEqual(entry["what"], "published a new policy")
        self.assertIn({"label": "Q1 bonus", "from": "₹50,000", "to": "₹55,000"}, entry["changes"])
        self.assertEqual(entry["reason"], "Q1 raised by the council")

    def test_changing_the_college_name_is_recorded_from_and_to(self):
        r = self.c.put("/api/admin/settings", data=json.dumps({"college_name": "Riverside College"}), content_type="application/json")
        self.assertEqual(r.status_code, 200, r.content)
        e = self.c.get("/api/admin/history", {"entity": "system_setting", "id": "institution"}).json()["entries"][0]
        self.assertEqual(e["what"], "changed the college's details")
        self.assertEqual(e["changes"][0]["label"], "College name")
        self.assertEqual(e["changes"][0]["to"], "Riverside College")

    def test_setting_an_allocation_records_from_what_to_what(self):
        put = lambda amount: self.c.post(
            "/api/budgets",
            data=json.dumps({"financial_year": "2026-27", "department": "ECE", "amount": amount, "note": "Council minute 4"}),
            content_type="application/json",
        )
        self.assertEqual(put(500000).status_code, 200)
        self.assertEqual(put(650000).status_code, 200)
        entries = self.c.get("/api/admin/audit", {"action": "BUDGET"}).json()["results"]
        newest = entries[0]
        self.assertEqual(newest["what"], "set an allocation")
        self.assertEqual(newest["context"], "ECE, FY 2026-27")
        self.assertEqual(newest["changes"][0], {"label": "Amount", "from": "₹5,00,000", "to": "₹6,50,000"})
        self.assertEqual(newest["reason"], "Council minute 4")
        self.assertEqual(entries[1]["changes"][0]["from"], "Not recorded")

    def test_audit_actions_lists_only_what_the_log_holds(self):
        AuditLog.objects.create(actor=self.admin, action="BUDGET_SET", entity="Budget", entity_id="x")
        actions = self.c.get("/api/admin/audit/actions").json()["actions"]
        self.assertIn({"value": "BUDGET_SET", "label": "Set an allocation"}, actions)
        self.assertEqual(len(actions), 1)

    def test_history_of_a_kind_not_kept_is_refused(self):
        self.assertEqual(self.c.get("/api/admin/history", {"entity": "Banana", "id": "x"}).status_code, 400)

    def test_inr_groups_the_indian_way(self):
        self.assertEqual(change_history.inr(109265), "₹1,09,265")
        self.assertEqual(change_history.inr(999), "₹999")
        self.assertEqual(change_history.inr(12345678), "₹1,23,45,678")
