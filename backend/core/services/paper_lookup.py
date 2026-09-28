"""Find the paper somebody is filing, from whatever they pasted, with no Scopus key.

Production has no SCOPUS_API_KEY, so the filing form's "pull it from Scopus"
failed there every time and the claimant typed eleven fields by hand. This
answers the same question from sources that need no key:

  OpenAlex   one work by DOI (`works/doi:`) is free and keyless, and it is the
             only source that carries every author's printed affiliation --
             which is how "is the college on this paper?" gets answered.
  Crossref   the DOI registry. The fallback when OpenAlex is down or does not
             know the DOI, and the title search (a title search on OpenAlex
             spends a keyless budget of about a hundred a day; Crossref's is
             free).
  Scopus     only when a key is configured. Never called without one, so a
             deployment without a subscription is a quiet state, not an error.

The journal's standing -- quartile, SNIP, subject areas, and so the
Engineering classification -- comes from our own SCImago and SNIP tables, by
ISSN, never from the source that named the journal (see search/resolve.py for
why). Those tables hold ISSNs in whatever shape a spreadsheet left them:
`20452322.0`, `3906663.0`, `2347470X`. `scimago.issn_variants` asks for every
one of them, because an ISSN that exists in the table and is not found there
is a journal priced without its SNIP.

Only raw upstream payloads are cached (search.upstream.cached). The claimant
match, the affiliation verdict and the journal's standing are worked out fresh
on every request, for the person asking. Nothing here is money: the amount is
the calculator's business, and a head of department may use this freely.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote, unquote, urlencode, urlparse

import httpx
from django.conf import settings
from django.db.models import Q

from core.models import Claim, ClaimStatus, ScimagoJournal, SnipSource
from core.services.discover import categories_of, find_journal
from core.services.normalize import normalize_doi, normalize_issn, normalize_title
from core.services.scimago import (
    engineering_class,
    issn_variants,
    match_subject_quartile,
    scimago_official_search_url,
)
from core.services.search import papers as search_papers
from core.services.search import resolve, sources, upstream

logger = logging.getLogger(__name__)

OPENALEX_WORK = "https://api.openalex.org/works/doi:{doi}"
CROSSREF_WORK = "https://api.crossref.org/works/{doi}"

#: Shorter than the search's ten seconds. A single record either comes back
#: quickly or the claimant is better off typing; the connect timeout (four
#: seconds) is shared with every other outbound call.
READ_TIMEOUT = 6.0
#: Wall clock for the whole lookup. Past this whatever has not answered is
#: abandoned and named, and the form carries on with what did.
BUDGET = 9.0
#: Below this a pasted title matches half the literature.
MIN_TITLE = 12

JOURNAL_DATA = sources.LABELS["journals"]

# --------------------------------------------------------------------------- #
# What was pasted                                                             #
# --------------------------------------------------------------------------- #

_DOI = re.compile(r"10\.\d{4,9}/[^\s\"'<>]+", re.I)
#: Path suffixes publishers put after a DOI in their own links:
#: onlinelibrary.wiley.com/doi/10.1002/x.1/full is the DOI 10.1002/x.1.
_LINK_SUFFIX = re.compile(
    r"/(full|abstract|abs|pdf|epdf|pdfdirect|fulltext|html|meta|references|figures|citedby|summary)/?$",
    re.I,
)
_SCOPUS_EID = re.compile(r"(?:eid=|/publications/)(2-s2\.0-\d+|\d{8,})", re.I)


@dataclass(frozen=True)
class Reference:
    """What somebody pasted, understood.

    kind is one of: doi, url, scopus, url_without_doi, title, too_short, empty.
    """

    kind: str
    doi: str | None = None
    eid: str | None = None
    title: str | None = None


def _find_doi(text: str, *, in_link: bool) -> str | None:
    match = _DOI.search(text)
    if not match:
        return None
    found = match.group(0)
    if in_link:
        # In a link the DOI is a path segment or a query value, so it ends
        # where the path does.
        found = re.split(r"[?#&]", found)[0]
        found = _LINK_SUFFIX.sub("", found)
    found = found.rstrip(".,;:)]}/")
    return normalize_doi(found)


def parse_reference(text: str | None) -> Reference:
    """A DOI, a link carrying one, a Scopus link, or a title -- whichever it is."""
    raw = (text or "").strip()
    if not raw:
        return Reference("empty")
    decoded = unquote(raw)
    is_link = bool(re.match(r"^(https?://|www\.)", decoded, re.I))
    host = ""
    if is_link:
        host = urlparse(decoded if "://" in decoded else f"https://{decoded}").netloc.lower()

    if is_link and host.endswith("scopus.com"):
        eid = _SCOPUS_EID.search(decoded)
        if eid:
            value = eid.group(1)
            return Reference(
                "scopus",
                doi=_find_doi(decoded, in_link=True),
                eid=value if value.startswith("2-s2.0-") else f"2-s2.0-{value}",
            )

    doi = _find_doi(decoded, in_link=is_link)
    if doi:
        return Reference("doi" if not is_link or host.endswith("doi.org") else "url", doi=doi)

    if is_link:
        # Nature's article links carry the DOI's suffix without its prefix.
        nature = re.search(r"nature\.com/articles/([a-z0-9][a-z0-9.\-]+)", decoded, re.I)
        if nature:
            return Reference("url", doi=normalize_doi(f"10.1038/{nature.group(1)}"))
        return Reference("url_without_doi")

    title = " ".join(raw.split())
    if len(title) < MIN_TITLE:
        return Reference("too_short")
    return Reference("title", title=title)


# --------------------------------------------------------------------------- #
# Fetching. Raw payloads only, cached; failures raise for the fan-out.        #
# --------------------------------------------------------------------------- #


def _openalex_params() -> dict[str, str]:
    params = {"mailto": upstream.contact()}
    key = (getattr(settings, "OPENALEX_API_KEY", "") or "").strip()
    if key:
        # Optional. Without one a single work is still free; a key raises the
        # daily budget the title search draws on.
        params["api_key"] = key
    return params


def _get_or_none(url: str, params: dict[str, Any]) -> Any:
    """GET, with a 404 meaning "no such record" rather than a failure."""
    try:
        return upstream.get_json(url, params, read_timeout=READ_TIMEOUT)
    except httpx.HTTPStatusError as exc:
        if exc.response is not None and exc.response.status_code == 404:
            return None
        raise


def fetch_openalex_work(doi: str | None) -> dict[str, Any] | None:
    """One work from OpenAlex by DOI, or None when OpenAlex does not know it."""
    doi = normalize_doi(doi)
    if not doi:
        return None

    def produce() -> dict[str, Any] | None:
        payload = _get_or_none(OPENALEX_WORK.format(doi=quote(doi, safe="/")), _openalex_params())
        return payload if isinstance(payload, dict) else None

    return upstream.cached(upstream.cache_key("lookup", "openalex", doi), upstream.WORKS_TTL, produce)


def fetch_crossref_work(doi: str | None) -> dict[str, Any] | None:
    """The registry's own record for a DOI, or None when it has none."""
    doi = normalize_doi(doi)
    if not doi:
        return None

    def produce() -> dict[str, Any] | None:
        payload = _get_or_none(
            CROSSREF_WORK.format(doi=quote(doi, safe="/")), {"mailto": upstream.contact()}
        )
        message = (payload or {}).get("message") if isinstance(payload, dict) else None
        return message if isinstance(message, dict) else None

    return upstream.cached(upstream.cache_key("lookup", "crossref", doi), upstream.WORKS_TTL, produce)


