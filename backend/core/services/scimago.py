from __future__ import annotations

import json
import re
from typing import Any

from django.db.models import Q

from core.models import ScimagoJournal
from core.services.normalize import normalize_issn, normalize_title, titles_rough_match

SCIMAGO_CITATION = (
    "SCImago, (n.d.). SJR — SCImago Journal & Country Rank [Portal]. "
    "Retrieved from https://www.scimagojr.com"
)

Q_ORDER = {"Q1": 1, "Q2": 2, "Q3": 3, "Q4": 4}


def normalize_category(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def issn_variants(issn: str | None) -> list[str]:
    """Every spelling of one ISSN the reference tables hold.

    Hyphenated and bare (Scopus writes 00280836), and the two a spreadsheet
    produces by reading an ISSN as a number: "20452322.0", and for 0390-6663
    the zero-stripped "3906663.0". The repairs in migrations 0027/0034 were
    undone by a later import -- 29,217 of 32,087 SNIP rows and 9,993 SCImago
    rows hold the float form -- and an ISSN that is in the table but not
    matched is a journal priced without its SNIP or quartile.
    """
    if not issn:
        return []
    cleaned = normalize_issn(issn) or issn.strip()
    bare = re.sub(r"[^0-9Xx]", "", cleaned).upper()
    out = []
    if cleaned:
        out.append(cleaned)
    if len(bare) == 8:
        hyph = f"{bare[:4]}-{bare[4:]}"
        out.extend([bare, hyph, bare.lower(), hyph.lower()])
        if bare.isdigit():
            out.extend([f"{bare}.0", f"{int(bare)}.0", str(int(bare))])
    # unique preserve order
    seen = set()
    uniq = []
    for v in out:
        if v and v not in seen:
            seen.add(v)
            uniq.append(v)
    return uniq


def parse_categories_field(raw: str) -> list[dict[str, Any]]:
    if not raw or not str(raw).strip():
        return []
    out = []
    for part in str(raw).split(";"):
        trimmed = part.strip()
        if not trimmed:
            continue
        m = re.match(r"^(.*?)(?:\s*\((Q[1-4])\))\s*$", trimmed, re.I) or re.match(
            r"^(.*?)\s+(Q[1-4])\s*$", trimmed, re.I
        )
        if m:
            out.append({"category": m.group(1).strip(), "quartile": m.group(2).upper()})
        else:
            out.append({"category": trimmed, "quartile": None})
    return out


def best_by_quartile(categories: list[dict[str, Any]]) -> dict[str, Any]:
    return sorted(
        categories,
        key=lambda c: Q_ORDER.get(c.get("quartile") or "Q4", 4),
    )[0]


def match_subject_quartile(
    categories: list[dict[str, Any]], paper_subject: str | None = None
) -> dict[str, Any]:
    if not categories:
        return {"quartile": None, "category": None}
    if not paper_subject:
        best = best_by_quartile(categories)
        return {"quartile": best.get("quartile"), "category": best.get("category")}
    needle = normalize_category(paper_subject)
    exact = next((c for c in categories if normalize_category(c["category"]) == needle), None)
    if exact:
        return {"quartile": exact.get("quartile"), "category": exact.get("category")}
    fuzzy = [
        c
        for c in categories
        if needle in normalize_category(c["category"])
        or normalize_category(c["category"]) in needle
    ]
    if fuzzy:
        best = best_by_quartile(fuzzy)
        return {"quartile": best.get("quartile"), "category": best.get("category")}
    best = best_by_quartile(categories)
    return {"quartile": best.get("quartile"), "category": best.get("category")}


def scimago_official_search_url(issn: str | None = None, title: str | None = None) -> str:
    if issn:
        bare = re.sub(r"[^0-9Xx]", "", issn)
        return f"https://www.scimagojr.com/journalsearch.php?q={bare}&tip=iss"
    if title:
        from urllib.parse import quote

        return f"https://www.scimagojr.com/journalsearch.php?q={quote(title)}&tip=jou"
    return "https://www.scimagojr.com/journalrank.php"


def lookup_scimago(
    issn: str | None = None,
    title: str | None = None,
    year: int | None = None,
    subject: str | None = None,
) -> dict[str, Any] | None:
    qs = ScimagoJournal.objects.all()
    if year:
        qs = qs.filter(year=year)
        # The dump held here covers only the years it was loaded for, so an
        # older paper falls through to the newest table available. That is a
        # reasonable answer and a bad one to give silently, so the result says
        # which year it came from and whether that is the year asked for.

    journal = None
    variants = issn_variants(issn)
    if variants:
        q = Q()
        for v in variants:
            q |= Q(issn__iexact=v) | Q(eissn__iexact=v)
        journal = qs.filter(q).order_by("-year").first()
        if not journal:
            journal = ScimagoJournal.objects.filter(q).order_by("-year").first()

    if not journal and title:
        # Case-insensitive contains, then rough normalize match over recent dump rows
        needle = title[:80]
        journal = qs.filter(title__icontains=needle).order_by("-year").first()
        if not journal:
            journal = (
                ScimagoJournal.objects.filter(title__icontains=needle).order_by("-year").first()
            )
        if not journal:
            nt = normalize_title(title)
            key = nt[:48] if nt else ""
            if key:
                candidates = (
                    ScimagoJournal.objects.filter(title__icontains=key.split()[0] if key.split() else key)
                    .order_by("-year")[:120]
                )
                for row in candidates:
                    if titles_rough_match(title, row.title, min_overlap=0.55):
                        journal = row
                        break

    if not journal:
        return None

    try:
        categories = json.loads(journal.categories_json)
        if isinstance(categories, str):
            categories = parse_categories_field(categories)
    except Exception:
        categories = parse_categories_field(journal.categories_json)

    matched = match_subject_quartile(categories, subject)
    return {
        "found": True,
        "title": journal.title,
        "issn": journal.issn,
        "eissn": journal.eissn,
        "sjr": journal.sjr,
        "year": journal.year,
        "categories": categories,
        "matched_quartile": matched.get("quartile"),
        "matched_category": matched.get("category"),
        "source": "official_dump",
        "dataset_year": journal.year,
        "requested_year": year,
        "year_exact": (year is None) or (journal.year == year),
        "citation": SCIMAGO_CITATION,
        "official_url": scimago_official_search_url(issn=journal.issn, title=journal.title),
        "message": None,
    }


def engineering_class(aggregation_type: str | None, subjects: str | None) -> str:
    if not aggregation_type and not subjects:
        return "Pending"
    if (aggregation_type or "") != "Journal":
        return "Engineering"
    hay = subjects or ""
    needles = [
        "Engineering",
        "Computer Science",
        "Material Science",
        "Material Sciences",
        "Materials Science",
        "Materials Sciences",
        "Decision Science",
        "Energy",
        "Chemical Engineering",
    ]
    for n in needles:
        if n.lower() in hay.lower():
            return "Engineering"
    return "Non-Engineering"


def sjr_quartile_label(scimago: dict[str, Any] | None) -> str:
    if not scimago or not scimago.get("found"):
        return "Not Found"
    q = scimago.get("matched_quartile")
    if not q:
        return "No Quartile"
    return q
