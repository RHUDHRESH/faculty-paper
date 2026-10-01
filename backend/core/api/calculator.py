"""The incentive calculator's routes: price a paper, check a claim, check many.

Everything is read-only. `POST /calculator/price` is a POST only because it
takes a body; no route here writes a claim, a ledger row or an audit entry. The
arithmetic is `core.services.remuneration`'s, reached through
`core.services.calculator`, so a figure here is the figure a claim would get.

Who: the research cell, the research coordinator, a super admin, the Principal,
the Director and Finance. A head of department and a faculty member are
refused: the head is money-blind, and faculty already have the estimate in
filing.
"""

from __future__ import annotations

import io
from typing import Optional

from django.conf import settings
from django.db.models import Q
from django.http import HttpRequest, HttpResponse
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, rate_limit, require_user, session_auth
from core.models import Claim, ClaimStatus, Role, User
from core.services import calculator, claim_numbers, rbac
from core.services.cell_safe import csv_writer
from core.services.normalize import normalize_doi

CALCULATOR_ROLES = (*rbac.ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR, Role.FINANCE)


def _require_calculator(request: HttpRequest) -> User:
    user = require_user(request)
    if user.role not in CALCULATOR_ROLES:
        raise HttpError(
            403,
            "The calculator is for the research cell, the Principal, the Director and Finance.",
        )
    return user


class PriceIn(Schema):
    publication_type: Optional[str] = None
    indexing_level: Optional[str] = None
    quartile: Optional[str] = None
    snip: Optional[float] = None
    engineering_class: Optional[str] = None
    total_authors: int = 1
    #: One position, or several to price co-authors at the college.
    positions: list[int] = [1]
    sec_reference_count: Optional[int] = None
    student_project: bool = False
    counted_only: bool = False
    policy_id: Optional[str] = None
    person_id: Optional[str] = None


@api.get("/calculator/options", auth=session_auth)
def calculator_options(request: HttpRequest):
    """What the form offers: the policy versions and the paper types the policy names."""
    _require_calculator(request)
    policies = calculator.policy_options()
    _obj, cfg, _in_force = calculator.config_for(None)
    types = list((cfg.publication_type_multipliers or {}).keys())
    return {
        "policies": policies,
        "in_force": next((p for p in policies if p["in_force"]), None),
        "publication_types": types,
        "quartiles": ["Q1", "Q2", "Q3", "Q4"],
        "limits": {
            "max_authors": cfg.max_authors,
            "min_sec_references": cfg.min_sec_references,
            "student_project_amount": cfg.student_project_amount,
        },
    }


@api.post("/calculator/price", auth=session_auth)
def calculator_price(request: HttpRequest, payload: PriceIn):
    """Price a paper under a policy version, with the working line by line."""
    _require_calculator(request)
    if payload.total_authors < 1 or payload.total_authors > 200:
        raise HttpError(400, "Total authors must be a whole number from 1 upwards.")
    positions = [p for p in payload.positions if isinstance(p, int)] or [1]
    if len(positions) > 20:
        raise HttpError(400, "Tick at most 20 positions.")
    person = None
    if payload.person_id:
        person = User.objects.filter(pk=payload.person_id).first()
        if person is None:
            raise HttpError(404, "No such person.")
    inp = calculator.PaperInputs(
        publication_type=(payload.publication_type or "").strip() or None,
        indexing_level=(payload.indexing_level or "").strip() or None,
        quartile=(payload.quartile or "").strip() or None,
        snip=payload.snip,
        engineering_class=(payload.engineering_class or "").strip() or None,
        total_authors=payload.total_authors,
        positions=positions,
        sec_reference_count=payload.sec_reference_count,
        student_project=payload.student_project,
        counted_only=payload.counted_only,
    )
    return calculator.price_paper(inp, policy_id=payload.policy_id, person=person)


