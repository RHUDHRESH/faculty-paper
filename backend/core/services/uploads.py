"""What a claim is allowed to carry as evidence, and how to recognise it.

Extension and browser-supplied MIME type are both caller-controlled, so neither
is evidence of anything. Every upload is identified by its leading bytes, and
the stored extension is derived from that — a .txt renamed to .pdf is refused
rather than saved as a document nobody can open.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FileKind:
    extension: str
    content_type: str
    label: str
    #: Safe to render in the browser tab. Office files download instead — they
    #: are not renderable and serving them inline invites content sniffing.
    inline: bool


PDF = FileKind("pdf", "application/pdf", "PDF", True)
PNG = FileKind("png", "image/png", "PNG image", True)
JPEG = FileKind("jpg", "image/jpeg", "JPEG image", True)
WEBP = FileKind("webp", "image/webp", "WebP image", True)
GIF = FileKind("gif", "image/gif", "GIF image", True)
TIFF = FileKind("tiff", "image/tiff", "TIFF image", False)
DOCX = FileKind(
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Word document",
    False,
)
DOC = FileKind("doc", "application/msword", "Word document", False)

#: Longest signature first so a prefix never shadows a longer match.
_SIGNATURES: list[tuple[bytes, FileKind]] = [
    (b"\x89PNG\r\n\x1a\n", PNG),
    (b"%PDF", PDF),
    (b"\xff\xd8\xff", JPEG),
    (b"GIF87a", GIF),
    (b"GIF89a", GIF),
    (b"II*\x00", TIFF),
    (b"MM\x00*", TIFF),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", DOC),  # OLE2 — legacy .doc/.xls
]

#: Extension → kind, for serving a file we stored earlier.
BY_EXTENSION: dict[str, FileKind] = {
    k.extension: k for k in (PDF, PNG, JPEG, WEBP, GIF, TIFF, DOCX, DOC)
}

ACCEPTED_LABEL = "PDF, PNG, JPEG, WebP, GIF, TIFF, or Word document"


def sniff(content: bytes) -> FileKind | None:
    """Identify an upload from its own bytes, or None if we don't accept it."""
    for signature, kind in _SIGNATURES:
        if content.startswith(signature):
            return kind
    # RIFF....WEBP — the size field sits between the two markers.
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return WEBP
    # OOXML is a zip; the part name distinguishes Word from the rest. Checking a
    # generous prefix avoids unpacking the archive just to classify it.
    if content[:4] == b"PK\x03\x04":
        head = content[:4096]
        if b"word/" in head:
            return DOCX
        return None
    return None


def kind_for_stored_name(filename: str) -> FileKind | None:
    _, _, ext = filename.rpartition(".")
    return BY_EXTENSION.get(ext.lower())
