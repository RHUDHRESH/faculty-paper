"""Put the right figure on ledger rows the ERP import read from the wrong column.

The newest block of Master_List_Accounts (April to June 2026 in the college's
workbook) carries six unlabelled columns, and in those rows the column headed
"Amount" holds the number of authors. `import_erp_excel` read the header at
face value until it was fixed, so every payment in that block was recorded as
Rs 2 to Rs 6 -- a faculty member paid Rs 21,979 was shown "Rs 4", and the
college's total fell short by lakhs.

The trailing columns are the ERP's own working: col23 the author-position
points, col26 (SNIP x 55000) + QF, col27 the payout. A row is corrected only
when that working agrees with itself (col26 x col23 = col27, to the rupee), so
a row whose columns mean something else is reported and left alone.

    python manage.py repair_ledger_amounts            # says what it would do
    python manage.py repair_ledger_amounts --apply    # does it, and audits it

Safe to run twice: a corrected row already carries col27 and is skipped.
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import AuditLog, PaidLedger, PriorPayment, Role, User
from core.services.record_dates import erp_row


def _num(value) -> float | None:
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def proposed_amount(raw: dict) -> tuple[float | None, str]:
    """(the payout the ERP worked out, why) -- or (None, why not)."""
    payout, formula, points = _num(raw.get("col27")), _num(raw.get("col26")), _num(raw.get("col23"))
    if payout is None or formula is None or points is None:
        return None, "no working"
    if abs(formula * points - payout) >= 1:
        return None, "working does not add up"
    return payout, "ok"


class Command(BaseCommand):
    help = "Correct ledger rows whose amount was read from the author-count column (dry run unless --apply)."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write the corrections.")

    def handle(self, *args, **options):
        fixes: list[tuple[PaidLedger, float]] = []
        left_alone = 0
        for row in PaidLedger.objects.filter(claim__isnull=True).exclude(raw_json__isnull=True):
            raw = erp_row(row.raw_json)
            if not raw or "col27" not in raw:
                continue
            amount, why = proposed_amount(raw)
            if amount is None:
                if why != "no working":
                    left_alone += 1
                continue
            if abs((row.amount or 0) - amount) >= 0.5:
                fixes.append((row, amount))

        before = sum(r.amount or 0 for r, _ in fixes)
        after = sum(a for _, a in fixes)
        noun = "ledger row" if len(fixes) == 1 else "ledger rows"
        self.stdout.write(
            f"{len(fixes)} {noun} to correct: recorded Rs {before:,.0f}, "
            f"the ERP's working says Rs {after:,.0f}."
        )
        for r, a in fixes[:10]:
            self.stdout.write(f"  {r.payout_month:%b %Y}  {r.staff_id or '-'}  Rs {r.amount or 0:,.0f} -> Rs {a:,.0f}")
        if left_alone:
            self.stdout.write(f"{left_alone} row(s) left alone: their working does not add up.")
        if not options["apply"] or not fixes:
            if fixes:
                self.stdout.write("Dry run. Nothing was changed; run again with --apply.")
            return

        with transaction.atomic():
            for row, amount in fixes:
                raw = erp_row(row.raw_json) or {}
                PriorPayment.objects.filter(
                    claim_ref=raw.get("Overall S No"),
                    employee_id=raw.get("Faculty ID"),
                    amount_paid=row.amount,
                ).update(amount_paid=amount)
                row.amount = amount
                row.save(update_fields=["amount"])
            AuditLog.objects.create(
                actor=User.objects.filter(role=Role.SUPER_ADMIN).order_by("created_at").first(),
                action="LEDGER_AMOUNTS_REPAIRED",
                entity="PaidLedger",
                detail_json=json.dumps({
                    "rows": len(fixes),
                    "recorded": round(before, 2),
                    "corrected": round(after, 2),
                    "rule": "col26 x col23 = col27; amount := col27",
                }),
            )
        self.stdout.write(f"Corrected {len(fixes)} {noun}.")
