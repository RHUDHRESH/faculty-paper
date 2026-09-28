"""budget.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.common import require_user
from core.api.claims import _claims_queryset

import json
import re
from datetime import date
from typing import Any, Optional
from django.db.models import Sum
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Budget, ClaimStatus, PaidLedger, Role, User
from core.services import rbac

# ---------- budget ----------


def financial_year_of(d: date) -> str:
    """India's financial year runs April to March, so "2026-27" starts in April 2026."""
    start = d.year if d.month >= 4 else d.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def _fy_bounds(fy: str) -> tuple[date, date]:
    start_year = int(fy.split("-")[0])
    return date(start_year, 4, 1), date(start_year + 1, 3, 31)


class BudgetIn(Schema):
    financial_year: str
    department: Optional[str] = None
    amount: float
    note: Optional[str] = None


def _budget_status(fy: str, user: User) -> dict[str, Any]:
    """Allocated, spent, committed and left -- for the college and each department.

    Committed is the part nobody was tracking: a ticket the principal has
    approved is money the college owes, even though finance has not moved it
    yet. Reporting only what has been paid understates the position by exactly
    the amount that is about to leave.
    """
    start, end = _fy_bounds(fy)
    scope = _claims_queryset(user)

    paid = scope.filter(
        status=ClaimStatus.PAID, payout_month__gte=start, payout_month__lte=end
    )
    # Committed has no payout month yet -- it is defined by where the ticket
    # sits, not by a date it has not reached.
    committed = scope.filter(
        status__in=(
            ClaimStatus.CLEARED,
            ClaimStatus.PRINCIPAL_APPROVED,
            ClaimStatus.DIRECTOR_APPROVED,
        )
    )

    def by_dept(qs) -> dict[str, float]:
        out: dict[str, float] = {}
        for row in qs.values("owner__department").annotate(s=Sum("remuneration")):
            key = (row["owner__department"] or "").strip()
            out[key] = round(out.get(key, 0) + (row["s"] or 0), 2)
        return out

    # Paid out is what the ledger paid in the year. The ledger holds every
    # payment the college made before this system too -- rows with no claim
    # behind them -- and summing claims alone showed a year of payouts as a
    # few lakh. A paid claim that somehow has no ledger row is still counted,
    # from the claim, so nothing is lost and nothing is counted twice.
    spent_by: dict[str, float] = {}
    for row in (
        PaidLedger.objects.filter(payout_month__gte=start, payout_month__lte=end)
        .values("department")
        .annotate(s=Sum("amount"))
    ):
        key = (row["department"] or "").strip()
        spent_by[key] = round(spent_by.get(key, 0) + (row["s"] or 0), 2)
    for key, amount in by_dept(paid.filter(ledger_rows__isnull=True)).items():
        spent_by[key] = round(spent_by.get(key, 0) + amount, 2)
    committed_by = by_dept(committed)
    budgets = {
        (b.department or ""): b
        for b in Budget.objects.filter(financial_year=fy)
    }

    def slice_for(dept: str) -> dict[str, Any]:
        allocated = budgets[dept].amount if dept in budgets else None
        if dept == "":
            # The college row is every department added up, not the rows that
            # happen to carry no department. Reading it the other way showed a
            # college that had spent nothing while its departments had spent
            # everything.
            spent = round(sum(spent_by.values()), 2)
            commit = round(sum(committed_by.values()), 2)
        else:
            spent = spent_by.get(dept, 0.0)
            commit = committed_by.get(dept, 0.0)
        left = None if allocated is None else round(allocated - spent - commit, 2)
        return {
            "department": dept or None,
            "allocated": allocated,
            "spent": spent,
            "committed": commit,
            "remaining": left,
            # Of the allocation, how much is already gone or spoken for.
            "used_fraction": (
                None if not allocated else round((spent + commit) / allocated, 4)
            ),
            "budget_id": budgets[dept].id if dept in budgets else None,
            "note": budgets[dept].note if dept in budgets else None,
        }

    departments = sorted(
        {d for d in list(spent_by) + list(committed_by) + list(budgets) if d}
    )
    college = slice_for("")
    # A college-wide allocation is the ceiling; without one, the total of the
    # department rows is the only figure there is, and it is not a ceiling.
    if college["allocated"] is None:
        total_alloc = sum(
            b.amount for k, b in budgets.items() if k
        )
        if total_alloc:
            college["allocated"] = round(total_alloc, 2)
            college["remaining"] = round(
                total_alloc - college["spent"] - college["committed"], 2
            )
            college["used_fraction"] = round(
                (college["spent"] + college["committed"]) / total_alloc, 4
            )
            college["note"] = "Sum of the departmental allocations"

    return {
        "financial_year": fy,
        "starts": start.isoformat(),
        "ends": end.isoformat(),
        "college": college,
        "departments": [slice_for(d) for d in departments],
        "years_on_record": sorted(
            {b.financial_year for b in Budget.objects.all()}
            | {financial_year_of(date.today())},
            reverse=True,
        ),
    }


@api.get("/budgets", auth=session_auth)
def budget_status(request: HttpRequest, financial_year: Optional[str] = None):
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    fy = financial_year or financial_year_of(date.today())
    if not re.fullmatch(r"\d{4}-\d{2}", fy):
        raise HttpError(400, "Financial year must look like 2026-27")
    return _budget_status(fy, user)


@api.post("/budgets", auth=session_auth)
def set_budget(request: HttpRequest, payload: BudgetIn):
    """Allocations are set by whoever runs the scheme, and the change is logged."""
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES and user.role != Role.FINANCE:
        raise HttpError(403, "Forbidden")
    fy = (payload.financial_year or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}", fy):
        raise HttpError(400, "Financial year must look like 2026-27")
    if payload.amount < 0:
        raise HttpError(400, "An allocation cannot be negative")
    dept = (payload.department or "").strip() or None

    budget, created = Budget.objects.update_or_create(
        financial_year=fy,
        department=dept,
        defaults={
            "amount": payload.amount,
            "note": (payload.note or "").strip() or None,
            "created_by": user,
        },
    )
    AuditLog.objects.create(
        actor=user,
        action="BUDGET_SET",
        entity="Budget",
        entity_id=budget.id,
        detail_json=json.dumps({
            "financial_year": fy, "department": dept,
            "amount": payload.amount, "created": created,
        }),
    )
    return {"ok": True, "id": budget.id, "created": created}


@api.delete("/budgets/{budget_id}", auth=session_auth)
def delete_budget(request: HttpRequest, budget_id: str):
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES and user.role != Role.FINANCE:
        raise HttpError(403, "Forbidden")
    budget = get_object_or_404(Budget, pk=budget_id)
    AuditLog.objects.create(
        actor=user, action="BUDGET_DELETE", entity="Budget", entity_id=budget.id,
        detail_json=json.dumps({
            "financial_year": budget.financial_year,
            "department": budget.department, "amount": budget.amount,
        }),
    )
    budget.delete()
    return {"ok": True}




__all__ = [
    'BudgetIn',
    '_budget_status',
    '_fy_bounds',
    'budget_status',
    'delete_budget',
    'financial_year_of',
    'set_budget',
]
