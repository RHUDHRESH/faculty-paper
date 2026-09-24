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

from django.db.models import Prefetch
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Authorship, ClaimStatus, Publication, PublicationMetrics, Role, User
from core.services import coauthors as graph
from core.services import publications as pubs
from core.services.normalize import normalize_title
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


def _record(user: User, **filters) -> dict:
    items = _publications(user, **filters)
    return hod.without_money({
        "user": {"id": user.id, "name": user.name, "department": user.department,
                 "scopus_author_id": user.scopus_author_id, "orcid": user.orcid_id},
        "metrics": _metrics(user),
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


def _waiting_since(c):
    stamps = [c.director_approved_at, c.principal_approved_at, c.cleared_at, c.submitted_at]
    return next((s for s in stamps if s), None) or c.updated_at


def claim_state(p: dict, index: _ClaimIndex) -> dict:
    """The claim fields for one of *my* papers. Money only once paid."""
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
    return {"claim": claim, "eligible": eligible,
            "ineligible_reason": None if eligible else f"More than {MAX_ELIGIBLE_AUTHORS} authors"}


def unclaimed_count(user: User) -> int:
    """Eligible papers on my record with no live claim -- Home's `unclaimed`
    and the My papers "Not claimed" tab read the same rule."""
    index = _ClaimIndex(user)
    return sum(1 for p in _publications(user)
               if (s := claim_state(p, index))["claim"] is None and s["eligible"])


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
    index = _ClaimIndex(user)
    for p in out["publications"]:
        p.update(claim_state(p, index))
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
    out = []
    for p in items:
        claim = None
        if p["claim_ids"]:
            claim = next((c for c in mine if c["id"] in p["claim_ids"]), None)
        claim = claim or (p["doi"] and by_doi.get(p["doi"].lower())) or (p["eid"] and by_eid.get(p["eid"])) \
            or by_title.get(normalize_title(p["title"]))
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
            "already_claimed": claim is not None,
            "claim_id": claim["id"] if claim else None,
            "claim_status": claim["status"] if claim else None,
        })
    return hod.without_money({"count": len(out), "unclaimed": sum(1 for o in out if not o["already_claimed"]),
                              "papers": out})


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
    "admin_queue_harvest",
    "admin_publication_status",
]
