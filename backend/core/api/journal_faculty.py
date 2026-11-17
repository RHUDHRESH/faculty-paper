"""One journal, as a faculty member sees it.

`/journals/report` is the college's view of a journal: who publishes there,
what each claim was worth, what has been paid. A faculty account used to be
refused the journal altogether, which left the most ordinary click in the app
("what is this journal?") ending at a closed gate.

This is the other half of the payload: read-only facts about the journal, and
the viewer's OWN claims in it. Nothing here is drawn from anybody else's
claim: no author list, no department split, no counts of other people's
papers, no amounts that are not the viewer's, and none of the research
office's notes or watch-list entries. It is built from scratch rather than by
trimming the staff payload, so a field added to that one cannot leak into
this one by being forgotten.

Not a route: `discover.journal_report` calls `faculty_record`.
"""
from __future__ import annotations

import json
from typing import Any

from core.api.journals import _issn_variants, _match_on_punctuation
from core.models import (
    Claim,
    ClaimStatus,
    JournalFlagList,
    JournalStanding,
    ScimagoJournal,
    SnipSource,
    User,
)
from core.services import journal_check
from core.services.normalize import normalize_issn, normalize_title

#: The most years of one journal's Scimago and SNIP history that are returned.
MAX_YEARS = 12


def _scimago_rows(title: str, issn: str | None) -> list[ScimagoJournal]:
    qs = ScimagoJournal.objects.all()
    variants = _issn_variants(issn)
    rows: list[ScimagoJournal] = []
    if variants:
        rows = list(qs.filter(issn__in=variants).order_by("-year")[:MAX_YEARS]) or list(
            qs.filter(eissn__in=variants).order_by("-year")[:MAX_YEARS]
        )
    if not rows and title:
        rows = list(qs.filter(title__iexact=title).order_by("-year")[:MAX_YEARS])
    if not rows and title:
        hit = _match_on_punctuation(qs, title)
        if hit is not None:
            rows = (
                list(qs.filter(issn=hit.issn).order_by("-year")[:MAX_YEARS]) if hit.issn else [hit]
            )
    return rows


def _categories(row: ScimagoJournal) -> list[dict[str, str]]:
    try:
        raw = json.loads(row.categories_json or "[]")
    except (TypeError, ValueError):
        return []
    out: list[dict[str, str]] = []
    for c in raw if isinstance(raw, list) else []:
        if isinstance(c, dict):
            name = c.get("category") or c.get("name") or ""
            if name:
                out.append(
                    {"category": str(name), "quartile": str(c.get("quartile") or c.get("Quartile") or "-")}
                )
    return out[:12]


def _best(categories: list[dict[str, str]]) -> str | None:
    return min((c["quartile"] for c in categories if c["quartile"].startswith("Q")), default=None)


def _snip_rows(title: str, issn: str | None) -> list[SnipSource]:
    variants = _issn_variants(issn)
    rows: list[SnipSource] = []
    if variants:
        rows = list(SnipSource.objects.filter(print_issn__in=variants).order_by("-year")) or list(
            SnipSource.objects.filter(e_issn__in=variants).order_by("-year")
        )
    if not rows and title:
        rows = list(SnipSource.objects.filter(title__iexact=title).order_by("-year"))
    return rows[:MAX_YEARS]


