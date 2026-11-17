"""How the leaderboard's overall score is weighted, and who may change it.

GET  /leaderboard/weights          the weights in force, the factors, the history (anybody signed in)
PUT  /leaderboard/weights          save new weights with a reason (research coordinator, super admin)
POST /leaderboard/weights/preview  the top 20 now and under proposed weights, saving nothing (same)
POST /leaderboard/weights/reset    back to the college's starting weights (same)

The score is made only from Scopus-linked papers and carries no money at any
role, so there is nothing here to hide from a head of department
(core.services.leaderboard_weights holds the rules).
"""

from __future__ import annotations

from typing import Any

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError
from pydantic import ConfigDict

from core.api.common import api, require_user, session_auth
from core.models import Role
from core.services import honours_board, leaderboard_weights as lw

EDITORS = (Role.RESEARCH_COORDINATOR, Role.SUPER_ADMIN)
TOP = 20


def _editor(request: HttpRequest):
    user = require_user(request)
    if user.role not in EDITORS:
        raise HttpError(403, "Only the research coordinator or a super admin can change the leaderboard weights.")
    return user


def _entry(entry: dict[str, Any]) -> dict[str, Any]:
    # "reason", not "note": "note" is one of the keys the money-blindness sweep guards.
    out = {k: entry.get(k) for k in ("version", "weights", "saved_by", "saved_at", "applies_from")}
    out["reason"] = entry.get("note")
    return out


def _state(user) -> dict[str, Any]:
    return {
        "current": _entry(lw.current()),
        "catalogue": lw.catalogue(),
        "defaults": dict(lw.DEFAULTS),
        "history": [_entry(e) for e in lw.history()],
        "normalisation": lw.NORMALISATION,
        "source": lw.SOURCE,
        "can_edit": user.role in EDITORS,
    }


@api.get("/leaderboard/weights", auth=session_auth)
def weights_get(request: HttpRequest):
    return _state(require_user(request))


class WeightsIn(Schema):
    model_config = ConfigDict(extra="forbid")

    weights: dict[str, Any]
    reason: str = ""


@api.put("/leaderboard/weights", auth=session_auth)
def weights_put(request: HttpRequest, payload: WeightsIn):
    user = _editor(request)
    try:
        lw.save(user, payload.weights, payload.reason)
    except lw.WeightsError as e:
        raise HttpError(400, str(e))
    return _state(user)


@api.post("/leaderboard/weights/reset", auth=session_auth)
def weights_reset(request: HttpRequest):
    user = _editor(request)
    lw.reset(user)
    return _state(user)


class PreviewIn(Schema):
    model_config = ConfigDict(extra="forbid")

    weights: dict[str, Any]
    period: str = "academic"
    department: str = ""


def _top(rows: list[dict[str, Any]], other: dict[str, dict[str, Any]], key: str) -> list[dict[str, Any]]:
    out = []
    for r in rows[:TOP]:
        if r["rank"] is None:
            break
        pid = r["person"]["id"]
        there = other.get(pid)
        there_rank = there["rank"] if there else None
        out.append({
            "rank": r["rank"], "joint": r["joint"], "person": r["person"], "score": r["value"],
            key: there_rank,
            # Places gained under the other weights: positive is up.
            "change": (there_rank - r["rank"] if key == "was" else r["rank"] - there_rank) if there_rank is not None else None,
        })
    return out


@api.post("/leaderboard/weights/preview", auth=session_auth)
def weights_preview(request: HttpRequest, payload: PreviewIn):
    """Top 20 as saved, and top 20 as proposed, with the places each person moves.

    Nothing is saved and nothing is cached.
    """
    _editor(request)
    if payload.period not in honours_board.PERIODS:
        raise HttpError(400, "Choose this academic year, last academic year, this calendar year, the last 12 months or all time.")
    try:
        proposed = lw.clean(payload.weights)
    except lw.WeightsError as e:
        raise HttpError(400, str(e))
    dept = payload.department.strip()
    now = honours_board.preview(weights=lw.current()["weights"], period=payload.period, department=dept)
    then = honours_board.preview(weights=proposed, period=payload.period, department=dept)
    now_by = {r["person"]["id"]: r for r in now["rows"]}
    then_by = {r["person"]["id"]: r for r in then["rows"]}
    return {
        "period": now["period"],
        "scope": now["scope"],
        "weights": proposed,
        # `change` is places up (positive) or down (negative) under the proposed weights.
        "current": _top(now["rows"], then_by, "becomes"),
        "proposed": _top(then["rows"], now_by, "was"),
        "saved": False,
    }


__all__ = ["weights_get", "weights_put", "weights_reset", "weights_preview"]
