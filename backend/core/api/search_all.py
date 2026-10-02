"""One box over everything the college itself knows: /api/search/all.

docs/ux/02-search.md. A server-side fan-out that answers the search page and
the Ctrl-K palette with grouped, ranked results in one round trip. Local
tables only -- people, the publication record, claims, journals, topics and
departments -- so it is fast; the literature (Crossref/OpenAlex) stays on
/api/search and /api/research/search. Pages and actions are resolved on the
client from nav.ts.

Permissions, each enforced here rather than trusted to the client:

- No money, to anybody: no amount key is ever built, and the payload still
  leaves through `hod.without_money`.
- Claims by role: a faculty member finds only their own claims and reads the
  claimant's stage (never a desk's status or names); a head finds their
  department's, translated by `hod.progress_of`; the desks find the college's.
- A head's people are their department's (`visible_users`), as everywhere.
"""

from __future__ import annotations

import re
from typing import Any

from django.conf import settings
from django.db.models import Count, Q
from django.http import HttpRequest
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.models import Authorship, Claim, ClaimStatus, Publication, ResearchInterest, Role, User
from core.services import claim_numbers, coauthors as graph
from core.services import discover as discover_service
from core.services.normalize import normalize_doi
from core.services.search.people import visible_users
from core.visibility import faculty_stage

SCOPES = {
    "all": ("person", "paper", "claim", "journal", "topic", "department"),
    "people": ("person",),
    "papers": ("paper", "claim"),
    "journals": ("journal",),
    "topics": ("topic",),
    "departments": ("department",),
    "pages": (),
}
DOI_RE = re.compile(r"^(https?://(dx\.)?doi\.org/)?10\.\d+/\S+$")


def _rank(text: str, q: str) -> int:
    t = (text or "").lower()
    if t == q:
        return 0
    if t.startswith(q):
        return 1
    if any(w.startswith(q) for w in t.split()):
        return 2
    return 3


def _claims_for(viewer: User):
    scope = Claim.objects.select_related("owner").exclude(status=ClaimStatus.DRAFT, ticket_number__isnull=True)
    role = viewer.role
    if role == Role.FACULTY:
        return Claim.objects.select_related("owner").filter(owner=viewer)
    if role == Role.HOD:
        dept = hod.department_of(viewer)
        mine = Q(owner=viewer)
        return Claim.objects.select_related("owner").filter(
            mine | Q(owner__department__iexact=dept) if dept else mine
        )
    return scope


def _claim_item(c: Claim, viewer: User) -> dict[str, Any]:
    own = c.owner_id == viewer.id
    if own or viewer.role == Role.FACULTY:
        status = faculty_stage(c.status, rejected_outright=c.rejected_outright,
                               ticket_number=c.ticket_number)
    elif viewer.role == Role.HOD:
        status = hod.progress_of(c.status)
    else:
        # Staff read the outcome in words, never the status code.
        status = claim_numbers.outcome(c)["label"]
    who = None if own else (c.owner.name if c.owner_id else None)
    return {
        "id": c.id,
        "title": c.paper_title or "(untitled)",
        "subtitle": " · ".join(str(x) for x in (c.ticket_number, c.journal_title, c.publication_year, who) if x),
        # A claim waiting at one of the asker's desks opens for review.
        "url": claim_numbers.review_url(viewer, c) or f"/papers/{c.id}",
        "chips": [status] + (["Yours"] if own else []),
        "meta": {"ticket_number": c.ticket_number, "status": status, "mine": own, "doi": c.doi},
    }


def _people(q: str, viewer: User, limit: int) -> dict[str, Any]:
    match = Q(name__icontains=q)
    if viewer.role in (Role.SUPER_ADMIN, Role.RESEARCH_CELL, Role.RESEARCH_COORDINATOR):
        # The office is asked "who is TSSH008?" as often as "who is Anandan?":
        # a staff ID or a Scopus author ID finds the person exactly.
        match |= Q(staff_id__iexact=q) | Q(scopus_author_id__exact=q)
    users = visible_users(viewer).filter(match)
    total = users.count()
    rows = list(users.values("id", "name", "department", "designation", "photo")[:200])
    counts = dict(
        Authorship.objects.filter(user_id__in=[r["id"] for r in rows])
        .values_list("user_id").annotate(n=Count("publication", distinct=True))
    )
    rows.sort(key=lambda r: (_rank(r["name"], q), -counts.get(r["id"], 0), r["name"] or ""))
    items = [
        {
            "id": r["id"],
            "title": r["name"],
            "subtitle": " · ".join(x for x in (r["department"], r["designation"]) if x),
            "url": f"/people/{r['id']}",
            "chips": ["Saveetha"],
            "meta": {"external": False, "department": r["department"], "designation": r["designation"],
                     "papers": counts.get(r["id"], 0), "connect": r["id"],
                     "photo_url": f"{settings.MEDIA_URL}{r['photo']}" if r["photo"] else None},
            "secondary_action": {"label": "Message", "url": f"/messages?to={r['id']}"},
        }
        for r in rows[:limit]
    ]
    external = graph.search_external(q, limit=limit)
    for e in external:
        inst = (e.get("institutions") or [None])[0]
        cos = e.get("college_coauthors") or []
        items.append({
            "id": e["key"],
            "title": e["name"],
            "subtitle": inst or ("Saveetha (former)" if e.get("college_affiliated") else "External co-author"),
            "url": f"/people/{cos[0]['user_id']}" if cos else "",
            "chips": [inst or "External"],
            "meta": {"external": True, "papers": e.get("papers", 0), "connect": e["key"],
                     "college_coauthors": cos[:3], "countries": e.get("countries", [])},
        })
    return {"kind": "person", "total": total + len(external), "items": items[: limit * 2], "status": "ok"}


