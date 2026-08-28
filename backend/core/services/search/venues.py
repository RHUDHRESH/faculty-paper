"""Where to publish, answered out of an index instead of a language model.

The AI venue finder takes ninety-one seconds on this hardware, and almost
everything people ask it is not a question that needs a model. "Q1 journals in
Materials Science", "somewhere that will take a paper on supercapacitors",
"what is the SNIP for Applied Surface Science" -- those are lookups against
32,000 Scimago rows and 32,000 SNIP rows we already hold, and they should
answer in the time it takes to run a query, because they are a query.

So the local tables are the primary source here, not the fallback. OpenAlex
Sources is added on top for the case the local tables cannot serve: a journal
that exists but is not in our Scimago dump, or one whose name somebody half
remembers. What it returns is resolved against our own rows by ISSN before it
is shown with any number on it, and what does not resolve comes back in a
separate `unresolved` list whose type has no field a number could live in.

No money is attached to a venue at all, for anybody. What a paper here would
pay is a different question -- it depends on author position, author count and
the active policy -- and `/discover` already asks it behind the money guard.
A search result carries academic standing only, which is the same thing every
role is entitled to see.
"""

from __future__ import annotations

import re
from typing import Any

from django.db.models import Q

from core.models import ScimagoJournal
from core.services.discover import categories_of
from core.services.normalize import normalize_issn, normalize_title
from core.services.scimago import match_subject_quartile, normalize_category
from core.services.search import resolve, upstream

OPENALEX_SOURCES = "https://api.openalex.org/sources"

#: Words in so many journal titles that matching on them finds everything and
#: therefore nothing. The same list `discover.find_journal` works from.
_STOPWORDS = {
    "journal", "international", "of", "the", "and", "for", "in", "on", "review",
    "research", "science", "sciences", "studies", "advances", "advanced",
    "letters", "transactions", "proceedings", "annals", "reports", "current",
    "open", "applied", "new", "modern",
}

#: How many rows the local search pulls back before filtering in Python.
#: Quartile lives inside a JSON text column, so it cannot be filtered in SQL --
#: the cap is what keeps "Q1 in engineering" from loading the whole table.
CANDIDATE_CAP = 400

_QUARTILE_ORDER = {"Q1": 0, "Q2": 1, "Q3": 2, "Q4": 3}


def _tokens(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(w) > 2]


def _distinctive(text: str) -> list[str]:
    words = _tokens(text)
    rare = [w for w in words if w not in _STOPWORDS]
    return rare or words


# --------------------------------------------------------------------------- #
# Our own tables                                                              #
# --------------------------------------------------------------------------- #


