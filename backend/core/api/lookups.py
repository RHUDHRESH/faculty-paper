"""lookups.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _require_may_see_money, api, logger, session_auth
from core.api.schemas import CalcIn, CandidateSearchIn, PriorCheckIn, ScimagoLookupIn, ScopusLookupIn, VerifyIn
from core.api.common import require_user

import uuid as uuid_lib
from typing import Any
from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db.models import Count, Q
from django.http import HttpRequest
from ninja import File, UploadedFile
from ninja.errors import HttpError
from core.models import Claim, ClaimAttachment, ClaimStatus, FormulaConfig
from core.services import rbac
from core.services.normalize import normalize_doi, normalize_issn
from core.services.remuneration import CATEGORY_LABELS, calculate_remuneration, formula_from_model, snapshot_formula
from core.services.scimago import lookup_scimago
from core.services.scopus import ScopusError, extract_author_id, lookup_paper_by_doi, lookup_serial_by_issn, search_by_title, search_candidates
from core.services.search import papers as search_papers
from core.services.pdfmeta import content_digest, guess_title
from core.services.uploads import ACCEPTED_LABEL, sniff
from core.services.verify import check_already_paid, verify_publication

# ---------- lookups ----------

# When Scopus cannot answer, the filing wizard still finds the paper: Crossref
# is the DOI registry, needs no key, and is already how the search box finds
# papers (core.services.search.papers). What it returns is what the publisher
# *declared* -- title, journal, ISSN, year, authors -- and is marked
# `source: "crossref"`, `verified: false`. Nothing here is priced: the amount is
# only ever computed from the values verification writes at submission, which
# a Crossref record cannot supply.
#
# `scopus_status` says why Scopus did not answer, because the two reasons
# have different remedies: "not_configured" (no key -- a setting to fix) and
# "unavailable" (a key, and an error -- try again later). "ok" when it answered.

_CROSSREF_TYPES = {
    "journal-article": "Journal",
    "proceedings-article": "Conference Proceeding",
    "book-chapter": "Book Chapter",
    "book": "Book",
}


def _scopus_failure() -> str:
    """Why a ScopusError was raised: no key at all, or a key and an error.

    Scopus is always asked first -- with no key it refuses at once, before
    any request is made -- so this is decided after the fact rather than by
    skipping the call.
    """
    return "unavailable" if search_papers.scopus_configured() else "not_configured"


def _declared(hit: dict[str, Any]) -> dict[str, Any]:
    """A Crossref record in the shape the Scopus lookups return."""
    return {
        "title": hit.get("title") or None,
        "doi": hit.get("doi"),
        "issn": hit.get("issn"),
        "journal_title": hit.get("journal") or None,
        "publication_year": hit.get("publication_year"),
        "cover_date": hit.get("publication_date"),
        "aggregation_type": _CROSSREF_TYPES.get(hit.get("type") or "", hit.get("type")),
        "author_count": hit.get("author_count"),
        "authors": [a for a in hit.get("authors") or [] if a],
        "eid": None,
        "scopus_url": None,
        "source": "crossref",
        "verified": False,
    }


def _crossref_records(state: str, *, doi: str | None, title: str | None, limit: int = 1) -> list[dict[str, Any]]:
    """Crossref's records for a DOI or a title. 502 if Crossref is down too."""
    try:
        hits = []
        if doi:
            hit = search_papers.fetch_crossref_work(doi)
            hits = [hit] if hit else []
        if not hits and title:
            # As the Scopus path does: a DOI the registry does not know, and
            # a title beside it, is a title search.
            hits = search_papers.fetch_crossref(title, max(1, limit))[:limit]
    except Exception:
        logger.warning("crossref_fallback_failed scopus_status=%s", state, exc_info=True)
        why = "is not configured" if state == "not_configured" else "could not be reached"
        raise HttpError(
            502,
            f"{state}: Scopus {why}, and Crossref did not answer either. Enter the "
            "details by hand, or try again shortly.",
        )
    return [_declared(h) for h in hits]