def _papers(q: str, viewer: User, limit: int) -> dict[str, Any]:
    doi = normalize_doi(q) if DOI_RE.search(q) else None
    match = Q(doi__iexact=doi) if doi else (Q(title__icontains=q) | Q(venue__icontains=q))
    qs = Publication.objects.filter(match)
    total = qs.count()
    mine_ids = set(Authorship.objects.filter(user=viewer).values_list("publication_id", flat=True))
    cands = list(qs.order_by("-year", "-citations")[:200])
    cands.sort(key=lambda p: (p.id not in mine_ids, _rank(p.title, q), -(p.year or 0), -p.citations))
    cands = cands[:limit]
    authors: dict[str, list] = {}
    for a in Authorship.objects.filter(publication__in=cands).order_by("position"):
        authors.setdefault(a.publication_id, []).append(a)
    claimed = set(
        Claim.objects.filter(publications__in=cands).exclude(status=ClaimStatus.REJECTED)
        .values_list("publications", flat=True)
    )
    items = []
    for p in cands:
        al = authors.get(p.id, [])
        mine = p.id in mine_ids
        items.append({
            "id": p.id,
            "title": p.title,
            "subtitle": " · ".join(str(x) for x in (p.venue, p.year) if x),
            "url": f"/research?tab=me&paper={p.id}" if mine else (f"https://doi.org/{p.doi}" if p.doi else ""),
            "chips": (["Yours"] if mine else []) + ([p.quartile] if p.quartile else []),
            "meta": {
                "venue": p.venue, "year": p.year, "quartile": p.quartile or None, "doi": p.doi,
                "citations": p.citations, "mine": mine, "claimed": p.id in claimed,
                "source": p.source,
                "authors": [{"name": a.display_name, "user_id": a.user_id, "you": a.user_id == viewer.id}
                            for a in al[:12]],
                "total_authors": len(al),
            },
            "secondary_action": {"label": "Copy DOI", "copy": p.doi} if p.doi else None,
        })
    return {"kind": "paper", "total": total, "items": items, "status": "ok"}


def _claims(q: str, viewer: User, limit: int) -> dict[str, Any]:
    doi = normalize_doi(q) if DOI_RE.search(q) else None
    forms = claim_numbers.variants(q)
    match = Q(ticket_number__iexact=q) | Q(paper_title__icontains=q)
    if len(q) >= 3:
        match |= Q(voucher_number__iexact=q)  # a payment is found by its voucher
    for form in forms:
        match |= Q(ticket_number__iexact=form)
        # A claim number typed in part ("fp-2026-0001", "erp-proc") is a prefix.
        if claim_numbers.looks_like_claim_number(q):
            match |= Q(ticket_number__istartswith=form)
    if doi:
        match |= Q(doi__iexact=doi)
    qs = _claims_for(viewer).filter(match)
    total = qs.count()
    wanted = {f.lower() for f in forms} | {q}

    def number_rank(c: Claim) -> int:
        t = (c.ticket_number or "").lower()
        if t in wanted:
            return 0
        return 1 if any(t.startswith(w) for w in wanted) else 2

    rows = sorted(qs.order_by("-created_at")[:100], key=lambda c: (number_rank(c), _rank(c.paper_title, q)))
    return {"kind": "claim", "total": total, "items": [_claim_item(c, viewer) for c in rows[:limit]],
            "status": "ok"}


