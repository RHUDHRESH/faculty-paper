"""Ticket number allocation for claims."""
from __future__ import annotations

from django.db.models import Max
from django.utils import timezone

from core.models import Claim


def next_ticket_number() -> str:
    year = timezone.now().year
    prefix = f"FP-{year}-"
    last = (
        Claim.objects.filter(ticket_number__startswith=prefix)
        .aggregate(m=Max("ticket_number"))
        .get("m")
    )
    seq = 1
    if last:
        try:
            seq = int(str(last).rsplit("-", 1)[-1]) + 1
        except ValueError:
            seq = Claim.objects.filter(ticket_number__startswith=prefix).count() + 1
    return f"{prefix}{seq:06d}"
