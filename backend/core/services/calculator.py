"""The incentive calculator: price a paper, check a claim, check many.

Read-only, everywhere. Nothing here writes a claim, a ledger row or an audit
entry; a difference it finds is reported with its cause and a link to where a
person can put it right.

There is exactly one piece of arithmetic in the whole system, and it lives in
`core.services.remuneration`. This module calls it and explains what came back.
It never multiplies a SNIP by a rate to get an amount: where a working line
shows `SNIP x rate = figure`, the figure is the term the engine itself used,
and a test pins the line that ends the working (the value of the paper) to the
engine's own `base`. That is what keeps the calculator from ever disagreeing
with how a claim was priced.

Three questions, three entry points:

* `price_paper`      what should a paper with these inputs pay?
* `explain_claim`    recorded vs formula (its snapshot, then today's) vs ledger
* `check_many`       every claim against its own pricing snapshot, in memory
"""
from __future__ import annotations

import dataclasses
import json
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, Optional

from django.db.models import Count, Sum

from core.models import (
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimAttachment,
    ClaimReason,
    ClaimStatus,
    FormulaConfig,
    PaidLedger,
    User,
)
from core.services import research_threshold
from core.services.remuneration import (
    CATEGORY_LABELS,
    ENGINEERING,
    NON_ENGINEERING,
    CalcResult,
    Category,
    FormulaConfigInput,
    _is_conference_or_book,
    _is_journal,
    _no_snip_floor,
    _pub_multiplier,
    calculate_remuneration,
    calculate_student_project,
    formula_from_model,
    is_scopus_indexed,
    is_web_of_science,
    qf_for,
    round2,
    snapshot_formula,
)

#: "differs" means by more than this many rupees. Sub-rupee differences are the
#: paisa the old sheet rounded away, and are not a finding.
TOLERANCE = 1.0

#: What a claim's stored status means to the calculator's stage filter.
STAGE_STATUSES: dict[str, tuple[str, ...]] = {
    "approved": (ClaimStatus.PRINCIPAL_APPROVED,),
    "authorised": (
        ClaimStatus.DIRECTOR_APPROVED,
        ClaimStatus.FINANCE_APPROVED,
        ClaimStatus.RESEARCH_APPROVED,
    ),
    "paid": (ClaimStatus.PAID,),
    "submitted": (ClaimStatus.SUBMITTED, ClaimStatus.CLEARED),
}
DEFAULT_STAGES = ("approved", "authorised", "paid")
STAGE_LABEL = {"approved": "Approved", "authorised": "Authorised", "paid": "Paid", "submitted": "Being checked"}

#: The audit entries that mean a person set an amount by hand.
_OVERRIDE_ACTIONS = ("CLAIM_DATA_FIX", "CLAIM_ADMIN_EDIT")

#: Causes, in words. `expected` causes are not faults: the recorded amount is
#: what it should be, and the cause says why it is not the bare formula figure.
CAUSES: dict[str, dict[str, Any]] = {
    "inputs_changed": {
        "label": "Figures changed after it was priced",
        "expected": False,
    },
    "manual_override": {
        "label": "Amount entered by hand",
        "expected": False,
    },
    "old_erp": {
        "label": "Paid by the old ERP's own sheet",
        "expected": False,
    },
    "imported_no_amount": {
        "label": "Imported with no amount",
        "expected": False,
    },
    "not_priced": {
        "label": "Not priced yet",
        "expected": False,
    },
    "cannot_be_priced": {
        "label": "The formula cannot price it now",
        "expected": False,
    },
    "ledger_differs": {
        "label": "The ledger shows another amount",
        "expected": False,
    },
    "unexplained": {
        "label": "Nothing explains the difference",
        "expected": False,
    },
    "policy_changed": {
        "label": "The policy has changed since",
        "expected": True,
    },
    "threshold": {
        "label": "Research threshold",
        "expected": True,
    },
    "counted_only": {
        "label": "Counted only, nothing due",
        "expected": True,
    },
    "old_quota": {
        "label": "Nothing paid under the old papers-a-year quota",
        "expected": True,
    },
}


def _inr(amount: float | None) -> str:
    if amount is None:
        return "Not recorded"
    return research_threshold.inr(float(amount))


def _plain(text: str | None) -> str:
    """No " — " fragments on screen (docs/ux/19): the engine's labels use them."""
    return (text or "").replace(" — ", ": ").replace("—", "-")


def policy_label(name: str | None, version: int | None) -> str:
    name = name or "Policy"
    if version is not None and re.search(rf"\bv{version}\b", name, re.I):
        return name
    return f"{name} v{version}" if version is not None else name


# ------------------------------------------------------------------ policies --


def active_policy() -> FormulaConfig | None:
    return FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()


