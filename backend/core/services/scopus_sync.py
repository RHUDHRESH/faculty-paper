"""Every member's papers as Scopus lists them, from the Scopus Search API.

For each account with a Scopus author id, page through ``AU-ID(<id>)``
(25 a page) and upsert each paper into the publication record -- matched to
an existing Publication by DOI, then EID, then title -- marking it
Scopus-indexed with Scopus's citation count, and putting the member on it
(`match_method = "scopus"`, 0.97: Scopus itself says the paper is on their
profile). Only the Search API is used; the Author Retrieval API is not
entitled on the college's key.

Throttled to ~2 requests a second. People are taken oldest-sync first and
stamped when done, so a run stopped by the weekly quota (HTTP 429) resumes
where it left off. Idempotent.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, Iterable
from urllib.parse import urlencode

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from core.models import Publication, User
from core.services.normalize import clean_venue, normalize_doi, normalize_issn, normalize_title
from core.services.publications import ensure_user_authorship
from core.services.scopus import SCOPUS_BASE, ScopusError, scopus_fetch
from core.services.scopus_profiles import normalize_scopus_id

logger = logging.getLogger(__name__)

PAGE = 25
MIN_INTERVAL = 0.5
MAX_PAGES = 40  # 1,000 papers: more than anybody here has

Search = Callable[[str, int], dict[str, Any]]

_last = [0.0]


def scopus_search(query: str, start: int) -> dict[str, Any]:
    wait = MIN_INTERVAL - (time.monotonic() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.monotonic()
    params = {"query": query, "count": str(PAGE), "start": str(start)}
    return scopus_fetch(f"{SCOPUS_BASE}/search/scopus?{urlencode(params)}", throttled=True)


def _entries(payload: dict[str, Any]) -> tuple[list[dict], int]:
    res = payload.get("search-results") or {}
    try:
        total = int(res.get("opensearch:totalResults") or 0)
    except (TypeError, ValueError):
        total = 0
    entries = [e for e in (res.get("entry") or []) if isinstance(e, dict) and not e.get("error")]
    return entries, total


def _int(value: Any) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def upsert_entry(entry: dict[str, Any], user: User) -> tuple[Publication, bool]:
    doi = normalize_doi(entry.get("prism:doi"))
    eid = (entry.get("eid") or "").strip() or None
    title = " ".join((entry.get("dc:title") or "").split())
    key = normalize_title(title)[:512]
    cover = entry.get("prism:coverDate") or ""
    year = _int(cover[:4]) if cover else None
    issn_raw = entry.get("prism:issn") or entry.get("prism:eIssn")
    cites = _int(entry.get("citedby-count"))
    with transaction.atomic():
        pub = None
        if doi:
            pub = Publication.objects.filter(doi=doi).first()
        if pub is None and eid:
            pub = Publication.objects.filter(eid=eid).first()
        if pub is None and len(key) > 20:
            pub = Publication.objects.filter(normalized_title=key).first()
        created = pub is None
        if created:
            from datetime import date

            try:
                on = date.fromisoformat(cover[:10]) if cover else None
            except ValueError:
                on = None
            pub = Publication.objects.create(
                doi=doi, eid=eid, title=title, normalized_title=key, year=year, date=on,
                venue=clean_venue(entry.get("prism:publicationName"))[:512],
                issn=(normalize_issn(str(issn_raw)) if issn_raw else "")[:64] or "",
                type=(entry.get("subtypeDescription") or "")[:64],
                citations=cites or 0, source="scopus", scopus_indexed=True, scopus_citations=cites,
            )
        else:
            changed = {"scopus_indexed": True, "scopus_citations": cites}
            if eid and not pub.eid:
                changed["eid"] = eid
            if doi and not pub.doi:
                changed["doi"] = doi
            if not pub.venue:
                v = clean_venue(entry.get("prism:publicationName"))
                if v:
                    changed["venue"] = v[:512]
            Publication.objects.filter(id=pub.id).update(**changed)
        ensure_user_authorship(pub, user, method="scopus", confidence=0.97)
    return pub, created


def sync_user(user: User, *, search: Search = scopus_search) -> dict[str, int]:
    sid = normalize_scopus_id(user.scopus_author_id)
    out = {"total": 0, "seen": 0, "created": 0}
    if not sid:
        return out
    start = 0
    for _ in range(MAX_PAGES):
        entries, total = _entries(search(f"AU-ID({sid})", start))
        out["total"] = total
        for e in entries:
            _, created = upsert_entry(e, user)
            out["seen"] += 1
            out["created"] += created
        start += PAGE
        if not entries or start >= total:
            break
    User.objects.filter(id=user.id).update(scopus_synced_at=timezone.now())
    return out


def sync_scopus_authors(
    *, users: Iterable[User] | None = None, limit: int | None = None, search: Search = scopus_search,
    log: Callable[[str], None] = logger.info,
) -> dict[str, Any]:
    """Sync each member (oldest sync first). Stops cleanly at the quota."""
    if users is None:
        qs = (
            User.objects.filter(active=True).exclude(scopus_author_id__isnull=True).exclude(scopus_author_id="")
            .order_by(F("scopus_synced_at").asc(nulls_first=True), "name")
        )
        users = qs[:limit] if limit else qs
    summary: dict[str, Any] = {"people": 0, "papers_seen": 0, "created": 0, "stopped": None, "per_user": {}}
    for u in users:
        try:
            got = sync_user(u, search=search)
        except ScopusError as exc:
            summary["stopped"] = f"{exc.code}: {exc}"
            log(f"stopped at {u.name}: {exc}")
            break
        summary["people"] += 1
        summary["papers_seen"] += got["seen"]
        summary["created"] += got["created"]
        summary["per_user"][u.name] = got
        log(f"{u.name}: {got}")
    if summary["people"]:
        from core.services.publications import refresh_metrics

        refresh_metrics()
    return summary