def _journals(q: str, limit: int) -> dict[str, Any]:
    from core.services.search.venues import search_local
    try:
        rows = search_local(q, limit=limit)
    except Exception:  # noqa: BLE001 -- a missing Scimago year is a partial answer, not a 500
        return {"kind": "journal", "total": 0, "items": [], "status": "error"}
    rows.sort(key=lambda r: _rank(r["title"], q))
    colleagues = dict(
        Publication.objects.filter(venue__in=[r["title"] for r in rows], authorships__user__isnull=False)
        .values_list("venue").annotate(n=Count("authorships__user", distinct=True))
    )
    return {"kind": "journal", "total": len(rows), "status": "ok", "items": [
        {
            "id": r["issn"] or r["title"],
            "title": r["title"],
            "subtitle": " · ".join(str(x) for x in (r.get("publisher"), r.get("subject")) if x),
            "url": f"/journals/{r['title']}",
            "chips": [r["quartile"]] if r.get("quartile") else [],
            "meta": {"quartile": r.get("quartile"), "snip": r.get("snip"), "issn": r.get("issn"),
                     "subject": r.get("subject"), "colleagues": colleagues.get(r["title"], 0)},
        }
        for r in rows
    ]}


def _topics(q: str, limit: int) -> dict[str, Any]:
    names = discover_service.research_domains(q, limit)
    names.sort(key=lambda n: _rank(n, q))
    counts = dict(
        ResearchInterest.objects.filter(domain__in=names).values_list("domain")
        .annotate(n=Count("user", distinct=True))
    )
    return {"kind": "topic", "total": len(names), "status": "ok", "items": [
        {"id": n, "title": n, "subtitle": f"{counts.get(n, 0)} people list this as an interest",
         "url": f"/search?scope=people&q={n}", "chips": [], "meta": {"people": counts.get(n, 0)}}
        for n in names[:limit]
    ]}


def _departments(q: str, viewer: User, limit: int) -> dict[str, Any]:
    rows = list(
        visible_users(viewer).filter(department__icontains=q).exclude(department="")
        .values("department").annotate(n=Count("id")).order_by("-n")
    )
    rows.sort(key=lambda r: _rank(r["department"], q))
    return {"kind": "department", "total": len(rows), "status": "ok", "items": [
        {"id": r["department"], "title": r["department"], "subtitle": f"{r['n']} people",
         "url": f"/search?scope=people&dept={r['department']}", "chips": [], "meta": {"people": r["n"]}}
        for r in rows[:limit]
    ]}


def _exact(q: str, viewer: User) -> dict[str, Any] | None:
    if DOI_RE.search(q):
        doi = normalize_doi(q)
        claim = _claims_for(viewer).filter(doi__iexact=doi).first()
        if claim:
            return {"kind": "claim", **_claim_item(claim, viewer)}
        pub = Publication.objects.filter(doi__iexact=doi).first()
        if pub:
            return {"kind": "paper", "id": pub.id, "title": pub.title,
                    "subtitle": " · ".join(str(x) for x in (pub.venue, pub.year) if x),
                    "url": f"https://doi.org/{pub.doi}", "chips": ["In the record"], "meta": {"doi": pub.doi}}
        return {"kind": "doi", "id": doi, "title": doi, "subtitle": "Not in the college's record yet",
                "url": f"/papers/new?doi={doi}", "chips": ["Not claimed"], "meta": {"doi": doi}}
    for form in claim_numbers.variants(q):
        claim = _claims_for(viewer).filter(ticket_number__iexact=form).first()
        if claim:
            return {"kind": "claim", **_claim_item(claim, viewer)}
    return None


@api.get("/search/all", auth=session_auth)
def search_all(request: HttpRequest, q: str = "", scope: str = "all", limit: int = 5):
    """Grouped, ranked results across the college's own data. See module doc."""
    viewer = require_user(request)
    if scope not in SCOPES:
        raise HttpError(400, "Scope is one of: " + ", ".join(SCOPES))
    q = " ".join((q or "").split())[:200]
    limit = max(1, min(limit, 50))
    if len(q) < 2:
        return {"q": q, "scope": scope, "exact": None, "groups": []}
    ql = q.lower()
    kinds = SCOPES[scope]
    runners = {
        "person": lambda: _people(ql, viewer, limit),
        "paper": lambda: _papers(ql, viewer, limit),
        "claim": lambda: _claims(ql, viewer, limit),
        "journal": lambda: _journals(ql, limit),
        "topic": lambda: _topics(ql, limit),
        "department": lambda: _departments(ql, viewer, limit),
    }
    groups = []
    for kind in kinds:
        try:
            groups.append(runners[kind]())
        except Exception:  # noqa: BLE001 -- one group failing must not blank the rest
            groups.append({"kind": kind, "total": 0, "items": [], "status": "error"})
    return hod.without_money({"q": q, "scope": scope, "exact": _exact(q, viewer), "groups": groups})
