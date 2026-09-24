"""Someone cited you: a daily check of citation counts against OpenAlex.

Once a day (schedule "citation-check", migration 0046) this asks OpenAlex how
often each claimed paper with a DOI has been cited, stores the count and a
row of history whenever it changes, and tells the owners of a paper whose
count rose: "Your paper “X” gained 2 citations — 14 now".

Kept inside OpenAlex's free allowance, and light enough for a 0.1-CPU worker:

- **Batched.** Up to 50 DOIs per request with the OR filter
  ``filter=doi:a|b|c`` (OpenAlex allows 100 values per filter and 100 results
  per page), asking only for ``id,doi,cited_by_count``.
- **Bounded per day.** At most ``CITATION_DOIS_PER_RUN`` DOIs a run, oldest
  check first and never-checked before anything, so a list longer than one
  day's share is covered over several days rather than in one burst.
- **Polite.** Our contact address rides along as ``mailto``; OpenAlex now
  meters by API key instead, and ``OPENALEX_API_KEY`` (free) raises the daily
  allowance tenfold when set. Without one the keyless allowance is still
  about a thousand list requests a day -- twenty times what a thousand DOIs
  need.

The first count for a paper is a baseline and tells nobody; otherwise the
first run would announce every citation a paper had ever had. A fall, a DOI
OpenAlex does not know and an outage tell nobody either; an outage leaves the
batch unchecked so it is asked first tomorrow.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Any, Callable

from django.conf import settings
from django.db.models import F
from django.utils import timezone

from core.models import CitationCount, CitationHistory, Claim, ClaimStatus
from core.services.normalize import normalize_doi
from core.services.notify import notify
from core.services.search import upstream

logger = logging.getLogger(__name__)

OPENALEX_WORKS = "https://api.openalex.org/works"
#: DOIs per request. OpenAlex takes up to 100 values in one OR filter; 50
#: keeps the URL comfortably short when DOIs are long.
BATCH = 50
#: Seconds between requests: well under OpenAlex's per-second limit.
PAUSE = 0.25
#: Statuses whose papers are not watched: unfinished, or not accepted.
_NOT_WATCHED = (ClaimStatus.DRAFT, ClaimStatus.REJECTED)


def _watchable(doi: str | None) -> str | None:
    """A normalised DOI the OR filter can carry, or None.

    A comma or a pipe inside a DOI would split the filter, so such a DOI is
    left out rather than corrupting a whole batch.
    """
    doi = normalize_doi(doi)
    if not doi or not doi.startswith("10.") or "," in doi or "|" in doi:
        return None
    return doi


def watched_papers() -> dict[str, list[Claim]]:
    """Every DOI being watched, with the claims that carry it."""
    out: dict[str, list[Claim]] = defaultdict(list)
    for claim in (
        Claim.objects.exclude(status__in=_NOT_WATCHED)
        .exclude(doi__isnull=True)
        .exclude(doi="")
        .select_related("owner")
        .only("id", "doi", "paper_title", "status", "owner")
    ):
        doi = _watchable(claim.doi)
        if doi:
            out[doi].append(claim)
    return out


def fetch_counts(dois: list[str]) -> dict[str, tuple[int, str | None]]:
    """OpenAlex's cited_by_count for up to 100 DOIs in one request."""
    params: dict[str, Any] = {
        "filter": "doi:" + "|".join(dois),
        "per_page": max(len(dois), 1),
        "select": "id,doi,cited_by_count",
        "mailto": upstream.contact(),
    }
    key = getattr(settings, "OPENALEX_API_KEY", "")
    if key:
        params["api_key"] = key
    payload = upstream.get_json(OPENALEX_WORKS, params, read_timeout=20.0)
    found: dict[str, tuple[int, str | None]] = {}
    for work in (payload or {}).get("results") or []:
        doi = normalize_doi(work.get("doi"))
        count = work.get("cited_by_count")
        if doi and isinstance(count, int):
            found[doi] = (count, work.get("id"))
    return found


def _title_for(claims: list[Claim]) -> str:
    title = next((c.paper_title for c in claims if c.paper_title), "") or "with this DOI"
    title = " ".join(title.split())
    return title if len(title) <= 90 else title[:87].rstrip() + "…"


def _tell_owners(doi: str, claims: list[Claim], gained: int, total: int) -> int:
    noun = "citation" if gained == 1 else "citations"
    title = f"Your paper “{_title_for(claims)}” gained {gained} {noun} — {total} now"
    told = 0
    seen: set[str] = set()
    for claim in claims:
        if claim.owner_id in seen:
            continue
        seen.add(claim.owner_id)
        note = notify(
            claim.owner,
            "citation",
            title,
            f"Counted by OpenAlex for DOI {doi}.",
            f"/papers/{claim.id}",
            claim_id=claim.id,
            email_context={"paper_title": claim.paper_title or "", "action_label": "Open your paper"},
        )
        told += note is not None
    return told


def check_citations(
    *,
    now=None,
    limit: int | None = None,
    pause: float = PAUSE,
    fetch: Callable[[list[str]], dict[str, tuple[int, str | None]]] = fetch_counts,
) -> dict[str, int]:
    """One day's citation check. Returns what it did, for the task log."""
    now = now or timezone.now()
    limit = limit if limit is not None else int(getattr(settings, "CITATION_DOIS_PER_RUN", 1000))
    papers = watched_papers()
    known = set(CitationCount.objects.values_list("doi", flat=True))
    CitationCount.objects.bulk_create(
        [CitationCount(doi=d) for d in papers if d not in known], ignore_conflicts=True
    )
    due = list(
        CitationCount.objects.filter(doi__in=list(papers))
        .order_by(F("checked_at").asc(nulls_first=True), "doi")[: max(limit, 0)]
    )
    summary = {"watched": len(papers), "checked": 0, "baselines": 0, "rose": 0,
               "notified": 0, "failed_batches": 0}

    for start in range(0, len(due), BATCH):
        batch = due[start : start + BATCH]
        if start and pause:
            time.sleep(pause)
        try:
            counts = fetch([row.doi for row in batch])
        except Exception:
            logger.warning("citation batch failed (%d DOIs)", len(batch), exc_info=True)
            summary["failed_batches"] += 1
            continue
        for row in batch:
            summary["checked"] += 1
            row.checked_at = now
            hit = counts.get(row.doi)
            if hit is None:
                row.save(update_fields=["checked_at"])
                continue
            total, openalex_id = hit
            before = row.count
            row.openalex_id = openalex_id or row.openalex_id
            if before != total:
                CitationHistory.objects.create(citation=row, count=total, at=now)
                row.changed_at = now
            row.count = total
            row.save(update_fields=["checked_at", "count", "openalex_id", "changed_at"])
            if before is None:
                summary["baselines"] += 1
            elif total > before:
                summary["rose"] += 1
                summary["notified"] += _tell_owners(row.doi, papers[row.doi], total - before, total)
    logger.info("citation check %s", summary)
    return summary
