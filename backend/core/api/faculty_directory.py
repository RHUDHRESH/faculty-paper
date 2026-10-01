"""The faculty directory and the faculty record: everybody, with everything.

Two questions the office asked in the same breath: "who are our faculty, and
what do we hold on each of them" and "who is missing a photo, a Scopus ID, a
department". This module answers both from the one record the rest of the app
already keeps (`person_record` for the paper count, `PublicationMetrics` for
citations and the h-index, the paid ledger for money), so a number here is the
number on Home and on the public profile.

Who sees what
-------------
* **Faculty** never see the directory. They open their own record, and only
  that one, shaped exactly as the office sees it minus what is not theirs.
* **The office, the Principal, the Director and Finance** see everybody.
  Money (incentives, payments, the research threshold's value) is shown to the
  roles that may read reports (`rbac.can_view_reports`) and to the person
  themself.
* **A head of department** sees their own department and no rupee figure but
  their own. The figures are left out here, at the source, and the renderer's
  `hod.for_head` is the net under that (rows carry `owner_id`).
* **Flags and file checks** are not part of this record at all, so the
  Director and Finance cannot receive them by this route.
* **Gaps** ("What is missing") are the office's to fix and theirs to see.

A faculty member's own record uses the faculty's words for a claim's stage
(`visibility.faculty_stage`); a head sees `hod.progress_of`; the staff see the
step name. Nobody outside the desks is told which desk holds a paper.
"""

from __future__ import annotations

import io
import re
from collections import Counter, defaultdict
from datetime import date
from typing import Any, Optional

from django.db.models import Q
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja.errors import HttpError

from core import hod, social
from core.api.common import api, require_user, session_auth
from core.api.my_payments import ledger_for
from core.api.publications import (
    _ClaimIndex,
    _LedgerIndex,
    _fill_from_claim,
    _metrics,
    _record,
)
from core.models import (
    Claim,
    ClaimStatus,
    PaidLedger,
    ProfileChangeRequest,
    PublicationMetrics,
    ResearchInterest,
    Role,
    Skill,
    User,
)
from core.services import aggregate_cache, cell_safe, rbac
from core.services import coauthors as graph
from core.services.person_record import Paper, papers_of
from core.services.remuneration import MAX_ELIGIBLE_AUTHORS
from core.services.scopus import author_profile_url
from core.services.scopus_profiles import profile_dict, profile_for
from core.social_rank import completeness_score_expr
from core.visibility import faculty_stage

#: The seven parts `social_rank.completeness` scores, for turning 0..7 into a percentage.
_COMPLETENESS_PARTS = 7

#: Roles that appear in the directory: everybody who publishes.
DIRECTORY_POPULATION = rbac.CLAIMANT_ROLES

#: What each direction of "missing" means, in the words the office uses.
GAPS = (
    ("photo", "No photo", "person", "Only they can add a photo, so ask them."),
    ("scopus", "No Scopus ID", "office", "Add the Scopus author ID on their account."),
    ("department", "No department", "office", "Choose the department on their account."),
    ("designation", "No designation", "office", "Add the designation on their account."),
)

SORTS = {
    "name", "department", "papers", "citations", "h_index", "last_paper", "completeness",
    "claims", "paid", "staff_id",
}

# Staff-facing stage words (docs/ux/19-vocabulary.md).
_STAFF_STAGE = {
    ClaimStatus.DRAFT: "Draft",
    ClaimStatus.SUBMITTED: "Submitted",
    ClaimStatus.CLEARED: "Cleared",
    ClaimStatus.PRINCIPAL_APPROVED: "Approved",
    ClaimStatus.DIRECTOR_APPROVED: "Authorised",
    ClaimStatus.PAID: "Paid",
    ClaimStatus.REJECTED: "Sent back",
}


# --------------------------------------------------------------- who may ask --


def _sees_everyone(role: str) -> bool:
    return rbac.can_view_college_wide(role)


def _same_department(a: User, b: User) -> bool:
    x = (a.department or "").strip().lower()
    return bool(x) and x == (b.department or "").strip().lower()


def _may_see(viewer: User, person: User) -> bool:
    if viewer.id == person.id or _sees_everyone(viewer.role):
        return True
    return viewer.role == Role.HOD and _same_department(viewer, person)


