"""The Report studio's engine: check a definition, run it, shape the answer.

A definition is plain JSON naming a dataset, fields, filters, groups and
aggregates. Nothing in it is ever SQL. `plan` checks every name and operator
against the dataset's whitelist (`report_datasets`) *for the person asking*,
and a name that is not on it is refused with a sentence, never ignored. `run`
then builds one ORM query out of the whitelisted expressions: rows come from
`values_list`, groups from `values().annotate()`, so a twenty-thousand-row
report is a handful of queries and no Python loop over records.

The same functions answer the screen, the file, the email and the feed link,
each as whoever the answer is for, which is how a report shared with a head of
department stays free of money.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Optional

from django.db.models import Avg, Count, F, Max, Min, Q, Sum
from django.db.models.functions import TruncMonth, TruncQuarter, TruncYear

from core.services import report_datasets as ds_mod
from core.services.report_datasets import Dataset, Field, Viewer

DEFAULT_LIMIT = 5000
MAX_LIMIT = 20000
MAX_COLUMNS = 60
MAX_FILTERS = 30
MAX_GROUPS = 3
MAX_AGGREGATES = 12
MAX_SORTS = 5
MAX_LIST_VALUES = 200
MAX_TEXT = 200
MAX_PIVOT_COLUMNS = 40

OPS = ("eq", "ne", "in", "not_in", "contains", "gt", "gte", "lt", "lte", "between", "is_empty", "not_empty")
_NUMERIC_OPS = {"eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "between", "is_empty", "not_empty"}
OPS_BY_TYPE = {
    "string": {"eq", "ne", "in", "not_in", "contains", "is_empty", "not_empty"},
    "enum": {"eq", "ne", "in", "not_in", "is_empty", "not_empty"},
    "number": _NUMERIC_OPS,
    "money": _NUMERIC_OPS,
    "date": {"eq", "ne", "gt", "gte", "lt", "lte", "between", "is_empty", "not_empty"},
    "bool": {"eq", "ne"},
}
FNS = ("count", "count_distinct", "sum", "avg", "min", "max")
BUCKETS = ("month", "quarter", "year", "academic_year")
FORMATS = ("xlsx", "pdf", "csv")
NOT_RECORDED = "Not recorded"

_OP_WORDS = {
    "eq": "is", "ne": "is not", "in": "is one of", "not_in": "is not one of", "contains": "contains",
    "gt": "is more than", "gte": "is at least", "lt": "is less than", "lte": "is at most",
    "between": "is between", "is_empty": "is empty", "not_empty": "is not empty",
}
_FN_WORDS = {"count": "Count", "count_distinct": "Distinct", "sum": "Total", "avg": "Average", "min": "Lowest", "max": "Highest"}
_BUCKET_WORDS = {"month": "month", "quarter": "quarter", "year": "year", "academic_year": "academic year"}


class ReportError(Exception):
    """A definition that cannot be run, with a sentence to show and a status."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


# --------------------------------------------------------------------- plan --


@dataclass
class Filter:
    field: Field
    op: str
    value: Any


@dataclass
class Aggregate:
    field: Optional[Field]
    fn: str
    key: str
    label: str
    type: str
    custom_label: bool = False


@dataclass
class Plan:
    viewer: Viewer
    dataset: Dataset
    mode: str  # "rows", "group" or "pivot"
    definition: dict[str, Any]
    columns: list[Field] = field(default_factory=list)
    filters: list[Filter] = field(default_factory=list)
    group_by: list[Field] = field(default_factory=list)
    bucket: Optional[str] = None
    aggregates: list[Aggregate] = field(default_factory=list)
    pivot_rows: Optional[Field] = None
    pivot_columns: Optional[Field] = None
    pivot_value: Optional[Aggregate] = None
    sort: list[tuple[str, str]] = field(default_factory=list)
    limit: int = DEFAULT_LIMIT
    top_n: Optional[int] = None


def _lookup(dataset: Dataset, viewer: Viewer, key: Any, what: str) -> Field:
    if not isinstance(key, str) or not key:
        raise ReportError(f"Each {what} needs a field name.")
    f = dataset.field(key)
    if f is None:
        raise ReportError(f"There is no field {key!r} in {dataset.label}. Use the field names the dataset lists.")
    if not f.available(viewer):
        if f.money or f.reveals_payment:
            raise ReportError(
                f"{f.label} is about money, and heads of department do not see money. "
                f"Take it out of the {what}."
            )
        raise ReportError(f"{f.label} is not available to you. Take it out of the {what}.")
    return f


