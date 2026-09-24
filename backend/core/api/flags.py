"""discrepancy flags, the flagged queue, and looking into the past.

A flag is a question somebody has about a claim, and it never stops the claim
(see `core.models.ClaimFlag` and `core.services.flags`). Everything here is
for the desks that judge a paper -- the office roles and the Principal
(`rbac.can_review_flags`) -- and refused to everybody else: the Director and
Finance are not shown the doubts about what they authorise and pay, and a
claimant is not shown the doubts about their own paper.

"Looking into the past" is `/archive/claims`: every filed claim in the
college's history, paid and imported ones included, with how many open flags
each carries. A claim opens on its ordinary page; `/claims/{id}/review` adds
the flags and what its files were found to say.
"""

from __future__ import annotations

import json
from typing import Any, Optional

from django.db import transaction
from django.db.models import Count, Q
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import _refuse_own_claim, api, require_user, session_auth
from core.api.dashboard import _SEARCH_SORTS, _search_queryset
from core.models import AttachmentCheck, AuditLog, Claim, ClaimFlag, ClaimStatus, User
from core.services import rbac
from core.services import flags as flag_service
from core.services.content_check import enqueue_file_check

# ---------- discrepancy flags ----------

_NOT_YOURS = (
    "Flags are raised and reviewed by the research cell, the coordinator, the "
    "Principal and the super admin."
)
#: Long enough that the next reader has something to go on.
MIN_NOTE = 10


def _require_reviewer(request: HttpRequest) -> User:
    user = require_user(request)
    if not rbac.can_review_flags(user.role):
        raise HttpError(403, _NOT_YOURS)
    return user


def _filed_claim(claim_id: str) -> Claim:
    """Any claim that has been filed. A draft is its author's alone."""
    return get_object_or_404(
        Claim.objects.exclude(status=ClaimStatus.DRAFT).select_related("owner"), pk=claim_id
    )


def flag_to_dict(f: ClaimFlag) -> dict[str, Any]:
    return {
        "id": f.id,
        "claim_id": f.claim_id,
        "kind": f.kind,
        "kind_label": f.get_kind_display(),
        "source": f.source,
        "note": f.note,
        "open": f.is_open,
        "raised_by_name": f.raised_by.name if f.raised_by_id else None,
        "raised_at": f.raised_at.isoformat() if f.raised_at else None,
        "resolved_by_name": f.resolved_by.name if f.resolved_by_id else None,
        "resolved_at": f.resolved_at.isoformat() if f.resolved_at else None,
        "resolution_note": f.resolution_note,
    }


def file_check_to_dict(c: AttachmentCheck) -> dict[str, Any]:
    return {
        "id": c.id,
        "url": c.url,
        "kind": c.kind,
        "filename": c.filename,
        "outcome": c.outcome,
        "outcome_label": c.get_outcome_display(),
        "found": json.loads(c.found_json or "[]"),
        "missing": json.loads(c.missing_json or "[]"),
        "score": c.score,
        "detail": c.detail,
        "text_chars": c.text_chars,
        "checked_at": c.checked_at.isoformat() if c.checked_at else None,
    }


def _claim_summary(c: Claim) -> dict[str, Any]:
    return {
        "id": c.id,
        "ticket_number": c.ticket_number,
        "paper_title": c.paper_title,
        "owner_name": c.owner.name,
        "owner_department": c.owner.department,
        "status": c.status,
        "remuneration": c.remuneration,
        "paid_at": c.paid_at.isoformat() if c.paid_at else None,
    }


class FlagIn(Schema):
    kind: str
    note: str


class ResolveFlagIn(Schema):
    note: str


def _note(text: str | None, what: str) -> str:
    note = (text or "").strip()
    if len(note) < MIN_NOTE:
        raise HttpError(400, f"Say {what} ({MIN_NOTE}+ characters) — the next reader has only this to go on")
    return note


