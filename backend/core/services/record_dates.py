"""Which dates the record actually carries, and which an import stamped on it.

The college's history arrived from its ERP workbook, and a workbook row does
not always say when something happened. Where it did not, the import filled
the gap with the moment it ran: every claim brought across carries that moment
as its filing and payment time, and the ledger rows for the "Processed" sheet
carry the import's month as their payout month. Shown as they stand, those
read as ninety papers filed and paid on one afternoon.

These two questions are asked in one place so the ticket history, the calendar
and anything else that puts a date in front of somebody agree on the answer.
"""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

#: The columns an ERP payment row names its month in. A row from the
#: payment-history sheet has one; a row from the "Processed" sheet does not.
MONTH_KEYS = ("Month", "Payout Month", "Paid Month")

#: How far before its own creation a claim's filing time must be to have come
#: from somewhere rather than from the import that created it.
_IMPORT_SLACK = timedelta(hours=1)


def erp_row(raw_json: str | None) -> dict[str, Any] | None:
    """The workbook row a ledger row was built from, or None for one this app wrote."""
    if not raw_json:
        return None
    try:
        raw = json.loads(raw_json)
    except ValueError:
        return None
    return raw if isinstance(raw, dict) and raw else None


def ledger_month_recorded(raw_json: str | None) -> bool:
    """Whether a ledger row's payout month is one somebody recorded.

    A row this app wrote when Finance paid has the month it was paid in. A row
    from the payment-history sheet has the sheet's own month. A row from the
    "Processed" sheet names no month, so the one it carries is the import's.
    """
    raw = erp_row(raw_json)
    if raw is None:
        return True
    return any(raw.get(k) for k in MONTH_KEYS)


def claim_record(claim, *, has_actions: bool) -> dict[str, Any]:
    """What a ticket's own history can truthfully say about it.

    `imported` and `source` say whether it came from the ERP workbook and from
    which sheet (its ticket number says so: ERP-RAW-65 is row 65 of Raw_Data,
    the Google Form's sheet). `filed_at` is a real filing time or None;
    `paid_month` the payout month somebody recorded, or None; `erp_status`
    what the workbook said about it, for an imported ticket.
    """
    ticket = claim.ticket_number or ""
    imported = ticket.startswith("ERP-") and not has_actions
    source = None
    if imported:
        tag = ticket.split("-")[1] if ticket.count("-") >= 2 else ""
        source = {"RAW": "Raw_Data", "PROCESSED": "Processed"}.get(tag, tag.title() or None)
    months = [
        row.payout_month
        for row in claim.ledger_rows.all()
        if ledger_month_recorded(row.raw_json) and (row.amount or 0) >= 0
    ]
    filed = filing_recorded(claim.submitted_at, claim.created_at, has_actions=has_actions)
    return {
        "imported": imported,
        "source": source,
        "imported_at": claim.created_at.isoformat() if imported and claim.created_at else None,
        "filed_at": claim.submitted_at.isoformat() if filed else None,
        "paid_month": max(months).strftime("%Y-%m") if months else None,
        "erp_status": (claim.status_note or None) if imported else None,
    }


def filing_recorded(submitted_at, created_at, *, has_actions: bool) -> bool:
    """Whether `submitted_at` is when the paper was filed.

    Filed through this app: the submit step is on record, so it is. Brought
    across from the old Google Form: the form's own timestamp, which is weeks
    or months before the import created the row. Otherwise it is the import's
    moment, within seconds of the row's creation, and says nothing.
    """
    if submitted_at is None:
        return False
    if has_actions:
        return True
    return created_at is not None and submitted_at < created_at - _IMPORT_SLACK
