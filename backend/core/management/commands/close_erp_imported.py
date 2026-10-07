"""Close the ERP-imported claims still waiting at the first desk.

`import_erp_excel` brought in claims the old ERP had received but not settled
(tickets `ERP-RAW-n`). The old system handled them, so they were never this
app's to decide: they sat at the first desk as weeks late and blocked nothing
but the desk's own figures. They close as REJECTED, outright, carrying
`ERP_CLOSED_NOTE`, which the claimant reads as "Closed (old system)" and which
the decision counts leave out. No notification, no email, no ledger row.

    python manage.py close_erp_imported          # show what would close
    python manage.py close_erp_imported --apply  # close them
"""
from __future__ import annotations

import json

from django.core.management.base import BaseCommand
from django.db import transaction

from core.models import AuditLog, Claim, ClaimStatus
from core.visibility import ERP_CLOSED_NOTE

ERP_RAW_PREFIX = "ERP-RAW-"


class Command(BaseCommand):
    help = "Close SUBMITTED ERP-RAW claims as handled in the old system."

    def add_arguments(self, parser):
        parser.add_argument("--apply", action="store_true", help="Write the change.")

    def handle(self, *args, **opts):
        claims = list(
            Claim.objects.filter(status=ClaimStatus.SUBMITTED, ticket_number__startswith=ERP_RAW_PREFIX)
            .select_related("owner")
            .order_by("ticket_number")
        )
        if not claims:
            self.stdout.write(self.style.SUCCESS("No ERP-imported claims are waiting."))
            return

        self.stdout.write(f"{len(claims)} claim(s) would close as handled in the old system:")
        for c in claims:
            owner = c.owner.name if c.owner_id else "-"
            self.stdout.write(f"  {c.ticket_number}  {owner}  {(c.paper_title or '')[:70]}")

        if not opts["apply"]:
            self.stdout.write(self.style.WARNING("\nDry run. Re-run with --apply to close them."))
            return

        with transaction.atomic():
            for c in claims:
                c.status = ClaimStatus.REJECTED
                c.rejected_outright = True
                c.status_note = ERP_CLOSED_NOTE
                c.save(update_fields=["status", "rejected_outright", "status_note", "updated_at"])
                AuditLog.objects.create(
                    actor=None,
                    action="CLAIM_CLOSED_OLD_SYSTEM",
                    entity="Claim",
                    entity_id=c.id,
                    detail_json=json.dumps({
                        "ticket_number": c.ticket_number,
                        "from": ClaimStatus.SUBMITTED,
                        "to": ClaimStatus.REJECTED,
                        "note": ERP_CLOSED_NOTE,
                    }),
                )
        self.stdout.write(self.style.SUCCESS(f"\nClosed {len(claims)} claim(s)."))
