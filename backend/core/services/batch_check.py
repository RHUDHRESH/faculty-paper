"""Anything unusual in a batch, found from the money records alone.

The Director looks at a batch before authorising it and Finance before paying
it. This is the part of "Check this batch" that decides what is unusual. It is
SQL and arithmetic over the claims, the ledger and the calculator; no model is
involved, so a server with AI off gives the same list and a model can never add
to it or take from it (`batch_check_ai` only words and ranks what is found here).

Six kinds of finding, each with a threshold that is a named constant below,
documented in docs/ux/20-ai.md and pinned by `test_batch_check.py`:

* ``amount_off_formula``   the recorded amount is far from what the calculator
  gives for the claim's own figures (`calculator.assess`: its pricing snapshot,
  then today's policy). "Far" is at least ``FAR_RUPEES`` and ``FAR_PERCENT`` of
  the formula figure; a claim the calculator cannot price at all is always shown.
* ``possible_repeat``      the same person has another claim, a ledger payment or a
  workbook payment for the same DOI, or for a title that is at least
  ``TITLE_RATIO`` alike (and at least ``TITLE_MIN`` characters long). Two
  different DOIs are two papers (a conference paper and its journal extension).
  A co-author's claim never counts: each author is paid their own share.
* ``first_payee``          the person has no payment on the ledger or in the old
  workbook, and no paid claim. Information only.
* ``large_amount``         the amount is more than ``LARGE_FACTOR`` times the
  ``LARGE_PERCENTILE``th percentile of what was paid for the same quartile in the
  same department (the college, when the department has fewer than
  ``MIN_PEERS`` paid claims for that quartile), and at least ``LARGE_FLOOR`` rupees.
* ``budget``               the batch sits inside a budget that is already over, or
  has less than ``THIN_LEFT`` of the allocation left (college, and each department
  in the batch that has an allocation).
* ``amount_changed``       the amount was changed in the last ``RECENT_DAYS`` days
  (a hand correction or a recalculation, from the audit log), or, when paying,
  the figure no longer equals the one the Director authorised.

What this never reads: the research cell's flags, the journal watch-list, the
duplicate sweep's findings, a contest note or any flag text. Every fact here is
an amount, a date, a count or a claim's own identifiers, so the Director and
Finance can be shown the result whole (`core.visibility`). The queue a person
sees never holds their own claim (`rbac.is_own_claim`), and is built the way
the desks build it (`api/director.py`, `api/admin.py`).
"""
from __future__ import annotations

import difflib
import json
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from django.db.models.functions import Lower
from django.utils import timezone

from core.models import AuditLog, Claim, ClaimStatus, PaidLedger, PriorPayment
from core.services import calculator, claim_standing
from core.services.normalize import normalize_doi, normalize_title
from core.services.remuneration import round2

#: Where the batch comes from. The authorise batch is what the Principal
#: approved; the pay batch is what the Director authorised.
STAGES = ("authorise", "pay")

#: The most claims one check reads. A real month is a few dozen; past this the
#: oldest are checked and the answer says so.
MAX_CLAIMS = 400

# --- thresholds (documented above, in docs/ux/20-ai.md, and tested) ---------
FAR_RUPEES = 1000.0
FAR_PERCENT = 5.0
TITLE_RATIO = 0.9
TITLE_MIN = 16
LARGE_FACTOR = 1.5
LARGE_PERCENTILE = 90
LARGE_FLOOR = 10000.0
MIN_PEERS = 8
THIN_LEFT = 0.10
RECENT_DAYS = 14

KINDS = ("amount_off_formula", "amount_changed", "possible_repeat", "budget", "large_amount", "first_payee")

SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

TITLES = {
    "amount_off_formula": "Amount differs from the calculator",
    "amount_changed": "Amount changed recently",
    "possible_repeat": "Looks like a repeat",
    "budget": "Budget",
    "large_amount": "Large for its group",
    "first_payee": "First payment to this person",
}

