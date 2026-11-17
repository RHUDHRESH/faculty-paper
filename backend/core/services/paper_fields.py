"""One answer to "what are this paper's figures?", for every report.

A paper's title, journal, ISSN, category, quartile, SNIP, author count, author
position, DOI, document type, Scopus indexing and remark live in four places,
and no one of them is complete:

1. **The claim**, when the row is linked to one: filed and checked in this app.
2. **The ledger row's own sheet row** (`PaidLedger.raw_json`), which the ERP and
   the settled-claims imports keep whole: "ISSN", "SNIP Value", "SJR Quartile",
   "Engineering Classification", "Document Type", "Indexing Status", "DOI", and
   the author count and position under more than one spelling.
3. **The publication record** (`Publication`), found by the link the college
   made, else by DOI, else by normalised title, with its authors.
4. **The journal tables** (`SnipSource`, `ScimagoJournal`), by ISSN: SNIP,
   quartile, category and, last of all, a journal's name.

`for_claims` and `for_ledger_rows` read them in that order, per field, and take
the first source that has a value. Every report calls these two functions, so
the same row shows the same values in the Report studio, the Paid register, the
statements, the ledger and `/api/v1`. A field no source has is `None`: an empty
cell in a file, a quiet dash on screen. Never a word such as "Not recorded".

What is deliberately *not* believed:

* A quartile is Q1 to Q4. The sheet's "Others", "No Quartile" and "-" are not
  quartiles, so the next source is asked.
* A SNIP is above zero. The sheet says "N/A" for books and conference series,
  and a claim for one carries 0.0; neither is a figure.
* A claimant's own declarations (`self_reported_quartile`, `self_reported_snip`)
  are not shown as the paper's: the payout never uses them either.
* A journal's quartile or SNIP is looked up by ISSN. A journal found by name
  alone gives only an ISSN, and only when the name matches exactly one.

Nothing here reads money. The ledger's amount stays where it is.

The newest block of the old accounts sheet has six unlabelled columns, and in
those rows the column headed "Amount" holds the number of authors (see
`rebuild_from_erp.ledger_amount`): `col22` is the author position, `col24` the
remark. They are read as such when `col27` is present.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, Optional

from django.db.models import Q
from django.db.models.functions import Lower, Upper

from core.management.commands.rebuild_from_erp import BLANKISH, num
from core.models import (
    Authorship,
    Claim,
    ClaimReason,
    PaidLedger,
    Publication,
    ScimagoJournal,
    SnipSource,
    User,
)
from core.services.normalize import clean_venue, normalize_doi, normalize_issn, normalize_title
from core.services.scimago import best_by_quartile, engineering_class, issn_variants, parse_categories_field

#: The fields every report shares, under the names the reports use.
FIELDS = (
    "title", "journal", "issn", "category", "quartile", "snip", "total_authors",
    "author_position", "doi", "document_type", "indexing", "remark",
)

ENGINEERING = "Engineering"
NON_ENGINEERING = "Non-engineering"
CATEGORIES = [ENGINEERING, NON_ENGINEERING]
QUARTILES = ["Q1", "Q2", "Q3", "Q4"]
INDEXED = "Indexed"
NOT_INDEXED = "Not yet indexed"

#: What a Scopus "source type" is called, which is what the sheet's Document
#: Type column holds. Anything else (an OpenAlex type, a claim's own wording)
#: is a paper in a journal for the purpose of the engineering rule.
_AGGREGATION_TYPES = {"Journal", "Conference Proceeding", "Book", "Book Series", "Trade Journal"}

_RAW_KEYS: dict[str, tuple[str, ...]] = {
    "title": ("scopusarticletitle", "articletitlescopus", "articletitle", "papertitle", "title"),
    "journal": ("sourcetitle", "journalname", "journaltitle", "journal"),
    "issn": ("issn", "issnnumber", "issnisbn"),
    "category": ("engineeringclassification", "engineeringclass", "engineeringnonengineering", "category"),
    "quartile": ("sjrquartile", "quartile"),
    "snip": ("snipvalue", "snip"),
    "total_authors": (
        "totalnoofauthors", "totalnumberofauthors", "noofauthors", "numberofauthors", "totalauthors",
        "authorcount", "noofauthor",
    ),
    "author_position": ("authorposition", "positionofauthor", "authorpos", "positioninauthorlist"),
    "doi": ("doi",),
    "document_type": ("documenttype", "doctype", "publicationtype", "sourcetype"),
    "indexing": ("indexingstatus", "scopusindexing", "indexing"),
    "remark": ("remark", "remarks", "notes", "note", "col24", "status"),
    "subjects": ("subjectarea", "subjectcategory", "subjects"),
}

_COUNT_ONLY = re.compile(r"only for count|no\s*re[nm]u", re.I)
_SEPARATED = re.compile(r"[,;/\s]")
_ISSN_SHAPE = re.compile(r"\d{4}[- ]?\d{3}[\dXx]")


# ----------------------------------------------------------- small cleaners --


def _text(value: Any) -> Optional[str]:
    """Clean text, or None for a blank or a placeholder such as "N/A" or "-"."""
    if value is None:
        return None
    text = " ".join(str(value).split())
    return None if text.lower() in BLANKISH else text


def _whole(value: Any) -> Optional[int]:
    """A whole number of at least 1 ("2", "2.0", "04"), else None."""
    n = num(value)
    if n is None or n != int(n) or n < 1:
        return None
    return int(n)


def parse_snip(value: Any) -> Optional[float]:
    """The one SNIP rule: a finite number above zero, else None.

    "N/A", "-", blanks, 0 and negatives are not a SNIP. The resolver, the Report
    studio and the Top 5 boards (`top5`) all read a SNIP through this, so one
    paper has one SNIP wherever it is shown.
    """
    if isinstance(value, bool):
        return None
    n = float(value) if isinstance(value, (int, float)) else num(value)
    return n if n is not None and math.isfinite(n) and n > 0 else None


def raw_snip(raw_json: Optional[str]) -> Optional[float]:
    """The SNIP a ledger row's sheet row carries ("SNIP Value" and its spellings)."""
    if not raw_json or "snip" not in raw_json.lower():
        return None
    by_key = {_squash(k): v for k, v in _raw_dict(raw_json).items()}
    for alias in _RAW_KEYS["snip"]:
        n = parse_snip(by_key.get(alias))
        if n is not None:
            return n
    return None