def search_crossref(title: str, limit: int) -> list[dict[str, Any]]:
    """Crossref's bibliographic search -- free, where OpenAlex's search is metered."""
    return search_papers.fetch_crossref(title, limit)


def search_openalex(title: str, limit: int) -> list[dict[str, Any]]:
    """Only when Crossref is down: every call spends the keyless daily budget."""
    return search_papers.fetch_openalex(title, limit)


def fetch_scopus_record(doi: str) -> dict[str, Any] | None:
    """Scopus's record for a DOI. Only ever called with a key configured."""
    from core.services.scopus import lookup_paper_by_doi

    return lookup_paper_by_doi(doi)


def fetch_scopus_by_eid(eid: str) -> dict[str, Any] | None:
    from core.services.scopus import SCOPUS_BASE, parse_search_entry, scopus_fetch

    data = scopus_fetch(f"{SCOPUS_BASE}/search/scopus?{urlencode({'query': f'EID({eid})', 'count': '1'})}")
    entries = (data.get("search-results") or {}).get("entry") or []
    entry = entries[0] if entries and isinstance(entries[0], dict) and not entries[0].get("error") else None
    return parse_search_entry(entry) if entry else None


# --------------------------------------------------------------------------- #
# Normalising each source into one record shape                                #
# --------------------------------------------------------------------------- #

#: (label a person reads, the form's publication type). None where the type
#: depends on the venue or is not known.
_OPENALEX_TYPES: dict[str, tuple[str, str] | None] = {
    "article": None,
    "review": ("Review article", "Journal"),
    "book-chapter": ("Book chapter", "Book Series"),
    "book": ("Book", "Book Series"),
    "erratum": ("Erratum", "Other"),
    "retraction": ("Retraction notice", "Other"),
    "editorial": ("Editorial", "Other"),
    "letter": ("Letter", "Other"),
    "paratext": ("Front matter", "Other"),
    "preprint": ("Preprint", "Other"),
    "dissertation": ("Thesis", "Other"),
    "dataset": ("Dataset", "Other"),
    "report": ("Report", "Other"),
    "peer-review": ("Peer review", "Other"),
}
_VENUE_TYPES = {
    "journal": ("Journal article", "Journal"),
    "conference": ("Conference paper", "Conference Proceeding"),
    "book series": ("Book series chapter", "Book Series"),
    "ebook platform": ("Book chapter", "Book Series"),
}
_CROSSREF_TYPES = {
    "journal-article": ("Journal article", "Journal"),
    "proceedings-article": ("Conference paper", "Conference Proceeding"),
    "book-chapter": ("Book chapter", "Book Series"),
    "book-part": ("Book chapter", "Book Series"),
    "book": ("Book", "Book Series"),
    "monograph": ("Book", "Book Series"),
    "edited-book": ("Book", "Book Series"),
    "posted-content": ("Preprint", "Other"),
    "dissertation": ("Thesis", "Other"),
    "report": ("Report", "Other"),
    "peer-review": ("Peer review", "Other"),
}
_SCOPUS_TYPES = {
    "Journal": ("Journal article", "Journal"),
    "Trade Journal": ("Journal article", "Journal"),
    "Conference Proceeding": ("Conference paper", "Conference Proceeding"),
    "Book Series": ("Book series chapter", "Book Series"),
    "Book": ("Book chapter", "Book Series"),
}
#: Types that are not the research article itself: a DOI for one of these
#: is almost always a mistaken paste.
_NOT_THE_PAPER = {"Erratum", "Retraction notice", "Editorial", "Letter", "Front matter",
                  "Preprint", "Peer review", "Dataset"}

