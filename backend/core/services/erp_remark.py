"""Old-ERP claims imported as paid that Accounts never priced or paid.

The importer (`import_erp_excel._import_accounts_claims`) marked every row of
the old workbook's Accounts sheet PAID, stamped it paid on the day of the
import and wrote the sheet's Amount to the ledger. Some of those rows had
Amount 0 because the author's share was never worked out: Accounts did not
price them and nobody was paid. They sit in the data-fix queue as "Paid with
no amount", and while they say PAID no desk can move them and Finance's pay
button refuses them.

This module puts them back where the normal run starts. It is the super
admin's tool, and it works from the database alone, never from a list of
claim numbers:

* **Candidates** are `data_fixes.queryset("paid_no_amount")` (an imported
  claim, PAID, no amount, and no note saying the sheet paid nothing on
  purpose), limited to the claim sheets the importer numbers
  (`erp_import.stable_ticket`), and with no real payment: no ledger row
  carrying money, none sent to the bank or written by a pay request, and no
  pay step in the claim's history.
* **Held for the research cell**, never changed here:
  "rejected on the accounts sheet" when the sheet's own Status, which the
  importer keeps in `status_note`, maps to REJECTED; "possible repeat" when
  `payment_guards.earlier_payment` would find the same person already paid
  for the same paper, the very check that would refuse the payment later
  (asked of the whole list at once by `paid_before`, which gives its answer).

Why Cleared, and not Principal-approved or authorised
-----------------------------------------------------
The owner's words are "approved, amount to be worked out". In this chain the
amount is worked out at each desk that signs it: `principal_approve` and
`director_approve` both recompute the amount (`_apply_calc`) and refuse
unless the person confirms exactly that figure, and the Director's step locks
it (`authorised_amount`), which is the only figure Finance may pay
(`_mark_one_paid`; docs/ops/safeguards.md, "Amount changed after
authorisation"). Finance's queue holds only DIRECTOR_APPROVED claims with a
live `director_approved_at`. So:

* DIRECTOR_APPROVED would need a Director's signature and a locked amount
  that nobody gave; without them `_mark_one_paid` refuses it as a retired
  import status and Finance's queue never shows it.
* PRINCIPAL_APPROVED would send to the Director an approval the Principal
  never gave, for an amount nobody has seen.
* CLEARED is "checked; waiting for the Principal to approve the amount". It
  is where `void_payment` puts a payment undone, where the amount lock sends a
  claim whose figure moved, and where `_mark_one_paid` says an imported
  ticket must go "so the amount is verified rather than taken from the
  import". From there the Principal works out and approves the amount, the
  Director authorises it, and Finance pays it in the monthly run.

What changes, reversibly
------------------------
In one transaction: status PAID to CLEARED; `paid_at`, `payout_month` and
`voucher_number` (stamped by the import, not by a payment) cleared;
`remuneration` cleared to "not worked out". The import's ₹0 ledger row is a
live PAYMENT in cycle 1, which the pay guard reads as "already paid", so a
₹0 REVERSAL is written for that cycle (the ledger is append-only, exactly as
`void_payment` does it) and the real payment later starts cycle 2. Each claim
gets a ClaimAction and an audit row; the batch's audit row keeps every
claim's values before and after, which is what `undo` restores. The reversal
stays on the ledger after an undo: it moved no money, and the ledger is never
edited.

Doubts about a paper are not written to the audit trail, which Finance can
read (`core.visibility`): the held lists live only in the preview.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable

from django.db import transaction
from django.db.models import Q
from django.db.models.functions import Lower
from django.utils.dateparse import parse_date, parse_datetime

from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, PaidLedger, PriorPayment, cuid
from core.services import claim_numbers, claim_standing, data_fixes, payment_guards, rbac
from core.services.erp_import import map_excel_status
from core.services.normalize import normalize_doi, normalize_title

ACTION = "ERP_REMARK"
UNDO_ACTION = "ERP_REMARK_UNDO"
#: The audit entity a batch is recorded under; its id is the batch id.
ENTITY = "ErpRemark"
AFTER_STATUS = ClaimStatus.CLEARED
AFTER_STATUS_LABEL = (
    "Cleared and waiting for the Principal. The amount is worked out and approved there, "
    "then the Director authorises it and Finance pays it in the monthly run."
)
HELD_REPEAT = "possible repeat"
HELD_REJECTED = "rejected on the accounts sheet"
WHY = "Imported from the old ERP as paid, but Accounts never worked out an amount and nothing was paid."
#: The sheets the importer numbers claims from (`erp_import.stable_ticket`).
#: A ticket like "ERP-000123" comes from the payments ledger, not a claim sheet.
SHEET_PREFIXES = ("ERP-RAW-", "ERP-PROCESSED-", "ERP-ACCOUNTS-")
#: The claim fields the re-mark sets and an undo puts back.
FIELDS = ("status", "paid_at", "payout_month", "voucher_number", "remuneration")
MONEY = 0.005


class RemarkError(ValueError):
    """A refusal, worded for the super admin, with the HTTP status it maps to."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def signature(ids: Iterable[str]) -> str:
    """What the preview showed, as one value the apply must send back."""
    return hashlib.sha256(",".join(sorted(ids)).encode()).hexdigest()


