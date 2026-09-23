"""Finding the paper somebody is about to file.

Three sources, and the reason for three rather than one is that they disagree
in useful ways. Crossref *is* the DOI registry, so it is authoritative on what
a DOI is and on the publisher's own metadata. OpenAlex has citation counts,
open-access status and an ISSN-L that actually resolves against our tables.
Scopus has the EID and the indexing status that the claim form needs and
neither of the others carries -- and it is the one source that needs a key, so
it is also the one that has to disappear gracefully when there is not one.

The same paper comes back from all three, which is the point of merging by DOI:
one row carrying Crossref's authoritative record, OpenAlex's citation count and
Scopus's EID is a better answer than any of the three alone, and it is the
shape the filing form wants.

Every field in `filing_fields()` matches what `/lookup/enrich` produces, so a
search result can be dropped into the claim form without translation. The
verified fields -- quartile, SNIP, subject -- come from our own tables and not
from the source that named the journal, for the reason set out in resolve.py.
"""

from __future__ import annotations

import math
from typing import Any

import httpx
from django.conf import settings

from core.services.normalize import normalize_doi, normalize_issn, normalize_title
from core.services.search import resolve, upstream

OPENALEX_WORKS = "https://api.openalex.org/works"
CROSSREF_WORKS = "https://api.crossref.org/works"

#: Ask each source for more than we show. Merging collapses duplicates, and a
#: page of ten built from ten-per-source would come back short.
FETCH_MULTIPLIER = 2
MAX_PER_SOURCE = 50

#: Only the fields we use. Both APIs honour a projection, and asking for the
#: whole record moves several megabytes for a query that needs a few kilobytes
#: -- which on a slow link is most of the time the search takes.
_OPENALEX_SELECT = ",".join([
    "id", "doi", "title", "publication_year", "publication_date", "type",
    "cited_by_count", "open_access", "authorships", "primary_location", "biblio",
])
_CROSSREF_SELECT = ",".join([
    "DOI", "title", "container-title", "ISSN", "issued", "author", "type",
    "publisher", "volume", "issue", "page", "is-referenced-by-count", "URL",
])


def _clean(text: Any) -> str:
    return " ".join(str(text or "").split())


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Sources. Each is pure HTTP: no database, so it is safe to run in a thread.   #
# --------------------------------------------------------------------------- #


def fetch_openalex(query: str, limit: int) -> list[dict[str, Any]]:
    def produce() -> list[dict[str, Any]]:
        payload = upstream.get_json(
            OPENALEX_WORKS,
            {
                "search": query,
                "per-page": min(limit, MAX_PER_SOURCE),
                "mailto": upstream.contact(),
                # A retracted paper must never be offered to somebody about to
                # file a claim on it.
                "filter": "is_retracted:false",
                "select": _OPENALEX_SELECT,
            },
        )
        return [_from_openalex(w) for w in (payload or {}).get("results") or []]

    return upstream.cached(
        upstream.cache_key("works", "openalex", query.lower(), limit),
        upstream.WORKS_TTL,
        produce,
    )


def _from_openalex(work: dict[str, Any]) -> dict[str, Any]:
    location = work.get("primary_location") or {}
    source = location.get("source") or {}
    biblio = work.get("biblio") or {}
    issn = source.get("issn_l") or (source.get("issn") or [None])[0]
    return {
        "source": "OpenAlex",
        "title": _clean(work.get("title")),
        "doi": normalize_doi(work.get("doi")),
        "journal": _clean(source.get("display_name")),
        "issn": normalize_issn(issn) if issn else None,
        "publication_year": _int(work.get("publication_year")),
        "publication_date": work.get("publication_date"),
        "type": work.get("type"),
        "publisher": _clean(source.get("host_organization_name")),
        "volume": biblio.get("volume"),
        "issue": biblio.get("issue"),
        "pages": biblio.get("first_page"),
        "citations": work.get("cited_by_count") or 0,
        "open_access": bool((work.get("open_access") or {}).get("is_oa")),
        "authors": [
            _clean((a.get("author") or {}).get("display_name"))
            for a in (work.get("authorships") or [])[:12]
        ],
        "author_count": len(work.get("authorships") or []) or None,
        "url": work.get("doi") or work.get("id"),
    }


