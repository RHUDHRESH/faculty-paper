"""The Safeguards page: did the money safeguards hold?

GET  /safeguards       the last stored report. A super admin sees every check;
                       Finance sees the money checks only, with their own
                       counts, and nothing that would reveal a doubt about a
                       paper (`core.visibility`).
POST /safeguards/run   run every check now (super admin). The same function the
                       nightly job runs, so "Check now" and the schedule agree.
"""
from __future__ import annotations

from django.http import HttpRequest
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import Role
from core.services import safeguards


def _reader(request: HttpRequest):
    user = require_user(request)
    if user.role not in (Role.SUPER_ADMIN, Role.FINANCE):
        raise HttpError(403, "Safeguards are for the super admin and Finance.")
    return user


@api.get("/safeguards", auth=session_auth)
def safeguards_report(request: HttpRequest):
    user = _reader(request)
    report = safeguards.last_report()
    full = user.role == Role.SUPER_ADMIN
    return {
        "report": report if full else safeguards.for_finance(report),
        "scope": "all" if full else "money",
        "can_run": full,
    }


@api.post("/safeguards/run", auth=session_auth)
def safeguards_run(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can run the safeguards check.")
    report = safeguards.run_and_store(by=user)
    return {"report": report, "scope": "all", "can_run": True}


__all__ = ["safeguards_report", "safeguards_run"]
