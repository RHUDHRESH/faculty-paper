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
from core.services import rbac
from core.services.aggregate_cache import cached

# ---------- operations: what is wrong right now ----------


def _probe(qs, field: str, n: int = 4) -> tuple[int, list]:
    """How many rows a check finds, and the first few of them.

    The sample is read first: when it comes back short -- nearly every check,
    on nearly every visit -- its length is the count, and the separate COUNT
    query is never sent. Half the round trips of asking both every time.
    """
    sample = [
        v if v or field != "ticket_number" else "(draft)"
        for v in qs.values_list(field, flat=True)[:n]
    ]
    return (len(sample) if len(sample) < n else qs.count()), sample


def _fault(key, title, detail, count=0, *, found=None, severity="warning", to=None, sample=None):
    if found is not None:
        count, sample = found
    return {
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


def _faults_now() -> dict[str, Any]:
    now = timezone.now()
    claims = Claim.objects.all()
    groups: list[dict[str, Any]] = []

    # ---- data gaps that stop somebody working ----
    faculty = User.objects.filter(role=Role.FACULTY, active=True)
    no_scopus = faculty.filter(Q(scopus_author_id__isnull=True) | Q(scopus_author_id=""))
    no_bio = faculty.filter(Q(biometric_id__isnull=True) | Q(biometric_id=""))
    no_dept = faculty.filter(Q(department__isnull=True) | Q(department=""))
    former = User.objects.filter(role=Role.FACULTY, email__endswith="@saveetha.invalid")
    groups.append({
        "key": "data",
        "title": "Data gaps",
        "blurb": "Missing details that stop a person filing or being paid",
        "faults": [
            _fault("no_scopus", "No Scopus author ID",
                   "Their profile link cannot be derived, so the claim form cannot pre-fill it.",
                   found=_probe(no_scopus, "email"), to="/admin/users"),
            _fault("no_biometric", "No biometric ID",
                   "Decides which account is paid. A claim cannot be submitted without it.",
                   found=_probe(no_bio, "email"), severity="critical", to="/admin/users"),
            _fault("no_department", "No department",
                   "Routes the approval and every departmental figure.",
                   found=_probe(no_dept, "email"), to="/admin/users"),
            _fault("former_staff", "Payments held by former staff",
                   "Imported rows whose faculty is not on the current roster. Reassign to the right person.",
                   found=_probe(former, "name"), severity="info", to="/admin/users"),
        ],
    })

    # ---- work that has stopped moving ----
    stale_days = 14
    stale_cut = now - timedelta(days=stale_days)
    stale_submitted = claims.filter(status=ClaimStatus.SUBMITTED, updated_at__lt=stale_cut)
    stale_cleared = claims.filter(status=ClaimStatus.CLEARED, updated_at__lt=stale_cut)
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
    old_drafts = claims.filter(status=ClaimStatus.DRAFT, updated_at__lt=now - timedelta(days=30))
    groups.append({
        "key": "stuck",
        "title": "Stuck work",
        "blurb": "Claims that have stopped moving",
        "faults": [
            _fault("stale_submitted", f"Waiting to clear over {stale_days} days",
                   "Submitted and untouched since. The claimant is waiting.",
                   found=_probe(stale_submitted, "ticket_number"), severity="critical",
                   to="/admin/clearing"),
            _fault("stale_cleared", f"Waiting to pay over {stale_days} days",
                   "Cleared but not paid. The money is approved and sitting.",
                   found=_probe(stale_cleared, "ticket_number"), severity="critical",
                   to="/finance"),
            _fault("legacy_status", "Stranded on a retired status",
                   "Imported at a stage the current workflow has no button for. A super admin can override the status.",
                   found=_probe(legacy, "ticket_number"), to="/admin/clearing"),
            _fault("old_drafts", "Drafts abandoned over 30 days",
                   "Started and never submitted.",
                   found=_probe(old_drafts, "ticket_number"), severity="info"),
        ],
    })

    # ---- verification that could not confirm ----
    unverified = claims.filter(verification_ok=False).exclude(status=ClaimStatus.PAID)
    no_quartile = claims.filter(
        Q(quartile__isnull=True) | Q(quartile="")
    ).filter(status__in=[ClaimStatus.SUBMITTED, ClaimStatus.CLEARED])
    no_snip = claims.filter(snip__isnull=True).filter(
        status__in=[ClaimStatus.SUBMITTED, ClaimStatus.CLEARED]
    )
    dup_override = claims.filter(override_duplicate=True)
    groups.append({
        "key": "verification",
        "title": "Verification",
        "blurb": "What the indexes could not confirm",
        "faults": [
            _fault("unverified", "Verification did not pass",
                   "Sent forward with issues outstanding.",
                   found=_probe(unverified, "ticket_number"), to="/admin/clearing"),
            _fault("no_quartile", "In review with no quartile",
                   # Rupees are written the same way everywhere else in the app.
                   "The quartile is worth up to ₹50,000 of the payout and has to be "
                   "set before clearing.",
                   found=_probe(no_quartile, "ticket_number"), severity="critical",
                   to="/admin/clearing"),
            _fault("no_snip", "In review with no SNIP",
                   "Without a verified SNIP the claim prices at the fixed category rate.",
                   found=_probe(no_snip, "ticket_number"), to="/admin/clearing"),
            _fault("duplicate_override", "Duplicate warning overridden",
                   "Paid or cleared despite matching an earlier payment.",
                   found=_probe(dup_override, "ticket_number"), severity="critical"),
        ],
    })

    # ---- money that does not add up ----
    paid = claims.filter(status=ClaimStatus.PAID)
    # The accounts workbook pays some papers nothing on purpose -- student
    # publications and uncited ones are "processed only for count" -- and
    # says so in the status. Those are not a lost figure.
    paid_zero = paid.filter(Q(remuneration__isnull=True) | Q(remuneration=0)).exclude(
        Q(status_note__icontains="only for count") | Q(status_note__iregex=r"no\s*re[nm]u")
    )
    self_cleared = paid.filter(cleared_by__isnull=False, cleared_by=F("owner"))
    no_ledger = paid.filter(ledger_rows__isnull=True)
    voided = claims.filter(ledger_rows__amount__lt=0).distinct()
    groups.append({
        "key": "money",
        "title": "Money",
        "blurb": "Payments that do not reconcile",
        "faults": [
            _fault("paid_zero", "Paid, but for nothing",
                   "Marked paid with no amount. Either the figure was lost or it should not have been paid.",
                   found=_probe(paid_zero, "ticket_number")),
            _fault("self_cleared", "Cleared by the claimant",
                   "The person who approved it is the person being paid.",
                   found=_probe(self_cleared, "ticket_number"), severity="critical"),
            _fault("no_ledger", "Paid with no ledger row",
                   "The claim says paid but nothing was written to the ledger.",
                   found=_probe(no_ledger, "ticket_number"), severity="critical"),
            _fault("voided", "Payments voided",
                   "A reversing row was written. Expected after a correction; unexpected otherwise.",
                   found=_probe(voided, "ticket_number"), severity="info"),
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
]