def fetch_crossref(query: str, limit: int) -> list[dict[str, Any]]:
    def produce() -> list[dict[str, Any]]:
        payload = upstream.get_json(
            CROSSREF_WORKS,
            {
                # `query.bibliographic` is the one meant for "a citation I have
                # in front of me", which is exactly what somebody filing a paper
                # is typing. Plain `query` searches everything including
                # funder names and matches far more loosely.
                "query.bibliographic": query,
                "rows": min(limit, 40),
                "mailto": upstream.contact(),
                "select": _CROSSREF_SELECT,
            },
        )
        items = ((payload or {}).get("message") or {}).get("items") or []
        return [_from_crossref(w) for w in items]

    return upstream.cached(
        upstream.cache_key("works", "crossref", query.lower(), limit),
        upstream.WORKS_TTL,
        produce,
    )


def fetch_crossref_work(doi: str) -> dict[str, Any] | None:
    """One DOI, straight from the registry: /works/{doi}.

    None when Crossref has no such DOI (it answers 404). Anything else going
    wrong raises, as every source here does, for the caller to report.
    """
    doi = normalize_doi(doi)
    if not doi:
        return None

    def produce() -> dict[str, Any] | None:
        try:
            payload = upstream.get_json(
                f"{CROSSREF_WORKS}/{doi}", {"mailto": upstream.contact()}
            )
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                return None
            raise
        work = (payload or {}).get("message")
        return _from_crossref(work) if isinstance(work, dict) else None

    return upstream.cached(
        upstream.cache_key("work", "crossref", doi), upstream.WORKS_TTL, produce
    )


def _from_crossref(work: dict[str, Any]) -> dict[str, Any]:
    parts = ((work.get("issued") or {}).get("date-parts") or [[]])[0] or []
    issn = (work.get("ISSN") or [None])[0]
    return {
        "source": "Crossref",
        "title": _clean((work.get("title") or [""])[0]),
        "doi": normalize_doi(work.get("DOI")),
        "journal": _clean((work.get("container-title") or [""])[0]),
        "issn": normalize_issn(issn) if issn else None,
        "publication_year": _int(parts[0] if parts else None),
        "publication_date": "-".join(f"{p:02d}" if i else str(p)
                                     for i, p in enumerate(parts)) or None,
        "type": work.get("type"),
        "publisher": _clean(work.get("publisher")),
        "volume": work.get("volume"),
        "issue": work.get("issue"),
        "pages": work.get("page"),
        "citations": work.get("is-referenced-by-count") or 0,
        "open_access": False,
        "authors": [
            _clean(f"{a.get('given', '')} {a.get('family', '')}")
            for a in (work.get("author") or [])[:12]
        ],
        "author_count": len(work.get("author") or []) or None,
        "url": work.get("URL"),
    }


def scopus_configured() -> bool:
    key = getattr(settings, "SCOPUS_API_KEY", "") or ""
    return bool(key) and key != "your-scopus-api-key"


def fetch_scopus(query: str, limit: int) -> list[dict[str, Any]]:
    """Scopus, when there is a key. Never called when there is not.

    Not cached alongside the others under a single key on purpose: Scopus is
    rate limited at thirty calls a minute in `scopus.py`, so its cache is the
    thing standing between a busy afternoon and a 429 for everybody.
    """
    from core.services.scopus import search_candidates

    def produce() -> list[dict[str, Any]]:
        return [_from_scopus(e) for e in search_candidates(title=query, limit=min(limit, 25))]

    return upstream.cached(
        upstream.cache_key("works", "scopus", query.lower(), limit),
        upstream.WORKS_TTL,
        produce,
    )


