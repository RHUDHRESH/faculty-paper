"""One-shot verify: Scopus + Scimago + already-paid."""
from __future__ import annotations

from datetime import date

import json
from typing import Any

from django.db.models import Q

from core.models import Claim, ClaimStatus, PriorPayment, SnipSource
from core.services.normalize import (
    normalize_doi,
    normalize_issn,
    normalize_title,
    title_tokens,
    titles_rough_match,
)
from core.services.scimago import (
    engineering_class,
    issn_variants,
    lookup_scimago,
    scimago_official_search_url,
)
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
    # All matching narrows in the database first. The old version scanned the
    # first 400 prior payments and 80 paid claims in Python, so a genuine
    # duplicate past those rows produced no warning at all.
    matches: list[dict[str, Any]] = []
    seen: set[str] = set()

    def add(
        source: str,
        obj_id: str,
        paper_title: str | None,
        amount: float | None,
        *,
        reference: str | None = None,
        who: str | None = None,
        when: str | None = None,
    ) -> None:
        if obj_id not in seen:
            seen.add(obj_id)
            matches.append({
                "source": source,
                "id": obj_id,
                "title": paper_title,
                "amount": amount,
                # What the approver would look up: a ticket number or the ERP
                # claim ref, the person paid, and the month it was settled.
                "reference": reference,
                "who": who,
                "when": when,
            })

    def from_claim(c) -> dict:
        return {
            "reference": c.ticket_number,
            "who": c.owner.name if c.owner_id else None,
            "when": c.payout_month.strftime("%Y-%m") if c.payout_month else None,
        }

    def from_prior(m) -> dict:
        return {
            "reference": m.claim_ref,
            "who": m.faculty_name,
            "when": m.paid_at.strftime("%Y-%m") if m.paid_at else None,
        }

    def paid_claims():
        qs = Claim.objects.filter(status=ClaimStatus.PAID).select_related("owner")
        if exclude_claim_id:
            qs = qs.exclude(pk=exclude_claim_id)
        return qs

    if doi:
        d = normalize_doi(doi)
        if d:
            for m in PriorPayment.objects.filter(doi__iexact=d)[:10]:
                add("prior", m.id, m.paper_title, m.amount_paid, **from_prior(m))
            for c in paid_claims().filter(doi__iexact=d)[:10]:
                add("claim", c.id, c.paper_title, c.remuneration, **from_claim(c))
    if title:
        nt = normalize_title(title)
        if nt:
            # Exact normalized-title hits are indexed lookups on both tables.
            for m in PriorPayment.objects.filter(normalized_title=nt)[:10]:
                add("prior", m.id, m.paper_title, m.amount_paid, **from_prior(m))
            for c in paid_claims().filter(normalized_title=nt)[:10]:
                add("claim", c.id, c.paper_title, c.remuneration, **from_claim(c))
            # Rough matching runs only over DB-narrowed candidates: rows that
            # share at least one of the title's most distinctive tokens.
            tokens = sorted(title_tokens(title), key=len, reverse=True)[:3]
            if tokens:
                cond = Q()
                for t in tokens:
                    cond |= Q(normalized_title__icontains=t)
                prior_candidates = (
                    PriorPayment.objects.exclude(normalized_title="")
                    .exclude(normalized_title__isnull=True)
                    .filter(cond)[:50]
                )
                for m in prior_candidates:
                    if m.id not in seen and titles_rough_match(title, m.paper_title):
                        add("prior", m.id, m.paper_title, m.amount_paid, **from_prior(m))
                for c in paid_claims().filter(cond)[:50]:
                    if c.id not in seen and titles_rough_match(title, c.paper_title):
                        add("claim", c.id, c.paper_title, c.remuneration, **from_claim(c))
    return {"warning": len(matches) > 0, "matches": matches[:15]}


