"""A metasearch over the scholarly record, and what each result would pay.

This is the SearXNG idea — ask several upstreams at once, merge, dedupe, rank —
pointed at research rather than at the general web. That difference is the
whole point. Scraping Google for "recent work on VLSI floorplanning" returns
blog posts and PDFs on university servers; asking OpenAlex returns the paper,
its DOI, its journal, its ISSN, how many times it has been cited and whether it
is open access. For a portal that pays people to publish, the second is the
only useful answer.

Three sources, all free and none needing a key:

  OpenAlex   250M works, richest metadata, the primary source here.
  Crossref   the DOI registry itself — authoritative on what a DOI *is*.
  arXiv      preprints, which is where "the latest thing" actually appears
             first in engineering and computer science.

None of this needs a model. That matters: the AI features degrade to "switched
off" without a key or credits, and this does not. A faculty member can find
what is being published in their field, and what it would be worth to them,
with no AI involved at all.

The last part is what nothing else can do. Every result is matched against our
own Scimago and SNIP tables, so a search result carries the journal's real
quartile and the amount our own formula would pay for a paper in it. That turns
"here are some papers" into "here is where your next one should go".
"""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Iterable

import httpx
from django.core.cache import cache
from django.utils import timezone

from core.services.normalize import normalize_doi, normalize_title

logger = logging.getLogger(__name__)

#: Both OpenAlex and Crossref run a "polite pool" — identify yourself and you
#: get a faster, more reliable lane. It is free and it is the deal they ask for
#: in exchange for an open API, so we keep it.
CONTACT = "joyalisacerp@gmail.com"
USER_AGENT = f"FacultyPublicationApp/1.0 (mailto:{CONTACT})"

#: Per source. A slow upstream must not sink the whole search — better three
#: results from two sources than a spinner until everything answers.
SOURCE_TIMEOUT = 12.0
CACHE_SECONDS = 60 * 30


class Hit(dict):
    """One work. A plain dict so it serialises straight out of the API."""


def _clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip()


