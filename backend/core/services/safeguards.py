"""The daily check that the money safeguards held.

The database refuses a second payment, the pay endpoint refuses a changed
amount, the filing form refuses a repeat. This module is the independent
witness: it recomputes, from the rows themselves, whether any of that was
bypassed (an import, a shell, a restore, a constraint that a migration had to
skip) and says so, in a list a person can work through.

Read-only. Every check is a function from the database to a `Check`, and
`run_and_store` keeps the last report in SystemSetting("safeguards_report") for
the Safeguards page and the readiness checklist. The claim-shaped checks are
also the queries behind the Faults screen (`claim_sets`), so the two cannot
disagree about how many there are.

Checks are tagged `scope`:

* "money": about payments, the ledger and the bank file. Finance may see them.
* "claims": about doubts over a paper (duplicate overrides, co-author claims,
  repeat payments). The Director and Finance are not told about these
  (`core.visibility`), so the Finance view never carries them or their counts.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable

from django.db import connection
from django.db.models import Count, Exists, F, OuterRef, Q, Sum
from django.db.models.functions import Coalesce, Lower
from django.utils import timezone

from core.models import (
    AuditLog,
    BankExport,
    Claim,
    ClaimAction,
    ClaimFlag,
    ClaimStatus,
    DuplicateFinding,
    PaidLedger,
    SystemSetting,
    User,
)
from core.services import research_threshold

logger = logging.getLogger(__name__)

REPORT_KEY = "safeguards_report"
SAMPLE = 25
TOLERANCE = 0.5
HISTORY = 30
NOT_HOLDING_THE_PAPER = (ClaimStatus.DRAFT, ClaimStatus.REJECTED)


@dataclass
class Check:
    key: str
    group: str
    title: str
    #: error: money may be wrong. warning: needs a person's eye. info: for the record.
    severity: str
    scope: str = "money"
    count: int = 0
    rows: list[dict[str, Any]] = field(default_factory=list)
    help: str = ""
    #: Where a person puts it right.
    fix_to: str = ""
    fix_label: str = ""
    #: What the check guards, for the table in docs/ops/safeguards.md.
    guard: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key, "group": self.group, "title": self.title, "severity": self.severity,
            "scope": self.scope, "count": self.count, "rows": self.rows[:SAMPLE], "help": self.help,
            "fix_to": self.fix_to if self.count else "", "fix_label": self.fix_label if self.count else "",
            "status": "ok" if not self.count else ("problem" if self.severity == "error" else "look"),
        }


def _claim_row(c: Claim, extra: str = "") -> dict[str, Any]:
    label = c.ticket_number or c.pk
    title = (c.paper_title or "")[:70]
    who = c.owner.name if c.owner_id and c.owner else ""
    tail = " - ".join(x for x in (who, extra) if x)
    return {"id": c.pk, "label": f"{label} {title}" + (f" ({tail})" if tail else ""), "href": f"/papers/{c.pk}"}


def _from_claims(check: Check, qs, extra: Callable[[Claim], str] | None = None) -> Check:
    check.count = qs.count()
    check.rows = [_claim_row(c, extra(c) if extra else "") for c in qs.select_related("owner").order_by("ticket_number")[:SAMPLE]]
    return check


# ------------------------------------------------------------- the sets --


def claim_sets() -> dict[str, Any]:
    """The query behind every claim-shaped check, by key. One definition: the
    Safeguards page counts it, the Faults screen counts and lists it."""
    paid = Claim.objects.filter(status=ClaimStatus.PAID)

    # Correlated subqueries, not lists read first: building the sets must cost
    # no query of its own, because the Faults screen builds them on every visit.
    twin_payment = PaidLedger.objects.filter(
        claim=OuterRef("claim"), kind=PaidLedger.Kind.PAYMENT, cycle=OuterRef("cycle")
    ).exclude(pk=OuterRef("pk"))
    doubled_payment = PaidLedger.objects.filter(claim=OuterRef("pk"), kind=PaidLedger.Kind.PAYMENT).filter(
        Exists(twin_payment)
    )
    twin_filing = (
        Claim.objects.annotate(d2=Lower("doi"))
        .filter(owner=OuterRef("owner"), d2=OuterRef("d"))
        .exclude(pk=OuterRef("pk")).exclude(status__in=NOT_HOLDING_THE_PAPER)
        .exclude(ticket_number__startswith="ERP-")
    )
    paid_by_authoriser = ClaimAction.objects.filter(
        claim=OuterRef("pk"), action="MARK_PAID", actor_id=OuterRef("director_approved_by_id")
    )

    full = Coalesce("remuneration", 0.0) + Coalesce("research_absorbed", 0.0)
    return {
        "paid_no_ledger": paid.filter(ledger_rows__isnull=True),
        "dup_payment": Claim.objects.filter(Exists(doubled_payment)),
        "ledger_mismatch": (
            paid.filter(ledger_rows__isnull=False).annotate(ledger_total=Sum("ledger_rows__amount"))
            .filter(remuneration__isnull=False).exclude(remuneration=0)
            .exclude(ledger_total__gte=F("remuneration") - 0.01, ledger_total__lte=F("remuneration") + 0.01)
        ),
        "ledger_unpaid": (
            Claim.objects.exclude(status=ClaimStatus.PAID).annotate(ledger_net=Sum("ledger_rows__amount"))
            .filter(ledger_net__gt=0.005)
        ),
        "authorised_drift": (
            Claim.objects.filter(status=ClaimStatus.DIRECTOR_APPROVED, director_approved_at__isnull=False,
                                 authorised_amount__isnull=False)
            .annotate(policy_now=full)
            .exclude(policy_now__gte=F("authorised_amount") - 0.005, policy_now__lte=F("authorised_amount") + 0.005)
        ),
        "payable_inactive": Claim.objects.filter(status=ClaimStatus.DIRECTOR_APPROVED, owner__active=False),
        "dup_filed": (
            Claim.objects.exclude(doi__isnull=True).exclude(doi="").exclude(status__in=NOT_HOLDING_THE_PAPER)
            .exclude(ticket_number__startswith="ERP-").annotate(d=Lower("doi")).filter(Exists(twin_filing))
        ),
        "self_paid": Claim.objects.filter(director_approved_by__isnull=False).filter(Exists(paid_by_authoriser)),
        "paid_no_audit": (
            paid.exclude(ticket_number__startswith="ERP-").exclude(actions__action="MARK_PAID")
        ),
        "override_unseconded": (
            Claim.objects.filter(duplicate_warning=True, override_duplicate=True,
                                 status__in=[ClaimStatus.PRINCIPAL_APPROVED, ClaimStatus.DIRECTOR_APPROVED, ClaimStatus.PAID])
            .filter(Q(second_approved_by__isnull=True) | Q(second_approved_by=F("cleared_by")))
            .exclude(ticket_number__startswith="ERP-")
        ),
    }


# ------------------------------------------------------------ the checks --


def check_paying_twice() -> list[Check]:
    s = claim_sets()
    out = [
        _from_claims(Check(
            "dup_payment", "Paying twice", "Claims with more than one live payment", "error",
            help="One payment per claim is a rule of the database. Two rows in one cycle means the rule was "
                 "bypassed or could not be added. Reverse the extra payment and recover the money.",
            fix_to="/ledger", fix_label="Open the ledger",
            guard="one_payment_per_claim_cycle"), s["dup_payment"],
            lambda c: f"{c.ledger_rows.filter(kind='PAYMENT').count()} payments"),
        _from_claims(Check(
            "paid_no_ledger", "Paying twice", "Claims marked paid with no ledger row", "error",
            help="Every payment has a ledger row. A paid claim without one is money nobody can account for, "
                 "and it can be paid again because the ledger does not show it.",
            fix_to="/ledger?problem=no-ledger", fix_label="Fix on the ledger"), s["paid_no_ledger"]),
        _from_claims(Check(
            "ledger_unpaid", "Paying twice", "Money on the ledger for a claim that is not marked paid", "error",
            help="The ledger says it was paid, the claim says it was not. Paying it now would pay it twice.",
            fix_to="/ledger", fix_label="Open the ledger"), s["ledger_unpaid"],
            lambda c: f"₹{float(c.ledger_net or 0):,.0f} on the ledger"),
    ]
    orphan = PaidLedger.objects.filter(claim__isnull=True).filter(Q(raw_json__isnull=True) | Q(raw_json=""))
    f = Check("orphan_ledger", "Paying twice", "Payments made here whose claim is gone", "error",
              help="A payment this system made, now with no claim (the claim was deleted). The money went out "
                   "and nothing says what for. Link it to its claim or record why it has none.",
              fix_to="/ledger?problem=no-claim", fix_label="Open the ledger")
    f.count = orphan.count()
    f.rows = [{"id": r.pk, "label": f"{r.faculty_name or 'Someone'} ₹{r.amount:,.0f} {(r.paper_title or '')[:60]}",
               "href": "/ledger?problem=no-claim"} for r in orphan[:SAMPLE]]
    out.append(f)
    return out


def check_amounts() -> list[Check]:
    s = claim_sets()
    out = [
        _from_claims(Check(
            "ledger_mismatch", "Amounts", "Paid claims whose ledger total differs from the amount", "error",
            help="What the claim says it was paid and what the ledger holds disagree by more than a rupee.",
            fix_to="/ledger?problem=mismatch", fix_label="Fix on the ledger"), s["ledger_mismatch"],
            lambda c: f"claim ₹{(c.remuneration or 0):,.0f}, ledger ₹{float(c.ledger_total or 0):,.0f}"),
        _from_claims(Check(
            "authorised_drift", "Amounts", "Authorised claims that no longer price at the authorised amount", "error",
            help="The Director authorised one figure and the claim now prices at another. Paying it sends it back "
                 "to the Principal; this shows it before anyone tries.",
            fix_to="/payments", fix_label="Open payments"), s["authorised_drift"],
            lambda c: f"authorised ₹{(c.authorised_amount or 0):,.0f}, now ₹{float(c.policy_now or 0):,.0f}"),
    ]
    out.append(_snapshot_mismatch())
    out.append(_threshold())
    return out


def _snapshot_mismatch() -> Check:
    """Claims priced under a stored formula whose amount differs from what
    that same formula gives today from the same figures."""
    from core.services import calculator

    f = Check("snapshot_mismatch", "Amounts", "Claims whose amount differs from their own pricing snapshot", "warning",
              help="The amount was priced under a stored formula, and pricing the same figures under it again "
                   "gives a different number: something the price depends on was edited afterwards.",
              fix_to="/calculator", fix_label="Check in the calculator")
    claims = list(
        Claim.objects.filter(status__in=[ClaimStatus.PAID, ClaimStatus.DIRECTOR_APPROVED], formula_snapshot_json__isnull=False)
        .exclude(formula_snapshot_json="").exclude(ticket_number__startswith="ERP-").select_related("owner")[:2000]
    )
    if not claims:
        return f
    ctx = calculator.Context()
    sec = calculator.sec_reference_counts([c.id for c in claims])
    ledger = calculator.ledger_by_claim([c.id for c in claims])
    overrides = calculator.override_entries([c.id for c in claims])
    bad: list[tuple[Claim, str]] = []
    for c in claims:
        try:
            a = calculator.assess(c, ctx, sec=sec.get(c.id, 0), ledger=ledger.get(c.id), override=overrides.get(c.id))
        except Exception:  # noqa: BLE001 -- one unpriceable claim must not hide the rest
            logger.exception("snapshot_check_failed claim=%s", c.pk)
            continue
        if a["cause"] in ("inputs_changed", "unexplained"):
            bad.append((c, f"recorded ₹{a['full']:,.0f}, formula ₹{(a['expected'] or 0):,.0f}"))
    f.count = len(bad)
    f.rows = [_claim_row(c, why) for c, why in bad[:SAMPLE]]
    return f


def _threshold() -> Check:
    """A research faculty member's yearly threshold, and what was absorbed against it."""
    f = Check("threshold_absorbed", "Amounts", "Research threshold absorbed more than it allows", "error",
              help="The part of a person's incentives that counted against their yearly threshold is more than "
                   "the threshold itself, so they were paid less than they should have been. This is what a "
                   "double absorb looks like.",
              fix_to="/research-faculty", fix_label="Open research faculty")
    rows: list[dict[str, Any]] = []
    people = User.objects.filter(faculty_type="RESEARCH", active=True)
    for u in people:
        hist = research_threshold.history(u.id)
        if not hist:
            continue
        by_year: dict[Any, float] = {}
        limit_of: dict[Any, float | None] = {}
        for c in (Claim.objects.filter(owner=u, status=ClaimStatus.PAID, research_absorbed__gt=0)
                  .only("research_absorbed", "payout_month", "paid_at", "ticket_number")):
            d = research_threshold._paid_date(c)
            if d is None:
                continue
            start, _ = research_threshold.year_bounds(d)
            by_year[start] = by_year.get(start, 0.0) + (c.research_absorbed or 0.0)
            limit_of.setdefault(start, research_threshold.threshold_on(hist, d))
        for start, absorbed in by_year.items():
            limit = limit_of.get(start)
            if limit is not None and absorbed > limit + TOLERANCE:
                rows.append({
                    "id": f"{u.pk}:{start}",
                    "label": f"{u.name}, {research_threshold.year_label(start)}: ₹{absorbed:,.0f} absorbed, "
                             f"threshold ₹{limit:,.0f}",
                    "href": f"/research-faculty?user={u.pk}",
                })
    f.count = len(rows)
    f.rows = rows[:SAMPLE]
    return f