def _money_ok(viewer: User, person_id: str) -> bool:
    """Rupee figures: the roles that read reports, and the person themself."""
    return rbac.can_view_reports(viewer.role) or viewer.id == person_id


def _require_directory(request: HttpRequest) -> User:
    viewer = require_user(request)
    if _sees_everyone(viewer.role):
        return viewer
    if viewer.role == Role.HOD:
        if not hod.department_of(viewer):
            raise HttpError(403, "A head needs a department before the directory can show one.")
        return viewer
    raise HttpError(403, "The faculty directory is for the college office and heads of department.")


# ------------------------------------------------------------------ the base --


def _population(viewer: User):
    qs = User.objects.filter(role__in=DIRECTORY_POPULATION).annotate(completeness_n=completeness_score_expr())
    if not _sees_everyone(viewer.role):
        qs = qs.filter(department__iexact=hod.department_of(viewer))
    return qs


_TITLE = re.compile(r"^\s*((dr|mr|ms|mrs|miss|prof|er)\b\.?\s*)+", re.IGNORECASE)


def _sort_name(name: str | None) -> str:
    """Filed as a directory files it: 'Dr. K. R. Devabalaji' under D-e-v, not under Dr."""
    return _TITLE.sub("", name or "").strip().lower()


def _hindex(cites: list[int]) -> int:
    ranked = sorted((c or 0 for c in cites), reverse=True)
    return sum(1 for i, c in enumerate(ranked, 1) if c >= i)


def _scopus_link(u: User) -> Optional[str]:
    return (u.scopus_author_url or "").strip() or author_profile_url(u.scopus_author_id)


def _ledger_by_person(users: list[User]) -> dict[str, list[tuple[date, float]]]:
    """(month, amount) of every paid-ledger row, per person, in one query.

    A row is a person's when its claim is theirs, or when it has no claim and
    carries their staff id (`my_payments.ledger_for`, the same rule in bulk).
    """
    by_staff = {(u.staff_id or "").strip().lower(): u.id for u in users if (u.staff_id or "").strip()}
    ids = {u.id for u in users}
    out: dict[str, list[tuple[date, float]]] = defaultdict(list)
    for owner, claim_id, staff, month, amount in PaidLedger.objects.filter(amount__gt=0).values_list(
        "claim__owner_id", "claim_id", "staff_id", "payout_month", "amount"
    ):
        uid = owner if claim_id and owner else by_staff.get((staff or "").strip().lower())
        if uid in ids:
            out[uid].append((month, float(amount or 0)))
    return out


def _base(users: list[User]) -> dict[str, dict[str, Any]]:
    """Everything the directory needs about each person that does not depend on who asks.

    Money is in here (`paid_total`, `paid_year`) because it is the same for
    every reader; whether a reader receives it is decided per row afterwards.
    """
    year = timezone.localdate().year
    ids = [u.id for u in users]
    papers = papers_of(users)
    metrics = {m.user_id: m for m in PublicationMetrics.objects.filter(user_id__in=ids)}
    ledger = _ledger_by_person(users)

    filed: Counter = Counter()
    done: Counter = Counter()
    paid_claim_ids: set[str] = set()
    ledger_claims = set(
        PaidLedger.objects.filter(claim__isnull=False, amount__gt=0).values_list("claim_id", flat=True)
    )
    claim_paid_amount: dict[str, float] = defaultdict(float)
    claim_paid_year_amount: dict[str, float] = defaultdict(float)
    claim_done_year: Counter = Counter()
    for owner, status, submitted, created, paid_at, month, cid, amount in Claim.objects.filter(
        owner_id__in=ids
    ).exclude(status=ClaimStatus.DRAFT).values_list(
        "owner_id", "status", "submitted_at", "created_at", "paid_at", "payout_month", "id", "remuneration"
    ):
        when = submitted or created
        if when and when.year == year:
            filed[owner] += 1
        if status == ClaimStatus.PAID:
            paid_claim_ids.add(cid)
            if cid not in ledger_claims:
                # Paid in this app and not (yet) on the ledger: still paid.
                done[owner] += 1
                claim_paid_amount[owner] += float(amount or 0)
                on = paid_at.date() if paid_at else month
                if on and on.year == year:
                    claim_done_year[owner] += 1
                    claim_paid_year_amount[owner] += float(amount or 0)

    out: dict[str, dict[str, Any]] = {}
    for u in users:
        mine: list[Paper] = papers.get(u.id, [])
        m = metrics.get(u.id)
        cites = [p.citations or 0 for p in mine]
        dated = [p for p in mine if p.year]
        last = max(dated, key=lambda p: (p.year or 0, p.on or date.min), default=None)
        rows = ledger.get(u.id, [])
        out[u.id] = {
            "papers": len(mine),
            "papers_year": sum(1 for p in mine if p.year == year),
            "citations": m.total_citations if m else sum(cites),
            "h_index": m.h_index if m else _hindex(cites),
            "last_paper_year": last.year if last else None,
            "last_paper_on": last.on.isoformat() if last and last.on else None,
            "claims_filed_year": filed[u.id],
            "claims_done": len(rows) + done[u.id],
            "claims_done_year": sum(1 for month, _ in rows if month and month.year == year) + claim_done_year[u.id],
            "paid_total": round(sum(a for _, a in rows) + claim_paid_amount[u.id], 2),
            "paid_year": round(
                sum(a for month, a in rows if month and month.year == year) + claim_paid_year_amount[u.id], 2
            ),
        }
    return out


