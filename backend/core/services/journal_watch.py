"""The research cell's own journal watch-list, matched against a claim."""

from __future__ import annotations

from core.models import JournalWatch
from core.services.normalize import normalize_issn


def _key_title(t: str | None) -> str:
    return " ".join((t or "").lower().split())


def watch_for(issn: str | None, title: str | None) -> dict | None:
    """The watch-list entry a journal falls under, or None.

    ISSN decides when both sides have one; a title only matches an entry that
    was added without an ISSN, so a cloned title never borrows a real ISSN's
    entry and the other way round.
    """
    rows = list(JournalWatch.objects.all()[:500])
    if not rows:
        return None
    issn_n = normalize_issn(issn) if issn else None
    title_k = _key_title(title)
    for w in rows:
        w_issn = normalize_issn(w.issn) if w.issn else None
        if w_issn and issn_n and w_issn == issn_n:
            return watch_dict(w)
        if not w_issn and title_k and _key_title(w.title) == title_k:
            return watch_dict(w)
    return None


def watch_dict(w: JournalWatch) -> dict:
    return {
        "id": w.id,
        "issn": w.issn,
        "title": w.title,
        "reason": w.reason,
        "added_by_name": w.added_by.name if w.added_by_id else None,
        "created_at": w.created_at.isoformat() if w.created_at else None,
    }
