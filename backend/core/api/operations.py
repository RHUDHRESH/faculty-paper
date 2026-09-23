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

# ---------- operations: what is wrong right now ----------


def _fault(key, title, detail, count, *, severity="warning", to=None, sample=None):
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

    now = timezone.now()
    claims = Claim.objects.all()
    groups: list[dict[str, Any]] = []

    def names(qs, field="email", n=4):
        return list(qs.values_list(field, flat=True)[:n])

    def tickets(qs, n=4):
        return [t or "(draft)" for t in qs.values_list("ticket_number", flat=True)[:n]]

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
                   no_scopus.count(), to="/admin/users", sample=names(no_scopus)),
            _fault("no_biometric", "No biometric ID",
                   "Decides which account is paid. A claim cannot be submitted without it.",
                   no_bio.count(), severity="critical", to="/admin/users", sample=names(no_bio)),
            _fault("no_department", "No department",
                   "Routes the approval and every departmental figure.",
                   no_dept.count(), to="/admin/users", sample=names(no_dept)),
            _fault("former_staff", "Payments held by former staff",
                   "Imported rows whose faculty is not on the current roster. Reassign to the right person.",
                   former.count(), severity="info", to="/admin/users",
                   sample=names(former, "name")),
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
                   stale_submitted.count(), severity="critical",
                   to="/admin/clearing", sample=tickets(stale_submitted)),
            _fault("stale_cleared", f"Waiting to pay over {stale_days} days",
                   "Cleared but not paid. The money is approved and sitting.",
                   stale_cleared.count(), severity="critical",
                   to="/finance", sample=tickets(stale_cleared)),
            _fault("legacy_status", "Stranded on a retired status",
                   "Imported at a stage the current workflow has no button for. A super admin can override the status.",
                   legacy.count(), to="/admin/clearing", sample=tickets(legacy)),
            _fault("old_drafts", "Drafts abandoned over 30 days",
                   "Started and never submitted.",
                   old_drafts.count(), severity="info", sample=tickets(old_drafts)),
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
                   unverified.count(), to="/admin/clearing", sample=tickets(unverified)),
            _fault("no_quartile", "In review with no quartile",
                   # Rupees are written the same way everywhere else in the app.
                   "The quartile is worth up to ₹50,000 of the payout and has to be "
                   "set before clearing.",
                   no_quartile.count(), severity="critical",
                   to="/admin/clearing", sample=tickets(no_quartile)),
            _fault("no_snip", "In review with no SNIP",
                   "Without a verified SNIP the claim prices at the fixed category rate.",
                   no_snip.count(), to="/admin/clearing", sample=tickets(no_snip)),
            _fault("duplicate_override", "Duplicate warning overridden",
                   "Paid or cleared despite matching an earlier payment.",
                   dup_override.count(), severity="critical", sample=tickets(dup_override)),
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
                   paid_zero.count(), sample=tickets(paid_zero)),
            _fault("self_cleared", "Cleared by the claimant",
                   "The person who approved it is the person being paid.",
                   self_cleared.count(), severity="critical", sample=tickets(self_cleared)),
            _fault("no_ledger", "Paid with no ledger row",
                   "The claim says paid but nothing was written to the ledger.",
                   no_ledger.count(), severity="critical", sample=tickets(no_ledger)),
            _fault("voided", "Payments voided",
                   "A reversing row was written. Expected after a correction; unexpected otherwise.",
                   voided.count(), severity="info", sample=tickets(voided)),
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