_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
           "September", "October", "November", "December"]


def _clean(text: Any) -> str:
    text = re.sub(r"<[^>]+>", "", str(text or ""))
    return " ".join(text.split())


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _orcid(value: Any) -> str | None:
    match = re.search(r"\d{4}-\d{4}-\d{4}-\d{3}[\dX]", str(value or ""), re.I)
    return match.group(0).upper() if match else None


def _issn_list(values: list[Any]) -> list[str]:
    out: list[str] = []
    for value in values:
        cleaned = normalize_issn(str(value)) if value else None
        if cleaned and len(cleaned) == 9 and cleaned not in out:
            out.append(cleaned)
    return out


def _date_parts(parts: list[Any]) -> tuple[str | None, str | None, int | None]:
    """(date, precision, year) from [2026, 5, 20] / [2026, 5] / [2026]."""
    parts = [p for p in (parts or []) if _int(p)]
    if not parts:
        return None, None, None
    year = _int(parts[0])
    if len(parts) >= 3:
        return f"{year:04d}-{_int(parts[1]):02d}-{_int(parts[2]):02d}", "day", year
    if len(parts) == 2:
        return f"{year:04d}-{_int(parts[1]):02d}", "month", year
    return f"{year:04d}", "year", year


def _iso_date(value: Any) -> tuple[str | None, str | None, int | None]:
    text = str(value or "").strip()
    match = re.match(r"^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?", text)
    if not match:
        return None, None, None
    return _date_parts([int(g) for g in match.groups() if g])


def _pages(first: Any, last: Any) -> str | None:
    first, last = _clean(first), _clean(last)
    if first and last and first != last:
        return f"{first}–{last}"
    return first or None


def from_openalex(work: dict[str, Any]) -> dict[str, Any]:
    location = work.get("primary_location") or {}
    source = location.get("source") or {}
    biblio = work.get("biblio") or {}
    oa = work.get("open_access") or {}
    best = work.get("best_oa_location") or {}
    date, precision, year = _iso_date(work.get("publication_date"))

    work_type = (work.get("type") or "").lower()
    kind = _OPENALEX_TYPES.get(work_type)
    if kind is None and work_type in ("article", ""):
        kind = _VENUE_TYPES.get((source.get("type") or "").lower())
    authors = []
    for i, a in enumerate(work.get("authorships") or [], start=1):
        person = a.get("author") or {}
        authors.append({
            "position": i,
            "name": _clean(person.get("display_name") or a.get("raw_author_name")),
            "orcid": _orcid(person.get("orcid")),
            "affiliations": [_clean(s) for s in a.get("raw_affiliation_strings") or [] if _clean(s)],
            "institutions": [
                _clean(inst.get("display_name")) for inst in a.get("institutions") or []
                if _clean(inst.get("display_name"))
            ],
            "corresponding": bool(a.get("is_corresponding")),
        })
    return {
        "title": _clean(work.get("title") or work.get("display_name")) or None,
        "doi": normalize_doi(work.get("doi")),
        "journal": _clean(source.get("display_name")) or None,
        "issns": _issn_list([source.get("issn_l"), *(source.get("issn") or [])]),
        "publication_date": date,
        "publication_date_precision": precision,
        "publication_year": _int(work.get("publication_year")) or year,
        "document_type": kind[0] if kind else None,
        "publication_type": kind[1] if kind else None,
        "publisher": _clean(source.get("host_organization_name")) or None,
        "volume": _clean(biblio.get("volume")) or None,
        "issue": _clean(biblio.get("issue")) or None,
        "pages": _pages(biblio.get("first_page"), biblio.get("last_page")),
        "citations": _int(work.get("cited_by_count")) or 0,
        "open_access_url": (best.get("pdf_url") or best.get("landing_page_url") or oa.get("oa_url"))
        if oa.get("is_oa") else None,
        "is_retracted": bool(work.get("is_retracted")),
        "authors": authors,
    }


def from_crossref(message: dict[str, Any]) -> dict[str, Any]:
    date, precision, year = None, None, None
    for key in ("issued", "published-online", "published-print", "published"):
        date, precision, year = _date_parts(((message.get(key) or {}).get("date-parts") or [[]])[0])
        if date:
            break
    kind = _CROSSREF_TYPES.get((message.get("type") or "").lower())
    issns = _issn_list([*(message.get("ISSN") or []),
                        *[i.get("value") for i in message.get("issn-type") or [] if isinstance(i, dict)]])
    authors = []
    for i, a in enumerate(message.get("author") or [], start=1):
        name = a.get("name") or f"{a.get('given', '')} {a.get('family', '')}"
        authors.append({
            "position": i,
            "name": _clean(name),
            "orcid": _orcid(a.get("ORCID")),
            "affiliations": [
                _clean(aff.get("name")) for aff in a.get("affiliation") or []
                if isinstance(aff, dict) and _clean(aff.get("name"))
            ],
            "institutions": [],
            "corresponding": False,
        })
    title = message.get("title") or []
    return {
        "title": _clean(title[0] if isinstance(title, list) and title else title) or None,
        "doi": normalize_doi(message.get("DOI")),
        "journal": _clean((message.get("container-title") or [""])[0]) or None,
        "issns": issns,
        "publication_date": date,
        "publication_date_precision": precision,
        "publication_year": year,
        "document_type": kind[0] if kind else None,
        "publication_type": kind[1] if kind else None,
        "publisher": _clean(message.get("publisher")) or None,
        "volume": _clean(message.get("volume")) or None,
        "issue": _clean(message.get("issue")) or None,
        "pages": _clean(message.get("page")) or None,
        "citations": _int(message.get("is-referenced-by-count")) or 0,
        "open_access_url": None,
        "is_retracted": False,
        "authors": authors,
    }