@api.post("/lookup/scopus", auth=session_auth)
def lookup_scopus(request: HttpRequest, payload: ScopusLookupIn):
    require_user(request)
    try:
        paper = None
        if payload.doi:
            paper = lookup_paper_by_doi(payload.doi)
        elif payload.title:
            paper, _ = search_by_title(payload.title)
        else:
            return {"ok": False, "code": "bad_payload", "message": "DOI or title required", "paper": None, "serial": None}
        if not paper:
            return {"ok": False, "code": "not_found", "message": "No Scopus match", "paper": None, "serial": None}
        serial = None
        issn = paper.get("issn") or payload.issn
        if issn:
            serial = lookup_serial_by_issn(issn)
        return {"ok": True, "code": "ok", "message": None, "paper": paper, "serial": serial}
    except ScopusError as e:
        raise HttpError(502, f"{e.code}: {e}")


@api.post("/lookup/candidates", auth=session_auth)
def lookup_candidates(request: HttpRequest, payload: CandidateSearchIn):
    """Search Scopus and hand back the matches for the claimant to choose from.

    Linkage is resolved in one extra query (AU-ID AND TITLE) rather than one per
    row: the claim rules require the article to sit on the author's own Scopus
    profile, so which candidates are already linked is the deciding detail.
    """
    user = require_user(request)
    title = (payload.title or "").strip()
    doi = normalize_doi(payload.doi) if payload.doi else None
    # Fall back to the caller's own profile so "show me my papers" needs no
    # arguments at all — the Scopus ID is already on the account.
    author_id = (
        (payload.author_id or "").strip()
        or extract_author_id(payload.scopus_author_url or "")
        or (user.scopus_author_id or "").strip()
        or extract_author_id(user.scopus_author_url or "")
        or ""
    )
    # Author-only is the "show me everything on my profile" mode.
    by_author_only = not title and not doi and bool(author_id)
    if not title and not doi and not author_id:
        return {
            "ok": False,
            "code": "bad_payload",
            "message": "Enter a title or DOI, or set your Scopus author link, to search",
            "author_id": None,
            "candidates": [],
        }

    limit = max(1, min(payload.limit or 10, 25))
    state = "ok"
    found: list[dict[str, Any]] = []
    linked_eids: set[str] = set()
    try:
        if by_author_only:
            # Newest first — a claim is nearly always for a recent paper.
            found = search_candidates(author_id=author_id, limit=limit, sort="-coverDate")
            linked_eids = {str(c.get("eid")) for c in found if c.get("eid")}
        else:
            found = search_candidates(title=title or None, doi=doi, limit=limit)
            if author_id and found:
                linked = search_candidates(
                    title=title or None, doi=doi, author_id=author_id, limit=limit
                )
                linked_eids = {str(c.get("eid")) for c in linked if c.get("eid")}
    except ScopusError as e:
        state = _scopus_failure()
        logger.warning("lookup_candidates_scopus_failed code=%s scopus_status=%s", e.code, state)
        found, linked_eids = [], set()
    if state != "ok":
        why = "is not configured" if state == "not_configured" else "could not be reached"
        if by_author_only:
            # Crossref knows nothing of Scopus author profiles.
            return {
                "ok": False,
                "code": state,
                "message": (
                    f"Scopus {why}, so papers cannot be listed from a Scopus author "
                    "profile. Search by title or DOI instead."
                ),
                "author_id": author_id,
                "by_author": True,
                "candidates": [],
                "scopus_status": state,
            }
        found = _crossref_records(state, doi=doi, title=title or None, limit=limit)

    # Rule 2 of the submission conditions is one claim per article, and the
    # claimant cannot see their own filed tickets from here — so say it on the row.
    dois = [d for d in (c.get("doi") for c in found) if d]
    eids = [e for e in (c.get("eid") for c in found) if e]
    claimed_q = Q()
    if dois:
        claimed_q |= Q(doi__in=dois)
    if eids:
        claimed_q |= Q(eid__in=eids)
    claimed_dois: set[str] = set()
    claimed_eids: set[str] = set()
    if claimed_q:
        # Only an admin proxy may ask about someone else's claims; for anyone
        # else owner_id is ignored rather than trusted.
        owner = user.id
        if payload.owner_id and rbac.can_clear_claims(user.role):
            owner = payload.owner_id
        for c in Claim.objects.filter(claimed_q, owner_id=owner).exclude(
            status=ClaimStatus.REJECTED
        ).only("doi", "eid"):
            if c.doi:
                claimed_dois.add(c.doi)
            if c.eid:
                claimed_eids.add(c.eid)

    candidates = [
        {
            "title": c.get("title"),
            "doi": c.get("doi"),
            "issn": c.get("issn"),
            "eid": c.get("eid"),
            "journal_title": c.get("journal_title"),
            "publication_year": c.get("publication_year"),
            "cover_date": c.get("cover_date"),
            "aggregation_type": c.get("aggregation_type"),
            "author_count": c.get("author_count"),
            "scopus_url": c.get("scopus_url"),
            # None (not False) when we have no author ID to check against --
            # or no Scopus to check it with -- so the UI can say "unknown"
            # instead of wrongly claiming "not linked".
            "linked_to_author": (
                (str(c.get("eid")) in linked_eids) if author_id and state == "ok" else None
            ),
            "already_claimed": bool(
                (c.get("doi") and c["doi"] in claimed_dois)
                or (c.get("eid") and c["eid"] in claimed_eids)
            ),
            "authors": c.get("authors") or [],
            "source": c.get("source") or "scopus",
            "verified": c.get("source") != "crossref",
        }
        for c in found
    ]
    return {
        "scopus_status": state,
        "source": "scopus" if state == "ok" else "crossref",
        "ok": bool(candidates),
        "code": "ok" if candidates else "not_found",
        "message": None
        if candidates
        else (
            "No papers found on that Scopus author profile"
            if by_author_only
            else "No Scopus record matched that search"
            if state == "ok"
            else "No Crossref record matched that search"
        ),
        "author_id": author_id,
        "by_author": by_author_only,
        "candidates": candidates,
    }