def search_local(
    query: str,
    *,
    field: str | None = None,
    quartile: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Journals from our own Scimago and SNIP rows. No network at all.

    Three ways in, because people ask this three ways: by an ISSN they have in
    front of them, by a journal name they half remember, and by a subject they
    work in. The subject route is the one the AI finder was being used for, and
    it is a `LIKE` against a text column rather than ninety-one seconds of
    inference.

    Filtering and ranking happen on what the candidate rows already carry --
    the categories are in a column we have loaded, so quartile costs nothing --
    and only the survivors are hydrated with a SNIP. Hydrating first meant four
    hundred SNIP lookups to build a list of ten.
    """
    year = resolve.dataset_year()
    scope = ScimagoJournal.objects.filter(year=year)

    exact = resolve.resolve_journal(issn=query, year=year) if _looks_like_issn(query) else None
    candidates = [exact] if exact else list(_candidates(scope, query, field))

    wanted_field = normalize_category(field) if field else None
    wanted_q = (quartile or "").strip().upper() or None

    shortlist: list[tuple[ScimagoJournal, dict[str, Any], float]] = []
    for row in candidates:
        categories = categories_of(row)
        if wanted_field and not _matches_field(categories, wanted_field):
            continue
        matched = (
            match_subject_quartile(categories, field or query)
            if categories
            else {"quartile": None, "category": None}
        )
        # A missing quartile is not Q-anything, so a quartile filter excludes it
        # rather than passing it through as an unranked extra.
        if wanted_q and (matched.get("quartile") or "").upper() != wanted_q:
            continue
        shortlist.append((row, matched, _match_score(row, query, exact=bool(exact))))

    shortlist.sort(
        key=lambda item: (
            _QUARTILE_ORDER.get((item[1].get("quartile") or "").upper(), 9),
            -item[2],
            -(item[0].sjr or 0.0),
        )
    )
    shortlist = shortlist[:limit]

    snips = resolve.snips_for([row for row, _, _ in shortlist])
    return [
        _row(row, matched, match=score, snip=snips.get(row.pk, (None, None)))
        for row, matched, score in shortlist
    ]


def _row(
    row: ScimagoJournal,
    matched: dict[str, Any],
    *,
    match: float,
    snip: tuple[float | None, int | None],
    publisher: str | None = None,
) -> dict[str, Any]:
    """One resolved venue, in the shape the page renders.

    Everything on it is ours: the quartile comes from our Scimago row and the
    SNIP from our SNIP row, matched by ISSN. Nothing an outside source said
    about this journal survives into these fields except, at most, the
    publisher name -- which carries no standing and decides nothing.
    """
    snip_value, _ = snip
    return {
        "title": row.title,
        "issn": normalize_issn(row.issn) or row.issn,
        "quartile": matched.get("quartile"),
        "subject": matched.get("category"),
        "sjr": row.sjr,
        "snip": snip_value,
        "dataset_year": row.year,
        "publisher": publisher,
        "_match": match,
        "_issn": row.issn,
        "_eissn": row.eissn,
    }


def _venue(
    row: ScimagoJournal,
    *,
    subject: str | None,
    match: float,
    publisher: str | None = None,
) -> dict[str, Any]:
    """One venue hydrated on its own -- for the handful OpenAlex adds."""
    categories = categories_of(row)
    matched = (
        match_subject_quartile(categories, subject)
        if categories
        else {"quartile": None, "category": None}
    )
    return _row(
        row, matched, match=match, snip=resolve.find_snip(row), publisher=publisher
    )


def _looks_like_issn(query: str) -> bool:
    bare = re.sub(r"[^0-9Xx]", "", query or "")
    return len(bare) == 8 and len(query.strip()) <= 10


def _candidates(scope, query: str, field: str | None):
    """A small set of plausible rows, narrowed in SQL rather than in Python.

    32,000 rows is too many to scan on every keystroke and too few to justify
    standing up a search index, which is the same trade `discover.find_journal`
    makes. Narrowing on the rarest words in the query is what keeps it cheap.
    """
    seen: set[str] = set()
    out = []

    words = sorted(_distinctive(query), key=len, reverse=True)[:3]
    if words:
        title_q = Q()
        for word in words:
            title_q &= Q(title__icontains=word)
        for row in scope.filter(title_q)[:CANDIDATE_CAP]:
            if row.pk not in seen:
                seen.add(row.pk)
                out.append(row)

    # A subject query names a Scimago category rather than a journal, so it
    # matches nothing on title and everything on categories.
    for needle in [t for t in (field, query) if t and t.strip()]:
        remaining = CANDIDATE_CAP - len(out)
        if remaining <= 0:
            break
        for row in scope.filter(categories_json__icontains=needle.strip())[:remaining]:
            if row.pk not in seen:
                seen.add(row.pk)
                out.append(row)

    return out


def _matches_field(categories: list[dict[str, Any]], wanted: str) -> bool:
    for category in categories:
        name = normalize_category(category.get("category") or "")
        if wanted in name or name in wanted:
            return True
    return False


def _match_score(row: ScimagoJournal, query: str, *, exact: bool) -> float:
    if exact:
        return 1.0
    title = normalize_title(row.title)
    wanted = normalize_title(query)
    if not title or not wanted:
        return 0.0
    if title == wanted:
        return 1.0
    if wanted in title or title in wanted:
        return 0.8
    a, b = set(title.split()), set(wanted.split())
    return len(a & b) / max(len(a), len(b), 1) * 0.6


# --------------------------------------------------------------------------- #
# OpenAlex Sources                                                            #
# --------------------------------------------------------------------------- #


def fetch_openalex_sources(query: str, limit: int) -> list[dict[str, Any]]:
    """Journals OpenAlex knows about. Pure HTTP -- safe to run in a thread.

    Cached for a day: a journal's name, ISSN and publisher are the most static
    facts either API holds, and this is the cache that has to be warm for the
    venue search to feel like an index lookup.
    """

    def produce() -> list[dict[str, Any]]:
        payload = upstream.get_json(
            OPENALEX_SOURCES,
            {
                "search": query,
                "per-page": min(max(limit, 10), 50),
                "mailto": upstream.contact(),
                # Repositories and conference series are not somewhere you
                # submit a journal article, and they carry no quartile.
                "filter": "type:journal",
                "select": "id,display_name,issn_l,issn,host_organization_name,homepage_url,works_count,type",
            },
        )
        out = []
        for source in (payload or {}).get("results") or []:
            issn = source.get("issn_l") or (source.get("issn") or [None])[0]
            out.append(
                {
                    "name": " ".join(str(source.get("display_name") or "").split()),
                    "issn": normalize_issn(issn) if issn else None,
                    "publisher": source.get("host_organization_name"),
                    "homepage": source.get("homepage_url"),
                    "openalex_id": source.get("id"),
                }
            )
        return out

    return upstream.cached(
        upstream.cache_key("sources", "openalex", query.lower(), limit),
        upstream.VENUE_TTL,
        produce,
    )


def tasks(query: str, limit: int) -> dict[str, Any]:
    return {"openalex_sources": lambda: fetch_openalex_sources(query, limit)}


# --------------------------------------------------------------------------- #
# Assembly                                                                    #
# --------------------------------------------------------------------------- #


def assemble(
    external: list[dict[str, Any]] | None,
    *,
    query: str,
    field: str | None = None,
    quartile: str | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    """Local rows first, OpenAlex names resolved against them, then the split.

    The two lists are the design, not the markup. `resolved` is every journal
    we can speak about because we hold a row for it; `unresolved` is every
    journal somebody else named that we cannot. Keeping them apart in the type
    is what stops the second quietly acquiring a number later -- there is no
    field on an unresolved venue to put one in.

    A `quartile: null` on a *resolved* venue is a different statement and is
    allowed: we know the journal, we simply hold no quartile for it.
    """
    year = resolve.dataset_year()
    found = search_local(query, field=field, quartile=quartile, limit=limit)
    seen_issn = {c for r in found for c in (r.get("_issn"), r.get("_eissn")) if c}
    seen_title = {normalize_title(r.get("title")) for r in found}

    unresolved: list[dict[str, Any]] = []
    wanted_q = (quartile or "").strip().upper() or None

    for source in external or []:
        name = source.get("name")
        if not name or normalize_title(name) in seen_title:
            continue
        row = resolve.resolve_journal(issn=source.get("issn"), title=name, year=year)
        if not row:
            unresolved.append(
                {
                    "title": name,
                    "publisher": source.get("publisher") or None,
                    "issn": source.get("issn") or None,
                }
            )
            continue
        if row.issn in seen_issn or row.eissn in seen_issn:
            continue
        record = _venue(row, subject=field or query, match=0.5,
                        publisher=source.get("publisher") or None)
        if wanted_q and (record.get("quartile") or "").upper() != wanted_q:
            continue
        found.append(record)
        seen_issn.update(c for c in (row.issn, row.eissn) if c)
        seen_title.add(normalize_title(row.title))

    found.sort(
        key=lambda r: (
            _QUARTILE_ORDER.get((r.get("quartile") or "").upper(), 9),
            -(r.get("_match") or 0),
            -(r.get("snip") or 0.0),
        )
    )
    return {
        "resolved": [_public(r) for r in found[:limit]],
        "unresolved": unresolved[:limit],
        "dataset_year": year,
    }


#: Fields used for ranking and de-duplication that the reader has no use for.
_INTERNAL = ("_match", "_issn", "_eissn")


def _public(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in _INTERNAL}
