"""One request for the review workspace.

The full-page review workspace (`/review/:claimId`) used to be a side sheet
that fetched the claim, then its flags, then asked again for its history. On a
slow college connection that is three round trips before a reviewer sees a
word, and a page that fills in piece by piece while they are already reading.
This answers all of it at once: the claim exactly as `GET /claims/{id}` sends
it (history and the three confirmations included), the flags and file checks
for the desks that may see them, and two plain facts the screen needs to
decide what to offer.

The rules of the desks are unchanged and enforced here rather than trusted to
the screen:

- only the desks that judge a paper, or authorise it, open the workspace;
- flags and file checks go only to `rbac.can_review_flags` roles, so the
  Director never receives them;
- a reviewer's own claim opens (they can read what they filed) but with no
  flags, because the server refuses to show a person the doubts about their
  own paper, and `own` is true so the decision bar stays away.
"""
from __future__ import annotations

from django.http import HttpRequest
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.api.flags import file_check_to_dict, flag_to_dict
from core.api.journals import get_claim
from core.models import Claim, Role
from core.services import rbac

#: Who may open the workspace: the office, the Principal (approves) and the
#: Director (authorises). Finance pays from its own list; faculty use their
#: own paper page.
_WORKSPACE_ROLES = (*rbac.ADMIN_ROLES, Role.PRINCIPAL, Role.DIRECTOR)


@api.get("/claims/{claim_id}/workspace", auth=session_auth)
def claim_workspace(request: HttpRequest, claim_id: str):
    """The claim, its review data and what this account may do with it."""
    user = require_user(request)
    if user.role not in _WORKSPACE_ROLES:
        raise HttpError(403, "The review workspace is for the desks that check and approve claims.")

    claim_data = get_claim(request, claim_id)
    claim = Claim.objects.select_related("owner").get(pk=claim_id)
    own = rbac.is_own_claim(user, claim)

    review = None
    if rbac.can_review_flags(user.role) and not own:
        review = {
            "flags": [
                flag_to_dict(f)
                for f in claim.flags.select_related("raised_by", "resolved_by").order_by("-raised_at")
            ],
            "file_checks": [file_check_to_dict(c) for c in claim.file_checks.all()],
        }

    return {
        "claim": claim_data,
        "review": review,
        "own": own,
        "role": user.role,
    }


__all__ = ["claim_workspace"]