def _empty_enrich(*, code: str, message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "code": code,
        "message": message,
        "paper": None,
        "serial": None,
        "scimago": None,
        "matched_title": None,
        "doi": None,
        "issn": None,
        "eid": None,
        "journal": None,
        "cover_date": None,
        "publication_year": None,
        "aggregation_type": None,
        "author_count": None,
        "snip": None,
        "snip_year": None,
        "quartile": None,
        "subject_category": None,
        "scimago_found": False,
    }


def _pack_enrich(paper: dict[str, Any] | None, serial: dict[str, Any] | None, scimago: dict[str, Any] | None) -> dict[str, Any]:
    paper = paper or {}
    serial = serial or {}
    scimago = scimago or {}
    found_scimago = bool(scimago.get("found"))
    return {
        "ok": True,
        "code": "ok",
        "message": None,
        "paper": paper or None,
        "serial": serial or None,
        "scimago": scimago or None,
        "matched_title": paper.get("title"),
        "doi": paper.get("doi"),
        "issn": paper.get("issn") or serial.get("issn") or scimago.get("issn"),
        "eid": paper.get("eid"),
        "journal": paper.get("journal_title") or serial.get("journal_title") or scimago.get("title"),
        "cover_date": paper.get("cover_date"),
        "publication_year": paper.get("publication_year"),
        "aggregation_type": paper.get("aggregation_type"),
        "author_count": paper.get("author_count"),
        "snip": serial.get("snip"),
        "snip_year": serial.get("snip_year"),
        "quartile": scimago.get("matched_quartile") if found_scimago else None,
        "subject_category": scimago.get("matched_category") if found_scimago else None,
        "scimago_found": found_scimago,
    }


