"""The applicant's side: when the next payment run is, and a look at a claim's
files before it is sent.

Both are the claimant's own and say nothing about which desk holds a claim.
"""
from __future__ import annotations

from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.api.teams import _min_sec_references
from core.models import Claim, ClaimStatus
from core.services import applicant


@api.get("/me/next-payout", auth=session_auth)
def next_payout(request: HttpRequest):
    """The college's payout pattern and the month the next run is expected."""
    require_user(request)
    return applicant.payout_outlook()


@api.post("/claims/{claim_id}/precheck", auth=session_auth)
def precheck_claim(request: HttpRequest, claim_id: str):
    """What the reviewer will look for in this claim's files, before it is sent.

    Only for the claimant's own draft or sent-back claim. Warnings only: it
    reads the files, writes nothing, and never ticks a filing condition.
    """
    user = require_user(request)
    claim = get_object_or_404(
        Claim.objects.select_related("owner").prefetch_related("attachments"),
        pk=claim_id,
        owner=user,
    )
    if claim.status not in (ClaimStatus.DRAFT, ClaimStatus.REJECTED):
        raise HttpError(400, "This claim is already with the college, so there is nothing to check before sending.")
    return applicant.precheck(claim, _min_sec_references())


__all__ = ["next_payout", "precheck_claim"]