def from_scopus(entry: dict[str, Any]) -> dict[str, Any]:
    date, precision, year = _iso_date(entry.get("cover_date"))
    kind = _SCOPUS_TYPES.get(entry.get("aggregation_type") or "")
    raw = entry.get("raw") or {}
    # Only the COMPLETE view lists authors; STANDARD names the first. Used
    # for the Scopus author ID when it is there, never required.
    authors = []
    for a in raw.get("author") or [] if isinstance(raw, dict) else []:
        seq = _int(a.get("@seq"))
        if seq:
            authors.append({"position": seq, "name": _clean(a.get("authname")),
                            "scopus_id": str(a.get("authid") or "") or None})
    return {
        "title": _clean(entry.get("title")) or None,
        "doi": normalize_doi(entry.get("doi")),
        "journal": _clean(entry.get("journal_title")) or None,
        "issns": _issn_list([entry.get("issn")]),
        "publication_date": date,
        "publication_date_precision": precision,
        "publication_year": _int(entry.get("publication_year")) or year,
        "document_type": kind[0] if kind else None,
        "publication_type": kind[1] if kind else None,
        "eid": entry.get("eid"),
        "scopus_url": entry.get("scopus_url"),
        "author_count": _int(entry.get("author_count")),
        "scopus_authors": authors,
    }


def _blank(value: Any) -> bool:
    return value is None or value == "" or value == []


def merge(records: list[tuple[str, dict[str, Any]]]) -> tuple[dict[str, Any], dict[str, str]]:
    """One record from several, in the order given, with where each field came from.

    `records` is in precedence order. The index the policy is judged against
    (Scopus) comes first when it answered, so its date and type are the ones
    the claimant is shown; then OpenAlex; then the registry. ISSNs are the
    union of all of them, and the citation count is the largest, because a
    lower count is only ever a staler one.
    """
    merged: dict[str, Any] = {}
    origin: dict[str, str] = {}
    issns: list[str] = []
    for label, record in records:
        for field, value in record.items():
            if field in ("issns", "authors", "scopus_authors", "citations") or _blank(value):
                continue
            if field not in merged:
                merged[field] = value
                origin[field] = label
        for issn in record.get("issns") or []:
            if issn not in issns:
                issns.append(issn)
        if record.get("citations"):
            merged["citations"] = max(merged.get("citations") or 0, record["citations"])
    merged["issns"] = issns
    merged.setdefault("citations", 0)
    if issns:
        origin["issn"] = next(label for label, r in records if r.get("issns"))

    # Authors from whichever source carries affiliations: OpenAlex, then the
    # registry. A gap in one is filled from the other when both list the same
    # number of people, which is how a Crossref affiliation reaches an author
    # OpenAlex could not place.
    lists = [(label, r.get("authors") or []) for label, r in records if r.get("authors")]
    order = {"OpenAlex": 0, "Crossref": 1}
    lists.sort(key=lambda item: order.get(item[0], 9))
    authors: list[dict[str, Any]] = []
    if lists:
        origin["authors"] = lists[0][0]
        authors = [dict(a) for a in lists[0][1]]
        for _, other in lists[1:]:
            if len(other) != len(authors):
                continue
            for mine, theirs in zip(authors, other, strict=True):
                if not mine.get("affiliations") and theirs.get("affiliations"):
                    mine["affiliations"] = list(theirs["affiliations"])
                if not mine.get("orcid") and theirs.get("orcid"):
                    mine["orcid"] = theirs["orcid"]
    for _, record in records:
        for scopus_author in record.get("scopus_authors") or []:
            pos = scopus_author.get("position")
            if pos and pos <= len(authors) and scopus_author.get("scopus_id"):
                authors[pos - 1]["scopus_id"] = scopus_author["scopus_id"]
    merged["authors"] = authors
    counts = [len(authors)] + [r.get("author_count") or 0 for _, r in records]
    merged["total_authors"] = max(counts) or None
    return merged, origin


# --------------------------------------------------------------------------- #
# Which author is the claimant                                                #
# --------------------------------------------------------------------------- #

_HONORIFICS = {"dr", "mr", "mrs", "ms", "miss", "prof", "professor", "er", "smt", "shri", "sri",
               "thiru", "tmt", "sir"}


