"""Check, or import, the settled-claims workbook (Claim_Settled_Upto_<month>.xlsx).

    python manage.py import_settled_claims Claim_Settled_Upto_Sep_2026.xlsx           # check only
    python manage.py import_settled_claims Claim_Settled_Upto_Sep_2026.xlsx --apply   # import

The same code as Admin > Imports; a check writes nothing.
"""
import json
import os

from django.core.management.base import BaseCommand, CommandError

from core.models import AuditLog
from core.services.settled_claims_import import import_settled_claims, read_settled_claims


class Command(BaseCommand):
    help = "Check (default) or import the settled-claims workbook"

    def add_arguments(self, parser):
        parser.add_argument("xlsx")
        parser.add_argument("--apply", action="store_true", help="Write the changes. Without it nothing is written.")
        parser.add_argument("--no-fill", action="store_true", help="With --apply: do not fill the gaps afterwards (core/services/data_fill.py).")

    def handle(self, *args, **opts):
        try:
            rows = read_settled_claims(opts["xlsx"])
        except Exception as exc:
            raise CommandError(f"Could not read the workbook: {exc}") from exc
        name = os.path.basename(opts["xlsx"])
        r = import_settled_claims(rows, dry_run=not opts["apply"], filename=name)
        if opts["apply"]:
            AuditLog.objects.create(
                actor=None, action="SETTLED_CLAIMS_IMPORT", entity="PaidLedger",
                detail_json=json.dumps({"rows": r["rows"], **r["counts"], "new_total_amount": r["new_total_amount"],
                                        "file": name[:120], "via": "command"}),
            )
        out = self.stdout.write
        out(("Imported" if opts["apply"] else "Check only, nothing written") + f": {r['rows']} rows")
        out("  " + ", ".join(f"{k} {v}" for k, v in r["counts"].items()))
        out(f"  new total: {r['new_total_amount']:,.2f}")
        for m in r["by_month"]:
            out(f"  {m['month'] or 'no month'}: {m['new']} new, {m['amount']:,.2f}")
        for d in r["amount_differs"][:20]:
            out(f"  amount differs {d['staff_id']} {d['name']}: ledger {d['ledger_amount']}, file {d['file_amount']}")
        d = r["double_payments"]
        out(f"  papers paid more than once: {d['count']}, {d['total_amount']:,.2f} in all")
        for x in d["rows"][:20]:
            out(f"    {x['staff_id']} {x['name']}: {x['title'][:60]} " + ", ".join(
                f"{p['month'][:7]} {p['amount']:,.0f}" for p in x["payments"]))
        c = r["claim_payments_from_sheet"]
        out(f"  claims the app had at nothing, paid per the sheet: {c['count']}, {c['total_amount']:,.2f}")
        out(f"  amount blank in the sheet: {r['blank_amounts']['count']}")
        n = r["paid_in_app_not_in_sheet"]
        out(f"  paid in the app, not in the sheet: {n['count']}")
        for x in n["rows"][:20]:
            out(f"    {x['ticket']} {x['staff_id']} {x['title'][:60]} {x['amount']:,.2f}"
                + (f" (sheet lists it under {', '.join(x['listed_under'])})" if x["listed_under"] else ""))
        if r["unmatched_staff"]:
            out("  unknown Faculty IDs: " + ", ".join(u["staff_id"] or "(blank)" for u in r["unmatched_staff"][:30]))
        if not opts["apply"]:
            out("Run again with --apply to import.")
        elif not opts["no_fill"]:
            from core.services import data_fill

            out(data_fill.run_safe_fills(None, "import:settled claims")["text"])