def check_who_did_what() -> list[Check]:
    s = claim_sets()
    return [
        _from_claims(Check(
            "self_paid", "Who did what", "Paid by the person who authorised it", "warning",
            help="Whoever authorises a payment does not also make it, unless a super admin stands in and says why. "
                 "These went through anyway; the reason is in the audit trail.",
            fix_to="/audit", fix_label="Open the audit trail"), s["self_paid"]),
        _from_claims(Check(
            "paid_no_audit", "Who did what", "Paid with no record of who paid it", "error",
            help="A claim made here is marked paid but no payment step was written to its history. Money moved "
                 "without an audit row.",
            fix_to="/audit", fix_label="Open the audit trail"), s["paid_no_audit"]),
        _from_claims(Check(
            "payable_inactive", "Who did what", "Authorised claims whose owner's account is switched off", "warning",
            help="Finance cannot pay these without a super admin and a reason. Reactivate the person or reassign it.",
            fix_to="/people", fix_label="Open people"), s["payable_inactive"],
            lambda c: c.owner.email),
    ]


def check_claimed_twice() -> list[Check]:
    s = claim_sets()
    out = [
        _from_claims(Check(
            "dup_filed", "Papers claimed twice", "The same person has filed the same paper more than once", "error",
            scope="claims",
            help="One claim per person per paper is a rule of the database; this exists only where the data "
                 "was already doubled when the rule was added. Reject all but one.",
            fix_to="/clearing", fix_label="Open the queue"), s["dup_filed"]),
        _from_claims(Check(
            "override_unseconded", "Papers claimed twice",
            "A payment-history warning was set aside without a second approver", "error", scope="claims",
            help="A duplicate warning dismissed by one person needs a second, different person before money moves.",
            fix_to="/duplicates", fix_label="Open duplicates"), s["override_unseconded"]),
    ]
    open_findings = DuplicateFinding.objects.filter(status=DuplicateFinding.Status.OPEN,
                                                    kind=DuplicateFinding.Kind.SAME_PERSON)
    f = Check("repeat_payments", "Papers claimed twice", "Papers paid to the same person more than once", "warning",
              scope="claims",
              help="Found by the sweep over everything already paid, including the old workbook. Each is a "
                   "judgement somebody records: a real repeat, or not.",
              fix_to="/duplicates", fix_label="Open duplicates")
    f.count = open_findings.count()
    f.rows = [{"id": x.pk, "label": f"{x.faculty_name or 'Someone'}: {(x.paper_title or '')[:60]} "
                                    f"({x.payment_count} payments, ₹{x.extra_amount:,.0f} repeated)",
               "href": "/duplicates"} for x in open_findings.order_by("-extra_amount")[:SAMPLE]]
    out.append(f)
    flags = ClaimFlag.objects.filter(kind=ClaimFlag.Kind.DUPLICATE, source=ClaimFlag.Source.AUTO,
                                     resolved_at__isnull=True, auto_key__startswith="coauthor:")
    g = Check("coauthor_claims", "Papers claimed twice", "Co-authors who have both claimed the same paper", "info",
              scope="claims",
              help="Allowed: the scheme pays each author by position. Listed so the research cell confirms the "
                   "positions agree before either is paid.",
              fix_to="/flags", fix_label="Open flags")
    g.count = flags.count()
    g.rows = [{"id": x.pk, "label": f"{x.claim.ticket_number or x.claim_id}: {x.note[:110]}",
               "href": f"/flags?claim={x.claim_id}"} for x in flags.select_related("claim")[:SAMPLE]]
    out.append(g)
    return out


