"""The research helper: where to send a paper idea, and who to talk to.

For anybody who files their own research (`rbac.can_file_own_papers`): a
faculty member, a head, and the other roles that publish. Nobody else's
money, and nothing about the desks, ever: see core.services.research_helper.

`POST /research-helper` always answers with the counted lists. With `ai` set
it also asks the model to rank and explain them, and says so in the `ai`
block. When the model is off, busy or over the person's daily limit the lists
still come back with a sentence in `ai.detail`; the request never fails
because the AI did.
"""

from __future__ import annotations

import re
from typing import Optional

from django.conf import settings
from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core import hod
from core.api.common import api, rate_limit, require_user, session_auth
from core.services import ai, rbac
from core.services import research_helper as helper


class HelperIn(Schema):
    title: Optional[str] = None
    text: Optional[str] = None
    paper_id: Optional[str] = None
    #: Ask the model to rank and explain. False returns the counted lists only.
    ai: bool = False
    #: Ask again even if this exact input was answered before.
    refresh: bool = False


class DraftIn(Schema):
    colleague_id: str
    title: Optional[str] = None
    text: Optional[str] = None
    paper_id: Optional[str] = None
    refresh: bool = False


class FeedbackIn(Schema):
    part: str
    value: str
    input_hash: str


def _researcher(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_file_own_papers(user.role):
        raise HttpError(403, "The research helper is for people who file their own research.")
    return user


def _input(user, payload) -> dict:
    try:
        return helper.resolve_input(user, title=payload.title, text=payload.text, paper_id=payload.paper_id)
    except helper.InputError as exc:
        raise HttpError(400, str(exc)) from exc


@api.get("/research-helper", auth=session_auth)
def research_helper_setup(request: HttpRequest):
    """What the panel needs before anybody types: whether AI is on (and where
    it runs), what is left of today's allowance, and the reader's own papers."""
    user = _researcher(request)
    return hod.without_money(
        {"ai": helper.ai_block(ai.health(), user), "papers": helper.my_papers(user)}
    )


@api.post("/research-helper", auth=session_auth)
def research_helper(request: HttpRequest, payload: HelperIn):
    """Venues, colleagues and related papers for an abstract, an idea or one of
    the reader's own papers. Every item is read from the college's record."""
    user = _researcher(request)
    rate_limit(request, "research-helper", settings.SEARCH_DAILY_LIMIT, "day", what="research helper searches")
    inp = _input(user, payload)
    return hod.without_money(helper.respond(user, inp, use_ai=payload.ai, refresh=payload.refresh))


@api.post("/research-helper/draft", auth=session_auth)
def research_helper_draft(request: HttpRequest, payload: DraftIn):
    """A short introduction to one colleague from the lists. It is returned for
    the reader to edit; nothing is sent, and no conversation is opened."""
    user = _researcher(request)
    rate_limit(request, "research-helper", settings.SEARCH_DAILY_LIMIT, "day", what="research helper searches")
    inp = _input(user, payload)
    try:
        return hod.without_money(helper.draft(user, inp, payload.colleague_id, refresh=payload.refresh))
    except helper.InputError as exc:
        raise HttpError(400, str(exc)) from exc


@api.post("/research-helper/feedback", auth=session_auth)
def research_helper_feedback(request: HttpRequest, payload: FeedbackIn):
    """Thumbs up or down on one part of an answer, kept in the audit trail."""
    user = _researcher(request)
    if payload.part not in ("venues", "people", "draft") or payload.value not in ("up", "down"):
        raise HttpError(400, "Say which part, and up or down.")
    if not re.fullmatch(r"[0-9a-f]{24}", payload.input_hash or ""):
        raise HttpError(400, "That answer is not one of yours to rate.")
    helper.record_feedback(user, part=payload.part, value=payload.value, input_hash=payload.input_hash)
    return {"ok": True}


__all__ = [
    "DraftIn",
    "FeedbackIn",
    "HelperIn",
    "research_helper",
    "research_helper_draft",
    "research_helper_feedback",
    "research_helper_setup",
]
