"""Request ids and JSON logs -- the observability floor, with no vendor.

Cloud Run already ships everything on stdout to Cloud Logging; what it
cannot do is make the lines *useful*. These two pieces do:

- **RequestIdMiddleware** gives every request an id (trusting Cloud Run's
  trace header when it is there, minting one when not), echoes it back to
  the browser, and stamps it on every log line the request produces -- so
  "the payment failed" in a user's report becomes a grep, not a hunt.
- **JsonFormatter** makes each line one JSON object with Cloud Logging's
  expected field names (``severity``, ``message``, the trace path), so
  severity levels, Error Reporting grouping and trace correlation all work
  without an agent or an SDK.

The same X-Cloud-Trace-Context header is turned into the
``logging.googleapis.com/trace`` field, which is what lets Cloud Logging
join these lines to Cloud Run's own request logs and to Cloud Trace spans.

There is deliberately no error-tracking service here. This deployment runs
on Google Cloud and Vercel and nothing else; Error Reporting reads the
tracebacks these lines carry, which is the capability we needed, owned by
the same project the logs are in.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from contextvars import ContextVar
from typing import Any

from django.http import HttpRequest, HttpResponse

_request_id: ContextVar[str] = ContextVar("request_id", default="")
_request_trace: ContextVar[str] = ContextVar("request_trace", default="")

#: Cloud Run's trace header looks like "TRACE_ID/SPAN_ID;o=1". The trace id
#: is the first half and is what Cloud Logging wants in the trace field --
#: fully qualified with the project so the join to Cloud Trace actually
#: happens. The project id arrives in the environment on Cloud Run; without
#: it the raw id is still logged, just not cross-linked.
_TRACE_HEADER = re.compile(r"^([0-9a-f]{32})(?:/\d+)?(?:;o=\d+)?$")

logger = logging.getLogger("core.log")


def current_request_id() -> str:
    return _request_id.get()


class RequestIdFilter(logging.Filter):
    """Put the request id (and trace, if known) on every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = _request_id.get()
        record.trace = _request_trace.get()
        return True


class RequestIdMiddleware:
    """One id per request, from Cloud Run when present, minted otherwise."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        raw = request.headers.get("X-Cloud-Trace-Context", "")
        match = _TRACE_HEADER.match(raw.strip()) if raw else None
        trace_id = match.group(1) if match else uuid.uuid4().hex
        request_id = trace_id[:32]
        request.request_id = request_id

        project = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
        trace_field = f"projects/{project}/traces/{trace_id}" if project else trace_id

        token = _request_id.set(request_id)
        trace_token = _request_trace.set(trace_field)
        started = time.monotonic()
        try:
            response = self.get_response(request)
        except Exception:
            _log_access(request, 500, started, errored=True)
            raise
        finally:
            _request_id.reset(token)
            _request_trace.reset(trace_token)
        response["X-Request-ID"] = request_id
        _log_access(request, response.status_code, started)
        return response


def _log_access(request: HttpRequest, status: int, started: float, *, errored: bool = False) -> None:
    """One structured line per request. This is the access log."""
    user = getattr(request, "user", None)
    logger.info(
        "request %s %s -> %s in %.0fms user=%s%s",
        request.method,
        request.get_full_path(),
        status,
        (time.monotonic() - started) * 1000,
        getattr(user, "pk", None),
        " errored" if errored else "",
        extra={
            "access": {
                "method": request.method,
                "path": request.get_full_path(),
                "status": status,
                "ms": round((time.monotonic() - started) * 1000),
                "user": getattr(user, "pk", None),
            }
        },
    )


class JsonFormatter(logging.Formatter):
    """One JSON object per line, in Cloud Logging's dialect.

    ``severity`` rather than ``levelname`` because that is the field Cloud
    Logging reads; ``message`` because that is what its viewers display.
    Structured ``extra`` dictionaries ride along under ``fields``, so the
    access log's counts are queryable rather than buried in prose.
    """

    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, Any] = {
            "severity": record.levelname,
            "message": record.getMessage(),
            "logger": record.name,
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "request_id": getattr(record, "request_id", "") or None,
        }
        trace = getattr(record, "trace", "")
        if trace:
            out["logging.googleapis.com/trace"] = trace
        access = getattr(record, "access", None)
        if access:
            out["fields"] = access
        if record.exc_info:
            out["message"] = f"{out['message']}\n{self.formatException(record.exc_info)}"
        return json.dumps(out, ensure_ascii=False)