def _natural(ticket: str | None) -> list:
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", ticket or "")]


def _imported_unpaid():
    sheets = Q()
    for prefix in SHEET_PREFIXES:
        sheets |= Q(ticket_number__startswith=prefix)
    return data_fixes.queryset("paid_no_amount").filter(sheets)


def _really_paid(ids: list[str]) -> set[str]:
    """Of these claims, the ones with a real payment on record."""
    money = (
        Q(ledger_rows__amount__gt=MONEY) | Q(ledger_rows__amount__lt=-MONEY)
        | Q(ledger_rows__bank_export__isnull=False) | Q(ledger_rows__idempotency_key__isnull=False)
        | Q(actions__action="MARK_PAID")
    )
    return set(Claim.objects.filter(pk__in=ids).filter(money).values_list("pk", flat=True))


def _same(a: str | None, b: str) -> bool:
    """`__iexact`, for a value already read."""
    return (a or "").casefold() == b.casefold()


def _same_paper(row: dict[str, Any], d: str, eid: str, key: str) -> bool:
    """`claim_standing._match_q(d, eid, key)`, for a row already read: the DOI,
    the Scopus EID, or the title key, which only counts against a row with no
    DOI when this paper has one (a conference paper and its journal version)."""
    if d and _same(row["doi"], d):
        return True
    if eid and row["eid"] == eid:
        return True
    return bool(key) and row["normalized_title"] == key and (not d or not row["doi"])


def paid_before(claims: list[Claim]) -> set[str]:
    """The claims `payment_guards.earlier_payment` would refuse, for a whole list.

    The guard asks one claim at a time, in up to three queries, and its
    workbook lookup scans every old payment: sixty claims took five seconds.
    Here the same two questions are asked of the whole list in two reads:

    1. Another PAID claim of the same person is the same paper
       (`_same_paper`, the guard's `claim_standing._match_q`).
    2. The old workbook paid the same person for the same paper: staff id and
       DOI ignoring case, or the exact title key; a claim's own sheet row
       (`claim_ref` is its number) is not an earlier payment.

    A claim with no DOI, EID or usable title is never a match, as in the guard.
    `test_erp_remark.TheRepeatRuleIsThePayGuards` holds the answers equal.
    """
    keys: dict[str, tuple[str, str, str]] = {}
    for c in claims:
        key = normalize_title(c.paper_title)
        keys[c.pk] = (normalize_doi(c.doi) or "", c.eid or "", key if claim_standing.key_ok(key) else "")
    claims = [c for c in claims if any(keys[c.pk])]
    others: dict[str, list[dict[str, Any]]] = {}
    for row in (Claim.objects.filter(owner_id__in={c.owner_id for c in claims}, status=ClaimStatus.PAID)
                .values("id", "owner_id", "doi", "eid", "normalized_title")):
        others.setdefault(row["owner_id"], []).append(row)
    found = {
        c.pk for c in claims
        if any(o["id"] != c.pk and _same_paper(o, *keys[c.pk]) for o in others.get(c.owner_id, ()))
    }

    staff_of = {c.pk: (c.owner.staff_id or "").strip() for c in claims if c.pk not in found}
    wanted = {s.lower() for s in staff_of.values() if s}
    prior: dict[str, list[dict[str, Any]]] = {}
    if wanted:
        for p in (PriorPayment.objects.annotate(staff=Lower("employee_id")).filter(staff__in=wanted)
                  .values("employee_id", "doi", "normalized_title", "claim_ref")):
            prior.setdefault(p["employee_id"].casefold(), []).append(p)
    for c in claims:
        staff = staff_of.get(c.pk)
        if not staff:
            continue
        d, _eid, key = keys[c.pk]
        if any(
            not (c.ticket_number and p["claim_ref"] == c.ticket_number)
            and ((d and _same(p["doi"], d)) or (key and p["normalized_title"] == key))
            for p in prior.get(staff.casefold(), ())
        ):
            found.add(c.pk)
    return found


