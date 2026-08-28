"""The model proposes, the database disposes -- applied to search results.

Crossref and OpenAlex are the proposers here rather than a language model, but
the failure they cause is the same one `discover.py` was written to prevent: a
journal name arrives from outside, somebody attaches a quartile to it, and a
figure that decides what a person is paid has been derived from a string a
third party typed.

So nothing external is shown with a quartile, a SNIP or an amount until it has
been found in our own tables. Resolution is by ISSN first and by exact
normalised title second, and a near miss is treated as no match at all -- a
result carrying the wrong journal's Q1 is worse than a result carrying nothing,
because the reader cannot tell it is wrong.

What does not resolve is not dropped and not silently downgraded. `venues.py`
puts it in a separate list whose type has no field a number could live in, so a
searcher sees that the journal exists and that we cannot yet say anything about
its standing.
"""

from __future__ import annotations

from typing import Any

from django.db.models import Max, Q

from core.models import ScimagoJournal, SnipSource
from core.services.discover import categories_of, find_journal
from core.services.normalize import normalize_issn
from core.services.scimago import issn_variants, match_subject_quartile

#: Used only when the table is empty, so that a fresh install behaves.
FALLBACK_YEAR = 2025


def dataset_year() -> int:
    """The most recent Scimago year we actually hold.

    Read rather than hardcoded: the importer adds a year at a time, and a
    constant left behind at the last import means every search silently
    resolves against stale standings.
    """
    latest = ScimagoJournal.objects.aggregate(latest=Max("year"))["latest"]
    return int(latest) if latest else FALLBACK_YEAR


def resolve_journal(
    *,
    issn: str | None = None,
    title: str | None = None,
    year: int | None = None,
) -> ScimagoJournal | None:
    """Our own row for a journal named by somebody else, or None.

    ISSN first. It is the identifier the journal actually has, and it survives
    the spelling differences between Crossref's `container-title`, OpenAlex's
    `display_name` and Scimago's `title` -- which are three different strings
    for the same journal often enough that title matching between them is a
    coin toss.
    """
    year = year or dataset_year()
    scope = ScimagoJournal.objects.filter(year=year)

    for candidate in issn_variants(issn):
        row = scope.filter(Q(issn=candidate) | Q(eissn=candidate)).first()
        if row:
            return row

    if title:
        return find_journal(title, year=year)
    return None


def find_snip(row: ScimagoJournal) -> tuple[float | None, int | None]:
    """SNIP and the year it is from, matched by ISSN and never by title.

    The value alone is not enough for the filing form, which records
    `snip_year` beside it -- a SNIP with no year attached cannot be audited
    later, and the payout was computed from it.
    """
    codes = [c for c in (row.issn, row.eissn) if c]
    if not codes:
        return None, None
    match = (
        SnipSource.objects.filter(Q(print_issn__in=codes) | Q(e_issn__in=codes))
        .exclude(snip__isnull=True)
        .order_by("-year")
        .first()
    )
    return (match.snip, match.year) if match else (None, None)


def snips_for(rows: list[ScimagoJournal]) -> dict[str, tuple[float | None, int | None]]:
    """SNIP and its year for a page of journals, in one query rather than N.

    `find_snip` per row is what turned a venue search into four hundred round
    trips: the candidate set is capped at four hundred rows, and hydrating each
    one to decide whether it belongs in a list of ten meant paying for three
    hundred and ninety we then threw away. Callers hydrate *after* the cut and
    hydrate the survivors together.
    """
    codes: list[str] = []
    for row in rows:
        codes.extend(c for c in (row.issn, row.eissn) if c)
    if not codes:
        return {}

    best: dict[str, tuple[float, int]] = {}
    for issn_p, issn_e, snip, year in (
        SnipSource.objects.filter(Q(print_issn__in=codes) | Q(e_issn__in=codes))
        .exclude(snip__isnull=True)
        .values_list("print_issn", "e_issn", "snip", "year")
    ):
        for code in (issn_p, issn_e):
            if code and (code not in best or year > best[code][1]):
                best[code] = (snip, year)

    out: dict[str, tuple[float | None, int | None]] = {}
    for row in rows:
        for code in (row.issn, row.eissn):
            if code in best:
                out[row.pk] = best[code]
                break
        else:
            out[row.pk] = (None, None)
    return out


def standing(
    row: ScimagoJournal,
    *,
    subject: str | None = None,
    snip: tuple[float | None, int | None] | None = None,
) -> dict[str, Any]:
    """Everything our tables know about a journal, and nothing they do not.

    Academic standing only -- no amount. Pricing happens later, and only for a
    viewer entitled to see one.
    """
    categories = categories_of(row)
    matched = (
        match_subject_quartile(categories, subject)
        if categories
        else {"quartile": None, "category": None}
    )
    snip_value, snip_year = snip if snip is not None else find_snip(row)
    return {
        "journal": row.title,
        "issn": normalize_issn(row.issn) or row.issn,
        "eissn": normalize_issn(row.eissn) or row.eissn,
        "quartile": matched.get("quartile"),
        "subject_category": matched.get("category"),
        "categories": categories,
        "sjr": row.sjr,
        "snip": snip_value,
        "snip_year": snip_year,
        "dataset_year": row.year,
        "scimago_found": True,
    }
