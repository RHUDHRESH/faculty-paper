"""Putting right the claims brought across from the old ERP.

`core.services.data_fixes` decides *which* claims are wrong and counts them, so
Home, Admin, Track, Faults and the fix page all count the same set the same
way. This module is the other half: what the fix page shows for each claim
(with a hint where the ledger or the policy already knows the answer) and how a
correction is written.

The kinds are the ones `data_fixes.KINDS` names:

* ``paid_no_amount``  paid, with no amount and no note saying that was meant;
* ``untitled``        no title, or a placeholder such as "-";
* ``no_quartile``     no quartile, worth up to Rs 50,000 of the payout;
* ``no_claimant``     the old row named someone who is not on the faculty list.

A fix goes through ``apply_fix``: it changes the claim, writes the balancing
ledger row when a settled amount changes (the ledger is append-only), records
who did it and why, and reports whether the ledger now agrees with the claim.
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone

from core.models import AuditLog, Claim, ClaimAction, ClaimStatus, PaidLedger, Role, User
from core.services import data_fixes as base
from core.services.normalize import normalize_title

KINDS = tuple(k for k, _label, _why in base.KINDS)
QUARTILES = ("Q1", "Q2", "Q3", "Q4", "Others")
#: The note the accounts workbook uses for papers that are processed for the
#: count only. A paid claim carrying it is not a lost amount.
NO_PAYMENT_NOTE = "No remuneration. Processed only for count."
MIN_REASON = 10

_BLANK = re.compile(r"^[\s\-–—_.]*$")
_PLACEHOLDERS = {"untitled", "n/a", "na", "none", "nil", "null", "title", "no title"}


def is_blank_title(title: str | None) -> bool:
    text = (title or "").strip()
    return bool(_BLANK.match(text)) or text.lower() in _PLACEHOLDERS


def paid_without_amount():
    return base.queryset("paid_no_amount")


def untitled():
    return base.queryset("untitled")


def missing_quartile():
    return base.queryset("no_quartile")


def in_review(qs):
    return qs.filter(status__in=[ClaimStatus.SUBMITTED, ClaimStatus.CLEARED])


def counts() -> dict[str, int]:
    """Real numbers, from the one service. The queue and Faults show these."""
    out = {key: base.queryset(key).count() for key in KINDS}
    out["no_quartile_in_review"] = in_review(base.queryset("no_quartile")).count()
    out["claims"] = base.total()
    return out


def ledger_check(claim: Claim) -> dict[str, Any]:
    """Does the ledger agree with what the claim says was paid?"""
    agg = claim.ledger_rows.aggregate(total=Sum("amount"), n=Count("id"))
    total = float(agg["total"] or 0)
    paid = float(claim.remuneration or 0)
    return {
        "claim_amount": paid,
        "ledger_total": total,
        "ledger_rows": agg["n"],
        "matches": claim.status != ClaimStatus.PAID or abs(paid - total) < 0.01,
    }


def _suggest(claim: Claim) -> dict[str, Any] | None:
    """What the current policy would pay this paper, from what is on record.

    Only a hint for the admin, never applied on its own: the amount that was
    really paid is in the accounts, not in the formula.
    """
    from core.api.common import price_claim
    from core.models import FormulaConfig
    from core.services.remuneration import formula_from_model

    cfg_obj = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = formula_from_model(cfg_obj) if cfg_obj else None
    try:
        result = price_claim(claim, cfg, allow_self_reported=True)
    except Exception:  # a hint must never take the queue down
        return None
    if result.error or not result.remuneration or result.remuneration <= 0:
        return None
    return {"amount": float(result.remuneration), "note": result.note or None}


def _ledger_matches(claim: Claim, index=None) -> list[dict]:
    """Payments already in the ledger, with no claim, that name this paper.

    For an imported claim with no amount, this is usually the real answer: the
    accounts workbook recorded what was paid, and the claim never got it.
    """
    from core.services import ledger_checks

    return ledger_checks.matches_for_claim(claim, index)


def _last_fixes(claim_ids: list[str]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    rows = (
        AuditLog.objects.filter(action="CLAIM_DATA_FIX", entity="Claim", entity_id__in=claim_ids)
        .select_related("actor")
        .order_by("created_at")
    )
    for r in rows:
        out[r.entity_id] = {
            "by": r.actor.name if r.actor else "System",
            "at": r.created_at.isoformat(),
        }
    return out


def row_for(claim: Claim, issues: list[str], *, with_suggestion: bool = True, last: dict | None = None, orphans=None) -> dict:
    ledger = claim.ledger_rows.all()
    ledger_total = sum(r.amount or 0 for r in ledger)
    wants_amount = "paid_no_amount" in issues
    return {
        "id": claim.id,
        "ticket_number": claim.ticket_number,
        "imported": bool(claim.ticket_number and claim.ticket_number.startswith("ERP-")),
        # The shape Home, Admin and Track read.
        "owner_id": claim.owner_id,
        "owner_name": claim.owner.name,
        "owner_department": claim.owner.department,
        "paper_title": claim.paper_title,
        "journal_title": claim.journal_title,
        "problems": [{"key": k, "label": base.PROBLEM_WORDS[k]} for k in issues],
        # What the fix page needs to put each one right.
        "title": claim.paper_title,
        "journal": claim.journal_title,
        "year": claim.publication_year,
        "status": claim.status,
        "owner": {"user_id": claim.owner_id, "name": claim.owner.name or claim.owner.email},
        "department": claim.owner.department,
        "amount": claim.remuneration,
        "quartile": claim.quartile,
        "claimed_quartile": claim.self_reported_quartile,
        "month_paid": claim.payout_month.isoformat() if claim.payout_month else None,
        "status_note": claim.status_note,
        "ledger_total": float(ledger_total),
        "ledger_rows": len(ledger),
        "issues": issues,
        "suggestion": _suggest(claim) if with_suggestion and wants_amount else None,
        "ledger_matches": _ledger_matches(claim, orphans) if with_suggestion and wants_amount else [],
        "last_fix": last,
    }


def queue(kind: str | None = None, stage: str | None = None, limit: int = 300, offset: int = 0) -> dict[str, Any]:
    """One row per claim, with every gap it has. `kind` is one of `KINDS`;
    `stage` narrows to claims still in review or already paid."""
    sets = {k: base.queryset(k) for k in KINDS}
    if stage == "review":
        sets = {k: in_review(v) for k, v in sets.items()}
    elif stage == "paid":
        sets = {k: v.filter(status=ClaimStatus.PAID) for k, v in sets.items()}
    wanted = [k for k in KINDS if not kind or kind == k]
    membership: dict[str, list[str]] = {}
    for k in KINDS:
        for pk in sets[k].values_list("pk", flat=True):
            membership.setdefault(pk, []).append(k)
    ids = [pk for pk, ks in membership.items() if any(k in wanted for k in ks)]
    total = len(ids)
    claims = list(
        Claim.objects.filter(pk__in=ids)
        .select_related("owner")
        .prefetch_related("ledger_rows")
        .order_by("ticket_number")
    )
    from core.services import ledger_checks

    orphans = ledger_checks.orphan_index()
    # The easiest first: a claim whose payment is already in the ledger needs
    # one click, not a trip to the accounts register. Only the page asked for
    # is worked out in full (the policy hint is the expensive part).
    claims.sort(
        key=lambda c: (
            not ("paid_no_amount" in membership[c.pk] and _ledger_matches(c, orphans)),
            c.ticket_number or "",
        )
    )
    page = claims[offset : offset + limit]
    last = _last_fixes([c.pk for c in page])
    return {
        "counts": counts(),
        "total": total,
        "limit": limit,
        "offset": offset,
        "rows": [row_for(c, membership[c.pk], last=last.get(c.pk), orphans=orphans) for c in page],
    }


class FixError(ValueError):
    """A fix that cannot be applied; the message is written for the admin."""


def apply_fix(
    actor,
    claim_id: str,
    *,
    amount: float | None = None,
    title: str | None = None,
    quartile: str | None = None,
    no_payment: bool = False,
    link_ledger_row_id: str | None = None,
    owner_email: str | None = None,
    reason: str,
) -> dict[str, Any]:
    reason = (reason or "").strip()
    if len(reason) < MIN_REASON:
        raise FixError("Say where the correction comes from (at least 10 characters). It is kept with the change.")
    if amount is None and title is None and quartile is None and not no_payment and not owner_email:
        raise FixError("Nothing to change. Enter an amount, a title, a quartile or the claimant.")
    if amount is not None and no_payment:
        raise FixError("Choose either an amount or no payment due, not both.")

    from core.api.common import _apply_calc, _refuse_own_claim

    with transaction.atomic():
        claim = Claim.objects.select_for_update().select_related("owner").get(pk=claim_id)
        _refuse_own_claim(actor, claim)
        before: dict[str, Any] = {}
        after: dict[str, Any] = {}

        if title is not None:
            title = title.strip()
            if is_blank_title(title):
                raise FixError("That is not a title. Type the paper's real title.")
            if len(title) > 2000:
                raise FixError("The title is too long.")
            if title != (claim.paper_title or ""):
                before["paper_title"], after["paper_title"] = claim.paper_title, title
                claim.paper_title = title
                claim.normalized_title = normalize_title(title)

        if quartile is not None:
            quartile = quartile.strip()
            if quartile not in QUARTILES:
                raise FixError("Quartile must be Q1, Q2, Q3, Q4 or Others.")
            if quartile != (claim.quartile or ""):
                before["quartile"], after["quartile"] = claim.quartile, quartile
                claim.quartile = quartile
                claim.quartile_source = "MANUAL"
                claim.manual_verified_by = actor
                claim.manual_verified_at = timezone.now()
                claim.manual_verification_note = reason[:500]
                # An unpaid claim's amount depends on its quartile: the formula
                # runs again. A settled one keeps what was paid.
                if claim.status != ClaimStatus.PAID:
                    old_amount = claim.remuneration
                    _apply_calc(claim)
                    if claim.remuneration != old_amount:
                        before["remuneration"], after["remuneration"] = old_amount, claim.remuneration

        if amount is not None:
            if claim.status != ClaimStatus.PAID:
                raise FixError(
                    "Only a paid claim's amount can be entered by hand. "
                    "An unpaid claim is priced by the policy once its figures are set."
                )
            try:
                amount = float(amount)
            except (TypeError, ValueError):
                raise FixError("The amount must be a number.")
            if not math.isfinite(amount) or amount <= 0:
                raise FixError("The amount must be more than ₹0. If nothing was due, choose no payment due.")
            if amount > 10_000_000:
                raise FixError("That amount is more than ₹1,00,00,000. Check for an extra digit.")
            before["remuneration"], after["remuneration"] = claim.remuneration, round(amount, 2)
            claim.remuneration = round(amount, 2)
            claim.remuneration_note = f"Amount entered from the accounts records: {reason}"[:500]
            if link_ledger_row_id:
                # The payment is already in the ledger, unattached. Attaching
                # it is the fix; adding a second row for the same money would
                # count it twice.
                orphan = PaidLedger.objects.select_for_update().filter(pk=link_ledger_row_id).first()
                if orphan is None or orphan.claim_id:
                    raise FixError("That ledger payment is not available to link. Reload the list.")
                orphan.claim = claim
                orphan.save(update_fields=["claim"])
                before["ledger_payment"], after["ledger_payment"] = None, f"{orphan.amount:g} linked"

        if no_payment:
            before["status_note"], after["status_note"] = claim.status_note, NO_PAYMENT_NOTE
            claim.status_note = NO_PAYMENT_NOTE

        if owner_email:
            new_owner = User.objects.filter(email__iexact=owner_email.strip()).first()
            if new_owner is None:
                raise FixError("No account has that email.")
            from core.services import rbac

            if new_owner.role not in rbac.CLAIMANT_ROLES:
                raise FixError("Claims belong to the staff who file them: faculty, a head of department, or an officer filing their own paper.")
            if new_owner.id != claim.owner_id:
                before["owner"], after["owner"] = claim.owner.name or claim.owner.email, new_owner.name or new_owner.email
                claim.owner = new_owner
                # The identity columns travel with the claim, or the ledger
                # would keep paying the person it was moved away from.
                claim.staff_id = new_owner.staff_id or claim.staff_id
                claim.biometric_id = new_owner.biometric_id or claim.biometric_id
                claim.ledger_rows.update(
                    faculty_name=new_owner.name,
                    staff_id=new_owner.staff_id,
                    biometric_id=new_owner.biometric_id,
                    department=new_owner.department,
                )

        if not after:
            return {"ok": True, "changed": {}, "row": None, "ledger": ledger_check(claim)}

        claim.save()

        money_changed = "remuneration" in after and claim.status == ClaimStatus.PAID
        if money_changed:
            delta = (claim.remuneration or 0) - float(
                claim.ledger_rows.aggregate(s=Sum("amount"))["s"] or 0
            )
            if abs(delta) > 0.01:
                PaidLedger.objects.create(
                    claim=claim,
                    payout_month=claim.payout_month or timezone.now().date().replace(day=1),
                    department=claim.owner.department,
                    faculty_name=claim.owner.name,
                    staff_id=claim.staff_id,
                    biometric_id=claim.biometric_id,
                    paper_title=claim.paper_title,
                    journal_title=claim.journal_title,
                    amount=delta,
                    voucher_number=f"{claim.voucher_number or claim.ticket_number}-ADJ",
                )

        check = ledger_check(claim)
        ClaimAction.objects.create(claim=claim, actor=actor, action="ADMIN_EDIT", note=reason[:500])
        AuditLog.objects.create(
            actor=actor,
            action="CLAIM_DATA_FIX",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps(
                {
                    "reason": reason,
                    "before": {k: v for k, v in before.items()},
                    "after": {k: v for k, v in after.items()},
                    "ledger_matches": check["matches"],
                },
                default=str,
            )[:20000],
        )
        claim = Claim.objects.select_related("owner").prefetch_related("ledger_rows").get(pk=claim.pk)
        issues = [k for k in KINDS if base.queryset(k).filter(pk=claim.pk).exists()]
        return {
            "ok": True,
            "changed": {k: v for k, v in after.items()},
            "ledger": check,
            "row": row_for(claim, issues, last={"by": actor.name, "at": timezone.now().isoformat()}),
        }
