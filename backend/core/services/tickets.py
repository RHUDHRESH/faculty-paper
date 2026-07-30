"""Ticket number allocation for claims — concurrency-safe."""
from __future__ import annotations

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from core.models import Claim


def _peek_next_seq(year: int) -> int:
    prefix = f"FP-{year}-"
    last = (
        Claim.objects.filter(ticket_number__startswith=prefix)
        .aggregate(m=Max("ticket_number"))
        .get("m")
    )
    if not last:
        return 1
    try:
        return int(str(last).rsplit("-", 1)[-1]) + 1
    except ValueError:
        return Claim.objects.filter(ticket_number__startswith=prefix).count() + 1


def next_ticket_number() -> str:
    """Allocate a unique FP-YYYY-###### under a short retry loop."""
    year = timezone.now().year
    for _ in range(12):
        with transaction.atomic():
            # Lock existing rows in this year prefix to serialize allocators
            list(
                Claim.objects.select_for_update()
                .filter(ticket_number__startswith=f"FP-{year}-")
                .order_by("-ticket_number")[:1]
            )
            seq = _peek_next_seq(year)
            candidate = f"FP-{year}-{seq:06d}"
            if not Claim.objects.filter(ticket_number=candidate).exists():
                return candidate
    raise RuntimeError("Could not allocate ticket number")


def assign_ticket_number(claim: Claim) -> str:
    """Set claim.ticket_number uniquely; caller should save."""
    if claim.ticket_number:
        return claim.ticket_number
    for _ in range(8):
        num = next_ticket_number()
        claim.ticket_number = num
        try:
            with transaction.atomic():
                if Claim.objects.filter(ticket_number=num).exclude(pk=claim.pk).exists():
                    continue
                claim.save(update_fields=["ticket_number", "updated_at"])
            return num
        except IntegrityError:
            claim.ticket_number = None
            continue
    raise RuntimeError("Could not assign ticket number")