_snip = parse_snip


def _quartile(value: Any) -> Optional[str]:
    text = (_text(value) or "").upper().replace(" ", "")
    return text if text in QUARTILES else None


def _category(value: Any) -> Optional[str]:
    text = (_text(value) or "").lower()
    if not text:
        return None
    if "non" in text:
        return NON_ENGINEERING
    return ENGINEERING if "engineering" in text else None


def _issn(value: Any) -> Optional[str]:
    """An ISSN as 1234-5678, whatever a spreadsheet did to it ("13303651.0",
    "1445987.0" for 0144-5987). A list, or an ISBN, is left as written."""
    text = _text(value)
    if not text:
        return None
    if _SEPARATED.search(text) and not _ISSN_SHAPE.fullmatch(text):
        return text
    return normalize_issn(text.replace(" ", "-")) or None


def _doi(value: Any) -> Optional[str]:
    text = _text(value)
    return normalize_doi(text) if text else None


_DOC_WORDS = {
    "conference proceedings": "Conference Proceeding",
    "conference proceeding": "Conference Proceeding",
    "conference paper": "Conference Proceeding",
    "proceedings-article": "Conference Proceeding",
    "proceedings article": "Conference Proceeding",
    "journal-article": "Journal",
    "journal article": "Journal",
}


def _document_type(value: Any) -> Optional[str]:
    """One spelling for each kind of document, so a report can group on it."""
    text = _text(value)
    if not text:
        return None
    parts: list[str] = []
    for part in re.split(r"\s*,\s*", text):
        key = part.strip().lower()
        if not key:
            continue
        words = _DOC_WORDS.get(key) or " ".join(w.capitalize() for w in key.replace("-", " ").split())
        if words not in parts:
            parts.append(words)
    return ", ".join(parts) or None


