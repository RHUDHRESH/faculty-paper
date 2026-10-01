"""Review marks on a claim: list, create, edit, resolve.

See `core.services.review_marks` for the visibility rules. In short:

* Whoever sits at the desk the claim is at (`rbac.can_act_at_desk`) creates,
  edits, resolves, reopens and deletes marks. The Principal and the office
  roles also read the marks on claims at other stages.
* The claimant (the owner, whatever their role) reads only the CLAIMANT marks
  that went back with a send-back, as "The college".
* The Director and Finance receive an empty list; everybody else is refused.
* Nobody marks, edits or resolves a mark on their own claim.
"""
from __future__ import annotations

import json
from typing import Optional

from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core import visibility
from core.api.common import _refuse_own_claim, api, require_user, session_auth
from core.models import AuditLog, Claim, ClaimAttachment, ClaimStatus, ReviewMark, User
from core.services import rbac
from core.services import review_marks as marks_service

MAX_BODY = 2000
MAX_QUOTE = 2000
MAX_PAGE = 5000


class RectIn(Schema):
    x: float
    y: float
    w: float
    h: float


class MarkIn(Schema):
    upload_id: Optional[str] = None
    page: Optional[int] = None
    rect: Optional[RectIn] = None
    quote: Optional[str] = None
    kind: str = "ISSUE"
    #: Defaults by kind: ISSUE is for the claimant, OK and NOTE are staff only.
    audience: Optional[str] = None
    checklist_key: Optional[str] = None
    body: Optional[str] = None


class MarkPatch(Schema):
    page: Optional[int] = None
    rect: Optional[RectIn] = None
    quote: Optional[str] = None
    kind: Optional[str] = None
    audience: Optional[str] = None
    checklist_key: Optional[str] = None
    body: Optional[str] = None


def _filed_claim(claim_id: str) -> Claim:
    """A drafted paper is its author's alone: it has no marks."""
    return get_object_or_404(
        Claim.objects.exclude(status=ClaimStatus.DRAFT).select_related("owner"), pk=claim_id
    )


def _seat(user: User, claim: Claim) -> str:
    """How `user` relates to `claim`: claimant, reviewer, blind, or nobody."""
    if rbac.is_own_claim(user, claim):
        return "claimant"
    if rbac.can_review_flags(user.role):
        return "reviewer"
    if visibility.is_contest_blind(user.role):
        return "blind"
    raise HttpError(403, "Marks are for the college's reviewers and the claim's owner.")


def _may_mark(user: User, claim: Claim) -> bool:
    return (
        not rbac.is_own_claim(user, claim)
        and rbac.can_act_at_desk(user.role, rbac.desk_for_status(claim.status))
    )


def _require_marker(user: User, claim: Claim) -> None:
    """Refuse unless `user` may mark `claim` at the stage it is at."""
    _refuse_own_claim(user, claim)
    if not rbac.can_review_flags(user.role):
        raise HttpError(403, "Only the college's reviewers mark a claim.")
    if not _may_mark(user, claim):
        raise HttpError(403, "This paper is not at your desk, so you cannot mark it.")


def _check_rect(rect) -> tuple[float, float, float, float] | None:
    if rect is None:
        return None
    x, y, w, h = rect.x, rect.y, rect.w, rect.h
    ok = (
        0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1
        and x + w <= 1.001 and y + h <= 1.001
    )
    if not ok:
        raise HttpError(400, "The marked area must sit inside the page.")
    return x, y, w, h


def _check_choices(kind: str | None, audience: str | None, key: str | None) -> None:
    if kind is not None and kind not in ReviewMark.Kind.values:
        raise HttpError(400, "Kind must be Issue, OK or Note.")
    if audience is not None and audience not in ReviewMark.Audience.values:
        raise HttpError(400, "Audience must be the claimant or staff only.")
    if key and key not in ReviewMark.Checklist.values:
        raise HttpError(400, "Unknown checklist item.")


def _check_content(mark: ReviewMark) -> None:
    """What is left after any edit must still say something."""
    has_rect = mark.rect_x is not None
    if mark.audience == ReviewMark.Audience.CLAIMANT and mark.kind == ReviewMark.Kind.ISSUE:
        if len((mark.body or "").strip()) < 3:
            raise HttpError(400, "Say what the claimant should fix.")
    if not (
        (mark.body or "").strip() or (mark.quote or "").strip() or has_rect or mark.checklist_key
    ):
        raise HttpError(400, "Add a note, a quote or an area to mark.")
    if has_rect and (mark.upload_id is None or not mark.page):
        raise HttpError(400, "An area needs its document and page.")
    if mark.upload_id is not None and not mark.page:
        mark.page = 1


def _audit(user: User, claim: Claim, action: str, mark: ReviewMark) -> None:
    AuditLog.objects.create(
        actor=user, action=action, entity="Claim", entity_id=claim.id,
        detail_json=json.dumps({"mark_id": mark.id, "kind": mark.kind, "audience": mark.audience}),
    )


def _mark_and_claim(mark_id: str) -> tuple[ReviewMark, Claim]:
    mark = get_object_or_404(
        ReviewMark.objects.select_related(
            "claim", "claim__owner", "upload", "author", "resolved_by"
        ),
        pk=mark_id,
    )
    return mark, mark.claim


