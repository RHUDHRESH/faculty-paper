from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from typing import Any
from urllib.parse import quote, urlencode

import httpx
from django.conf import settings

from core.services.normalize import normalize_doi, normalize_issn

SCOPUS_BASE = "https://api.elsevier.com/content"

_RATE_WINDOW: dict[str, list[float]] = defaultdict(list)
_RATE_LIMIT = 30
_RATE_WINDOW_SEC = 60.0


def _check_rate_limit(key: str = "scopus") -> None:
    now = time.time()
    window = [t for t in _RATE_WINDOW[key] if now - t < _RATE_WINDOW_SEC]
    if len(window) >= _RATE_LIMIT:
        raise ScopusError("Scopus rate limit — wait and retry", code="rate_limit")
    window.append(now)
    _RATE_WINDOW[key] = window


class ScopusError(Exception):
    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.code = code


def _api_key() -> str:
    key = getattr(settings, "SCOPUS_API_KEY", "") or ""
    if not key or key == "your-scopus-api-key":
        raise ScopusError("SCOPUS_API_KEY is not configured", code="unauthorized")
    return key


def scopus_fetch(url: str, timeout: float = 30.0) -> dict[str, Any]:
    _check_rate_limit()
    key = _api_key()
    sep = "&" if "?" in url else "?"
    if "apiKey=" not in url:
        url = f"{url}{sep}apiKey={quote(key)}"
    headers = {"Accept": "application/json", "X-ELS-APIKey": key}
    with httpx.Client(timeout=timeout) as client:
        res = client.get(url, headers=headers)
        text = res.text.strip()
        if text.startswith("<") or text.startswith("<?xml"):
            raise ScopusError("API Error: Bad Request Structure", code="bad_payload")
        if res.status_code == 401 or res.status_code == 403:
            raise ScopusError(f"Scopus authorization failed ({res.status_code})", code="unauthorized")
        if res.status_code == 429:
            raise ScopusError("Scopus rate limit — wait and retry", code="rate_limit")
        if res.status_code >= 400:
            raise ScopusError(f"Scopus API {res.status_code}: {text[:300]}", code="error")
        try:
            return res.json()
        except json.JSONDecodeError as e:
            raise ScopusError(f"Invalid JSON from Scopus: {e}", code="bad_payload") from e


def pick_yearly_metric(lst: Any) -> tuple[float | None, int | None]:
    if not lst:
        return None, None
    items = lst
    if isinstance(lst, dict):
        items = lst.get("SNIP") or lst.get("SJR") or []
    if not isinstance(items, list):
        return None, None
    best: tuple[float, int] | None = None
    for item in items:
        if not isinstance(item, dict):
            continue
        year = item.get("@year") or item.get("year")
        value = item.get("$") or item.get("value") or item.get("_")
        try:
            y = int(year)
            v = float(value)
        except (TypeError, ValueError):
            continue
        if best is None or y > best[1]:
            best = (v, y)
    return (best[0], best[1]) if best else (None, None)


def parse_search_entry(entry: dict[str, Any]) -> dict[str, Any]:
    year = None
    cover = entry.get("prism:coverDate")
    if cover and isinstance(cover, str) and len(cover) >= 4:
        try:
            year = int(cover[:4])
        except ValueError:
            year = None

    scopus_url = None
    links = entry.get("link") or []
    if isinstance(links, list):
        for link in links:
            if isinstance(link, dict) and link.get("@ref") == "scopus":
                scopus_url = link.get("@href")
                break

    issn_raw = entry.get("prism:issn") or entry.get("prism:eIssn")
    return {
        "title": entry.get("dc:title"),
        "doi": entry.get("prism:doi"),
        "issn": normalize_issn(str(issn_raw)) if issn_raw else None,
        "journal_title": entry.get("prism:publicationName"),
        "publication_year": year,
        "cover_date": cover,
        "eid": entry.get("eid"),
        "scopus_url": scopus_url,
        "aggregation_type": entry.get("prism:aggregationType"),
        "author_count": _intish(entry.get("author-count")),
        "subjects": [],
        "authors": [],
        "scopus_id": entry.get("dc:identifier"),
        "raw": entry,
    }


def _intish(value: Any) -> int | None:
    if isinstance(value, dict):
        value = value.get("$") or value.get("@total") or value.get("#")
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def clean_title_for_query(title: str) -> str:
    return re.sub(r"[\'\"“”‘’]", "", str(title)).strip()


def _search(query: str, count: int = 1, sort: str | None = None) -> dict[str, Any]:
    params = {"query": query, "count": str(count)}
    if sort:
        params["sort"] = sort
    return scopus_fetch(f"{SCOPUS_BASE}/search/scopus?{urlencode(params)}")


