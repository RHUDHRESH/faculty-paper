"""The research threshold: incentives a research faculty member is not paid.

Research faculty are already paid to do research. The research coordinator (or
a super admin) sets a rupee amount per person, say ₹3 lakh a year, and the
incentives they earn count against it in the order claims are paid:

* a claim that falls wholly inside what is left of the threshold pays nothing;
* the claim that crosses it pays only the part above;
* every claim after that pays in full.

The threshold runs on one year for the whole college, set in the policy
(`FormulaConfig.research_year_start_month`, 6 = the academic year from 1 June,
which is also what the faculty home calls "this year"). A claim belongs to the
year its money is paid in; a claim still on its way belongs to the current year.

Everything that shows or moves an amount goes through `plan()` so every screen
agrees. The one number it needs for another claim is that claim's own full
amount, which is `remuneration + research_absorbed` on the row, so re-deciding
who absorbs what is plain arithmetic and never re-prices a paper.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Iterable, Optional

from django.db.models import Q
from django.utils import timezone

from core.models import (
    Claim,
    ClaimReason,
    ClaimStatus,
    FormulaConfig,
    ResearchThreshold,
    User,
)

DEFAULT_YEAR_START_MONTH = 6

#: Claims on their way to payment, furthest along first: the one nearest the
#: cashier is the one most likely to be paid first, so it uses the threshold
#: first. Legacy statuses count as the last step before payment.
_IN_FLIGHT_RANK = {
    ClaimStatus.SUBMITTED: 0,
    ClaimStatus.CLEARED: 1,
    ClaimStatus.PRINCIPAL_APPROVED: 2,
    ClaimStatus.DIRECTOR_APPROVED: 3,
    ClaimStatus.RESEARCH_APPROVED: 3,
    ClaimStatus.FINANCE_APPROVED: 3,
}


def inr(amount: float) -> str:
    """₹ with Indian grouping and no paise unless there are some."""
    from core.services.payout_statement import inr as _inr

    return _inr(round(amount, 2))


# ---------------------------------------------------------------- the year --


def year_start_month() -> int:
    cfg = FormulaConfig.objects.filter(active=True).order_by("-version").only("research_year_start_month").first()
    m = getattr(cfg, "research_year_start_month", None) or DEFAULT_YEAR_START_MONTH
    return m if 1 <= m <= 12 else DEFAULT_YEAR_START_MONTH


def year_bounds(on: date, month: Optional[int] = None) -> tuple[date, date]:
    """(first day, first day of the next year) of the research year holding `on`."""
    month = month or year_start_month()
    y = on.year if on.month >= month else on.year - 1
    return date(y, month, 1), date(y + 1, month, 1)


def year_label(start: date) -> str:
    if start.month == 1:
        return str(start.year)
    return f"{start.year}-{str(start.year + 1)[-2:]}"


def today() -> date:
    return timezone.localdate()


# ---------------------------------------------------------- the threshold --


def history(user_id: str) -> list[ResearchThreshold]:
    return list(
        ResearchThreshold.objects.filter(user_id=user_id)
        .select_related("set_by")
        .order_by("-effective_from", "-created_at")
    )


def threshold_on(rows: Iterable[ResearchThreshold], on: date) -> Optional[float]:
    """The amount in force on `on`, or None when none is set."""
    for r in sorted(rows, key=lambda r: (r.effective_from, r.created_at), reverse=True):
        if r.effective_from <= on:
            return r.amount
    return None


def applies_to(claim: Claim) -> bool:
    """Only faculty incentive claims spend the threshold. A count-only filing
    asks for no money, and a student project is paid under its own scheme."""
    return claim.claim_reason not in (ClaimReason.COUNT_ONLY, ClaimReason.STUDENT_PROJECT)


def is_research(user: Optional[User]) -> bool:
    return bool(user is not None and user.faculty_type == "RESEARCH")


def full_amount(claim: Claim) -> float:
    """What the policy says this claim is worth, before the threshold."""
    return round((claim.remuneration or 0) + (claim.research_absorbed or 0), 2)


def _paid_date(c: Claim) -> Optional[date]:
    if c.payout_month:
        return c.payout_month
    if c.paid_at:
        return timezone.localtime(c.paid_at).date()
    return None


# ------------------------------------------------------------- the plan ----


@dataclass
class Effect:
    """What the threshold does to one claim."""

    absorbed: float = 0.0
    payable: float = 0.0
    full: float = 0.0
    note: Optional[str] = None
    left_before: Optional[float] = None
    state: str = "none"  # none | inside | crossing | after | unset
    #: 0 submitted, 1 cleared, 2 approved, 3 authorised; -1 not in the line.
    rank: int = -1


@dataclass
class Plan:
    """The research year of one person as it stands."""

    research: bool = False
    threshold: Optional[float] = None
    unset: bool = False
    start: Optional[date] = None
    end: Optional[date] = None
    label: str = ""
    used_paid: float = 0.0
    #: claim id -> Effect, for the claims in flight and the target.
    effects: dict = field(default_factory=dict)

    @property
    def used_total(self) -> float:
        """Paid plus everything on its way, at policy value."""
        return round(self.used_paid + sum(e.full for e in self.effects.values() if e.rank >= 0), 2)

    @property
    def on_the_way_absorbed(self) -> float:
        """What the claims still waiting for approval would use of the
        threshold if they were approved as they stand. Not used yet."""
        if self.threshold is None:
            return 0.0
        return round(
            max(0.0, min(self.threshold, self.used_total) - min(self.threshold, self.used_approved)), 2
        )

    @property
    def on_the_way_above(self) -> float:
        """What those same claims would be paid: their amount above the threshold."""
        return round((self.used_total - self.used_approved) - self.on_the_way_absorbed, 2)

    @property
    def used_approved(self) -> float:
        """Paid plus what the Principal has approved. What the person is told."""
        return round(self.used_paid + sum(e.full for e in self.effects.values() if e.rank >= 2), 2)


def _claimless_ledger_total(user: User, start: date, end: date) -> float:
    """Money paid to this person in the year that no claim of this app explains
    (the accounts workbook the college imported). It was real money paid for
    incentives, so it counts as used."""
    from core.api.my_payments import ledger_for

    rows = ledger_for(user).filter(
        claim__isnull=True, amount__gt=0, payout_month__gte=start, payout_month__lt=end
    )
    return round(sum(r.amount or 0 for r in rows), 2)


def paid_used(user: User, start: date, end: date, exclude_id: Optional[str] = None) -> float:
    total = 0.0
    qs = Claim.objects.filter(owner=user, status=ClaimStatus.PAID).exclude(
        claim_reason__in=(ClaimReason.COUNT_ONLY, ClaimReason.STUDENT_PROJECT)
    )
    if exclude_id:
        qs = qs.exclude(pk=exclude_id)
    for c in qs.only("remuneration", "research_absorbed", "payout_month", "paid_at"):
        d = _paid_date(c)
        if d and start <= d < end:
            total += full_amount(c)
    return round(total + _claimless_ledger_total(user, start, end), 2)


def _order_key(c: Claim):
    return (
        -_IN_FLIGHT_RANK.get(c.status, 0),
        c.submitted_at or c.created_at or timezone.now(),
        c.id or "",
    )


def claim_ahead_in_line(claim: Claim) -> Optional[Claim]:
    """The earlier claim of the same research faculty member that must be paid
    before this one, or None.

    The threshold is spent in the order claims are paid, and the amounts on
    the rows were decided on the line as it stands: the claims ahead take what
    is left of the threshold, the ones behind it take the rest. A paid claim
    is settled at its full amount. So paying a claim from the back of the line
    first lets it keep the money it was priced at while the claims ahead,
    re-decided afterwards, absorb the threshold *again* from what is now left:
    the person is paid for the same paper twice over. Found by the year
    scenario, where Finance paid a batch largest amount first.

    Only a claim ahead that is still absorbing some of the threshold matters:
    one that absorbs nothing takes nothing from the claims behind it.
    """
    owner = claim.owner
    if not is_research(owner) or not applies_to(claim):
        return None
    if threshold_on(history(owner.id), today()) is None:
        return None
    mine = _order_key(claim)
    ahead = [
        c
        for c in Claim.objects.filter(owner=owner, status__in=list(_IN_FLIGHT_RANK))
        .exclude(pk=claim.pk)
        .exclude(claim_reason__in=(ClaimReason.COUNT_ONLY, ClaimReason.STUDENT_PROJECT))
        if (c.research_absorbed or 0) > 0.005 and _order_key(c) < mine
    ]
    ahead.sort(key=_order_key)
    return ahead[0] if ahead else None


def in_line_order(claim_ids: Iterable[str]) -> list[str]:
    """`claim_ids` in the order the threshold expects them to be paid, so a
    batch never pays a claim ahead of the ones in front of it. Ids not found
    keep their place at the end, in the order given."""
    ids = list(dict.fromkeys(claim_ids))
    found = {c.id: c for c in Claim.objects.filter(pk__in=ids)}
    known = sorted((found[i] for i in ids if i in found), key=_order_key)
    return [c.id for c in known] + [i for i in ids if i not in found]


def _describe(e: Effect, threshold: float, label: str, used_before: float) -> Effect:
    left = max(0.0, threshold - used_before)
    e.left_before = round(left, 2)
    if e.full <= 0:
        e.state = "none"
        return e
    if e.absorbed >= e.full - 0.005:
        e.state = "inside"
        e.note = (
            f"Inside your research threshold. {inr(e.full)} counts against your "
            f"{inr(threshold)} threshold for {label}, so nothing is paid on this claim."
        )
    elif e.absorbed > 0.005:
        e.state = "crossing"
        e.note = (
            f"This claim crosses your research threshold. {inr(e.absorbed)} of its "
            f"{inr(e.full)} counts against your {inr(threshold)} threshold for {label}. "
            f"The {inr(e.payable)} above it is paid."
        )
    else:
        e.state = "after"
        e.note = (
            f"Your research threshold for {label} is already used up, so this is paid in full."
            if left <= 0.005
            else None
        )
    return e


def plan(
    owner: User,
    *,
    target: Optional[Claim] = None,
    target_full: Optional[float] = None,
    fulls: Optional[dict] = None,
    on: Optional[date] = None,
) -> Plan:
    """Work out, for one person, how the year's threshold is spent.

    `target` is a claim held in memory (it may not be saved yet, or not in the
    state the database has). `target_full` is its policy amount. `fulls` maps
    claim ids to a different policy amount, which is how the policy preview
    asks "and under the new rates?" without writing anything.

    Paid claims are settled: they use the threshold as it was decided when
    they were paid, so they are counted at their full amount and not
    reconsidered. Claims still in flight take what is left, furthest along
    first; a draft or any other claim not in that line is priced as the next
    one to be paid.
    """
    p = Plan(research=is_research(owner))
    now = on or today()
    p.start, p.end = year_bounds(now)
    p.label = year_label(p.start)
    if not p.research:
        return p
    rows = history(owner.id)
    p.threshold = threshold_on(rows, now)
    p.unset = p.threshold is None
    p.used_paid = paid_used(owner, p.start, p.end, exclude_id=target.id if target is not None else None)

    fulls = fulls or {}
    in_flight = list(
        Claim.objects.filter(owner=owner, status__in=list(_IN_FLIGHT_RANK))
        .exclude(claim_reason__in=(ClaimReason.COUNT_ONLY, ClaimReason.STUDENT_PROJECT))
        .exclude(pk=target.id if target is not None else None)
        .only("id", "status", "remuneration", "research_absorbed", "submitted_at", "created_at", "payout_month")
    )
    line = [(c, fulls.get(c.id, full_amount(c))) for c in in_flight]
    target_in_line = False
    if target is not None and applies_to(target):
        t_full = target_full if target_full is not None else full_amount(target)
        if target.status in _IN_FLIGHT_RANK:
            line.append((target, t_full))
            target_in_line = True
    line.sort(key=lambda cf: _order_key(cf[0]))

    used = p.used_paid
    for c, f in line:
        e = Effect(full=round(f, 2), rank=_IN_FLIGHT_RANK.get(c.status, 0))
        if not p.unset:
            e.absorbed = round(min(f, max(0.0, p.threshold - used)), 2)
        e.payable = round(f - e.absorbed, 2)
        if not p.unset:
            _describe(e, p.threshold, p.label, used)
        p.effects[c.id] = e
        used += f

    # A claim not in the line (a draft, or one sent back) is priced as next.
    if target is not None and applies_to(target) and not target_in_line:
        f = target_full if target_full is not None else full_amount(target)
        e = Effect(full=round(f, 2))
        if not p.unset:
            e.absorbed = round(min(f, max(0.0, p.threshold - used)), 2)
        e.payable = round(f - e.absorbed, 2)
        if not p.unset:
            _describe(e, p.threshold, p.label, used)
        p.effects[target.id or "_target"] = e
    return p


def effect_for(claim: Claim, full: float) -> Effect:
    """The threshold's effect on `claim` if the policy prices it at `full`.

    A paid claim is settled and keeps the split it was paid on.
    """
    owner = claim.owner
    if not is_research(owner) or not applies_to(claim):
        return Effect(absorbed=0.0, payable=round(full, 2), full=round(full, 2))
    if claim.status == ClaimStatus.PAID:
        if claim.quota_applied and not (claim.research_absorbed or 0):
            # Paid nothing under the old papers-a-year rule. Settled, and not
            # a rupee amount that counts against anything.
            paid = round(claim.remuneration or 0, 2)
            return Effect(absorbed=0.0, payable=paid, full=paid)
        absorbed = min(full, claim.research_absorbed or 0)
        e = Effect(absorbed=round(absorbed, 2), payable=round(full - absorbed, 2), full=round(full, 2))
        if absorbed > 0.005:
            e.state = "inside" if absorbed >= full - 0.005 else "crossing"
            e.note = claim.quota_note
        return e
    p = plan(owner, target=claim, target_full=full)
    e = p.effects.get(claim.id or "_target")
    if e is None:
        e = Effect(payable=round(full, 2), full=round(full, 2))
    if p.unset:
        e.state = "unset"
    return e


def refresh_open_claims(owner: User, *, skip_id: Optional[str] = None) -> int:
    """Re-decide who absorbs what across a person's unpaid claims.

    Called after any claim of a research faculty member moves or is priced,
    because the amounts of the others depend on the order. Writes with
    `.update()` so nothing else about the claims is touched. Returns how many
    claims changed.
    """
    changed = 0
    p = plan(owner)
    if not p.research or p.unset:
        # Regular faculty, or research faculty with no threshold set: nothing
        # is absorbed, so give back whatever an earlier state had taken.
        for c in Claim.objects.filter(owner=owner, research_absorbed__gt=0).exclude(status=ClaimStatus.PAID).exclude(pk=skip_id):
            full = full_amount(c)
            Claim.objects.filter(pk=c.pk).update(
                remuneration=full, research_absorbed=0, quota_applied=False, quota_note=None
            )
            changed += 1
        return changed
    drafts = Claim.objects.filter(owner=owner).exclude(
        status__in=[ClaimStatus.PAID, *_IN_FLIGHT_RANK]
    ).exclude(claim_reason__in=(ClaimReason.COUNT_ONLY, ClaimReason.STUDENT_PROJECT)).exclude(pk=skip_id)
    for c in list(drafts):
        e = plan(owner, target=c).effects.get(c.id)
        if e is not None:
            changed += _store(c, e)
    for cid, e in p.effects.items():
        if cid == skip_id:
            continue
        c = Claim.objects.filter(pk=cid).only("id", "remuneration", "research_absorbed", "quota_applied", "quota_note").first()
        if c is not None:
            changed += _store(c, e)
    return changed


def _store(c: Claim, e: Effect) -> int:
    absorbed_now = e.absorbed > 0.005
    same = (
        abs((c.remuneration or 0) - e.payable) < 0.005
        and abs((c.research_absorbed or 0) - e.absorbed) < 0.005
        and bool(c.quota_applied) == absorbed_now
        and (c.quota_note or None) == (e.note or None)
    )
    if same:
        return 0
    Claim.objects.filter(pk=c.pk).update(
        remuneration=e.payable,
        research_absorbed=e.absorbed,
        quota_applied=absorbed_now,
        quota_note=e.note,
    )
    return 1


_TRIGGER_FIELDS = {"status", "remuneration", "research_absorbed", "payout_month", "paid_at", "claim_reason", "owner", "owner_id"}


def on_claim_saved(sender, instance, created=False, raw=False, update_fields=None, **kwargs):
    """Keep the person's other unpaid claims in step when one of them moves.

    Wired to `post_save` of Claim. The amounts of a research faculty member's
    open claims depend on each other through the threshold, so a claim being
    submitted, approved, paid, sent back or repriced re-decides the rest. The
    re-decision writes with `.update()`, which does not fire this again.
    """
    if raw or not instance.owner_id:
        return
    if update_fields is not None and not (_TRIGGER_FIELDS & set(update_fields)):
        return
    owner = User.objects.filter(pk=instance.owner_id, faculty_type="RESEARCH").first()
    if owner is not None:
        refresh_open_claims(owner)


def on_claim_deleted(sender, instance, **kwargs):
    if not instance.owner_id:
        return
    owner = User.objects.filter(pk=instance.owner_id, faculty_type="RESEARCH").first()
    if owner is not None:
        refresh_open_claims(owner)


# ------------------------------------------------------ what people see ----


def summary(user: User, on: Optional[date] = None) -> dict:
    """The threshold, this year's use and what is left, for one person.

    `used` is what has been paid or is on its way (approved or paid amounts at
    their full policy value); `left` is what remains before incentives are paid.
    """
    if not is_research(user):
        return {"research": False}
    p = plan(user, on=on)
    rows = history(user.id)
    used = min(p.used_approved, p.threshold) if p.threshold is not None else p.used_approved
    return {
        "research": True,
        "threshold": p.threshold,
        "unset": p.unset,
        "year": p.label,
        "year_start": p.start.isoformat() if p.start else None,
        "year_end": p.end.isoformat() if p.end else None,
        "used": round(used, 2),
        # Used is only what is paid or approved. Claims still waiting for an
        # approval are a separate figure, never added into it.
        "on_the_way": p.on_the_way_absorbed,
        "on_the_way_above": p.on_the_way_above,
        "left": None if p.threshold is None else round(max(0.0, p.threshold - p.used_approved), 2),
        "old_quota": user.research_quota,
        "old_quota_note": user.research_quota_note,
        "needs_rupee_threshold": p.unset and bool(user.research_quota),
        "message": message_for(user, p),
        "history": [
            {
                "id": r.id,
                "amount": r.amount,
                "effective_from": r.effective_from.isoformat(),
                "note": r.note,
                "set_by": r.set_by.name if r.set_by else None,
                "set_at": r.created_at.isoformat(),
            }
            for r in rows
        ],
    }


def message_for(user: User, p: Plan) -> str:
    if p.unset:
        return (
            "You are research faculty. The college has not set your research "
            "threshold yet, so your incentives are paid in full for now."
        )
    used = min(p.used_approved, p.threshold)
    text = (
        f"You are research faculty. Your threshold this year is {inr(p.threshold)}. "
        f"Used so far: {inr(used)}."
    )
    if p.threshold - used <= 0.005:
        text += " All of it is used, so your incentives are now paid in full."
    else:
        text += f" {inr(p.threshold - used)} is left before incentives are paid."
    if p.on_the_way_absorbed > 0.005 or p.on_the_way_above > 0.005:
        if p.on_the_way_absorbed <= 0.005:
            text += f" Claims on the way would be paid in full: {inr(p.on_the_way_above)}."
        else:
            text += f" Claims on the way would use {inr(p.on_the_way_absorbed)} of it"
            if p.on_the_way_above > 0.005:
                text += f"; {inr(p.on_the_way_above)} above it would be paid."
            else:
                text += "."
    return text


def claim_fields(claim: Claim) -> dict:
    """What a claim carries about the threshold, for every screen that lists it."""
    return {
        "threshold_absorbed": round(claim.research_absorbed or 0, 2),
        "threshold_full_amount": full_amount(claim),
        "threshold_note": claim.quota_note,
    }