def _classify(*, lock: bool = False) -> tuple[list[Claim], list[tuple[Claim, str]]]:
    """(claims to change, claims held with the reason), by claim number.

    Held: "rejected on the accounts sheet" when the sheet's own Status, kept in
    `status_note` by the importer, maps to REJECTED; otherwise "possible
    repeat" when the pay guard would find an earlier payment (`paid_before`).
    """
    qs = _imported_unpaid().select_related("owner")
    if lock:
        qs = qs.select_for_update(of=("self",))
    claims = sorted(qs, key=lambda c: _natural(c.ticket_number))
    paid = _really_paid([c.pk for c in claims])
    claims = [c for c in claims if c.pk not in paid]
    rejected = {c.pk for c in claims if map_excel_status(c.status_note) == ClaimStatus.REJECTED}
    repeats = paid_before([c for c in claims if c.pk not in rejected])
    change: list[Claim] = []
    held: list[tuple[Claim, str]] = []
    for c in claims:
        if c.pk in rejected:
            held.append((c, HELD_REJECTED))
        elif c.pk in repeats:
            held.append((c, HELD_REPEAT))
        else:
            change.append(c)
    return change, held


def _claimant(c: Claim) -> dict[str, Any]:
    o = c.owner
    # `user_id` lets the renderer add the face (`core.faces.fill`).
    return {"id": o.pk, "user_id": o.pk, "name": o.name or o.email, "staff_id": o.staff_id or c.staff_id}


def _held_row(c: Claim, reason: str) -> dict[str, Any]:
    return {"claim_id": c.pk, "claim_no": c.ticket_number, "claimant": _claimant(c),
            "title": c.paper_title, "reason": reason}


def _change_row(c: Claim) -> dict[str, Any]:
    return {**_held_row(c, WHY), "status_before": c.status, "status_after": AFTER_STATUS}


def _batch_rows():
    return AuditLog.objects.filter(action=ACTION, entity=ENTITY)


def _undo_rows():
    return AuditLog.objects.filter(action=UNDO_ACTION, entity=ENTITY)


def _already_done() -> set[str]:
    """Claims a batch re-marked that no undo has put back."""
    restored = {u.entity_id: set(json.loads(u.detail_json).get("restored", [])) for u in _undo_rows()}
    done: set[str] = set()
    for b in _batch_rows():
        ids = {s["claim_id"] for s in json.loads(b.detail_json)["claims"]}
        done |= ids - restored.get(b.entity_id, set())
    return done


def preview() -> dict[str, Any]:
    """Exactly what `apply` would change now, and what it holds back. Writes nothing."""
    change, held = _classify()
    return {
        "will_change": [_change_row(c) for c in change],
        "held": [_held_row(c, why) for c, why in held],
        "counts": {
            "will_change": len(change),
            "held_repeat": sum(1 for _c, why in held if why == HELD_REPEAT),
            "held_rejected": sum(1 for _c, why in held if why == HELD_REJECTED),
            "already_done": len(_already_done()),
        },
        "signature": signature(c.pk for c in change),
        "after_status_label": AFTER_STATUS_LABEL,
    }


def _values(c: Claim) -> dict[str, Any]:
    return {
        "status": c.status,
        "paid_at": c.paid_at.isoformat() if c.paid_at else None,
        "payout_month": c.payout_month.isoformat() if c.payout_month else None,
        "voucher_number": c.voucher_number,
        "remuneration": c.remuneration,
    }