#: The audit entries that move a claim's amount, and where each keeps it.
_AMOUNT_ACTIONS = {
    "CLAIM_DATA_FIX": ("before", "after", "remuneration"),
    "CLAIM_ADMIN_EDIT": ("before", "after", "remuneration"),
    "CLAIM_RECALC_SKIP_EXTERNAL": (None, None, None),
    "CLAIM_RECALC_STORED_VALUES": (None, None, None),
}


def inr(n: float | None) -> str:
    """₹1,09,265 with Indian grouping, to the rupee unless there are paise."""
    from core.services import research_threshold

    return research_threshold.inr(float(n or 0))


def claims_for(stage: str, user, department: str | None = None) -> tuple[list[Claim], bool]:
    """The claims this person would act on, never their own. (claims, truncated)."""
    if stage == "authorise":
        qs = Claim.objects.filter(status=ClaimStatus.PRINCIPAL_APPROVED)
        order = "principal_approved_at"
    else:
        qs = Claim.objects.filter(status=ClaimStatus.DIRECTOR_APPROVED, director_approved_at__isnull=False)
        order = "director_approved_at"
    qs = qs.exclude(owner=user).select_related("owner", "formula_config")
    if department:
        qs = qs.filter(owner__department__iexact=department)
    qs = qs.defer(*calculator._HEAVY).order_by(order, "ticket_number")
    rows = list(qs[: MAX_CLAIMS + 1])
    return rows[:MAX_CLAIMS], len(rows) > MAX_CLAIMS


def _amount_of(c: Claim) -> float:
    return float(c.remuneration or 0.0)


def _is_far(delta: float, formula: float) -> bool:
    return abs(delta) >= FAR_RUPEES and abs(delta) >= formula * FAR_PERCENT / 100.0


def _claim_fields(c: Claim) -> dict[str, Any]:
    return {
        "claim_id": c.id,
        "ticket_number": c.ticket_number,
        "paper_title": (c.paper_title or "")[:200],
        "user_id": c.owner_id,
        "name": c.owner.name,
        "department": c.owner.department,
    }


def _finding(kind: str, severity: str, c: Claim | None, reason: str, facts: dict[str, Any], *,
             sort_money: float = 0.0, link: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "kind": kind,
        "severity": severity,
        "title": TITLES[kind],
        "reason": reason,
        "facts": facts,
        "_money": sort_money,
    }
    if c is not None:
        out.update(_claim_fields(c))
        out["link"] = None  # filled by `check`, which knows the queue
    else:
        out.update({"claim_id": None, "ticket_number": None, "paper_title": "", "user_id": None,
                    "name": None, "department": None, "link": link})
    return out


# ------------------------------------------------------------------- detectors


def amount_off_formula(claims: list[Claim]) -> list[dict[str, Any]]:
    ctx = calculator.Context()
    ids = [c.id for c in claims]
    sec = calculator.sec_reference_counts(ids)
    ledger = calculator.ledger_by_claim(ids)
    overrides = calculator.override_entries(ids)
    out = []
    for c in claims:
        a = calculator.assess(c, ctx, sec=sec.get(c.id, 0), ledger=ledger.get(c.id), override=overrides.get(c.id))
        recorded, full, formula = a["recorded"] or 0.0, a["full"], a["expected"]
        label = calculator.CAUSES[a["cause"]]["label"] if a["cause"] else None
        if a["cause"] in ("cannot_be_priced", "not_priced") and (recorded > 0 or a["cause"] == "cannot_be_priced"):
            out.append(_finding(
                "amount_off_formula", "high", c,
                f"The calculator cannot price this claim now, and it carries {inr(recorded)}.",
                {"recorded": round2(recorded), "formula": None, "difference": None, "cause": label},
                sort_money=recorded,
            ))
            continue
        if formula is None:
            continue
        today = a["today"]
        if a["cause"] and not calculator.CAUSES[a["cause"]]["expected"] and _is_far(a["delta"], formula):
            out.append(_finding(
                "amount_off_formula", "high", c,
                f"Recorded {inr(full)}, but the calculator gives {inr(formula)}, a difference of {inr(abs(a['delta']))}."
                f" {label}.",
                {"recorded": round2(full), "formula": round2(formula), "difference": round2(a["delta"]), "cause": label},
                sort_money=abs(a["delta"]),
            ))
        elif a["policy_moved"] and today is not None and _is_far(today - formula, formula):
            out.append(_finding(
                "amount_off_formula", "medium", c,
                f"Priced at {inr(formula)} under the policy then in force; today's policy gives {inr(today)}.",
                {"recorded": round2(full), "formula": round2(formula), "today": round2(today),
                 "difference": round2(today - formula), "cause": "The policy has changed since"},
                sort_money=abs(today - formula),
            ))
    return out


