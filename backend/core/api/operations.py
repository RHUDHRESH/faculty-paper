"""operations: what is wrong right now.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.common import require_user

from datetime import timedelta
from typing import Any
from django.db.models import F, Q
from django.http import HttpRequest
from django.utils import timezone
from ninja.errors import HttpError
from core.models import Claim, ClaimStatus, Role, User
from core.services import claim_fixes, rbac, safeguards
from core.services.aggregate_cache import cached

#: The claim-shaped safeguard checks the Faults screen lists (the rest live on
#: the Safeguards page only).
_SAFEGUARD_FAULTS = (
    "dup_payment", "ledger_unpaid", "ledger_mismatch", "authorised_drift", "dup_filed", "paid_no_audit",
    "self_paid", "override_unseconded",
)

# ---------- operations: what is wrong right now ----------


def _probe(qs, field: str, n: int = 4) -> tuple[int, list]:
    """How many rows a check finds, and the first few of them.

    The sample is read first: when it comes back short -- nearly every check,
    on nearly every visit -- its length is the count, and the separate COUNT
    query is never sent. Half the round trips of asking both every time.
    """
    if qs.model is User:
        # People are shown as faces: the sample string stays for old readers,
        # `people` carries who they are.
        rows = list(qs.values(*dict.fromkeys(("id", "name", "email", "photo", field)))[:n])
        sample = [r[field] for r in rows]
        people = [_person(r) for r in rows]
        return (len(sample) if len(sample) < n else qs.count()), sample, people
    sample = [
        v if v or field != "ticket_number" else "(draft)"
        for v in qs.values_list(field, flat=True)[:n]
    ]
    return (len(sample) if len(sample) < n else qs.count()), sample


def _person(r: dict) -> dict:
    from django.conf import settings
    from core.social import initials

    return {
        "user_id": r["id"],
        "name": r["name"] or r["email"],
        "email": r["email"],
        "initials": initials(r["name"] or r["email"]),
        "photo_url": f"{settings.MEDIA_URL}{r['photo']}" if r["photo"] else None,
    }


def _fault(key, title, detail, count=0, *, found=None, severity="warning", to=None, sample=None):
    people = None
    if found is not None:
        count, sample, *rest = found
        people = rest[0] if rest else None
    return {
        "people": people or [],
        "key": key,
        "title": title,
        "detail": detail,
        "count": count,
        "severity": severity,
        "to": to,
        "sample": sample or [],
    }


@api.get("/admin/faults", auth=session_auth)
def admin_faults(request: HttpRequest):
    """Every fault worth an admin's attention, counted and sampled.

    Each of these was found by hand at some point, in a query nobody was going
    to run twice. Four groups, because they need four different responses: data
    that blocks a person, work that has stalled, verification that could not
    confirm, and money that does not add up.
    """
    user = require_user(request)
    # Read-only, and the principal oversees the scheme: they can already read
    # the audit log, the payable queue and every record, so hiding stalled
    # work from them was an inconsistency rather than a boundary.
    if not (rbac.can_manage_users(user.role) or user.role == Role.PRINCIPAL):
        raise HttpError(403, "Forbidden")
    # The same checks for every reader allowed them, so the answer is shared
    # until something is written (core/services/aggregate_cache.py).
    return cached("faults", {}, _faults_now)


#: A fault's full list is capped so one bad import cannot send a page of
#: thousands. The count beside it is always the real one.
ITEM_CAP = 500


@api.get("/admin/faults/{key}", auth=session_auth)
def admin_fault_items(request: HttpRequest, key: str):
    """Everything behind one fault, not a sample: who or which claim, and how
    long it has been waiting. The count on the Faults screen is this list's
    length, so the two cannot disagree."""
    user = require_user(request)
    if not (rbac.can_manage_users(user.role) or user.role == Role.PRINCIPAL):
        raise HttpError(403, "Forbidden")
    sets = _fault_sets(timezone.now())
    if key not in sets:
        raise HttpError(404, "No such check")
    return cached("fault-items", {"key": key}, lambda: _fault_items(key, sets[key]))


def _fault_items(key: str, qs) -> dict[str, Any]:
    from core.api.common import _waiting_days

    total = qs.count()
    if qs.model is User:
        rows = qs.order_by("name")[:ITEM_CAP]
        return {
            "key": key,
            "kind": "people",
            "total": total,
            "items": [
                {
                    "user_id": u.id,
                    "name": u.name or u.email,
                    "email": u.email,
                    "department": u.department,
                }
                for u in rows
            ],
        }
    claims = qs.select_related("owner").order_by("ticket_number")[:ITEM_CAP]
    return {
        "key": key,
        "kind": "claims",
        "total": total,
        "items": [
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "imported": bool(c.ticket_number and c.ticket_number.startswith("ERP-")),
                "title": c.paper_title,
                "journal": c.journal_title,
                "owner": {"user_id": c.owner_id, "name": c.owner.name or c.owner.email},
                "status": c.status,
                "amount": c.remuneration,
                "waiting_days": _waiting_days(c),
                "month_paid": c.payout_month.isoformat() if c.payout_month else None,
            }
            for c in claims
        ],
    }


def _fault_sets(now) -> dict[str, Any]:
    """The query behind every check, by key. One definition: the summary
    counts it, the list shows it."""
    claims = Claim.objects.all()
    faculty = User.objects.filter(role=Role.FACULTY, active=True)
    stale_days = 14
    stale_cut = now - timedelta(days=stale_days)
    # Measured from arrival at the step (as `_waiting_days` does for the queue),
    # not updated_at: an import or any edit resets updated_at, and the real
    # college data showed 0 stale tickets beside a queue 90 days old.
    legacy = claims.filter(status__in=[
        ClaimStatus.HOD_APPROVED,
        ClaimStatus.RESEARCH_APPROVED,
        ClaimStatus.FINANCE_APPROVED,
    ]) | claims.filter(
        # A live Principal approval sets this; an ERP import does not. Without
        # the distinction every ticket legitimately waiting on the Director was
        # reported as stranded on a retired status.
        status=ClaimStatus.PRINCIPAL_APPROVED,
        principal_approved_at__isnull=True,
    )
    paid = claims.filter(status=ClaimStatus.PAID)
    return {
        "no_scopus": faculty.filter(Q(scopus_author_id__isnull=True) | Q(scopus_author_id="")),
        "no_biometric": faculty.filter(Q(biometric_id__isnull=True) | Q(biometric_id="")),
        "no_department": faculty.filter(Q(department__isnull=True) | Q(department="")),
        "former_staff": User.objects.filter(role=Role.FACULTY, email__endswith="@saveetha.invalid"),
        "stale_submitted": claims.filter(status=ClaimStatus.SUBMITTED).filter(
            Q(submitted_at__lt=stale_cut) | Q(submitted_at__isnull=True, updated_at__lt=stale_cut)
        ),
        "stale_cleared": claims.filter(status=ClaimStatus.CLEARED).filter(
            Q(cleared_at__lt=stale_cut) | Q(cleared_at__isnull=True, updated_at__lt=stale_cut)
        ),
        "legacy_status": legacy,
        "old_drafts": claims.filter(status=ClaimStatus.DRAFT, updated_at__lt=now - timedelta(days=30)),
        "unverified": claims.filter(verification_ok=False).exclude(status=ClaimStatus.PAID),
        "no_quartile": claim_fixes.in_review(claim_fixes.missing_quartile()),
        "no_snip": claims.filter(snip__isnull=True).filter(
            status__in=[ClaimStatus.SUBMITTED, ClaimStatus.CLEARED]
        ),
        "duplicate_override": claims.filter(override_duplicate=True),
        # Paid for nothing: the accounts workbook pays some papers nothing on
        # purpose -- student publications and uncited ones are "processed only
        # for count" -- and says so in the status. Those are not a lost figure.
        "paid_zero": claim_fixes.paid_without_amount(),
        "self_cleared": paid.filter(cleared_by__isnull=False, cleared_by=F("owner")),
        "no_ledger": paid.filter(ledger_rows__isnull=True),
        "voided": claims.filter(ledger_rows__amount__lt=0).distinct(),
        # The daily money safeguards (core.services.safeguards): the Safeguards
        # page counts these same queries, so the two screens cannot disagree.
        **{f"sg_{k}": qs for k, qs in safeguards.claim_sets().items()
           if k in _SAFEGUARD_FAULTS},
    }


def _faults_now() -> dict[str, Any]:
    now = timezone.now()
    S = _fault_sets(now)
    stale_days = 14
    groups: list[dict[str, Any]] = []

    # ---- data gaps that stop somebody working ----
    groups.append({
        "key": "data",
        "title": "People's details",
        "blurb": "Missing details that stop a person filing or being paid",
        "faults": [
            _fault("no_scopus", "No Scopus author ID",
                   "Their profile link cannot be derived, so the claim form cannot pre-fill it.",
                   found=_probe(S["no_scopus"], "email"), to="/people"),
            _fault("no_biometric", "No biometric ID",
                   "Decides which account is paid. A claim cannot be submitted without it.",
                   found=_probe(S["no_biometric"], "email"), severity="critical", to="/people"),
            _fault("no_department", "No department",
                   "Routes the approval and every departmental figure.",
                   found=_probe(S["no_department"], "email"), to="/people"),
            _fault("former_staff", "Payments held by former staff",
                   "Imported rows whose faculty is not on the current roster. Reassign to the right person.",
                   found=_probe(S["former_staff"], "name"), severity="info", to="/people"),
        ],
    })

    # ---- work that has stopped moving ----
    groups.append({
        "key": "stuck",
        "title": "Stuck claims",
        "blurb": "Claims that have stopped moving",
        "faults": [
            _fault("stale_submitted", f"Waiting to be cleared for over {stale_days} days",
                   "Filed and untouched since. The claimant is waiting.",
                   found=_probe(S["stale_submitted"], "ticket_number"), severity="critical",
                   to="/clearing"),
            _fault("stale_cleared", f"Waiting to be paid for over {stale_days} days",
                   "Cleared but not paid. The money is approved and sitting.",
                   found=_probe(S["stale_cleared"], "ticket_number"), severity="critical",
                   to="/payments"),
            _fault("legacy_status", "Stuck at an old step",
                   "Imported at a step the current chain has no button for. A super admin can move it on.",
                   found=_probe(S["legacy_status"], "ticket_number"), to="/clearing"),
            _fault("old_drafts", "Drafts left for over 30 days",
                   "Started and never filed.",
                   found=_probe(S["old_drafts"], "ticket_number"), severity="info"),
        ],
    })

    # ---- verification that could not confirm ----
    groups.append({
        "key": "verification",
        "title": "Figures the indexes could not confirm",
        "blurb": "Quartile, SNIP and duplicates that need a person's eye",
        "faults": [
            _fault("unverified", "Sent on with checks not passed",
                   "Passed forward with issues outstanding.",
                   found=_probe(S["unverified"], "ticket_number"), to="/clearing"),
            _fault("no_quartile", "In review with no quartile",
                   # Rupees are written the same way everywhere else in the app.
                   "The quartile is worth up to ₹50,000 of the payout and has to be "
                   "set before clearing.",
                   found=_probe(S["no_quartile"], "ticket_number"), severity="critical",
                   to="/data/fixes?kind=no_quartile&stage=review"),
            _fault("no_snip", "In review with no SNIP",
                   "Without a confirmed SNIP the claim prices at the fixed category rate.",
                   found=_probe(S["no_snip"], "ticket_number"), to="/clearing"),
            _fault("duplicate_override", "Duplicate warning overridden",
                   "Paid or cleared despite matching an earlier payment.",
                   found=_probe(S["duplicate_override"], "ticket_number"), severity="critical",
                   to="/duplicates"),
        ],
    })

    # ---- money that does not add up ----
    groups.append({
        "key": "money",
        "title": "Money",
        "blurb": "Payments that do not add up",
        "faults": [
            _fault("paid_zero", "Paid, but for nothing",
                   "Marked paid with no amount. Either the figure was lost or it should not have been paid.",
                   found=_probe(S["paid_zero"], "ticket_number"),
                   to="/data/fixes?kind=paid_no_amount"),
            _fault("self_cleared", "Cleared by the claimant",
                   "The person who approved it is the person being paid.",
                   found=_probe(S["self_cleared"], "ticket_number"), severity="critical"),
            _fault("no_ledger", "Paid with no ledger row",
                   "The claim says paid but nothing was written to the ledger.",
                   found=_probe(S["no_ledger"], "ticket_number"), severity="critical",
                   to="/ledger?problem=no-ledger"),
            _fault("voided", "Payments cancelled",
                   "A reversing row was written. Expected after a correction; unexpected otherwise.",
                   found=_probe(S["voided"], "ticket_number"), severity="info",
                   to="/ledger"),
        ],
    })

    # ---- the safeguards that guard the money itself ----
    # From the last run of the safeguards check (nightly, or "Check now"): the
    # counts are one stored read, not eight more queries on every visit, and the
    # list behind each one (`/admin/faults/{key}`) is the live query.
    report = safeguards.last_report() or {}
    reported = {c["key"]: c for c in report.get("checks", [])}

    def _reported(key: str):
        c = reported.get(key)
        if not c:
            return 0, []
        return c["count"], [r["label"].split(" ")[0] for r in c["rows"][:4]]

    groups.append({
        "key": "safeguards",
        "title": "Money safeguards",
        "blurb": "Payments that were doubled, changed or made without a record",
        "faults": [
            _fault("sg_dup_payment", "Claims with more than one live payment",
                   "The database allows one payment per claim, so these got round it. Money may have gone out twice.",
                   found=_reported("dup_payment"), severity="critical", to="/safeguards"),
            _fault("sg_ledger_unpaid", "Money on the ledger for a claim not marked paid",
                   "Paying it again would pay it twice.",
                   found=_reported("ledger_unpaid"), severity="critical", to="/safeguards"),
            _fault("sg_ledger_mismatch", "Ledger total differs from the paid amount",
                   "The claim and the ledger disagree about how much was paid.",
                   found=_reported("ledger_mismatch"), severity="critical",
                   to="/ledger?problem=mismatch"),
            _fault("sg_authorised_drift", "Authorised amount no longer matches",
                   "Priced differently since the Director authorised it. Paying sends it back to the Principal.",
                   found=_reported("authorised_drift"), to="/payments"),
            _fault("sg_dup_filed", "The same paper filed twice by one person",
                   "Only possible where the data was doubled before the rule was added. Reject all but one.",
                   found=_reported("dup_filed"), severity="critical", to="/clearing"),
            _fault("sg_paid_no_audit", "Paid with no record of who paid it",
                   "Money moved and the claim's history does not say who moved it.",
                   found=_reported("paid_no_audit"), severity="critical", to="/audit"),
            _fault("sg_self_paid", "Paid by the person who authorised it",
                   "A super admin standing in. Check the reason in the audit trail.",
                   found=_reported("self_paid"), severity="info", to="/audit"),
            _fault("sg_override_unseconded", "A duplicate warning was set aside with no second approver",
                   "It needed a second, different person before any money moved.",
                   found=_reported("override_unseconded"), severity="critical",
                   to="/duplicates"),
        ],
    })

    total = sum(f["count"] for g in groups for f in g["faults"])
    urgent = sum(
        f["count"] for g in groups for f in g["faults"] if f["severity"] == "critical"
    )
    return {"groups": groups, "total": total, "urgent": urgent, "checked_at": now.isoformat()}




__all__ = [
    '_fault',
    'admin_faults',
    'admin_fault_items',
]
