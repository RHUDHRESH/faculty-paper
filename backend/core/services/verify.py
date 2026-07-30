"""One-shot verify: Scopus + Scimago + already-paid."""
from __future__ import annotations

import json
from typing import Any

from core.models import Claim, ClaimStatus, PriorPayment, SnipSource
from core.services.normalize import (
    normalize_doi,
    normalize_issn,
    normalize_title,
    titles_rough_match,
)
from core.services.scimago import engineering_class, lookup_scimago, scimago_official_search_url
from core.services.scopus import (
    ScopusError,
    check_author_linkage,
    extract_author_id,
    lookup_serial_by_issn,
    search_by_title,
)


def lookup_snip_dump(issn: str | None, title: str | None = None) -> float | None:
    if issn:
        variants = []
        cleaned = normalize_issn(issn)
        if cleaned:
            bare = cleaned.replace("-", "")
            variants = [cleaned, bare]
        for v in variants:
            row = (
                SnipSource.objects.filter(print_issn__iexact=v).first()
                or SnipSource.objects.filter(e_issn__iexact=v).first()
            )
            if row and row.snip is not None:
                return row.snip
    if title:
        row = SnipSource.objects.filter(title__icontains=title[:80]).first()
        if row and row.snip is not None:
            return row.snip
    return None


def check_already_paid(
    *,
    title: str | None,
    doi: str | None = None,
    staff_id: str | None = None,
    exclude_claim_id: str | None = None,
) -> dict[str, Any]:
    matches: list[dict[str, Any]] = []
    if doi:
        d = normalize_doi(doi)
        if d:
            for m in PriorPayment.objects.filter(doi__iexact=d)[:10]:
                matches.append({"source": "prior", "id": m.id, "title": m.paper_title, "amount": m.amount_paid})
            qs = Claim.objects.filter(doi__iexact=d, status=ClaimStatus.PAID)
            if exclude_claim_id:
                qs = qs.exclude(pk=exclude_claim_id)
            for c in qs[:10]:
                matches.append({"source": "claim", "id": c.id, "title": c.paper_title, "amount": c.remuneration})
    if title:
        nt = normalize_title(title)
        if nt:
            # Exact normalized first, then rough case-insensitive overlap
            for m in PriorPayment.objects.filter(normalized_title=nt)[:10]:
                if not any(x["id"] == m.id for x in matches):
                    matches.append({"source": "prior", "id": m.id, "title": m.paper_title, "amount": m.amount_paid})
            for m in PriorPayment.objects.exclude(normalized_title="")[:400]:
                if any(x["id"] == m.id for x in matches):
                    continue
                if titles_rough_match(title, m.paper_title):
                    matches.append({"source": "prior", "id": m.id, "title": m.paper_title, "amount": m.amount_paid})
            qs = Claim.objects.filter(status=ClaimStatus.PAID)
            if exclude_claim_id:
                qs = qs.exclude(pk=exclude_claim_id)
            if staff_id:
                qs = qs.filter(staff_id=staff_id)
            for c in qs[:80]:
                if any(x["id"] == c.id for x in matches):
                    continue
                if titles_rough_match(title, c.paper_title):
                    matches.append({"source": "claim", "id": c.id, "title": c.paper_title, "amount": c.remuneration})
    return {"warning": len(matches) > 0, "matches": matches[:15]}


