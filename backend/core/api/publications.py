"""The publication record: every member's papers, co-authors and connections.

Open to everybody signed in: a publication record is public research, and
none of it carries money -- every payload still leaves through
`hod.without_money`, so an amount added to a model later cannot leak here.
The data is built by `harvest_publications` / `match_authors`
(core.services.publications); see frontend2/API.md, "Publication record".
"""

from __future__ import annotations

import json
from typing import Optional

from django.db.models import Prefetch, Q
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.models import (AuditLog, Authorship, Claim, ClaimStatus, PaidLedger, Publication, PublicationMetrics,
                         Role, User)
from core.services import coauthors as graph
from core.services import publications as pubs
from core.services.normalize import normalize_doi, normalize_title
from core.services.remuneration import MAX_ELIGIBLE_AUTHORS

SORTS = {
    "year": ("-year", "-date", "title"),
    "oldest": ("year", "date", "title"),
    "citations": ("-citations", "-year"),
    "title": ("title",),
}


def _person(user_id: str) -> User:
    return get_object_or_404(User, id=user_id)


def _metrics(user: User) -> dict:
    row = PublicationMetrics.objects.filter(user=user).first()
    if row is None:
        data = pubs.metrics_for(user.id)
        data["computed_at"] = None
        return data
    return {
        "total_publications": row.total_publications,
        "total_citations": row.total_citations,
        "h_index": row.h_index,
        "i10_index": row.i10_index,
        "first_year": row.first_year,
        "last_year": row.last_year,
        "computed_at": row.computed_at.isoformat() if row.computed_at else None,
    }


def _pub_dict(p: Publication, user: User) -> dict:
    authors = sorted(p.authorships.all(), key=lambda a: (a.position is None, a.position or 0))
    mine = next((a for a in authors if a.user_id == user.id), None)
    return {
        "id": p.id,
        "title": p.title,
        "year": p.year,
        "date": p.date.isoformat() if p.date else None,
        "venue": p.venue,
        "issn": p.issn,
        "type": p.type,
        "quartile": p.quartile or None,
        "doi": p.doi,
        "eid": p.eid,
        "openalex_id": p.openalex_id,
        "citations": p.citations,
        "citations_refreshed_at": p.citations_refreshed_at.isoformat() if p.citations_refreshed_at else None,
        "oa_url": p.oa_url or None,
        "topics": json.loads(p.topics_json or "[]"),
        "source": p.source,
        "scopus_indexed": bool(getattr(p, "scopus_indexed", False)),
        "author_position": mine.position if mine else None,
        "total_authors": sum(1 for a in authors if a.position is not None) or len(authors),
        "match_confidence": mine.match_confidence if mine else None,
        "authors": [
            {
                "name": a.display_name,
                "position": a.position,
                "user_id": a.user_id,
                "key": graph.node_of(a.user_id, a.author_key),
                "is_college": a.is_college or bool(a.user_id),
                "institution": a.institution_name or None,
                "country": a.institution_country or None,
                "orcid": a.orcid or None,
            }
            for a in authors
        ],
        "claim_ids": [c.id for c in p.claims.all() if c.owner_id == user.id],
    }


def _publications(user: User, *, year=None, year_from=None, year_to=None, type=None, quartile=None,
                  q=None, sort="year"):
    if sort not in SORTS:
        raise HttpError(400, "Sort by year, oldest, citations or title.")
    qs = Publication.objects.filter(authorships__user=user).distinct()
    if year:
        qs = qs.filter(year=year)
    if year_from:
        qs = qs.filter(year__gte=year_from)
    if year_to:
        qs = qs.filter(year__lte=year_to)
    if type:
        qs = qs.filter(type__iexact=type)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if q:
        qs = qs.filter(title__icontains=q)
    qs = qs.order_by(*SORTS[sort]).prefetch_related(
        Prefetch("authorships", queryset=Authorship.objects.all()), "claims"
    )
    return [_pub_dict(p, user) for p in qs]