def check_journal_standing(
    *,
    issn: str | None,
    published_on: str | None = None,
    publication_year: int | None = None,
) -> dict[str, Any]:
    """Was this journal still recognised when the paper came out?

    Answers three different things, and says which:

    - unknown: no list has been loaded, so nothing can be claimed either way.
      Reported honestly rather than as a pass, because "we did not check" and
      "we checked and it was fine" are not the same sentence.
    - listed: the sources hold it and have not removed it.
    - removed: a source dropped it. Whether that matters depends on when --
      a paper published before the removal was in a recognised journal at the
      time, which is the question the policy actually asks.
    """
    from core.models import JournalStanding

    out: dict[str, Any] = {"checked": False, "issues": [], "sources": []}
    variants = issn_variants(issn)
    if not variants:
        return out
    rows = list(JournalStanding.objects.filter(issn__in=variants))
    if not JournalStanding.objects.exists():
        out["message"] = "No journal list has been loaded, so standing was not checked"
        return out

    out["checked"] = True
    published = None
    if published_on:
        try:
            published = date.fromisoformat(published_on[:10])
        except ValueError:
            published = None
    if published is None and publication_year:
        # Without a day, the end of the year is the cautious reading: it asks
        # whether the journal was still listed by the time the paper was out.
        published = date(int(publication_year), 12, 31)

    for row in rows:
        out["sources"].append({
            "source": row.source,
            "listed": row.listed,
            "changed_on": row.changed_on.isoformat() if row.changed_on else None,
            "reason": row.reason,
        })
        if row.listed:
            continue
        label = row.get_source_display()
        if row.changed_on and published and published < row.changed_on:
            # Dropped later. Worth knowing, not worth blocking.
            out.setdefault("notes", []).append(
                f"{label}: removed on {row.changed_on.isoformat()}, after this paper was published"
            )
        else:
            when = f" on {row.changed_on.isoformat()}" if row.changed_on else ""
            out["issues"].append(
                f"The journal was removed from the {label}{when}"
            )
    return out


def verify_publication(
    *,
    title: str,
    scopus_author_url: str | None = None,
    scopus_author_id: str | None = None,
    issn: str | None = None,
    staff_id: str | None = None,
    exclude_claim_id: str | None = None,
    publication_year: int | None = None,
    publication_date: str | None = None,
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
        snip_source = None
        if issn_use:
            serial = lookup_serial_by_issn(issn_use)
            if serial and serial.get("snip") is not None:
                snip = serial["snip"]
                snip_source = "SCOPUS"
            if snip is None:
                snip = lookup_snip_dump(issn_use, paper.get("journal_title"))
                if snip is not None:
                    snip_source = "SNIP_DUMP"
        out["snip"] = snip
        out["snip_source"] = snip_source

        scimago = lookup_scimago(
            issn=issn_use,
            title=paper.get("journal_title"),
            # The policy pays on the quartile the journal held when the paper
            # came out, not on today's.
            year=publication_year or paper.get("publication_year"),
        )
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
    out["standing"] = check_journal_standing(
        # The ISSN the index returned when it had one, else what was typed.
        issn=(out.get("paper") or {}).get("issn") or issn,
        published_on=publication_date,
        publication_year=publication_year,
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

    # Verified values carry their provenance. A miss clears the previous value
    # unless an admin entered it manually — otherwise a stale or injected
    # number would quietly survive into the payout.
    if result.get("snip") is not None:
        claim.snip = float(result["snip"])
        claim.snip_source = result.get("snip_source") or "SCOPUS"
    elif claim.snip_source != "MANUAL":
        claim.snip = None
        claim.snip_source = None
    scimago = result.get("scimago") or {}
    if scimago.get("found") and scimago.get("quartile"):
        claim.quartile = scimago["quartile"]
        claim.quartile_source = "SCIMAGO"
        claim.scimago_verified = True
        claim.scimago_sjr = scimago.get("sjr")
        claim.scimago_categories_json = json.dumps(scimago.get("categories") or [])
        claim.scimago_dataset_year = scimago.get("year")
    elif claim.quartile_source != "MANUAL":
        claim.quartile = None
        claim.quartile_source = None
        claim.scimago_verified = False
    if result.get("engineering_class"):
        claim.engineering_class = result["engineering_class"]
    if result.get("subjects"):
        claim.subjects_json = result["subjects"]
    claim.normalized_title = normalize_title(claim.paper_title)[:512]

    paid = result.get("paid") or {}
    claim.duplicate_warning = bool(paid.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid.get("matches") or [])
    return claim