def _cached_base(users: list[User]) -> dict[str, dict[str, Any]]:
    # Same for every reader, so shared while the college record is unchanged.
    # `shared` (ten minutes, keyed to the record's own fingerprint) and not the
    # thirty-second `cached`: building it walks every paper of every person
    # (half a second on the real record), and at thirty seconds nearly every
    # visit to the directory paid that.
    return aggregate_cache.shared(
        "faculty-directory",
        {"ids": sorted(u.id for u in users), "day": timezone.localdate().isoformat()},
        lambda: _base(users),
    )


def _missing(u: User) -> list[str]:
    out = []
    if not (u.photo or "").strip():
        out.append("photo")
    if not ((u.scopus_author_id or "").strip() or (u.scopus_author_url or "").strip()):
        out.append("scopus")
    if not (u.department or "").strip():
        out.append("department")
    if not (u.designation or "").strip():
        out.append("designation")
    return out


def _row(u: User, base: dict[str, Any], viewer: User) -> dict[str, Any]:
    money = _money_ok(viewer, u.id)
    quota_visible = money or viewer.id == u.id
    row: dict[str, Any] = {
        "id": u.id,
        # Marks the row as this person's, so `hod.for_head` (the net under the
        # money rule) knows whose figures it is looking at.
        "owner_id": u.id,
        **social.person_brief(u),
        "active": bool(u.active),
        "role": u.role,
        "staff_id": u.staff_id or None,
        "faculty_type": u.faculty_type,
        "threshold_set": u.faculty_type == "RESEARCH" and u.research_quota is not None,
        "scopus_author_id": u.scopus_author_id or None,
        "scopus_url": _scopus_link(u),
        "orcid_id": u.orcid_id or None,
        "orcid_url": f"https://orcid.org/{u.orcid_id}" if u.orcid_id else None,
        "papers": base["papers"],
        "papers_year": base["papers_year"],
        "citations": base["citations"],
        "h_index": base["h_index"],
        "last_paper_year": base["last_paper_year"],
        "last_paper_on": base["last_paper_on"],
        "claims_filed_year": base["claims_filed_year"],
        "claims_done": base["claims_done"],
        "claims_done_year": base["claims_done_year"],
        "completeness": round(100 * (getattr(u, "completeness_n", 0) or 0) / _COMPLETENESS_PARTS),
        "missing": _missing(u),
    }
    if u.faculty_type == "RESEARCH" and quota_visible:
        row["threshold"] = u.research_quota
    if money:
        # Under keys `hod.for_head` knows are money, so a slip is stripped for a head.
        row["incentive"] = {"amount": base["paid_year"], "total_amount": base["paid_total"]}
    return row


# ----------------------------------------------------------------- filtering --


