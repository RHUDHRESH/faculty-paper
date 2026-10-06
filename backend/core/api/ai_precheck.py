"""The AI claim pre-check, as the review workspace asks for it.

Staff only, and not every staff seat: the research cell, the coordinator and
the super admin. The Principal, the Director and Finance are refused (the
Director and Finance never see flags or the watch-list, and the checklist is
built from them), and so is a claimant. Nobody runs it on their own claim.

Nothing here changes a claim. The answer is advice for a person who then
decides, and the endpoints that return it write only to the AI tables and the
audit log.
"""
from __future__ import annotations

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import Claim, ClaimStatus, User
from core.services import ai_precheck as service
from core.services import rbac

_ALLOWED = rbac.ADMIN_ROLES


class RunIn(Schema):
    force: bool = False


class FeedbackIn(Schema):
    target_id: str
    rating: int
    feature: str = service.FEATURE
    comment: str = ""


def _gate(request: HttpRequest, claim_id: str) -> tuple[User, Claim]:
    user = require_user(request)
    if user.role not in _ALLOWED:
        raise HttpError(403, "The AI check is for the research cell.")
    claim = Claim.objects.select_related("owner").filter(pk=claim_id).first()
    if claim is None:
        raise HttpError(404, "Claim not found.")
    if rbac.is_own_claim(user, claim):
        raise HttpError(403, "You cannot run an AI check on your own claim.")
    if claim.status == ClaimStatus.DRAFT:
        raise HttpError(409, "This claim has not been filed yet.")
    return user, claim


def _refuse(exc: service.PrecheckError) -> HttpError:
    return HttpError(exc.status, exc.message)


@api.get("/claims/{claim_id}/ai-precheck", auth=session_auth)
def ai_precheck_status(request: HttpRequest, claim_id: str):
    """Whether the AI check is on, and the stored answer for the claim as it is now.

    Never calls a model: opening a claim must be free. The screen decides
    whether to ask for a fresh run.
    """
    user, claim = _gate(request, claim_id)
    return service.status(claim, user)


@api.post("/claims/{claim_id}/ai-precheck", auth=session_auth)
def ai_precheck_run(request: HttpRequest, claim_id: str, payload: RunIn):
    user, claim = _gate(request, claim_id)
    try:
        return service.run(claim, user, force=payload.force)
    except service.PrecheckError as exc:
        raise _refuse(exc) from exc


@api.post("/claims/{claim_id}/ai-precheck/send-back-draft", auth=session_auth)
def ai_precheck_draft(request: HttpRequest, claim_id: str):
    """A drafted send-back reason from the failed items. Text only: it is not saved or sent."""
    user, claim = _gate(request, claim_id)
    try:
        return service.draft_reason(claim, user)
    except service.PrecheckError as exc:
        raise _refuse(exc) from exc


@api.post("/claims/{claim_id}/ai-precheck/feedback", auth=session_auth)
def ai_precheck_feedback(request: HttpRequest, claim_id: str, payload: FeedbackIn):
    user, claim = _gate(request, claim_id)
    try:
        service.feedback(
            claim, user, target_id=payload.target_id, rating=payload.rating,
            comment=payload.comment, feature=payload.feature,
        )
    except service.PrecheckError as exc:
        raise _refuse(exc) from exc
    return {"ok": True}


__all__ = ["ai_precheck_draft", "ai_precheck_feedback", "ai_precheck_run", "ai_precheck_status"]