def _set(c: Claim, values: dict[str, Any]) -> None:
    c.status = values["status"]
    c.paid_at = parse_datetime(values["paid_at"]) if values["paid_at"] else None
    c.payout_month = parse_date(values["payout_month"]) if values["payout_month"] else None
    c.voucher_number = values["voucher_number"]
    c.remuneration = values["remuneration"]
    c.save(update_fields=[*FIELDS, "updated_at"])


def _reverse_import_payment(c: Claim, actor, batch_id: str) -> str | None:
    """Reverse the import's ₹0 payment row, so a real payment can follow it."""
    live = payment_guards.live_payment(c)
    if live is None:
        return None
    row = PaidLedger.objects.create(
        claim=c,
        kind=PaidLedger.Kind.REVERSAL,
        cycle=live.cycle,
        payout_month=live.payout_month,
        department=c.owner.department,
        faculty_name=c.owner.name,
        staff_id=c.staff_id or c.owner.staff_id,
        biometric_id=c.biometric_id or c.owner.biometric_id,
        paper_title=c.paper_title,
        journal_title=c.journal_title,
        # A candidate has no money on the ledger (`_really_paid`), so there is
        # nothing to net off: the row records that the ₹0 "payment" was not one.
        amount=0.0,
        voucher_number=f"{(c.voucher_number or 'VOID')[:59]}-VOID",
        raw_json=json.dumps({"voided_by": actor.email, "reason": WHY, "erp_remark": batch_id}),
    )
    return row.pk


def _remark(c: Claim, actor, batch_id: str) -> dict[str, Any]:
    before = _values(c)
    reversal = _reverse_import_payment(c, actor, batch_id)
    _set(c, {"status": AFTER_STATUS, "paid_at": None, "payout_month": None,
             "voucher_number": None, "remuneration": None})
    step = ClaimAction.objects.create(
        claim=c, actor=actor, from_status=before["status"], to_status=AFTER_STATUS, action=ACTION, note=WHY,
    )
    AuditLog.objects.create(
        actor=actor, action=ACTION, entity="Claim", entity_id=c.pk,
        detail_json=json.dumps({"batch": batch_id, "ticket": c.ticket_number,
                                "from": before["status"], "to": AFTER_STATUS}),
    )
    return {
        "claim_id": c.pk, "claim_no": c.ticket_number, "before": before, "after": _values(c),
        "reversal": reversal, "ledger_rows": c.ledger_rows.count(), "action": step.pk,
    }


