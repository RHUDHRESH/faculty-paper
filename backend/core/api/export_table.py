"""One export for any table on a list page: the rows on screen, as Excel, PDF or CSV.

The screen has already decided what its rows are and who may see them, so
this endpoint takes the table as sent, dresses it through the same exporter
the reports use, and writes an audit row that says what was exported without
saying what was in it. It looks nothing up.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.utils import timezone
from django.utils.text import slugify
from ninja import Schema
from ninja.errors import HttpError
from pydantic import ValidationError

from core.api.common import api, rate_limit, require_user, session_auth
from core.models import AuditLog
from core.services import exporters

__all__ = ["table_export"]

MAX_ROWS = 20_000
MAX_COLUMNS = 60
MAX_CELL_CHARS = 2_000
MAX_TITLE_CHARS = 120
#: Django refuses bodies over DATA_UPLOAD_MAX_MEMORY_SIZE (2.5 MB) before any
#: view runs. This route reads its own body up to this cap instead.
MAX_BODY_BYTES = 50 * 1024 * 1024
COLUMN_KINDS = ("text", "number", "money", "date")


class ColumnIn(Schema):
    key: str
    label: str
    kind: Optional[str] = None


class TableExportIn(Schema):
    title: str
    subtitle: Optional[str] = None
    format: str
    filename: Optional[str] = None
    columns: list[ColumnIn]
    rows: list[list[Any]]


def _cell(value: Any) -> Any:
    """A scalar as sent; anything else as its text. Text is cut to the limit."""
    if value is None or isinstance(value, (bool, int, float)):
        return value
    text = value if isinstance(value, str) else str(value)
    return text[:MAX_CELL_CHARS]


def _stem(filename: Optional[str], title: str) -> str:
    """A download name of letters, digits and hyphens only, never empty."""
    given = (filename or "").strip()
    for fmt in exporters.TABLE_FORMATS:
        if given.lower().endswith("." + fmt):
            given = given[: -(len(fmt) + 1)]
    stem = slugify(given)[:50].strip("-") or slugify(title)[:50].strip("-")
    return stem or "table"


@api.post("/export/table", auth=session_auth)
def table_export(request: HttpRequest):
    """The table the reader is looking at, downloaded as one file.

    The body is read here rather than declared as a ninja payload, because a
    declared payload is parsed before the view runs, and that parse is what
    the 2.5 MB default refuses. Every limit is checked before any work is
    done, and refused with a message that says what the limit is. Rows are
    taken as they are sent: the client is the screen, and the screen already
    applied the filters.
    """
    user = require_user(request)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")

    raw = request.read(MAX_BODY_BYTES + 1)
    if len(raw) > MAX_BODY_BYTES:
        raise HttpError(
            400,
            f"This table is larger than {MAX_BODY_BYTES // (1024 * 1024)} MB. "
            "Narrow the filters and try again.",
        )
    try:
        payload = TableExportIn.model_validate_json(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(part) for part in first["loc"]) or "body"
        raise HttpError(400, f"Not a table export: {where} {first['msg']}.") from None

    title = payload.title.strip()
    if not 1 <= len(title) <= MAX_TITLE_CHARS:
        raise HttpError(400, f"The title must be 1 to {MAX_TITLE_CHARS} characters.")
    if payload.format not in exporters.TABLE_FORMATS:
        raise HttpError(400, f"Format must be one of: {', '.join(exporters.TABLE_FORMATS)}.")
    if not 1 <= len(payload.columns) <= MAX_COLUMNS:
        raise HttpError(
            400,
            f"A table has 1 to {MAX_COLUMNS} columns; this one has {len(payload.columns)}.",
        )
    for column in payload.columns:
        if column.kind is not None and column.kind not in COLUMN_KINDS:
            raise HttpError(
                400,
                f"Column {column.label!r} has kind {column.kind!r}; "
                f"use one of: {', '.join(COLUMN_KINDS)}, or leave it out.",
            )
    if len(payload.rows) > MAX_ROWS:
        raise HttpError(
            400,
            f"A table can be exported up to {MAX_ROWS:,} rows; this one has "
            f"{len(payload.rows):,}. Narrow the filters and try again.",
        )
    for number, row in enumerate(payload.rows, start=1):
        if len(row) != len(payload.columns):
            raise HttpError(
                400,
                f"Each row needs one cell per column: row {number} has {len(row)}, "
                f"and the table has {len(payload.columns)} columns.",
            )

    now = timezone.localtime()
    generated = (
        f"Saveetha Engineering College · generated {now:%d %b %Y, %H:%M} "
        f"by {user.name or user.email}"
    )
    rows = [[_cell(v) for v in row] for row in payload.rows]
    body = exporters.render_table(
        title,
        payload.subtitle or "",
        [c.label for c in payload.columns],
        rows,
        payload.format,
        kinds=[c.kind for c in payload.columns],
        generated_line=generated,
    )

    base = f"{_stem(payload.filename, title)}-{timezone.localdate():%Y%m%d}"
    res = HttpResponse(body, content_type=exporters.CONTENT_TYPES[payload.format])
    res["Content-Disposition"] = f'attachment; filename="{base}.{payload.format}"'
    AuditLog.objects.create(
        actor=user,
        action="DATA_EXPORT",
        entity="Table",
        entity_id=base[:64],
        detail_json=json.dumps({"title": title, "format": payload.format, "rows": len(rows)}),
    )
    return res