def _title_key(title: str | None) -> str:
    key = normalize_title(title)
    return key if claim_standing.key_ok(key) else ""


def _same_paper(doi_a, key_a, doi_b, key_b) -> bool:
    if doi_a and doi_b:
        return doi_a == doi_b
    if not key_a or not key_b:
        return False
    if key_a == key_b:
        return True
    return difflib.SequenceMatcher(None, key_a, key_b).ratio() >= TITLE_RATIO


def _month_word(d: date | None) -> str:
    return d.strftime("%B %Y") if d else "an earlier month"


def possible_repeats(claims: list[Claim]) -> list[dict[str, Any]]:
    owners = {c.owner_id for c in claims}
    staff = {(c.owner.staff_id or "").strip().lower() for c in claims} - {""}
    others: dict[str, list[Claim]] = defaultdict(list)
    for o in Claim.objects.filter(owner_id__in=owners, status__in=(*claim_standing.FILED, ClaimStatus.PAID)).only(
        "id", "owner_id", "ticket_number", "status", "doi", "paper_title", "remuneration", "payout_month", "created_at",
    ):
        others[o.owner_id].append(o)
    ledger_by_staff: dict[str, list[PaidLedger]] = defaultdict(list)
    if staff:
        for r in PaidLedger.objects.annotate(sid=Lower("staff_id")).filter(
            amount__gt=0, kind=PaidLedger.Kind.PAYMENT, sid__in=staff
        ).only("id", "claim_id", "staff_id", "paper_title", "amount", "payout_month"):
            ledger_by_staff[(r.staff_id or "").strip().lower()].append(r)
    prior_by_staff: dict[str, list[PriorPayment]] = defaultdict(list)
    if staff:
        for p in PriorPayment.objects.annotate(eid=Lower("employee_id")).filter(eid__in=staff).only(
            "id", "employee_id", "paper_title", "doi", "amount_paid", "claim_ref", "paid_at"
        ):
            prior_by_staff[(p.employee_id or "").strip().lower()].append(p)
    own_ledger: dict[str, float] = defaultdict(float)
    for r in PaidLedger.objects.filter(claim_id__in=[c.id for c in claims]).values("claim_id", "amount"):
        own_ledger[r["claim_id"]] += r["amount"] or 0.0

    in_batch = {c.id: c for c in claims}
    out = []
    for c in claims:
        if own_ledger.get(c.id, 0) > 0.005:
            out.append(_finding(
                "possible_repeat", "high", c,
                f"The ledger already holds {inr(own_ledger[c.id])} for this very claim.",
                {"match": "this claim is already on the ledger", "ledger_amount": round2(own_ledger[c.id])},
                sort_money=own_ledger[c.id],
            ))
            continue
        d, key = normalize_doi(c.doi), _title_key(c.paper_title)
        if not d and not key:
            continue
        hit = None
        for o in others.get(c.owner_id, ()):
            if o.id == c.id:
                continue
            if _same_paper(d, key, normalize_doi(o.doi), _title_key(o.paper_title)):
                if o.id in in_batch and (o.created_at, o.id) > (c.created_at, c.id):
                    continue  # one finding per pair: the later claim carries it
                state = ("paid" if o.status == ClaimStatus.PAID
                         else "in this batch" if o.id in in_batch else "still moving through the chain")
                paid = o.status == ClaimStatus.PAID
                hit = (
                    f"The same person has {o.ticket_number or 'another claim'} for what looks like the same paper"
                    + (f", paid {inr(o.remuneration)} in {_month_word(o.payout_month)}." if paid else f" ({state}).")
                    , {"match": "another claim", "other_claim": o.ticket_number, "other_state": state,
                       "other_amount": round2(o.remuneration or 0) if paid else None},
                    o.remuneration or 0.0 if paid else 0.0,
                )
                if paid:
                    break
        if hit is None:
            s = (c.owner.staff_id or "").strip().lower()
            linked = {o.id for o in others.get(c.owner_id, ())}
            for r in ledger_by_staff.get(s, ()):
                if r.claim_id in linked or r.claim_id == c.id:
                    continue  # already compared as a claim
                if _same_paper(d, key, None, _title_key(r.paper_title)):
                    hit = (f"The ledger shows {inr(r.amount)} paid to this person in {_month_word(r.payout_month)}"
                           " for what looks like the same paper.",
                           {"match": "ledger payment", "ledger_amount": round2(r.amount),
                            "paid_month": r.payout_month.isoformat()[:7] if r.payout_month else None},
                           r.amount)
                    break
            if hit is None:
                for p in prior_by_staff.get(s, ()):
                    if p.claim_ref and p.claim_ref == c.ticket_number:
                        continue
                    if _same_paper(d, key, normalize_doi(p.doi), _title_key(p.paper_title)):
                        hit = ("The old payment record shows this person was paid"
                               + (f" {inr(p.amount_paid)}" if p.amount_paid else "")
                               + " for what looks like the same paper.",
                               {"match": "earlier payment record", "ledger_amount": round2(p.amount_paid or 0)},
                               p.amount_paid or 0.0)
                        break
        if hit:
            out.append(_finding("possible_repeat", "high", c, hit[0], hit[1], sort_money=hit[2] or _amount_of(c)))
    return out