def _year(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# The sources                                                                 #
# --------------------------------------------------------------------------- #


def _openalex(query: str, limit: int) -> list[Hit]:
    with httpx.Client(timeout=SOURCE_TIMEOUT, headers={"User-Agent": USER_AGENT}) as c:
        r = c.get(
            "https://api.openalex.org/works",
            params={
                "search": query,
                "per-page": min(limit, 50),
                "mailto": CONTACT,
                # Retracted work must never be recommended to somebody looking
                # for where to publish or what to build on.
                "filter": "is_retracted:false",
            },
        )
        r.raise_for_status()
        works = r.json().get("results", [])

    out: list[Hit] = []
    for w in works:
        location = w.get("primary_location") or {}
        source = location.get("source") or {}
        out.append(
            Hit(
                source="OpenAlex",
                title=_clean(w.get("title")),
                doi=normalize_doi(w.get("doi") or "") or None,
                year=_year(w.get("publication_year")),
                journal=_clean(source.get("display_name")),
                issn=source.get("issn_l"),
                citations=w.get("cited_by_count") or 0,
                open_access=bool((w.get("open_access") or {}).get("is_oa")),
                type=w.get("type"),
                authors=[
                    _clean((a.get("author") or {}).get("display_name"))
                    for a in (w.get("authorships") or [])[:6]
                ],
                url=w.get("doi") or w.get("id"),
            )
        )
    return out


def _crossref(query: str, limit: int) -> list[Hit]:
    with httpx.Client(timeout=SOURCE_TIMEOUT, headers={"User-Agent": USER_AGENT}) as c:
        r = c.get(
            "https://api.crossref.org/works",
            params={"query": query, "rows": min(limit, 40), "mailto": CONTACT},
        )
        r.raise_for_status()
        items = (r.json().get("message") or {}).get("items", [])

    out: list[Hit] = []
    for w in items:
        issued = ((w.get("issued") or {}).get("date-parts") or [[None]])[0]
        out.append(
            Hit(
                source="Crossref",
                title=_clean((w.get("title") or [""])[0]),
                doi=normalize_doi(w.get("DOI") or "") or None,
                year=_year(issued[0] if issued else None),
                journal=_clean((w.get("container-title") or [""])[0]),
                issn=(w.get("ISSN") or [None])[0],
                citations=w.get("is-referenced-by-count") or 0,
                open_access=False,
                type=w.get("type"),
                authors=[
                    _clean(f"{a.get('given','')} {a.get('family','')}")
                    for a in (w.get("author") or [])[:6]
                ],
                url=w.get("URL"),
            )
        )
    return out


_ARXIV_NS = {"a": "http://www.w3.org/2005/Atom"}


def _arxiv(query: str, limit: int) -> list[Hit]:
    with httpx.Client(
        timeout=SOURCE_TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True
    ) as c:
        r = c.get(
            "https://export.arxiv.org/api/query",
            params={
                "search_query": f"all:{query}",
                "max_results": min(limit, 25),
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            },
        )
        r.raise_for_status()
        root = ET.fromstring(r.text)

    out: list[Hit] = []
    for entry in root.findall("a:entry", _ARXIV_NS):
        published = (entry.findtext("a:published", "", _ARXIV_NS) or "")[:4]
        out.append(
            Hit(
                source="arXiv",
                title=_clean(entry.findtext("a:title", "", _ARXIV_NS)),
                doi=None,
                year=_year(published),
                # A preprint has no journal yet, and saying otherwise would let
                # it be priced as though it did.
                journal="",
                issn=None,
                citations=0,
                open_access=True,
                type="preprint",
                authors=[
                    _clean(a.findtext("a:name", "", _ARXIV_NS))
                    for a in entry.findall("a:author", _ARXIV_NS)[:6]
                ],
                url=entry.findtext("a:id", "", _ARXIV_NS),
            )
        )
    return out


SOURCES = {"openalex": _openalex, "crossref": _crossref, "arxiv": _arxiv}


# --------------------------------------------------------------------------- #
# Merging                                                                     #
# --------------------------------------------------------------------------- #


def _key(hit: Hit) -> str | None:
    """What makes two results the same work.

    The same rule as everywhere else in this system: a DOI where there is one,
    a normalised title where there is not.
    """
    if hit.get("doi"):
        return "doi:" + hit["doi"]
    title = normalize_title(hit.get("title") or "")
    return "title:" + title if title else None


def merge(batches: Iterable[list[Hit]]) -> list[Hit]:
    """One row per work, keeping the richest version of each.

    The same paper comes back from OpenAlex with citations and an ISSN, and
    from Crossref with neither but an authoritative DOI. Taking whichever
    arrived first would throw away half of what we asked three sources for, so
    they are folded together field by field.
    """
    merged: dict[str, Hit] = {}
    for batch in batches:
        for hit in batch:
            key = _key(hit)
            if not key:
                continue
            if key not in merged:
                hit["sources"] = [hit.pop("source")]
                merged[key] = hit
                continue

            kept = merged[key]
            incoming_source = hit.pop("source", None)
            if incoming_source and incoming_source not in kept["sources"]:
                kept["sources"].append(incoming_source)
            for field, value in hit.items():
                if field == "sources":
                    continue
                # Fill gaps and take the larger citation count; never overwrite
                # something real with something empty.
                if field == "citations":
                    kept[field] = max(kept.get(field) or 0, value or 0)
                elif not kept.get(field) and value:
                    kept[field] = value
    return list(merged.values())


def rank(hits: list[Hit], *, this_year: int | None = None) -> list[Hit]:
    """Recent and well cited, with recency weighted for a portal about output.

    Citations accumulate over decades, so ranking on them alone buries
    everything published in the last two years — which is exactly what somebody
    asking "what is happening in my field" wants to see. The log flattens the
    difference between a 400-citation paper and a 4,000-citation one, which is
    not a distinction worth ten places in a list of ten.
    """
    import math

    # Resolved here as well as in `search`, because this is a public function
    # and the whole defect was one caller passing None into arithmetic.
    year = this_year or timezone.now().year

    def score(h: Hit) -> float:
        age = max(0, year - (h.get("year") or year))
        # Age discounts the whole score rather than being one term added to
        # it. Added, the citation term simply wins: log1p(800) is 6.7 against
        # a recency term that can never exceed 3, so a paper from 2005 outran
        # everything published since, which is the exact failure this function
        # is supposed to prevent. Multiplying makes age a discount on standing
        # instead of a competitor to it, so a genuine classic still surfaces
        # while a twenty-year-old paper does not outrank the whole field.
        recency = 1.0 / (1.0 + age * 0.35)
        standing = 1.0 + math.log1p(h.get("citations") or 0)
        confirmed = 0.4 * len(h.get("sources") or [])
        return (standing + confirmed) * recency

    return sorted(hits, key=score, reverse=True)


def enrich_with_our_data(hits: list[Hit], *, author_position: int, total_authors: int) -> None:
    """Attach the quartile, the SNIP and what the policy would pay.

    In place, and only where we can actually identify the journal. This is the
    part no general search engine can do: our own tables know that a particular
    ISSN is Q1 with a SNIP of 3.289, and our own formula knows what that is
    worth to this person at this author position.

    A result we cannot match keeps `journal_known: False` and carries no
    numbers, for the same reason the venue suggestions do — a figure beside a
    journal we have not identified is worse than no figure.
    """
    from core.models import ScimagoJournal
    from core.services.discover import describe_journal, estimate_payout

    for hit in hits:
        hit["journal_known"] = False
        issn = (hit.get("issn") or "").replace("-", "").strip()
        if not issn or not hit.get("journal"):
            continue
        row = (
            ScimagoJournal.objects.filter(year=2025)
            .filter(issn=issn)
            .first()
            or ScimagoJournal.objects.filter(year=2025).filter(eissn=issn).first()
        )
        if not row:
            continue
        described = describe_journal(row)
        hit["journal_known"] = True
        hit["quartile"] = described["quartile"]
        hit["snip"] = described["snip"]
        hit["sjr"] = described["sjr"]
        hit["payout"] = estimate_payout(
            snip=described["snip"],
            quartile=described["quartile"],
            author_position=author_position,
            total_authors=total_authors,
        )


def search(
    query: str,
    *,
    limit: int = 20,
    sources: list[str] | None = None,
    author_position: int = 1,
    total_authors: int = 1,
    this_year: int | None = None,
) -> dict[str, Any]:
    """Ask every source at once, merge what comes back, and price it.

    Sources are queried in parallel and failures are collected rather than
    raised. One upstream being down or slow degrades the result set; it does
    not empty it, and the response says which sources answered so a thin set of
    results is not mistaken for a thin field.
    """
    query = (query or "").strip()
    if len(query) < 3:
        return {"results": [], "asked": [], "failed": [], "query": query}

    # `None` means "today". This was `this_year: int = 2026` -- a literal that
    # silently prices last year's recency curve the moment the calendar turns,
    # and an annotation that said `int` while `thread_agent` passed None. That
    # None reached `rank`, where `this_year - (h.get("year") or this_year)` is
    # None minus an int: every hit raised TypeError, the caller's bare
    # `except Exception` turned it into "I could not reach the scholarly
    # sources", and the thread assistant's web search had never once worked.
    year = this_year or timezone.now().year

    wanted = [s for s in (sources or list(SOURCES)) if s in SOURCES]
    cache_key = f"research:{'|'.join(sorted(wanted))}:{limit}:{query.lower()}"
    cached = cache.get(cache_key)

    if cached is None:
        batches: list[list[Hit]] = []
        failed: list[str] = []
        with ThreadPoolExecutor(max_workers=len(wanted) or 1) as pool:
            futures = {pool.submit(SOURCES[name], query, limit): name for name in wanted}
            for future in as_completed(futures):
                name = futures[future]
                try:
                    batches.append(future.result())
                except Exception:
                    # Logged, not raised. An upstream having a bad day is not
                    # this application having an error.
                    logger.warning("research source failed: %s", name, exc_info=True)
                    failed.append(name)

        results = rank(merge(batches), this_year=year)[:limit]
        cached = {
            "results": results,
            "asked": wanted,
            "failed": failed,
        }
        cache.set(cache_key, cached, CACHE_SECONDS)

    # Pricing is not cached with the results: it depends on the author position
    # being asked about, and it is cheap.
    results = [Hit(dict(r)) for r in cached["results"]]
    enrich_with_our_data(
        results, author_position=author_position, total_authors=total_authors
    )
    return {
        "results": results,
        "asked": cached["asked"],
        "failed": cached["failed"],
        "query": query,
        "assumed": {
            "author_position": author_position,
            "total_authors": total_authors,
            "publication_type": "Journal article, Scopus indexed",
        },
    }
