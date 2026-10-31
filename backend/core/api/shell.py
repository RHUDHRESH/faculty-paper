"""The frame's three badges, in one answer.

The sidebar's desk counts, the bell's unread number and Messages' unread badge
used to be three polls on three clocks, so an open tab sent a request every
fourteen seconds for as long as it was on screen -- and a free API and database
that never see a quiet minute never sleep. They are one request now.

Each slice is the answer of the endpoint it replaces, produced by calling that
endpoint's own function for this request. Nothing is recomputed here, so the
badge and the page it points at cannot disagree, and each slice keeps the
visibility rules of its source (a desk's counts exclude the viewer's own
papers, a draft is never counted for anybody else, an office thread counts only
for somebody who follows it).
"""

from __future__ import annotations

from django.http import HttpRequest

from core.api.calendar import notifications_unread_count
from core.api.claims import claim_counts
from core.api.common import api, session_auth
from core.api.dm import my_unread


@api.get("/shell/badges", auth=session_auth)
def shell_badges(request: HttpRequest):
    """`/claims/counts`, `/notifications/unread-count` and `/dm/unread` together."""
    return {
        "stage_counts": claim_counts(request),
        "notifications": notifications_unread_count(request),
        "dm": my_unread(request),
    }


__all__ = ["shell_badges"]
