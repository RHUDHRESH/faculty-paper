"""head of department.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _csv_row, api, session_auth
from core.api.deps import require_user

import csv
import io
import json
import time
from typing import Any, Optional
from django.db.models import Count, Q
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimStatus, DepartmentTarget, Role, User
from core import hod

# ---------- head of department ----------




def _require_hod(request: HttpRequest) -> User:
    user = require_user(request)
    if user.role != Role.HOD:
        raise HttpError(403, "Forbidden")
    return user


@api.get("/hod/overview", auth=session_auth)
def hod_overview(request: HttpRequest, year: Optional[int] = None):
    """What the department has published, and by whom. No money anywhere."""
    user = _require_hod(request)
    qs = _hod_scope(user)
    if year:
        qs = qs.filter(publication_year=year)

    def bucket(field: str, blank: str) -> list[dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for value in qs.values_list(field, flat=True):
            key = (str(value).strip() if value not in (None, "") else blank) or blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0})
            slot["count"] += 1
        return sorted(out.values(), key=lambda r: -r["count"])

    # Members of the department, whether or not they have published: a head
    # needs to see who has nothing as much as who has most.
    people = User.objects.filter(
        role=Role.FACULTY, department__iexact=hod.department_of(user)
    ).order_by("name")
    counts = {
        row["owner_id"]: row["n"]
        for row in qs.values("owner_id").annotate(n=Count("id"))
    }
    first_author = {
        row["owner_id"]: row["n"]
        for row in qs.filter(author_position=1).values("owner_id").annotate(n=Count("id"))
    }
    q1 = {
        row["owner_id"]: row["n"]
        for row in qs.filter(quartile__iexact="Q1").values("owner_id").annotate(n=Count("id"))
    }

    years = sorted({y for y in qs.values_list("publication_year", flat=True) if y})
    by_year = []
    if years:
        per = {
            row["publication_year"]: row["n"]
            for row in qs.exclude(publication_year__isnull=True)
            .values("publication_year")
            .annotate(n=Count("id"))
        }
        # Empty years plotted as the zeros they are, not skipped: a gap drawn
        # as a straight line reads as steady output through years with none.
        by_year = [
            {"key": str(y), "count": per.get(y, 0), "amount": 0}
            for y in range(min(years), max(years) + 1)
        ]

    indexing: dict[str, int] = {}
    for raw in qs.values_list("indexing_level", flat=True):
        for part in [p.strip() for p in (raw or "").split(",") if p.strip()] or ["Not stated"]:
            indexing[part] = indexing.get(part, 0) + 1

    return hod.without_money({
        "department": hod.department_of(user),
        "years_on_record": sorted(
            {y for y in _hod_scope(user).values_list("publication_year", flat=True) if y},
            reverse=True,
        ),
        "year": year,
        "totals": {
            "publications": qs.count(),
            "faculty_in_department": people.count(),
            "faculty_who_published": len(counts),
            "q1": qs.filter(quartile__iexact="Q1").count(),
            "first_author": qs.filter(author_position=1).count(),
            "under_review": qs.filter(
                status__in=(ClaimStatus.SUBMITTED, ClaimStatus.CLEARED)
            ).count(),
        },
        "by_year": by_year,
        "by_quartile": bucket("quartile", "Not recorded"),
        "by_type": bucket("aggregation_type", "Not stated"),
        "by_journal": bucket("journal_title", "Not recorded")[:12],
        "by_indexing": sorted(
            ({"key": k, "count": v, "amount": 0} for k, v in indexing.items()),
            key=lambda r: -r["count"],
        ),
        "people": [
            {
                "id": p.id,
                "name": p.name,
                "designation": p.designation,
                "staff_id": p.staff_id,
                "publications": counts.get(p.id, 0),
                "first_author": first_author.get(p.id, 0),
                "q1": q1.get(p.id, 0),
                "active": p.active,
            }
            for p in people
        ],
    })


# ---------- what a head is measured on, and can steer ----------


class TargetIn(Schema):
    year: int
    metric: str
    target: int
    #: Omitted or null sets the target on the department as a whole.
    person_id: Optional[str] = None
    note: Optional[str] = None


def _target_progress(qs, metric: str, person_id: str | None) -> int:
    """How far along a target is, counted the same way every time.

    One function so the number under a departmental target and the number
    under a personal one cannot be arrived at differently -- which is exactly
    how a head ends up with a department at 80% made of people who are each,
    somehow, at 60%.
    """
    scoped = qs.filter(owner_id=person_id) if person_id else qs
    if metric == DepartmentTarget.Metric.Q1:
        return scoped.filter(quartile__iexact="Q1").count()
    if metric == DepartmentTarget.Metric.FIRST_AUTHOR:
        return scoped.filter(author_position=1).count()
    return scoped.count()


@api.get("/hod/targets", auth=session_auth)
def hod_targets(request: HttpRequest, year: Optional[int] = None):
    """Every target this head has set, with where it actually stands.

    Progress is recomputed on read rather than stored. A stored figure is one
    that is wrong from the moment somebody files a paper, and a head checking
    a target is checking it *now*.
    """
    user = _require_hod(request)
    department = hod.department_of(user)
    year = year or timezone.now().year

    qs = _hod_scope(user).filter(publication_year=year)
    rows = (
        DepartmentTarget.objects.filter(department__iexact=department, year=year)
        .select_related("person", "set_by")
        .order_by("person__name", "metric")
    )

    def as_dict(t: DepartmentTarget) -> dict[str, Any]:
        done = _target_progress(qs, t.metric, t.person_id)
        return {
            "id": t.id,
            "year": t.year,
            "metric": t.metric,
            "metric_label": DepartmentTarget.Metric(t.metric).label,
            "target": t.target,
            "done": done,
            "remaining": max(0, t.target - done),
            "fraction": round(done / t.target, 4) if t.target else None,
            "met": done >= t.target,
            "person_id": t.person_id,
            "person_name": t.person.name if t.person_id else None,
            "note": t.note,
            "set_by": t.set_by.name if t.set_by_id else None,
            "updated_at": t.updated_at.isoformat() if t.updated_at else None,
        }

    all_rows = [as_dict(t) for t in rows]
    return hod.without_money({
        "department": department,
        "year": year,
        "department_targets": [r for r in all_rows if r["person_id"] is None],
        "personal_targets": [r for r in all_rows if r["person_id"] is not None],
        "metrics": [
            {"key": m.value, "label": m.label} for m in DepartmentTarget.Metric
        ],
        "years": sorted(
            {y for y in _hod_scope(user).values_list("publication_year", flat=True) if y},
            reverse=True,
        ),
    })


@api.post("/hod/targets", auth=session_auth)
def hod_set_target(request: HttpRequest, payload: TargetIn):
    """Set or change one target. A head may only set them inside their own
    department, and only on somebody who is actually in it."""
    user = _require_hod(request)
    department = hod.department_of(user)

    valid = {m.value for m in DepartmentTarget.Metric}
    if payload.metric not in valid:
        raise HttpError(400, f"Metric must be one of: {', '.join(sorted(valid))}.")
    if payload.target < 0:
        raise HttpError(400, "A target cannot be negative")
    if payload.year < 2000 or payload.year > timezone.now().year + 5:
        raise HttpError(400, "That is not a year this can be set against")

    person = None
    if payload.person_id:
        person = User.objects.filter(pk=payload.person_id).first()
        if person is None:
            raise HttpError(404, "No such person")
        # Checked on the server, not just hidden on the screen: a head setting
        # targets on somebody else's staff is not a filter mistake, it is a
        # different head's business.
        if (person.department or "").strip().lower() != department.lower():
            raise HttpError(
                403, f"{person.name} is not in {department}."
            )

    target, created = DepartmentTarget.objects.update_or_create(
        department=department,
        year=payload.year,
        metric=payload.metric,
        person=person,
        defaults={
            "target": payload.target,
            "note": (payload.note or "").strip() or None,
            "set_by": user,
        },
    )
    AuditLog.objects.create(
        actor=user, action="TARGET_SET", entity="DepartmentTarget", entity_id=target.id,
        detail_json=json.dumps({
            "department": department, "year": payload.year, "metric": payload.metric,
            "target": payload.target, "person": person.id if person else None,
            "created": created,
        }),
    )
    return {"ok": True, "id": target.id, "created": created}


@api.delete("/hod/targets/{target_id}", auth=session_auth)
def hod_delete_target(request: HttpRequest, target_id: str):
    user = _require_hod(request)
    department = hod.department_of(user)
    target = get_object_or_404(DepartmentTarget, pk=target_id)
    if (target.department or "").lower() != department.lower():
        raise HttpError(403, "That target belongs to another department.")
    AuditLog.objects.create(
        actor=user, action="TARGET_DELETE", entity="DepartmentTarget",
        entity_id=target.id,
        detail_json=json.dumps({"metric": target.metric, "year": target.year}),
    )
    target.delete()
    return {"ok": True}


@api.get("/hod/people/{user_id}", auth=session_auth)
def hod_person(request: HttpRequest, user_id: str):
    """One member of this head's department, and what they have published.

    A head could see a list of their staff with counts beside each name and
    could not open any of them: `/api/faculty/{id}/report` needs
    `can_view_reports`, which a head does not have, so every name on their own
    department screen was a dead link. This is the same question asked inside
    the two limits a head works under -- their own department, and no money.

    The scope check is on the person's department, not on a parameter: a head
    asking about somebody else's staff is not a filter, it is a different
    question with a different answer.
    """
    user = _require_hod(request)
    department = hod.department_of(user)
    person = get_object_or_404(User, pk=user_id)

    if (person.department or "").strip().lower() != department.lower():
        raise HttpError(
            403,
            f"{person.name} is not in {department}. A head sees their own department.",
        )

    claims = (
        Claim.objects.filter(owner=person)
        .exclude(status=ClaimStatus.DRAFT)
        .order_by("-publication_year", "-updated_at")
    )

    def bucket(field: str, blank: str) -> list[dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for value in claims.values_list(field, flat=True):
            key = (str(value).strip() if value not in (None, "") else blank) or blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0})
            slot["count"] += 1
        return sorted(out.values(), key=lambda r: -r["count"])

    years = sorted({y for y in claims.values_list("publication_year", flat=True) if y})
    by_year = []
    if years:
        per: dict[int, int] = {}
        for y in claims.values_list("publication_year", flat=True):
            if y:
                per[y] = per.get(y, 0) + 1
        # Empty years drawn as the zeros they are: a gap joined by a straight
        # line reads as steady output through a year with nothing in it.
        by_year = [
            {"key": str(y), "count": per.get(y, 0), "amount": 0}
            for y in range(min(years), max(years) + 1)
        ]

    targets = [
        {
            "id": t.id,
            "year": t.year,
            "metric": t.metric,
            "metric_label": DepartmentTarget.Metric(t.metric).label,
            "target": t.target,
            "done": _target_progress(
                claims.filter(publication_year=t.year), t.metric, person.id
            ),
        }
        for t in DepartmentTarget.objects.filter(
            department__iexact=department, person=person
        ).order_by("-year", "metric")
    ]
    for t in targets:
        t["remaining"] = max(0, t["target"] - t["done"])
        t["met"] = t["done"] >= t["target"]
        t["fraction"] = round(t["done"] / t["target"], 4) if t["target"] else None

    return hod.without_money({
        "person": {
            "id": person.id,
            "name": person.name,
            "email": person.email,
            "department": person.department,
            "designation": person.designation,
            "staff_id": person.staff_id,
            "active": person.active,
        },
        "totals": {
            "publications": claims.count(),
            "q1": claims.filter(quartile__iexact="Q1").count(),
            "first_author": claims.filter(author_position=1).count(),
            "under_review": claims.filter(
                status__in=(
                    ClaimStatus.SUBMITTED,
                    ClaimStatus.CLEARED,
                    ClaimStatus.PRINCIPAL_APPROVED,
                    ClaimStatus.DIRECTOR_APPROVED,
                )
            ).count(),
        },
        "by_year": by_year,
        "by_quartile": bucket("quartile", "Not recorded"),
        "by_journal": bucket("journal_title", "Not recorded")[:10],
        "targets": targets,
        "papers": [
            {
                "id": c.id,
                "paper_title": c.paper_title,
                "journal_title": c.journal_title,
                "publication_year": c.publication_year,
                "quartile": c.quartile,
                "author_position": c.author_position,
                "total_authors": c.total_authors,
                "progress": hod.progress_of(c.status),
            }
            for c in claims[:100]
        ],
    })


@api.get("/hod/standing", auth=session_auth)
def hod_standing(request: HttpRequest, year: Optional[int] = None):
    """How this department compares with the rest of the college.

    A head knows their own numbers and has no way to tell whether they are
    good. Forty papers is a triumph or a disappointment depending entirely on
    what the department next door did, and nothing in this system would say.

    Every figure here is a count or a rate. **No money, and no other
    department is named** -- the head sees where they sit and what the college
    typically does, not a ranked table of their colleagues' departments, which
    is a different document with different politics and is not a head's to
    hold.
    """
    user = _require_hod(request)
    department = hod.department_of(user)

    college = Claim.objects.exclude(status=ClaimStatus.DRAFT)
    if year:
        college = college.filter(publication_year=year)
    mine = college.filter(owner__department__iexact=department)

    def rates(qs) -> dict[str, Any]:
        total = qs.count()
        q1 = qs.filter(quartile__iexact="Q1").count()
        first = qs.filter(author_position=1).count()
        return {
            "publications": total,
            "q1": q1,
            "q1_rate": round(q1 / total, 4) if total else None,
            "first_author": first,
            "first_author_rate": round(first / total, 4) if total else None,
        }

    # Per-department counts, used for the share and the position. The names
    # are dropped straight after; only this department's own is kept.
    per_department: dict[str, int] = {}
    for row in college.values("owner__department").annotate(n=Count("id")):
        key = (row["owner__department"] or "").strip()
        if key:
            per_department[key] = per_department.get(key, 0) + row["n"]

    counts = sorted(per_department.values(), reverse=True)
    my_count = per_department.get(department, 0)
    position = counts.index(my_count) + 1 if my_count in counts else None
    college_total = sum(per_department.values())

    heads = User.objects.filter(
        role=Role.FACULTY, department__iexact=department, active=True
    ).count()
    college_heads = User.objects.filter(role=Role.FACULTY, active=True).count()

    mine_rates = rates(mine)
    college_rates = rates(college)

    return hod.without_money({
        "department": department,
        "year": year,
        "mine": {
            **mine_rates,
            "faculty": heads,
            "per_head": round(my_count / heads, 2) if heads else None,
        },
        "college": {
            **college_rates,
            "departments": len(per_department),
            "faculty": college_heads,
            "per_head": round(college_total / college_heads, 2) if college_heads else None,
        },
        "share": round(my_count / college_total, 4) if college_total else None,
        # "3rd of 22" is the whole answer a head wants and the least
        # inflammatory way to give it: no other department is named.
        "position": position,
        "of": len(per_department),
        "years": sorted(
            {y for y in Claim.objects.exclude(status=ClaimStatus.DRAFT)
             .values_list("publication_year", flat=True) if y},
            reverse=True,
        ),
    })


@api.get("/hod/opportunities", auth=session_auth)
def hod_opportunities(request: HttpRequest, year: Optional[int] = None):
    """Where this department could realistically do more, with the names.

    Every item is something a head can actually act on this term, and each one
    carries the people or papers behind it rather than only a count -- "eleven
    papers would fail accreditation" is a statistic, and the list of which
    eleven is a task.
    """
    user = _require_hod(request)
    department = hod.department_of(user)
    qs = _hod_scope(user)
    if year:
        qs = qs.filter(publication_year=year)

    def people_rows(users) -> list[dict[str, Any]]:
        return [
            {
                "id": u.id, "name": u.name,
                "designation": u.designation, "staff_id": u.staff_id,
            }
            for u in users
        ]

    members = list(
        User.objects.filter(role=Role.FACULTY, department__iexact=department, active=True)
        .order_by("name")
    )
    filed = set(qs.values_list("owner_id", flat=True))
    with_q1 = set(qs.filter(quartile__iexact="Q1").values_list("owner_id", flat=True))
    led = set(qs.filter(author_position=1).values_list("owner_id", flat=True))

    silent = [u for u in members if u.id not in filed]
    no_q1 = [u for u in members if u.id in filed and u.id not in with_q1]
    never_led = [u for u in members if u.id in filed and u.id not in led]

    # Accreditation asks for these on every row; a paper missing one is a row
    # an assessor sends back, and it is far cheaper to fix now than in the
    # week the submission is due.
    incomplete = qs.filter(
        Q(issn__isnull=True) | Q(issn="") | Q(doi__isnull=True) | Q(doi="")
    ).order_by("-publication_year")

    # Where the department already publishes, worst standing first: the
    # realistic next move is usually a better journal in a field somebody is
    # already in, not a new field.
    low_quartile = (
        qs.filter(quartile__iregex=r"^Q[34]$")
        .values("journal_title", "quartile")
        .annotate(n=Count("id"))
        .order_by("-n")[:10]
    )

    return hod.without_money({
        "department": department,
        "year": year,
        "groups": [
            {
                "key": "silent",
                "title": "Nobody has filed anything for them",
                "blurb": (
                    "Not the same as having published nothing -- a paper nobody "
                    "filed a claim for does not exist anywhere in this system."
                ),
                "count": len(silent),
                "people": people_rows(silent),
            },
            {
                "key": "no_q1",
                "title": "Publishing, but nothing in a Q1 journal",
                "blurb": "The clearest single lift available to the department.",
                "count": len(no_q1),
                "people": people_rows(no_q1),
            },
            {
                "key": "never_led",
                "title": "Never first author",
                "blurb": (
                    "Contributing to other people's papers without leading one. "
                    "First authorship is what the department is credited with."
                ),
                "count": len(never_led),
                "people": people_rows(never_led),
            },
        ],
        "incomplete_records": {
            "count": incomplete.count(),
            "blurb": (
                "Missing an ISSN or a DOI. An assessor sends these back, and "
                "they are far cheaper to fix now than in submission week."
            ),
            "papers": [
                {
                    "id": c.id,
                    "paper_title": c.paper_title,
                    "journal_title": c.journal_title,
                    "publication_year": c.publication_year,
                    "owner_name": c.owner.name if c.owner_id else None,
                    "missing": [
                        label for label, present in (
                            ("ISSN", bool((c.issn or "").strip())),
                            ("DOI", bool((c.doi or "").strip())),
                        ) if not present
                    ],
                }
                for c in incomplete[:25]
            ],
        },
        "lower_quartile_journals": [
            {
                "journal_title": r["journal_title"] or "Not recorded",
                "quartile": r["quartile"],
                "count": r["n"],
            }
            for r in low_quartile
        ],
    })


@api.get("/hod/publications", auth=session_auth)
def hod_publications(
    request: HttpRequest,
    q: Optional[str] = None,
    year: Optional[int] = None,
    quartile: Optional[str] = None,
    person: Optional[str] = None,
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
):
    """Every filed publication in the department, one row each."""
    user = _require_hod(request)
    qs = _hod_scope(user)
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(owner__name__icontains=term)
        )
    if year:
        qs = qs.filter(publication_year=year)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if person:
        qs = qs.filter(owner_id=person)

    sorts = {
        "recent": "-updated_at",
        "year": "-publication_year",
        "title": "paper_title",
        "person": "owner__name",
        "journal": "journal_title",
    }
    qs = qs.order_by(sorts.get(sort, "-updated_at"))

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()

    return hod.without_money({
        "total": total,
        "limit": limit,
        "offset": offset,
        "department": hod.department_of(user),
        "results": [
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "paper_title": c.paper_title,
                "journal_title": c.journal_title,
                "issn": c.issn,
                "doi": c.doi,
                "publication_year": c.publication_year,
                "quartile": c.quartile,
                "snip": c.snip,
                "indexing_level": c.indexing_level,
                "publication_type": c.publication_type,
                "author_position": c.author_position,
                "total_authors": c.total_authors,
                "owner_name": c.owner.name,
                "owner_id": c.owner_id,
                # The DOI resolves for anybody; the Scopus link needs a
                # subscription and lands a head on Scopus's front page without
                # one. Both are bibliographic, so neither is money.
                "doi": c.doi,
                "scopus_url": c.scopus_url,
                # Translated, never the raw status: "PAID" tells a head that a
                # colleague was paid, which is not their business.
                "progress": hod.progress_of(c.status),
            }
            for c in qs[offset : offset + limit]
        ],
    })


_HOD_EXPORT_HEADERS = [
    "Ticket", "Faculty", "Paper title", "Journal", "ISSN", "DOI",
    "Year of publication", "Quartile", "SNIP", "Indexed in",
    "Publication type", "Author position", "Total authors", "Progress",
]


@api.get("/hod/export", auth=session_auth)
def hod_export(
    request: HttpRequest,
    q: Optional[str] = None,
    year: Optional[int] = None,
    quartile: Optional[str] = None,
    person: Optional[str] = None,
    fmt: str = "xlsx",
):
    """The department's publications as a file, carrying no money column.

    Same filters as the screen: an export that ignores them and returns
    everything is how a wrong number reaches a review meeting.
    """
    user = _require_hod(request)
    qs = _hod_scope(user)
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(journal_title__icontains=term)
            | Q(owner__name__icontains=term)
        )
    if year:
        qs = qs.filter(publication_year=year)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if person:
        qs = qs.filter(owner_id=person)
    qs = qs.order_by("owner__name", "-publication_year")[:5000]

    rows = [
        [
            c.ticket_number, c.owner.name, c.paper_title, c.journal_title,
            c.issn, c.doi, c.publication_year, c.quartile, c.snip,
            c.indexing_level, c.publication_type, c.author_position,
            c.total_authors, hod.progress_of(c.status),
        ]
        for c in qs
    ]
    stem = f"{hod.department_of(user).replace(' ', '-').lower()}-publications"

    AuditLog.objects.create(
        actor=user, action="HOD_EXPORT", entity="Department",
        entity_id=hod.department_of(user),
        detail_json=json.dumps({"rows": len(rows), "format": fmt}),
    )

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(_csv_row(_HOD_EXPORT_HEADERS))
        for row in rows:
            writer.writerow(_csv_row(row))
        res = HttpResponse(buf.getvalue(), content_type="text/csv")
        res["Content-Disposition"] = f'attachment; filename="{stem}.csv"'
        return res

    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Publications"
    ws.append(_HOD_EXPORT_HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append(["" if v is None else v for v in _csv_row(row)])
    ws.freeze_panes = "A2"
    for column, width in zip(ws.columns, [14, 24, 60, 36, 14, 28, 10, 9, 8, 18, 18, 9, 9, 14]):
        ws.column_dimensions[column[0].column_letter].width = width
    out = io.BytesIO()
    wb.save(out)
    res = HttpResponse(
        out.getvalue(),
        content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    res["Content-Disposition"] = f'attachment; filename="{stem}.xlsx"'
    return res




__all__ = [
    'TargetIn',
    '_HOD_EXPORT_HEADERS',
    '_require_hod',
    '_target_progress',
    'hod_delete_target',
    'hod_export',
    'hod_opportunities',
    'hod_overview',
    'hod_person',
    'hod_publications',
    'hod_set_target',
    'hod_standing',
    'hod_targets',
]