def _indexing(value: Any) -> Optional[str]:
    text = _text(value)
    if not text:
        return None
    low = text.lower()
    if low.startswith("not ") or low in ("not", "no"):
        return NOT_INDEXED
    return INDEXED if "index" in low or low in ("yes", "scopus") else text


def _join_remark(*texts: Optional[str]) -> Optional[str]:
    """Remarks as one line. A remark that another one already says is dropped."""
    out: list[str] = []
    for text in texts:
        text = (text or "").strip().rstrip(".").strip()
        if not text:
            continue
        low = text.casefold()
        if any(low in seen.casefold() for seen in out):
            continue
        out = [seen for seen in out if seen.casefold() not in low]
        out.append(text)
    return ". ".join(out) or None


def _raw_dict(raw_json: Optional[str]) -> dict[str, Any]:
    if not raw_json or not raw_json.lstrip().startswith("{"):
        return {}
    try:
        data = json.loads(raw_json)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _squash(key: Any) -> str:
    return "".join(ch for ch in str(key).lower() if ch.isalnum())


# ----------------------------------------------------------------- the tiers --


def _claim_tier(c: Claim) -> dict[str, Any]:
    """What the claim itself holds. A claim's SNIP and quartile are the verified
    ones; the claimant's own declarations are not read."""
    total, position = _whole(c.total_authors), _whole(c.author_position)
    # 1 of 1 is the column's default. On a claim nobody listed the authors of
    # (an import, or a draft) it says "not entered", so the publication's own
    # author order is asked instead, and an empty cell beats an invented 1 of 1.
    ticket = c.ticket_number or ""
    if total == 1 and position == 1 and not (c.authors_json or "").strip() and (
        not ticket or ticket.startswith("ERP-")
    ):
        total = position = None
    if total and position and position > total:
        position = None
    note = _text(c.status_note)
    note = note if note and _COUNT_ONLY.search(note) else None
    indexing = _indexing(c.indexing_status)
    if indexing is None and (c.eid or c.scopus_url):
        indexing = INDEXED
    return {
        "title": _text(c.paper_title),
        "journal": clean_venue(c.journal_title) or None,
        "issn": _issn(c.issn),
        "category": _category(c.engineering_class),
        "quartile": _quartile(c.quartile),
        "snip": _snip(c.snip),
        "total_authors": total,
        "author_position": position,
        "doi": _doi(c.doi),
        "document_type": _document_type(c.aggregation_type) or _document_type(c.publication_type),
        "indexing": indexing,
        "remark": note,
        "subjects": _text(c.subject_category),
        "count_only": c.claim_reason == ClaimReason.COUNT_ONLY or bool(note),
        "student": bool(c.is_student_publication) or c.claim_reason == ClaimReason.STUDENT_PROJECT,
    }


def _sheet_tier(row: Optional[PaidLedger], raw: dict[str, Any]) -> dict[str, Any]:
    """What a ledger row holds: its own columns, then the sheet row it came from."""
    by_key = {_squash(k): v for k, v in raw.items()}

    def pick(name: str) -> Any:
        for alias in _RAW_KEYS[name]:
            if alias in by_key and _text(by_key[alias]) is not None:
                return by_key[alias]
        return None

    shifted = _text(by_key.get("col27")) is not None
    total = _whole(by_key.get("amount")) if shifted else _whole(pick("total_authors"))
    position = _whole(by_key.get("col22")) if shifted else _whole(pick("author_position"))
    if total and position and position > total:
        position = None
    return {
        "title": (_text(row.paper_title) if row else None) or _text(pick("title")),
        "journal": ((clean_venue(row.journal_title) if row else "") or clean_venue(pick("journal"))) or None,
        "issn": _issn(pick("issn")),
        "category": _category(pick("category")),
        "quartile": _quartile(pick("quartile")),
        "snip": _snip(pick("snip")),
        "total_authors": total,
        "author_position": position,
        "doi": _doi(pick("doi")),
        "document_type": _document_type(pick("document_type")),
        "indexing": _indexing(pick("indexing")),
        "remark": _text(pick("remark")),
        "subjects": _text(pick("subjects")),
    }