def _standing(title: str, issns: list[str]) -> dict[str, Any]:
    """Whether Scopus still lists it and whether it is on the UGC-CARE list.

    The same two questions the journal check answers, from the same tables,
    with the dates the standing changed. "unknown" means the list was never
    loaded, which is not the same as "fine".
    """
    variants = journal_check._variants(issns)
    scopus_rows = JournalStanding.objects.filter(source=JournalStanding.Source.SCOPUS_DISCONTINUED)
    flags = JournalFlagList.objects.filter(source=JournalFlagList.Source.SCOPUS_DISCONTINUED)
    if not (scopus_rows.exists() or flags.exists()):
        discontinued: dict[str, Any] = {"state": "unknown", "since": None, "reason": None}
    else:
        gone = scopus_rows.filter(issn__in=variants, listed=False).first() if variants else None
        hit = journal_check._flag_hit(JournalFlagList.Source.SCOPUS_DISCONTINUED, issns, title)
        if gone or hit:
            discontinued = {
                "state": "discontinued",
                "since": gone.changed_on.isoformat() if gone and gone.changed_on else None,
                "reason": (gone.reason if gone else None) or (hit.note if hit else None) or None,
            }
        else:
            discontinued = {"state": "not_discontinued", "since": None, "reason": None}

    ugc_rows = JournalStanding.objects.filter(source=JournalStanding.Source.UGC_CARE)
    if not ugc_rows.exists():
        ugc: dict[str, Any] = {"state": "unknown", "since": None, "reason": None}
    else:
        row = ugc_rows.filter(issn__in=variants).first() if variants else None
        if row is None:
            ugc = {"state": "not_listed", "since": None, "reason": None}
        elif row.listed:
            ugc = {"state": "listed", "since": None, "reason": None}
        else:
            ugc = {
                "state": "removed",
                "since": row.changed_on.isoformat() if row.changed_on else None,
                "reason": row.reason or None,
            }
    return {"scopus_discontinued": discontinued, "ugc_care": ugc}


def _own_claim(c: Claim) -> dict[str, Any]:
    """One of the viewer's own claims: what My papers already shows them."""
    return {
        "id": c.id,
        "ticket_number": c.ticket_number,
        "paper_title": c.paper_title,
        "publication_year": c.publication_year,
        "status": c.status,
        "quartile": c.quartile,
        "snip": c.snip,
        # Their own amount, as on their own claim page. Never anybody else's.
        "remuneration": c.remuneration,
        "remuneration_is_estimate": c.status == ClaimStatus.DRAFT,
    }


def faculty_record(user: User, name: str) -> dict[str, Any] | None:
    """The faculty view of journal `name`, or None when nothing is known of it."""
    mine = list(
        Claim.objects.filter(owner=user, journal_title__iexact=name).order_by(
            "-publication_year", "-updated_at"
        )[:100]
    )
    # Journal-level fields (indexing, class, subject) are facts about the
    # journal, read from whichever filed claim carries them. Only the values
    # leave, never the claim.
    filed = Claim.objects.exclude(status=ClaimStatus.DRAFT).filter(journal_title__iexact=name)

    def first(field: str):
        values = (
            filed.exclude(**{f"{field}__isnull": True})
            .exclude(**{field: ""})
            .values_list(field, flat=True)[:1]
        )
        return next(iter(values), None)

    issn = next((c.issn for c in mine if c.issn), None) or first("issn")
    rows = _scimago_rows(name, issn)
    snips = _snip_rows(name, issn)
    if not (mine or rows or snips or filed.exists()):
        return None

    latest = rows[0] if rows else None
    issns = [
        n
        for n in dict.fromkeys(
            normalize_issn(v)
            for v in (issn, latest.issn if latest else None, latest.eissn if latest else None)
            if v
        )
        if n
    ]

    sjr_by_year = []
    for r in rows:
        cats = _categories(r)
        sjr_by_year.append(
            {"year": r.year, "sjr": r.sjr, "best_quartile": _best(cats), "categories": cats}
        )

    named = latest is not None and normalize_title(latest.title) == normalize_title(name)
    return {
        "view": "faculty",
        "journal": {
            "title": latest.title if named else name,
            "issn": normalize_issn(latest.issn) if latest and latest.issn else (normalize_issn(issn) if issn else None),
            "eissn": normalize_issn(latest.eissn) if latest and latest.eissn else None,
            "publisher": journal_check._publisher(latest) if latest else None,
            "subject_category": first("subject_category"),
            "indexing": first("indexing_level"),
            "engineering_class": first("engineering_class"),
            "snip_by_year": [{"year": s.year, "snip": s.snip} for s in snips if s.snip is not None],
            "sjr_by_year": sjr_by_year,
            "standing": _standing(name, issns),
        },
        "mine": {"claims": [_own_claim(c) for c in mine], "count": len(mine)},
    }
