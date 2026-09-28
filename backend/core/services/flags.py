"""Raising, resolving and announcing discrepancy flags.

A flag never stops a claim (see `core.models.ClaimFlag`). What it does do is
make paying a doubted claim a visible decision: the super admin hears when a
claim is paid with a flag still open, and when somebody raises a flag on a
claim that has already been paid -- the two moments at which money and doubt
meet. Raising a flag on a claim still in the chain tells nobody; the desks it
is waiting at can see it.

Every raise and every resolution is written to the audit log. Those entries
are withheld from the Director and Finance along with the flags themselves
(`core.visibility.FLAG_AUDIT_ACTIONS`).
"""
from __future__ import annotations

import json

from django.db import IntegrityError, transaction
from django.utils import timezone

from core.models import AuditLog, Claim, ClaimFlag, ClaimStatus, User

#: Where the super admin is sent to deal with it.
FLAGS_HREF = "/flags"


def _audit(actor: User | None, action: str, flag: ClaimFlag, **extra) -> None:
    AuditLog.objects.create(
        actor=actor,
        action=action,
        entity="ClaimFlag",
        entity_id=flag.id,
        detail_json=json.dumps(
            {
                "claim": flag.claim_id,
                "ticket": flag.claim.ticket_number,
                "kind": flag.kind,
                "source": flag.source,
                **extra,
            }
        )[:5000],
    )


def _tell_super_admins(claim: Claim, title: str, body: str) -> None:
    from core.api.common import _notify_admin_users

    _notify_admin_users(
        title, body, f"{FLAGS_HREF}?claim={claim.id}", super_admin_only=True, claim_id=claim.id
    )


def raise_flag(
    claim: Claim,
    *,
    kind: str,
    note: str,
    actor: User | None = None,
    source: str = ClaimFlag.Source.MANUAL,
    auto_key: str | None = None,
    notify: bool = True,
) -> tuple[ClaimFlag, bool]:
    """Record a discrepancy on `claim`. Returns (flag, created).

    With `auto_key`, idempotent: a flag already raised under that key -- open
    or resolved -- is returned rather than raised again, so a check that runs
    twice does not ask its question twice, and one somebody has answered is
    not reopened behind their back.

    `notify=False` is for a sweep over history, which tells the super admin
    once for the whole run rather than once per claim.
    """
    if auto_key:
        existing = ClaimFlag.objects.filter(claim=claim, auto_key=auto_key).first()
        if existing:
            return existing, False
    try:
        with transaction.atomic():
            flag = ClaimFlag.objects.create(
                claim=claim,
                kind=kind,
                note=note,
                source=source,
                raised_by=actor,
                auto_key=auto_key,
            )
    except IntegrityError:
        # A second run of the same check got there first.
        return ClaimFlag.objects.get(claim=claim, auto_key=auto_key), False

    _audit(actor, "CLAIM_FLAG_RAISE", flag, note=note[:1000])
    if notify and claim.status == ClaimStatus.PAID:
        _tell_super_admins(
            claim,
            f"Flag raised on a paid claim · {claim.ticket_number or 'no ticket'}",
            f"{flag.get_kind_display()}: {note[:300]}",
        )
    return flag, True


def resolve_flag(flag: ClaimFlag, *, actor: User | None, note: str) -> ClaimFlag:
    """Record the answer. `actor` is None when a check closes its own flag."""
    flag.resolved_by = actor
    flag.resolved_at = timezone.now()
    flag.resolution_note = note
    flag.save(update_fields=["resolved_by", "resolved_at", "resolution_note"])
    _audit(actor, "CLAIM_FLAG_RESOLVE", flag, resolution=note[:1000])
    return flag


def announce_paid_with_open_flags(claim: Claim) -> None:
    """Tell the super admin a claim was just paid with a question still open.

    Called after the payment, never before it: the payment is not held, it
    is made and then reported.
    """
    open_flags = list(claim.flags.filter(resolved_at__isnull=True))
    if not open_flags:
        return
    kinds = sorted({f.get_kind_display().lower() for f in open_flags})
    count = len(open_flags)
    _tell_super_admins(
        claim,
        f"Paid with an open flag · {claim.ticket_number or 'no ticket'}",
        f"{claim.paper_title or 'A claim'} was paid with {count} open "
        f"flag{'s' if count != 1 else ''} ({', '.join(kinds)}). Nothing was held back; "
        "review it under Flags.",
    )