def check_bank_files() -> list[Check]:
    f = Check("bank_reexport", "Paying twice", "Months whose bank file was generated more than once", "info",
              help="The bank pays what it is sent. A second file for a month is how a month is paid twice, so "
                   "every file is recorded and a repeat needs a reason.",
              fix_to="/statements", fix_label="Open statements")
    months = (BankExport.objects.values("month").annotate(n=Count("id")).filter(n__gt=1).order_by("-month"))
    rows = []
    for m in months[:SAMPLE]:
        last = BankExport.objects.filter(month=m["month"]).order_by("-created_at").first()
        rows.append({"id": m["month"], "label": f"{m['month']}: {m['n']} files, last {last.created_at:%d %b %Y} "
                                                f"({last.scope}{', ' + last.reason[:60] if last.reason else ''})",
                     "href": f"/statements?month={m['month']}"})
    f.count = months.count()
    f.rows = rows
    return [f]


REQUIRED_CONSTRAINTS = (
    ("core_paidledger", "one_payment_per_claim_cycle"),
    ("core_paidledger", "one_reversal_per_claim_cycle"),
    ("core_claim", "one_filed_claim_per_person_per_doi"),
)


def check_database() -> list[Check]:
    """Whether the safeguards the database itself holds are actually there.
    A migration that met existing duplicates skips the constraint and says so
    once, in a deploy log nobody reads; this says so every day."""
    f = Check("db_constraints", "The database", "Database safeguards that are missing", "error",
              help="A unique rule the code relies on is not in the database, usually because the data already broke the rule "
                   "when the migration ran. Resolve the rows listed above, then run: "
                   "python manage.py migrate core 0074 && python manage.py migrate",
              guard="migration 0075")
    missing = []
    with connection.cursor() as cur:
        for table, name in REQUIRED_CONSTRAINTS:
            try:
                have = connection.introspection.get_constraints(cur, table)
            except Exception:  # noqa: BLE001
                have = {}
            if name not in have:
                missing.append((table, name))
        trigger_missing = False
        if connection.vendor == "postgresql":
            cur.execute("SELECT 1 FROM pg_trigger WHERE tgname = 'core_auditlog_append_only'")
            trigger_missing = cur.fetchone() is None
    f.count = len(missing) + (1 if trigger_missing else 0)
    f.rows = [{"id": n, "label": f"{n} is missing on {t}", "href": ""} for t, n in missing]
    if trigger_missing:
        f.rows.append({"id": "audit-trigger", "label": "The audit log has no append-only trigger", "href": ""})
    return [f]


