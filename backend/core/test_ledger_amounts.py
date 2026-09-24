"""The ledger's newest ERP rows paid the figure in col27, not the one headed "Amount".

The last block of Master_List_Accounts carries six unlabelled columns, and in
those rows the column headed "Amount" holds the number of authors. Imported at
face value, 304 payments of April to June 2026 were recorded as Rs 2 to Rs 6
each: a faculty member paid Rs 21,979 read "Rs 4", and the college's total was
short by about Rs 20.6 lakh.
"""
from __future__ import annotations

import json
from datetime import date
from io import StringIO

from django.core.management import call_command
from django.test import TestCase
from openpyxl import Workbook

from core.management.commands.import_erp_excel import Command as ImportCommand
from core.models import AuditLog, PaidLedger, PriorPayment, Role, User

SHIFTED = {
    "Month": "2026-05-01 00:00:00", "Overall S No": "2907.0", "Faculty ID": "TSXX901",
    "Scopus Article Title": "A paper", "Amount": "4.0", "col22": "3.0", "col23": "0.2",
    "col24": "Processed for Remuneration", "col25": "50000.0", "col26": "109895.0",
    "col27": "21979.0",
}


def _row(raw, amount):
    PriorPayment.objects.create(
        employee_id=raw.get("Faculty ID"), paper_title=raw.get("Scopus Article Title"),
        amount_paid=amount, claim_ref=raw.get("Overall S No"), raw_json=json.dumps(raw),
    )
    return PaidLedger.objects.create(
        payout_month=date(2026, 5, 1), staff_id=raw.get("Faculty ID"), paper_title="A paper",
        amount=amount, raw_json=json.dumps(raw),
    )


class RepairLedgerAmountsTests(TestCase):
    def run_command(self, *args):
        out = StringIO()
        call_command("repair_ledger_amounts", *args, stdout=out)
        return out.getvalue()

    def test_a_dry_run_says_what_it_would_change_and_changes_nothing(self):
        row = _row(SHIFTED, 4.0)
        out = self.run_command()
        row.refresh_from_db()
        self.assertEqual(row.amount, 4.0)
        self.assertIn("1 ledger row", out)
        self.assertIn("21,979", out)

    def test_applying_it_pays_the_row_what_the_erp_worked_out(self):
        row = _row(SHIFTED, 4.0)
        User.objects.create_user(email="a@x.edu", password="p", name="A", role=Role.SUPER_ADMIN)
        self.run_command("--apply")
        row.refresh_from_db()
        self.assertEqual(row.amount, 21979.0)
        self.assertEqual(PriorPayment.objects.get().amount_paid, 21979.0)
        log = AuditLog.objects.get(action="LEDGER_AMOUNTS_REPAIRED")
        self.assertEqual(json.loads(log.detail_json)["rows"], 1)

    def test_a_row_whose_working_does_not_add_up_is_left_alone(self):
        odd = dict(SHIFTED, col27="99999.0")
        row = _row(odd, 4.0)
        out = self.run_command("--apply")
        row.refresh_from_db()
        self.assertEqual(row.amount, 4.0)
        self.assertIn("left alone", out)

    def test_an_ordinary_row_is_never_touched_and_a_second_run_changes_nothing(self):
        plain = {"Month": "2025-01-01 00:00:00", "Amount": "15000", "Faculty ID": "X"}
        ordinary = _row(plain, 15000.0)
        _row(SHIFTED, 4.0)
        self.run_command("--apply")
        out = self.run_command("--apply")
        ordinary.refresh_from_db()
        self.assertEqual(ordinary.amount, 15000.0)
        self.assertIn("0 ledger rows", out)


class ImportAccountsTests(TestCase):
    def test_the_import_reads_the_payout_not_the_author_count(self):
        wb = Workbook()
        ws = wb.active
        # The sheet's real layout: 22 labelled columns, then six without a
        # header, which the reader names col22 to col27 by position.
        headers = [
            "Month", "Overall S No", "Department", "Faculty Name", "Biometric ID", "Faculty ID",
            "Scopus Article Title", "Source Title", "ISSN", "Document Type", "SNIP Value",
            "Engineering Classification", "SJR Quartile", "Scopus ID", "Indexing Status",
            "Scopus ID Link Status", "Publication Date", "Scopus EID", "DOI",
            "Scopus Article Link", "Subject Area", "Amount",
        ]
        ws.append(headers + [None] * 6)
        row = dict.fromkeys(headers)
        row.update({"Month": "2026-05-01", "Overall S No": 2907, "Faculty ID": "TSXX901",
                    "Scopus Article Title": "A paper", "Amount": 4})
        ws.append(list(row.values()) + [3, 0.2, "Processed", 50000, 109895, 21979])
        actor = User.objects.create_user(email="i@x.edu", password="p", name="I", role=Role.SUPER_ADMIN)
        ImportCommand()._import_accounts(ws, actor, 0)
        self.assertEqual(PaidLedger.objects.get().amount, 21979.0)
        self.assertEqual(PriorPayment.objects.get().amount_paid, 21979.0)
