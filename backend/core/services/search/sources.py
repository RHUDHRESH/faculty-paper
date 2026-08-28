"""What to tell the reader about where the answer came from.

A search that quietly returns three results because two of five sources were
down looks exactly like a search that returned three results because that is
all there is. The second is an answer; the first is a lie by omission, and it
is the failure this module exists to make impossible: every source reports
itself on every request, whether it succeeded or not.

So `sources[]` is built even on complete success. The page can then render the
three states it needs -- all well, some down (name each, with the reason), all
down (an error, never "no results") -- from data rather than from inference.

`detail` is shown to a reader verbatim, so it is written for one: "Crossref did
not respond in time", not `ReadTimeout(...)`. `code` is for the client to
branch on, and is drawn from a fixed vocabulary so that branching is safe.
"""

from __future__ import annotations

from typing import Any

import httpx

#: The reader-facing name of every source. `found_in` on a paper carries these
#: labels rather than ids, because "Crossref, OpenAlex" is what belongs on the
#: screen and mapping ids back to names in two places is how they drift apart.
LABELS = {
    "crossref": "Crossref",
    "openalex": "OpenAlex",
    "scopus": "Scopus",
    "journals": "Our journal data",
    "college": "This college",
}

#: The fixed vocabulary the client branches on.
RATE_LIMIT = "rate_limit"
UNAUTHORIZED = "unauthorized"
TIMEOUT = "timeout"
ERROR = "error"
NOT_CONFIGURED = "not_configured"


def ok(source_id: str, count: int | None) -> dict[str, Any]:
    return {
        "id": source_id,
        "label": LABELS.get(source_id, source_id),
        "ok": True,
        "count": count,
        "detail": None,
        "code": None,
    }


def failed(source_id: str, code: str, detail: str) -> dict[str, Any]:
    return {
        "id": source_id,
        "label": LABELS.get(source_id, source_id),
        "ok": False,
        "count": None,
        "detail": detail,
        "code": code,
    }


def not_configured(source_id: str, detail: str) -> dict[str, Any]:
    """A missing key is a state of this installation, not an outage.

    Reported as its own code rather than as an error so the page can say "not
    set up on this server" quietly instead of raising a caution banner on every
    search for the lifetime of a deployment that has no Scopus subscription.
    """
    return failed(source_id, NOT_CONFIGURED, detail)


def classify(exc: BaseException, label: str = "The source") -> tuple[str, str]:
    """An exception as `(code, detail)` -- one for the client, one for the reader.

    `detail` is rendered verbatim, so it names the source and says what
    happened in a sentence: "Crossref did not respond in time." A reader can act
    on that -- wait, or search again without it. `ReadTimeout(...)` tells them
    only that something they do not understand went wrong.
    """
    # Scopus raises its own error carrying a code we already agree with.
    scopus_code = getattr(exc, "code", None)
    if isinstance(scopus_code, str) and scopus_code in {RATE_LIMIT, UNAUTHORIZED}:
        return scopus_code, (
            f"{label} is refusing more requests for the moment."
            if scopus_code == RATE_LIMIT
            else f"{label} rejected our key."
        )

    if isinstance(exc, httpx.TimeoutException):
        return TIMEOUT, f"{label} did not respond in time."
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        if status == 429:
            return RATE_LIMIT, f"{label} is refusing more requests for the moment."
        if status in (401, 403):
            return UNAUTHORIZED, f"{label} rejected our request."
        return ERROR, f"{label} returned an error ({status})."
    if isinstance(exc, httpx.TransportError):
        return ERROR, f"{label} could not be reached."
    return ERROR, f"{label} failed unexpectedly."


def timed_out(source_id: str, budget: float) -> dict[str, Any]:
    return failed(
        source_id,
        TIMEOUT,
        f"{LABELS.get(source_id, source_id)} did not respond within "
        f"{budget:.0f} seconds and was abandoned.",
    )
