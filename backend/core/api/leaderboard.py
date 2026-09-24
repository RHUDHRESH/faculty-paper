"""The leaderboard: person-wise and department-wise, over a chosen period.

Open to everybody signed in -- it is paper counts, which the college's own
trend and collaboration pages already show per person -- and carries no money
at any role. The payload is built without reading an amount anywhere, and it
still leaves through `hod.without_money`, so a field named `amount` added
later cannot reach a reader either.
"""

from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.services import leaderboard as boards, paper_facts


@api.get("/leaderboard", auth=session_auth)
def leaderboard(
    request: HttpRequest,
    board: str = "people",
    period: str = "academic",
    sort: str = "score",
    department: Optional[str] = None,
    per_head: bool = False,
):
    """One board, for one period, ranked by one measure.

    `board` is `people` or `departments`; `period` is `academic` (from
    1 June), `last_academic`, `calendar` or `all`; `sort` is `score`,
    `papers`, `q1` or `first_author`. `department` narrows the people board
    and ranks within it; `per_head` ranks departments by each measure divided
    by their head-count.
    """
    user = require_user(request)
    if board not in boards.BOARDS:
        raise HttpError(400, "Choose the people board or the department board.")
    if period not in boards.PERIODS:
        raise HttpError(400, "Choose this academic year, last academic year, this calendar year or all time.")
    if sort not in boards.SORTS:
        raise HttpError(400, "Rank by score, papers, Q1 papers or first-author papers.")

    facts = paper_facts.load()
    if board == "people":
        payload = boards.people_board(
            facts, period=period, sort=sort, department=department, viewer=user
        )
    else:
        payload = boards.department_board(
            facts, period=period, sort=sort, per_head=per_head, viewer=user
        )
    return hod.without_money(payload)


__all__ = ["leaderboard"]
