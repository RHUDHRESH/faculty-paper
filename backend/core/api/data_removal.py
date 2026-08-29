"""removing rows, and emptying the system.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.deps import require_user

import json
from typing import Optional
from django.contrib.auth import login
from django.db import transaction
from django.db.models import Sum
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimAction, ClaimAttachment, ClaimStatus, DuplicateFinding, MonthlyBatch, Notification, PaidLedger, PriorPayment, Role, User

# ---------- removing rows, and emptying the system ----------

#: Tables that can never be deleted from, whatever the caller says.
#: The audit log is the record of who did what, including of a wipe, and a
#: wipe that erases its own trace is not something this system will do.
UNDELETABLE = {"AuditLog"}

#: Tables whose rows are the evidence that money moved.
MONEY_TABLES = {"PaidLedger", "PriorPayment", "MonthlyBatch"}


def _deletion_guard(user: User, table_name: str) -> None:
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may delete records here.")
    if table_name in UNDELETABLE:
        raise HttpError(
            400,
            "The audit log cannot be deleted from. It is the record of who "
            "changed what, and a system that can erase its own trail cannot "
            "be relied on for anything else it says.",
        )


def _refuses_because_paid(instance) -> str | None:
    """Why this row must stay, or None if it may go.

    Judged on everything the delete would take, not on the row that was named.
    Those are different questions, and answering the easy one was a hole: a
    claim that has been paid is refused, but `Claim.owner` cascades, so
    deleting the *account* took 113 paid publications with it and never
    reached this check at all — the row being deleted was a User, and a User
    has no status and is not a money table. The largest account on the live
    database would have taken ₹398,204 of settled payments out of the record
    with one call and left an audit entry reading "deleted one user".
    """
    from django.db import router
    from django.db.models.deletion import Collector

    collector = Collector(using=router.db_for_write(instance.__class__))
    try:
        collector.collect([instance])
    except Exception:
        # Nothing here is worth a 500. If the cascade cannot be worked out,
        # fall back to judging the row itself, which is what this did before.
        collected = {instance.__class__: [instance]}
    else:
        collected = collector.data

    paid = 0
    money = set()
    for model, objects in collected.items():
        name = model.__name__
        if name in MONEY_TABLES:
            money.add(name)
        if name == "Claim":
            paid += sum(1 for o in objects if getattr(o, "status", None) == ClaimStatus.PAID)

    if paid and not isinstance(instance, Claim):
        return (
            f"Deleting this would also remove {paid} publication"
            f"{'s' if paid != 1 else ''} that {'have' if paid != 1 else 'has'} "
            "been paid, because they belong to it. That is the record of money "
            "that really left the account. Deactivate it instead — the account "
            "stops working and everything it did stays on the record."
        )
    if paid:
        return (
            "This publication has been paid. Deleting it removes the record of "
            "a payment that really happened — void the payment first if it was "
            "made in error, which keeps the reversal on the ledger."
        )
    if money:
        return (
            "This row is part of the payment record. It is what the college "
            "would show if anybody asked why money left the account."
        )
    return None


class DeleteRowIn(Schema):
    reason: str


# "/admin/data/{table}/row/{id}" rather than "/admin/data/{table}/{id}":
# the second shape matches "/admin/data/Claim/export" too, and because this
# operation is registered first the export answered 405. The same trap is
# documented on the reset-password route below.
@api.delete("/admin/data/{table_name}/row/{row_id}", auth=session_auth)
def data_delete_row(
    request: HttpRequest, table_name: str, row_id: str, payload: DeleteRowIn
):
    """Remove one row, with the reason recorded and the money protected."""
    user = require_user(request)
    _deletion_guard(user, table_name)

    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Say why this is being deleted, in a sentence.")

    instance = get_object_or_404(model, pk=row_id)
    refusal = _refuses_because_paid(instance)
    if refusal:
        raise HttpError(400, refusal)
    if isinstance(instance, User) and instance.id == user.id:
        raise HttpError(400, "You cannot delete the account you are signed in as.")

    described = str(instance)[:200]
    # Written before the delete: afterwards there is no row to describe, and
    # an audit entry that cannot say what went is not much of a record.
    AuditLog.objects.create(
        actor=user, action="DATA_DELETE", entity=table.model_name,
        entity_id=str(row_id),
        detail_json=json.dumps({"was": described, "reason": reason}),
    )
    instance.delete()
    return {"ok": True, "deleted": described}


class WipeIn(Schema):
    #: The exact phrase, typed out. Nothing else is accepted.
    confirm: str
    reason: str
    #: What the caller was told would go. A mismatch means the system changed
    #: under them between reading and confirming, and the wipe is refused.
    expect_rows: Optional[int] = None
    #: Required separately when settled payments are present.
    i_understand_payments_will_be_lost: bool = False


#: What a wipe empties, in the order a foreign key will tolerate.
WIPE_ORDER = [
    "ClaimAttachment", "ClaimAction", "Notification", "DuplicateFinding",
    "PaidLedger", "Claim", "PriorPayment", "MonthlyBatch",
]

WIPE_PHRASE = "DELETE EVERYTHING"


def _wipe_counts() -> dict[str, int]:
    out: dict[str, int] = {}
    for name in WIPE_ORDER:
        model = explorer.model_for(name)
        if model is not None:
            out[name] = model.objects.count()
    return out


@api.get("/admin/wipe/preview", auth=session_auth)
def wipe_preview(request: HttpRequest):
    """What a wipe would remove, before anybody types the words."""
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may see this.")
    counts = _wipe_counts()
    paid = Claim.objects.filter(status=ClaimStatus.PAID).count()
    paid_amount = (
        Claim.objects.filter(status=ClaimStatus.PAID).aggregate(
            s=Sum("remuneration")
        )["s"]
        or 0
    )
    return {
        "counts": counts,
        "total_rows": sum(counts.values()),
        "paid_claims": paid,
        "paid_amount": round(paid_amount, 2),
        "phrase": WIPE_PHRASE,
        # Said plainly rather than left for the dialog to word.
        "kept": [
            "Accounts and roles — everybody keeps their login",
            "The audit log, including this wipe",
            "Journal reference data and the payout formula",
        ],
    }


@api.post("/admin/wipe", auth=session_auth)
def wipe_everything(request: HttpRequest, payload: WipeIn):
    """Empty the publication and payment tables. Accounts and audit survive.

    Every guard here exists because the alternative is losing 2.76 crore of
    payment history to a mis-click.
    """
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may do this.")

    if (payload.confirm or "").strip() != WIPE_PHRASE:
        raise HttpError(400, f'Type "{WIPE_PHRASE}" exactly to confirm.')
    reason = (payload.reason or "").strip()
    if len(reason) < 10:
        raise HttpError(400, "Say why the system is being emptied, in a sentence.")

    counts = _wipe_counts()
    total = sum(counts.values())
    if payload.expect_rows is not None and payload.expect_rows != total:
        raise HttpError(
            409,
            f"The system now holds {total:,} rows, not the {payload.expect_rows:,} "
            "you were shown. Something changed while you were reading — look "
            "again before confirming.",
        )

    paid = Claim.objects.filter(status=ClaimStatus.PAID).count()
    if paid and not payload.i_understand_payments_will_be_lost:
        raise HttpError(
            400,
            f"This system holds {paid:,} settled payments. Emptying it destroys "
            "the record that they were made. Confirm that separately if it is "
            "genuinely what you want.",
        )

    # Recorded first: the log survives the wipe on purpose, and an entry
    # written afterwards would be missing if the delete failed halfway.
    AuditLog.objects.create(
        actor=user, action="SYSTEM_WIPE", entity="System", entity_id="all",
        detail_json=json.dumps({"counts": counts, "total": total, "reason": reason}),
    )

    removed: dict[str, int] = {}
    with transaction.atomic():
        for name in WIPE_ORDER:
            model = explorer.model_for(name)
            if model is None:
                continue
            n, _ = model.objects.all().delete()
            removed[name] = counts.get(name, 0)

    return {"ok": True, "removed": removed, "total": total}




__all__ = [
    'DeleteRowIn',
    'MONEY_TABLES',
    'UNDELETABLE',
    'WIPE_ORDER',
    'WIPE_PHRASE',
    'WipeIn',
    '_deletion_guard',
    '_refuses_because_paid',
    '_wipe_counts',
    'data_delete_row',
    'wipe_everything',
    'wipe_preview',
]
