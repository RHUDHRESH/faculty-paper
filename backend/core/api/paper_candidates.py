"""Papers that may be the signed-in person's, and whether their Scopus profile is theirs.

The cleanup of 2026-10-24 removed links the name matcher had made. Each one is a
pending `PaperCandidate` here, and the person answers it: confirm (the paper is
theirs, and the matcher keeps it) or reject (recorded as a dispute, so the
matcher does not link it again). Their Scopus profile gets the same treatment:
a yes or a no, shown in the directory. Every route works on the caller's own
rows only; somebody else's id is a 404.
"""

from __future__ import annotations

import json

from django.db import transaction
from django.db.models import F
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, require_user, session_auth
from core.api.faculty_directory import _scopus_link, _scopus_papers
from core.models import AuditLog, PaperCandidate, User
from core.services import publications as pubs
from core.services.person_record import papers_for

#: The most candidates listed at once; `pending` still counts them all.
LIST_LIMIT = 200
#: Author names shown per candidate paper.
AUTHORS_SHOWN = 4


def _mine(request: HttpRequest, candidate_id: str) -> tuple[User, PaperCandidate]:
    user = require_user(request)
    cand = get_object_or_404(
        PaperCandidate.objects.select_related("publication", "authorship"), id=candidate_id, user=user,
    )
    return user, cand


def _undecided(cand: PaperCandidate) -> None:
    if cand.status != PaperCandidate.Status.PENDING:
        raise HttpError(409, "This paper has already been confirmed or rejected.")


def _pending(user: User) -> int:
    return PaperCandidate.objects.filter(user=user, status=PaperCandidate.Status.PENDING).count()


def _candidate_dict(cand: PaperCandidate) -> dict:
    pub = cand.publication
    authors = sorted(pub.authorships.all(), key=lambda a: (a.position is None, a.position or 0))
    return {
        "id": cand.id,
        "reason": cand.reason,
        "source": cand.source,
        "publication": {
            "id": pub.id,
            "title": pub.title,
            "year": pub.year,
            "venue": pub.venue,
            "doi": pub.doi,
            "authors": [a.display_name for a in authors[:AUTHORS_SHOWN]],
            "author_count": len(authors),
        },
    }


@api.get("/me/paper-candidates", auth=session_auth)
def my_paper_candidates(request: HttpRequest):
    """Papers that may be mine and wait for my answer, newest year first."""
    user = require_user(request)
    waiting = PaperCandidate.objects.filter(user=user, status=PaperCandidate.Status.PENDING)
    rows = (
        waiting.select_related("publication")
        .prefetch_related("publication__authorships")
        .order_by(F("publication__year").desc(nulls_last=True), "publication__title", "id")[:LIST_LIMIT]
    )
    return {"pending": waiting.count(), "results": [_candidate_dict(c) for c in rows]}


@api.post("/me/paper-candidates/{candidate_id}/confirm", auth=session_auth)
def confirm_paper_candidate(request: HttpRequest, candidate_id: str):
    """The paper is mine: it goes on my record and the matcher keeps it there."""
    user, cand = _mine(request, candidate_id)
    _undecided(cand)
    with transaction.atomic():
        row, added = pubs.confirm_authorship(cand.publication, user, cand.authorship)
        cand.status = PaperCandidate.Status.CONFIRMED
        cand.decided_at = timezone.now()
        cand.save(update_fields=["status", "decided_at"])
        AuditLog.objects.create(
            actor=user, action="PAPER_CONFIRMED", entity="Publication", entity_id=cand.publication_id,
            detail_json=json.dumps({"candidate_id": cand.id, "authorship_id": row.id, "row_added": added}),
        )
    return {"ok": True, "pending": _pending(user), "papers_on_record": len(papers_for(user))}


@api.post("/me/paper-candidates/{candidate_id}/reject", auth=session_auth)
def reject_paper_candidate(request: HttpRequest, candidate_id: str):
    """Not mine. Recorded the way the record's own "not mine" is, so the matcher does not link it again."""
    user, cand = _mine(request, candidate_id)
    _undecided(cand)
    with transaction.atomic():
        AuditLog.objects.create(
            actor=user, action="PUBLICATION_DISPUTED", entity="Publication", entity_id=cand.publication_id,
            detail_json=json.dumps({"reason": "not_mine", "duplicate_of": None}),
        )
        cand.status = PaperCandidate.Status.REJECTED
        cand.decided_at = timezone.now()
        cand.save(update_fields=["status", "decided_at"])
    return {"ok": True, "pending": _pending(user)}


def _scopus_profile_body(user: User) -> dict:
    """The figures match the faculty directory's row for the same person."""
    linked = bool((user.scopus_author_id or "").strip())
    return {
        "scopus_author_id": user.scopus_author_id or None,
        "url": _scopus_link(user),
        "papers_in_scopus": _scopus_papers([user]).get(user.id, 0),
        "papers_on_record": len(papers_for(user)),
        "status": user.scopus_profile_status if linked else "no_id",
        "checked_at": user.scopus_profile_checked_at.isoformat() if user.scopus_profile_checked_at else None,
    }


@api.get("/me/scopus-profile", auth=session_auth)
def my_scopus_profile_answer(request: HttpRequest):
    """The Scopus profile on my account, my answer about it, and the figures the directory shows."""
    return _scopus_profile_body(require_user(request))


class ScopusAnswerIn(Schema):
    answer: str


@api.post("/me/scopus-profile", auth=session_auth)
def answer_my_scopus_profile(request: HttpRequest, payload: ScopusAnswerIn):
    """Yes: the profile is mine. No: it is not. Either way it is recorded with an audit row."""
    user = require_user(request)
    if payload.answer not in ("yes", "no"):
        raise HttpError(400, "Answer yes or no.")
    if not (user.scopus_author_id or "").strip():
        raise HttpError(400, "There is no Scopus author ID on your account to answer for.")
    yes = payload.answer == "yes"
    user.scopus_profile_status = "confirmed" if yes else "wrong"
    user.scopus_profile_checked_at = timezone.now()
    with transaction.atomic():
        user.save(update_fields=["scopus_profile_status", "scopus_profile_checked_at"])
        AuditLog.objects.create(
            actor=user, action="SCOPUS_PROFILE_CONFIRMED" if yes else "SCOPUS_PROFILE_DISPUTED",
            entity="User", entity_id=user.id,
            detail_json=json.dumps({"scopus_author_id": user.scopus_author_id, "answer": payload.answer}),
        )
    return _scopus_profile_body(user)


__all__ = [
    "my_paper_candidates",
    "confirm_paper_candidate",
    "reject_paper_candidate",
    "my_scopus_profile_answer",
    "answer_my_scopus_profile",
]
