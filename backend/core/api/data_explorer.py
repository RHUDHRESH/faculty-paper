"""data explorer.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core import data_explorer as explorer
from core.api.common import rate_limit, _csv_row, api, session_auth
from core.api.common import require_user
from core.api.claims import _assign_quota_position

import csv
import io
import json
import time
from typing import Any, Optional
from django.db.models import Q
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from django.conf import settings
from ninja.errors import HttpError
from core.models import AuditLog, Claim, Role
from core.services import rbac

# ---------- data explorer ----------


def _may_browse_data(role: str) -> bool:
    """The admin and the principal. Finance reads money through its own
    screens, which are shaped for that job."""
    return role in rbac.ADMIN_ROLES or role == Role.PRINCIPAL


class CellEditIn(Schema):
    column: str
    value: Any = None
    reason: str


@api.get("/admin/data/tables", auth=session_auth)
def data_tables(request: HttpRequest):
    """Every table, what it holds, and how many rows are in it."""
    user = require_user(request)
    if not _may_browse_data(user.role):
        raise HttpError(403, "Forbidden")

    out = []
    for table in explorer.TABLES:
        model = explorer.model_for(table.model_name)
        out.append({
            "name": table.model_name,
            "label": table.label,
            "about": table.about,
            "group": table.group,
            "rows": model.objects.count(),
            "columns": len(explorer.column_meta(model, table)),
            "editable": bool(table.editable) and user.role == Role.SUPER_ADMIN,
        })
    return {
        "tables": out,
        "may_edit": user.role == Role.SUPER_ADMIN,
        # Said once, here, rather than left for somebody to discover by being
        # refused: reading is wide, writing is deliberately narrow.
        "note": (
            "Reading covers every table and every column that is not a secret. "
            "Editing is limited to reference data — the journal tables, the "
            "faculty master, budgets and journal standing — because everything "
            "the workflow owns moves through the screens that recalculate it "
            "and record who did it."
        ),
    }


def _explorer_queryset(table, model, request_params: dict):
    """Rows for one table, filtered and sorted as asked."""
    qs = model.objects.all()

    q = (request_params.get("q") or "").strip()
    if q:
        condition = Q()
        for column in explorer.searchable_columns(model):
            condition |= Q(**{f"{column}__icontains": q})
        qs = qs.filter(condition)

    # column:value pairs, one per filter, exact for anything but text.
    for raw in request_params.get("filters") or []:
        if ":" not in raw:
            continue
        column, value = raw.split(":", 1)
        column, value = column.strip(), value.strip()
        if not column or not any(
            f.name == column for f in model._meta.fields
        ) or column in explorer.NEVER_SHOW:
            raise HttpError(400, f"No column called {column!r} on this table")
        if value == "":
            qs = qs.filter(**{f"{column}__isnull": True})
        elif value.lower() in ("true", "false"):
            qs = qs.filter(**{column: value.lower() == "true"})
        else:
            try:
                qs = qs.filter(**{f"{column}__icontains": value})
            except Exception:
                qs = qs.filter(**{column: value})

    names = {f.name for f in model._meta.fields}

    def usable(candidate: str) -> bool:
        bare = candidate.lstrip("-")
        return bool(bare) and bare in names and bare not in explorer.NEVER_SHOW

    sort = (request_params.get("sort") or "").strip()
    # The requested sort, then the table's declared default, then the primary
    # key. The declared default is checked too: a registry naming a column the
    # model does not have took the whole screen down with a 500 the moment
    # somebody opened that table.
    for candidate in (sort, table.order, "-id"):
        if usable(candidate):
            return qs.order_by(candidate)
    return qs.order_by("pk")


@api.get("/admin/data/{table_name}", auth=session_auth)
def data_rows(
    request: HttpRequest,
    table_name: str,
    q: Optional[str] = None,
    filters: Optional[str] = None,
    sort: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """Rows, with the columns described alongside so the screen can render
    anything without knowing the schema in advance."""
    user = require_user(request)
    if not _may_browse_data(user.role):
        raise HttpError(403, "Forbidden")
    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    params = {
        "q": q,
        "sort": sort,
        "filters": [f for f in (filters or "").split("|") if f],
    }
    qs = _explorer_queryset(table, model, params)
    columns = explorer.column_meta(model, table)

    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    total = qs.count()

    related = [c["name"] for c in columns if c["type"] == "reference"]
    if related:
        qs = qs.select_related(*related)

    return {
        "table": {
            "name": table.model_name,
            "label": table.label,
            "about": table.about,
            "group": table.group,
        },
        "columns": columns,
        "highlight": list(table.highlight),
        "rows": [explorer.serialise(o, columns) for o in qs[offset : offset + limit]],
        "total": total,
        "limit": limit,
        "offset": offset,
        "sort": params["sort"] or table.order,
        "may_edit": (
            user.role == Role.SUPER_ADMIN and any(c["editable"] for c in columns)
        ),
    }


@api.get("/admin/data/{table_name}/export", auth=session_auth)
def data_export(
    request: HttpRequest,
    table_name: str,
    q: Optional[str] = None,
    filters: Optional[str] = None,
    sort: Optional[str] = None,
    fmt: str = "csv",
    limit: int = 50000,
):
    """The rows currently on screen, in whichever format the reader works in.

    The filter is applied, not ignored: an export that quietly returns the
    whole table when the screen showed forty rows is how a wrong number ends
    up in a report.
    """
    user = require_user(request)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    if not _may_browse_data(user.role):
        raise HttpError(403, "Forbidden")
    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    params = {
        "q": q,
        "sort": sort,
        "filters": [f for f in (filters or "").split("|") if f],
    }
    qs = _explorer_queryset(table, model, params)
    columns = explorer.column_meta(model, table)
    related = [c["name"] for c in columns if c["type"] == "reference"]
    if related:
        qs = qs.select_related(*related)
    rows = [explorer.serialise(o, columns) for o in qs[: max(1, min(int(limit), 50000))]]
    headers = [c["name"] for c in columns]
    stem = f"{table.model_name.lower()}-{timezone.now():%Y%m%d}"

    AuditLog.objects.create(
        actor=user, action="DATA_EXPORT", entity=table.model_name, entity_id=stem,
        detail_json=json.dumps({"format": fmt, "rows": len(rows), "filters": params}),
    )

    if fmt == "json":
        res = HttpResponse(
            json.dumps(rows, indent=2, default=str), content_type="application/json"
        )
        res["Content-Disposition"] = f'attachment; filename="{stem}.json"'
        return res

    if fmt == "xlsx":
        from openpyxl import Workbook
        from openpyxl.styles import Font

        wb = Workbook()
        ws = wb.active
        ws.title = table.label[:31]
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for row in rows:
            ws.append([
                # A leading "=" is read as a formula by Excel.
                f"'{row[h]}" if isinstance(row.get(h), str) and str(row[h]).startswith("=")
                else row.get(h)
                for h in headers
            ])
        ws.freeze_panes = "A2"
        for column in ws.columns:
            longest = max(
                (len(str(c.value)) for c in column[:200] if c.value is not None),
                default=10,
            )
            ws.column_dimensions[column[0].column_letter].width = min(
                60, max(10, longest + 2)
            )
        out = io.BytesIO()
        wb.save(out)
        res = HttpResponse(
            out.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        res["Content-Disposition"] = f'attachment; filename="{stem}.xlsx"'
        return res

    if fmt == "md":
        lines = ["| " + " | ".join(headers) + " |",
                 "| " + " | ".join("---" for _ in headers) + " |"]
        for row in rows:
            lines.append(
                "| " + " | ".join(
                    str(row.get(h, "")).replace("|", "\\|").replace("\n", " ")[:120]
                    for h in headers
                ) + " |"
            )
        res = HttpResponse("\n".join(lines), content_type="text/markdown; charset=utf-8")
        res["Content-Disposition"] = f'attachment; filename="{stem}.md"'
        return res

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_csv_row(headers))
    for row in rows:
        writer.writerow(_csv_row([row.get(h) for h in headers]))
    delimiter = "\t" if fmt == "tsv" else ","
    body = buf.getvalue()
    if fmt == "tsv":
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter="\t")
        writer.writerow(_csv_row(headers))
        for row in rows:
            writer.writerow(_csv_row([row.get(h) for h in headers]))
        body = buf.getvalue()
    res = HttpResponse(
        body, content_type="text/tab-separated-values" if fmt == "tsv" else "text/csv"
    )
    res["Content-Disposition"] = f'attachment; filename="{stem}.{"tsv" if fmt == "tsv" else "csv"}"'
    return res


@api.patch("/admin/data/{table_name}/{row_id}", auth=session_auth)
def data_edit_cell(
    request: HttpRequest, table_name: str, row_id: str, payload: CellEditIn
):
    """Correct one value in a reference table, with the reason recorded.

    One column at a time and a reason each time, on purpose. A grid that lets
    somebody change forty things and press save produces an audit entry nobody
    can reconstruct a decision from.
    """
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may correct data here")
    table = explorer.BY_NAME.get(table_name)
    model = explorer.model_for(table_name)
    if not table or model is None:
        raise HttpError(404, "No such table")

    reason = (payload.reason or "").strip()
    if len(reason) < 5:
        raise HttpError(400, "Say why this is being changed")

    columns = {c["name"]: c for c in explorer.column_meta(model, table)}
    column = columns.get(payload.column)
    if column is None:
        raise HttpError(400, "No such column")
    if not column["editable"]:
        raise HttpError(
            400,
            f"{payload.column} is not editable here. Everything the workflow "
            "owns — status, the money columns, who approved what — moves "
            "through the screen that recalculates it and records who did it.",
        )

    instance = get_object_or_404(model, pk=row_id)
    before = getattr(instance, payload.column, None)
    value = payload.value
    if column["type"] == "number" and value not in (None, ""):
        try:
            value = float(value)
        except (TypeError, ValueError):
            raise HttpError(400, f"{payload.column} takes a number")
    if column["type"] == "boolean":
        value = str(value).lower() in ("true", "1", "yes")
    if value == "":
        value = None

    # Same rule as the pack screen: a corrected year drops the research-quota
    # slot the old year issued, and the paper has to take one in the new year
    # or it sits there unnumbered. Unreachable today -- the Claim table
    # declares no editable columns, so this endpoint cannot touch
    # `publication_year` at all -- and here so that the day it does, the slot
    # is not quietly lost.
    held_a_slot = (
        isinstance(instance, Claim)
        and payload.column == "publication_year"
        and instance.quota_position is not None
    )

    setattr(instance, payload.column, value)
    instance.save(update_fields=[payload.column])
    if held_a_slot and instance.quota_position is None:
        _assign_quota_position(instance)

    AuditLog.objects.create(
        actor=user, action="DATA_EDIT", entity=table.model_name,
        entity_id=str(row_id),
        detail_json=json.dumps({
            "column": payload.column,
            "from": str(before) if before is not None else None,
            "to": str(value) if value is not None else None,
            "reason": reason,
        }),
    )
    return {"ok": True, "column": payload.column, "value": value, "was": str(before)}




__all__ = [
    'CellEditIn',
    '_explorer_queryset',
    '_may_browse_data',
    'data_edit_cell',
    'data_export',
    'data_rows',
    'data_tables',
]