def verify_publication(
    *,
    title: str,
    scopus_author_url: str | None = None,
    scopus_author_id: str | None = None,
    issn: str | None = None,
    staff_id: str | None = None,
    exclude_claim_id: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "ok": True,
        "scopus": {"indexed": False, "linked": False, "message": None},
        "scimago": {"found": False, "quartile": None, "message": None},
        "paid": {"warning": False, "matches": []},
        "paper": None,
        "snip": None,
        "engineering_class": None,
    }

    author_id = scopus_author_id or extract_author_id(scopus_author_url or "")
    try:
        paper, _raw = search_by_title(title)
    except ScopusError as e:
        out["ok"] = False
        out["scopus"]["message"] = f"{e.code}: {e}"
        return out

    if not paper:
        out["scopus"]["message"] = "Not yet indexed in Scopus"
        out["scopus"]["indexed"] = False
    else:
        out["scopus"]["indexed"] = True
        out["paper"] = paper
        if author_id:
            try:
                linked, _ = check_author_linkage(author_id, title)
                out["scopus"]["linked"] = linked
                out["scopus"]["message"] = "Linked" if linked else "Indexed but author not linked"
            except ScopusError as e:
                out["scopus"]["message"] = f"Indexed; linkage check failed: {e}"
        else:
            out["scopus"]["message"] = "Indexed (no Scopus author ID to check linkage)"

        issn_use = paper.get("issn") or issn
        snip = None
        if issn_use:
            serial = lookup_serial_by_issn(issn_use)
            if serial and serial.get("snip") is not None:
                snip = serial["snip"]
            if snip is None:
                snip = lookup_snip_dump(issn_use, paper.get("journal_title"))
        out["snip"] = snip

        scimago = lookup_scimago(issn=issn_use, title=paper.get("journal_title"))
        if scimago and scimago.get("found"):
            out["scimago"] = {
                "found": True,
                "quartile": scimago.get("matched_quartile"),
                "sjr": scimago.get("sjr"),
                "categories": scimago.get("categories"),
                "year": scimago.get("year"),
                "official_url": scimago.get("official_url"),
                "message": None,
            }
            cats = scimago.get("categories") or []
            subjects = "; ".join(
                f"{c.get('category')} ({c.get('quartile')})" if c.get("quartile") else str(c.get("category") or "")
                for c in cats
            )
            out["engineering_class"] = engineering_class(
                paper.get("aggregation_type"), subjects
            )
            out["subjects"] = subjects
        else:
            out["scimago"] = {
                "found": False,
                "quartile": None,
                "official_url": scimago_official_search_url(issn=issn_use, title=paper.get("journal_title")),
                "message": "No match in Scimago dump — set quartile manually",
            }
            out["engineering_class"] = engineering_class(paper.get("aggregation_type"), None)

    doi = (out.get("paper") or {}).get("doi")
    out["paid"] = check_already_paid(
        title=title, doi=doi, staff_id=staff_id, exclude_claim_id=exclude_claim_id
    )
    return out


def apply_verify_to_claim(claim: Claim, result: dict[str, Any]) -> Claim:
    paper = result.get("paper") or {}
    if paper:
        claim.indexing_status = "Indexed" if result["scopus"]["indexed"] else "Not yet indexed"
        claim.linkage_status = (
            "Linked" if result["scopus"].get("linked") else ("Not Linked" if result["scopus"]["indexed"] else None)
        )
        claim.doi = paper.get("doi") or claim.doi
        claim.eid = paper.get("eid") or claim.eid
        claim.scopus_url = paper.get("scopus_url") or claim.scopus_url
        claim.cover_date = paper.get("cover_date") or claim.cover_date
        claim.aggregation_type = paper.get("aggregation_type") or claim.aggregation_type
        if paper.get("journal_title"):
            claim.journal_title = paper["journal_title"]
        if paper.get("issn"):
            claim.issn = paper["issn"]
        if paper.get("publication_year"):
            claim.publication_year = paper["publication_year"]
        claim.scopus_raw_json = json.dumps(paper.get("raw") or paper)[:200000]
    else:
        claim.indexing_status = "Not yet indexed"

    if result.get("snip") is not None:
        claim.snip = float(result["snip"])
    scimago = result.get("scimago") or {}
    if scimago.get("found") and scimago.get("quartile"):
        claim.quartile = scimago["quartile"]
        claim.scimago_verified = True
        claim.scimago_sjr = scimago.get("sjr")
        claim.scimago_categories_json = json.dumps(scimago.get("categories") or [])
        claim.scimago_dataset_year = scimago.get("year")
    if result.get("engineering_class"):
        claim.engineering_class = result["engineering_class"]
    if result.get("subjects"):
        claim.subjects_json = result["subjects"]

    paid = result.get("paid") or {}
    claim.duplicate_warning = bool(paid.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid.get("matches") or [])
    return claim