def _claims_only(user: User, *, year=None, year_from=None, year_to=None, type=None, quartile=None,
                 q=None, sort="year") -> list[dict]:
    """Papers known only from a recognised claim or ledger row -- the same
    `person_record` count Home and the Impact card use -- as record entries."""
    from core.services.person_record import papers_for
    out = []
    for p in papers_for(user):
        if p.source != "claims":
            continue
        if (year and p.year != year) or (year_from and (p.year or 0) < year_from) \
                or (year_to and (p.year or 9999) > year_to) or type \
                or (quartile and (p.quartile or "").lower() != quartile.lower()) \
                or (q and q.lower() not in (p.title or "").lower()):
            continue
        out.append({
            "id": f"claim-{len(out) + 1}", "title": p.title, "year": p.year, "date": p.on.isoformat() if p.on else None,
            "venue": p.venue or None, "issn": None, "type": None, "quartile": p.quartile, "doi": None,
            "eid": None, "openalex_id": None, "citations": p.citations, "citations_refreshed_at": None,
            "oa_url": None, "topics": [], "source": "claim", "author_position": p.position,
            "total_authors": 0, "match_confidence": None, "authors": [], "claim_ids": [],
        })
    return out


def _record(user: User, **filters) -> dict:
    items = _publications(user, **filters) + _claims_only(user, **filters)
    metrics = _metrics(user)
    if not any(filters.get(k) for k in ("year", "year_from", "year_to", "type", "quartile", "q")):
        metrics["total_publications"] = len(items)
    return hod.without_money({
        "user": {"id": user.id, "name": user.name, "department": user.department,
                 "scopus_author_id": user.scopus_author_id, "orcid": user.orcid_id},
        "metrics": metrics,
        "count": len(items),
        "publications": items,
    })


_NOT_FILED = (ClaimStatus.REJECTED,)


class _ClaimIndex:
    """My live claims, findable by the paper's links, DOI, EID or title."""

    def __init__(self, user: User):
        self.claims = list(user.claims.exclude(status__in=_NOT_FILED))
        self.by_id = {c.id: c for c in self.claims}
        self.by_doi = {c.doi.lower(): c for c in self.claims if c.doi}
        self.by_eid = {c.eid: c for c in self.claims if c.eid}
        self.by_title = {c.normalized_title: c for c in self.claims if c.normalized_title}

    def find(self, p: dict):
        for cid in p.get("claim_ids") or []:
            if cid in self.by_id:
                return self.by_id[cid]
        return ((p["doi"] and self.by_doi.get(p["doi"].lower())) or (p["eid"] and self.by_eid.get(p["eid"]))
                or self.by_title.get(normalize_title(p["title"] or "")))


class _LedgerIndex:
    """My rows on the paid ledger -- by staff id, linked to my claim, or linked
    to one of my papers -- findable by paper, DOI (from the imported sheet row)
    or title. A paper paid through the ERP has no claim, but it is filed."""

    def __init__(self, user: User):
        cond = Q(claim__owner=user) | Q(publications__authorships__user=user)
        for sid in {user.staff_id, getattr(user, "employee_id", None)} - {None, ""}:
            cond |= Q(staff_id__iexact=sid.strip())
        self.my_ids = {s.strip().lower() for s in {user.staff_id, getattr(user, "employee_id", None)} - {None, ""}}
        rows = {r.id: r for r in PaidLedger.objects.filter(cond).distinct()
                .only("id", "claim_id", "payout_month", "paper_title", "raw_json", "amount", "staff_id")}
        self.by_pub: dict = {}
        for rid, pid in PaidLedger.publications.through.objects.filter(paidledger_id__in=rows) \
                .values_list("paidledger_id", "publication_id"):
            self.by_pub.setdefault(pid, rows[rid])
        self.by_doi: dict = {}
        self.by_title: dict = {}
        for row in rows.values():
            try:
                raw = json.loads(row.raw_json or "{}")
            except (ValueError, TypeError):
                raw = {}
            if not isinstance(raw, dict):
                raw = {}
            doi = normalize_doi(next((str(v) for k, v in raw.items() if "doi" in str(k).lower() and v), ""))
            title = normalize_title(str(row.paper_title or raw.get("Scopus Article Title") or ""))
            if doi:
                self.by_doi.setdefault(doi.lower(), row)
            if title:
                self.by_title.setdefault(title, row)

    def is_mine(self, row) -> bool:
        """The row pays me (not a co-author) -- only then may its amount be shown."""
        return (row.staff_id or "").strip().lower() in self.my_ids

    def find(self, p: dict):
        d = normalize_doi(p.get("doi") or "")
        return (self.by_pub.get(p.get("id")) or (d and self.by_doi.get(d.lower()))
                or self.by_title.get(normalize_title(p.get("title") or "")))


