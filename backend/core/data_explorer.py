"""Read the database from inside the app, in a way that cannot undo it.

The admin and the principal need to look at the data directly: to answer a
question nobody built a screen for, to check a figure against its row, to pull
a table into a spreadsheet. Django's own admin would do it, and is exactly
what should not be used here -- it edits any column of any row with no
recalculation and no reason recorded, so one afternoon in it would quietly
undo the trust boundary, the payment gates, the amount guards and the
duplicate controls.

So this is a registry rather than a database shell. Three rules:

- Some columns are never shown. A password hash is not data to browse.
- Most columns are read-only. Anything the workflow owns -- status, every
  money column, who approved what and when -- moves through the screens that
  recalculate and audit it. A row editor that could set `status = PAID` would
  make every guard in the system optional.
- What is editable is reference data: the imported journal tables and the
  faculty master, where a wrong row is a data-entry error and correcting it
  is the whole point. Every edit is audited with the before and after.

Reading is wide open by design: every table, every non-secret column, any
filter, any format. It is the writing that is narrow.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from django.apps import apps
from django.db import models

#: Columns that are never returned, whatever table they sit on.
NEVER_SHOW = {"password", "is_superuser", "is_staff"}

#: Substrings marking a column the workflow owns. Read yes, write never --
#: these move through screens that recalculate and record who did it.
WORKFLOW_OWNED = (
    "status", "remuneration", "amount", "paid", "payout", "approved",
    "cleared", "override", "voucher", "verified", "duplicate", "snip",
    "quartile", "engineering_class", "author_point", "category",
)


@dataclass(frozen=True)
class Table:
    """One table, as somebody browsing it needs to understand it."""

    model_name: str
    label: str
    #: What this table is for, in a sentence. Shown above the rows, because a
    #: name like "ClaimAction" tells a reader nothing.
    about: str
    #: Columns worth showing first, before the long tail.
    highlight: tuple[str, ...] = ()
    #: Columns a super admin may correct here. Empty means read-only.
    editable: tuple[str, ...] = ()
    #: Default ordering.
    order: str = "-id"
    group: str = "Other"


TABLES: list[Table] = [
    Table("Claim", "Claims", "Every ticket ever filed, at every stage. Ninety-five "
          "columns: the paper, the journal, the verification, the money and the "
          "trail of who moved it.",
          ("ticket_number", "status", "paper_title", "journal_title",
           "publication_year", "quartile", "snip", "remuneration", "payout_month"),
          order="-updated_at", group="The scheme"),
    Table("ClaimAction", "Claim actions", "Every transition a ticket made, who made "
          "it and when. This is the ticket's history.",
          ("claim", "action", "from_status", "to_status", "actor", "created_at"),
          order="-created_at", group="The scheme"),
    Table("ClaimAttachment", "Attachments", "Files on a ticket: the published paper "
          "and the cited SEC references, with the fingerprint of each file.",
          ("claim", "kind", "filename", "ref_number", "content_hash"),
          order="-created_at", group="The scheme"),
    Table("ClaimNote", "Notes on tickets", "Notes between the principal and the "
          "research cell about one ticket. Never visible to the claimant.",
          ("claim", "author", "body", "resolved_at"),
          order="-created_at", group="The scheme"),
    Table("PaidLedger", "Payment ledger", "One row per payment made, including the "
          "negative rows written when a payment is voided.",
          ("claim", "payout_month", "faculty_name", "amount", "voucher_number"),
          order="-created_at", group="Money"),
    Table("PriorPayment", "Imported payment history", "The payments loaded from the "
          "old ERP workbook, as the sheet recorded them.",
          ("claim_ref", "faculty_name", "paper_title", "amount_paid", "paid_at"),
          order="-paid_at", group="Money"),
    Table("Budget", "Budgets", "What was allocated, per financial year and "
          "department.",
          ("financial_year", "department", "amount", "note"),
          editable=("amount", "note"), order="-financial_year", group="Money"),
    Table("DuplicateFinding", "Duplicate findings", "Payments the sweep grouped as "
          "possibly made twice, and what somebody decided about each.",
          ("kind", "status", "faculty_name", "paper_title", "payment_count",
           "extra_amount"),
          order="-extra_amount", group="Money"),
    Table("FormulaConfig", "Payout policy", "The rates every payout is computed "
          "from, version by version.",
          ("name", "version", "snip_multiplier", "qf_q1", "qf_q2", "qf_q3",
           "qf_q4", "effective_from"),
          order="-version", group="Money"),
    Table("User", "Accounts", "Everybody who can sign in, and the identity fields "
          "that decide who is paid and whose record a paper is checked against.",
          ("email", "name", "role", "department", "designation", "staff_id",
           "biometric_id", "active"),
          order="name", group="People"),
    Table("FacultyMaster", "Faculty master", "The staff list the ERP import was "
          "keyed on, before accounts were created from it.",
          ("name", "department", "staff_id", "biometric_id", "designation"),
          editable=("name", "department", "staff_id", "biometric_id",
                    "designation", "email", "phone"),
          order="name", group="People"),
    Table("ScimagoJournal", "Scimago journals", "The quartile and SJR table, one row "
          "per journal per year. Thirty-two thousand rows.",
          ("title", "issn", "eissn", "year", "sjr"),
          editable=("title", "issn", "eissn", "sjr"),
          order="title", group="Reference data"),
    Table("SnipSource", "SNIP source", "The SNIP table the payout formula multiplies "
          "by.",
          ("title", "print_issn", "e_issn", "snip", "sjr", "year"),
          editable=("title", "print_issn", "e_issn"),
          order="title", group="Reference data"),
    Table("JournalStanding", "Journal standing", "Whether a journal is still on the "
          "Scopus or UGC-CARE list, and when it was removed.",
          ("source", "issn", "title", "listed", "changed_on"),
          editable=("listed", "changed_on", "reason", "title"),
          order="issn", group="Reference data"),
    Table("AuditLog", "Audit log", "Who did what. Never editable, by anybody, at "
          "any level: a record that can be rewritten is not a record.",
          ("created_at", "actor", "action", "entity", "entity_id"),
          order="-created_at", group="Oversight"),
    Table("Notification", "Notifications", "What each person was told, and whether "
          "they have read it.",
          ("user", "title", "read", "created_at"),
          order="-created_at", group="Oversight"),
    Table("PriorImport", "Import runs", "Each time the ERP workbook was loaded.",
          ("created_at", "filename", "row_count"),
          order="-created_at", group="Oversight"),
    Table("MonthlyBatch", "Monthly batches", "Each monthly processing run.",
          ("name", "status", "started_at", "finished_at"),
          order="-created_at", group="Oversight"),
    Table("MonthlyRow", "Monthly batch rows", "One row per claim inside a batch.",
          ("batch", "row_number", "paper_title", "journal", "index_status"),
          order="-id", group="Oversight"),
]

BY_NAME = {t.model_name: t for t in TABLES}


def model_for(name: str):
    if name not in BY_NAME:
        return None
    return apps.get_model("core", name)


def column_meta(model, table: Table) -> list[dict[str, Any]]:
    """Every column a reader may see, with what it is and whether it moves."""
    out = []
    for f in model._meta.fields:
        if f.name in NEVER_SHOW:
            continue
        editable = f.name in table.editable and not _is_workflow_owned(f.name)
        out.append({
            "name": f.name,
            "label": f.verbose_name.title() if hasattr(f, "verbose_name") else f.name,
            "type": _kind_of(f),
            "editable": editable,
            "highlighted": f.name in table.highlight,
            "related": f.related_model.__name__ if f.related_model else None,
            "choices": [c[0] for c in (f.choices or [])] or None,
        })
    return out


def _is_workflow_owned(name: str) -> bool:
    return any(token in name for token in WORKFLOW_OWNED)


def _kind_of(f) -> str:
    if isinstance(f, models.ForeignKey):
        return "reference"
    if isinstance(f, models.BooleanField):
        return "boolean"
    if isinstance(f, (models.IntegerField, models.FloatField, models.DecimalField)):
        return "number"
    if isinstance(f, models.DateTimeField):
        return "datetime"
    if isinstance(f, models.DateField):
        return "date"
    if isinstance(f, models.TextField):
        return "text"
    return "string"


def searchable_columns(model) -> list[str]:
    """Text columns worth running a free-text search across."""
    return [
        f.name
        for f in model._meta.fields
        if f.name not in NEVER_SHOW
        and isinstance(f, (models.CharField, models.TextField))
        and not isinstance(f, models.ForeignKey)
    ]


def serialise(instance, columns: list[dict[str, Any]]) -> dict[str, Any]:
    """One row, with references shown as something a person can read."""
    row: dict[str, Any] = {}
    for col in columns:
        name = col["name"]
        value = getattr(instance, name, None)
        if col["type"] == "reference":
            related = getattr(instance, name, None)
            row[name] = str(related) if related is not None else None
            row[f"{name}__id"] = getattr(instance, f"{name}_id", None)
        elif hasattr(value, "isoformat"):
            row[name] = value.isoformat()
        else:
            row[name] = value
    return row
