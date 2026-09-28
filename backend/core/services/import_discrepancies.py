"""Paid rows the ERP import brought across that do not add up.

Two patterns in the imported history, each a real discrepancy rather than a
formatting quirk:

* **Paid nothing, without saying why.** The accounts workbook pays some papers
  nothing on purpose -- student publications and uncited ones are "processed
  only for count", and say so in the status. The rest of the zero-amount rows
  do not: their ERP "Amount" column reads 0 while the ERP's own working
  column, (SNIP x 55000) + QF, holds a figure. Raised as AMOUNT, quoting both.
* **Paid, but marked rejected.** The row was imported as paid because it is on
  the accounts sheet, while its own status says "Rejected". Raised as OTHER.

Both are flags, not corrections: nobody here knows which figure is the true
one, and a flag asks the person who can find out.

This module is run by the `flag_import_discrepancies` command and by data
migration 0043, so it takes a model registry (`apps`) and imports nothing
from `core.models` itself: in a migration it must work against the models as
they stood then. Idempotent -- each claim is flagged once per rule, and a
flag somebody resolved is not raised again.
"""
from __future__ import annotations

import json
import re

RULE_PAID_ZERO = "import:paid-zero"
RULE_PAID_REJECTED = "import:paid-rejected"


def _money(value: float) -> str:
    return f"₹{value:,.0f}"


def _number(raw) -> float | None:
    if raw in (None, "", "None", "nan"):
        return None
    try:
        return float(str(raw).replace(",", "").strip())
    except ValueError:
        return None


def erp_figures(raw_json: str | None) -> dict[str, float | None]:
    """The ERP's own figures from a ledger row's raw spreadsheet row.

    Headers are matched loosely: the workbooks spell "(SNIP * 55000)+QF" with
    and without spaces, and keep it under a column number when the header
    cell was blank.
    """
    try:
        row = json.loads(raw_json) if raw_json else {}
    except (TypeError, ValueError):
        return {}
    if not isinstance(row, dict):
        return {}
    out: dict[str, float | None] = {}
    for key, value in row.items():
        k = re.sub(r"\s+", "", str(key)).lower()
        if "55000" in k:
            out["working"] = _number(value)
        elif k == "amount":
            out["amount"] = _number(value)
        elif k in ("qfamount", "qf"):
            out["qf"] = _number(value)
        elif k in ("snipvalue", "snip"):
            out["snip"] = _number(value)
    return out


def zero_both_ways(figures: dict[str, float | None]) -> bool:
    """The ERP paid nothing and its own working also comes to nothing.

    That is the ERP agreeing with itself -- a paper its formula prices at
    zero -- not a lost figure, so it is no discrepancy.
    """
    return not (figures.get("amount") or 0) and figures.get("working") == 0


def _paid_zero_note(claim, figures: dict[str, float | None]) -> str:
    said = [
        "Paid nothing on the ERP import, and the row does not say it was "
        "processed only for count or carries no remuneration."
    ]
    if figures:
        amount = figures.get("amount")
        parts = [f"The ERP's Amount column reads {_money(amount) if amount is not None else 'nothing'}"]
        working = figures.get("working")
        if working is not None:
            extras = []
            if figures.get("qf") is not None:
                extras.append(f"QF Amount {_money(figures['qf'])}")
            if figures.get("snip") is not None:
                extras.append(f"SNIP {figures['snip']:g}")
            parts.append(
                f"its own working, (SNIP × 55000) + QF, reads {_money(working)}"
                + (f" ({', '.join(extras)})" if extras else "")
            )
        said.append("; ".join(parts) + ".")
    else:
        said.append("The ERP row behind it was not kept, so its own figures cannot be quoted here.")
    said.append("Check which figure was actually paid, and correct the amount or record why it is nothing.")
    return " ".join(said)


def _paid_rejected_note(claim, figures: dict[str, float | None]) -> str:
    amount = claim.remuneration
    on_record = _money(amount) if amount is not None else "no amount"
    return (
        f"Imported as paid because it is on the ERP accounts sheet, but its own "
        f"status reads “{claim.status_note}”. Amount on record: {on_record}. "
        "Check whether it was really paid: if it was not, the payment record needs "
        "reversing; if it was, the status is wrong."
    )


