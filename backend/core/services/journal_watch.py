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
    rows = _entries()
    if not rows:
        return None
    issn_n = normalize_issn(issn) if issn else None
    title_k = _key_title(title)
    for w_issn, w_title, entry in rows:
        if w_issn and issn_n and w_issn == issn_n:
            return dict(entry)
        if not w_issn and title_k and w_title == title_k:
            return dict(entry)
    return None


def _entries() -> list[tuple]:
    """The watch-list, prepared once per data generation.

    A claim list calls `watch_for` once per claim; reading the table each time
    was one query per row (95 on a 100-row reports search).
    """
    from core.services.aggregate_cache import cached

    def build() -> list[tuple]:
        return [
            (normalize_issn(w.issn) if w.issn else None, _key_title(w.title), watch_dict(w))
            for w in JournalWatch.objects.select_related("added_by")[:500]
        ]

    return cached("journal_watch.entries", {}, build)


def watch_dict(w: JournalWatch) -> dict:
    return {
        "id": w.id,
        "issn": w.issn,
        "title": w.title,
        "reason": w.reason,
        "added_by_name": w.added_by.name if w.added_by_id else None,
        "created_at": w.created_at.isoformat() if w.created_at else None,
    }