@api.get("/flags", auth=session_auth)
def list_flags(
    request: HttpRequest,
    status: str = "open",
    kind: Optional[str] = None,
    paid: Optional[str] = None,
    claim: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """The flagged queue, newest first. Open ones unless asked otherwise.

    `paid=yes` is the list the super admin is told about: money that went
    out with a question still open.
    """
    user = _require_reviewer(request)
    # A reviewer's own paper is theirs as its claimant, and a claimant is not
    # shown the doubts about it -- nor asked to answer them.
    everything = ClaimFlag.objects.exclude(claim__owner=user)
    qs = everything.select_related("claim", "claim__owner", "raised_by", "resolved_by")
    if status == "open":
        qs = qs.filter(resolved_at__isnull=True)
    elif status == "resolved":
        qs = qs.filter(resolved_at__isnull=False)
    elif status != "all":
        raise HttpError(400, "status is open, resolved or all")
    if kind:
        qs = qs.filter(kind=kind)
    if paid == "yes":
        qs = qs.filter(claim__status=ClaimStatus.PAID)
    elif paid == "no":
        qs = qs.exclude(claim__status=ClaimStatus.PAID)
    if claim:
        qs = qs.filter(claim_id=claim)

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    return {
        "total": qs.count(),
        "limit": limit,
        "offset": offset,
        "results": [
            {**flag_to_dict(f), "claim": _claim_summary(f.claim)}
            for f in qs.order_by("-raised_at", "-id")[offset : offset + limit]
        ],
        "summary": {
            "open": everything.filter(resolved_at__isnull=True).count(),
            "resolved": everything.filter(resolved_at__isnull=False).count(),
            "open_on_paid": everything.filter(
                resolved_at__isnull=True, claim__status=ClaimStatus.PAID
            ).count(),
        },
    }


@api.post("/flags/{flag_id}/resolve", auth=session_auth)
def resolve_flag(request: HttpRequest, flag_id: str, payload: ResolveFlagIn):
    """Record the answer to a flag. The claim itself does not move."""
    user = _require_reviewer(request)
    note = _note(payload.note, "what was found")
    # Locked, so two reviewers answering at once cannot both succeed and
    # leave the second one's name on the first one's answer.
    with transaction.atomic():
        flag = get_object_or_404(
            ClaimFlag.objects.select_for_update().select_related("claim"), pk=flag_id
        )
        _refuse_own_claim(user, flag.claim)
        if not flag.is_open:
            raise HttpError(409, "This flag has already been resolved")
        flag_service.resolve_flag(flag, actor=user, note=note)
    return flag_to_dict(flag)


@api.post("/claims/{claim_id}/flags", auth=session_auth)
def raise_flag(request: HttpRequest, claim_id: str, payload: FlagIn):
    """Flag a filed claim -- in the chain, paid, or imported -- without stopping it."""
    user = _require_reviewer(request)
    if payload.kind not in ClaimFlag.Kind.values:
        raise HttpError(400, f"kind is one of {', '.join(ClaimFlag.Kind.values)}")
    note = _note(payload.note, "what looks wrong")
    claim = _filed_claim(claim_id)
    _refuse_own_claim(user, claim)
    flag, _ = flag_service.raise_flag(claim, kind=payload.kind, note=note, actor=user)
    return flag_to_dict(flag)


@api.get("/claims/{claim_id}/review", auth=session_auth)
def claim_review(request: HttpRequest, claim_id: str):
    """The flags on a claim and what its files were found to say."""
    user = _require_reviewer(request)
    claim = _filed_claim(claim_id)
    _refuse_own_claim(user, claim)
    return {
        "flags": [
            flag_to_dict(f)
            for f in claim.flags.select_related("raised_by", "resolved_by").order_by("-raised_at")
        ],
        "file_checks": [file_check_to_dict(c) for c in claim.file_checks.all()],
    }


@api.post("/claims/{claim_id}/check-files", auth=session_auth)
def check_files(request: HttpRequest, claim_id: str):
    """Read the claim's PDFs again, on the job queue. Returns what is known now."""
    user = _require_reviewer(request)
    claim = _filed_claim(claim_id)
    _refuse_own_claim(user, claim)
    job = enqueue_file_check(claim.id, force=True)
    AuditLog.objects.create(
        actor=user,
        action="CLAIM_FILES_CHECK",
        entity="Claim",
        entity_id=claim.id,
        detail_json=json.dumps({"ticket": claim.ticket_number, "job": job}),
    )
    return {
        "queued": job is not None,
        "file_checks": [file_check_to_dict(c) for c in claim.file_checks.all()],
    }


# ---------- looking into the past ----------


@api.get("/archive/claims", auth=session_auth)
def archive_claims(
    request: HttpRequest,
    q: Optional[str] = None,
    status: Optional[str] = None,
    year: Optional[int] = None,
    department: Optional[str] = None,
    flagged: Optional[str] = None,
    sort: str = "recent",
    limit: int = 50,
    offset: int = 0,
):
    """Every filed claim in the college's history, with its open flags.

    Paid and imported claims included: the point is to go back over what was
    already paid. Drafts are not, for the reason they never are.
    """
    user = _require_reviewer(request)
    # Every claim but the reviewer's own: each row carries its open flags.
    qs = _search_queryset(
        user, q=q, status=status, year=year, department=department
    ).exclude(owner=user).annotate(
        open_flags=Count("flags", filter=Q(flags__resolved_at__isnull=True), distinct=True),
        file_count=Count("attachments", distinct=True),
    )
    if flagged == "open":
        qs = qs.filter(open_flags__gt=0)
    elif flagged == "none":
        qs = qs.filter(open_flags=0)

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    rows = qs.order_by(_SEARCH_SORTS.get(sort, "-updated_at"), "-id")[offset : offset + limit]
    return {
        "total": qs.count(),
        "limit": limit,
        "offset": offset,
        "results": [
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "paper_title": c.paper_title,
                "journal_title": c.journal_title,
                "publication_year": c.publication_year,
                "status": c.status,
                "status_note": c.status_note,
                "owner_name": c.owner.name,
                "owner_department": c.owner.department,
                "remuneration": c.remuneration,
                "paid_at": c.paid_at.isoformat() if c.paid_at else None,
                "file_count": c.file_count,
                "open_flags": c.open_flags,
            }
            for c in rows
        ],
    }


__all__ = [
    'FlagIn',
    'MIN_NOTE',
    'ResolveFlagIn',
    '_claim_summary',
    '_filed_claim',
    '_require_reviewer',
    'archive_claims',
    'check_files',
    'claim_review',
    'file_check_to_dict',
    'flag_to_dict',
    'list_flags',
    'raise_flag',
    'resolve_flag',
]