def policy_options() -> list[dict[str, Any]]:
    """Every version, the one in force first, then newest to oldest."""
    rows = FormulaConfig.objects.order_by("-active", "-version", "-updated_at")
    return [
        {
            "id": f.id,
            "name": f.name,
            "version": f.version,
            "label": policy_label(f.name, f.version),
            "in_force": bool(f.active),
            "effective_from": f.effective_from.isoformat() if f.effective_from else None,
            "effective_to": f.effective_to.isoformat() if f.effective_to else None,
        }
        for f in rows
    ]


def policy_summary(obj: FormulaConfig | None, cfg: FormulaConfigInput, in_force: bool) -> dict[str, Any]:
    return {
        "id": obj.id if obj else None,
        "name": cfg.name,
        "version": cfg.version,
        "label": policy_label(cfg.name, cfg.version),
        "in_force": in_force,
        "effective_from": obj.effective_from.isoformat() if obj and obj.effective_from else None,
        "min_sec_references": cfg.min_sec_references,
        "max_authors": cfg.max_authors,
        "snip_multiplier": cfg.snip_multiplier,
        "student_project_amount": cfg.student_project_amount,
    }


def config_for(policy_id: str | None) -> tuple[FormulaConfig | None, FormulaConfigInput, bool]:
    """(row, config, in force) for a version; the one in force when none is named.

    A college with no policy row still prices, on the built-in defaults, exactly
    as `_apply_calc` does.
    """
    active = active_policy()
    if policy_id:
        obj = FormulaConfig.objects.filter(pk=policy_id).first()
        if obj is not None:
            return obj, formula_from_model(obj), bool(active and obj.pk == active.pk)
    if active is not None:
        return active, formula_from_model(active), True
    return None, FormulaConfigInput(), True


def cfg_from_snapshot(snapshot: dict[str, Any]) -> FormulaConfigInput:
    """The policy a claim was priced under, rebuilt from the copy stored on it.

    Older snapshots lack newer keys; those fall back to the defaults, which is
    what the engine did for them at the time.
    """
    known = {f.name for f in dataclasses.fields(FormulaConfigInput)}
    kwargs = {k: v for k, v in snapshot.items() if k in known and v is not None}
    return FormulaConfigInput(**kwargs)


# ---------------------------------------------------------------- pricing ----


@dataclass
class PaperInputs:
    publication_type: Optional[str] = None
    indexing_level: Optional[str] = None
    quartile: Optional[str] = None
    snip: Optional[float] = None
    engineering_class: Optional[str] = None
    total_authors: int = 1
    positions: list[int] = field(default_factory=lambda: [1])
    sec_reference_count: Optional[int] = None
    student_project: bool = False
    counted_only: bool = False


def _engine(inp: PaperInputs, position: int, cfg: FormulaConfigInput) -> CalcResult:
    """The one call that prices. A student project has its own function, as it
    does on `/api/calculate` and in `price_claim`."""
    if inp.student_project:
        return calculate_student_project(inp.publication_type, cfg)
    return calculate_remuneration(
        inp.snip,
        inp.quartile,
        inp.total_authors,
        position,
        cfg,
        is_student_publication=inp.counted_only,
        publication_type=inp.publication_type,
        indexing_level=inp.indexing_level,
        engineering_class=inp.engineering_class,
        sec_reference_count=inp.sec_reference_count,
    )


def _quartile_word(inp: PaperInputs, cfg: FormulaConfigInput) -> str:
    engineering = (inp.engineering_class or "") == ENGINEERING
    unclassified = (inp.engineering_class or "") not in (ENGINEERING, NON_ENGINEERING)
    journal = _is_journal(inp.publication_type) and not _is_conference_or_book(inp.publication_type)
    if not journal:
        return "No quartile incentive: it applies to journals only."
    if unclassified:
        return "No quartile incentive yet: the office has not classified the journal's subject area."
    if not engineering:
        return "No quartile incentive: it applies to Engineering journals only."
    if qf_for(inp.quartile or "", cfg) == 0:
        return "No quartile incentive: the policy has no incentive for this quartile."
    return "No quartile incentive."


def _share_line(inp: PaperInputs, position: int, r: CalcResult) -> dict[str, Any]:
    return {
        "key": "share",
        "label": "This author's share",
        "text": f"Author {position} of {inp.total_authors} takes {r.point:g} of the paper.",
        "amount": r.remuneration,
    }