def _ascii(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def _name_parts(name: str | None) -> tuple[list[str], set[str]]:
    """(whole words, initials). "Dr. R N Kavitha" -> (["kavitha"], {"r", "n"})."""
    tokens = [t for t in re.findall(r"[a-z]+", _ascii(name or "")) if t not in _HONORIFICS]
    words = [t for t in tokens if len(t) >= 3]
    initials = {ch for t in tokens if len(t) <= 2 for ch in t}
    return words, initials


def _joined(words: list[str]) -> dict[str, tuple[str, ...]]:
    """Every word and every adjacent pair run together: "uma devi" -> umadevi."""
    out = {w: (w,) for w in words}
    for a, b in zip(words, words[1:], strict=False):
        out.setdefault(a + b, (a, b))
    return out


def _name_match(person: str, author: str) -> tuple[int, bool] | None:
    """(shared words, initials agree exactly), or None when these are two people.

    Loose on purpose, and in one direction only. A dropped initial is still
    the same person ("Rakesh Kumar M" is "Rakesh Kumar"); a shorter name is not
    a prefix ("Kavi" is not "Kavitha"); two different initials in front of the
    same name are two people ("P. Senthil Kumar" is not "K. Senthil Kumar").
    """
    p_words, p_init = _name_parts(person)
    a_words, a_init = _name_parts(author)
    if not p_words or not a_words:
        return None
    p_join, a_join = _joined(p_words), _joined(a_words)
    shared = set(p_join) & set(a_join)
    if not shared:
        return None
    p_used = {w for key in shared for w in p_join[key]}
    a_used = {w for key in shared for w in a_join[key]}
    # What is left on each side has to be explainable as initials.
    p_sig = p_init | {w[0] for w in p_words if w not in p_used}
    a_sig = a_init | {w[0] for w in a_words if w not in a_used}
    if p_sig and a_sig and not (p_sig & a_sig):
        return None
    return len(shared), p_sig == a_sig


def match_claimant(
    authors: list[dict[str, Any]],
    *,
    name: str | None,
    scopus_author_id: str | None = None,
) -> dict[str, Any]:
    """Where the claimant sits in the author list, and how sure that is.

    `confidence` is exact (a Scopus ID, or the name with the same initials),
    likely (the name, with an initial missing or expanded), ambiguous (two
    authors fit equally well -- not guessed between) or none.
    """
    out = {"position": None, "name_on_paper": None, "confidence": "none",
           "matched_on": None, "candidates": []}
    wanted_id = str(scopus_author_id or "").strip()
    if wanted_id.endswith(".0"):
        wanted_id = wanted_id[:-2]
    if wanted_id:
        for a in authors:
            if str(a.get("scopus_id") or "") == wanted_id:
                return {**out, "position": a["position"], "name_on_paper": a.get("name"),
                        "confidence": "exact", "matched_on": "scopus_id",
                        "candidates": [a["position"]]}

    scored = []
    for a in authors:
        result = _name_match(name or "", a.get("name") or "")
        if result:
            scored.append((result, a))
    if not scored:
        return out
    best = max(s for s, _ in scored)
    top = [a for s, a in scored if s == best]
    if len(top) > 1:
        return {**out, "confidence": "ambiguous", "matched_on": "name",
                "candidates": [a["position"] for a in top]}
    chosen = top[0]
    return {**out, "position": chosen["position"], "name_on_paper": chosen.get("name"),
            "confidence": "exact" if best[1] else "likely", "matched_on": "name",
            "candidates": [chosen["position"]]}


# --------------------------------------------------------------------------- #
# Whether the college is on the paper                                          #
# --------------------------------------------------------------------------- #

#: Words in a college's name that say nothing about which college it is --
#: the same list the file check uses (content_check.py).
_GENERIC_NAME_WORDS = {
    "college", "engineering", "university", "institute", "institution", "technology",
    "technological", "school", "science", "sciences", "of", "and", "the", "for", "arts",
    "deemed", "be", "to",
}


def _words(text: str) -> str:
    return f" {' '.join(re.findall(r'[a-z0-9]+', _ascii(text)))} "


def _verdict(texts: list[str], full: str, distinctive: list[str]) -> str | None:
    if not texts:
        return None
    joined = " ".join(_words(t) for t in texts)
    if full in joined:
        return "yes"
    if distinctive and all(f" {w} " in joined for w in distinctive):
        return "other"
    return "no"


def author_verdicts(authors: list[dict[str, Any]], college_name: str) -> dict[int, str | None]:
    """Per author: yes, other, no -- or None when their affiliation was not given."""
    full = _words(college_name)
    distinctive = [w for w in full.split() if w not in _GENERIC_NAME_WORDS]
    return {a["position"]: _verdict(a.get("affiliations") or [], full, distinctive) for a in authors}


def college_affiliation(
    authors: list[dict[str, Any]],
    *,
    college_name: str,
    claimant_position: int | None,
) -> dict[str, Any]:
    """Is the college printed on the paper, and beside the claimant's name?

    From the printed affiliation strings only. OpenAlex's institution entities
    are not good enough for this: it files Saveetha Engineering College under
    "Saveetha University", a different body -- and a paper that names the
    wrong one of the two is exactly what the research cell sends back.

    status is yes, other (a differently named institution sharing the college's
    distinctive word), no, or unknown (the source carried no affiliations).
    """
    distinctive = [w for w in _words(college_name).split() if w not in _GENERIC_NAME_WORDS]
    per_author = author_verdicts(authors, college_name)
    other_text = next(
        (
            s
            for a in authors
            if per_author.get(a["position"]) == "other"
            for s in a.get("affiliations") or []
            if all(f" {w} " in _words(s) for w in distinctive)
        ),
        None,
    )
    verdicts = [v for v in per_author.values() if v]
    if "yes" in verdicts:
        status = "yes"
    elif "other" in verdicts:
        status = "other"
    elif verdicts:
        status = "no"
    else:
        status = "unknown"
    claimant_status = per_author.get(claimant_position) if claimant_position else None
    return {
        "status": status,
        "claimant_status": claimant_status or ("unknown" if claimant_position else None),
        "positions": sorted(p for p, v in per_author.items() if v == "yes"),
        "text": other_text,
    }


# --------------------------------------------------------------------------- #
# The journal's standing, from our own tables                                 #
# --------------------------------------------------------------------------- #


def _shapes(issns: list[str | None]) -> list[str]:
    """Every stored spelling of every ISSN given (`scimago.issn_variants`)."""
    out: list[str] = []
    for issn in issns:
        out.extend(s for s in issn_variants(issn) if s not in out)
    return out


def journal_metrics(
    *,
    issns: list[str],
    journal: str | None,
    publication_type: str | None,
) -> dict[str, Any]:
    """Quartile, SNIP, subject areas and the Engineering class, or an honest miss."""
    shapes = _shapes(list(issns or []))
    row = None
    matched_by = None
    if shapes:
        row = (
            ScimagoJournal.objects.filter(Q(issn__in=shapes) | Q(eissn__in=shapes))
            .order_by("-year")
            .first()
        )
        matched_by = "issn" if row else None
    if row is None and journal:
        row = find_journal(journal, year=resolve.dataset_year())
        matched_by = "title" if row else None

    snip_shapes = shapes + _shapes([row.issn, row.eissn] if row else [])
    snip_row = None
    if snip_shapes:
        snip_row = (
            SnipSource.objects.filter(Q(print_issn__in=snip_shapes) | Q(e_issn__in=snip_shapes))
            .exclude(snip__isnull=True)
            .order_by("-year")
            .first()
        )

    categories = categories_of(row) if row else []
    best = match_subject_quartile(categories, None) if categories else {"quartile": None, "category": None}
    subjects = "; ".join(
        f"{c.get('category')} ({c.get('quartile')})" if c.get("quartile") else str(c.get("category") or "")
        for c in categories
    )
    row_issn = normalize_issn(row.issn) if row and row.issn else None
    return {
        "found": bool(row or snip_row),
        "journal": row.title if row else (snip_row.title if snip_row else None),
        "issn": row_issn if row_issn and len(row_issn) == 9 else None,
        "matched_by": matched_by or ("issn" if snip_row else None),
        "quartile": best.get("quartile"),
        "category": best.get("category"),
        "categories": categories,
        "sjr": row.sjr if row else None,
        "dataset_year": row.year if row else None,
        "snip": snip_row.snip if snip_row else None,
        "snip_year": snip_row.year if snip_row else None,
        "engineering_class": engineering_class(publication_type, subjects) if categories else None,
        "scimago_url": scimago_official_search_url(
            issn=row_issn or (issns[0] if issns else None), title=journal
        ),
    }


# --------------------------------------------------------------------------- #
# The lookup                                                                  #
# --------------------------------------------------------------------------- #


def _source_entry(source_id: str, *, found: bool | None, error: BaseException | None,
                  abandoned: bool, budget: float) -> dict[str, Any]:
    label = sources.LABELS.get(source_id, source_id)
    if abandoned:
        return sources.timed_out(source_id, budget)
    if error is not None:
        code, detail = sources.classify(error, label)
        return sources.failed(source_id, code, detail)
    entry = sources.ok(source_id, 1 if found else 0)
    if not found:
        entry["detail"] = f"{label} has no record of this DOI."
    return entry


def _a(noun: str) -> str:
    return f"an {noun}" if noun[:1].lower() in "aeiou" else f"a {noun}"


def _to_check(
    *,
    paper: dict[str, Any],
    claimant: dict[str, Any],
    affiliation: dict[str, Any],
    metrics: dict[str, Any],
    college_name: str,
    scopus_answered: bool,
    authors_from: str | None,
) -> list[dict[str, str]]:
    """What the claimant still has to look at, one plain sentence each."""
    out: list[dict[str, str]] = []
    authors = paper.get("authors") or []

    if not authors:
        out.append({"key": "position", "text": "The source did not list the authors. Enter how many "
                    "there are and where you come in the list."})
    elif claimant["confidence"] == "likely":
        out.append({"key": "position", "text": f"We matched you to author {claimant['position']}, "
                    f"“{claimant['name_on_paper']}”, by name. Check that is you."})
    elif claimant["confidence"] == "ambiguous":
        places = " and ".join(str(p) for p in claimant["candidates"])
        out.append({"key": "position", "text": f"Authors {places} could both be you. Pick your position."})
    elif claimant["confidence"] == "none":
        out.append({"key": "position", "text": f"We could not find your name among the {len(authors)} "
                    "authors. Pick your position in the list."})

    status = affiliation["status"]
    if status == "other":
        out.append({"key": "affiliation", "text": f"The paper names “{affiliation['text']}”, not "
                    f"{college_name}. The research cell sends these back."})
    elif status == "no":
        out.append({"key": "affiliation", "text": f"None of the printed affiliations name {college_name}."})
    elif status == "unknown" and authors:
        out.append({"key": "affiliation", "text": f"{authors_from or 'The source'} did not include "
                    f"affiliations. Check that {college_name} is printed on the paper."})
    elif status == "yes" and affiliation.get("claimant_status") == "no":
        out.append({"key": "affiliation", "text": f"{college_name} is on the paper, but not beside your name."})

    precision = paper.get("publication_date_precision")
    date = paper.get("publication_date") or ""
    if precision in ("month", "year"):
        known = (f"{_MONTHS[int(date[5:7]) - 1]} {date[:4]}" if precision == "month" else date[:4])
        out.append({"key": "date", "text": f"The source gives only {known}. Enter the exact "
                    "publication date from the paper."})
    elif not scopus_answered and precision == "day" and date[5:7] in ("01", "12"):
        out.append({"key": "date", "text": "Check the year. This is the date it appeared online, and "
                    "near the turn of a year Scopus often carries the print issue's year instead."})

    if not paper.get("publication_type"):
        out.append({"key": "type", "text": "Choose the type of publication — the source did not say."})

    is_journal = paper.get("publication_type") in (None, "Journal")
    journal = paper.get("journal") or ("This journal" if is_journal else "This proceedings volume")
    if not metrics["found"] and not is_journal:
        # The quartile incentive is a journal's; a proceedings volume or a
        # book series is priced on its SNIP, when Scopus gives it one.
        out.append({"key": "metrics", "text": f"{journal} has no SNIP in our tables. Conference papers and "
                    "book chapters are paid without a quartile; enter a SNIP only if Scopus shows one."})
    elif not metrics["found"]:
        out.append({"key": "metrics", "text": f"{journal} is not in our SCImago or SNIP tables. Enter "
                    "the quartile and SNIP from the journal's Scopus page."})
    else:
        if metrics["matched_by"] == "title":
            out.append({"key": "metrics", "text": f"Matched to “{metrics['journal']}” by name, not by "
                        "ISSN. Check it is the same journal."})
        if metrics["snip"] is None:
            out.append({"key": "snip", "text": "We hold a quartile but no SNIP for this journal. Enter "
                        "the SNIP from its Scopus page."})
        elif metrics["quartile"] is None:
            out.append({"key": "quartile", "text": "We hold a SNIP but no quartile for this journal. "
                        "Enter the quartile from SCImago."})
    return out


def _warnings(paper: dict[str, Any], records: list[tuple[str, dict[str, Any]]]) -> list[str]:
    out: list[str] = []
    if paper.get("is_retracted"):
        out.append("OpenAlex marks this paper as retracted. A retracted paper cannot be claimed; "
                   "if that is wrong, say so in a note when you file.")
    kinds = [r.get("document_type") for _, r in records if r.get("document_type")]
    odd = next((k for k in kinds if k in _NOT_THE_PAPER), None)
    if odd:
        out.append(f"This DOI is {_a(odd.lower())}, not the research article. Check you pasted the "
                   "DOI of the paper itself.")
    return out


def _already_filed(claimant, doi: str | None, exclude_claim_id: str | None) -> dict[str, Any] | None:
    if not doi or claimant is None:
        return None
    qs = Claim.objects.filter(owner=claimant, doi__iexact=doi).exclude(status=ClaimStatus.REJECTED)
    if exclude_claim_id:
        qs = qs.exclude(pk=exclude_claim_id)
    found = qs.order_by("-created_at").only("id", "ticket_number", "status").first()
    if not found:
        return None
    # No status: a faculty member is not told which desk holds their paper.
    return {"id": found.id, "ticket_number": found.ticket_number,
            "is_draft": found.status == ClaimStatus.DRAFT}


def _answer(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {
        "ok": False, "code": code, "message": message, "paper": None, "claimant": None,
        "affiliation": None, "metrics": None, "field_sources": {}, "sources": [],
        "scopus_status": "ok" if search_papers.scopus_configured() else "not_configured",
        "warnings": [], "to_check": [], "already_filed": None, "candidates": [], **extra,
    }


def error_answer() -> dict[str, Any]:
    """What the endpoint says when something here is simply broken."""
    return _answer("error", "Something went wrong looking that up. Enter the details by hand — "
                   "nothing you typed has been lost.")


def _by_title(title: str) -> tuple[str | None, dict[str, Any] | None]:
    """(the DOI to look up, or None) and the answer to give instead of looking."""
    try:
        hits = search_crossref(title, 5)
    except Exception as crossref_error:  # noqa: BLE001 -- reported as a sentence
        logger.warning("paper_lookup_title_crossref_failed", exc_info=True)
        try:
            hits = search_openalex(title, 5)
        except Exception:  # noqa: BLE001
            logger.warning("paper_lookup_title_openalex_failed", exc_info=True)
            _, detail = sources.classify(crossref_error, "Crossref")
            return None, _answer("unreachable", f"{detail} Search again shortly, paste the DOI, or "
                                 "enter the details by hand.")
    wanted = normalize_title(title)
    exact = [h for h in hits if normalize_title(h.get("title")) == wanted and h.get("doi")]
    if len(exact) == 1:
        return exact[0]["doi"], None
    if not hits:
        return None, _answer("not_found", "Nothing matched that title. Paste the DOI instead — it is "
                             "printed on the first page of the paper and starts with 10.")
    candidates = [
        {"doi": normalize_doi(h.get("doi")), "title": h.get("title"), "journal": h.get("journal"),
         "year": h.get("publication_year"), "authors": (h.get("authors") or [])[:3],
         "author_count": h.get("author_count")}
        for h in hits[:5]
    ]
    message = ("Several records carry that exact title — an erratum or a translation does too. "
               "Pick yours." if len(exact) > 1 else "No record has exactly that title. Pick yours if it is "
               "here, or paste the DOI.")
    return None, _answer("choose", message, candidates=candidates)


def lookup(
    text: str,
    *,
    claimant,
    college_name: str,
    exclude_claim_id: str | None = None,
) -> dict[str, Any]:
    """Everything the filing form can fill from what was pasted, and what it cannot."""
    ref = parse_reference(text)
    scopus_on = search_papers.scopus_configured()

    if ref.kind == "empty":
        return _answer("bad_input", "Paste the paper's DOI, a link to it, or its title.")
    if ref.kind == "too_short":
        return _answer("bad_input", "That is too short to search on. Paste the DOI — it starts with "
                       "10. — or the paper's full title.")
    if ref.kind == "url_without_doi":
        return _answer("bad_input", "That link does not contain the paper's DOI. Open the paper, copy "
                       "its DOI (it starts with 10.) and paste that, or paste the title.")

    doi = ref.doi
    if ref.kind == "scopus" and not doi:
        if not scopus_on:
            return _answer("scopus_link", "That is a Scopus link, and Scopus is not connected on this "
                           "server, so it cannot be opened from here. Copy the DOI from the same Scopus "
                           "page — it is listed under the title — and paste that.")
        try:
            record = fetch_scopus_by_eid(ref.eid)
        except Exception as exc:  # noqa: BLE001
            _, detail = sources.classify(exc, "Scopus")
            return _answer("unreachable", f"{detail} Paste the paper's DOI instead.")
        doi = normalize_doi((record or {}).get("doi"))
        if not doi:
            return _answer("not_found", "Scopus has no DOI for that record. Paste the DOI from the "
                           "paper itself, or its title.")

    if ref.kind == "title":
        doi, answer = _by_title(ref.title)
        if answer:
            return answer

    tasks: dict[str, Callable[[], Any]] = {
        "openalex": lambda: fetch_openalex_work(doi),
        "crossref": lambda: fetch_crossref_work(doi),
    }
    if scopus_on:
        tasks["scopus"] = lambda: fetch_scopus_record(doi)
    results, errors = upstream.fan_out(tasks, budget=BUDGET)

    records: list[tuple[str, dict[str, Any]]] = []
    if results.get("scopus"):
        records.append(("Scopus", from_scopus(results["scopus"])))
    if results.get("openalex"):
        records.append(("OpenAlex", from_openalex(results["openalex"])))
    if results.get("crossref"):
        records.append(("Crossref", from_crossref(results["crossref"])))

    source_list = [
        _source_entry(sid, found=bool(results.get(sid)), error=errors.get(sid),
                      abandoned=sid in errors and errors[sid] is None, budget=BUDGET)
        for sid in ("openalex", "crossref", "scopus") if sid in tasks
    ]
    if not scopus_on:
        source_list.append(sources.not_configured("scopus", "Scopus is not connected on this server."))
    scopus_status = ("not_configured" if not scopus_on
                     else "ok" if "scopus" not in errors else "unavailable")

    if not records:
        if errors and len(errors) == len(tasks):
            return _answer("unreachable", "OpenAlex and Crossref did not answer, so nothing could be "
                           "looked up. Enter the details by hand, or try again in a minute.",
                           sources=source_list, scopus_status=scopus_status)
        return _answer("not_found", f"No record of {doi} in OpenAlex or Crossref. Check the DOI against "
                       "the paper, or enter the details by hand.",
                       sources=source_list, scopus_status=scopus_status)

    paper, origin = merge(records)
    paper["doi"] = paper.get("doi") or doi
    name = getattr(claimant, "name", None)
    claimant_match = match_claimant(paper["authors"], name=name,
                                    scopus_author_id=getattr(claimant, "scopus_author_id", None))
    affiliation = college_affiliation(paper["authors"], college_name=college_name,
                                      claimant_position=claimant_match["position"])
    verdicts = author_verdicts(paper["authors"], college_name)
    for a in paper["authors"]:
        a["is_claimant"] = a["position"] == claimant_match["position"]
        a["college"] = verdicts.get(a["position"])

    metrics = journal_metrics(issns=paper["issns"], journal=paper.get("journal"),
                              publication_type=paper.get("publication_type"))
    if metrics["found"]:
        for field in ("quartile", "snip", "category", "engineering_class"):
            if metrics.get(field) is not None:
                origin[field] = JOURNAL_DATA
    # One ISSN for the form: the one our tables knew the journal by, when they did.
    paper["issn"] = next((i for i in paper["issns"] if i == metrics.get("issn")), None) or (
        paper["issns"][0] if paper["issns"] else None
    )
    journals_entry = sources.ok("journals", 1 if metrics["found"] else 0)
    if not metrics["found"]:
        journals_entry["detail"] = "Our SCImago and SNIP tables do not hold this journal."
    source_list.append(journals_entry)

    return {
        "ok": True,
        "code": "ok",
        "message": None,
        "input": {"kind": ref.kind, "doi": doi},
        "paper": paper,
        "claimant": claimant_match,
        "affiliation": affiliation,
        "metrics": metrics,
        "field_sources": origin,
        "sources": source_list,
        "scopus_status": scopus_status,
        "warnings": _warnings(paper, records),
        "to_check": _to_check(paper=paper, claimant=claimant_match, affiliation=affiliation,
                              metrics=metrics, college_name=college_name,
                              scopus_answered=bool(results.get("scopus")),
                              authors_from=origin.get("authors")),
        "already_filed": _already_filed(claimant, paper["doi"], exclude_claim_id),
        "candidates": [],
    }
