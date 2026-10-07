"""The research compass: who you are, what you could be, and the next steps.

For anybody who files their own research (`rbac.can_file_own_papers`, the
research helper's rule): a faculty member, a head, and the office roles that
publish. The super admin is refused. See core.services.compass for what each
step says and where every word and number comes from.

Every step answers with AI off, from the counts, and says so (`counted`).
The request never fails because the AI did; it fails for bad input (400), for
a step that is not in the plan (404) and once today's questions are used (429).

    GET  /compass                        the page: facts, and whatever was kept
    POST /compass/portrait               step 1: who you are
    POST /compass/topics                 step 2: what you work on (research interests)
    POST /compass/paths                  step 3: three paths, measured in code
    POST /compass/choose                 step 4: the plan for one path
    POST /compass/actions/{action_id}    tick a step
    POST /compass/ask                    a question, or a first note to a colleague
    GET  /compass/summary                the Home card: kept answers only, no counting
"""

from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.services import compass, discover, rbac


class RefreshIn(Schema):
    #: Ask again even if an answer for these facts is kept.
    refresh: bool = False


class TopicsIn(Schema):
    topics: list[str]


class ChooseIn(Schema):
    path: str


class TickIn(Schema):
    done: bool


class AskIn(Schema):
    question: str


def _researcher(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_file_own_papers(user.role):
        raise HttpError(403, "The research compass is for people who file their own research.")
    return user


@api.get("/compass", auth=session_auth)
def compass_page(request: HttpRequest):
    """The facts, and the portrait, paths and plan kept from earlier visits.
    Asks no model and writes nothing."""
    user = _researcher(request)
    return hod.without_money(compass.overview(user))


@api.post("/compass/portrait", auth=session_auth)
def compass_portrait(request: HttpRequest, payload: Optional[RefreshIn] = None):
    user = _researcher(request)
    return hod.without_money(compass.portrait(user, refresh=bool(payload and payload.refresh)))


@api.post("/compass/topics", auth=session_auth)
def compass_topics(request: HttpRequest, payload: TopicsIn):
    """The topics the person works on, kept as their research interests (the
    same rows My research's domains write): the whole set is replaced."""
    user = _researcher(request)
    kept = discover.replace_interests(user, payload.topics)
    compass.forget_facts(user)
    return {"ok": True, "topics": kept}


@api.post("/compass/paths", auth=session_auth)
def compass_paths(request: HttpRequest, payload: Optional[RefreshIn] = None):
    user = _researcher(request)
    return hod.without_money(compass.paths(user, refresh=bool(payload and payload.refresh)))


@api.post("/compass/choose", auth=session_auth)
def compass_choose(request: HttpRequest, payload: ChooseIn):
    user = _researcher(request)
    try:
        return hod.without_money(compass.plan(user, payload.path))
    except compass.InputError as exc:
        raise HttpError(400, str(exc)) from exc


@api.post("/compass/actions/{action_id}", auth=session_auth)
def compass_tick(request: HttpRequest, action_id: str, payload: TickIn):
    user = _researcher(request)
    try:
        return compass.tick(user, action_id, payload.done)
    except compass.NotFound as exc:
        raise HttpError(404, str(exc)) from exc


@api.post("/compass/ask", auth=session_auth)
def compass_ask(request: HttpRequest, payload: AskIn):
    """An answer from the person's record and compass. A draft note is only
    returned, to be edited and sent by the person; nothing is sent here."""
    user = _researcher(request)
    try:
        return hod.without_money(compass.ask(user, payload.question))
    except compass.InputError as exc:
        raise HttpError(400, str(exc)) from exc
    except compass.LimitReached as exc:
        raise HttpError(429, str(exc)) from exc


@api.get("/compass/summary", auth=session_auth)
def compass_summary(request: HttpRequest):
    """For the Home and My research cards: what is kept, no counting, no model."""
    user = _researcher(request)
    return hod.without_money(compass.summary(user))


__all__ = [
    "AskIn",
    "ChooseIn",
    "RefreshIn",
    "TickIn",
    "TopicsIn",
    "compass_ask",
    "compass_choose",
    "compass_page",
    "compass_paths",
    "compass_portrait",
    "compass_summary",
    "compass_tick",
    "compass_topics",
]