def first_payees(claims: list[Claim]) -> list[dict[str, Any]]:
    owners = {c.owner_id for c in claims}
    paid_owners = set(
        Claim.objects.filter(owner_id__in=owners, status=ClaimStatus.PAID).values_list("owner_id", flat=True)
    )
    staff = {(c.owner.staff_id or "").strip().lower() for c in claims} - {""}
    paid_staff = set(
        PaidLedger.objects.annotate(sid=Lower("staff_id")).filter(amount__gt=0, sid__in=staff)
        .values_list("sid", flat=True).distinct()
    )
    paid_staff |= set(
        PriorPayment.objects.annotate(eid=Lower("employee_id")).filter(eid__in=staff)
        .values_list("eid", flat=True).distinct()
    )
    seen: set[str] = set()
    out = []
    for c in claims:
        s = (c.owner.staff_id or "").strip().lower()
        if c.owner_id in paid_owners or (s and s in paid_staff) or c.owner_id in seen:
            continue
        seen.add(c.owner_id)  # one note per person, on their first claim in the batch
        n = sum(1 for x in claims if x.owner_id == c.owner_id)
        out.append(_finding(
            "first_payee", "low", c,
            "No payment to this person is on the ledger or in the old payment record."
            + (f" They have {n} claims in this batch." if n > 1 else ""),
            {"claims_in_batch": n}, sort_money=sum(_amount_of(x) for x in claims if x.owner_id == c.owner_id),
        ))
    return out