CHECKS: list[Callable[[], list[Check]]] = [
    check_paying_twice, check_amounts, check_who_did_what, check_claimed_twice, check_bank_files, check_database,
]


# --------------------------------------------------------------- running --


def run_audit() -> dict[str, Any]:
    started = timezone.now()
    checks: list[dict[str, Any]] = []
    for fn in CHECKS:
        try:
            checks += [c.as_dict() for c in fn()]
        except Exception as exc:  # noqa: BLE001 -- one broken check must not hide the rest
            logger.exception("safeguard check %s failed", fn.__name__)
            checks.append(Check(fn.__name__, "Audit", f"{fn.__name__} could not run: {exc}", "error", count=1).as_dict())
    problems = {"error": 0, "warning": 0, "info": 0}
    for c in checks:
        if c["count"]:
            problems[c["severity"]] += 1
    return {
        "ran_at": started.isoformat(),
        "seconds": round((timezone.now() - started).total_seconds(), 2),
        "problems": problems,
        "checks": checks,
    }


def run_and_store(*, by: User | None = None) -> dict[str, Any]:
    """Run every check, keep the report, write one audit row, and tell the
    super admins when there are more errors than there were last time."""
    previous = last_report()
    report = run_audit()
    report["by"] = (by.name or by.email) if by else "The nightly check"
    history = (previous or {}).get("history", [])
    history.append({"ran_at": report["ran_at"], **report["problems"]})
    report["history"] = history[-HISTORY:]
    SystemSetting.objects.update_or_create(key=REPORT_KEY, defaults={"value": report})
    AuditLog.objects.create(
        actor=by, action="SAFEGUARD_CHECK", entity="Safeguards",
        detail_json=json.dumps({"problems": report["problems"], "seconds": report["seconds"]}),
    )
    before = (previous or {}).get("problems", {}).get("error", 0)
    if report["problems"]["error"] > before:
        from core.api.common import _notify_admin_users

        _notify_admin_users(
            "Money safeguards found a problem",
            f"{report['problems']['error']} checks failed. Open Safeguards to see which payments or claims.",
            "/safeguards", super_admin_only=True,
        )
    return report


def last_report() -> dict[str, Any] | None:
    row = SystemSetting.objects.filter(key=REPORT_KEY).first()
    return row.value if row else None


def for_finance(report: dict[str, Any] | None) -> dict[str, Any] | None:
    """The report as Finance may read it: money checks only, and the counts of
    those alone, so no total quietly includes a doubt Finance is not told of."""
    if report is None:
        return None
    checks = [c for c in report["checks"] if c.get("scope") == "money"]
    problems = {"error": 0, "warning": 0, "info": 0}
    for c in checks:
        if c["count"]:
            problems[c["severity"]] += 1
    return {**report, "checks": checks, "problems": problems, "history": []}
