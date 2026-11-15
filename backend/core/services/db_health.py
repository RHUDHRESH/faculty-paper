"""Facts about the database server, read-only.

Shared by `GET /api/health?deep=1` and `manage.py db_check`, so the two never
disagree about what "slow" or "nearly full" means. Every query here only reads.
Nothing in this module may raise out to a caller that is answering a health
probe: a fact that cannot be read is simply left out.
"""

from __future__ import annotations

import statistics
import time
from typing import Any

# A round trip above this says the database is far from the API (another
# region, or a shared network). In the same region it is a few milliseconds.
LATENCY_WARN_MS = 50
LATENCY_CRITICAL_MS = 100
CONNECTIONS_CRITICAL_RATIO = 0.8
MIN_SERVER_MAJOR = 15

LATENCY_HINT = (
    "Round trips to the database are slow. Check that the database is in the "
    "same region as the API (Singapore for both), and use its internal address "
    "if the host offers one."
)


def is_postgres(connection) -> bool:
    return connection.vendor == "postgresql"


def median_latency_ms(cursor, rounds: int = 3) -> float:
    """Median wall time of `SELECT 1` round trips, in milliseconds."""
    samples = []
    for _ in range(rounds):
        t0 = time.perf_counter()
        cursor.execute("SELECT 1")
        cursor.fetchone()
        samples.append((time.perf_counter() - t0) * 1000)
    return round(statistics.median(samples), 2)


def _scalar(cursor, sql: str):
    cursor.execute(sql)
    row = cursor.fetchone()
    return row[0] if row else None


def server_facts(cursor) -> dict[str, Any]:
    """Version, size and connection counts of a PostgreSQL server."""
    facts: dict[str, Any] = {}
    for key, sql in (
        ("server_version", "SHOW server_version"),
        ("server_version_num", "SHOW server_version_num"),
        ("size_bytes", "SELECT pg_database_size(current_database())"),
        ("connections_used", "SELECT count(*) FROM pg_stat_activity"),
        ("connections_max", "SHOW max_connections"),
    ):
        try:
            facts[key] = _scalar(cursor, sql)
        except Exception:
            facts[key] = None
    for key in ("server_version_num", "size_bytes", "connections_used", "connections_max"):
        try:
            facts[key] = int(facts[key]) if facts[key] is not None else None
        except (TypeError, ValueError):
            facts[key] = None
    return facts


def database_details(connection) -> dict[str, Any]:
    """The `db_details` block of the deep health report.

    Never raises. On SQLite (local development) only the latency, the engine
    version and the file size are known.
    """
    details: dict[str, Any] = {"vendor": connection.vendor}
    try:
        with connection.cursor() as c:
            latency = median_latency_ms(c)
            details["latency_ms"] = latency
            if latency > LATENCY_WARN_MS:
                details["latency_warning"] = True
                details["hint"] = LATENCY_HINT
            if is_postgres(connection):
                f = server_facts(c)
                details["server_version"] = f["server_version"]
                details["size_mb"] = (
                    round(f["size_bytes"] / 1048576, 1) if f["size_bytes"] is not None else None
                )
                details["connections"] = {
                    "used": f["connections_used"],
                    "max": f["connections_max"],
                }
            else:
                import sqlite3

                details["server_version"] = sqlite3.sqlite_version
    except Exception:
        details.setdefault("error", "could not read database details")
    return details