@api.get("/calculator/people", auth=session_auth)
def calculator_people(request: HttpRequest, q: str = ""):
    """Find a person, to apply their research threshold to a price."""
    _require_calculator(request)
    q = (q or "").strip()
    if len(q) < 2:
        return {"results": []}
    qs = User.objects.filter(active=True)
    for word in q.split()[:4]:
        qs = qs.filter(
            Q(name__icontains=word) | Q(email__icontains=word) | Q(staff_id__icontains=word)
        )
    return {
        "results": [
            {
                "user_id": u.id,
                "name": u.name,
                "department": u.department,
                "research": u.faculty_type == "RESEARCH",
            }
            for u in qs.order_by("name")[:8]
        ]
    }


def _prefill_from_claim(c: Claim) -> dict:
    inp = calculator.claim_inputs(c)
    return {
        "kind": "claim",
        "message": f"Filled from claim {c.ticket_number}. Change anything to try another case.",
        "inputs": inp,
        "claim_id": c.id,
        "ticket_number": c.ticket_number,
    }


@api.get("/calculator/prefill", auth=session_auth)
def calculator_prefill(request: HttpRequest, q: str = ""):
    """Inputs for the form, from a claim number or a DOI. Never blocks.

    A claim number gives the claim's stored inputs. A DOI first tries a claim
    already filed with it, then Scopus; a Scopus failure is a sentence, not an
    error, and the form stays as it is.
    """
    _require_calculator(request)
    q = (q or "").strip()
    if not q:
        return {"kind": "none", "message": "Type a claim number or a DOI.", "inputs": None}
    if claim_numbers.looks_like_claim_number(q):
        c = calculator.find_claim(q)
        if c is None:
            return {"kind": "none", "message": "No claim has that number.", "inputs": None}
        return _prefill_from_claim(c)
    doi = normalize_doi(q)
    if not doi or not doi.startswith("10."):
        c = calculator.find_claim(q)
        if c is not None:
            return _prefill_from_claim(c)
        return {"kind": "none", "message": "That is not a claim number or a DOI.", "inputs": None}
    c = (
        Claim.objects.select_related("owner")
        .exclude(status=ClaimStatus.DRAFT)
        .filter(doi__iexact=doi)
        .order_by("-created_at")
        .first()
    )
    if c is not None:
        out = _prefill_from_claim(c)
        out["kind"] = "doi_claim"
        out["message"] = f"A claim ({c.ticket_number}) was already filed with this DOI. Filled from it."
        return out
    try:
        from core.services.scimago import lookup_scimago
        from core.services.scopus import lookup_paper_by_doi, lookup_serial_by_issn

        paper = lookup_paper_by_doi(doi)
        if not paper:
            return {"kind": "none", "message": "Scopus does not know that DOI. Enter the figures by hand.", "inputs": None}
        issn = paper.get("issn")
        serial = lookup_serial_by_issn(issn) if issn else None
        sc = lookup_scimago(issn=issn, title=paper.get("journal_title"), subject=None) or {}
    except Exception:  # never block: the form works without the lookup
        return {
            "kind": "none",
            "message": "Scopus could not be reached, so nothing was filled in. Enter the figures by hand.",
            "inputs": None,
        }
    agg = (paper.get("aggregation_type") or "").lower()
    ptype = {"journal": "Journal", "conference proceeding": "Conference Proceeding", "book series": "Book Series"}.get(
        agg, paper.get("aggregation_type")
    )
    return {
        "kind": "doi",
        "message": "Filled from Scopus. Check each figure: the college verifies them when a claim is filed.",
        "inputs": {
            "publication_type": ptype,
            "indexing_level": "Scopus",
            "quartile": sc.get("matched_quartile") if sc.get("found") else None,
            "snip": (serial or {}).get("snip"),
            "engineering_class": None,
            "total_authors": paper.get("author_count") or 1,
            "author_position": 1,
            "student_project": False,
            "counted_only": False,
        },
    }