def _waiting_since(c):
    stamps = [c.director_approved_at, c.principal_approved_at, c.cleared_at, c.submitted_at]
    return next((s for s in stamps if s), None) or c.updated_at


def claim_state(p: dict, index: _ClaimIndex, ledger: Optional[_LedgerIndex] = None) -> dict:
    """The claim fields for one of *my* papers. Money only once paid. A paper
    paid through the ledger (often before this app) is filed and paid -- the
    rule the filing page's Scopus pull uses, so every count agrees."""
    c = index.find(p)
    total = p.get("total_authors") or 0
    eligible = total <= MAX_ELIGIBLE_AUTHORS
    claim = None
    if c is not None:
        paid = c.status == ClaimStatus.PAID
        since = None if paid or c.status == ClaimStatus.DRAFT else _waiting_since(c)
        claim = {"id": c.id, "stage": c.status,
                 "days_waiting": (timezone.now() - since).days if since else None,
                 **({"amount": c.remuneration} if paid else {})}
    elif ledger is not None and (row := ledger.find(p)) is not None:
        claim = {"id": row.claim_id, "stage": ClaimStatus.PAID, "days_waiting": None,
                 **({"amount": row.amount} if ledger.is_mine(row) else {}),
                 "paid_month": row.payout_month.isoformat()[:7] if row.payout_month else None}
    return {"claim": claim, "eligible": eligible,
            "ineligible_reason": None if eligible else f"More than {MAX_ELIGIBLE_AUTHORS} authors"}


def unclaimed_count(user: User) -> int:
    """Eligible papers on my record with no live claim -- Home's `unclaimed`
    and the My papers "Not claimed" tab read the same rule."""
    index, ledger = _ClaimIndex(user), _LedgerIndex(user)
    return sum(1 for p in _publications(user)
               if (s := claim_state(p, index, ledger))["claim"] is None and s["eligible"])


@api.get("/me/publications", auth=session_auth)
def my_publications(request: HttpRequest, year: Optional[int] = None, year_from: Optional[int] = None,
                    year_to: Optional[int] = None, type: Optional[str] = None, quartile: Optional[str] = None,
                    q: Optional[str] = None, sort: str = "year"):
    """My full publication record, newest first, with co-authors and metrics.
    Each paper also carries `claim` (my own claim on it: id, stage,
    days_waiting, amount once paid -- added after the money filter, since it
    is the caller's own) and `eligible` / `ineligible_reason`."""
    user = require_user(request)
    out = _record(user, year=year, year_from=year_from, year_to=year_to, type=type, quartile=quartile, q=q,
                  sort=sort)
    index, ledger = _ClaimIndex(user), _LedgerIndex(user)
    for p in out["publications"]:
        p.update(claim_state(p, index, ledger))
        if p["source"] == "claim":
            # Known only from a recognised claim or the paid ledger: filed, never "unclaimed".
            p["eligible"], p["ineligible_reason"] = True, None
            if p["claim"] is None:
                p["claim"] = {"id": None, "stage": ClaimStatus.PAID, "days_waiting": None}
    out["unclaimed"] = sum(1 for p in out["publications"] if p["claim"] is None and p["eligible"])
    return out