def _from_scopus(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": "Scopus",
        "title": _clean(entry.get("title")),
        "doi": normalize_doi(entry.get("doi")),
        "journal": _clean(entry.get("journal_title")),
        "issn": entry.get("issn"),
        "publication_year": entry.get("publication_year"),
        "publication_date": entry.get("cover_date"),
        "cover_date": entry.get("cover_date"),
        "type": entry.get("aggregation_type"),
        "aggregation_type": entry.get("aggregation_type"),
        "eid": entry.get("eid"),
        "scopus_url": entry.get("scopus_url"),
        "author_count": entry.get("author_count"),
        "citations": 0,
        "open_access": False,
        "authors": [],
        "url": entry.get("scopus_url"),
    }


def tasks(query: str, limit: int) -> dict[str, Any]:
    """Callables for the engine's fan-out, with Scopus omitted when keyless.

    Omitted rather than failing: a missing key is a configuration state, not an
    outage, and reporting it as a failed source would make every search on a
    machine without a Scopus subscription look broken.
    """
    want = limit * FETCH_MULTIPLIER
    chosen = {"crossref": lambda: fetch_crossref(query, want),
              "openalex": lambda: fetch_openalex(query, want)}
    if scopus_configured():
        chosen["scopus"] = lambda: fetch_scopus(query, want)
    return chosen


# --------------------------------------------------------------------------- #
# Merging                                                                     #
# --------------------------------------------------------------------------- #


def _identity(hit: dict[str, Any]) -> str | None:
    """What makes two rows the same paper.

    The DOI, normalised, wherever there is one -- `10.1021/NL200225J`,
    `https://doi.org/10.1021/nl200225j` and `10.1021/nl200225j` are one paper
    described three ways, and `normalize_doi` is what makes them one row.
    Falling back to the normalised title covers the Scopus records that predate
    DOIs; it is a weaker key, so it is only ever the fallback.
    """
    doi = normalize_doi(hit.get("doi"))
    if doi:
        return f"doi:{doi}"
    title = normalize_title(hit.get("title"))
    return f"title:{title}" if title else None


#: Which source wins when two of them disagree about the same field. Crossref
#: is the registry of record for bibliographic metadata; Scopus is the only one
#: that can speak to indexing; OpenAlex is the fallback and the citation count.
_AUTHORITY = {"Crossref": 3, "Scopus": 2, "OpenAlex": 1}