def _select(
    viewer: User,
    q: str = "",
    department: str = "",
    faculty_type: str = "",
    missing: str = "",
    no_papers_year: bool = False,
    sort: str = "name",
    direction: str = "asc",
    include_left: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    qs = _population(viewer)
    users = list(qs.order_by("name"))
    base = _cached_base(users)
    rows = [_row(u, base[u.id], viewer) for u in users]
    # Current staff by default, so the figures here are the ones on the "what
    # is missing" list and on Admin: a leaver without a photo is not a gap to
    # close. The base above is built for everybody so both views share it.
    left = sum(1 for r in rows if not r["active"])
    if not include_left:
        rows = [r for r in rows if r["active"]]

    counts = {
        "people": len(rows),
        "left": left,
        "research": sum(1 for r in rows if r["faculty_type"] == "RESEARCH"),
        "no_photo": sum(1 for r in rows if "photo" in r["missing"]),
        "no_scopus": sum(1 for r in rows if "scopus" in r["missing"]),
        "no_papers_year": sum(1 for r in rows if r["papers_year"] == 0),
    }

    text = q.strip().lower()
    if text:
        rows = [
            r for r in rows
            if text in " ".join(
                str(r.get(k) or "") for k in ("name", "staff_id", "department", "designation", "scopus_author_id", "orcid_id")
            ).lower()
        ]
    dept = department.strip().lower()
    if dept:
        rows = [r for r in rows if (r["department"] or "").strip().lower() == dept]
    if faculty_type in ("REGULAR", "RESEARCH"):
        rows = [r for r in rows if r["faculty_type"] == faculty_type]
    if missing in {g[0] for g in GAPS}:
        rows = [r for r in rows if missing in r["missing"]]
    if no_papers_year:
        rows = [r for r in rows if r["papers_year"] == 0]

    if sort not in SORTS:
        raise HttpError(400, "Sort by name, department, papers, citations, h-index, last paper, completeness, claims or paid.")
    keys = {
        "name": lambda r: _sort_name(r["name"]),
        "staff_id": lambda r: (r["staff_id"] or "~").lower(),
        "department": lambda r: ((r["department"] or "~").lower(), _sort_name(r["name"])),
        "papers": lambda r: r["papers"],
        "citations": lambda r: r["citations"],
        "h_index": lambda r: r["h_index"],
        "last_paper": lambda r: (r["last_paper_year"] or 0, r["last_paper_on"] or ""),
        "completeness": lambda r: r["completeness"],
        "claims": lambda r: r["claims_filed_year"],
        "paid": lambda r: (r.get("incentive") or {}).get("amount", 0),
    }
    rows.sort(key=keys[sort], reverse=(direction == "desc"))
    return rows, counts


@api.get("/directory/faculty", auth=session_auth)
def faculty_directory(
    request: HttpRequest,
    q: str = "",
    department: str = "",
    faculty_type: str = "",
    missing: str = "",
    no_papers_year: bool = False,
    sort: str = "name",
    dir: str = "asc",
    limit: int = 30,
    offset: int = 0,
    include_left: bool = False,
):
    """Every faculty member as a row: identifiers, papers, citations, claims, money where
    allowed. People who have left are left out unless `include_left`."""
    viewer = _require_directory(request)
    rows, counts = _select(viewer, q, department, faculty_type, missing, no_papers_year, sort, dir, include_left)
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    return {
        "total": len(rows),
        "limit": limit,
        "offset": offset,
        "year": timezone.localdate().year,
        # Whether this reader is shown incentives at all, so the page does not
        # have to guess from a role.
        "money": rbac.can_view_reports(viewer.role),
        "scope": "department" if not _sees_everyone(viewer.role) else "college",
        "counts": counts,
        "results": rows[offset : offset + limit],
    }


def _dash(v: Any) -> Any:
    return "" if v is None else v


@api.get("/directory/faculty/export.csv", auth=session_auth)
def faculty_directory_csv(
    request: HttpRequest,
    q: str = "",
    department: str = "",
    faculty_type: str = "",
    missing: str = "",
    no_papers_year: bool = False,
    sort: str = "name",
    dir: str = "asc",
    include_left: bool = False,
):
    """The filtered directory as a spreadsheet, every cell formula-safe."""
    viewer = _require_directory(request)
    rows, _ = _select(viewer, q, department, faculty_type, missing, no_papers_year, sort, dir, include_left)
    year = timezone.localdate().year
    money = rbac.can_view_reports(viewer.role)
    head = [
        "Name", "Staff ID", "Department", "Designation", "Faculty type", "Scopus ID", "Scopus profile", "ORCID",
        "Papers on record", f"Papers in {year}", "Citations", "h-index", "Last paper",
        f"Claims filed in {year}", f"Claims paid in {year}" if money else f"Claims completed in {year}",
        "Profile complete (%)",
    ]
    if money:
        head += ["Research threshold (papers a year)", f"Incentives paid in {year} (₹)", "Incentives paid in total (₹)"]
    buf = io.StringIO()
    w = cell_safe.csv_writer(buf)
    w.writerow(head)
    for r in rows:
        line = [
            r["name"], _dash(r["staff_id"]), _dash(r["department"]), _dash(r["designation"]),
            "Research" if r["faculty_type"] == "RESEARCH" else "Regular",
            _dash(r["scopus_author_id"]), _dash(r["scopus_url"]), _dash(r["orcid_id"]),
            r["papers"], r["papers_year"], r["citations"], r["h_index"],
            r["last_paper_on"] or _dash(r["last_paper_year"]),
            r["claims_filed_year"], r["claims_done_year"], r["completeness"],
        ]
        if money:
            line += [_dash(r.get("threshold")), r["incentive"]["amount"], r["incentive"]["total_amount"]]
        w.writerow(line)
    resp = HttpResponse(("﻿" + buf.getvalue()).encode("utf-8"), content_type="text/csv; charset=utf-8")
    resp["Content-Disposition"] = f'attachment; filename="faculty-directory-{timezone.localdate().isoformat()}.csv"'
    resp["X-Total-Rows"] = str(len(rows))
    return resp


@api.get("/directory/faculty/gaps", auth=session_auth)
def faculty_gaps(request: HttpRequest, per: int = 8):
    """What is missing from the faculty record, for the office that fixes it.

    Counted over current staff: a leaver without a photo is not a gap to close.
    """
    viewer = require_user(request)
    if not rbac.can_manage_users(viewer.role):
        raise HttpError(403, "Only the research office and the super admin see what is missing.")
    people = list(
        User.objects.filter(role__in=DIRECTORY_POPULATION, active=True).order_by("name")
    )
    per = max(1, min(int(per), 50))
    cats = []
    for key, label, who, hint in GAPS:
        hit = [u for u in people if key in _missing(u)]
        cats.append({
            "key": key,
            "label": label,
            "count": len(hit),
            "who_fixes": who,
            "hint": hint,
            "people": [
                {
                    **social.person_brief(u),
                    # The account form fixes an identifier; a photo is theirs to add.
                    "fix_path": f"/people/{u.id}" if who == "office" else f"/faculty/{u.id}",
                }
                for u in hit[:per]
            ],
        })
    return {"population": len(people), "categories": cats, "any": any(c["count"] for c in cats)}


# ------------------------------------------------------------- the record -----


def _stage_for(viewer: User, c: Claim) -> str:
    if viewer.id == c.owner_id or viewer.role == Role.FACULTY:
        return faculty_stage(c.status, rejected_outright=bool(c.rejected_outright), ticket_number=c.ticket_number)
    if viewer.role == Role.HOD:
        return hod.progress_of(c.status)
    if c.status == ClaimStatus.REJECTED and c.rejected_outright:
        return "Rejected"
    return _STAFF_STAGE.get(c.status, "In progress")


def _may_review(viewer: User, c: Claim) -> bool:
    return (
        viewer.role in (*rbac.ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR)
        and viewer.id != c.owner_id
        and c.status != ClaimStatus.DRAFT
    )


def _claim_row(viewer: User, c: Claim, money: bool) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": c.id,
        "owner_id": c.owner_id,
        "claim_no": c.ticket_number,
        "title": c.paper_title,
        "journal": c.journal_title,
        "year": c.publication_year,
        "quartile": c.quartile,
        "author_position": c.author_position,
        "stage": _stage_for(viewer, c),
        "filed_on": c.submitted_at.date().isoformat() if c.submitted_at else None,
        "review_path": f"/review/{c.id}" if _may_review(viewer, c) else None,
    }
    if money and c.status == ClaimStatus.PAID:
        row["amount"] = c.remuneration
        row["paid_at"] = c.paid_at.isoformat() if c.paid_at else (c.payout_month.isoformat() if c.payout_month else None)
    return row


