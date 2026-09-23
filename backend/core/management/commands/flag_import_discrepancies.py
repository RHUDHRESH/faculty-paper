"""Flag the imported paid claims whose amount or status does not add up.

Paid nothing without saying why (AMOUNT), and paid while marked rejected
(OTHER). The same sweep runs once in data migration 0043, so on a deployment
with no shell this is already done; running it again raises nothing twice.
See core.services.import_discrepancies.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.services.import_discrepancies import flag_import_discrepancies


class Command(BaseCommand):
    help = "Flag imported paid claims paid nothing without a reason, or paid while marked rejected."

    def handle(self, *args, **opts):
        counts = flag_import_discrepancies()
        self.stdout.write(
            f"Paid nothing without a reason: {counts['paid_zero']}. "
            f"Paid while marked rejected: {counts['paid_rejected']}. "
            f"New flags raised: {counts['raised']}."
        )