@api.get("/people/{user_id}/publications", auth=session_auth)
def person_publications(request: HttpRequest, user_id: str, year: Optional[int] = None,
                        year_from: Optional[int] = None, year_to: Optional[int] = None,
                        type: Optional[str] = None, quartile: Optional[str] = None,
                        q: Optional[str] = None, sort: str = "year"):
    """One member's full publication record. `sort`: year | oldest | citations | title."""
    require_user(request)
    return _record(_person(user_id), year=year, year_from=year_from, year_to=year_to, type=type,
                   quartile=quartile, q=q, sort=sort)


@api.get("/people/{user_id}/publication-metrics", auth=session_auth)
def person_publication_metrics(request: HttpRequest, user_id: str):
    """Total papers, citations, h-index, i10-index, first and last year."""
    require_user(request)
    person = _person(user_id)
    return {"user_id": person.id, **_metrics(person)}


@api.get("/people/{user_id}/coauthors", auth=session_auth)
def person_coauthors(request: HttpRequest, user_id: str):
    """Everyone this member has written with, inside and outside the college."""
    require_user(request)
    return hod.without_money(graph.coauthors(_person(user_id)))


@api.get("/people/{user_id}/connection", auth=session_auth)
def person_connection(request: HttpRequest, user_id: str, to: str):
    """Shortest co-author paths (up to 3 papers long) from this member to `to`
    -- a user id or an external author key -- with the connecting papers."""
    require_user(request)
    source = f"u:{_person(user_id).id}"
    target = graph.resolve_node(to)
    if target is None:
        raise HttpError(404, "Nobody in the publication record has that id or author key.")
    return {"from": source, "to": target, **graph.connection(source, target)}


@api.get("/search/people-external", auth=session_auth)
def search_people_external(request: HttpRequest, q: str = "", limit: int = 20):
    """Co-authors outside the roster by name, with who in the college wrote with them."""
    require_user(request)
    return {"q": q, "results": graph.search_external(q, limit=max(1, min(limit, 50)))}


def _viewer_or(request: HttpRequest, user_id: str) -> User:
    user = require_user(request)
    return user if user_id == "me" else _person(user_id)


@api.get("/people/{user_id}/ego", auth=session_auth)
def person_ego(request: HttpRequest, user_id: str, limit: int = graph.EGO_MAX):
    """This member, their co-authors and their co-authors' co-authors: at most
    60 people, for the Map on Who to work with. Never the whole college."""
    return hod.without_money(graph.ego(_viewer_or(request, user_id), limit=limit))


@api.get("/people/{user_id}/why", auth=session_auth)
def person_why(request: HttpRequest, user_id: str, of: Optional[str] = None):
    """Why `of` (a user id or external author key; default: this member)
    might matter to a reader -- counted from the record. `?for=<user id>`
    (office roles only) asks on someone else's behalf; `for=me` or no `for`
    means the signed-in viewer."""
    from core import discussions

    viewer = require_user(request)
    who = (request.GET.get("for") or "me").strip()
    if who not in ("me", viewer.id):
        if not discussions.is_office(viewer.role):
            raise HttpError(403, "Only the office can ask on someone else's behalf.")
        viewer = _person(who)
    target = graph.resolve_node(of or user_id)
    if target is None:
        raise HttpError(404, "Nobody in the publication record has that id or author key.")
    return {"for": f"u:{viewer.id}", "about": target, **graph.why(target, f"u:{viewer.id}")}


@api.get("/external-person", auth=session_auth)
def external_person(request: HttpRequest, key: str):
    """An author outside the roster: name, institution, their papers with
    college authors, and who at the college connects to them."""
    require_user(request)
    body = graph.external_person(key)
    if body is None:
        raise HttpError(404, "Nobody outside the roster has that author key.")
    return hod.without_money(body)


class DisputeIn(Schema):
    reason: str
    duplicate_of: Optional[str] = None


