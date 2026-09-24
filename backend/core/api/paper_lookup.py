"""paper lookup: the filing form's one box, and a look inside an attached file.

`/lookup/paper` answers "paste the DOI or link" from OpenAlex, Crossref and --
only with a key -- Scopus, then fills the journal's standing from our own
tables (core.services.paper_lookup). It never raises: an upstream outage, a
link with no DOI in it and an honest bug all come back as a sentence the form
can show, because the claimant can always carry on by hand.

`/lookup/file-check` reads a file the claimant has just attached and says
whether it looks like the paper they described -- before filing, while a
wrong file can still be swapped. It is the claimant checking their own
upload, like `duplicate_of` on the upload itself; the checks the desks rely on
after filing (`AttachmentCheck`, and the flags they raise) are a different
thing and stay the desks' own.

Both paths are under /lookup/: `/claims/{claim_id}` is registered earlier and
would answer a later `/claims/file-check` with a 405.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from django.core.files.storage import default_storage
from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, logger, require_user, session_auth
from core.models import AttachmentKind, ClaimAttachment, User
from core.services import content_check, institution, paper_lookup, rbac


class PaperLookupIn(Schema):
    #: Whatever was pasted: a DOI, a link, a Scopus link or a title.
    query: str = ""
    #: Filing for somebody else: match *their* name against the authors.
    #: Honoured only for the office roles that may file on someone's behalf.
    owner_id: Optional[str] = None
    #: The draft being edited, so it is not reported as already filed.
    claim_id: Optional[str] = None


class FileCheckIn(Schema):
    url: str
    kind: str = AttachmentKind.PUBLISHED_PAPER
    title: Optional[str] = None
    doi: Optional[str] = None
    journal: Optional[str] = None
    issn: Optional[str] = None
    ref_title: Optional[str] = None
    owner_id: Optional[str] = None


def _claimant(user: User, owner_id: str | None) -> User:
    """Whose name the paper is checked against: yours, unless the office is filing for someone."""
    if owner_id and rbac.can_clear_claims(user.role):
        return User.objects.filter(pk=owner_id).first() or user
    return user


@api.post("/lookup/paper", auth=session_auth)
def lookup_paper(request: HttpRequest, payload: PaperLookupIn):
    user = require_user(request)
    claimant = _claimant(user, payload.owner_id)
    try:
        return paper_lookup.lookup(
            payload.query,
            claimant=claimant,
            college_name=institution.get("college_name"),
            exclude_claim_id=payload.claim_id,
        )
    except Exception:  # noqa: BLE001 -- the form must get a sentence, never a 500
        logger.exception("paper_lookup_failed")
        return paper_lookup.error_answer()


_OWN_MEDIA = re.compile(r"^/media/claims/[0-9a-f]{32}\.[a-z0-9]{2,5}$")

_LABELS = {
    "title": "the title",
    "doi": "the DOI",
    "journal": "the journal",
    "claimant": "your name",
    "affiliation": "the college",
    "reference_title": "the reference's title",
}


def _list(keys: list[str], *, for_self: bool) -> str:
    words = [
        ("their name" if k == "claimant" and not for_self else _LABELS.get(k, k)) for k in keys
    ]
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


def _read(outcome: str, summary: str, **extra: Any) -> dict[str, Any]:
    return {"outcome": outcome, "summary": summary, "found": [], "missing": [], "pages": 0, **extra}


@api.post("/lookup/file-check", auth=session_auth)
def check_attached_file(request: HttpRequest, payload: FileCheckIn):
    user = require_user(request)
    url = (payload.url or "").strip()
    if not _OWN_MEDIA.match(url):
        raise HttpError(400, "That is not a file uploaded to this form.")
    # A file already on somebody else's claim is theirs; its contents are not
    # yours to probe. A fresh upload belongs to no claim yet.
    if not rbac.can_clear_claims(user.role) and (
        ClaimAttachment.objects.filter(url=url).exclude(claim__owner=user).exists()
    ):
        raise HttpError(403, "That file is on another claim.")

    name = content_check.storage_name(url)
    if not name:
        return _read("NOT_READ", "Only PDFs are read here. The research cell compares images and "
                     "Word files by eye, so this one is fine as it is.")
    try:
        with default_storage.open(name, "rb") as handle:
            data = handle.read()
        text, pages = content_check.extract_text(data)
    except Exception:  # noqa: BLE001 -- storage backends and pypdf each raise their own
        logger.warning("file_check_unreadable url=%s", url, exc_info=True)
        return _read("UNREADABLE", "This file could not be opened as a PDF. Save it again, or attach "
                     "a different copy.")

    if len(re.sub(r"\s+", "", text)) < content_check.MIN_TEXT_CHARS:
        return _read("NO_TEXT", "This file has no text to read — it looks like a scan. That is fine: "
                     "the research cell compares it by eye.", pages=pages)

    claimant = _claimant(user, payload.owner_id)
    for_self = claimant.pk == user.pk
    college = institution.get("college_name")
    if payload.kind == AttachmentKind.PUBLISHED_PAPER:
        result = content_check.compare_published_paper(
            text,
            title=payload.title,
            doi=payload.doi,
            journal=payload.journal,
            issn=payload.issn,
            claimant=claimant.name,
            college_name=college,
        )
        failed = [k for k in ("title", "doi") if k in result.missing]
    else:
        result = content_check.compare_reference(text, ref_title=payload.ref_title, college_name=college)
        failed = list(result.missing)

    if failed:
        summary = (
            f"This file does not show {_list(failed, for_self=for_self)} of the paper on this form. "
            "Check it is the published version of this paper, not a draft or a different article."
            if payload.kind == AttachmentKind.PUBLISHED_PAPER
            else f"This file does not show {_list(failed, for_self=for_self)}. A cited reference is "
            f"here to show an author from {college} — check it is the right paper."
        )
        outcome = "MISMATCH"
    else:
        summary = (
            f"This file shows {_list(result.found, for_self=for_self)}."
            if result.found else "Nothing on this form to compare the file with yet."
        )
        if payload.kind == AttachmentKind.PUBLISHED_PAPER and "affiliation" in result.missing:
            summary += f" It does not name {college}, though — check the affiliation printed on it."
        outcome = "MATCHED"
    return _read(outcome, summary, found=result.found, missing=result.missing, pages=pages)


__all__ = [
    "FileCheckIn",
    "PaperLookupIn",
    "check_attached_file",
    "lookup_paper",
]