def working_lines(
    inp: PaperInputs, position: int, cfg: FormulaConfigInput, r: CalcResult
) -> list[dict[str, Any]]:
    """The working, one line per term, read back from the engine's result.

    Every `amount` is either a term the policy states (a rate, the SNIP times
    its rate) or a figure the engine returned (`qf`, `base`, `remuneration`).
    """
    lines: list[dict[str, Any]] = []

    def add(key: str, label: str, text: str, amount: float | None = None) -> None:
        lines.append({"key": key, "label": label, "text": text, "amount": amount})

    cat = r.category
    add("rate", "Which rate applies", _plain(CATEGORY_LABELS.get(cat or "", cat or "")))
    if inp.student_project:
        if (r.base or 0) > 0:
            add(
                "fixed",
                "Fixed amount per team",
                "A fixed amount for the team's conference paper, paid to its mentor. It is not "
                "split by author position and takes no SNIP or quartile.",
                r.base,
            )
        return lines
    if r.error or r.base is None:
        return lines
    if cat == Category.NONE:
        # Nothing is paid; the reason is the engine's own note.
        return lines

    pub_m = _pub_multiplier(inp.publication_type, cfg)
    if cat == Category.SNIP:
        snip = float(inp.snip or 0)
        raw_snip = round2(snip * cfg.snip_multiplier)
        add(
            "snip",
            "SNIP part",
            f"SNIP {snip:g} x {_inr(cfg.snip_multiplier)} for each point of SNIP.",
            raw_snip,
        )
        if r.qf:
            add(
                "quartile",
                "Quartile incentive",
                f"{inp.quartile}, an Engineering journal: the quartile incentive is added.",
                r.qf,
            )
        else:
            add("quartile", "Quartile incentive", _quartile_word(inp, cfg), 0.0)
        raw = float(inp.snip or 0) * cfg.snip_multiplier + (r.qf or 0)
        floor = _no_snip_floor(inp.publication_type, cfg)
        if floor > raw:
            add(
                "floor",
                "The fixed rate applies instead",
                f"The SNIP formula comes to {_inr(round2(raw))}, less than the fixed rate of "
                f"{_inr(floor)} for a paper with no SNIP. A SNIP never pays less than no SNIP.",
                floor,
            )
    elif cat == Category.JOURNAL_NO_SNIP:
        add("fixed", "Fixed rate", "A Scopus journal article with no SNIP on record.", cfg.fixed_journal_no_snip)
    elif cat == Category.OTHER_NO_SNIP:
        add(
            "fixed",
            "Fixed rate",
            "A Scopus conference paper or book chapter with no SNIP on record.",
            cfg.fixed_other_no_snip,
        )
    elif cat == Category.WEB_OF_SCIENCE:
        add("fixed", "Fixed rate", "A Web of Science paper that is not in Scopus.", cfg.fixed_web_of_science)
        if r.qf:
            add("quartile", "Quartile incentive", f"{inp.quartile}, an Engineering journal: added.", r.qf)
        else:
            add("quartile", "Quartile incentive", _quartile_word(inp, cfg), 0.0)

    add(
        "multiplier",
        "Paper type",
        f"{inp.publication_type or 'No type given'}: the policy multiplies by {pub_m:g}"
        + (", so nothing changes." if pub_m == 1 else "."),
    )
    add("value", "Value of the whole paper", "Before it is shared between the authors.", r.base)
    if r.point is not None:
        lines.append(_share_line(inp, position, r))
    return lines


def _threshold_block(
    person: User | None, full: float | None
) -> dict[str, Any] | None:
    """What a person's research threshold does to `full`, in words.

    The claim is priced as the next one this person is paid, which is where a
    new claim always lands. Reuses `research_threshold.effect_for`, so it can
    never disagree with what happens to the real claim.
    """
    if person is None:
        return None
    name = person.name
    if not research_threshold.is_research(person):
        return {
            "applies": False,
            "person": name,
            "absorbed": 0.0,
            "payable": full,
            "text": f"{name} is not research faculty, so no threshold applies and the incentive is paid in full.",
        }
    if not full:
        return {
            "applies": True,
            "person": name,
            "absorbed": 0.0,
            "payable": full or 0.0,
            "text": f"{name} is research faculty, but the paper carries no incentive, so the threshold is not touched.",
        }
    fake = Claim(owner=person, status=ClaimStatus.DRAFT, claim_reason=ClaimReason.INCENTIVE)
    eff = research_threshold.effect_for(fake, full)
    plan = research_threshold.plan(person)
    if eff.state == "unset" or plan.unset:
        text = f"No research threshold is set for {name}, so the incentive is paid in full for now."
    elif eff.state == "inside":
        text = (
            f"Inside {name}'s research threshold. {_inr(eff.full)} counts against their "
            f"{_inr(plan.threshold)} for {plan.label}, so nothing is paid."
        )
    elif eff.state == "crossing":
        text = (
            f"This crosses {name}'s research threshold. {_inr(eff.absorbed)} of the {_inr(eff.full)} "
            f"counts against their {_inr(plan.threshold)} for {plan.label}; the {_inr(eff.payable)} "
            "above it is paid."
        )
    else:
        text = f"{name}'s research threshold for {plan.label} is already used up, so it is paid in full."
    return {
        "applies": True,
        "person": name,
        "year": plan.label,
        "threshold": plan.threshold,
        "absorbed": eff.absorbed,
        "payable": eff.payable,
        "text": text,
    }


