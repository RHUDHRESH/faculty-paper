"""Which claims a signed-in person may see: one rule, used wherever claims are listed.

The claims list, the search box, the admin process queue, a claim's notes and
a claim's attachments all answer the same question -- "may this person see
this claim?" -- and used to answer it separately, so a fix to one left the
others open. They share this instead.

- A draft is unsubmitted, half-typed work that its author has not shown to
  anyone, so nobody else sees it: not an admin, not the Principal.
- The roles that oversee the scheme (`rbac.can_view_college_wide`) see every
  claim that has been filed, and their own drafts.
- Everybody else -- a faculty member, a head of department -- sees their own
  claims. A head's view of their department's filed papers is a separate
  screen (`/hod/*`), which carries no money.
"""
from __future__ import annotations

from django.db.models import Q, QuerySet

from core.models import ClaimStatus
from core.services import rbac


def hide_others_drafts(claims: QuerySet, user) -> QuerySet:
    """`claims` without any draft that is not `user`'s own."""
    return claims.filter(~Q(status=ClaimStatus.DRAFT) | Q(owner=user))


def visible_to(user, claims: QuerySet) -> QuerySet:
    """`claims` narrowed to the ones `user` may see."""
    if rbac.can_view_college_wide(user.role):
        return hide_others_drafts(claims, user)
    return claims.filter(owner=user)
