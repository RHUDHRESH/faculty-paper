"""Ask the data: a question in plain English, answered from a fixed catalogue.

For heads of department and everybody who reads the college's reports
(`insights.may_ask`); a faculty member is refused every endpoint (403). See
core.services.insights for what each question counts and who may ask it.

The request never fails because the AI did: with it off, failing or over its
limit, a typed question is matched by its words and every suggestion runs on
its own. A question this reader may not have answered (money, for a head)
comes back as a sentence with `refused: true`, never as an error page, and
carries no figure.

    POST /insights/ask           {question} -> the answer, chart, list and how it was counted
    GET  /insights/suggestions   the questions to offer this reader, and the settings' choices
    POST /insights/run           {query, params} -> the same shape, for a chip or a refined setting
    GET  /insights/run.csv       ?query=...&<settings>: everything behind the answer
"""

from __future__ import annotations

import io
from typing import Any, Optional

from django.http import HttpRequest, HttpResponse
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, rate_limit, require_user, session_auth
from core.services import insights
from core.services.cell_safe import csv_writer

#: Questions one person may type in an hour. The AI's own allowance is the
#: harness's (`insights.ASK.limits`); this bounds the counting behind it.
ASK_PER_HOUR = 120


class AskIn(Schema):
    question: str


class RunIn(Schema):
    query: str
    params: Optional[dict[str, Any]] = None


def _viewer(request: HttpRequest) -> tuple[Any, insights.Viewer]:
    user = require_user(request)
    try:
        return user, insights.viewer_for(user)
    except insights.Forbidden as exc:
        raise HttpError(403, str(exc)) from exc
    except insights.InputError as exc:
        raise HttpError(400, str(exc)) from exc


@api.post("/insights/ask", auth=session_auth)
def insights_ask(request: HttpRequest, payload: AskIn):
    user, viewer = _viewer(request)
    rate_limit(request, "insights_ask", ASK_PER_HOUR, "hour", what="questions")
    try:
        return insights.ask(viewer, user, payload.question)
    except insights.InputError as exc:
        raise HttpError(400, str(exc)) from exc


@api.get("/insights/suggestions", auth=session_auth)
def insights_suggestions(request: HttpRequest):
    _user, viewer = _viewer(request)
    return insights.suggestions(viewer)


@api.post("/insights/run", auth=session_auth)
def insights_run(request: HttpRequest, payload: RunIn):
    _user, viewer = _viewer(request)
    try:
        return insights.run(viewer, payload.query, payload.params or {})
    except insights.InputError as exc:
        raise HttpError(400, str(exc)) from exc


@api.get("/insights/run.csv", auth=session_auth)
def insights_csv(request: HttpRequest, query: str):
    """The answer's whole list, not the page's first rows. Settings are the
    query string's own keys; `insights.clean` decides which of them count."""
    _user, viewer = _viewer(request)
    params = {k: v for k, v in request.GET.items() if k != "query"}
    try:
        out, rows = insights.csv_rows(viewer, query, params)
    except insights.Refused as exc:
        raise HttpError(403, str(exc)) from exc
    except insights.InputError as exc:
        raise HttpError(400, str(exc)) from exc
    buf = io.StringIO()
    writer = csv_writer(buf)
    for row in rows:
        writer.writerow(["" if v is None else v for v in row])
    res = HttpResponse(buf.getvalue(), content_type="text/csv")
    res["Content-Disposition"] = f'attachment; filename="ask-the-data-{out["query"]}.csv"'
    return res


__all__ = [
    "AskIn",
    "RunIn",
    "insights_ask",
    "insights_csv",
    "insights_run",
    "insights_suggestions",
]