def price_paper(
    inp: PaperInputs,
    *,
    policy_id: str | None = None,
    person: User | None = None,
) -> dict[str, Any]:
    """Price a paper. The answer, and the working that leads to it."""
    obj, cfg, in_force = config_for(policy_id)
    policy = policy_summary(obj, cfg, in_force)
    cautions: list[str] = []
    if not inp.student_project and not inp.counted_only:
        if not is_scopus_indexed(inp.indexing_level) and not is_web_of_science(inp.indexing_level):
            cautions.append(
                "Indexing is not stated, so the paper is priced as a Scopus paper, the way a draft "
                "estimate is. The college pays only Scopus and Web of Science papers."
            )
        if inp.sec_reference_count is None:
            cautions.append(
                f"SEC-affiliated references are not entered. The policy needs {cfg.min_sec_references}, "
                "and a claim with fewer carries no incentive."
            )

    positions = sorted({int(p) for p in (inp.positions or [1])}) or [1]
    rows: list[dict[str, Any]] = []
    results: list[CalcResult] = []
    for pos in positions:
        r = _engine(inp, pos, cfg)
        results.append(r)
        rows.append(
            {
                "position": pos,
                "point": r.point,
                "incentive": r.remuneration,
                "problem": r.error,
            }
        )
    first = results[0]
    first_pos = positions[0]

    problem = first.error
    full = first.remuneration
    threshold = _threshold_block(person, full) if not problem else None
    payable = threshold["payable"] if threshold and threshold.get("applies") else full
    working = [] if problem else working_lines(inp, first_pos, cfg, first)
    if threshold and threshold.get("applies") and (threshold.get("absorbed") or 0) > 0:
        working.append(
            {"key": "threshold", "label": "Research threshold", "text": threshold["text"], "amount": -threshold["absorbed"]}
        )
        working.append(
            {"key": "payable", "label": "Incentive payable", "text": "What is paid to this person.", "amount": payable}
        )

    zero_reason: str | None = None
    if not problem and not payable:
        zero_reason = _plain(first.note) if first.note else None
        if threshold and threshold.get("applies") and full and not payable:
            zero_reason = threshold["text"]
        if zero_reason is None:
            zero_reason = "The policy pays nothing on this combination."

    if problem:
        sentence = f"This paper cannot be priced: {problem}"
    elif zero_reason:
        sentence = zero_reason
    elif inp.student_project:
        sentence = f"A fixed amount for the team, under {policy['label']}"
    else:
        who = f"author {first_pos} of {inp.total_authors}"
        sentence = f"For {who}, under {policy['label']}"
        if len(positions) > 1:
            sentence = (
                f"For {len(positions)} authors at the college, under {policy['label']}. "
                f"This is the incentive for author {first_pos}"
            )
        sentence += ", the policy in force now." if in_force else ", not the policy in force now."
        if threshold and threshold.get("applies") and (threshold.get("absorbed") or 0) > 0:
            sentence = sentence[:-1] + f", after {threshold['person']}'s research threshold."

    college_total = None
    if len(positions) > 1 and all(r.remuneration is not None for r in results):
        college_total = round2(sum(r.remuneration or 0 for r in results))

    return {
        "ok": problem is None,
        "policy": policy,
        "amount": None if problem else payable,
        "full": None if problem else full,
        "paper_value": first.base,
        "category": first.category,
        "category_label": _plain(CATEGORY_LABELS.get(first.category or "", None)) or None,
        "problem": problem,
        "sentence": sentence,
        "zero_reason": zero_reason,
        "working": working,
        "authors": rows if len(positions) > 1 else [],
        "college_total": college_total,
        "threshold": threshold,
        "cautions": cautions,
    }


# ------------------------------------------------------- claims, in memory ---


def claim_inputs(c: Claim) -> dict[str, Any]:
    """The inputs a claim carries, as the form would show them."""
    return {
        "publication_type": c.publication_type or c.aggregation_type,
        "indexing_level": c.indexing_level,
        "quartile": c.quartile,
        "snip": c.snip,
        "engineering_class": c.engineering_class,
        "total_authors": c.total_authors,
        "author_position": c.author_position,
        "student_project": c.claim_reason == ClaimReason.STUDENT_PROJECT,
        "counted_only": bool(c.is_student_publication),
    }


def sec_reference_counts(claim_ids: Iterable[str] | None = None) -> dict[str, int]:
    """Evidenced SEC-affiliated citations per claim: one query for all of them.
    The same rule `price_claim` counts by (a citation with a number)."""
    qs = (
        ClaimAttachment.objects.filter(kind=AttachmentKind.SEC_REFERENCE)
        .exclude(ref_number__isnull=True)
        .exclude(ref_number="")
    )
    if claim_ids is not None:
        qs = qs.filter(claim_id__in=list(claim_ids))
    return {r["claim_id"]: r["n"] for r in qs.values("claim_id").annotate(n=Count("id"))}