@api.get("/calculator/claim", auth=session_auth)
def calculator_claim(request: HttpRequest, q: str = ""):
    """Check a claim: what was recorded, what the formula gives under the policy
    it was priced with and under the policy in force, and what the ledger shows."""
    _require_calculator(request)
    if not (q or "").strip():
        raise HttpError(400, "Type a claim number.")
    c = calculator.find_claim(q)
    if c is None:
        raise HttpError(404, "No claim has that number.")
    return calculator.explain_claim(c)


def _stages(raw: str | None, submitted: bool) -> list[str]:
    stages = [s for s in (raw or "").split(",") if s in calculator.STAGE_STATUSES and s != "submitted"]
    stages = stages or list(calculator.DEFAULT_STAGES)
    if submitted:
        stages.append("submitted")
    return stages


@api.get("/calculator/many", auth=session_auth)
def calculator_many(
    request: HttpRequest,
    stage: Optional[str] = None,
    submitted: bool = False,
    department: Optional[str] = None,
    month: Optional[str] = None,
    cause: Optional[str] = None,
    direction: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
):
    """Every claim in the chosen stages against its own pricing snapshot; the
    ones that differ by more than ₹1, with the cause, and the totals.

    `direction` narrows the list to claims recorded above ("over") or below
    ("under") what the formula gives; `listed` totals whatever is listed."""
    _require_calculator(request)
    result = calculator.check_many(
        stages=_stages(stage, submitted), department=department or None, month=month or None
    )
    rows = _narrow(result["rows"], cause, direction)
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    listed = {
        "count": len(rows),
        "recorded": round(sum(r["recorded"] or 0 for r in rows), 2),
        "formula": round(sum(r["formula"] or 0 for r in rows), 2),
        "difference": round(sum(r["difference"] for r in rows), 2),
    }
    return {
        **result,
        "rows": rows[offset : offset + limit],
        "row_total": len(rows),
        "listed": listed,
        "limit": limit,
        "offset": offset,
    }


def _narrow(rows: list[dict], cause: str | None, direction: str | None) -> list[dict]:
    if cause:
        rows = [r for r in rows if r["cause"] == cause]
    if direction == "over":
        rows = [r for r in rows if r["difference"] > 0]
    elif direction == "under":
        rows = [r for r in rows if r["difference"] < 0]
    return rows


@api.get("/calculator/many.csv", auth=session_auth)
def calculator_many_csv(
    request: HttpRequest,
    stage: Optional[str] = None,
    submitted: bool = False,
    department: Optional[str] = None,
    month: Optional[str] = None,
    cause: Optional[str] = None,
    direction: Optional[str] = None,
):
    """The same list, for a spreadsheet. Cells are escaped by `cell_safe`."""
    _require_calculator(request)
    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    result = calculator.check_many(
        stages=_stages(stage, submitted), department=department or None, month=month or None
    )
    rows = _narrow(result["rows"], cause, direction)
    buf = io.StringIO()
    w = csv_writer(buf)
    w.writerow(
        [
            "Claim no.",
            "Claimant",
            "Department",
            "Paper",
            "Status",
            "Month",
            "Recorded amount",
            "Policy amount before threshold",
            "Formula amount",
            "Difference",
            "Priced under",
            "Cause",
            "Explanation",
        ]
    )
    for r in rows:
        w.writerow(
            [
                r["ticket_number"],
                r["name"],
                r["department"],
                r["title"],
                r["status"],
                r["month"],
                "" if r["recorded"] is None else f"{r['recorded']:.2f}",
                f"{r['policy_amount']:.2f}",
                "" if r["formula"] is None else f"{r['formula']:.2f}",
                f"{r['difference']:.2f}",
                r["policy"],
                r["cause_label"],
                r["cause_text"],
            ]
        )
    resp = HttpResponse(("﻿" + buf.getvalue()).encode("utf-8"), content_type="text/csv; charset=utf-8")
    resp["Content-Disposition"] = 'attachment; filename="incentive-check.csv"'
    return resp


__all__ = [
    "CALCULATOR_ROLES",
    "calculator_claim",
    "calculator_many",
    "calculator_many_csv",
    "calculator_options",
    "calculator_people",
    "calculator_prefill",
    "calculator_price",
]
