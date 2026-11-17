"""Papers the college paid more than once to the same person.

The settled-claims workbook is the college's own record of what it paid. When
it lists one paper twice for one person, each with money, the importer writes
both payments (`settled_claims_import`) and this module finds them, so the
office is told rather than the second payment being dropped.

A paper is one person plus one paper, which is the same normalised title, or
the same DOI (two spellings of a title with one DOI are one paper). Every live
payment of that paper with money on it counts: a payment that was voided (a
`REVERSAL` for the same claim and cycle) and a zero amount do not.

`find` reads the ledger, plus any payments about to be written (so a check can
say what an import would add). It changes nothing.
"""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any, Iterable

from django.db.models import Q

from core.models import PaidLedger
from core.services.fyp_roster import staff_key
from core.services.normalize import normalize_doi, normalize_title

KIND = "double_payment"


def paper_digest(title: str) -> str:
    return hashlib.sha1(normalize_title(title)[:512].encode("utf-8")).hexdigest()[:16]


def signature(payments: Iterable[dict[str, Any]]) -> list[tuple[str, float]]:
    """What a flag was raised about: each payment's month and amount, in order."""
    return sorted((str(p.get("month") or "")[:7], round(float(p.get("amount") or 0), 2)) for p in payments)


def _doi_of(raw: str | None) -> str:
    if not raw or '"DOI"' not in raw:
        return ""
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return ""
    return (normalize_doi(str(data.get("DOI") or "")) or "") if isinstance(data, dict) else ""


def _month_text(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value or "")


def find(extra: Iterable[dict[str, Any]] = ()) -> list[dict[str, Any]]:
    """Every paper with two or more payments, newest total first.

    `extra` are payments not on the ledger yet, as dicts with `staff_id`,
    `name`, `title`, `doi`, `month` and `amount`.
    """
    rows = list(
        PaidLedger.objects.filter(
            Q(kind__in=[PaidLedger.Kind.PAYMENT, PaidLedger.Kind.REVERSAL])
            | Q(idempotency_key__startswith="settled-import:r:")  # the sheet's payment on a claim paid at nothing
        ).values(
            "kind", "claim_id", "cycle", "staff_id", "faculty_name", "paper_title", "amount", "payout_month", "raw_json"
        ).iterator(chunk_size=2000)
    )
    voided = {(r["claim_id"], r["cycle"]) for r in rows if r["kind"] == PaidLedger.Kind.REVERSAL and r["claim_id"]}
    items: list[dict[str, Any]] = []
    for r in rows:
        if r["kind"] == PaidLedger.Kind.REVERSAL or not (r["amount"] or 0) > 0:
            continue
        if r["claim_id"] and (r["claim_id"], r["cycle"]) in voided:
            continue
        items.append({
            "staff_id": r["staff_id"] or "", "name": r["faculty_name"] or "", "title": r["paper_title"] or "",
            "doi": _doi_of(r["raw_json"]), "month": r["payout_month"], "amount": float(r["amount"]),
        })
    for e in extra:
        if (e.get("amount") or 0) > 0:
            items.append({
                "staff_id": e.get("staff_id") or "", "name": e.get("name") or "", "title": e.get("title") or "",
                "doi": e.get("doi") or "", "month": e.get("month"), "amount": float(e["amount"]),
            })

    # One paper of one person: items sharing a (person, title) or a (person, DOI) are joined.
    parent = list(range(len(items)))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    seen: dict[tuple[str, str, str], int] = {}
    for i, it in enumerate(items):
        who = staff_key(it["staff_id"]) or (f"n:{it['name'].casefold()}" if it["name"] else "")
        it["who"] = who
        it["tkey"] = normalize_title(it["title"])[:512]
        if not who:
            continue
        keys = []
        if it["tkey"]:
            keys.append(("t", who, it["tkey"]))
        if it["doi"]:
            keys.append(("d", who, it["doi"]))
        for k in keys:
            j = seen.setdefault(k, i)
            if j != i:
                parent[root(i)] = root(j)

    groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for i, it in enumerate(items):
        if it["who"] and (it["tkey"] or it["doi"]):
            groups[root(i)].append(it)

    out = []
    for members in groups.values():
        if len(members) < 2:
            continue
        members.sort(key=lambda m: (_month_text(m["month"]), m["tkey"], m["amount"]))
        first = members[0]
        named = next((m for m in members if m["staff_id"]), first)
        out.append({
            "staff_id": named["staff_id"],
            "name": next((m["name"] for m in members if m["name"]), ""),
            "title": first["title"] or next((m["title"] for m in members if m["title"]), ""),
            "doi": next((m["doi"] for m in members if m["doi"]), ""),
            "payments": [{"month": _month_text(m["month"]), "amount": round(m["amount"], 2)} for m in members],
            "count": len(members),
            "total": round(sum(m["amount"] for m in members), 2),
        })
    out.sort(key=lambda d: (-d["total"], d["name"].casefold(), d["title"].casefold()))
    return out


__all__ = ["KIND", "find", "paper_digest", "signature"]