def _paper_row(p: dict, claim: Optional[Claim], ledger_row: Any, viewer: User, person: User, money: bool,
               ledgers_own: bool = False) -> dict[str, Any]:
    total = p.get("total_authors") or 0
    eligible = total <= MAX_ELIGIBLE_AUTHORS
    state: Optional[dict[str, Any]] = None
    if claim is not None:
        state = {"id": claim.id, "claim_no": claim.ticket_number, "stage": _stage_for(viewer, claim),
                 "review_path": f"/review/{claim.id}" if _may_review(viewer, claim) else None}
        if money and claim.status == ClaimStatus.PAID:
            state["amount"] = claim.remuneration
    elif ledger_row is not None:
        # "Paid" on a colleague's paper tells a head their colleague was paid,
        # which is nobody's business but the payer's (`hod.PROGRESS`): a head
        # reads "Completed", as everywhere else on their pages.
        stage = hod.progress_of(ClaimStatus.PAID) if viewer.role == Role.HOD and viewer.id != person.id else "Paid"
        state = {"id": ledger_row.claim_id, "claim_no": None, "stage": stage, "review_path": None}
        if money and ledgers_own:
            state["amount"] = ledger_row.amount
    elif p.get("source") == "claim":
        state = {"id": None, "claim_no": None, "stage": "Filed", "review_path": None}
    return {
        "id": p["id"],
        "owner_id": person.id,
        "title": p["title"],
        "year": p["year"],
        "date": p["date"],
        "venue": p["venue"],
        "type": p["type"],
        "quartile": p["quartile"],
        "citations": p["citations"],
        "doi": p["doi"],
        "scopus_indexed": p["scopus_indexed"],
        "author_position": p["author_position"],
        "total_authors": total or None,
        "corresponding": p["corresponding_author"],
        "topics": p["topics"],
        "claim": state,
        "eligible": eligible,
    }