def search_by_title(title: str) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Try exact TITLE, then a looser (case-insensitive) TITLE query for rough matches."""
    clean = clean_title_for_query(title)
    data = _search(f'TITLE("{clean}")')
    results = data.get("search-results") or {}
    total = str(results.get("opensearch:totalResults") or "0")
    if total == "0":
        # Rough fallback: unquoted TITLE words (Scopus is case-insensitive)
        loose = re.sub(r"\s+", " ", clean).strip()
        if loose:
            data = _search(f"TITLE({loose})", count=5)
            results = data.get("search-results") or {}
            total = str(results.get("opensearch:totalResults") or "0")
    if total == "0":
        return None, data
    entry = (results.get("entry") or [None])[0]
    if not entry:
        return None, data
    return parse_search_entry(entry), data


def _build_query(
    *,
    title: str | None = None,
    doi: str | None = None,
    author_id: str | None = None,
    exact_title: bool = True,
) -> str:
    parts: list[str] = []
    if doi:
        parts.append(f"DOI({doi})")
    if title:
        clean = clean_title_for_query(title)
        if exact_title:
            parts.append(f'TITLE("{clean}")')
        else:
            loose = re.sub(r"\s+", " ", clean).strip()
            parts.append(f"TITLE({loose})")
    if author_id:
        parts.append(f"AU-ID({author_id})")
    return " AND ".join(parts)


def search_candidates(
    *,
    title: str | None = None,
    doi: str | None = None,
    author_id: str | None = None,
    limit: int = 10,
    sort: str | None = None,
) -> list[dict[str, Any]]:
    """Every Scopus match for the query, not only the first.

    search_by_title returns entry[0], which is right when the caller already
    knows the article. Picking one is a different job: a title alone also matches
    errata, translations, and same-titled work by other groups, and silently
    taking the top hit is how a wrong DOI ends up on a claim.

    With `author_id` alone this becomes "everything on that Scopus profile",
    which is the list a claimant actually recognises their own paper from.
    """
    count = max(1, min(int(limit or 10), 25))
    queries: list[str] = [_build_query(title=title, doi=doi, author_id=author_id)]
    if title:
        # Quoted TITLE misses on punctuation and subtitle differences; the
        # unquoted form is the same fallback search_by_title uses.
        queries.append(
            _build_query(title=title, doi=doi, author_id=author_id, exact_title=False)
        )

    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for query in queries:
        if not query:
            continue
        data = _search(query, count=count, sort=sort)
        entries = ((data.get("search-results") or {}).get("entry")) or []
        if not isinstance(entries, list):
            continue
        for entry in entries:
            # A zero-result Scopus search still returns one entry — an error stub.
            if not isinstance(entry, dict) or entry.get("error"):
                continue
            parsed = parse_search_entry(entry)
            key = str(parsed.get("eid") or parsed.get("doi") or parsed.get("title") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(parsed)
            if len(out) >= count:
                return out
        if out:
            break
    return out


def check_author_linkage(author_id: str, title: str) -> tuple[bool, dict[str, Any]]:
    clean = clean_title_for_query(title)
    data = _search(f'AU-ID({author_id}) AND TITLE("{clean}")')
    results = data.get("search-results") or {}
    total = int(results.get("opensearch:totalResults") or 0)
    return total > 0, data


def lookup_paper_by_doi(doi: str) -> dict[str, Any] | None:
    cleaned = normalize_doi(doi)
    if not cleaned:
        return None
    data = _search(f"DOI({cleaned})")
    entry = ((data.get("search-results") or {}).get("entry") or [None])[0]
    return parse_search_entry(entry) if entry else None


def lookup_serial_by_issn(issn: str) -> dict[str, Any] | None:
    cleaned = normalize_issn(issn)
    if not cleaned:
        return None
    bare = cleaned.replace("-", "")
    try:
        url = f"{SCOPUS_BASE}/serial/title/issn/{bare}?view=STANDARD&field=SJR,SNIP,dc:title,prism:issn"
        data = scopus_fetch(url)
    except ScopusError:
        try:
            data = scopus_fetch(f"{SCOPUS_BASE}/serial/title/issn/{bare}")
        except ScopusError:
            return None
    entry = ((data.get("serial-metadata-response") or {}).get("entry") or [None])[0]
    if not entry:
        return None
    snip_v, snip_y = pick_yearly_metric(entry.get("SNIPList"))
    sjr_v, sjr_y = pick_yearly_metric(entry.get("SJRList"))
    return {
        "snip": snip_v,
        "snip_year": snip_y,
        "sjr": sjr_v,
        "sjr_year": sjr_y,
        "journal_title": entry.get("dc:title"),
        "issn": entry.get("prism:issn") or cleaned,
        "raw": entry,
    }


def extract_author_id(raw: str) -> str | None:
    if not raw or not str(raw).strip():
        return None
    raw_s = str(raw).strip()
    m = re.search(r"authorId[s]*=(\d+)", raw_s, re.I)
    if m:
        return m.group(1)
    return raw_s if raw_s else None


AUTHOR_PROFILE_URL = "https://www.scopus.com/authid/detail.uri?authorId={}"


def author_profile_url(author_id: str | None) -> str | None:
    """The Scopus profile link for an author ID.

    The ERP roster carries IDs but no links, and the claim form asks for the
    link — so derive it rather than making 400 people paste their own.
    """
    if not author_id:
        return None
    aid = str(author_id).strip()
    if aid.endswith(".0") and aid[:-2].isdigit():
        aid = aid[:-2]
    return AUTHOR_PROFILE_URL.format(aid) if aid.isdigit() else None