def _publication_tier(pub: Publication, authors: dict[str, Any], user_id: Optional[str]) -> dict[str, Any]:
    n = authors.get("count") or 0
    mine = [p for p in authors.get("positions", {}).get(user_id, []) if p] if user_id else []
    position = min(mine) if mine else None
    if n and position and position > n:
        position = None
    return {
        "title": _text(pub.title),
        "journal": clean_venue(pub.venue) or None,
        "issn": _issn(pub.issn),
        "quartile": _quartile(pub.quartile),
        "total_authors": n or None,
        "author_position": position,
        "doi": _doi(pub.doi),
        "document_type": _document_type(pub.type),
        "indexing": INDEXED if (pub.scopus_indexed or pub.eid) else None,
    }


def _categories_of(raw: Optional[str]) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return parse_categories_field(raw)
    if isinstance(data, str):
        return parse_categories_field(data)
    return [c for c in data if isinstance(c, dict) and c.get("category")] if isinstance(data, list) else []


def _derived_category(document_type: Optional[str], subjects: Optional[str]) -> Optional[str]:
    """The college's own engineering rule (`scimago.engineering_class`) over a
    paper's subject areas. Without subjects there is nothing to apply it to."""
    if not subjects:
        return None
    kind = document_type if document_type in _AGGREGATION_TYPES else "Journal"
    return _category(engineering_class(kind, subjects))


# ------------------------------------------------------------------ the batch --


@dataclass
class _Item:
    key: str
    claim: Optional[Claim] = None
    ledger: Optional[PaidLedger] = None
    user_id: Optional[str] = None
    tiers: list[dict[str, Any]] = field(default_factory=list)
    pub: Optional[Publication] = None
    #: What the journal tables add (the last tier).
    journal: dict[str, Any] = field(default_factory=dict)


def _chunks(items: list, size: int = 2000):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _first(tiers: list[dict[str, Any]], name: str) -> Any:
    for t in tiers:
        if t.get(name) is not None:
            return t[name]
    return None


def _load_publications(items: list[_Item]) -> None:
    """Link each item to its publication: the link the college made, else DOI, else title."""
    linked: dict[tuple[str, str], str] = {}
    claim_ids = [i.claim.pk for i in items if i.claim]
    ledger_ids = [i.ledger.pk for i in items if i.ledger]
    for chunk in _chunks(claim_ids):
        for pid, cid in Publication.claims.through.objects.filter(claim_id__in=chunk).values_list(
            "publication_id", "claim_id"
        ):
            linked.setdefault(("c", cid), pid)
    for chunk in _chunks(ledger_ids):
        for pid, lid in Publication.ledger_rows.through.objects.filter(paidledger_id__in=chunk).values_list(
            "publication_id", "paidledger_id"
        ):
            linked.setdefault(("l", lid), pid)

    dois: set[str] = set()
    titles: set[str] = set()
    for it in items:
        d = _first(it.tiers, "doi")
        if d:
            dois.add(d)
        t = normalize_title(_first(it.tiers, "title"))[:512]
        if t:
            titles.add(t)

    by_id: dict[str, Publication] = {}
    by_doi: dict[str, Publication] = {}
    by_title: dict[str, Publication] = {}
    for chunk in _chunks(sorted(set(linked.values()))):
        by_id.update({p.pk: p for p in Publication.objects.filter(pk__in=chunk)})
    for chunk in _chunks(sorted(dois)):
        for p in Publication.objects.filter(doi__in=chunk).order_by("-year", "id"):
            by_doi.setdefault(normalize_doi(p.doi) or "", p)
    for chunk in _chunks(sorted(titles)):
        for p in Publication.objects.filter(normalized_title__in=chunk).order_by("-year", "id"):
            by_title.setdefault(p.normalized_title, p)

    for it in items:
        pub = by_id.get(linked.get(("c", it.claim.pk), "")) if it.claim else None
        if pub is None and it.ledger:
            pub = by_id.get(linked.get(("l", it.ledger.pk), ""))
        if pub is None:
            doi = _first(it.tiers, "doi")
            pub = by_doi.get(doi) if doi else None
        if pub is None:
            title = normalize_title(_first(it.tiers, "title"))[:512]
            pub = by_title.get(title) if title else None
        it.pub = pub

    authors: dict[str, dict[str, Any]] = {}
    for chunk in _chunks(sorted({it.pub.pk for it in items if it.pub})):
        for pid, uid, pos in Authorship.objects.filter(publication_id__in=chunk).values_list(
            "publication_id", "user_id", "position"
        ):
            row = authors.setdefault(pid, {"count": 0, "positions": {}})
            row["count"] += 1
            if uid:
                row["positions"].setdefault(uid, []).append(pos)
    for it in items:
        if it.pub:
            it.tiers.append(_publication_tier(it.pub, authors.get(it.pub.pk, {}), it.user_id))