@api.get("/claims/{claim_id}/marks", auth=session_auth)
def list_marks(request: HttpRequest, claim_id: str):
    """The marks on a claim, as the reader may see them.

    `viewer` is "reviewer", "claimant" or "blind"; `can_mark` says whether the
    reader may add marks at the stage the claim is at; `send_back` is the
    latest thing that went back to the claimant (reason, marks and failed
    checklist items as they stood), or null.
    """
    user = require_user(request)
    claim = _filed_claim(claim_id)
    seat = _seat(user, claim)
    if seat == "blind":
        return {"results": [], "viewer": seat, "can_mark": False, "send_back": None}
    latest = claim.send_backs.first()
    if seat == "claimant":
        return {
            "results": [marks_service.for_claimant(m) for m in marks_service.claimant_marks(claim)],
            "viewer": seat,
            "can_mark": False,
            "send_back": marks_service.send_back_dict(latest),
        }
    return {
        "results": [marks_service.for_staff(m) for m in marks_service.staff_marks(claim)],
        "viewer": seat,
        "can_mark": _may_mark(user, claim),
        "send_back": marks_service.send_back_dict(latest),
    }


@api.post("/claims/{claim_id}/marks", auth=session_auth)
def create_mark(request: HttpRequest, claim_id: str, payload: MarkIn):
    user = require_user(request)
    claim = _filed_claim(claim_id)
    _require_marker(user, claim)
    _check_choices(payload.kind, payload.audience, payload.checklist_key)
    upload = None
    if payload.upload_id:
        upload = ClaimAttachment.objects.filter(pk=payload.upload_id, claim=claim).first()
        if upload is None:
            raise HttpError(400, "That document is not on this claim.")
    if payload.page is not None and not 1 <= payload.page <= MAX_PAGE:
        raise HttpError(400, "Page must be 1 or more.")
    rect = _check_rect(payload.rect)
    mark = ReviewMark(
        claim=claim,
        upload=upload,
        page=payload.page if upload else None,
        quote=(payload.quote or "").strip()[:MAX_QUOTE],
        kind=payload.kind,
        audience=payload.audience or marks_service.default_audience(payload.kind),
        checklist_key=payload.checklist_key or "",
        body=(payload.body or "").strip()[:MAX_BODY],
        author=user,
    )
    if rect:
        mark.rect_x, mark.rect_y, mark.rect_w, mark.rect_h = rect
    _check_content(mark)
    mark.save()
    _audit(user, claim, "REVIEW_MARK_ADD", mark)
    return marks_service.for_staff(mark)


@api.patch("/marks/{mark_id}", auth=session_auth)
def update_mark(request: HttpRequest, mark_id: str, payload: MarkPatch):
    user = require_user(request)
    mark, claim = _mark_and_claim(mark_id)
    _require_marker(user, claim)
    data = payload.model_dump(exclude_unset=True)
    _check_choices(data.get("kind"), data.get("audience"), data.get("checklist_key"))
    if data.get("kind"):
        mark.kind = data["kind"]
    if data.get("audience"):
        mark.audience = data["audience"]
    if "checklist_key" in data:
        mark.checklist_key = data["checklist_key"] or ""
    if "body" in data:
        mark.body = (data["body"] or "").strip()[:MAX_BODY]
    if "quote" in data:
        mark.quote = (data["quote"] or "").strip()[:MAX_QUOTE]
    if data.get("page") is not None:
        if not 1 <= data["page"] <= MAX_PAGE:
            raise HttpError(400, "Page must be 1 or more.")
        mark.page = data["page"]
    if "rect" in data:
        rect = _check_rect(payload.rect)
        if rect is None:
            mark.rect_x = mark.rect_y = mark.rect_w = mark.rect_h = None
        else:
            mark.rect_x, mark.rect_y, mark.rect_w, mark.rect_h = rect
    _check_content(mark)
    mark.save()
    _audit(user, claim, "REVIEW_MARK_EDIT", mark)
    return marks_service.for_staff(mark)


@api.post("/marks/{mark_id}/resolve", auth=session_auth)
def resolve_mark(request: HttpRequest, mark_id: str):
    """Close a mark: the problem is fixed, or (on a "fixed?" mark) confirmed."""
    user = require_user(request)
    mark, claim = _mark_and_claim(mark_id)
    _require_marker(user, claim)
    if not mark.resolved_at:
        mark.resolved_at = timezone.now()
        mark.resolved_by = user
        mark.save(update_fields=["resolved_at", "resolved_by", "updated_at"])
        _audit(user, claim, "REVIEW_MARK_RESOLVE", mark)
    return marks_service.for_staff(mark)


@api.post("/marks/{mark_id}/reopen", auth=session_auth)
def reopen_mark(request: HttpRequest, mark_id: str):
    """Not fixed after all: the mark is open again and goes back with the next send-back."""
    user = require_user(request)
    mark, claim = _mark_and_claim(mark_id)
    _require_marker(user, claim)
    mark.resolved_at = None
    mark.resolved_by = None
    mark.resolved_in_resubmission = False
    mark.save(update_fields=["resolved_at", "resolved_by", "resolved_in_resubmission", "updated_at"])
    _audit(user, claim, "REVIEW_MARK_REOPEN", mark)
    return marks_service.for_staff(mark)


@api.delete("/marks/{mark_id}", auth=session_auth)
def delete_mark(request: HttpRequest, mark_id: str):
    """Take back a mark that has not gone to the claimant. One that has is resolved instead."""
    user = require_user(request)
    mark, claim = _mark_and_claim(mark_id)
    _require_marker(user, claim)
    if mark.sent_back_at:
        raise HttpError(400, "This mark has already gone to the claimant. Resolve it instead.")
    _audit(user, claim, "REVIEW_MARK_DELETE", mark)
    mark.delete()
    return {"ok": True}


__all__ = [
    "MarkIn", "MarkPatch", "RectIn",
    "create_mark", "delete_mark", "list_marks", "reopen_mark", "resolve_mark", "update_mark",
]