@api.post("/lookup/enrich", auth=session_auth)
def lookup_enrich(request: HttpRequest, payload: ScopusLookupIn):
    """One-shot: Scopus paper + SNIP + Scimago quartile for the claim form.

    DOI or title finds the article. ISSN alone still fills journal, SNIP, and quartile.
    """
    require_user(request)
    issn = normalize_issn(payload.issn) if payload.issn else None
    if not payload.doi and not payload.title and not issn:
        return _empty_enrich(code="bad_payload", message="Provide DOI, title, or ISSN")
    try:
        paper = lookup_paper_by_doi(payload.doi) if payload.doi else None
        if not paper and payload.title:
            paper, _ = search_by_title(payload.title)
        issn = (paper.get("issn") if paper else None) or issn
        serial = lookup_serial_by_issn(issn) if issn else None
        scimago = lookup_scimago(
            issn=issn,
            title=(paper.get("journal_title") if paper else None) or payload.title,
            subject=None,
        )
        if not paper and not serial and not (scimago and scimago.get("found")):
            return {
                **_empty_enrich(code="not_found", message="Not found in Scopus"),
                "scopus_status": "ok",
            }
        return {
            **_pack_enrich(paper, serial, scimago),
            "source": "scopus",
            "verified": True,
            "scopus_status": "ok",
        }
    except ScopusError as e:
        state = _scopus_failure()
        logger.warning("lookup_enrich_scopus_failed code=%s scopus_status=%s", e.code, state)

    # Scopus did not answer: the declared record from Crossref, and whatever
    # our own Scimago table holds for the journal it names.
    found = _crossref_records(state, doi=payload.doi, title=payload.title)
    paper = found[0] if found else None
    issn = (paper.get("issn") if paper else None) or issn
    scimago = lookup_scimago(
        issn=issn,
        title=(paper.get("journal_title") if paper else None) or payload.title,
        subject=None,
    )
    why = "is not configured" if state == "not_configured" else "could not be reached"
    if not paper and not (scimago and scimago.get("found")):
        return {
            **_empty_enrich(code="not_found", message=f"Scopus {why}, and Crossref has no match"),
            "source": "crossref",
            "verified": False,
            "scopus_status": state,
        }
    return {
        **_pack_enrich(paper, None, scimago),
        "message": (
            f"Scopus {why}, so these details are the publisher's own, from "
            "Crossref. They are checked against the index when the claim is filed."
        ),
        "authors": (paper or {}).get("authors") or [],
        "source": "crossref" if paper else "scimago",
        "verified": False,
        "scopus_status": state,
    }


@api.post("/lookup/scimago", auth=session_auth)
def lookup_scimago_api(request: HttpRequest, payload: ScimagoLookupIn):
    require_user(request)
    result = lookup_scimago(
        issn=payload.issn, title=payload.title, year=payload.year, subject=payload.subject
    )
    if result is None:
        from core.services.scimago import scimago_official_search_url

        return {
            "found": False,
            "matched_quartile": None,
            "official_url": scimago_official_search_url(issn=payload.issn, title=payload.title),
            "message": "No match in imported Scimago dump — import CSV or set quartile manually",
        }
    return result


@api.post("/lookup/verify", auth=session_auth)
def lookup_verify(request: HttpRequest, payload: VerifyIn):
    # The response embeds the same paid-history block as /prior/check.
    _require_may_see_money(request)
    if not (payload.title or "").strip():
        raise HttpError(400, "Title is required")
    result = verify_publication(
        title=payload.title.strip(),
        scopus_author_url=payload.scopus_author_url,
        scopus_author_id=payload.scopus_author_id,
        issn=payload.issn,
        staff_id=payload.staff_id,
        exclude_claim_id=payload.exclude_claim_id,
    )
    # No Crossref fallback here: verification is exactly the thing a declared
    # value cannot satisfy. It only says why Scopus did not confirm it.
    # verify_publication reports a ScopusError as ok=False rather than raising.
    state = "ok" if result.get("ok") else _scopus_failure()
    return {**result, "scopus_status": state}


def _zero_payout_note(payload: CalcIn, result, cfg) -> str | None:
    """Why a valid calculation still came out at nothing.

    "Base Amount: Rs. 0.00" with no error next to it reads as a broken formula.
    Every zero here is a policy outcome, so name which one it was.
    """
    if result.error or result.remuneration is None or result.remuneration > 0:
        return None
    if payload.is_student_publication:
        return (
            "Count-only submissions carry no incentive — the ticket still runs through "
            "approval so the publication is counted."
        )
    q = (payload.quartile or "").strip()
    snip = payload.snip
    if q == "NO_SNIP":
        return "The quartile is set to NO_SNIP, whose quartile factor is zero in the active policy."
    if not snip:
        qf = result.qf or 0
        if qf == 0:
            return (
                f"SNIP is {snip if snip is not None else 'empty'} and the quartile factor for "
                f"{q or 'this quartile'} is ₹0 in the active policy, so SNIP × "
                f"{(cfg.snip_multiplier if cfg else 55000):g} + QF comes to zero."
            )
        return "SNIP is zero, so the amount is the quartile factor alone."
    return "The active policy produces no payable amount for this combination."