def merge(batches: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    """One row per paper, keeping the best-attested value for every field.

    Blank values never overwrite real ones, and a field already supplied by a
    more authoritative source is not replaced by a less authoritative one --
    otherwise which of three identical papers happened to arrive first would
    decide what publisher name ends up on somebody's claim.
    """
    merged: dict[str, dict[str, Any]] = {}
    provenance: dict[str, dict[str, int]] = {}

    for batch in batches:
        for hit in batch or []:
            key = _identity(hit)
            if not key:
                continue
            source = hit.get("source") or "?"
            rank = _AUTHORITY.get(source, 0)

            if key not in merged:
                row = {k: v for k, v in hit.items() if k != "source"}
                row["sources"] = [source]
                merged[key] = row
                provenance[key] = {k: rank for k, v in row.items() if v not in (None, "", [])}
                continue

            kept = merged[key]
            if source not in kept["sources"]:
                kept["sources"].append(source)
            seen = provenance[key]
            for field, value in hit.items():
                if field == "source" or value in (None, "", []):
                    continue
                if field == "citations":
                    kept[field] = max(kept.get(field) or 0, value or 0)
                    continue
                if kept.get(field) in (None, "", []) or rank > seen.get(field, 0):
                    kept[field] = value
                    seen[field] = rank

    for row in merged.values():
        row["sources"] = sorted(row["sources"], key=lambda s: -_AUTHORITY.get(s, 0))
    return list(merged.values())


def rank(hits: list[dict[str, Any]], *, this_year: int) -> list[dict[str, Any]]:
    """Well attested, well cited, and recent -- in that order of influence.

    Age discounts the whole score rather than competing with it. Added as a
    term, the citation count simply wins: a 2004 paper with four thousand
    citations outranks everything published since, which is not what somebody
    searching for the paper they just wrote wants to see.
    """

    def score(hit: dict[str, Any]) -> float:
        age = max(0, this_year - (hit.get("publication_year") or this_year))
        recency = 1.0 / (1.0 + age * 0.30)
        standing = 1.0 + math.log1p(hit.get("citations") or 0)
        corroborated = 0.5 * len(hit.get("sources") or [])
        return (standing + corroborated) * recency

    return sorted(hits, key=score, reverse=True)


# --------------------------------------------------------------------------- #
# Resolution against our own tables                                           #
# --------------------------------------------------------------------------- #


def filing_fields(hit: dict[str, Any]) -> dict[str, Any]:
    """The result as the claim form consumes it -- the `/lookup/enrich` shape.

    Additive to the contract and safe to ignore, but it is what makes a search
    result droppable straight into the filing form: every key here is one
    `/lookup/enrich` already returns, so the form needs no second mapping.
    """
    return {
        "matched_title": hit.get("title"),
        "doi": hit.get("doi"),
        "issn": hit.get("issn"),
        "eid": hit.get("eid"),
        "journal": hit.get("journal"),
        "cover_date": hit.get("cover_date") or hit.get("publication_date"),
        "publication_year": hit.get("publication_year"),
        "aggregation_type": hit.get("aggregation_type") or hit.get("type"),
        "snip": hit.get("snip"),
        "snip_year": hit.get("snip_year"),
        "quartile": hit.get("quartile"),
        "subject_category": hit.get("subject_category"),
        "scimago_found": hit.get("scimago_found", False),
        "author_count": hit.get("author_count"),
    }


def attach_standing(hits: list[dict[str, Any]]) -> None:
    """Fill in quartile, SNIP and subject from our own tables. In place.

    A journal we cannot identify keeps `scimago_found: False` and carries no
    quartile and no SNIP -- not values dressed up as data, but the same
    explicit "we cannot say" the venue search gives.
    """
    year = resolve.dataset_year()
    for hit in hits:
        row = resolve.resolve_journal(
            issn=hit.get("issn"), title=hit.get("journal"), year=year
        )
        if not row:
            hit.update(
                scimago_found=False, quartile=None, snip=None,
                snip_year=None, subject_category=None,
            )
            continue
        found = resolve.standing(row)
        hit.update(
            scimago_found=True,
            quartile=found["quartile"],
            subject_category=found["subject_category"],
            snip=found["snip"],
            snip_year=found["snip_year"],
            sjr=found["sjr"],
            # The journal as *we* spell it, so it matches the claim record and
            # the Scimago page a reviewer will open.
            journal=found["journal"] or hit.get("journal"),
            issn=found["issn"] or hit.get("issn"),
        )


def public(hit: dict[str, Any], claim: dict[str, Any] | None) -> dict[str, Any]:
    """One paper in the shape the page renders."""
    return {
        "doi": hit.get("doi"),
        "title": hit.get("title"),
        "authors": hit.get("authors") or [],
        "year": hit.get("publication_year"),
        "journal_title": hit.get("journal"),
        "issn": hit.get("issn"),
        "publication_type": hit.get("aggregation_type") or hit.get("type"),
        "cited_by": hit.get("citations") or 0,
        "url": hit.get("url"),
        # Reader-facing names, not ids: "Crossref, OpenAlex" is what belongs on
        # the screen, and mapping ids to names in two codebases is how the two
        # spellings drift apart.
        "found_in": hit.get("sources") or [],
        "claim": claim,
        "filing": filing_fields(hit),
    }


def assemble(
    batches: dict[str, list[dict[str, Any]]],
    *,
    limit: int,
    this_year: int,
    viewer,
) -> list[dict[str, Any]]:
    """Everything after the network: merge, rank, cut, resolve, link.

    Resolution runs only on the rows that survive the cut. It is a database
    round trip per journal, and doing it on a hundred merged rows to show ten
    is most of the query budget spent on results nobody sees.
    """
    from core.services.search.people import claims_by_doi

    hits = rank(merge(list(batches.values())), this_year=this_year)[:limit]
    attach_standing(hits)
    filed = claims_by_doi([h.get("doi") for h in hits if h.get("doi")], viewer=viewer)
    return [public(h, filed.get(normalize_doi(h.get("doi")) or "")) for h in hits]
