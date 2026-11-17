"""Cut a long title the way a reader expects: at a word, with an ellipsis."""
from __future__ import annotations

from typing import Optional


def ellipsize(text: Optional[str], limit: int) -> str:
    """`text` as it is when it fits, else cut at the last whole word within `limit` characters and ended with "…".

    A title cut mid-word ("Design of a low-pow") reads as a typing error; one
    cut at a word and marked ("Design of a low-power…") reads as shortened.
    The result, ellipsis included, is never longer than `limit`.
    """
    s = " ".join((text or "").split())
    if len(s) <= limit:
        return s
    if limit <= 1:
        return "…"[:limit]
    cut = s[: limit - 1]
    if s[limit - 1] != " " and " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-–") + "…"