def _as_list(value: Any, what: str) -> list:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ReportError(f"{what} must be a list.")
    return value


def _text(value: Any, label: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ReportError(f"{label} needs text.")
    text = str(value).strip()
    if len(text) > MAX_TEXT:
        raise ReportError(f"{label}: a value can be at most {MAX_TEXT} characters.")
    return text


def _number(value: Any, label: str) -> float | int:
    if isinstance(value, bool):
        raise ReportError(f"{label} needs a number.")
    if isinstance(value, (int, float)):
        out = value
    elif isinstance(value, str) and re.fullmatch(r"\s*-?\d+(\.\d+)?\s*", value):
        out = float(value)
    else:
        raise ReportError(f"{label} needs a number.")
    if isinstance(out, float) and not math.isfinite(out):
        raise ReportError(f"{label} needs a finite number.")
    return out


def _date(value: Any, label: str) -> date:
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            pass
    raise ReportError(f"{label} needs a date written like 2025-04-30.")


def _bool(value: Any, label: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "yes", "1"):
        return True
    if isinstance(value, str) and value.strip().lower() in ("false", "no", "0"):
        return False
    raise ReportError(f"{label} needs yes or no.")


def _one(f: Field, value: Any, label: str):
    if f.type in ("string", "enum"):
        return _text(value, label)
    if f.type in ("number", "money"):
        return _number(value, label)
    if f.type == "date":
        return _date(value, label)
    return _bool(value, label)


def _filter(dataset: Dataset, viewer: Viewer, raw: Any) -> Filter:
    if not isinstance(raw, dict):
        raise ReportError("Each filter needs a field, an operator and a value.")
    f = _lookup(dataset, viewer, raw.get("field"), "filter")
    if f.python is not None or not f.filterable:
        raise ReportError(f"{f.label} cannot be used to filter. It can only be shown as a column.")
    op = raw.get("op")
    if op not in OPS:
        raise ReportError(f"{op!r} is not a filter operator. Use one of: {', '.join(OPS)}.")
    if op not in OPS_BY_TYPE[f.type]:
        raise ReportError(f"{f.label} cannot be filtered with {op!r}. For this field use: {', '.join(sorted(OPS_BY_TYPE[f.type]))}.")
    label = f"Filter on {f.label}"
    value: Any = None
    if op in ("is_empty", "not_empty"):
        pass
    elif op in ("in", "not_in"):
        items = raw.get("value")
        if not isinstance(items, list) or not items:
            raise ReportError(f"{label}: {op!r} needs a list with at least one value.")
        if len(items) > MAX_LIST_VALUES:
            raise ReportError(f"{label}: at most {MAX_LIST_VALUES} values in a list.")
        value = [_one(f, v, label) for v in items]
    elif op == "between":
        pair = raw.get("value")
        if not isinstance(pair, list) or len(pair) != 2:
            raise ReportError(f"{label}: 'between' needs two values, from and to.")
        value = [_one(f, v, label) for v in pair]
        if value[0] > value[1]:
            value.reverse()
    else:
        value = _one(f, raw.get("value"), label)
    return Filter(f, op, value)


def _fn_ok(f: Optional[Field], fn: Any, what: str) -> None:
    if fn not in FNS:
        raise ReportError(f"{fn!r} is not a calculation. Use one of: {', '.join(FNS)}.")
    if fn == "count" and f is None:
        return
    if f is None:
        raise ReportError(f"The {what} {fn!r} needs a field.")
    if f.python is not None:
        raise ReportError(f"{f.label} can only be shown as a column, not calculated on.")
    if fn in ("sum", "avg") and f.type not in ("number", "money"):
        raise ReportError(f"{f.label} is not a number, so it cannot be totalled or averaged. Count it instead.")
    if fn in ("min", "max") and f.type not in ("number", "money", "date"):
        raise ReportError(f"{f.label} has no lowest or highest value. Count it instead.")
    if fn in ("sum", "avg", "min", "max") and not f.is_aggregatable():
        raise ReportError(f"{f.label} is not something to total or average. Count it instead.")


def _aggregate(dataset: Dataset, viewer: Viewer, raw: Any) -> Aggregate:
    if not isinstance(raw, dict):
        raise ReportError("Each aggregate needs a field and a calculation.")
    name = raw.get("field")
    f = None if name in (None, "", "*") else _lookup(dataset, viewer, name, "aggregate")
    fn = raw.get("fn")
    _fn_ok(f, fn, "aggregate")
    if f is None:
        key, ftype = "count", "number"
        default_label = "Count"
    else:
        key = f"{fn}_{f.key}"
        if fn in ("count", "count_distinct"):
            ftype = "number"
        elif fn == "sum":
            ftype = "money" if f.type == "money" else "number"
        elif fn == "avg":
            ftype = "money" if f.type == "money" else "number"
        else:
            ftype = f.type
        default_label = f"{_FN_WORDS[fn]} of {f.label.lower()}" if fn != "count" else f"Count of {f.label.lower()}"
    label = raw.get("label")
    if label is not None:
        label = _text(label, "An aggregate label")
    return Aggregate(f, fn, key, label or default_label, ftype, custom_label=bool(label))


def plan(user, definition: Any) -> Plan:
    """The definition checked against what `user` may use, or a `ReportError`."""
    if not isinstance(definition, dict):
        raise ReportError("A report definition is a set of named choices.")
    viewer = ds_mod.viewer_for(user)
    key = definition.get("dataset")
    dataset = ds_mod.DATASETS.get(key) if isinstance(key, str) else None
    if dataset is None:
        raise ReportError(f"There is no dataset {key!r}. Choose one of: {', '.join(ds_mod.DATASETS)}.")
    if not dataset.offered_to(viewer):
        if dataset.key == "payments" and not viewer.sees_money:
            raise ReportError("Payments are about money, and heads of department do not see money.", 403)
        raise ReportError(f"{dataset.label} is not available to you.", 403)

    limit = definition.get("limit")
    if limit is None:
        limit = DEFAULT_LIMIT
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_LIMIT:
        raise ReportError(f"The limit must be a whole number from 1 to {MAX_LIMIT:,}.")
    top_n = definition.get("top_n")
    if top_n is not None and (isinstance(top_n, bool) or not isinstance(top_n, int) or not 1 <= top_n <= MAX_LIMIT):
        raise ReportError(f"top_n must be a whole number from 1 to {MAX_LIMIT:,}.")

    filters_raw = _as_list(definition.get("filters"), "Filters")
    if len(filters_raw) > MAX_FILTERS:
        raise ReportError(f"A report can have at most {MAX_FILTERS} filters.")
    filters = [_filter(dataset, viewer, f) for f in filters_raw]

    bucket = definition.get("date_bucket")
    if bucket is not None and bucket not in BUCKETS:
        raise ReportError(f"{bucket!r} is not a date bucket. Use one of: {', '.join(BUCKETS)}.")

    group_raw = _as_list(definition.get("group_by"), "group_by")
    if len(group_raw) > MAX_GROUPS:
        raise ReportError(f"A report can be grouped by at most {MAX_GROUPS} fields.")
    group_by: list[Field] = []
    for name in group_raw:
        g = _lookup(dataset, viewer, name, "group")
        if not g.groupable or g.python is not None:
            raise ReportError(f"{g.label} cannot be used to group.")
        if g in group_by:
            raise ReportError(f"{g.label} is in group_by twice.")
        group_by.append(g)

    aggregates_raw = _as_list(definition.get("aggregates"), "aggregates")
    if len(aggregates_raw) > MAX_AGGREGATES:
        raise ReportError(f"A report can have at most {MAX_AGGREGATES} calculations.")
    aggregates = [_aggregate(dataset, viewer, a) for a in aggregates_raw]
    aggregates_json = [
        {"field": a.field.key if a.field else None, "fn": a.fn, **({"label": a.label} if a.custom_label else {})}
        for a in aggregates
    ]
    seen = set()
    for a in aggregates:
        if a.key in seen:
            raise ReportError(f"{a.label!r} is asked for twice. Give each calculation a different field or calculation.")
        seen.add(a.key)

    pivot_raw = definition.get("pivot")
    pivot_rows = pivot_columns = None
    pivot_value = None
    if pivot_raw is not None:
        if not isinstance(pivot_raw, dict):
            raise ReportError("A pivot needs rows, columns and a value.")
        if group_by or aggregates:
            raise ReportError("Use either a pivot or group_by with aggregates, not both.")
        pivot_rows = _lookup(dataset, viewer, pivot_raw.get("rows"), "pivot")
        pivot_columns = _lookup(dataset, viewer, pivot_raw.get("columns"), "pivot")
        for p in (pivot_rows, pivot_columns):
            if not p.groupable or p.python is not None:
                raise ReportError(f"{p.label} cannot be used in a pivot.")
        if pivot_rows is pivot_columns:
            raise ReportError("A pivot needs two different fields, one for rows and one for columns.")
        value_raw = pivot_raw.get("value")
        if not isinstance(value_raw, dict):
            raise ReportError("A pivot needs a value, such as {field, fn}.")
        pivot_value = _aggregate(dataset, viewer, value_raw)

    dims = [pivot_rows, pivot_columns] if pivot_raw is not None else group_by
    if bucket and not any(d is not None and d.type == "date" for d in dims):
        raise ReportError("A date bucket needs a date field in group_by (or in the pivot's rows or columns).")

    if pivot_raw is not None:
        mode = "pivot"
    elif group_by or aggregates:
        mode = "group"
        if not aggregates:
            aggregates = [Aggregate(None, "count", "count", "Count", "number")]
    else:
        mode = "rows"

    columns: list[Field] = []
    names = _as_list(definition.get("columns"), "columns")
    if len(names) > MAX_COLUMNS:
        raise ReportError(f"A report can show at most {MAX_COLUMNS} columns.")
    for name in names:
        c = _lookup(dataset, viewer, name, "column")
        if c not in columns:
            columns.append(c)
    saved_columns = [c.key for c in columns]
    if mode == "rows" and not columns:
        columns = [
            dataset.field(k) for k in dataset.default_columns
            if dataset.field(k) and dataset.field(k).available(viewer)
        ]
    elif mode != "rows":
        columns = []

    sort: list[tuple[str, str]] = []
    sort_raw = _as_list(definition.get("sort"), "sort")
    if len(sort_raw) > MAX_SORTS:
        raise ReportError(f"A report can be sorted by at most {MAX_SORTS} fields.")
    allowed_sorts = _sortable_keys(mode, dataset, viewer, group_by, aggregates, pivot_rows)
    for s in sort_raw:
        if not isinstance(s, dict):
            raise ReportError("Each sort needs a field and a direction.")
        name = s.get("field")
        direction = s.get("dir", "asc")
        if direction not in ("asc", "desc"):
            raise ReportError("A sort direction is 'asc' or 'desc'.")
        if isinstance(name, str) and dataset.field(name) is not None:
            _lookup(dataset, viewer, name, "sort")  # a field this person may not use says why
        if name not in allowed_sorts:
            if isinstance(name, str) and dataset.field(name) is not None:
                raise ReportError(f"This report cannot be sorted by {dataset.field(name).label}. Sort by one of its own columns.")
            raise ReportError(f"{name!r} is not something this report can be sorted by.")
        sort.append((name, direction))
    if top_n and not sort and mode == "rows":
        raise ReportError("top_n needs a sort, so it is clear what the top is.")

    normalised = {
        "dataset": dataset.key,
        "columns": saved_columns,
        "filters": [_filter_json(f) for f in filters],
        "group_by": [g.key for g in group_by],
        "date_bucket": bucket,
        "aggregates": aggregates_json,
        "pivot": (
            {"rows": pivot_rows.key, "columns": pivot_columns.key,
             "value": {"field": pivot_value.field.key if pivot_value.field else None, "fn": pivot_value.fn}}
            if pivot_raw is not None else None
        ),
        "sort": [{"field": k, "dir": d} for k, d in sort],
        "limit": limit,
        "top_n": top_n,
    }
    return Plan(
        viewer=viewer, dataset=dataset, mode=mode, definition=normalised, columns=columns, filters=filters,
        group_by=group_by, bucket=bucket, aggregates=aggregates, pivot_rows=pivot_rows,
        pivot_columns=pivot_columns, pivot_value=pivot_value, sort=sort, limit=limit, top_n=top_n,
    )


def _filter_json(f: Filter) -> dict[str, Any]:
    def plain(v):
        return v.isoformat() if isinstance(v, date) else v

    value = [plain(v) for v in f.value] if isinstance(f.value, list) else plain(f.value)
    return {"field": f.field.key, "op": f.op, "value": value}


def _sortable_keys(mode, dataset, viewer, group_by, aggregates, pivot_rows) -> set[str]:
    if mode == "rows":
        return {f.key for f in dataset.fields_for(viewer) if f.sortable and f.python is None}
    if mode == "group":
        return {g.key for g in group_by} | {a.key for a in aggregates}
    return {pivot_rows.key, "total"}


# ---------------------------------------------------------------------- run --


def _alias(f: Field) -> str:
    return f"f_{f.key}"


def _filter_q(flt: Filter) -> Q:
    alias = _alias(flt.field)
    textual = flt.field.type in ("string", "enum")
    op, v = flt.op, flt.value
    null = Q(**{f"{alias}__isnull": True})

    def equals(value) -> Q:
        return Q(**{f"{alias}__iexact": value}) if textual else Q(**{alias: value})

    if op == "eq":
        return equals(v)
    if op == "ne":
        return ~equals(v) | null
    if op == "in":
        out = Q()
        for item in v:
            out |= equals(item)
        return out
    if op == "not_in":
        out = Q()
        for item in v:
            out |= equals(item)
        return ~out | null
    if op == "contains":
        return Q(**{f"{alias}__icontains": v})
    if op in ("gt", "gte", "lt", "lte"):
        return Q(**{f"{alias}__{op}": v})
    if op == "between":
        return Q(**{f"{alias}__range": (v[0], v[1])})
    if op == "is_empty":
        return null | Q(**{alias: ""}) if textual else null
    if op == "not_empty":
        return ~null & ~Q(**{alias: ""}) if textual else ~null
    raise ReportError(f"Unsupported operator {op!r}.")  # pragma: no cover


_FN = {"sum": Sum, "avg": Avg, "min": Min, "max": Max}


def _agg_expr(a: Aggregate):
    if a.fn == "count":
        return Count("*") if a.field is None else Count(_alias(a.field))
    if a.fn == "count_distinct":
        return Count(_alias(a.field), distinct=True)
    return _FN[a.fn](_alias(a.field))


def _bucket_expr(alias: str, bucket: str, viewer: Viewer):
    if bucket == "month":
        return TruncMonth(alias)
    if bucket == "quarter":
        return TruncQuarter(alias)
    if bucket == "year":
        return TruncYear(alias)
    return ds_mod.academic_year_expr(F(alias), viewer.year_start_month)


def _bucket_text(value: Any, bucket: str) -> Optional[str]:
    if value is None:
        return None
    if bucket == "academic_year":
        return value
    if isinstance(value, datetime):
        value = value.date()
    if bucket == "month":
        return f"{value:%Y-%m}"
    if bucket == "quarter":
        return f"{value.year}-Q{(value.month - 1) // 3 + 1}"
    return f"{value.year}"


def _convert(value: Any, ftype: str, *, group: bool = False) -> Any:
    if value is None:
        return NOT_RECORDED if group and ftype in ("string", "enum") else None
    if ftype == "date":
        if isinstance(value, datetime):
            value = value.date()
        return value.isoformat() if isinstance(value, date) else str(value)
    if ftype == "money":
        return round(float(value), 2)
    if ftype == "number":
        if isinstance(value, float):
            return int(value) if value.is_integer() and abs(value) < 1e15 else round(value, 4)
        return value
    if ftype == "bool":
        return bool(value)
    text = str(value)
    if group and not text.strip():
        return NOT_RECORDED
    return text


def _dimension(plan_: Plan, f: Field) -> tuple[str, str, str, str]:
    """(query alias, output key, label, output type) for a field used to group."""
    if plan_.bucket and f.type == "date":
        label = f"{f.label} by {_BUCKET_WORDS[plan_.bucket]}"
        return f"b_{f.key}", f.key, label, "string"
    return _alias(f), f.key, f.label, f.type


def _annotations(plan_: Plan, fields: list[Field]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in fields:
        out[_alias(f)] = f.expression(plan_.viewer)
    return out


def _used_fields(plan_: Plan) -> list[Field]:
    used: list[Field] = []

    def add(f: Optional[Field]):
        if f is not None and f.python is None and f not in used:
            used.append(f)

    for c in plan_.columns:
        add(c)
        if c.python is not None:
            for need in c.python[0]:
                add(plan_.dataset.field(need))
    for flt in plan_.filters:
        add(flt.field)
    for g in plan_.group_by:
        add(g)
    for a in plan_.aggregates:
        add(a.field)
    add(plan_.pivot_rows)
    add(plan_.pivot_columns)
    if plan_.pivot_value:
        add(plan_.pivot_value.field)
    if plan_.mode == "rows":
        for key, _ in plan_.sort:
            add(plan_.dataset.field(key))
    return used


def _filtered(plan_: Plan):
    qs = plan_.dataset.base(plan_.viewer)
    qs = qs.annotate(**_annotations(plan_, _used_fields(plan_)))
    for flt in plan_.filters:
        qs = qs.filter(_filter_q(flt))
    return qs


def _order(items: list[tuple[str, str]]):
    out = []
    for alias, direction in items:
        out.append(F(alias).desc(nulls_last=True) if direction == "desc" else F(alias).asc(nulls_last=True))
    return out


def _fetch(qs, limit: int) -> tuple[list, int]:
    """(up to `limit` rows, how many there are in all)."""
    rows = list(qs[:limit])
    total = len(rows) if len(rows) < limit else qs.count()
    return rows, total


def run(user, definition: Any) -> dict[str, Any]:
    return execute(plan(user, definition))


def execute(plan_: Plan) -> dict[str, Any]:
    out = {"rows": _run_rows, "group": _run_group, "pivot": _run_pivot}[plan_.mode](plan_)
    out["scope"] = plan_.viewer.scope
    return out


def _run_rows(plan_: Plan) -> dict[str, Any]:
    limit = min(plan_.limit, plan_.top_n) if plan_.top_n else plan_.limit
    qs = _filtered(plan_)
    real = [c for c in plan_.columns if c.python is None]
    needed: list[Field] = list(real)
    for c in plan_.columns:
        if c.python is not None:
            for need in c.python[0]:
                f = plan_.dataset.field(need)
                if f not in needed:
                    needed.append(f)
    order = [(_alias(plan_.dataset.field(k)), d) for k, d in plan_.sort]
    qs = qs.order_by(*_order(order), "pk")
    aliases = [_alias(f) for f in needed]
    raw, total = _fetch(qs.values_list(*aliases), limit)
    if plan_.top_n:
        total = min(total, plan_.top_n)
    index = {f.key: i for i, f in enumerate(needed)}

    derived: dict[str, list] = {}
    for c in plan_.columns:
        if c.python is not None:
            needs, fn = c.python
            derived[c.key] = fn(plan_.viewer, [tuple(r[index[n]] for n in needs) for r in raw])

    keys = [c.key for c in plan_.columns]
    types = [c.type for c in plan_.columns]
    picks = [index.get(c.key) for c in plan_.columns]
    rows = []
    for n, r in enumerate(raw):
        rows.append({
            k: (_convert(r[p], t) if p is not None else derived[k][n])
            for k, t, p in zip(keys, types, picks)
        })
    return {
        "columns": [{"key": c.key, "label": c.label, "type": c.type} for c in plan_.columns],
        "rows": rows,
        "total_rows": total,
        "truncated": total > len(rows),
        "chart_hint": {"kind": "none", "x": None, "y": []},
    }


def _group_query(plan_: Plan, dims: list[Field], aggregates: list[Aggregate]):
    qs = _filtered(plan_)
    if not dims:
        return qs, [], {a.key: f"a_{a.key}" for a in aggregates}
    extra: dict[str, Any] = {}
    group_aliases: list[str] = []
    for d in dims:
        alias, _key, _label, _type = _dimension(plan_, d)
        if alias.startswith("b_"):
            extra[alias] = _bucket_expr(_alias(d), plan_.bucket, plan_.viewer)
        group_aliases.append(alias)
    if extra:
        qs = qs.annotate(**extra)
    agg_aliases = {a.key: f"a_{a.key}" for a in aggregates}
    qs = qs.values(*group_aliases).annotate(**{agg_aliases[a.key]: _agg_expr(a) for a in aggregates})
    return qs, group_aliases, agg_aliases


def _run_group(plan_: Plan) -> dict[str, Any]:
    qs, group_aliases, agg_aliases = _group_query(plan_, plan_.group_by, plan_.aggregates)
    dims = [_dimension(plan_, g) for g in plan_.group_by]
    columns = [{"key": k, "label": lbl, "type": t} for _a, k, lbl, t in dims]
    columns += [{"key": a.key, "label": a.label, "type": a.type} for a in plan_.aggregates]

    if not plan_.group_by:
        # One row of totals. An aggregate over no rows is still one row: zeros and blanks.
        totals = qs.aggregate(**{agg_aliases[a.key]: _agg_expr(a) for a in plan_.aggregates})
        rows = [{a.key: _convert(totals[agg_aliases[a.key]], a.type) for a in plan_.aggregates}]
        return {"columns": columns, "rows": rows, "total_rows": 1, "truncated": False,
                "chart_hint": {"kind": "none", "x": None, "y": []}}

    ordering: list[tuple[str, str]] = []
    for key, direction in plan_.sort:
        alias = next((a for a, k, _l, _t in dims if k == key), None) or agg_aliases.get(key)
        ordering.append((alias, direction))
    if not ordering:
        if plan_.top_n:
            ordering = [(agg_aliases[plan_.aggregates[0].key], "desc")]
        else:
            ordering = [(a, "asc") for a in group_aliases]
    # Ties keep a steady order, so a cut at the limit is the same cut each time.
    ordering += [(a, "asc") for a in group_aliases if a not in {o[0] for o in ordering}]
    qs = qs.order_by(*_order(ordering))

    limit = min(plan_.limit, plan_.top_n) if plan_.top_n else plan_.limit
    raw, total = _fetch(qs, limit)
    if plan_.top_n:
        total = min(total, plan_.top_n)
    rows = []
    for r in raw:
        row = {}
        for (alias, key, _lbl, ftype), g in zip(dims, plan_.group_by):
            v = r[alias]
            if plan_.bucket and g.type == "date":
                v = _bucket_text(v, plan_.bucket)
                row[key] = v if v is not None else NOT_RECORDED
            else:
                row[key] = _convert(v, ftype, group=True)
        for a in plan_.aggregates:
            row[a.key] = _convert(r[agg_aliases[a.key]], a.type)
        rows.append(row)
    return {
        "columns": columns, "rows": rows, "total_rows": total, "truncated": total > len(rows),
        "chart_hint": _chart_hint(plan_, dims, len(rows)),
    }


def _chart_hint(plan_: Plan, dims, row_count: int) -> dict[str, Any]:
    ys = [a.key for a in plan_.aggregates]
    first = plan_.group_by[0]
    x = dims[0][1]
    if first.type == "date":
        return {"kind": "line", "x": x, "y": ys}
    one_share = (
        len(plan_.group_by) == 1 and len(ys) == 1 and plan_.aggregates[0].fn in ("count", "count_distinct", "sum")
    )
    if one_share and 1 < row_count <= 6:
        return {"kind": "pie", "x": x, "y": ys}
    return {"kind": "bar", "x": x, "y": ys}


def _run_pivot(plan_: Plan) -> dict[str, Any]:
    value = plan_.pivot_value
    qs, group_aliases, agg_aliases = _group_query(plan_, [plan_.pivot_rows, plan_.pivot_columns], [value])
    rows_dim = _dimension(plan_, plan_.pivot_rows)
    cols_dim = _dimension(plan_, plan_.pivot_columns)
    qs = qs.order_by(*_order([(a, "asc") for a in group_aliases]))
    raw, total = _fetch(qs, plan_.limit)
    agg_alias = agg_aliases[value.key]

    def text_of(dim, field_, v):
        if plan_.bucket and field_.type == "date":
            t = _bucket_text(v, plan_.bucket)
            return t if t is not None else NOT_RECORDED
        c = _convert(v, dim[3], group=True)
        if isinstance(c, bool):
            return "Yes" if c else "No"
        return c if isinstance(c, str) else (NOT_RECORDED if c is None else str(c))

    row_labels: list[str] = []
    col_raw: dict[str, Any] = {}
    cells: dict[tuple[str, str], Any] = {}
    for r in raw:
        rl = text_of(rows_dim, plan_.pivot_rows, r[rows_dim[0]])
        cl = text_of(cols_dim, plan_.pivot_columns, r[cols_dim[0]])
        if rl not in row_labels:
            row_labels.append(rl)
        col_raw.setdefault(cl, r[cols_dim[0]])
        cells[(rl, cl)] = r[agg_alias]
    # Columns in the order of what they stand for (numbers as numbers, dates as dates), blanks last.
    try:
        col_labels = sorted(col_raw, key=lambda label: (col_raw[label] is None, col_raw[label] if col_raw[label] is not None else 0))
    except TypeError:
        col_labels = sorted(col_raw)
    if len(col_labels) > MAX_PIVOT_COLUMNS:
        raise ReportError(
            f"This pivot would have {len(col_labels)} columns, and {MAX_PIVOT_COLUMNS} is the most. "
            f"Filter first, or choose a field with fewer values for the columns."
        )
    additive = value.fn in ("count", "sum")
    col_keys = {cl: f"c{i}" for i, cl in enumerate(col_labels)}
    columns = [{"key": rows_dim[1], "label": rows_dim[2], "type": rows_dim[3]}]
    columns += [{"key": col_keys[cl], "label": cl, "type": value.type} for cl in col_labels]
    if additive:
        columns.append({"key": "total", "label": "Total", "type": value.type})
    rows = []
    for rl in row_labels:
        row: dict[str, Any] = {rows_dim[1]: rl}
        subtotal = 0
        for cl in col_labels:
            v = cells.get((rl, cl))
            row[col_keys[cl]] = _convert(v, value.type)
            subtotal += v or 0
        if additive:
            row["total"] = _convert(subtotal, value.type)
        rows.append(row)
    sort = plan_.sort[0] if plan_.sort else None
    if sort and sort[0] == "total" and additive:
        rows.sort(key=lambda r: r["total"] or 0, reverse=sort[1] == "desc")
    elif sort:
        rows.sort(key=lambda r: str(r[rows_dim[1]]), reverse=sort[1] == "desc")
    elif plan_.top_n and additive:
        rows.sort(key=lambda r: r["total"] or 0, reverse=True)
    if plan_.top_n:
        rows = rows[: plan_.top_n]
    hint = {"kind": "bar", "x": rows_dim[1], "y": [col_keys[cl] for cl in col_labels]}
    return {"columns": columns, "rows": rows, "total_rows": len(row_labels) if not plan_.top_n else min(len(row_labels), plan_.top_n),
            "truncated": total > len(raw) or (bool(plan_.top_n) and len(row_labels) > plan_.top_n), "chart_hint": hint}



# ------------------------------------------------------------ for the files --


def describe_filters(plan_: Plan) -> list[str]:
    """The report's choices in plain words, for the top of a file."""
    out = [f"Dataset: {plan_.dataset.label}"]
    for flt in plan_.filters:
        word = _OP_WORDS[flt.op]
        v = flt.value

        def show(x):
            if isinstance(x, bool):
                return "yes" if x else "no"
            return x.isoformat() if isinstance(x, date) else str(x)

        if flt.op in ("is_empty", "not_empty"):
            out.append(f"{flt.field.label} {word}")
        elif flt.op == "between":
            out.append(f"{flt.field.label} {word} {show(v[0])} and {show(v[1])}")
        elif isinstance(v, list):
            out.append(f"{flt.field.label} {word} {', '.join(show(x) for x in v)}")
        else:
            out.append(f"{flt.field.label} {word} {show(v)}")
    if plan_.mode == "group" and plan_.group_by:
        by = ", ".join(g.label for g in plan_.group_by)
        if plan_.bucket:
            by += f" (by {_BUCKET_WORDS[plan_.bucket]})"
        out.append(f"Grouped by {by}")
    if plan_.mode == "pivot":
        out.append(f"Pivot of {plan_.pivot_rows.label} by {plan_.pivot_columns.label}")
    if plan_.top_n:
        out.append(f"Top {plan_.top_n}")
    return out


_EXPORT_KIND = {"string": "text", "enum": "text", "bool": "text", "number": "number", "money": "money", "date": "date"}


def table_for_file(result: dict[str, Any], plan_: Plan) -> tuple[list[str], list[list[Any]], list[str]]:
    """(headings, rows as lists, exporter kinds) for `exporters.render_table`."""
    headings = [c["label"] for c in result["columns"]]
    kinds: list[str] = []
    for c in result["columns"]:
        kind = _EXPORT_KIND[c["type"]]
        f = plan_.dataset.field(c["key"])
        if f is not None and f.format == "year" and c["type"] == "number":
            kind = "year"
        kinds.append(kind)
    keys = [c["key"] for c in result["columns"]]
    types = [c["type"] for c in result["columns"]]
    rows = [
        [("Yes" if r[k] else "No") if (t == "bool" and r[k] is not None) else r[k] for k, t in zip(keys, types)]
        for r in result["rows"]
    ]
    return headings, rows, kinds
