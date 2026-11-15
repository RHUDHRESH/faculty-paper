"""The fuller read-only report behind `manage.py db_check`.

Plain SELECTs against the PostgreSQL catalog and statistics views. The
thresholds live in `db_health`, shared with the deep health report.
"""

from __future__ import annotations

from typing import Any

from core.services.db_health import (
    CONNECTIONS_CRITICAL_RATIO,
    LATENCY_CRITICAL_MS,
    MIN_SERVER_MAJOR,
    median_latency_ms,
    server_facts,
)

_USER_TABLES = "n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')"

LARGEST_TABLES_SQL = f"""
SELECT c.relname, pg_total_relation_size(c.oid), c.reltuples::bigint
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND {_USER_TABLES}
ORDER BY 2 DESC LIMIT 10
"""

# A foreign key is covered when some valid, non-partial index starts with
# exactly its columns (in any order). Without one, deleting a parent row scans
# the whole child table.
UNINDEXED_FK_SQL = f"""
SELECT c.conrelid::regclass::text, c.conname
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype = 'f' AND {_USER_TABLES}
AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
    AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] @> c.conkey
)
ORDER BY 1, 2
"""

# Constraint-backing (unique / primary key) indexes are left out: they are
# needed even if no query ever reads them.
UNUSED_INDEX_SQL = """
SELECT s.relname, s.indexrelname, pg_relation_size(s.indexrelid)
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
AND pg_relation_size(s.indexrelid) > 1048576
ORDER BY 3 DESC
"""

# A floor of 1,000 dead rows keeps a 5-row table with 2 dead rows quiet.
DEAD_TUPLE_SQL = """
SELECT relname, n_live_tup, n_dead_tup
FROM pg_stat_user_tables
WHERE n_dead_tup >= 1000 AND n_dead_tup > 0.2 * (n_live_tup + n_dead_tup)
ORDER BY n_dead_tup DESC
"""

LONG_QUERY_SQL = """
SELECT pid, round(extract(epoch FROM now() - query_start))::int, left(query, 120)
FROM pg_stat_activity
WHERE state = 'active' AND datname = current_database()
AND pid <> pg_backend_pid() AND now() - query_start > interval '60 seconds'
ORDER BY query_start
"""

PG_STAT_STATEMENTS_SQL = "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'"


def _rows(cursor, sql: str) -> list[tuple]:
    cursor.execute(sql)
    return list(cursor.fetchall())


def collect_report(cursor) -> dict[str, Any]:
    """Everything `db_check` prints, as plain data. Read-only SELECTs only."""
    facts = server_facts(cursor)
    num = facts["server_version_num"]
    return {
        "latency_ms": median_latency_ms(cursor),
        "server_version": facts["server_version"],
        "server_major": num // 10000 if num else None,
        "size_bytes": facts["size_bytes"],
        "connections_used": facts["connections_used"],
        "connections_max": facts["connections_max"],
        "largest_tables": [
            {"table": r[0], "bytes": int(r[1]), "rows": max(int(r[2]), 0)}
            for r in _rows(cursor, LARGEST_TABLES_SQL)
        ],
        "unindexed_foreign_keys": [
            {"table": r[0], "constraint": r[1]} for r in _rows(cursor, UNINDEXED_FK_SQL)
        ],
        "unused_indexes": [
            {"table": r[0], "index": r[1], "bytes": int(r[2])}
            for r in _rows(cursor, UNUSED_INDEX_SQL)
        ],
        "bloated_tables": [
            {
                "table": r[0], "live": int(r[1]), "dead": int(r[2]),
                "ratio": round(int(r[2]) / max(int(r[1]) + int(r[2]), 1), 3),
            }
            for r in _rows(cursor, DEAD_TUPLE_SQL)
        ],
        "long_queries": [
            {"pid": r[0], "seconds": r[1], "query": " ".join(str(r[2]).split())}
            for r in _rows(cursor, LONG_QUERY_SQL)
        ],
        "pg_stat_statements": bool(_rows(cursor, PG_STAT_STATEMENTS_SQL)),
    }


def critical_findings(report: dict[str, Any]) -> list[str]:
    """The reasons `db_check` exits 1. Empty means no critical finding."""
    found = []
    major = report.get("server_major")
    if major is None or major < MIN_SERVER_MAJOR:
        found.append(
            f"PostgreSQL {report.get('server_version') or 'version unknown'} is older "
            f"than {MIN_SERVER_MAJOR} (or its version could not be read)"
        )
    if report["latency_ms"] > LATENCY_CRITICAL_MS:
        found.append(f"round trip {report['latency_ms']} ms is over {LATENCY_CRITICAL_MS} ms")
    used, limit = report.get("connections_used"), report.get("connections_max")
    if used is not None and limit and used > CONNECTIONS_CRITICAL_RATIO * limit:
        found.append(
            f"{used} of {limit} connections are in use "
            f"({round(100 * used / limit)}%, over {int(CONNECTIONS_CRITICAL_RATIO * 100)}%)"
        )
    return found