@api.post("/me/publications/{pub_id}/dispute", auth=session_auth)
def dispute_my_publication(request: HttpRequest, pub_id: str, payload: DisputeIn):
    """Report a paper on my record as not mine, or a duplicate. Recorded for the
    research cell to review; the record itself is not changed here."""
    user = require_user(request)
    if payload.reason not in ("not_mine", "duplicate"):
        raise HttpError(400, "Reason is not_mine or duplicate.")
    pub = get_object_or_404(Publication, id=pub_id, authorships__user=user)
    AuditLog.objects.create(actor=user, action="PUBLICATION_DISPUTED", entity="Publication", entity_id=pub.id,
                            detail_json=json.dumps(payload.dict()))
    return {"ok": True}


@api.get("/me/scopus-pull", auth=session_auth)
def my_scopus_pull(request: HttpRequest):
    """My papers as the record holds them, each marked with whether I have
    already filed a claim for it -- step 1 of filing ("Pull from Scopus")."""
    user = require_user(request)
    items = _publications(user)
    mine = list(user.claims.exclude(status__in=_NOT_FILED).values("id", "doi", "eid", "normalized_title", "status"))
    by_doi = {c["doi"].lower(): c for c in mine if c["doi"]}
    by_eid = {c["eid"]: c for c in mine if c["eid"]}
    by_title = {c["normalized_title"]: c for c in mine if c["normalized_title"]}
    ledger = _LedgerIndex(user)
    out = []
    for p in items:
        claim = None
        if p["claim_ids"]:
            claim = next((c for c in mine if c["id"] in p["claim_ids"]), None)
        claim = claim or (p["doi"] and by_doi.get(p["doi"].lower())) or (p["eid"] and by_eid.get(p["eid"])) \
            or by_title.get(normalize_title(p["title"]))
        paid = None if claim else ledger.find(p)
        out.append({
            "publication_id": p["id"],
            "title": p["title"],
            "venue": p["venue"],
            "issn": p["issn"],
            "year": p["year"],
            "date": p["date"],
            "type": p["type"],
            "doi": p["doi"],
            "eid": p["eid"],
            "citations": p["citations"],
            "author_position": p["author_position"],
            "total_authors": p["total_authors"],
            "authors": [a["name"] for a in p["authors"] if a["position"] is not None] or [a["name"] for a in p["authors"]],
            "already_claimed": claim is not None or paid is not None,
            "claim_id": claim["id"] if claim else (paid.claim_id if paid else None),
            "claim_status": claim["status"] if claim else (ClaimStatus.PAID if paid else None),
            # Paid through the ledger (often before this app): nothing to file.
            "on_paid_ledger": paid is not None,
            "paid_month": paid.payout_month.isoformat()[:7] if paid and paid.payout_month else None,
        })
    return hod.without_money({"count": len(out), "unclaimed": sum(1 for o in out if not o["already_claimed"]),
                              "papers": out})


@api.get("/me/publications/{pub_id}/evidence", auth=session_auth)
def my_publication_evidence(request: HttpRequest, pub_id: str):
    """What the record says about one of my papers, for the three conditions
    of filing. Read-only facts: they never tick a box for the claimant."""
    user = require_user(request)
    pub = get_object_or_404(Publication.objects.prefetch_related("authorships", "claims"), id=pub_id)
    mine = next((a for a in pub.authorships.all() if a.user_id == user.id), None)
    if mine is None:
        raise HttpError(404, "This paper is not on your record.")
    p = _pub_dict(pub, user)
    # Any filed claim for this article, by anybody -- a co-author's counts.
    d = normalize_doi(pub.doi or "")
    nt = normalize_title(pub.title or "")
    cond = Q(publications=pub)
    if d:
        cond |= Q(doi__iexact=d)
    if nt:
        cond |= Q(normalized_title=nt)
    existing = (Claim.objects.filter(cond).exclude(status__in=(*_NOT_FILED, ClaimStatus.DRAFT))
                .select_related("owner").order_by("submitted_at", "created_at").first())
    paid = _LedgerIndex(user).find(p)
    affiliation = (mine.raw_affiliation or mine.institution_name or "").strip()
    return hod.without_money({
        "publication_id": pub.id,
        "title": pub.title,
        "doi": pub.doi,
        "scopus_eid": pub.eid or None,
        "openalex_id": pub.openalex_id or None,
        "source": pub.source,
        "lists_me": True,
        "my_position": mine.position,
        "total_authors": p["total_authors"],
        "affiliation_found": bool(mine.is_college),
        "affiliation_text": affiliation or None,
        "existing_claim": {
            "id": existing.id,
            "ticket_number": existing.ticket_number,
            "owner": existing.owner.name if existing.owner_id else None,
            "is_mine": existing.owner_id == user.id,
            "status": existing.status,
            "filed_at": (existing.submitted_at or existing.created_at).isoformat(),
        } if existing else None,
        "paid_ledger": {
            "paid_month": paid.payout_month.isoformat()[:7] if paid.payout_month else None,
            "claim_id": paid.claim_id,
        } if paid else None,
    })


