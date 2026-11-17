"""A journal's SNIP and quartile for a year, read from the journal tables by ISSN.

The leaderboard counts Scopus-linked papers, so what a paper's journal is
worth comes from the journal tables (`SnipSource` for SNIP, `ScimagoJournal`
for the SJR quartile), never from a claim or a ledger row that happens to
carry the same paper. ISSN only, never the title: the two tables spell
journal names differently often enough that a title match pairs the wrong rows.

One pass for any number of papers: the ISSNs are collected, each table is read
once for them (in chunks), and `lookup` then picks, for a paper's year, the
table year nearest to it (the later one on a tie; the newest when the paper
has no year). A journal in neither table is a paper with no SNIP and no
quartile, which is what it is.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterable, Optional

from django.db.models import Q

from core.models import ScimagoJournal, SnipSource
from core.services.discover import categories_of
from core.services.normalize import normalize_issn
from core.services.scimago import issn_variants, match_subject_quartile

_SPLIT = re.compile(r"[,;/\s]+")
CHUNK = 400


def issn_keys(text: Optional[str]) -> list[str]:
    """The eight-character keys in a stored ISSN field ("1234-5678, 8765432X")."""
    out: list[str] = []
    for token in _SPLIT.split((text or "").strip()):
        if not token:
            continue
        cleaned = normalize_issn(token) or token
        bare = re.sub(r"[^0-9Xx]", "", cleaned).upper()
        if len(bare) == 8 and bare not in out:
            out.append(bare)
    return out


def _key(value: Optional[str]) -> Optional[str]:
    keys = issn_keys(value)
    return keys[0] if keys else None


def _nearest(rows: list[tuple[int, object]], year: Optional[int]):
    if not rows:
        return None
    if year is None:
        return max(rows, key=lambda r: r[0])[1]
    return min(rows, key=lambda r: (abs(r[0] - year), -r[0]))[1]


class Journals:
    def __init__(self, issn_texts: Iterable[str]):
        wanted = sorted({k for t in issn_texts for k in issn_keys(t)})
        self._snip: dict[str, list[tuple[int, float]]] = defaultdict(list)
        self._quartile: dict[str, list[tuple[int, str]]] = defaultdict(list)
        for i in range(0, len(wanted), CHUNK):
            shapes = sorted({s for k in wanted[i:i + CHUNK] for s in issn_variants(f"{k[:4]}-{k[4:]}")})
            self._read(shapes)

    def _read(self, shapes: list[str]) -> None:
        snips = SnipSource.objects.filter(Q(print_issn__in=shapes) | Q(e_issn__in=shapes)).exclude(snip__isnull=True)
        for row in snips.only("print_issn", "e_issn", "snip", "year"):
            for k in {_key(row.print_issn), _key(row.e_issn)} - {None}:
                self._snip[k].append((row.year, row.snip))
        journals = ScimagoJournal.objects.filter(Q(issn__in=shapes) | Q(eissn__in=shapes))
        for row in journals.only("issn", "eissn", "year", "categories_json"):
            cats = categories_of(row)
            q = (match_subject_quartile(cats, None).get("quartile") or "").upper() if cats else ""
            if not q:
                continue
            for k in {_key(row.issn), _key(row.eissn)} - {None}:
                self._quartile[k].append((row.year, q))

    def lookup(self, issn_text: Optional[str], year: Optional[int]) -> tuple[str, Optional[float]]:
        """(quartile or "", SNIP or None) for the journal in this year."""
        quartile, snip = "", None
        for k in issn_keys(issn_text):
            if not quartile:
                quartile = _nearest(self._quartile.get(k, []), year) or ""
            if snip is None:
                snip = _nearest(self._snip.get(k, []), year)
        return quartile, snip
