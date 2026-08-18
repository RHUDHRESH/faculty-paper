"""Read what a PDF says about itself, without a PDF library.

Two jobs, both first-line-of-defence rather than authoritative:

  content_digest  the file's own fingerprint, so the same document uploaded
                  twice is recognised however it was renamed
  guess_title     the article title, offered to the claimant to save retyping

A PDF's object streams are usually Flate-compressed, which the standard library
can inflate; that is enough for the document-information dictionary and for the
text of the first page in most publisher PDFs. Anything it cannot read returns
None and the claimant types the title, which is what they do today anyway.
"""
from __future__ import annotations

import hashlib
import re
import zlib

#: Titles below this are page furniture ("Abstract"), above it are paragraphs.
MIN_TITLE = 12
MAX_TITLE = 300

#: Lines that are never the title, however prominently they are set.
_FURNITURE = re.compile(
    r"^(abstract|introduction|keywords?|contents|received|accepted|available online|"
    r"doi[: ]|https?://|www\.|issn|isbn|vol(ume)?[. ]|page \d+|\d+\s*$|"
    r"downloaded from|licensed under|copyright|©|all rights reserved|"
    r"journal of|proceedings of|ieee|springer|elsevier)",
    re.I,
)


def content_digest(data: bytes) -> str:
    """A stable fingerprint of the bytes themselves."""
    return hashlib.sha256(data).hexdigest()


def _info_title(data: bytes) -> str | None:
    """The title from the document-information dictionary, when it has one.

    Publishers often leave the typesetting job name in here ("output.pdf",
    "untitled"), so the value is only trusted when it looks like a sentence.
    """
    for pattern in (rb"/Title\s*\(([^)]{4,400})\)", rb"/Title\s*<([0-9A-Fa-f]{8,800})>"):
        m = re.search(pattern, data)
        if not m:
            continue
        raw = m.group(1)
        try:
            if pattern.endswith(b">"):
                text = bytes.fromhex(raw.decode("ascii")).decode("utf-16-be", "ignore")
            else:
                text = raw.decode("latin-1", "ignore")
        except (ValueError, UnicodeDecodeError):
            continue
        text = re.sub(r"\s+", " ", text).strip()
        if _plausible(text):
            return text
    return None


def _plausible(text: str) -> bool:
    if not (MIN_TITLE <= len(text) <= MAX_TITLE):
        return False
    if _FURNITURE.match(text):
        return False
    # A title is words, not a filename or a path.
    if re.search(r"\.(pdf|docx?|tex|indd)$", text, re.I):
        return False
    if text.count(" ") < 2:
        return False
    letters = sum(c.isalpha() for c in text)
    return letters >= len(text) * 0.6


def _first_page_lines(data: bytes) -> list[str]:
    """Text from the earliest streams we can inflate, in order."""
    lines: list[str] = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", data, re.S):
        if len(lines) > 60:
            break
        chunk = m.group(1)
        try:
            text = zlib.decompress(chunk).decode("latin-1", "ignore")
        except zlib.error:
            continue
        # PDF text-showing operators: (text) Tj  and  [(a) -2 (b)] TJ
        parts = re.findall(r"\((?:\\.|[^\\()])*\)", text)
        current: list[str] = []
        for part in parts:
            piece = part[1:-1]
            piece = re.sub(r"\\([()\\])", r"\1", piece)
            current.append(piece)
        joined = re.sub(r"\s+", " ", "".join(current)).strip()
        if joined:
            lines.extend(s.strip() for s in re.split(r"(?<=[.?!])\s{2,}", joined))
    return [ln for ln in lines if ln]


def guess_title(data: bytes) -> str | None:
    """The article's title, or None when the file will not give it up.

    Offered as a suggestion the claimant confirms — never written straight onto
    the claim. A wrong title picked up silently is worse than an empty box.
    """
    if not data.startswith(b"%PDF"):
        return None

    from_info = _info_title(data)
    if from_info:
        return from_info

    for line in _first_page_lines(data)[:25]:
        candidate = line.strip(" .,-—–")
        if _plausible(candidate):
            return candidate[:MAX_TITLE]
    return None
