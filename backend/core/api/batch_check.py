"""Check this batch: what is unusual before the Director authorises or Finance pays.

`GET  /batch-check/{stage}`           the deterministic list, and whether AI can
                                       word it. No model, no limit spent.
`POST /batch-check/{stage}/summary`   the same list plus the model's headline,
                                       wording and ranking (cached by batch contents,
                                       limited per person per day, audited).
`POST /batch-check-feedback`           a thumb up or down on a summary.

`stage` is ``authorise`` (the Director's, and a super admin standing in) or
``pay`` (Finance's, and a super admin). A person never sees their own claim in
the batch, and nothing here reads a flag, the journal watch-list or a contest
note: see `core.services.batch_check`.
"""
from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.services import batch_check, batch_check_ai, rbac


class FeedbackIn(Schema):
    stage: str
    fingerprint: str
    helpful: bool
    note: Optional[str] = None


def _allowed(user, stage: str) -> None:
    if stage not in batch_check.STAGES:
        raise HttpError(404, "There is no such batch.")
    ok = rbac.can_approve_as_director(user.role) if stage == "authorise" else rbac.can_finance_portal(user.role)
    if not ok:
        raise HttpError(403, "Forbidden")


def _rules() -> dict:
    """The thresholds in force, so the screen can say them in words."""
    return {
        "far_rupees": batch_check.FAR_RUPEES, "far_percent": batch_check.FAR_PERCENT,
        "title_ratio_percent": int(batch_check.TITLE_RATIO * 100), "large_factor": batch_check.LARGE_FACTOR,
        "large_percentile": batch_check.LARGE_PERCENTILE, "large_floor": batch_check.LARGE_FLOOR,
        "thin_left_percent": int(batch_check.THIN_LEFT * 100), "recent_days": batch_check.RECENT_DAYS,
        "daily_limit": batch_check_ai.daily_limit(),
    }


@api.get("/batch-check/{stage}", auth=session_auth)
def batch_check_list(request: HttpRequest, stage: str, department: Optional[str] = None):
    user = require_user(request)
    _allowed(user, stage)
    result = batch_check.check(stage, user, (department or "").strip() or None)
    return {
        **result,
        "fingerprint": batch_check.fingerprint_of(result),
        "ai": batch_check_ai.status(),
        "summary": None,
        "rules": _rules(),
    }


@api.post("/batch-check/{stage}/summary", auth=session_auth)
def batch_check_summary(request: HttpRequest, stage: str, department: Optional[str] = None):
    user = require_user(request)
    _allowed(user, stage)
    result = batch_check.check(stage, user, (department or "").strip() or None)
    return {**result, **batch_check_ai.summarise(user, result), "rules": _rules()}


@api.post("/batch-check-feedback", auth=session_auth)
def batch_check_feedback(request: HttpRequest, payload: FeedbackIn):
    user = require_user(request)
    _allowed(user, payload.stage)
    batch_check_ai.record_feedback(user, payload.stage, payload.fingerprint, payload.helpful, payload.note)
    return {"ok": True}


__all__ = ["batch_check_list", "batch_check_summary", "batch_check_feedback"]
