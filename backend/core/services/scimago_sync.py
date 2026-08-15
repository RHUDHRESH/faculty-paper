"""Fetch the official SCImago journal rank dump and load it into ScimagoJournal.

The quartile on a claim decides the QF term in the payout, so the dump behind it
has to be refreshable without anyone hand-downloading a CSV once a year and
remembering to upload it.
"""
from __future__ import annotations

import csv
import io
import json
import re
from typing import Any, Iterator

import httpx
from django.db import transaction

from core.models import ScimagoJournal
from core.services.scimago import parse_categories_field

SCIMAGO_RANK_URL = "https://www.scimagojr.com/journalrank.php"

# The portal serves the dump to browsers only; without a UA it returns the HTML page.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


class ScimagoSyncError(Exception):
    pass


def parse_decimal(raw: Any) -> float | None:
    """Read SJR values from either decimal convention.

    The official dump is European: SJR 0.137 ships as "0,137". Stripping commas
    the way a naive parser does turns that into 137 — a thousand-fold error on a
    number that ends up next to a payout.
    """
    s = str(raw if raw is not None else "").strip()
    if not s or s in {"-", "N/A", "NA"}:
        return None
    s = s.replace(" ", "").replace(" ", "")
    if "," in s and "." in s:
        # Whichever separator comes last is the decimal point.
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        # A lone comma is the decimal separator in this dump. SJR never reaches
        # four figures, so there is no thousands separator to confuse it with.
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _first(row: dict[str, Any], *names: str) -> str | None:
    """Column headers differ between the portal dump and hand-made exports."""
    for n in names:
        for key in (n, n.lower(), n.upper(), n.title()):
            if key in row and str(row[key]).strip():
                return str(row[key]).strip()
    return None


def read_rows(content: str) -> Iterator[dict[str, Any]]:
    """Rows from the dump, whichever delimiter it arrived with."""
    sample = content[:4096]
    delimiter = ";" if sample.count(";") > sample.count(",") else ","
    yield from csv.DictReader(io.StringIO(content), delimiter=delimiter)


def normalize_row(row: dict[str, Any]) -> dict[str, Any] | None:
    title = _first(row, "Title", "Journal", "Source title")
    if not title:
        return None
    issn_raw = _first(row, "Issn", "ISSN", "Print ISSN") or ""
    # The dump packs both ISSNs into one field: "00280836, 14764687".
    parts = [p.strip() for p in re.split(r"[,;]", issn_raw) if p.strip()]
    issn = parts[0] if parts else None
    eissn = _first(row, "EISSN", "E-ISSN", "Eissn") or (parts[1] if len(parts) > 1 else None)
    return {
        "title": title[:512],
        "issn": issn,
        "eissn": eissn,
        "sjr": parse_decimal(_first(row, "SJR")),
        "source_id": _first(row, "Sourceid", "Source Id", "Source ID"),
        "categories": parse_categories_field(_first(row, "Categories", "Category") or ""),
        "raw": row,
    }


def upsert_rows(rows: Iterator[dict[str, Any]] | list[dict[str, Any]], year: int) -> dict[str, int]:
    """Load normalized rows for one dataset year. All or nothing.

    A half-loaded dump silently mixes two datasets, and the mix only shows up
    later as a wrong quartile on somebody's payout.
    """
    imported = 0
    skipped = 0
    with transaction.atomic():
        for row in rows:
            if not row:
                skipped += 1
                continue
            # ScimagoJournal is unique on (issn, year); title-keyed rows keep
            # ISSN-less journals addressable instead of colliding on NULL.
            key = row["issn"] or f"TITLE:{row['title'][:40]}"
            ScimagoJournal.objects.update_or_create(
                issn=key,
                year=year,
                defaults={
                    "title": row["title"],
                    "eissn": row["eissn"],
                    "sjr": row["sjr"],
                    "source_id": row["source_id"],
                    "categories_json": json.dumps(row["categories"]),
                    "raw_json": json.dumps(row["raw"])[:50000],
                },
            )
            imported += 1
    return {"imported": imported, "skipped": skipped, "year": year}


MANUAL_FALLBACK = (
    "Download the CSV from scimagojr.com in a browser "
    "(Journal Rankings → Download data) and upload it here — it is parsed identically."
)


def _is_bot_challenge(text: str, status: int) -> bool:
    head = text[:2000].lower()
    return status in (403, 503) and (
        "just a moment" in head or "cf-browser-verification" in head or "cloudflare" in head
    )


def download_dump(year: int, timeout: float = 180.0) -> str:
    """The rank table for one year, as CSV text.

    SCImago fronts the portal with a bot challenge that a server-side client
    cannot answer, and it is not ours to work around. When that is what comes
    back, say so and point at the upload rather than failing on an opaque 403.
    """
    try:
        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            res = client.get(
                SCIMAGO_RANK_URL,
                params={"out": "xls", "year": str(year)},
                headers={
                    "User-Agent": _UA,
                    "Accept": "text/csv,text/html;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": "https://www.scimagojr.com/journalrank.php",
                },
            )
    except httpx.HTTPError as e:
        raise ScimagoSyncError(f"Could not reach scimagojr.com: {e}. {MANUAL_FALLBACK}") from e
    text = res.text
    if _is_bot_challenge(text, res.status_code):
        raise ScimagoSyncError(
            "SCImago is serving its bot-protection challenge, which a server cannot answer. "
            + MANUAL_FALLBACK
        )
    if res.status_code >= 400:
        raise ScimagoSyncError(f"SCImago returned HTTP {res.status_code}. {MANUAL_FALLBACK}")
    if text.lstrip().startswith("<"):
        raise ScimagoSyncError(
            "SCImago returned a web page instead of the dump — the year may not be published yet. "
            + MANUAL_FALLBACK
        )
    if "Title" not in text[:4096] and "title" not in text[:4096]:
        raise ScimagoSyncError(
            "Downloaded file does not look like a SCImago rank dump. " + MANUAL_FALLBACK
        )
    return text


def sync_year(year: int) -> dict[str, int]:
    """Download and load one dataset year."""
    content = download_dump(year)
    return upsert_rows((normalize_row(r) for r in read_rows(content)), year)


def import_csv_text(content: str, year: int) -> dict[str, int]:
    """Same loader for a hand-uploaded CSV, so both paths parse identically."""
    return upsert_rows((normalize_row(r) for r in read_rows(content)), year)
