"""Track: where every claim is, in one view.

GET /track -> the stage board (a count, and for roles that may see money a
total, per stage, with how long claims have sat there) and the claims behind
it as a searchable, filterable, pageable list.

Who sees what, decided here and not left to the screen:

- The office roles, the Principal, the Director and Finance see the whole
  college. Everyone but a head sees the amount on every claim.
- Discrepancy flags and duplicate matches only reach the desks that judge a
  paper (`rbac.can_review_flags`). The Director and Finance get neither key,
  not even as a zero.
- A head of department sees only their own department, no amount at all (not
  even on their own papers: this is a department view), and the coarser
  stages `hod.PROGRESS` already defines -- never which desk holds a paper,
  never "on hold", never "paid". Days are counted from filing, so a clock
  that restarts at each desk cannot tell them who has it.
- A faculty member has My papers, which speaks of their own claims in their
  own words; this endpoint refuses them.

Rows are deliberately not shaped like a claim (no `status`, no
`rejected_outright`), so the renderer's claimant rules do not mistake an
officer's own row for a paper to be reshaped, and each row names its stage
under `stage`, in words the vocabulary allows.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any, Optional

from django.db.models import Q
from django.db.models.functions import Coalesce
from django.http import HttpRequest
from django.utils import timezone
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.models import Claim, ClaimFlag, ClaimStatus, Role
from core.services import data_fixes, rbac

#: The accounts workbook pays some papers nothing on purpose.
_COUNT_ONLY = re.compile(r"only for count|no\s*re[nm]u", re.I)


def _amount_note(c: Claim, stage: str) -> tuple[str, str | None]:
    """(what to say, and why) where a claim has no amount, in place of a blank.

    A blank cell is read as "lost", and for most imported paid claims that is
    wrong: the accounts sheet paid them nothing on purpose. So say which it is.
    Both are "\u20b90" where nothing was payable, so the column adds up to the
    Paid total; "Not recorded" is kept for a figure that is genuinely missing.
    """
    if stage == "paid":
        if _COUNT_ONLY.search(c.status_note or ""):
            return "\u20b90", "counted only"
        imported = (c.ticket_number or "").startswith("ERP-")
        return "Not recorded", "in the old ERP" if imported else None
    if c.quota_applied:
        return "\u20b90", "inside the research threshold"
    if c.calc_error:
        return "Cannot be priced", None
    return "Not priced yet", None

#: Roles that may open the Track view: everybody who is not a claimant only.
TRACK_ROLES = (*rbac.ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE, Role.HOD)

#: (key, label, who has it). The main path, in order.
MAIN_STAGES = (
    ("submitted", "Submitted", "Waiting for the research cell to clear it"),
    ("checked", "Being checked", "Cleared by the research cell, waiting for the Principal"),
    ("approved", "Approved", "Approved by the Principal, waiting for the Director"),
    ("authorised", "Authorised", "Authorised by the Director, waiting for Finance to pay"),
    ("paid", "Paid", "Paid out"),
)
#: Off the main path.
SIDE_STAGES = (
    ("sent_back", "Sent back", "With the claimant to correct and send again"),
    ("on_hold", "On hold", "Paused at a desk, with a reason. The desk queue still counts it"),
    ("not_accepted", "Not accepted", "Refused for good"),
)
STAGE_LABEL = {k: label for k, label, _ in (*MAIN_STAGES, *SIDE_STAGES)}

#: What a head sees: the words `hod.PROGRESS` uses, four steps.
HOD_STAGES = (
    ("review", "Under review", "With the college"),
    ("approved", "Approved", "Approved, payment in progress"),
    ("completed", "Completed", "Finished"),
    ("sent_back", "Sent back", "With the claimant to correct"),
)
HOD_LABEL = {k: label for k, label, _ in HOD_STAGES}

#: Whole days in a stage; the ageing split the desks already use.
AGE_BUCKETS = (("week", "Up to a week", 7), ("fortnight", "8 to 14 days", 14),
               ("month", "15 to 30 days", 30), ("older", "Over 30 days", None))

_STAGE_OF_STATUS = {
    ClaimStatus.SUBMITTED: "submitted",
    ClaimStatus.HOD_APPROVED: "submitted",
    ClaimStatus.CLEARED: "checked",
    ClaimStatus.RESEARCH_APPROVED: "checked",
    ClaimStatus.PRINCIPAL_APPROVED: "approved",
    ClaimStatus.DIRECTOR_APPROVED: "authorised",
    ClaimStatus.FINANCE_APPROVED: "authorised",
    ClaimStatus.PAID: "paid",
}
_HOD_OF_STAGE = {
    "submitted": "review", "checked": "review", "on_hold": "review",
    "approved": "approved", "authorised": "approved",
    "paid": "completed", "sent_back": "sent_back", "not_accepted": "sent_back",
}
#: Stages where nobody at a desk is holding the claim: it has finished, or it
#: is with the claimant. `moving=1` leaves these out of the list so a home
#: page can ask "what has waited longest" without a paid claim answering.
_NOT_MOVING = ("paid", "completed", "not_accepted", "sent_back")
_HOLDABLE = (ClaimStatus.SUBMITTED, ClaimStatus.CLEARED, ClaimStatus.HOD_APPROVED,
             ClaimStatus.RESEARCH_APPROVED)

_LIGHT = (
    "id", "status", "on_hold", "rejected_outright", "remuneration",
    "submitted_at", "created_at", "cleared_at", "principal_approved_at",
    "director_approved_at", "paid_at", "held_at", "updated_at", "owner__department",
)


def _stage_of(status: str, on_hold: bool, rejected_outright: bool) -> str:
    if status == ClaimStatus.REJECTED:
        return "not_accepted" if rejected_outright else "sent_back"
    if on_hold and status in _HOLDABLE:
        return "on_hold"
    return _STAGE_OF_STATUS.get(status, "submitted")


def _since(stage: str, r: dict) -> Optional[datetime]:
    """When the claim arrived at its stage; the last touch if that was not recorded."""
    filed = r["submitted_at"] or r["created_at"]
    at = {
        "submitted": filed,
        "checked": r["cleared_at"],
        "approved": r["principal_approved_at"],
        "authorised": r["director_approved_at"],
        "paid": r["paid_at"],
        "on_hold": r["held_at"],
    }.get(stage)
    return at or r["updated_at"] or filed


def _days(since: Optional[datetime], now: datetime) -> Optional[int]:
    return max(0, (now - since).days) if since else None


def _scope(user):
    """Claims this viewer may see here. Drafts belong to their author alone."""
    qs = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    if user.role == Role.HOD:
        department = hod.department_of(user)
        if not department:
            raise HttpError(
                400,
                "This account has no department set, so there is nothing to show. "
                "Ask the research cell to set it.",
            )
        return qs.filter(owner__department__iexact=department)
    return qs


def _bucket(days: Optional[int]) -> str:
    d = days or 0
    for key, _label, top in AGE_BUCKETS:
        if top is None or d <= top:
            return key
    return "older"


@api.get("/track", auth=session_auth)
def track(
    request: HttpRequest,
    stage: Optional[str] = None,
    department: Optional[str] = None,
    month: Optional[str] = None,
    q: Optional[str] = None,
    owner: Optional[str] = None,
    fix: Optional[str] = None,
    moving: bool = False,
    exclude: Optional[str] = None,
    sort: str = "oldest",
    limit: int = 25,
    offset: int = 0,
):
    user = require_user(request)
    if user.role not in TRACK_ROLES:
        raise HttpError(403, "Your own claims are under My papers.")

    is_head = user.role == Role.HOD
    sees_money = not is_head
    sees_flags = rbac.can_review_flags(user.role)
    now = timezone.now()

    base = _scope(user)
    # Options for the filters come from the whole scope, so choosing a month
    # does not make the other months vanish from the list.
    filed = Coalesce("submitted_at", "created_at")
    seen = base.annotate(filed_at=filed).values_list("owner__department", "filed_at")
    departments = sorted({(d or "").strip() for d, _ in seen if (d or "").strip()}, key=str.lower)
    months = sorted({f.strftime("%Y-%m") for _, f in seen if f}, reverse=True)[:36]

    qs = base
    if department and not is_head:
        qs = qs.filter(owner__department__iexact=department.strip())
    if month:
        try:
            y, m = (int(x) for x in month.split("-"))
            start = datetime(y, m, 1, tzinfo=timezone.get_current_timezone())
            end = datetime(y + (m == 12), 1 if m == 12 else m + 1, 1, tzinfo=timezone.get_current_timezone())
        except (ValueError, TypeError):
            raise HttpError(400, "Month must look like 2026-09.")
        qs = qs.annotate(filed_at=filed).filter(filed_at__gte=start, filed_at__lt=end)
    if owner:
        qs = qs.filter(owner_id=owner)
    if fix and user.role in rbac.ADMIN_ROLES:
        # Old-ERP claims that need a person: "1" for any problem, or one kind.
        kinds = [k for k, _l, _w in data_fixes.KINDS if fix in ("1", k)]
        ids: set[str] = set()
        for k in kinds:
            ids.update(data_fixes.queryset(k).values_list("id", flat=True))
        qs = qs.filter(id__in=ids)
    if q and q.strip():
        term = q.strip()
        qs = qs.filter(
            Q(ticket_number__icontains=term)
            | Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(doi__icontains=term)
            | Q(owner__name__icontains=term)
        )

    rows = list(qs.values(*_LIGHT))
    flagged: set[str] = set()
    if sees_flags and rows:
        flagged = set(
            ClaimFlag.objects.filter(resolved_at__isnull=True, claim__in=[r["id"] for r in rows])
            .values_list("claim_id", flat=True)
        )

    keys = HOD_STAGES if is_head else (*MAIN_STAGES, *SIDE_STAGES)
    board = {
        k: {"key": k, "label": label, "caption": caption, "count": 0,
            "oldest_days": None, "_days": [],
            "ageing": {b[0]: 0 for b in AGE_BUCKETS}}
        for k, label, caption in keys
    }
    if sees_money:
        for s in board.values():
            s["amount"] = 0.0
    if sees_flags:
        for s in board.values():
            s["flagged"] = 0

    skip = {s.strip() for s in (exclude or "").split(",") if s.strip()}
    picked: list[tuple[str, int, dict]] = []  # (days, sort key, row) for the list
    for r in rows:
        st = _stage_of(r["status"], r["on_hold"], r["rejected_outright"])
        since = _since(st, r)
        if is_head:
            st = _HOD_OF_STAGE[st]
            since = r["submitted_at"] or r["created_at"]
        days = _days(since, now)
        slot = board[st]
        slot["count"] += 1
        if sees_money:
            slot["amount"] += float(r["remuneration"] or 0)
        if sees_flags and r["id"] in flagged:
            slot["flagged"] += 1
        # Ageing means waiting. A finished claim has no age worth a bucket.
        if st not in ("paid", "completed", "not_accepted"):
            slot["ageing"][_bucket(days)] += 1
            slot["_days"].append(days or 0)
        if (moving and st in _NOT_MOVING) or st in skip:
            continue
        if not stage or stage == st:
            picked.append((days if days is not None else -1, r["remuneration"] or 0, {"id": r["id"], "stage": st, "days": days, "since": since}))

    stages = []
    for s in board.values():
        ds = s.pop("_days")
        s["oldest_days"] = max(ds) if ds else None
        s["average_days"] = round(sum(ds) / len(ds)) if ds else None
        if s["key"] in ("paid", "completed", "not_accepted"):
            s["ageing"] = None
        if sees_money:
            s["amount"] = round(s["amount"], 2)
        stages.append(s)

    if sort == "newest":
        picked.sort(key=lambda t: t[0])
    elif sort == "amount" and sees_money:
        picked.sort(key=lambda t: -t[1])
    else:
        picked.sort(key=lambda t: -t[0])

    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    page = picked[offset: offset + limit]
    details = {
        c.id: c for c in Claim.objects.filter(id__in=[p[2]["id"] for p in page]).select_related("owner")
    }
    labels = HOD_LABEL if is_head else STAGE_LABEL
    is_office = user.role in rbac.ADMIN_ROLES
    fixes = data_fixes.problems_for([p[2]["id"] for p in page]) if is_office else {}
    out: list[dict[str, Any]] = []
    for _d, _a, meta in page:
        c = details.get(meta["id"])
        if c is None:
            continue
        row: dict[str, Any] = {
            "id": c.id,
            "ticket_number": c.ticket_number,
            "owner_id": c.owner_id,
            "owner_name": c.owner.name,
            "owner_department": c.owner.department,
            "paper_title": c.paper_title,
            "journal_title": c.journal_title,
            "quartile": c.quartile,
            "publication_year": c.publication_year,
            "stage": meta["stage"],
            "stage_label": labels[meta["stage"]],
            "days_in_stage": meta["days"],
            "since": meta["since"].isoformat() if meta["since"] else None,
            "is_mine": c.owner_id == user.pk,
        }
        if sees_money:
            row["amount"] = c.remuneration or None
            if not c.remuneration:
                row["amount_note"], row["amount_reason"] = _amount_note(c, meta["stage"])
        if meta["stage"] == "paid":
            # The month the money went out; a real date only for a claim paid in
            # this system. An imported claim's `paid_at` is the day of the
            # import, which says nothing about when anyone was paid.
            imported = (c.ticket_number or "").startswith("ERP-")
            if imported and c.payout_month:
                when, month_only = c.payout_month, True
            elif c.paid_at:
                when, month_only = c.paid_at, False
            else:
                when, month_only = c.payout_month, True
            row["paid_on"] = when.isoformat()[:10] if when else None
            row["paid_month_only"] = month_only
        if is_office:
            row["fixes"] = [data_fixes.PROBLEM_WORDS[k] for k in fixes.get(c.id, [])]
        if sees_flags:
            row["open_flags"] = 1 if c.id in flagged else 0
            row["duplicate"] = bool(c.duplicate_warning and not c.override_duplicate)
        out.append(row)

    return {
        "scope": "department" if is_head else "college",
        "department": hod.department_of(user) if is_head else None,
        "sees_money": sees_money,
        "sees_flags": sees_flags,
        "stages": stages,
        "total_claims": len(rows),
        "total": len(picked),
        "limit": limit,
        "offset": offset,
        "departments": [] if is_head else departments,
        "months": months,
        "results": out,
        "checked_at": now.isoformat(),
    }


def _rs(n: float | None) -> str:
    """₹ with Indian digit grouping (1,09,265), paise only when there are some."""
    if n is None:
        return "not recorded"
    neg = n < 0
    whole, frac = divmod(round(abs(n) * 100), 100)
    s = str(whole)
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts + [tail])
    return f"{'-' if neg else ''}₹{s}" + (f".{frac:02d}" if frac else "")


def _num(v: Any) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _sheet_terms(ledger_rows: list) -> list[dict[str, Any]]:
    """The working the old ERP's accounts sheet carried, when it did.

    Its row has the SNIP, the quartile incentive, `(SNIP * 55000)+QF` and the
    author's position points. Those are copied as they stand: the amount was
    decided by that sheet, and working it out again here could disagree.
    """
    for r in ledger_rows:
        try:
            raw = json.loads(r.raw_json or "{}")
        except ValueError:
            continue
        snip, qf, points = _num(raw.get("SNIP Value")), _num(raw.get("QF Amount")), _num(raw.get("Author Position Points"))
        base_key = next((k for k in raw if "SNIP" in k and "QF" in k and "*" in k), None)
        base = _num(raw.get(base_key)) if base_key else None
        if base is None and snip is None and points is None:
            continue
        rate = None
        if base_key:
            m = re.search(r"\*\s*([\d,]+)", base_key)
            rate = _num(m.group(1)) if m else None
        terms: list[dict[str, Any]] = []
        if snip:
            terms.append({
                "label": "SNIP", "amount": round(snip * rate, 2) if rate else None,
                "detail": f"{snip:g}" + (f" x {_rs(rate)} = {_rs(snip * rate)}" if rate else ""),
            })
        if qf:
            q = raw.get("SJR Quartile")
            terms.append({"label": "Quartile incentive", "amount": qf,
                          "detail": f"{q + ' adds ' if q else 'Adds '}{_rs(qf)}"})
        if base is not None:
            terms.append({"label": "Value of the paper", "amount": base,
                          "detail": "What the whole paper is worth before it is shared among its authors"})
        if points is not None:
            pos, tot = raw.get("Author Position"), raw.get("Total No of Authors")
            who = f"Author {int(_num(pos))} of {int(_num(tot))} takes " if _num(pos) and _num(tot) else "The author takes "
            terms.append({"label": "This author's share", "amount": None, "detail": f"{who}{points:g} of the paper"})
        return terms
    return []


@api.get("/claims/{claim_id}/why-amount", auth=session_auth)
def why_amount(request: HttpRequest, claim_id: str):
    """Why this claim came to this amount, line by line.

    Read from what was stored when the claim was priced (the policy version it
    was priced under, the SNIP, the quartile, the author's share) rather than
    priced again, so it explains the amount that was actually decided. Only the
    roles that see money: a head of department never does.
    """
    from core.models import FormulaConfig, PaidLedger
    from core.services.remuneration import CATEGORY_LABELS

    user = require_user(request)
    if user.role not in (*rbac.ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE):
        raise HttpError(403, "Amounts are not shown to this account.")
    c = Claim.objects.select_related("owner", "formula_config").filter(pk=claim_id).first()
    if c is None or c.status == ClaimStatus.DRAFT:
        raise HttpError(404, "No such claim.")

    try:
        snap = json.loads(c.formula_snapshot_json) if c.formula_snapshot_json else {}
    except ValueError:
        snap = {}
    active = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = c.formula_config
    policy = None
    if cfg or snap:
        name = (cfg.name if cfg else None) or snap.get("name") or "Policy"
        version = (cfg.version if cfg else None) or snap.get("version")
        policy = {
            "name": name,
            "version": version,
            "in_force_now": bool(cfg and active and cfg.pk == active.pk),
            "effective_from": cfg.effective_from.isoformat() if cfg and cfg.effective_from else None,
        }

    terms: list[dict[str, Any]] = []
    priced = c.base_amount is not None or c.remuneration_category is not None
    if priced:
        kind = ", ".join(x for x in (c.publication_type, c.indexing_level) if x and x != "-")
        if c.remuneration_category:
            terms.append({"label": "Which rate applies", "detail": CATEGORY_LABELS.get(
                c.remuneration_category, c.remuneration_category).replace(" — ", ": "), "amount": None})
        if kind:
            terms.append({"label": "The paper", "detail": kind, "amount": None})
        if c.snip:
            mult = snap.get("snip_multiplier")
            terms.append({
                "label": "SNIP",
                "detail": f"{c.snip:g}" + (f" x {_rs(mult)} = {_rs(c.snip * mult)}" if mult else ""),
                "amount": round(c.snip * mult, 2) if mult else None,
            })
        if c.qf_amount:
            terms.append({"label": "Quartile incentive", "detail": f"{c.quartile or 'Quartile'} adds {_rs(c.qf_amount)}",
                          "amount": c.qf_amount})
        if c.base_amount is not None:
            terms.append({"label": "Value of the paper", "detail": "What the whole paper is worth before it is shared among its authors",
                          "amount": c.base_amount})
        if c.author_point is not None:
            terms.append({
                "label": "This author's share",
                "detail": f"Author {c.author_position} of {c.total_authors} takes {c.author_point:g} of the paper",
                "amount": None,
            })
    threshold = None
    limit = float(active.high_value_threshold) if active and active.high_value_threshold else 0.0
    if limit > 0:
        amount = float(c.remuneration or 0)
        threshold = {
            "limit": limit,
            "over": amount >= limit,
            "detail": (
                f"Claims of {_rs(limit)} or more need a second signature before Finance pays."
                + (" This claim is over it." if amount >= limit else " This claim is under it.")
            ),
        }
    sheet_rows = list(PaidLedger.objects.filter(claim=c).order_by("payout_month", "created_at"))
    if not priced:
        terms = _sheet_terms(sheet_rows)
    ledger = [
        {
            "month": r.payout_month.isoformat()[:7] if r.payout_month else None,
            "voucher": r.voucher_number,
            "amount": r.amount,
            "kind": "Reversal" if (r.amount or 0) < 0 else "Payment",
        }
        for r in sheet_rows
    ]
    message = None
    note, reason = _amount_note(c, _stage_of(c.status, c.on_hold, c.rejected_outright))
    if not priced:
        if not c.remuneration and reason and reason == "counted only":
            message = (
                "The old ERP's accounts sheet paid nothing for this claim on purpose. It was processed only to "
                "count the paper, as a student publication or one with too few citations of the college's work. "
                "That is ₹0 in the Paid total."
            )
        elif terms:
            message = (
                "This claim came from the old ERP. The working below is copied from its accounts sheet, "
                "not worked out again here."
            )
        else:
            message = (
                c.calc_error
                or ("It came from the old ERP with an amount and no working. Only the amount and the ledger are on record."
                    if (c.ticket_number or "").startswith("ERP-") and c.remuneration
                    else "It has not been priced yet.")
            )
    return {
        "id": c.id,
        "ticket_number": c.ticket_number,
        "paper_title": c.paper_title,
        "owner_name": c.owner.name,
        "amount": c.remuneration or None,
        "amount_note": None if c.remuneration else note,
        "amount_reason": None if c.remuneration else reason,
        "priced": priced,
        "message": message,
        "policy": policy,
        "terms": terms,
        "quota": {"applied": True, "note": c.quota_note} if c.quota_applied else None,
        "note": c.remuneration_note,
        "threshold": threshold,
        "ledger": ledger,
        "ledger_total": round(sum(r["amount"] or 0 for r in ledger), 2),
    }


__all__ = ["track", "why_amount", "TRACK_ROLES", "MAIN_STAGES", "SIDE_STAGES", "HOD_STAGES"]