def _load_journals(items: list[_Item]) -> None:
    """SNIP, quartile, subjects and a journal's name from the journal tables, by ISSN."""
    # A journal known only by name gives its ISSN, and only when one journal has that name.
    nameless = [i for i in items if not _first(i.tiers, "issn") and _first(i.tiers, "journal")]
    found: dict[str, str] = {}
    for chunk in _chunks(sorted({_first(i.tiers, "journal").lower() for i in nameless}), 1000):
        by_name: dict[str, set[str]] = {}
        for title, print_issn in (
            SnipSource.objects.annotate(lt=Lower("title")).filter(lt__in=chunk)
            .exclude(print_issn__isnull=True).exclude(print_issn="").values_list("lt", "print_issn")
        ):
            normalized = _issn(print_issn)
            if normalized:
                by_name.setdefault(title, set()).add(normalized)
        found.update({t: next(iter(v)) for t, v in by_name.items() if len(v) == 1})
    for it in nameless:
        issn = found.get(_first(it.tiers, "journal").lower())
        if issn:
            it.journal["issn"] = issn

    wants: dict[str, list[_Item]] = {}
    for it in items:
        issn = _first(it.tiers, "issn") or it.journal.get("issn")
        missing = any(_first(it.tiers, n) is None for n in ("snip", "quartile", "journal")) or (
            _first(it.tiers, "category") is None and _first(it.tiers, "subjects") is None
        )
        if issn and missing:
            for v in issn_variants(issn):
                wants.setdefault(v, []).append(it)
    if not wants:
        return

    snips: dict[int, tuple[int, float]] = {}
    names: dict[int, tuple[int, str]] = {}
    sjrs: dict[int, ScimagoJournal] = {}
    for chunk in _chunks(sorted(wants), 3000):
        for pi, ei, snip, year, title in SnipSource.objects.filter(
            Q(print_issn__in=chunk) | Q(e_issn__in=chunk)
        ).values_list("print_issn", "e_issn", "snip", "year", "title"):
            for v in (pi, ei):
                for it in wants.get(v or "", ()):
                    if snip is not None and snip > 0 and year >= snips.get(id(it), (0, 0))[0]:
                        snips[id(it)] = (year, snip)
                    if title and year >= names.get(id(it), (0, ""))[0]:
                        names[id(it)] = (year, title)
        for sj in ScimagoJournal.objects.filter(Q(issn__in=chunk) | Q(eissn__in=chunk)):
            for v in (sj.issn, sj.eissn):
                for it in wants.get(v or "", ()):
                    if id(it) not in sjrs or sj.year > sjrs[id(it)].year:
                        sjrs[id(it)] = sj
    for group in wants.values():
        for it in group:
            if "looked_up" in it.journal:
                continue
            it.journal["looked_up"] = True
            if id(it) in snips:
                it.journal["snip"] = round(snips[id(it)][1], 4)
            if id(it) in names:
                it.journal["journal"] = clean_venue(names[id(it)][1]) or None
            sj = sjrs.get(id(it))
            if sj is not None:
                cats = _categories_of(sj.categories_json)
                it.journal["journal"] = it.journal.get("journal") or clean_venue(sj.title) or None
                if cats:
                    it.journal["quartile"] = _quartile(best_by_quartile(cats).get("quartile"))
                    it.journal["subjects"] = "; ".join(
                        f"{c['category']} ({c['quartile']})" if c.get("quartile") else c["category"] for c in cats
                    )