def ledger_by_claim(claim_ids: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    qs = PaidLedger.objects.filter(claim__isnull=False)
    if claim_ids is not None:
        qs = qs.filter(claim_id__in=list(claim_ids))
    return {
        r["claim_id"]: {"total": round(r["t"] or 0, 2), "rows": r["n"]}
        for r in qs.values("claim_id").annotate(t=Sum("amount"), n=Count("id"))
    }


def override_entries(claim_ids: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    """The last time a person set each claim's amount by hand, from the audit log.

    Only entries whose "after" carries a `remuneration` count: a title or a
    quartile correction is not an amount.
    """
    qs = AuditLog.objects.filter(entity="Claim", action__in=_OVERRIDE_ACTIONS)
    if claim_ids is not None:
        qs = qs.filter(entity_id__in=list(claim_ids))
    out: dict[str, dict[str, Any]] = {}
    for a in qs.select_related("actor").order_by("created_at"):
        try:
            detail = json.loads(a.detail_json or "{}")
        except ValueError:
            continue
        if "remuneration" not in (detail.get("after") or {}):
            continue
        out[a.entity_id] = {
            "by": a.actor.name if a.actor else "The system",
            "at": a.created_at.date().isoformat(),
            "reason": (detail.get("reason") or "")[:160],
        }
    return out


class Context:
    """What every claim in one request is compared against, fetched once."""

    def __init__(self) -> None:
        self.active_obj = active_policy()
        self.active_cfg = formula_from_model(self.active_obj) if self.active_obj else None
        self._snapshots: dict[str, tuple[FormulaConfigInput, str]] = {}

    def snapshot_for(self, c: Claim) -> tuple[FormulaConfigInput, str] | None:
        js = c.formula_snapshot_json
        if not js:
            return None
        hit = self._snapshots.get(js)
        if hit is None:
            try:
                snap = json.loads(js)
            except ValueError:
                return None
            if not isinstance(snap, dict):
                return None
            cfg = cfg_from_snapshot(snap)
            hit = (cfg, policy_label(cfg.name, cfg.version))
            self._snapshots[js] = hit
        return hit

    @property
    def active_label(self) -> str:
        cfg = self.active_cfg or FormulaConfigInput()
        return policy_label(cfg.name, cfg.version)


def _price(c: Claim, cfg: FormulaConfigInput | None, sec: int | None) -> CalcResult:
    """A claim priced by the very function the chain prices it with."""
    from core.api.common import price_claim

    return price_claim(c, cfg, sec_refs=sec)


def _counted_only(c: Claim) -> bool:
    from core.api.track import _COUNT_ONLY

    return bool(_COUNT_ONLY.search(c.status_note or ""))


def _is_erp(c: Claim) -> bool:
    return (c.ticket_number or "").startswith("ERP-")


def _cause_text(key: str, c: Claim, **k: Any) -> str:
    if key == "manual_override":
        o = k["override"]
        why = f" ({o['reason']})" if o.get("reason") else ""
        return f"{o['by']} entered this amount by hand on {o['at']}{why}, so it is no longer the formula's figure."
    if key == "imported_no_amount":
        return "The old ERP's workbook marked this paid but carried no amount. It needs to be entered from the accounts records."
    if key == "old_erp":
        return (
            "Brought over from the old ERP with the amount its own accounts sheet worked out. It carries no "
            "record of the policy it was priced under, so it is compared with the policy in force."
        )
    if key == "inputs_changed":
        r = k["result"]
        was = _inr(c.base_amount) + (
            f" for the paper and {c.author_point:g} for the author's share" if c.author_point is not None else ""
        )
        now = _inr(r.base) + (f" and {r.point:g}" if r.point is not None else "")
        return (
            f"It was priced at {was}. Its figures now give {now}. "
            "Something the price depends on was edited after pricing (SNIP, quartile, authors or their order, "
            "type, indexing or SEC references), and the claim was not priced again."
        )
    if key == "not_priced":
        return "The claim has no price recorded yet."
    if key == "cannot_be_priced":
        return f"The formula cannot price it now: {k.get('error')}"
    if key == "counted_only":
        return "The accounts sheet paid nothing on purpose. The paper was processed only to count it."
    if key == "old_quota":
        return "It was paid nothing under the old papers-a-year quota, which no longer applies."
    return "The amount differs from the formula, and neither the claim's figures nor its history explain it."


def assess(
    c: Claim,
    ctx: Context,
    *,
    sec: int | None = None,
    ledger: dict[str, Any] | None = None,
    override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Every number and the one cause for a claim. `explain_claim` and
    `check_many` are both this, so the list and the detail cannot disagree."""
    recorded = c.remuneration
    absorbed = round(c.research_absorbed or 0, 2)
    full = round2((recorded or 0) + absorbed)
    snap = ctx.snapshot_for(c)
    if _is_erp(c) and not sec:
        # An imported claim carries no evidence files in this system, so "0
        # citations" is not a finding: the old sheet decided that itself. The
        # references check is left as "not checked", as a draft estimate does.
        sec = None
    base_cfg = snap[0] if snap else ctx.active_cfg
    base_label = snap[1] if snap else ctx.active_label

    priced = _price(c, base_cfg, sec)
    expected = priced.remuneration
    if snap and ctx.active_cfg is not None and snap[0] != ctx.active_cfg:
        today_res = _price(c, ctx.active_cfg, sec)
    else:
        today_res = priced
    today = today_res.remuneration

    delta = None if expected is None else round2(full - expected)
    cause: str | None = None
    text: str | None = None
    if _counted_only(c) and not (recorded or 0):
        cause = "counted_only"
    elif not (recorded or 0) and c.quota_applied and not absorbed:
        cause = "old_quota"
    elif expected is None:
        if (recorded or 0) > 0 or priced.error:
            cause = "cannot_be_priced"
    elif abs(delta) > TOLERANCE:
        if override:
            cause = "manual_override"
        elif not snap and _is_erp(c):
            paid_blank = c.status == ClaimStatus.PAID and not (recorded or 0)
            cause = "imported_no_amount" if paid_blank else "old_erp"
        elif c.base_amount is None and c.remuneration_category is None and recorded is None:
            cause = "not_priced"
        elif (
            c.base_amount is not None
            and (
                abs((priced.base or 0) - c.base_amount) > TOLERANCE
                or abs((priced.point or 0) - (c.author_point or 0)) > 1e-6
            )
        ):
            cause = "inputs_changed"
        else:
            cause = "unexplained"
    if cause:
        text = _cause_text(
            cause, c, override=override, result=priced, error=priced.error
        )

    policy_moved = (
        snap is not None
        and cause is None
        and today is not None
        and expected is not None
        and abs(today - expected) > TOLERANCE
    )
    ledger_total = ledger["total"] if ledger else 0.0
    ledger_differs = (
        c.status == ClaimStatus.PAID
        and abs(ledger_total - (recorded or 0)) > TOLERANCE
        and not (cause in ("counted_only", "old_quota", "imported_no_amount") and not ledger_total)
    )
    return {
        "recorded": recorded,
        "absorbed": absorbed,
        "full": full,
        "expected": expected,
        "expected_result": priced,
        "expected_policy": base_label,
        "has_snapshot": snap is not None,
        "today": today,
        "today_result": today_res,
        "delta": delta,
        "cause": cause,
        "cause_text": text,
        "policy_moved": bool(policy_moved),
        "ledger_total": ledger_total,
        "ledger_differs": bool(ledger_differs),
    }


def _stage_label(c: Claim) -> str:
    from core.services import claim_numbers

    return claim_numbers.outcome(c)["label"]


def claim_month(c: Claim) -> str | None:
    """The month a claim belongs to on this page: paid in, else filed in."""
    if c.payout_month:
        return c.payout_month.isoformat()[:7]
    when = c.paid_at or c.submitted_at or c.created_at
    return when.date().isoformat()[:7] if when else None


def find_claim(q: str) -> Claim | None:
    """A claim by number, however it was typed ("fp 2026 123"), or by id."""
    from core.services import claim_numbers

    q = (q or "").strip()
    if not q:
        return None
    qs = Claim.objects.select_related("owner", "formula_config").exclude(status=ClaimStatus.DRAFT)
    for form in claim_numbers.variants(q):
        hit = qs.filter(ticket_number__iexact=form).first()
        if hit:
            return hit
    return qs.filter(pk=q).first()


def explain_claim(c: Claim) -> dict[str, Any]:
    """Check a claim: recorded, formula under its snapshot, formula today, ledger."""
    ctx = Context()
    sec = sec_reference_counts([c.id]).get(c.id, 0)
    ledger_rows = list(PaidLedger.objects.filter(claim=c).order_by("payout_month", "created_at"))
    ledger = {"total": round(sum(r.amount or 0 for r in ledger_rows), 2), "rows": len(ledger_rows)}
    override = override_entries([c.id]).get(c.id)
    a = assess(c, ctx, sec=sec, ledger=ledger, override=override)
    snap = ctx.snapshot_for(c)

    def res_block(res: CalcResult, label: str, in_force: bool) -> dict[str, Any]:
        return {
            "policy": label,
            "in_force": in_force,
            "amount": res.remuneration,
            "paper_value": res.base,
            "category": _plain(CATEGORY_LABELS.get(res.category or "", None)) or None,
            "note": _plain(res.note) if res.note else None,
            "problem": res.error,
        }

    today_block = res_block(a["today_result"], ctx.active_label, True)
    # What the research threshold would do to a claim priced at today's figure.
    today_payable = None
    if a["today"] is not None:
        try:
            today_payable = research_threshold.effect_for(c, a["today"]).payable
        except Exception:  # a hint must not take the page down
            today_payable = a["today"]
    today_block["payable"] = today_payable
    snapshot_block = None
    if snap is not None:
        snapshot_block = res_block(a["expected_result"], a["expected_policy"], False)
        snapshot_block["in_force"] = bool(
            ctx.active_cfg is not None and snap[0] == ctx.active_cfg
        )

    differences: list[dict[str, Any]] = []
    if a["cause"]:
        meta = CAUSES[a["cause"]]
        differences.append(
            {
                "key": "recorded",
                "cause": a["cause"],
                "cause_label": meta["label"],
                "expected": meta["expected"],
                "compare": (
                    f"Recorded {_inr(a['full'])} against {_inr(a['expected'])} under {a['expected_policy']}"
                    if a["expected"] is not None
                    else "Recorded against a formula that cannot price it"
                ),
                "delta": a["delta"],
                "text": a["cause_text"],
            }
        )
    if a["policy_moved"]:
        differences.append(
            {
                "key": "policy",
                "cause": "policy_changed",
                "cause_label": CAUSES["policy_changed"]["label"],
                "expected": True,
                "compare": f"{_inr(a['expected'])} under {a['expected_policy']}, {_inr(a['today'])} under {ctx.active_label}",
                "delta": round2((a["today"] or 0) - (a["expected"] or 0)),
                "text": (
                    f"It agrees with the policy it was priced under. {ctx.active_label} is in force now and "
                    f"would give {_inr(a['today'])}. Nothing is owed or wrong: a paid claim keeps its price."
                ),
            }
        )
    if a["absorbed"] > 0:
        differences.append(
            {
                "key": "threshold",
                "cause": "threshold",
                "cause_label": CAUSES["threshold"]["label"],
                "expected": True,
                "compare": f"Policy amount {_inr(a['full'])}, payable {_inr(a['recorded'])}",
                "delta": -a["absorbed"],
                "text": (
                    f"The research threshold took {_inr(a['absorbed'])} of the {_inr(a['full'])} the policy "
                    f"gives, so {_inr(a['recorded'])} is payable."
                ),
            }
        )
    if a["ledger_differs"]:
        differences.append(
            {
                "key": "ledger",
                "cause": "ledger_differs",
                "cause_label": CAUSES["ledger_differs"]["label"],
                "expected": False,
                "compare": f"Claim {_inr(a['recorded'])}, ledger {_inr(a['ledger_total'])}",
                "delta": round2(a["ledger_total"] - (a["recorded"] or 0)),
                "text": "The claim and the money the ledger shows paid do not agree.",
            }
        )

    problems = [d for d in differences if not d["expected"]]
    if problems and problems[0]["key"] == "recorded" and a["delta"] is not None:
        d = a["delta"]
        headline = (
            f"The recorded amount is {_inr(abs(d))} {'more' if d > 0 else 'less'} than the policy gives."
        )
    elif problems:
        headline = problems[0]["text"]
    elif a["cause"] in ("counted_only", "old_quota"):
        headline = "Nothing was due on this claim, and nothing was paid."
    elif a["absorbed"] > 0:
        headline = f"The recorded amount agrees with the policy, less {_inr(a['absorbed'])} taken by the research threshold."
    else:
        headline = "The recorded amount agrees with the policy it was priced under."
    if a["policy_moved"] and not problems:
        headline += f" The policy in force now would give {_inr(a['today'])}."

    ledger_out = [
        {
            "month": r.payout_month.isoformat()[:7] if r.payout_month else None,
            "voucher": r.voucher_number,
            "amount": r.amount,
        }
        for r in ledger_rows
    ]
    return {
        "claim": {
            "id": c.id,
            "ticket_number": c.ticket_number,
            "imported": _is_erp(c),
            "title": c.paper_title,
            "journal": c.journal_title,
            "status": _stage_label(c),
            "month": claim_month(c),
            "user_id": c.owner_id,
            "name": c.owner.name,
            "department": c.owner.department,
        },
        "inputs": {**claim_inputs(c), "sec_references": sec, "priced_category": _plain(CATEGORY_LABELS.get(c.remuneration_category or "", None)) or None},
        "recorded": {
            "amount": a["recorded"],
            "absorbed": a["absorbed"],
            "policy_amount": a["full"],
            "note": _plain(c.remuneration_note) if c.remuneration_note else None,
        },
        "under_snapshot": snapshot_block,
        "under_today": today_block,
        "ledger": {"total": ledger["total"], "rows": ledger_out},
        "differences": differences,
        "agrees": not problems,
        "headline": headline,
        "delta": a["delta"],
    }


# ------------------------------------------------------------ check many -----

_HEAVY = (
    "scopus_raw_json",
    "scimago_raw_json",
    "verification_snapshot_json",
    "reference_articles",
    "sec_refs",
    "duplicate_matches_json",
    "authors_json",
    "subjects_json",
    "scimago_categories_json",
    "contest_note",
    "hold_reason",
    "manual_verification_note",
    "manual_quartile_reason",
    "override_reason",
    "year_mismatch_reason",
)


def statuses_for(stages: Iterable[str]) -> list[str]:
    out: list[str] = []
    for s in stages:
        out.extend(STAGE_STATUSES.get(s, ()))
    return out


def check_many(
    *,
    stages: Iterable[str] = DEFAULT_STAGES,
    department: str | None = None,
    month: str | None = None,
) -> dict[str, Any]:
    """Every claim in the chosen stages against its own pricing snapshot.

    Four queries however many claims there are (claims with their owners, SEC
    reference counts, ledger sums, hand-entered amounts); the recomputation is
    `assess`, in memory. Returns every row that differs, plus the totals.
    """
    stages = [s for s in stages if s in STAGE_STATUSES] or list(DEFAULT_STAGES)
    ctx = Context()
    qs = (
        Claim.objects.filter(status__in=statuses_for(stages))
        .select_related("owner", "formula_config")
        .defer(*_HEAVY)
    )
    if department:
        qs = qs.filter(owner__department=department)
    claims = list(qs.order_by("ticket_number"))
    if month:
        claims = [c for c in claims if claim_month(c) == month]
    ids = [c.id for c in claims]
    sec = sec_reference_counts()
    ledger = ledger_by_claim()
    overrides = override_entries()

    departments = sorted({c.owner.department for c in claims if c.owner.department})
    months = sorted({m for m in (claim_month(c) for c in claims) if m}, reverse=True)

    rows: list[dict[str, Any]] = []
    totals = {
        "checked": len(claims),
        "agree": 0,
        "differ": 0,
        "over": 0.0,
        "under": 0.0,
        "left_out": 0,
        "threshold_claims": 0,
        "threshold_total": 0.0,
        "policy_moved": 0,
        "ledger_differs": 0,
    }
    by_cause: dict[str, dict[str, Any]] = {}
    for c in claims:
        a = assess(c, ctx, sec=sec.get(c.id, 0), ledger=ledger.get(c.id), override=overrides.get(c.id))
        if a["absorbed"] > 0:
            totals["threshold_claims"] += 1
            totals["threshold_total"] += a["absorbed"]
        if a["policy_moved"]:
            totals["policy_moved"] += 1
        if a["ledger_differs"]:
            totals["ledger_differs"] += 1
        cause = a["cause"]
        if cause and CAUSES[cause]["expected"]:
            totals["left_out"] += 1
            continue
        if not cause:
            totals["agree"] += 1
            continue
        totals["differ"] += 1
        d = a["delta"] or 0.0
        if a["expected"] is None:
            d = a["full"]
        if d > 0:
            totals["over"] += d
        else:
            totals["under"] += -d
        slot = by_cause.setdefault(
            cause, {"cause": cause, "label": CAUSES[cause]["label"], "count": 0, "over": 0.0, "under": 0.0}
        )
        slot["count"] += 1
        slot["over" if d > 0 else "under"] += abs(d)
        rows.append(
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "imported": _is_erp(c),
                "user_id": c.owner_id,
                "name": c.owner.name,
                "department": c.owner.department,
                "title": c.paper_title,
                "status": _stage_label(c),
                "month": claim_month(c),
                "recorded": a["recorded"],
                "policy_amount": a["full"],
                "formula": a["expected"],
                "difference": round2(d),
                "policy": a["expected_policy"],
                "cause": cause,
                "cause_label": CAUSES[cause]["label"],
                "cause_text": a["cause_text"],
                # Where a super admin puts it right: the data-fix queue for a hole
                # left by the import, the claim itself for anything else.
                "fix": "data" if cause == "imported_no_amount" else "claim",
            }
        )
    rows.sort(key=lambda r: (-abs(r["difference"]), r["ticket_number"] or ""))
    totals["over"] = round2(totals["over"])
    totals["under"] = round2(totals["under"])
    totals["net"] = round2(totals["over"] - totals["under"])
    totals["threshold_total"] = round2(totals["threshold_total"])
    causes = sorted(by_cause.values(), key=lambda s: -(s["over"] + s["under"]))
    for s in causes:
        s["over"], s["under"] = round2(s["over"]), round2(s["under"])
    return {
        "stages": stages,
        "policy": ctx.active_label,
        "totals": totals,
        "causes": causes,
        "rows": rows,
        "departments": departments,
        "months": months,
        "claims_checked": len(ids),
    }
