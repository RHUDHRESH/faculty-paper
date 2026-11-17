"""Accept for count only: a reviewer decides a paper is counted and not paid."""

from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja import Schema

from core.api.common import api, require_user, session_auth
from core.api.deps import claim_to_dict
from core.services import count_only


class CountOnlyIn(Schema):
    reason: str
    note: Optional[str] = None


@api.post("/claims/{claim_id}/count-only", auth=session_auth)
def accept_for_count_only(request: HttpRequest, claim_id: str, payload: CountOnlyIn):
    """Count this paper for the college and pay no incentive. The claim keeps its place in the chain."""
    user = require_user(request)
    return claim_to_dict(count_only.accept(claim_id, user, payload.reason, payload.note))


@api.post("/claims/{claim_id}/count-only/undo", auth=session_auth)
def undo_count_only(request: HttpRequest, claim_id: str):
    """Super admin only, before any payment: restore the reason the claim had."""
    user = require_user(request)
    return claim_to_dict(count_only.undo(claim_id, user))


__all__ = ["CountOnlyIn", "accept_for_count_only", "undo_count_only"]
