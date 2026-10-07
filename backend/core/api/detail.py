"""Click anything, get the detail: the panels behind a paper, a journal, a
person and a number.

Every payload here leaves through `hod.without_money`. The claim stage on a
paper is the viewer's own and is shown without its amount: the payments
list and the statement are where money is read, and those keep their own
rules. Nothing here widens who sees a rupee figure.
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Optional

from django.db.models import Prefetch
from django.http import HttpRequest
from ninja.errors import HttpError

from core import hod
from core.api.common import api, require_user, session_auth
from core.models import Authorship, Publication, Role, User
from core.services import rbac

_SCOPUS = "https://www.scopus.com/record/display.uri?origin=resultslist&eid="


def _journal_facts(name: str | None) -> dict:
    from core.services.discover import describe_journal, find_journal

    row = find_journal(name or "") if name else None
    if row is None:
        return {"found": False, "quartile": None, "snip": None, "subject": None, "issn": None}
    d = describe_journal(row)
    return {"found": True, "title": d["title"], "quartile": d["quartile"], "snip": d["snip"],
            "subject": d["subject"], "issn": d["issn"], "sjr": d["sjr"], "dataset_year": d["dataset_year"]}


def _may_see_paper(viewer: User, p: Publication) -> bool:
    authors = list(p.authorships.all())
    if any(a.user_id == viewer.id for a in authors):
        return True
    if rbac.can_view_college_wide(viewer.role):
        return True
    if viewer.role == Role.HOD:
        dept = (viewer.department or "").strip().lower()
        ids = [a.user_id for a in authors if a.user_id]
        return bool(dept) and User.objects.filter(
            id__in=ids, department__iexact=viewer.department.strip()).exists()
    return False


def _strip(viewer: User, body: dict) -> dict:
    # No figures on any panel, for any role: see the module docstring.
    return hod.without_money(body)


@api.get("/papers/{publication_id}/detail", auth=session_auth)
def paper_detail(request: HttpRequest, publication_id: str):
    """One paper: authors (college ones linked), journal facts, citations,
    links out, and the viewer's own claim stage on it. No money."""
    from core.api.publications import _ClaimIndex, _LedgerIndex, _pub_dict, claim_state

    viewer = require_user(request)
    p = (Publication.objects.filter(id=publication_id)
         .prefetch_related(Prefetch("authorships", queryset=Authorship.objects.all()), "claims").first())
    if p is None:
        raise HttpError(404, "No paper on the record has that id.")
    if not _may_see_paper(viewer, p):
        raise HttpError(403, "Only the paper's authors and the college office can open this paper.")
    d = _pub_dict(p, viewer)
    is_author = any(a["user_id"] == viewer.id for a in d["authors"])
    mine = None
    if is_author:
        s = claim_state(d, _ClaimIndex(viewer), _LedgerIndex(viewer))
        c = s["claim"]
        mine = {
            "claim_id": c.get("id") if c else None,
            "stage": c.get("stage") if c else None,
            "days_waiting": c.get("days_waiting") if c else None,
            "eligible": s["eligible"],
            "ineligible_reason": s["ineligible_reason"],
        }
    journal = _journal_facts(d["venue"])
    return _strip(viewer, {
        "id": d["id"], "title": d["title"], "year": d["year"], "date": d["date"], "type": d["type"] or None,
        "venue": d["venue"] or None, "quartile": d["quartile"] or journal.get("quartile"),
        "snip": journal.get("snip"), "citations": d["citations"], "doi": d["doi"] or None,
        "topics": d["topics"],
        "links": {
            "doi": f"https://doi.org/{d['doi']}" if d["doi"] else None,
            "scopus": f"{_SCOPUS}{d['eid']}" if d["eid"] else None,
            "openalex": (d["openalex_id"] if (d["openalex_id"] or "").startswith("http")
                         else f"https://openalex.org/{d['openalex_id']}") if d["openalex_id"] else None,
            "open_access": d["oa_url"],
        },
        "authors": [{"name": a["name"], "position": a["position"], "user_id": a["user_id"],
                     "is_college": a["is_college"], "institution": a["institution"]} for a in d["authors"]],
        "is_author": is_author,
        "mine": mine,
    })


def _row(p: Publication, position: Optional[int] = None) -> dict:
    return {"id": p.id, "title": p.title, "year": p.year, "venue": p.venue or None,
            "quartile": p.quartile or None, "citations": p.citations, "position": position}


@api.get("/journals/detail", auth=session_auth)
def journal_detail(request: HttpRequest, name: str = ""):
    """A journal, for anybody signed in: quartile, SNIP, subject, the
    college's papers there, colleagues who published there and the viewer's
    own. The watch-list entry only for the office. No money."""
    viewer = require_user(request)
    name = (name or "").strip()
    if not name:
        raise HttpError(400, "Name a journal.")
    facts = _journal_facts(name)
    titles = {name}
    if facts.get("title"):
        titles.add(facts["title"])
    q = Publication.objects.none()
    for t in titles:
        q = q | Publication.objects.filter(venue__iexact=t)
    papers = list(q.distinct().order_by("-year", "-citations"))
    if not papers and not facts["found"]:
        raise HttpError(404, "Nothing on the record or in the journal list goes by that name.")
    ids = [p.id for p in papers]
    rows = Authorship.objects.filter(publication_id__in=ids, user__isnull=False).values_list(
        "publication_id", "user_id", "position")
    mine_pos = {pid: pos for pid, uid, pos in rows if uid == viewer.id}
    others = Counter(uid for _, uid, _ in rows if uid != viewer.id)
    people = {u.id: u for u in User.objects.filter(id__in=list(others), active=True)}
    from core.social import person_brief

    colleagues = [{**person_brief(people[uid]), "papers": n}
                  for uid, n in others.most_common() if uid in people][:8]
    watch = None
    if rbac.can_view_college_wide(viewer.role):
        from core.services.journal_watch import watch_for

        hit = watch_for(facts.get("issn"), facts.get("title") or name)
        if hit:
            watch = {"reason": hit.get("reason"), "since": hit.get("created_at")}
    return _strip(viewer, {
        "name": facts.get("title") or (papers[0].venue if papers else name),
        "quartile": facts["quartile"], "snip": facts["snip"], "subject": facts["subject"],
        "issn": facts["issn"], "in_journal_list": facts["found"],
        "college": {"count": len(papers), "papers": [_row(p) for p in papers[:8]]},
        "colleagues": colleagues,
        "colleague_count": len(people),
        "mine": [_row(p, mine_pos[p.id]) for p in papers if p.id in mine_pos],
        "watch": watch,
    })


