"""Make a backup taken before migration 0075 loadable after it.

An export from before the ledger had `kind` and `cycle` carries a payment, its
void's reversing row, and a second payment after the void, all as plain rows.
Loaded as they stand they would all default to "PAYMENT, cycle 1", and the
database (rightly) refuses two payments for one claim in one cycle: the very
backup somebody needs in a disaster would fail to restore.

This reads such a file and gives each ledger row the kind and cycle migration
0075 would have given it, by the same rule, so the restore lands exactly where
the same data would have after migrating. Files that already carry `kind` are
left alone, and files too large to read into memory are passed through as they
are (the restore then reports the constraint it hit rather than guessing).
"""
from __future__ import annotations

import gzip
import json
import os
from typing import Any

#: Past this the file is not read into memory here; a restore is for a fresh
#: installation and the upload limit is 90 MB.
MAX_BYTES = 60 * 1024 * 1024


def classify(amount: float, voucher: str | None, raw_json: str | None) -> str:
    voucher = voucher or ""
    if (amount or 0) < 0:
        return "REVERSAL" if voucher.endswith("-VOID") or '"voided_by"' in (raw_json or "") else "ADJUSTMENT"
    return "ADJUSTMENT" if voucher.endswith("-ADJ") else "PAYMENT"


def upgrade_records(records: list[dict[str, Any]]) -> int:
    """Set kind and cycle on old ledger rows, in place. Returns how many."""
    by_claim: dict[str, list[dict[str, Any]]] = {}
    for rec in records:
        if rec.get("model") != "core.paidledger":
            continue
        fields = rec.get("fields", {})
        if "kind" in fields or not fields.get("claim"):
            continue
        by_claim.setdefault(fields["claim"], []).append(rec)
    changed = 0
    for rows in by_claim.values():
        rows.sort(key=lambda r: (r["fields"].get("created_at") or "", r.get("pk") or ""))
        cycle = 1
        for rec in rows:
            f = rec["fields"]
            kind = classify(f.get("amount") or 0, f.get("voucher_number"), f.get("raw_json"))
            f["kind"], f["cycle"] = kind, cycle
            changed += 1
            if kind == "REVERSAL":
                cycle += 1
    return changed


def upgraded_path(path: str) -> str:
    """The file to load: `path` itself, or an upgraded copy beside it."""
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return path
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8") as fh:
            records = json.load(fh)
    except (OSError, ValueError):
        return path
    if not isinstance(records, list) or not upgrade_records(records):
        return path
    out = path + ".upgraded.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(records, fh)
    return out