def _payments(person: User) -> dict[str, Any]:
    year = timezone.localdate().year
    rows = list(ledger_for(person).filter(amount__gt=0).order_by("-payout_month", "-id"))
    seen = {r.claim_id for r in rows if r.claim_id}
    out = [
        {
            "id": r.id,
            "owner_id": person.id,
            "claim_id": r.claim_id,
            "month": r.payout_month.isoformat()[:7],
            "title": r.paper_title,
            "journal": r.journal_title,
            "amount": r.amount,
            "voucher": r.voucher_number,
        }
        for r in rows
    ]
    for c in Claim.objects.filter(owner=person, status=ClaimStatus.PAID).exclude(id__in=seen):
        on = c.paid_at.date() if c.paid_at else c.payout_month
        out.append({
            "id": f"claim-{c.id}", "owner_id": person.id, "claim_id": c.id,
            "month": on.isoformat()[:7] if on else None, "title": c.paper_title, "journal": c.journal_title,
            "amount": c.remuneration or 0, "voucher": c.voucher_number,
        })
    out.sort(key=lambda r: r["month"] or "", reverse=True)
    return {
        "owner_id": person.id,
        "total_amount": round(sum(r["amount"] or 0 for r in out), 2),
        "this_year": {"amount": round(sum(r["amount"] or 0 for r in out if (r["month"] or "").startswith(str(year))), 2)},
        "count": len(out),
        "year": year,
        "rows": out,
    }


def _topics(papers: list[dict]) -> list[dict[str, Any]]:
    c: Counter = Counter()
    for p in papers:
        for t in p.get("topics") or []:
            if isinstance(t, str) and t.strip():
                c[t.strip()] += 1
    return [{"name": k, "papers": n} for k, n in c.most_common(12)]