@api.post("/calculate", auth=session_auth)
def calculate(request: HttpRequest, payload: CalcIn):
    _require_may_see_money(request)
    cfg_obj = FormulaConfig.objects.filter(active=True).order_by("-updated_at").first()
    cfg = formula_from_model(cfg_obj) if cfg_obj else None
    result = calculate_remuneration(
        payload.snip,
        payload.quartile,
        payload.total_authors,
        payload.author_position,
        cfg,
        is_student_publication=payload.is_student_publication,
        publication_type=payload.publication_type,
        indexing_level=payload.indexing_level,
        engineering_class=payload.engineering_class,
        sec_reference_count=payload.sec_reference_count,
    )
    return {
        "base": result.base,
        "point": result.point,
        "remuneration": result.remuneration,
        "qf": result.qf,
        "error": result.error,
        # The engine now explains itself; _zero_payout_note stays as a fallback
        # for combinations it has nothing to say about.
        "note": result.note or _zero_payout_note(payload, result, cfg),
        "category": result.category,
        "category_label": CATEGORY_LABELS.get(result.category or "", None),
        "policy": snapshot_formula(cfg) if cfg else None,
    }


@api.post("/prior/check", auth=session_auth)
def prior_check(request: HttpRequest, payload: PriorCheckIn):
    # Every match carries the amount a named colleague was paid and when. A
    # head of department must not see a rupee figure by any route, and this
    # route hands one over for any title somebody cares to type.
    _require_may_see_money(request)
    result = check_already_paid(
        title=payload.title,
        doi=payload.doi,
        staff_id=payload.staff_id,
        exclude_claim_id=payload.exclude_claim_id,
    )
    return result


MAX_UPLOAD_BYTES = 10 * 1024 * 1024


@api.post("/claims/upload", auth=session_auth)
def upload_claim_file(request: HttpRequest, file: UploadedFile = File(...)):
    """Store one evidence file, identified by its own bytes.

    The old check was `name.endswith(".pdf")`, which accepted anything renamed
    and rejected the scans and photos people actually hold. Sniffing decides
    both whether we take the file and what extension it is stored under, so
    what comes back out is what went in.
    """
    user = require_user(request)
    if not rbac.can_issue_claims(user.role):
        raise HttpError(403, "Forbidden")
    content = file.read()
    if not content:
        raise HttpError(400, "That file is empty")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HttpError(400, "File too large (max 10MB)")

    kind = sniff(content)
    if kind is None:
        raise HttpError(
            400,
            f"That file is not a {ACCEPTED_LABEL}. "
            "Renaming a file does not change its type — export or scan it instead.",
        )

    # Through the storage API, not open(): the same code then writes to the
    # local disk in development and to Google Cloud Storage in production,
    # where the container filesystem does not survive a deploy.
    fname = f"{uuid_lib.uuid4().hex}.{kind.extension}"
    default_storage.save(f"claims/{fname}", ContentFile(content))

    # The file's own fingerprint, so the same document is recognised however it
    # was renamed. Two references that are really one page scanned twice is the
    # common case; the same paper already used on another claim is the one worth
    # stopping.
    digest = content_digest(content)
    seen = (
        ClaimAttachment.objects.filter(content_hash=digest)
        .select_related("claim", "claim__owner")
        .first()
    )
    duplicate = None
    if seen:
        duplicate = {
            "claim_id": seen.claim_id,
            "ticket_number": seen.claim.ticket_number,
            "filename": seen.filename,
            "uploaded_at": seen.created_at.isoformat(),
            "same_owner": seen.claim.owner_id == user.id,
            "owner_name": seen.claim.owner.name,
        }

    return {
        "url": f"{settings.MEDIA_URL}claims/{fname}",
        # The claimant's own name, shown in the UI; the stored name is a uuid.
        "filename": (file.name or f"document.{kind.extension}")[:255],
        "size_bytes": len(content),
        "content_type": kind.content_type,
        "kind_label": kind.label,
        "content_hash": digest,
        # A suggestion for the title box, never written to the claim on its own:
        # a wrong title picked up silently is worse than an empty field.
        "suggested_title": guess_title(content),
        "duplicate_of": duplicate,
    }




__all__ = [
    'MAX_UPLOAD_BYTES',
    '_CROSSREF_TYPES',
    '_crossref_records',
    '_declared',
    '_empty_enrich',
    '_pack_enrich',
    '_scopus_failure',
    '_zero_payout_note',
    'calculate',
    'lookup_candidates',
    'lookup_enrich',
    'lookup_scimago_api',
    'lookup_scopus',
    'lookup_verify',
    'prior_check',
    'upload_claim_file',
]