def flag_import_discrepancies(registry=None, *, notify: bool = True) -> dict[str, int]:
    """Flag every imported paid claim matching either rule. Returns counts.

    `registry` is a migration's `apps`, or None for the live models.
    """
    from django.apps import apps as live
    from django.db import IntegrityError, transaction
    from django.db.models import Q

    registry = registry or live
    Claim = registry.get_model("core", "Claim")
    ClaimFlag = registry.get_model("core", "ClaimFlag")
    PaidLedger = registry.get_model("core", "PaidLedger")
    AuditLog = registry.get_model("core", "AuditLog")
    Notification = registry.get_model("core", "Notification")
    User = registry.get_model("core", "User")

    # Imported means never authorised on this system: `director_approved_at`
    # is set by a live authorisation and by nothing else. A live count-only
    # filing is paid at zero on purpose and is not an import at all.
    imported_paid = Claim.objects.filter(status="PAID", director_approved_at__isnull=True)
    rejected = Q(status_note__icontains="reject")
    # The same test as `admin_faults` (core/api/operations.py) uses for the
    # zero payments that are zero on purpose.
    on_purpose = Q(status_note__icontains="only for count") | Q(status_note__iregex=r"no\s*re[nm]u")
    rules = (
        (
            RULE_PAID_ZERO, "AMOUNT", _paid_zero_note, "paid_zero",
            imported_paid.filter(Q(remuneration__isnull=True) | Q(remuneration=0))
            .exclude(on_purpose)
            .exclude(rejected)
            .exclude(claim_reason="COUNT_ONLY"),
        ),
        (RULE_PAID_REJECTED, "OTHER", _paid_rejected_note, "paid_rejected", imported_paid.filter(rejected)),
    )

    counts = {"paid_zero": 0, "paid_rejected": 0, "raised": 0}
    for rule, kind, compose, label, queryset in rules:
        already = set(
            ClaimFlag.objects.filter(auto_key=rule).values_list("claim_id", flat=True)
        )
        for claim in queryset.order_by("pk").iterator():
            counts[label] += 1
            if claim.pk in already:
                continue
            ledger = (
                PaidLedger.objects.filter(claim_id=claim.pk)
                .exclude(raw_json__isnull=True)
                .exclude(raw_json="")
                .order_by("created_at")
                .first()
            )
            figures = erp_figures(ledger.raw_json) if ledger else {}
            if rule == RULE_PAID_ZERO and zero_both_ways(figures):
                continue
            note = compose(claim, figures)
            try:
                with transaction.atomic():
                    flag = ClaimFlag.objects.create(
                        claim_id=claim.pk, kind=kind, source="AUTO", note=note, auto_key=rule
                    )
            except IntegrityError:
                continue
            AuditLog.objects.create(
                actor=None,
                action="CLAIM_FLAG_RAISE",
                entity="ClaimFlag",
                entity_id=flag.pk,
                detail_json=json.dumps(
                    {"claim": claim.pk, "ticket": claim.ticket_number, "kind": kind,
                     "source": "AUTO", "rule": rule, "note": note[:1000]}
                ),
            )
            counts["raised"] += 1

    if notify and counts["raised"]:
        raised = counts["raised"]
        for admin in User.objects.filter(role="SUPER_ADMIN", active=True):
            Notification.objects.create(
                user_id=admin.pk,
                title=f"Import check: {raised} flag{'s' if raised != 1 else ''} raised on paid claims",
                body=(
                    "Paid rows from the ERP import whose amount or status does not add up. "
                    "Nothing was changed; each one is waiting under Flags."
                ),
                href="/flags",
            )
    return counts


def close_zero_both_ways(registry=None) -> int:
    """Resolve open import flags whose ERP figures are both zero. Returns how many."""
    from django.apps import apps as live
    from django.utils import timezone

    registry = registry or live
    ClaimFlag = registry.get_model("core", "ClaimFlag")
    PaidLedger = registry.get_model("core", "PaidLedger")
    closed = 0
    for flag in ClaimFlag.objects.filter(auto_key=RULE_PAID_ZERO, resolved_at__isnull=True):
        ledger = (
            PaidLedger.objects.filter(claim_id=flag.claim_id)
            .exclude(raw_json__isnull=True)
            .exclude(raw_json="")
            .order_by("created_at")
            .first()
        )
        if ledger and zero_both_ways(erp_figures(ledger.raw_json)):
            flag.resolved_at = timezone.now()
            flag.resolution_note = (
                "Closed by the import check: the ERP's amount and its own working are both "
                "₹0, so the figures agree."
            )
            flag.save(update_fields=["resolved_at", "resolution_note"])
            closed += 1
    return closed
