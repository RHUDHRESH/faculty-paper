"""The read-only data API (/api/v1): what each endpoint returns, and to whom.

Every endpoint answers for one viewer, the token's user, and applies the same
rules the app applies to that person:

* **Faculty** see their own claims, payments, papers and record. Never anybody
  else's, and never another person's drafts.
* **A head of department** sees their department's filed papers and claims,
  and no rupee figure at all: the money keys are not in the response (omitted,
  not zeroed; `search.money.may_see_money`), and `/payments` is closed to them,
  as the app closes its money screens.
* **The office, Principal, Director and Finance** see the college (still not
  other people's drafts).

`FIELDS` is the one place the field names are written down. The docs page
reads it through GET /api/v1/meta, and the CSV/XLSX headers are these names.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time as dtime
from typing import Any, Callable

from django.db.models import Q
from django.utils import timezone

from core import hod
from core.models import (
    Authorship,
    Claim,
    ClaimStatus,
    PaidLedger,
    Publication,
    Role,
    Team,
    User,
)
from core.services import claim_scope, exporters, rbac
from core.services.api_tokens import TokenRefused as ApiError
from core.services.search.money import may_see_money

MAX_PAGE_SIZE = 1000
DEFAULT_PAGE_SIZE = 100
#: csv and xlsx are for spreadsheets, which want the whole table in one pull.
MAX_FILE_PAGE_SIZE = 20_000
DEFAULT_FILE_PAGE_SIZE = 1000
FORMATS = ("json", "csv", "xlsx")


def _f(name: str, type_: str, description: str, *, money: bool = False) -> dict[str, Any]:
    return {"name": name, "type": type_, "description": description, "money": money}


#: Stable field names per endpoint. Adding a field is fine; renaming one is a
#: breaking change for every spreadsheet that reads it.
FIELDS: dict[str, dict[str, Any]] = {
    "papers": {
        "scope": "read:papers",
        "title": "Papers",
        "description": "The publication record: papers by college authors, with journal ranking and citations.",
        "who": "Faculty: your own papers. Heads of department: papers by people in your department. Office, Principal, Director, Finance: the college.",
        "params": ["department", "year", "from", "to", "updated_since", "q", "page", "page_size", "format"],
        "date_field": "date (falls back to year)",
        "fields": [
            _f("id", "text", "Stable paper id."),
            _f("title", "text", "Paper title."),
            _f("year", "number", "Publication year."),
            _f("date", "date", "Publication date, when known (YYYY-MM-DD)."),
            _f("journal", "text", "Journal or conference."),
            _f("issn", "text", "ISSN of the journal."),
            _f("type", "text", "Document type, for example article or conference paper."),
            _f("doi", "text", "DOI without the https://doi.org/ prefix."),
            _f("quartile", "text", "SJR quartile (Q1 to Q4) from the college records."),
            _f("snip", "number", "SNIP of the journal, from the college records."),
            _f("citations", "number", "Citation count (OpenAlex)."),
            _f("scopus_citations", "number", "Citation count (Scopus), when known."),
            _f("scopus_indexed", "text", "Yes when Scopus lists the paper."),
            _f("authors", "list", "All authors in order."),
            _f("college_authors", "list", "The authors who are college staff."),
            _f("updated_at", "datetime", "When the record last changed."),
        ],
    },
    "claims": {
        "scope": "read:claims",
        "title": "Claims",
        "description": "Incentive claims. Drafts are only ever shown to their author.",
        "who": "Faculty: your own claims. Heads of department: your department's filed claims, with no amounts. Office, Principal, Director, Finance: the college's filed claims.",
        "params": ["department", "year", "from", "to", "updated_since", "q", "page", "page_size", "format"],
        "date_field": "filed date (created date for a draft)",
        "fields": [
            _f("id", "text", "Stable claim id."),
            _f("claim_no", "text", "Claim number, for example FP-2026-000001."),
            _f("owner_id", "text", "Id of the claimant."),
            _f("owner", "text", "Claimant's name."),
            _f("department", "text", "Claimant's department."),
            _f("title", "text", "Paper title."),
            _f("journal", "text", "Journal or conference."),
            _f("issn", "text", "ISSN."),
            _f("doi", "text", "DOI."),
            _f("year", "number", "Publication year."),
            _f("quartile", "text", "Quartile used for the claim."),
            _f("snip", "number", "SNIP used for the claim."),
            _f("type", "text", "Publication type."),
            _f("author_position", "number", "The claimant's position in the author list."),
            _f("total_authors", "number", "Number of authors."),
            _f("stage", "text", "Where the claim stands, in the words the viewer sees in the app."),
            _f("filed_on", "date", "Date filed (YYYY-MM-DD)."),
            _f("updated_at", "datetime", "When the claim last changed."),
            _f("amount", "money", "Incentive amount in rupees. Left out for heads of department.", money=True),
            _f("paid_on", "date", "Month paid. Left out for heads of department.", money=True),
        ],
    },
    "payments": {
        "scope": "read:payments",
        "title": "Payments",
        "description": "The paid ledger and paid claims. Closed to heads of department.",
        "who": "Faculty: your own payments. Office, Principal, Director, Finance: the college. Heads of department: not available.",
        "params": ["department", "year", "from", "to", "updated_since", "q", "page", "page_size", "format"],
        "date_field": "month paid",
        "fields": [
            _f("id", "text", "Stable payment id."),
            _f("source", "text", "ledger (the paid ledger) or claim (paid in this app, not yet on the ledger)."),
            _f("kind", "text", "PAYMENT, REVERSAL or ADJUSTMENT."),
            _f("claim_id", "text", "The claim paid, when there is one."),
            _f("month", "date", "Month paid (YYYY-MM-DD, first of the month)."),
            _f("department", "text", "Department."),
            _f("faculty", "text", "Who was paid."),
            _f("staff_id", "text", "Staff id."),
            _f("title", "text", "Paper title."),
            _f("journal", "text", "Journal."),
            _f("amount", "money", "Amount in rupees.", money=True),
            _f("voucher", "text", "Voucher number."),
            _f("updated_at", "datetime", "When the row was written."),
        ],
    },
    "faculty": {
        "scope": "read:faculty",
        "title": "Faculty",
        "description": "The faculty directory: department, designation, Scopus ID, paper counts. Current staff only.",
        "who": "Faculty: your own record. Heads of department: your department, with no amounts. Office, Principal, Director, Finance: everybody.",
        "params": ["department", "updated_since", "q", "page", "page_size", "format"],
        "date_field": "none (year, from and to are ignored)",
        "fields": [
            _f("id", "text", "Stable user id."),
            _f("name", "text", "Name."),
            _f("department", "text", "Department."),
            _f("designation", "text", "Designation."),
            _f("role", "text", "Role in the app."),
            _f("staff_id", "text", "Staff id."),
            _f("faculty_type", "text", "REGULAR or RESEARCH."),
            _f("scopus_author_id", "text", "Scopus author ID."),
            _f("scopus_url", "text", "Scopus profile link."),
            _f("orcid_id", "text", "ORCID iD."),
            _f("papers", "number", "Papers on the publication record."),
            _f("scopus_papers", "number", "Of those, papers Scopus lists."),
            _f("papers_year", "number", "Papers this calendar year."),
            _f("citations", "number", "Total citations."),
            _f("h_index", "number", "h-index."),
            _f("last_paper_year", "number", "Year of the latest paper."),
            _f("claims_filed_year", "number", "Claims filed this year."),
            _f("claims_done", "number", "Claims paid, all time."),
            _f("incentive_year", "money", "Incentives paid this year, in rupees.", money=True),
            _f("incentive_total", "money", "Incentives paid, all time, in rupees.", money=True),
            _f("updated_at", "datetime", "When the account last changed."),
        ],
    },
    "teams": {
        "scope": "read:teams",
        "title": "Teams",
        "description": "Final-year project teams, with students and mentor.",
        "who": "Faculty: teams you mentor or created. Heads of department: your department's teams. Office, Principal, Director, Finance: all teams.",
        "params": ["department", "year", "from", "to", "updated_since", "q", "page", "page_size", "format"],
        "date_field": "created date; year matches the start of the academic year",
        "fields": [
            _f("id", "text", "Stable team id."),
            _f("code", "text", "Team code."),
            _f("title", "text", "Project title."),
            _f("department", "text", "Department."),
            _f("academic_year", "text", "Academic year, for example 2025-26."),
            _f("mentor_id", "text", "Mentor's user id, when linked."),
            _f("mentor", "text", "Mentor's name."),
            _f("active", "text", "Yes while the team is active."),
            _f("member_count", "number", "Students on the team."),
            _f("members", "list", "Students: name, register number, programme, year of study."),
            _f("updated_at", "datetime", "When the team last changed."),
        ],
    },
}

ENDPOINTS = tuple(FIELDS)


# ------------------------------------------------------------------ params --


@dataclass
class Params:
    department: str = ""
    year: int | None = None
    date_from: date | None = None
    date_to: date | None = None
    updated_since: datetime | None = None
    q: str = ""
    page: int = 1
    page_size: int = DEFAULT_PAGE_SIZE
    fmt: str = "json"


def _int(raw: str, name: str, low: int, high: int | None = None) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ApiError(400, f"{name} must be a whole number.") from None
    if value < low or (high is not None and value > high):
        raise ApiError(400, f"{name} must be {low} or more." if high is None else f"{name} must be {low} to {high}.")
    return value


def _date(raw: str, name: str) -> date:
    try:
        return date.fromisoformat(raw.strip()[:10])
    except ValueError:
        raise ApiError(400, f"{name} must be a date like 2026-04-30.") from None


def _moment(raw: str, name: str) -> datetime:
    text = raw.strip()
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(400, f"{name} must be a date or time like 2026-04-30 or 2026-04-30T10:00:00Z.") from None
    if timezone.is_naive(value):
        value = timezone.make_aware(datetime.combine(value.date(), value.time()))
    return value


def parse(query: Any) -> Params:
    """Query parameters to `Params`, refusing anything malformed."""
    fmt = (query.get("format") or "json").strip().lower()
    if fmt not in FORMATS:
        raise ApiError(400, "format must be json, csv or xlsx.")
    file = fmt != "json"
    cap = MAX_FILE_PAGE_SIZE if file else MAX_PAGE_SIZE
    p = Params(fmt=fmt, page_size=DEFAULT_FILE_PAGE_SIZE if file else DEFAULT_PAGE_SIZE)
    p.department = (query.get("department") or "").strip()
    p.q = (query.get("q") or "").strip()[:200]
    if query.get("year"):
        p.year = _int(query["year"], "year", 1900, 2200)
    if query.get("from"):
        p.date_from = _date(query["from"], "from")
    if query.get("to"):
        p.date_to = _date(query["to"], "to")
    if p.date_from and p.date_to and p.date_from > p.date_to:
        raise ApiError(400, "from must not be after to.")
    if query.get("updated_since"):
        p.updated_since = _moment(query["updated_since"], "updated_since")
    if query.get("page"):
        p.page = _int(query["page"], "page", 1)
    if query.get("page_size"):
        # Over the cap is clamped, not refused: a client asking for "everything"
        # gets the most there is and follows `next`.
        p.page_size = min(_int(query["page_size"], "page_size", 1), cap)
    return p


# ------------------------------------------------------------------- scope --


def _college_wide(viewer: User) -> bool:
    return rbac.can_view_college_wide(viewer.role)


def _head_department(viewer: User) -> str:
    return hod.department_of(viewer) if viewer.role == Role.HOD else ""


def _yes(v: Any) -> str:
    return "Yes" if v else "No"


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _day(d: date | datetime | None) -> str | None:
    if d is None:
        return None
    return (d.date() if isinstance(d, datetime) else d).isoformat()


def _start(d: date) -> datetime:
    return timezone.make_aware(datetime.combine(d, dtime.min))


def _end(d: date) -> datetime:
    return timezone.make_aware(datetime.combine(d, dtime.max))


# ------------------------------------------------------------------ papers --


def _papers_queryset(viewer: User, p: Params):
    qs = Publication.objects.all()
    if not _college_wide(viewer):
        dept = _head_department(viewer)
        mine = Q(user=viewer)
        if dept:
            mine |= Q(user__department__iexact=dept)
        qs = qs.filter(pk__in=Authorship.objects.filter(mine).values("publication_id"))
    if p.department:
        qs = qs.filter(
            pk__in=Authorship.objects.filter(user__department__iexact=p.department).values("publication_id")
        )
    if p.year:
        qs = qs.filter(year=p.year)
    if p.date_from:
        qs = qs.filter(Q(date__gte=p.date_from) | Q(date__isnull=True, year__gte=p.date_from.year))
    if p.date_to:
        qs = qs.filter(Q(date__lte=p.date_to) | Q(date__isnull=True, year__lte=p.date_to.year))
    if p.updated_since:
        qs = qs.filter(updated_at__gte=p.updated_since)
    if p.q:
        qs = qs.filter(
            Q(title__icontains=p.q)
            | Q(venue__icontains=p.q)
            | Q(doi__icontains=p.q)
            | Q(pk__in=Authorship.objects.filter(display_name__icontains=p.q).values("publication_id"))
        )
    return qs.prefetch_related("authorships", "claims").order_by("-year", "title", "id")


def _paper_row(pub: Publication, viewer: User) -> dict[str, Any]:
    people = sorted(pub.authorships.all(), key=lambda a: (a.position is None, a.position or 0, a.id))
    snips = [c.snip for c in pub.claims.all() if c.snip is not None and c.status != ClaimStatus.DRAFT]
    return {
        "id": pub.id,
        "title": pub.title,
        "year": pub.year,
        "date": _day(pub.date),
        "journal": pub.venue or None,
        "issn": pub.issn or None,
        "type": pub.type or None,
        "doi": pub.doi,
        "quartile": pub.quartile or None,
        "snip": max(snips) if snips else None,
        "citations": pub.citations,
        "scopus_citations": pub.scopus_citations,
        "scopus_indexed": bool(pub.scopus_indexed or pub.eid),
        "authors": [a.display_name for a in people],
        "college_authors": [a.display_name for a in people if a.is_college],
        "updated_at": _iso(pub.updated_at),
    }


# ------------------------------------------------------------------ claims --


def _claims_queryset(viewer: User, p: Params):
    qs = Claim.objects.select_related("owner")
    if _college_wide(viewer):
        qs = claim_scope.hide_others_drafts(qs, viewer)
    elif viewer.role == Role.HOD and _head_department(viewer):
        qs = qs.filter(
            (Q(owner__department__iexact=_head_department(viewer)) & ~Q(status=ClaimStatus.DRAFT))
            | Q(owner=viewer)
        )
    else:
        qs = qs.filter(owner=viewer)
    if p.department:
        qs = qs.filter(owner__department__iexact=p.department)
    if p.year:
        qs = qs.filter(publication_year=p.year)
    if p.date_from:
        qs = qs.filter(created_at__gte=_start(p.date_from))
    if p.date_to:
        qs = qs.filter(created_at__lte=_end(p.date_to))
    if p.updated_since:
        qs = qs.filter(updated_at__gte=p.updated_since)
    if p.q:
        qs = qs.filter(
            Q(ticket_number__icontains=p.q)
            | Q(paper_title__icontains=p.q)
            | Q(journal_title__icontains=p.q)
            | Q(doi__icontains=p.q)
            | Q(owner__name__icontains=p.q)
        )
    return qs.order_by("-updated_at", "id")


def _stage(viewer: User, c: Claim) -> str:
    from core.visibility import faculty_stage

    if c.owner_id == viewer.id or viewer.role == Role.FACULTY:
        return faculty_stage(
            c.status, rejected_outright=bool(c.rejected_outright),
            ticket_number=c.ticket_number, status_note=c.status_note,
        )
    if viewer.role == Role.HOD:
        return hod.progress_of(c.status)
    staff = {
        ClaimStatus.DRAFT: "Draft",
        ClaimStatus.SUBMITTED: "Submitted",
        ClaimStatus.CLEARED: "Cleared",
        ClaimStatus.PRINCIPAL_APPROVED: "Approved",
        ClaimStatus.DIRECTOR_APPROVED: "Authorised",
        ClaimStatus.PAID: "Paid",
        ClaimStatus.REJECTED: "Sent back",
    }
    if c.status == ClaimStatus.REJECTED and c.rejected_outright:
        return "Rejected"
    return staff.get(c.status, "In progress")


def _claim_row(c: Claim, viewer: User) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": c.id,
        "claim_no": c.ticket_number,
        "owner_id": c.owner_id,
        "owner": c.owner.name,
        "department": c.owner.department,
        "title": c.paper_title,
        "journal": c.journal_title,
        "issn": c.issn,
        "doi": c.doi,
        "year": c.publication_year,
        "quartile": c.quartile,
        "snip": c.snip,
        "type": (c.publication_type or "").split(",")[0].strip() or None,
        "author_position": c.author_position,
        "total_authors": c.total_authors,
        "stage": _stage(viewer, c),
        "filed_on": _day(c.submitted_at),
        "updated_at": _iso(c.updated_at),
    }
    if may_see_money(viewer.role):
        row["amount"] = c.remuneration
        row["paid_on"] = _day(c.payout_month or c.paid_at) if c.status == ClaimStatus.PAID else None
    return row


# ---------------------------------------------------------------- payments --


class _Concat:
    """Two querysets read as one list, so a page can straddle them."""

    def __init__(self, *parts):
        self.parts = parts
        self._counts = [part.count() for part in parts]

    def count(self) -> int:
        return sum(self._counts)

    def slice(self, start: int, stop: int) -> list[tuple[int, Any]]:
        out: list[tuple[int, Any]] = []
        offset = 0
        for i, (part, n) in enumerate(zip(self.parts, self._counts)):
            lo, hi = max(start - offset, 0), min(stop - offset, n)
            if lo < hi:
                out.extend((i, obj) for obj in part[lo:hi])
            offset += n
        return out


def _payments(viewer: User, p: Params) -> _Concat:
    if viewer.role == Role.HOD:
        raise ApiError(
            403,
            "Heads of department see their department's papers and claims, which carry no payment details.",
        )
    from core.api.my_payments import ledger_for

    ledger = PaidLedger.objects.all() if _college_wide(viewer) else ledger_for(viewer)
    claims = Claim.objects.filter(status=ClaimStatus.PAID).select_related("owner").exclude(
        pk__in=PaidLedger.objects.filter(claim__isnull=False).values("claim_id")
    )
    claims = claim_scope.visible_to(viewer, claims)
    if p.department:
        ledger = ledger.filter(department__iexact=p.department)
        claims = claims.filter(owner__department__iexact=p.department)
    if p.year:
        ledger = ledger.filter(payout_month__year=p.year)
        claims = claims.filter(payout_month__year=p.year)
    if p.date_from:
        ledger = ledger.filter(payout_month__gte=p.date_from)
        claims = claims.filter(payout_month__gte=p.date_from)
    if p.date_to:
        ledger = ledger.filter(payout_month__lte=p.date_to)
        claims = claims.filter(payout_month__lte=p.date_to)
    if p.updated_since:
        ledger = ledger.filter(created_at__gte=p.updated_since)
        claims = claims.filter(updated_at__gte=p.updated_since)
    if p.q:
        ledger = ledger.filter(
            Q(paper_title__icontains=p.q) | Q(journal_title__icontains=p.q)
            | Q(faculty_name__icontains=p.q) | Q(staff_id__icontains=p.q) | Q(voucher_number__icontains=p.q)
        )
        claims = claims.filter(
            Q(paper_title__icontains=p.q) | Q(journal_title__icontains=p.q)
            | Q(owner__name__icontains=p.q) | Q(voucher_number__icontains=p.q)
        )
    return _Concat(ledger.order_by("-payout_month", "-id"), claims.order_by("-payout_month", "-id"))


def _payment_row(source: int, obj: Any, viewer: User) -> dict[str, Any]:
    if source == 0:
        row = {
            "id": obj.id,
            "source": "ledger",
            "kind": obj.kind,
            "claim_id": obj.claim_id,
            "month": _day(obj.payout_month),
            "department": obj.department,
            "faculty": obj.faculty_name,
            "staff_id": obj.staff_id,
            "title": obj.paper_title,
            "journal": obj.journal_title,
            "voucher": obj.voucher_number,
            "updated_at": _iso(obj.created_at),
        }
        amount = obj.amount
    else:
        row = {
            "id": f"claim-{obj.id}",
            "source": "claim",
            "kind": "PAYMENT",
            "claim_id": obj.id,
            "month": _day(obj.payout_month or obj.paid_at),
            "department": obj.owner.department,
            "faculty": obj.owner.name,
            "staff_id": obj.owner.staff_id,
            "title": obj.paper_title,
            "journal": obj.journal_title,
            "voucher": obj.voucher_number,
            "updated_at": _iso(obj.updated_at),
        }
        amount = obj.remuneration or 0
    if may_see_money(viewer.role):
        row["amount"] = amount
    return row


# ----------------------------------------------------------------- faculty --


def _faculty_rows(viewer: User, p: Params) -> list[dict[str, Any]]:
    import importlib

    fd = importlib.import_module("core.api.faculty_directory")

    dept = _head_department(viewer)
    if _college_wide(viewer) or (viewer.role == Role.HOD and dept):
        rows, _counts, _summary = fd._select(viewer, q=p.q, department=p.department)
    else:
        base = fd._base([viewer])
        scopus = fd._scopus_papers([viewer])
        row = fd._row(viewer, base[viewer.id], viewer, scopus.get(viewer.id, 0))
        rows = [row] if row["active"] else []
        text = p.q.lower()
        if text and text not in f"{row['name']} {row['department'] or ''}".lower():
            rows = []
        if p.department and (row["department"] or "").lower() != p.department.lower():
            rows = []
    stamps = dict(User.objects.filter(pk__in=[r["id"] for r in rows]).values_list("pk", "updated_at"))
    out = []
    for r in rows:
        if p.updated_since and (stamps.get(r["id"]) or p.updated_since) < p.updated_since:
            continue
        item = {
            "id": r["id"],
            "name": r["name"],
            "department": r["department"],
            "designation": r["designation"],
            "role": r["role"],
            "staff_id": r["staff_id"],
            "faculty_type": r["faculty_type"],
            "scopus_author_id": r["scopus_author_id"],
            "scopus_url": r["scopus_url"],
            "orcid_id": r["orcid_id"],
            "papers": r["papers"],
            "scopus_papers": r["scopus_papers"],
            "papers_year": r["papers_year"],
            "citations": r["citations"],
            "h_index": r["h_index"],
            "last_paper_year": r["last_paper_year"],
            "claims_filed_year": r["claims_filed_year"],
            "claims_done": r["claims_done"],
            "updated_at": _iso(stamps.get(r["id"])),
        }
        incentive = r.get("incentive")
        if incentive and may_see_money(viewer.role):
            item["incentive_year"] = incentive.get("amount")
            item["incentive_total"] = incentive.get("total_amount")
        out.append(item)
    return out


# ------------------------------------------------------------------- teams --


def _teams_queryset(viewer: User, p: Params):
    qs = Team.objects.select_related("mentor").prefetch_related("members")
    if not rbac.can_view_reports(viewer.role):
        mine = Q(mentor=viewer) | Q(created_by=viewer)
        if _head_department(viewer):
            mine |= Q(department__iexact=_head_department(viewer))
        qs = qs.filter(mine)
    if p.department:
        qs = qs.filter(department__iexact=p.department)
    if p.year:
        qs = qs.filter(academic_year__startswith=str(p.year))
    if p.date_from:
        qs = qs.filter(created_at__gte=_start(p.date_from))
    if p.date_to:
        qs = qs.filter(created_at__lte=_end(p.date_to))
    if p.updated_since:
        qs = qs.filter(updated_at__gte=p.updated_since)
    if p.q:
        qs = qs.filter(
            Q(code__icontains=p.q) | Q(title__icontains=p.q) | Q(mentor_name__icontains=p.q)
            | Q(pk__in=Team.objects.filter(members__name__icontains=p.q).values("pk"))
        )
    return qs.order_by("code", "id")


def _team_row(t: Team, viewer: User) -> dict[str, Any]:
    members = [
        {
            "name": m.name,
            "register_number": m.register_number,
            "programme": m.programme,
            "year_of_study": m.year_of_study,
        }
        for m in t.members.all()
    ]
    return {
        "id": t.id,
        "code": t.code,
        "title": t.title,
        "department": t.department,
        "academic_year": t.academic_year,
        "mentor_id": t.mentor_id,
        "mentor": t.mentor.name if t.mentor_id else t.mentor_name,
        "active": bool(t.active),
        "member_count": len(members),
        "members": members,
        "updated_at": _iso(t.updated_at),
    }


# ------------------------------------------------------------------ paging --


def fetch(kind: str, viewer: User, p: Params) -> tuple[list[dict[str, Any]], int]:
    """One page of rows for `kind`, and the total across all pages."""
    lo = (p.page - 1) * p.page_size
    hi = lo + p.page_size
    if kind == "papers":
        qs = _papers_queryset(viewer, p)
        return [_paper_row(x, viewer) for x in qs[lo:hi]], qs.count()
    if kind == "claims":
        qs = _claims_queryset(viewer, p)
        return [_claim_row(x, viewer) for x in qs[lo:hi]], qs.count()
    if kind == "payments":
        both = _payments(viewer, p)
        return [_payment_row(i, x, viewer) for i, x in both.slice(lo, hi)], both.count()
    if kind == "faculty":
        rows = _faculty_rows(viewer, p)
        return rows[lo:hi], len(rows)
    if kind == "teams":
        qs = _teams_queryset(viewer, p)
        return [_team_row(x, viewer) for x in qs[lo:hi]], qs.count()
    raise ApiError(404, "No such endpoint.")


def columns_for(kind: str, viewer: User) -> list[dict[str, Any]]:
    """The fields this viewer receives: money fields are not theirs if blind."""
    blind = not may_see_money(viewer.role)
    return [f for f in FIELDS[kind]["fields"] if not (blind and f["money"])]


def _cell(value: Any) -> Any:
    if isinstance(value, list):
        parts = []
        for v in value:
            if isinstance(v, dict):
                reg = v.get("register_number")
                parts.append(f"{v.get('name') or ''} ({reg})" if reg else str(v.get("name") or ""))
            else:
                parts.append(str(v))
        return "; ".join(parts)
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return value


_KINDS = {"text": "text", "list": "text", "number": "number", "money": "money", "date": "date", "datetime": "text"}


def render_file(kind: str, viewer: User, rows: list[dict[str, Any]], fmt: str) -> bytes:
    """The page as CSV or XLSX through the app's own exporters, which neutralise
    spreadsheet formulas (`core.services.cell_safe`)."""
    cols = columns_for(kind, viewer)
    names = [c["name"] for c in cols]
    # Year columns are left to the exporter so 2025 never reads "2,025".
    kinds = [None if c["name"] in ("year", "last_paper_year", "papers_year") else _KINDS[c["type"]] for c in cols]
    table = [[_cell(r.get(n)) for n in names] for r in rows]
    title = FIELDS[kind]["title"]
    return exporters.render_table(title, "", names, table, fmt, kinds=kinds)


def meta_for(viewer: User) -> dict[str, Any]:
    """What the docs page shows: every endpoint, its parameters and fields."""
    from core.services import api_tokens

    allowed = set(api_tokens.scopes_for_role(viewer.role))
    out = []
    for kind in ENDPOINTS:
        spec = FIELDS[kind]
        out.append({
            "name": kind,
            "path": f"/api/v1/{kind}",
            "scope": spec["scope"],
            "title": spec["title"],
            "description": spec["description"],
            "who": spec["who"],
            "available": spec["scope"] in allowed,
            "params": spec["params"],
            "date_field": spec["date_field"],
            "fields": columns_for(kind, viewer),
        })
    return {
        "version": 1,
        "rate_limit_per_minute": api_tokens.RATE_LIMIT,
        "max_page_size": MAX_PAGE_SIZE,
        "max_file_page_size": MAX_FILE_PAGE_SIZE,
        "formats": list(FORMATS),
        "params": {
            "department": "Only this department.",
            "year": "Only this year.",
            "from": "From this date (YYYY-MM-DD), on the endpoint's date field.",
            "to": "Up to this date (YYYY-MM-DD).",
            "updated_since": "Only rows changed since this date or time (ISO 8601).",
            "q": "Search text.",
            "page": "Page number, from 1.",
            "page_size": f"Rows per page. JSON up to {MAX_PAGE_SIZE}; csv and xlsx up to {MAX_FILE_PAGE_SIZE}.",
            "format": "json (default), csv or xlsx.",
        },
        "endpoints": out,
    }


__all__ = ["FIELDS", "ENDPOINTS", "Params", "parse", "fetch", "render_file", "meta_for", "columns_for", "ApiError"]