@api.get("/directory/faculty/{user_id}", auth=session_auth)
def faculty_record(request: HttpRequest, user_id: str):
    """One faculty member, everything held on them, shaped for whoever is asking."""
    viewer = require_user(request)
    person = viewer if user_id == "me" else get_object_or_404(User, pk=user_id)
    if not _may_see(viewer, person):
        raise HttpError(403, "You can open your own record, and your department's if you head one.")

    is_self = viewer.id == person.id
    money = _money_ok(viewer, person.id)
    office = rbac.can_manage_users(viewer.role)

    rec = _record(person, sort="year")
    pubs = rec["publications"]
    index, ledger = _ClaimIndex(person), _LedgerIndex(person)
    paper_rows = []
    for p in pubs:
        c = index.find(p)
        _fill_from_claim(p, c)
        row = ledger.find(p) if c is None else None
        paper_rows.append(_paper_row(p, c, row, viewer, person, money, bool(row is not None and ledger.is_mine(row))))

    claims_qs = Claim.objects.filter(owner=person)
    if not is_self:
        claims_qs = claims_qs.exclude(status=ClaimStatus.DRAFT)
    claims = [
        _claim_row(viewer, c, money)
        for c in claims_qs.order_by("-submitted_at", "-created_at")
    ]

    metrics = _metrics(person)
    metrics["total_publications"] = len(pubs)
    year = timezone.localdate().year

    by_year: dict[int, dict[str, int]] = {}
    quartiles: Counter = Counter()
    for p in pubs:
        if p["year"]:
            slot = by_year.setdefault(p["year"], {"year": p["year"], "papers": 0, "citations": 0})
            slot["papers"] += 1
            slot["citations"] += p["citations"] or 0
        quartiles[p["quartile"] or "Not recorded"] += 1

    graph_people = graph.coauthors(person)
    co_inside = graph_people.get("inside", [])[:12]
    co_outside = graph_people.get("outside", [])[:8]

    quota_visible = money and person.faculty_type == "RESEARCH"
    details: dict[str, Any] = {
        "bio": person.bio or None,
        "interests": list(
            ResearchInterest.objects.filter(user=person).order_by("domain").values_list("domain", flat=True)
        ),
        "skills": list(Skill.objects.filter(user=person).order_by("name").values_list("name", flat=True)),
        "joined": person.created_at.date().isoformat() if person.created_at else None,
        "changes_visible": bool(office or is_self),
        "changes": [],
    }
    if details["changes_visible"]:
        from core.api.auth import FIELD_LABELS

        details["changes"] = [
            {
                "id": r.id,
                "field": FIELD_LABELS.get(r.field, r.field.replace("_", " ")),
                "from": r.current_value or None,
                "to": r.proposed_value,
                "state": {"PENDING": "Waiting", "APPROVED": "Applied", "DECLINED": "Declined"}.get(r.status, "Waiting"),
                "note": r.note or None,
                "decision_note": r.decision_note or None,
                "asked_on": r.created_at.date().isoformat(),
                "decided_on": r.decided_at.date().isoformat() if r.decided_at else None,
            }
            for r in ProfileChangeRequest.objects.filter(user=person).order_by("-created_at")[:50]
        ]

    phone_ok = office or is_self
    email_ok = phone_ok or _sees_everyone(viewer.role) or viewer.role == Role.HOD
    body = {
        "person": {
            **social.person_brief(person),
            "owner_id": person.id,
            "active": bool(person.active),
            "role": person.role,
            "staff_id": person.staff_id or None,
            "employee_id": person.employee_id if (office or is_self) else None,
            "email": person.email if email_ok else None,
            "phone": (person.phone or None) if phone_ok else None,
            "scopus_author_id": person.scopus_author_id or None,
            "scopus_url": _scopus_link(person),
            "orcid_id": person.orcid_id or None,
            "orcid_url": f"https://orcid.org/{person.orcid_id}" if person.orcid_id else None,
            "faculty_type": person.faculty_type,
            "threshold_set": person.faculty_type == "RESEARCH" and person.research_quota is not None,
            **({"threshold": person.research_quota} if quota_visible else {}),
            "missing": _missing(person),
        },
        "viewer": {
            "is_self": is_self,
            "money": money,
            "may_edit": office,
            "sees_everyone": _sees_everyone(viewer.role),
            "year": year,
        },
        "metrics": {**metrics, "papers_this_year": sum(1 for p in pubs if p["year"] == year)},
        "papers": paper_rows,
        "claims": claims,
        "payments": _payments(person) if money else None,
        "research": {
            "by_year": [by_year[y] for y in sorted(by_year)],
            "quartiles": [{"name": k, "papers": v} for k, v in sorted(quartiles.items())],
            "topics": _topics(pubs),
            "interests": details["interests"],
            "coauthors_inside": co_inside,
            "coauthors_outside": co_outside,
            "scopus_profile": profile_dict(profile_for(person)),
        },
        "details": details,
    }
    # Money never reaches a head for anybody but themself: the rows above are
    # built without it, and `owner_id` on each row lets the renderer's
    # `hod.for_head` strip anything that slipped in.
    return body


__all__ = ["faculty_directory", "faculty_directory_csv", "faculty_gaps", "faculty_record"]