def _percentile(values: list[float], pct: int) -> float:
    """Nearest rank, so the figure is always one somebody was actually paid."""
    ordered = sorted(values)
    rank = max(1, -(-len(ordered) * pct // 100))
    return ordered[rank - 1]


def large_amounts(claims: list[Claim]) -> list[dict[str, Any]]:
    quartiles = {(c.quartile or "").strip().upper() for c in claims} - {""}
    if not quartiles:
        return []
    peers: dict[tuple[str, str], list[float]] = defaultdict(list)
    college: dict[str, list[float]] = defaultdict(list)
    for q, dept, amount in Claim.objects.filter(
        status=ClaimStatus.PAID, remuneration__gt=0, quartile__isnull=False
    ).values_list("quartile", "owner__department", "remuneration"):
        q = (q or "").strip().upper()
        if q in quartiles:
            peers[(q, (dept or "").strip().lower())].append(amount)
            college[q].append(amount)
    out = []
    for c in claims:
        q = (c.quartile or "").strip().upper()
        amount = _amount_of(c)
        if not q or amount < LARGE_FLOOR:
            continue
        dept = (c.owner.department or "").strip().lower()
        group, label = peers.get((q, dept), []), f"{c.owner.department} {q}"
        if len(group) < MIN_PEERS:
            group, label = college.get(q, []), f"{q} across the college"
        if len(group) < MIN_PEERS:
            continue
        top = _percentile(group, LARGE_PERCENTILE)
        if amount > top * LARGE_FACTOR:
            out.append(_finding(
                "large_amount", "medium", c,
                f"{inr(amount)} is more than {LARGE_FACTOR:g} times {inr(top)}, which {LARGE_PERCENTILE} in 100 "
                f"earlier payments for {label} were at or below.",
                {"amount": round2(amount), "typical_top": round2(top), "group": label, "peers": len(group)},
                sort_money=amount,
            ))
    return out


def budget_risks(claims: list[Claim], user) -> list[dict[str, Any]]:
    from core.api.budget import _budget_status, financial_year_of

    status = _budget_status(financial_year_of(date.today()), user)
    batch = sum(_amount_of(c) for c in claims)
    out = []
    college = status["college"]
    if college.get("allocated"):
        left, frac = college["remaining"], college["used_fraction"] or 0
        if left is not None and left < 0:
            out.append(_finding(
                "budget", "high", None,
                f"With this batch the year's commitments pass the budget by {inr(round(-left))}.",
                {"batch": round2(batch), "allocated": college["allocated"], "left": left, "over_by": round2(-left)},
                sort_money=-left, link="/budget"))
        elif left is not None and left < college["allocated"] * THIN_LEFT:
            out.append(_finding(
                "budget", "medium", None,
                f"Only {inr(round(left))} of the year's {inr(round(college['allocated']))} is left once this batch is counted.",
                {"batch": round2(batch), "allocated": college["allocated"], "left": left,
                 "used_percent": round(frac * 100, 1)},
                sort_money=batch, link="/budget"))
    in_batch = {(c.owner.department or "").strip() for c in claims}
    for d in status["departments"]:
        name = d["department"]
        if name and name in in_batch and d["allocated"] and d["remaining"] is not None and d["remaining"] < 0:
            dept_batch = sum(_amount_of(c) for c in claims if (c.owner.department or "").strip() == name)
            out.append(_finding(
                "budget", "medium", None,
                f"{name} is over its own allocation by {inr(round(-d['remaining']))} with this batch counted.",
                {"department": name, "batch": round2(dept_batch), "allocated": d["allocated"],
                 "over_by": round2(-d["remaining"])},
                sort_money=-d["remaining"], link="/budget"))
    return out


def amount_changes(claims: list[Claim], stage: str, now=None) -> list[dict[str, Any]]:
    now = now or timezone.now()
    since = now - timedelta(days=RECENT_DAYS)
    by_id = {c.id: c for c in claims}
    latest: dict[str, tuple[Any, float | None, float | None]] = {}
    for a in AuditLog.objects.filter(
        entity="Claim", entity_id__in=list(by_id), action__in=list(_AMOUNT_ACTIONS), created_at__gte=since
    ).order_by("created_at"):
        try:
            d = json.loads(a.detail_json or "{}")
        except ValueError:
            continue
        before_key, after_key, field = _AMOUNT_ACTIONS[a.action]
        if field:
            was, now_ = (d.get(before_key) or {}).get(field), (d.get(after_key) or {}).get(field)
        else:
            was, now_ = d.get("previous"), d.get("recomputed")
        if was is None or now_ is None or abs(float(now_) - float(was)) <= calculator.TOLERANCE:
            continue
        latest[a.entity_id] = (a.created_at, float(was), float(now_))
    out = []
    for cid, (when, was, now_) in latest.items():
        c = by_id[cid]
        days = max(0, (now.date() - when.date()).days)
        ago = "today" if days == 0 else "yesterday" if days == 1 else f"{days} days ago"
        out.append(_finding(
            "amount_changed", "medium", c,
            f"The amount was changed {ago}, from {inr(was)} to {inr(now_)}.",
            {"was": round2(was), "now": round2(now_), "days_ago": days}, sort_money=abs(now_ - was)))
    if stage == "pay":
        done = {f["claim_id"] for f in out}
        for c in claims:
            if c.authorised_amount is None:
                continue
            full = round2((c.remuneration or 0) + (c.research_absorbed or 0))
            if abs(full - c.authorised_amount) > 0.005:
                f = _finding(
                    "amount_changed", "high", c,
                    f"It was authorised at {inr(c.authorised_amount)} and now stands at {inr(full)}. "
                    "Paying would send it back to the Principal.",
                    {"authorised": round2(c.authorised_amount), "now": full,
                     "difference": round2(full - c.authorised_amount)},
                    sort_money=abs(full - c.authorised_amount))
                if c.id in done:  # the lock mismatch is the stronger statement
                    out = [x for x in out if x["claim_id"] != c.id]
                out.append(f)
    return out


# ------------------------------------------------------------------- the check


def check(stage: str, user, department: str | None = None, *, now=None) -> dict[str, Any]:
    """Everything unusual in this person's batch, most worth a look first."""
    claims, truncated = claims_for(stage, user, department)
    found: list[dict[str, Any]] = []
    if claims:
        found += amount_off_formula(claims)
        found += possible_repeats(claims)
        found += first_payees(claims)
        found += large_amounts(claims)
        found += budget_risks(claims, user)
        found += amount_changes(claims, stage, now=now)
    found.sort(key=lambda f: (SEVERITY_ORDER[f["severity"]], KINDS.index(f["kind"]), -f["_money"],
                              f.get("ticket_number") or ""))
    queue = "authorisations" if stage == "authorise" else "payments"
    for i, f in enumerate(found, 1):
        f["id"] = f"F{i}"
        f.pop("_money")
        if f["claim_id"]:
            f["link"] = f"/review/{f['claim_id']}?queue={queue}"
    kinds: dict[str, int] = {}
    for f in found:
        kinds[f["kind"]] = kinds.get(f["kind"], 0) + 1
    return {
        "stage": stage,
        "batch": {
            "count": len(claims),
            "amount": round2(sum(_amount_of(c) for c in claims)),
            "truncated": truncated,
            "department": department or None,
        },
        "findings": found,
        "counts": kinds,
    }


def fingerprint_of(result: dict[str, Any]) -> str:
    """A short hash of the facts, so the same batch gets the same cached summary."""
    import hashlib

    basis = [
        [f["kind"], f["claim_id"], f["severity"], sorted((k, str(v)) for k, v in f["facts"].items())]
        for f in result["findings"]
    ]
    blob = json.dumps([result["stage"], result["batch"]["count"], result["batch"]["amount"], basis], sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:32]
