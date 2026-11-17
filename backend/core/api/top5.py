"""The Top 5 dashboard: three short lists of five, from the settled history.

For the Principal, the Director, the Super admin, the Research coordinator and
Finance across the whole college; for a head of department, their own
department and never the money list (the `remuneration` key is left out, the
same blindness `search.money.may_see_money` states). Faculty are refused.
"""

from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import Role
from core.services import top5
from core.services.search.money import may_see_money

COLLEGE_WIDE = (Role.PRINCIPAL, Role.VICE_PRINCIPAL, Role.DIRECTOR, Role.SUPER_ADMIN, Role.RESEARCH_COORDINATOR, Role.FINANCE)


@api.get("/dashboard/top5", auth=session_auth)
def dashboard_top5(
    request: HttpRequest,
    period: str = "all",
    year: Optional[int] = None,
    month: Optional[str] = None,
    academic: bool = True,
    department: Optional[str] = None,
):
    """Top 5 by cumulative SNIP, incentive paid, and papers settled.

    `period` is `all`, `year` or `month`. A year is the academic year from
    1 June of `year` (the current one when omitted), or the calendar year when
    `academic` is false. A month is `month=YYYY-MM`, the latest month with
    payments when omitted. Both are by month paid. `department` narrows the
    lists for a college-wide reader; a head of department always gets their
    own. These are the first five of `/dashboard/standings`, same order.
    """
    user = require_user(request)
    if user.role in COLLEGE_WIDE:
        scope = (department or "").strip()
    elif user.role == Role.HOD:
        scope = (user.department or "").strip()
        if not scope:
            raise HttpError(403, "Your account has no department yet.")
        if (department or "").strip().casefold() not in ("", scope.casefold()):
            raise HttpError(403, "You can see your own department only.")
    else:
        raise HttpError(403, "This dashboard is for the college's office holders and heads of department.")
    if period not in top5.PERIODS:
        raise HttpError(400, "Choose all time, a year or a month.")
    if year is not None and not 1990 <= year <= 2100:
        raise HttpError(400, "Give the year as four digits.")
    if month:
        try:
            top5.parse_month(month)
        except ValueError:
            raise HttpError(400, "Give the month as YYYY-MM, for example 2026-09.") from None

    on = top5.today()
    rec, sp = top5.resolve(on, period, year, month, academic)
    everyone = top5.cards(rec, sp)
    lists = top5.top(everyone, department=scope, money=may_see_money(user.role))
    from django.utils import timezone

    return {
        "period": period,
        "label": sp.label,
        "month": sp.month,
        "year": sp.year,
        "academic": sp.academic,
        "department": scope or None,
        "generated_at": timezone.now().isoformat(),
        "choices": top5.choices(rec, on),
        **lists,
    }


__all__ = ["dashboard_top5"]