def apply(
    actor,
    *,
    seen_signature: str,
    confirm: bool,
    include_only: Iterable[str] | None = None,
    exclude_claim_nos: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Re-mark what the preview listed, in one transaction.

    Refused unless confirmed and unless the list is still the one the preview
    signed (`seen_signature`), so a stale preview cannot be applied.
    `include_only` and `exclude_claim_nos` narrow the batch; neither can add a
    claim the preview did not list. The actor's own claim is skipped (nobody
    acts on their own).
    """
    if not confirm:
        raise RemarkError("Confirm the change first. It moves every listed claim out of Paid.")
    with transaction.atomic():
        change, _held = _classify(lock=True)
        if seen_signature != signature(c.pk for c in change):
            raise RemarkError(
                "The list has changed since the preview was made. Open the preview again and check it.", 409
            )
        by_no = {claim_numbers.dashed(c.ticket_number): c for c in change}
        wanted = None if include_only is None else [claim_numbers.dashed(n) for n in include_only]
        left_out = {claim_numbers.dashed(n) for n in exclude_claim_nos or ()}
        skipped: list[dict[str, str]] = [
            {"claim_no": n, "reason": "Not in the preview's list of claims to change."}
            for n in dict.fromkeys(wanted or ()) if n not in by_no
        ]
        targets: list[Claim] = []
        for no, c in by_no.items():
            if (wanted is not None and no not in wanted) or no in left_out:
                continue
            if rbac.is_own_claim(actor, c):
                skipped.append({"claim_no": c.ticket_number,
                                "reason": "Your own claim. Another super admin re-marks it."})
                continue
            targets.append(c)
        if not targets:
            return {"batch_id": None, "changed": 0, "skipped": len(skipped), "skipped_claims": skipped}
        batch_id = cuid()
        claims = [_remark(c, actor, batch_id) for c in targets]
        AuditLog.objects.create(
            actor=actor, action=ACTION, entity=ENTITY, entity_id=batch_id,
            detail_json=json.dumps({
                "signature": seen_signature, "after_status": AFTER_STATUS, "changed": len(claims),
                "claims": claims, "skipped": skipped,
            }),
        )
    return {"batch_id": batch_id, "changed": len(claims), "skipped": len(skipped), "skipped_claims": skipped}


def _moved_on(c: Claim | None, snap: dict[str, Any]) -> str | None:
    """Why this claim is no longer as the batch left it, or None."""
    if c is None:
        return "The claim no longer exists."
    if _values(c) != snap["after"]:
        return f"It has moved on since (now {c.status}), so it is left as it is."
    if c.ledger_rows.count() != snap["ledger_rows"]:
        return "The ledger has changed for it since, so it is left as it is."
    ours = ClaimAction.objects.filter(pk=snap["action"]).values_list("created_at", flat=True).first()
    if ours is None or c.actions.exclude(pk=snap["action"]).filter(created_at__gte=ours).exists():
        return "Someone has acted on it since, so it is left as it is."
    return None


def undo(actor, batch_id: str) -> dict[str, Any]:
    """Put back exactly what a batch changed, on the claims nobody has touched since."""
    with transaction.atomic():
        batch = _batch_rows().select_for_update().filter(entity_id=batch_id).first()
        if batch is None:
            raise RemarkError("No such batch.", 404)
        if _undo_rows().filter(entity_id=batch_id).exists():
            raise RemarkError("This batch has already been undone.", 409)
        snaps = json.loads(batch.detail_json)["claims"]
        claims = Claim.objects.select_for_update(of=("self",)).in_bulk([s["claim_id"] for s in snaps])
        restored: list[str] = []
        skipped: list[dict[str, str]] = []
        for snap in snaps:
            c = claims.get(snap["claim_id"])
            why = _moved_on(c, snap)
            if why:
                skipped.append({"claim_id": snap["claim_id"], "claim_no": snap["claim_no"], "reason": why})
                continue
            _set(c, snap["before"])
            ClaimAction.objects.create(
                claim=c, actor=actor, from_status=AFTER_STATUS, to_status=c.status, action=UNDO_ACTION,
                note=f"Re-mark {batch_id} undone.",
            )
            AuditLog.objects.create(
                actor=actor, action=UNDO_ACTION, entity="Claim", entity_id=c.pk,
                detail_json=json.dumps({"batch": batch_id, "ticket": c.ticket_number,
                                        "from": AFTER_STATUS, "to": c.status}),
            )
            restored.append(c.pk)
        AuditLog.objects.create(
            actor=actor, action=UNDO_ACTION, entity=ENTITY, entity_id=batch_id,
            detail_json=json.dumps({"restored": restored, "skipped": skipped}),
        )
    return {"restored": len(restored), "skipped": skipped}


def batches(limit: int = 50) -> list[dict[str, Any]]:
    """Past applies, newest first, and whether each has been undone."""
    rows = list(_batch_rows().select_related("actor").order_by("-created_at")[:limit])
    undone = {u.entity_id: u for u in _undo_rows().filter(entity_id__in=[r.entity_id for r in rows])}
    out = []
    for r in rows:
        u = undone.get(r.entity_id)
        out.append({
            "batch_id": r.entity_id,
            "at": r.created_at.isoformat(),
            "by": (r.actor.name or r.actor.email) if r.actor else None,
            "changed": json.loads(r.detail_json)["changed"],
            "undone": u is not None,
            "undone_at": u.created_at.isoformat() if u else None,
            "restored": len(json.loads(u.detail_json)["restored"]) if u else 0,
        })
    return out


__all__ = [
    "ACTION", "UNDO_ACTION", "ENTITY", "AFTER_STATUS", "AFTER_STATUS_LABEL", "HELD_REPEAT", "HELD_REJECTED",
    "RemarkError", "signature", "paid_before", "preview", "apply", "undo", "batches",
]