@api.get("/people/{user_id}/card", auth=session_auth)
def person_card(request: HttpRequest, user_id: str):
    """A compact card: face, department, designation, papers, citations,
    top topics. Public research, the same for every reader."""
    from core.services.person_record import papers_for
    from core.social import person_brief

    viewer = require_user(request)
    person = viewer if user_id == "me" else User.objects.filter(pk=user_id, active=True).first()
    if person is None:
        raise HttpError(404, "No such person.")
    papers = papers_for(person)
    topics: Counter[str] = Counter()
    spelled: dict[str, str] = {}
    for raw in Publication.objects.filter(authorships__user=person).distinct().values_list("topics_json", flat=True):
        try:
            values = json.loads(raw or "[]")
        except ValueError:
            continue
        for t in values if isinstance(values, list) else []:
            if isinstance(t, str) and t.strip():
                k = " ".join(t.lower().split())
                spelled.setdefault(k, t.strip())
                topics[k] += 1
    return _strip(viewer, {
        "person": person_brief(person),
        "is_me": person.id == viewer.id,
        "papers": len(papers),
        "citations": sum(p.citations or 0 for p in papers),
        "topics": [spelled[k] for k, _ in topics.most_common(4)],
    })


_METRICS = ("papers", "citations", "h_index", "year", "quartile", "first_author", "topic", "unfiled")


@api.get("/me/metric/{name}", auth=session_auth)
def my_metric(request: HttpRequest, name: str, year: Optional[int] = None, value: Optional[str] = None):
    """What is behind one of my numbers: the papers that make it up. My own
    record only. `name`: papers | citations | h_index | year (with `year`) |
    quartile (with `value`, e.g. Q1) | first_author | topic (with `value`) |
    unfiled."""
    from core.api.publications import _ClaimIndex, _LedgerIndex, _claims_only, _publications, claim_state
    from core.services.research_picture import h_index

    user = require_user(request)
    if name not in _METRICS:
        raise HttpError(404, "No such number.")
    record = _publications(user)
    items = record + _claims_only(user)

    def row(p: dict) -> dict:
        pid = p["id"] if not str(p["id"]).startswith("claim-") else None
        return {"id": pid, "title": p["title"], "year": p["year"], "venue": p["venue"],
                "quartile": p["quartile"], "citations": p["citations"], "position": p["author_position"]}

    explain = None
    if name == "citations":
        chosen = sorted((p for p in items if p["citations"]), key=lambda p: -(p["citations"] or 0))
        total = sum(p["citations"] or 0 for p in items)
        title = f"{total} citations"
    elif name == "h_index":
        h = h_index(p["citations"] or 0 for p in items)
        chosen = sorted(items, key=lambda p: -(p["citations"] or 0))[:h]
        title = f"h-index {h}"
        explain = f"An h-index of {h} means {h} of your papers have at least {h} citations each."
    elif name == "year":
        if not year:
            raise HttpError(400, "Say which year.")
        chosen = [p for p in items if p["year"] == year]
        title = f"Your papers in {year}"
    elif name == "quartile":
        want = (value or "").strip().upper()
        if want not in ("Q1", "Q2", "Q3", "Q4"):
            raise HttpError(400, "Say which quartile, Q1 to Q4.")
        chosen = [p for p in items if (p["quartile"] or "").upper() == want]
        title = f"Your {want} papers"
    elif name == "first_author":
        chosen = [p for p in items if p["author_position"] == 1]
        title = "Your papers as first author"
    elif name == "topic":
        want = " ".join((value or "").lower().split())
        if not want:
            raise HttpError(400, "Say which topic.")
        chosen = [p for p in record if any(" ".join(str(t).lower().split()) == want for t in p["topics"] or [])]
        title = f"Your papers on {value.strip()}"
    elif name == "unfiled":
        index, ledger = _ClaimIndex(user), _LedgerIndex(user)
        chosen = []
        for p in record:
            s = claim_state(p, index, ledger)
            if s["claim"] is None and s["eligible"]:
                chosen.append(p)
        title = "Ready to file"
        explain = "Papers on your record with no claim yet. File one to start its payment."
    else:
        chosen = list(items)
        title = "Your papers"
    if name not in ("citations", "h_index"):
        chosen = sorted(chosen, key=lambda p: (-(p["year"] or 0), p["title"] or ""))
    return hod.without_money({"name": name, "title": title, "explain": explain, "count": len(chosen),
                              "papers": [row(p) for p in chosen]})
