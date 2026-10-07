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

from django.conf import settings
from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Q
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import _refuse_own_claim, api, require_user, session_auth
from core.api.dashboard import _SEARCH_SORTS, _search_queryset
from core.services import proof_locker
from core.models import AttachmentCheck, AuditLog, Claim, ClaimFlag, ClaimStatus, User
from core.services import rbac
from core.services import flags as flag_service
from core.services.content_check import enqueue_file_check
from core.visibility import ERP_CLOSED_NOTE

# ---------- discrepancy flags ----------

_NOT_YOURS = (
    "Flags are raised and reviewed by the research office, the coordinator, the "
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


#: What each automatic check is asking, in the words a reviewer uses. The
#: keys are `ClaimFlag.auto_key` (or its prefix for the file check).
_RULE_HEADLINES = {
    "import:paid-zero": "Paid nothing, but the old ERP's own working gives a figure",
    "import:paid-rejected": "Paid, but the old ERP says it was rejected",
    "file": "The file does not match the claim",
}

_MANUAL_HEADLINES = {
    "AMOUNT": "The amount looks wrong",
    "CONTENT_MISMATCH": "The file does not match the claim",
    "AUTHOR": "The author or position looks wrong",
    "AFFILIATION": "The college is missing from the paper",
    "DUPLICATE": "It looks like a paper already paid",
    "OTHER": "A reviewer had a question",
}


def rule_of(source: str, kind: str, auto_key: Optional[str]) -> str:
    """The question a flag asks, as a stable key: what the Flags page groups by."""
    if auto_key and auto_key.startswith("import:"):
        return auto_key
    if auto_key and auto_key.startswith("file:"):
        return "file"
    if source == ClaimFlag.Source.AUTO:
        return "check"
    return f"manual:{kind}"


def headline_of(rule: str) -> str:
    if rule in _RULE_HEADLINES:
        return _RULE_HEADLINES[rule]
    if rule.startswith("manual:"):
        return _MANUAL_HEADLINES.get(rule.split(":", 1)[1], "A reviewer had a question")
    return "A check found something"


def _filter_rule(qs, rule: str):
    if rule.startswith("import:"):
        return qs.filter(auto_key=rule)
    if rule == "file":
        return qs.filter(auto_key__startswith="file:")
    if rule.startswith("manual:"):
        return qs.filter(source=ClaimFlag.Source.MANUAL, kind=rule.split(":", 1)[1])
    if rule == "check":
        return qs.filter(source=ClaimFlag.Source.AUTO).exclude(auto_key__startswith="import:").exclude(
            auto_key__startswith="file:"
        )
    raise HttpError(400, "rule is not one this page knows")


def flag_to_dict(f: ClaimFlag) -> dict[str, Any]:
    rule = rule_of(f.source, f.kind, f.auto_key)
    return {
        "id": f.id,
        "claim_id": f.claim_id,
        "kind": f.kind,
        "kind_label": f.get_kind_display(),
        "rule": rule,
        "headline": headline_of(rule),
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
        "origin": _erp_origin(c.ticket_number),
        "paper_title": c.paper_title,
        "owner_id": c.owner_id,
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
        raise HttpError(400, f"Say {what} ({MIN_NOTE}+ characters). The next reader has only this to go on")
    return note


@api.get("/flags", auth=session_auth)
def list_flags(
    request: HttpRequest,
    status: str = "open",
    kind: Optional[str] = None,
    paid: Optional[str] = None,
    claim: Optional[str] = None,
    rule: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """The flagged queue, newest first. Open ones unless asked otherwise.

    `paid=yes` is the list the super admin is told about: money that went
    out with a question still open. `rule` narrows to one question (see
    `rule_of`); `summary.groups` counts the open flags under each.
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
    if rule:
        qs = _filter_rule(qs, rule)

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    # What is open, grouped by the question it asks: the page's answer.
    groups: dict[str, dict[str, Any]] = {}
    for src, kind_, key, paid_ in everything.filter(resolved_at__isnull=True).values_list(
        "source", "kind", "auto_key", "claim__status"
    ):
        r = rule_of(src, kind_, key)
        g = groups.setdefault(r, {"rule": r, "headline": headline_of(r), "open": 0, "open_on_paid": 0})
        g["open"] += 1
        if paid_ == ClaimStatus.PAID:
            g["open_on_paid"] += 1
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
            "groups": sorted(groups.values(), key=lambda g: (-g["open_on_paid"], -g["open"])),
        },
    }


class ResolveManyIn(Schema):
    flag_ids: list[str]
    note: str


@api.post("/flags/resolve-many", auth=session_auth)
def resolve_many_flags(request: HttpRequest, payload: ResolveManyIn):
    """Give the same answer to several open flags at once (up to 200).

    For a batch that asks one question and has one answer, such as fifty
    imported rows checked against the accounts sheet. Each flag is decided on
    its own: one that is already answered, or is on the viewer's own claim, is
    skipped by name and the rest go through. Every one is audit-logged.
    """
    user = _require_reviewer(request)
    note = _note(payload.note, "what was found")
    ids = list(dict.fromkeys(i for i in payload.flag_ids if isinstance(i, str) and i))
    if not ids:
        raise HttpError(400, "Choose at least one flag.")
    if len(ids) > 200:
        raise HttpError(400, "Resolve up to 200 flags at a time.")
    done: list[str] = []
    skipped: list[dict[str, Any]] = []
    with transaction.atomic():
        found = {
            f.id: f
            for f in ClaimFlag.objects.select_for_update().select_related("claim", "claim__owner").filter(pk__in=ids)
        }
        for fid in ids:
            f = found.get(fid)
            if f is None:
                skipped.append({"flag_id": fid, "ticket_number": None, "reason": "No such flag."})
            elif f.claim.owner_id == user.id:
                skipped.append({"flag_id": fid, "ticket_number": f.claim.ticket_number, "reason": "This is on your own claim. Another officer answers it."})
            elif not f.is_open:
                skipped.append({"flag_id": fid, "ticket_number": f.claim.ticket_number, "reason": "Already resolved."})
            else:
                flag_service.resolve_flag(f, actor=user, note=note)
                done.append(fid)
    return {"resolved": len(done), "flag_ids": done, "skipped": skipped}


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
        # What the claimant's proof locker found on the same files, by URL.
        "locker_checks": proof_locker.checks_by_url(claim),
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


# The sheets of the old ERP workbook a ticket can have come from, by the tag
# `erp_import.stable_ticket` writes into its number.
_ERP_SHEETS = {
    "RAW": "Raw data sheet",
    "PROCESSED": "Processed sheet",
    "ACCOUNTS": "Accounts sheet",
}


def _erp_origin(ticket: Optional[str]) -> Optional[str]:
    """"Imported from the ERP, <sheet>" for an imported ticket, else None.

    The importer writes notes like "Imported from Raw_Data" to
    `status_note`, which read as a reason the claim was sent back.
    """
    if not ticket or not ticket.startswith("ERP-"):
        return None
    tag = ticket.split("-")[1] if ticket.count("-") >= 2 else ""
    sheet = _ERP_SHEETS.get(tag)
    return f"Imported from the ERP, {sheet}" if sheet else "Imported from the ERP"


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
    rows = list(qs.select_related("owner").order_by(_SEARCH_SORTS.get(sort, "-updated_at"), "-id")[offset : offset + limit])

    # The same paper claimed again: how many OTHER claims carry this DOI. One
    # query for the page, not one per row.
    dois = {c.doi for c in rows if c.doi}
    doi_count: dict[str, int] = {}
    if dois:
        for d, n in (
            Claim.objects.exclude(status=ClaimStatus.DRAFT)
            .filter(doi__in=dois)
            .values_list("doi")
            .annotate(n=Count("id"))
            .values_list("doi", "n")
        ):
            doi_count[d.strip().lower()] = n

    # What the record holds, whatever status or flag filter is chosen (each
    # figure on the page is a link that sets one). Counts only.
    everyone = _search_queryset(user, q=q, status=None, year=year, department=department).exclude(owner=user)
    # ERP claims closed as handled in the old system are neither moving nor
    # refused here: counted apart.
    erp_closed = everyone.filter(status=ClaimStatus.REJECTED, status_note=ERP_CLOSED_NOTE).count()
    by_status: dict[tuple[str, bool], int] = {}
    for st, outright, n in everyone.exclude(status=ClaimStatus.REJECTED, status_note=ERP_CLOSED_NOTE).order_by().values_list(
        "status", "rejected_outright"
    ).annotate(n=Count("id")).values_list("status", "rejected_outright", "n"):
        by_status[(st, bool(outright))] = by_status.get((st, bool(outright)), 0) + n
    summary = {
        "all": sum(by_status.values()) + erp_closed,
        "closed_old_system": erp_closed,
        "paid": sum(n for (st, _), n in by_status.items() if st == ClaimStatus.PAID),
        "sent_back": sum(n for (st, o), n in by_status.items() if st == ClaimStatus.REJECTED and not o),
        "not_accepted": sum(n for (st, o), n in by_status.items() if st == ClaimStatus.REJECTED and o),
        "with_open_flags": everyone.filter(
            Exists(ClaimFlag.objects.filter(claim=OuterRef("pk"), resolved_at__isnull=True))
        ).count(),
    }
    summary["moving"] = (
        summary["all"] - summary["paid"] - summary["sent_back"] - summary["not_accepted"] - erp_closed
    )
    return {
        "total": qs.count(),
        "limit": limit,
        "offset": offset,
        "summary": summary,
        "results": [
            {
                "rejected_outright": bool(c.rejected_outright),
                "doi": c.doi,
                "same_doi_others": max(0, doi_count.get((c.doi or "").strip().lower(), 1) - 1) if c.doi else 0,
                "id": c.id,
                "ticket_number": c.ticket_number,
                "paper_title": c.paper_title,
                "journal_title": c.journal_title,
                "publication_year": c.publication_year,
                "status": c.status,
                "status_note": c.status_note,
                "owner_id": c.owner_id,
                "owner_name": c.owner.name,
                "owner_department": c.owner.department,
                "owner_photo_url": f"{settings.MEDIA_URL}{c.owner.photo}" if c.owner.photo else None,
                "origin": _erp_origin(c.ticket_number),
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
    'resolve_many_flags',
    'ResolveManyIn',
    'rule_of',
    'headline_of',
]
