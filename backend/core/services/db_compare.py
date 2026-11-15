"""Compare two databases table by table, reading only.

Used by `manage.py db_compare` to prove that a copy (a restore, a host move)
holds what the original holds: the same row count in every table of the `core`
app, and the same newest `updated_at` / `created_at`. It never writes, and it
never keeps or prints a password.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone as dt_timezone
from typing import Any
from urllib.parse import unquote, urlparse

from django.apps import apps
from django.db import models
from django.db.utils import ConnectionHandler
from django.utils.dateparse import parse_datetime

# Rows that legitimately differ between an original and its restored copy.
# A restore writes its own audit lines (RESTORE_QUEUED, RESTORE_DONE...), and
# the weekly backups held in the database are never part of an export.
# model name -> (column, LIKE pattern to leave out; backslash escapes)
IGNORED_ROWS = {
    "AuditLog": ("action", "RESTORE\\_%"),
    "StoredFile": ("name", "backups/%"),
}


def redact_url(url: str) -> str:
    """`user@host:port/name`, with no password and no query string."""
    p = urlparse(url)
    if p.scheme.startswith("sqlite"):
        return f"sqlite:{url.split('///', 1)[-1]}"
    who = unquote(p.username or "")
    where = p.hostname or (p.query and "socket") or ""
    port = f":{p.port}" if p.port else ""
    return f"{who + '@' if who else ''}{where}{port}/{(p.path or '/').lstrip('/')}"


def scrub(text: str, url: str) -> str:
    """Take the URL's password out of an error message."""
    p = urlparse(url)
    for secret in {p.password or "", unquote(p.password or "")}:
        if secret:
            text = text.replace(secret, "***")
    return text


def settings_for(url: str) -> dict:
    """A Django DATABASES entry for a postgres or sqlite URL."""
    if url.startswith("sqlite"):
        path = url.split("///", 1)[-1]
        return {"ENGINE": "django.db.backends.sqlite3", "NAME": path}
    if not url.startswith("postgres"):
        raise ValueError("the URL must start with postgres:// , postgresql:// or sqlite:///")
    from config.settings import _database_from_url

    entry = _database_from_url(url)
    entry["OPTIONS"]["application_name"] = "faculty-paper-db-compare"
    entry["CONN_MAX_AGE"] = 0
    return entry


def open_connection(url: str):
    """A connection of its own: a handler per URL, so it is never Django's
    default connection and nothing else shares it."""
    conn = ConnectionHandler({"default": settings_for(url)})["default"]
    if conn.vendor == "postgresql":
        # A second lock on the door: the session itself refuses writes.
        with conn.cursor() as c:
            c.execute("SET default_transaction_read_only = on")
    return conn


def core_models() -> list[type[models.Model]]:
    """Every real table of the core app, including many-to-many link tables."""
    return sorted(
        (
            m
            for m in apps.get_app_config("core").get_models(include_auto_created=True)
            if not m._meta.proxy and m._meta.managed
        ),
        key=lambda m: m._meta.db_table,
    )


def timestamp_column(model: type[models.Model]) -> str | None:
    """`updated_at`, else `created_at`, for a model that has an `id`."""
    names = {f.name: f for f in model._meta.get_fields() if hasattr(f, "column")}
    if "id" not in names:
        return None
    for col in ("updated_at", "created_at"):
        if isinstance(names.get(col), models.DateTimeField):
            return col
    return None


def normalise_timestamp(value: Any) -> str | None:
    """One text form for a timestamp from either engine, in UTC."""
    if value is None:
        return None
    if isinstance(value, str):
        parsed = parse_datetime(value.strip().replace(" ", "T", 1)) if value.strip() else None
        if parsed is None:
            return value
        value = parsed
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt_timezone.utc)
        return value.astimezone(dt_timezone.utc).isoformat(timespec="microseconds")
    return str(value)


def table_stats(conn, model_list=None) -> dict[str, dict[str, Any]]:
    """{table: {"rows": n, "newest": text or None}} for each model, or
    {"error": ...} for a table the database does not have."""
    qn = conn.ops.quote_name
    stats: dict[str, dict[str, Any]] = {}
    for model in model_list or core_models():
        table = model._meta.db_table
        where, params = "", []
        ignore = IGNORED_ROWS.get(model.__name__)
        if ignore:
            column = model._meta.get_field(ignore[0]).column
            where = f" WHERE {qn(column)} NOT LIKE %s ESCAPE '\\'"
            params = [ignore[1]]
        ts = timestamp_column(model)
        select = "COUNT(*)"
        if ts:
            select += f", MAX({qn(model._meta.get_field(ts).column)})"
        try:
            with conn.cursor() as c:
                c.execute(f"SELECT {select} FROM {qn(table)}{where}", params)
                row = c.fetchone()
        except Exception as exc:  # a table the other side never created
            stats[table] = {"error": type(exc).__name__}
            continue
        stats[table] = {
            "rows": int(row[0]),
            "newest": normalise_timestamp(row[1]) if ts else None,
        }
    return stats


def compare(source: dict, target: dict) -> list[dict[str, Any]]:
    """One entry per table that differs. Empty means the two agree."""
    diffs = []
    for table in sorted(set(source) | set(target)):
        s, t = source.get(table), target.get(table)
        if s is None or t is None or "error" in s or "error" in t:
            why = (
                "missing in target" if t is None or "error" in (t or {})
                else "missing in source"
            )
            diffs.append({"table": table, "source": s, "target": t, "why": why})
            continue
        problems = []
        if s["rows"] != t["rows"]:
            problems.append(f"rows differ by {t['rows'] - s['rows']:+d}")
        if s["newest"] != t["newest"]:
            problems.append("newest timestamp differs")
        if problems:
            diffs.append({"table": table, "source": s, "target": t, "why": "; ".join(problems)})
    return diffs


_URL_PASSWORD = re.compile(r"(://[^:/@\s]+:)[^@\s]+@")


def hide_passwords(text: str) -> str:
    """Last line of defence: any `scheme://user:secret@` in text is blanked."""
    return _URL_PASSWORD.sub(r"\1***@", text)
