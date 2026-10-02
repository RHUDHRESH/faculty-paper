"""Old-ERP claims imported as paid that were never priced or paid.

Super admin only. The rule, the status they go to and why, and what an undo
restores are in `core.services.erp_remark`.

GET  /admin/erp-remark/preview  what would change now, what is held for the
                                research cell, and the signature to apply it
POST /admin/erp-remark/apply    {signature, confirm, include_only?, exclude_claim_nos?}
POST /admin/erp-remark/undo     {batch_id}
GET  /admin/erp-remark/batches  past applies, and whether each was undone
"""
from __future__ import annotations

from typing import Optional

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.models import Role
from core.services import erp_remark


def _super_admin(request: HttpRequest):
    # require_user refuses every write while viewing as somebody.
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can re-mark old ERP claims.")
    return user


class ErpRemarkApplyIn(Schema):
    #: The `signature` the preview returned: proof the list being applied is
    #: the one that was looked at.
    signature: str
    confirm: bool = False
    #: Change only these claim numbers (each must be on the preview's list).
    include_only: Optional[list[str]] = None
    #: Leave these claim numbers out of the batch.
    exclude_claim_nos: Optional[list[str]] = None


class ErpRemarkUndoIn(Schema):
    batch_id: str


@api.get("/admin/erp-remark/preview", auth=session_auth)
def erp_remark_preview(request: HttpRequest):
    _super_admin(request)
    return erp_remark.preview()


@api.post("/admin/erp-remark/apply", auth=session_auth)
def erp_remark_apply(request: HttpRequest, payload: ErpRemarkApplyIn):
    user = _super_admin(request)
    try:
        return erp_remark.apply(
            user,
            seen_signature=payload.signature,
            confirm=payload.confirm,
            include_only=payload.include_only,
            exclude_claim_nos=payload.exclude_claim_nos,
        )
    except erp_remark.RemarkError as exc:
        raise HttpError(exc.status, str(exc))


@api.post("/admin/erp-remark/undo", auth=session_auth)
def erp_remark_undo(request: HttpRequest, payload: ErpRemarkUndoIn):
    user = _super_admin(request)
    try:
        return erp_remark.undo(user, payload.batch_id)
    except erp_remark.RemarkError as exc:
        raise HttpError(exc.status, str(exc))


@api.get("/admin/erp-remark/batches", auth=session_auth)
def erp_remark_batches(request: HttpRequest):
    _super_admin(request)
    return {"batches": erp_remark.batches()}


__all__ = ["erp_remark_preview", "erp_remark_apply", "erp_remark_undo", "erp_remark_batches"]