def _resolve(items: list[_Item]) -> dict[str, dict[str, Any]]:
    _load_publications(items)
    _load_journals(items)
    out: dict[str, dict[str, Any]] = {}
    for it in items:
        tiers = [*it.tiers, it.journal]
        row = {name: _first(tiers, name) for name in FIELDS if name != "remark"}
        if row["category"] is None:
            row["category"] = _derived_category(row["document_type"], _first(tiers, "subjects"))
        # A position past the count is two sources disagreeing: keep the count.
        if row["total_authors"] and row["author_position"] and row["author_position"] > row["total_authors"]:
            row["author_position"] = None
        texts = [t.get("remark") for t in tiers]
        joined = " ".join(t for t in texts if t)
        if any(t.get("count_only") for t in tiers) and not _COUNT_ONLY.search(joined):
            texts.append("Count only")
        if any(t.get("student") for t in tiers) and "student" not in joined.casefold():
            texts.append("Student publication")
        row["remark"] = _join_remark(*texts)
        out[it.key] = row
    return out


def _users_by_staff(staff_ids: Iterable[Optional[str]]) -> dict[str, str]:
    wanted = sorted({s.strip().upper() for s in staff_ids if s and s.strip()})
    out: dict[str, str] = {}
    for chunk in _chunks(wanted):
        for pk, sid in User.objects.annotate(u=Upper("staff_id")).filter(u__in=chunk).values_list("pk", "u"):
            out[sid] = pk
    return out


def for_ledger_rows(rows: Iterable[PaidLedger]) -> dict[str, dict[str, Any]]:
    """Resolved fields for ledger rows, keyed by row id."""
    rows = list(rows)
    claims: dict[str, Claim] = {}
    for chunk in _chunks(sorted({r.claim_id for r in rows if r.claim_id})):
        claims.update({c.pk: c for c in Claim.objects.filter(pk__in=chunk)})
    by_staff = _users_by_staff(r.staff_id for r in rows if not r.claim_id)
    items = []
    for r in rows:
        claim = claims.get(r.claim_id) if r.claim_id else None
        it = _Item(key=r.pk, claim=claim, ledger=r)
        it.user_id = claim.owner_id if claim else by_staff.get((r.staff_id or "").strip().upper())
        if claim:
            it.tiers.append(_claim_tier(claim))
        it.tiers.append(_sheet_tier(r, _raw_dict(r.raw_json)))
        items.append(it)
    return _resolve(items)


def for_claims(claims: Iterable[Claim]) -> dict[str, dict[str, Any]]:
    """Resolved fields for claims, keyed by claim id. A claim that was paid also
    reads the sheet row its payment carries, so it agrees with the ledger row."""
    claims = list(claims)
    paid: dict[str, PaidLedger] = {}
    for chunk in _chunks([c.pk for c in claims]):
        for r in PaidLedger.objects.filter(claim_id__in=chunk, kind=PaidLedger.Kind.PAYMENT).order_by("cycle", "id"):
            paid[r.claim_id] = r
    items = []
    for c in claims:
        r = paid.get(c.pk)
        it = _Item(key=c.pk, claim=c, ledger=r, user_id=c.owner_id)
        it.tiers.append(_claim_tier(c))
        if r:
            it.tiers.append(_sheet_tier(r, _raw_dict(r.raw_json)))
        items.append(it)
    return _resolve(items)


def for_ledger_row(row: PaidLedger) -> dict[str, Any]:
    return for_ledger_rows([row])[row.pk]


def for_claim(claim: Claim) -> dict[str, Any]:
    return for_claims([claim])[claim.pk]


def academic_year(d: Optional[date]) -> Optional[str]:
    """The academic year a date falls in ("2025-26"), by the policy's first month."""
    from core.services import research_threshold

    if d is None:
        return None
    return research_threshold.year_label(research_threshold.year_bounds(d)[0])


__all__ = [
    "FIELDS", "parse_snip", "raw_snip", "CATEGORIES", "QUARTILES", "ENGINEERING", "NON_ENGINEERING", "INDEXED", "NOT_INDEXED",
    "for_ledger_rows", "for_claims", "for_ledger_row", "for_claim", "academic_year",
]