class HarvestIn(Schema):
    since: Optional[int] = None
    limit: Optional[int] = None
    expand: bool = True


def _super_admin(request: HttpRequest) -> User:
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin may run the publication harvest.")
    return user


@api.post("/admin/publications/harvest", auth=session_auth)
def admin_queue_harvest(request: HttpRequest, payload: HarvestIn):
    """Queue a harvest from OpenAlex (production has no shell)."""
    user = _super_admin(request)
    from django_q.tasks import async_task

    job_id = async_task("core.tasks.harvest_publications", payload.since, payload.limit, payload.expand,
                        timeout=3 * 3600)
    AuditLog.objects.create(actor=user, action="PUBLICATION_HARVEST_QUEUED", entity="Publication",
                            detail_json=json.dumps({**payload.dict(), "job_id": job_id}))
    return {"ok": True, "queued": True, "job_id": job_id}


@api.post("/admin/publications/scopus-sync", auth=session_auth)
def admin_queue_scopus_sync(request: HttpRequest, limit: Optional[int] = None):
    """Queue the Scopus AU-ID sync for every member with a Scopus id."""
    from django.conf import settings

    user = _super_admin(request)
    if not getattr(settings, "SCOPUS_API_KEY", ""):
        raise HttpError(400, "SCOPUS_API_KEY is not set on this server.")
    from django_q.tasks import async_task

    job_id = async_task("core.tasks.sync_scopus_authors", limit, timeout=6 * 3600)
    AuditLog.objects.create(actor=user, action="SCOPUS_SYNC_QUEUED", entity="Publication",
                            detail_json=json.dumps({"limit": limit, "job_id": job_id}))
    return {"ok": True, "queued": True, "job_id": job_id}


@api.get("/admin/publications/status", auth=session_auth)
def admin_publication_status(request: HttpRequest):
    """What the record holds, and the college authors nobody could be matched to."""
    _super_admin(request)
    college = Authorship.objects.filter(is_college=True)
    unmatched = (
        college.filter(user__isnull=True).values_list("display_name", flat=True).order_by("display_name").distinct()
    )
    last = AuditLog.objects.filter(action__startswith="PUBLICATION_HARVEST").order_by("-created_at").first()
    return {
        "publications": Publication.objects.count(),
        "authorships": Authorship.objects.count(),
        "college_authorships": college.count(),
        "college_matched": college.filter(user__isnull=False).count(),
        "users_with_publications": PublicationMetrics.objects.filter(total_publications__gt=0).count(),
        "unmatched_college_names": list(unmatched[:500]),
        "last_run": {"action": last.action, "at": last.created_at.isoformat() if last.created_at else None,
                     "detail": json.loads(last.detail_json or "{}")} if last else None,
    }


__all__ = [
    "my_publications",
    "person_publications",
    "person_publication_metrics",
    "person_coauthors",
    "person_connection",
    "search_people_external",
    "my_scopus_pull",
    "my_publication_evidence",
    "admin_queue_harvest",
    "admin_queue_scopus_sync",
    "admin_publication_status",
]
