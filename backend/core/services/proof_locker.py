"""The proof locker: a person's evidence files, uploaded once, checked once,
reused on any claim.

Claims stall at the research office for things a machine can see first: the
college's name is not on the paper, the claimant is not on the author list,
the title is a different paper's. `check` reads the file with the same text
extraction and affiliation rule the claim file check uses
(`content_check`) and says so before anything is filed. Nothing here blocks
a claim: the office decides.
"""
from __future__ import annotations

import json
import re
import uuid

from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.utils import timezone

from core.models import AttachmentKind, AuthorAlias, ClaimAttachment, ProofFile, Publication, User
from core.services import content_check
from core.services.author_names import name_parts
from core.services.normalize import normalize_doi, title_tokens
from core.services.pdfmeta import content_digest, guess_title
from core.services.uploads import ACCEPTED_LABEL, sniff

MAX_BYTES = 10 * 1024 * 1024
#: The author block sits on the first page, under the title.
AUTHOR_BLOCK_CHARS = 4000
_DOI = re.compile(r"\b10\.\d{4,9}/[^\s\"<>]+", re.I)

OK, WARN, BAD, UNKNOWN = "ok", "warn", "bad", "unknown"


class ProofError(ValueError):
    pass


def _check(key: str, status: str, title: str, detail: str) -> dict:
    return {"key": key, "status": status, "title": title, "detail": detail}


# ---- adding ------------------------------------------------------------------


def add(user: User, file, kind: str = ProofFile.Kind.ARTICLE, publication_id: str | None = None,
        *, run_checks: bool = True) -> tuple[ProofFile, bool]:
    """(proof, created). The same bytes already in the locker return that file."""
    content = file.read()
    if not content:
        raise ProofError("That file is empty")
    if len(content) > MAX_BYTES:
        raise ProofError("File too large (max 10MB)")
    sniffed = sniff(content)
    if sniffed is None:
        raise ProofError(
            f"That file is not a {ACCEPTED_LABEL}. "
            "Renaming a file does not change its type — export or scan it instead."
        )
    if kind not in ProofFile.Kind.values:
        raise ProofError("Unknown kind")
    digest = content_digest(content)
    existing = ProofFile.objects.filter(owner=user, content_hash=digest).first()
    if existing:
        return existing, False
    pub = Publication.objects.filter(id=publication_id).first() if publication_id else None
    path = f"claims/{uuid.uuid4().hex}.{sniffed.extension}"
    path = default_storage.save(path, ContentFile(content))
    proof = ProofFile.objects.create(
        owner=user,
        kind=kind,
        filename=(getattr(file, "name", None) or f"document.{sniffed.extension}")[:255],
        storage_path=path,
        content_hash=digest,
        size=len(content),
        publication=pub,
    )
    if run_checks:
        check(proof, data=content)
    return proof, True


def add_existing(user: User, *, storage_path: str, filename: str, kind: str) -> ProofFile | None:
    """Save a file already uploaded for a claim to the locker too."""
    try:
        with default_storage.open(storage_path, "rb") as fh:
            data = fh.read()
    except Exception:  # noqa: BLE001 - any storage backend's "missing"
        return None
    digest = content_digest(data)
    existing = ProofFile.objects.filter(owner=user, content_hash=digest).first()
    if existing:
        return existing
    proof = ProofFile.objects.create(
        owner=user, kind=kind, filename=(filename or "document")[:255], storage_path=storage_path,
        content_hash=digest, size=len(data),
    )
    check(proof, data=data)
    return proof


# ---- checking ----------------------------------------------------------------


def _name_variants(user: User) -> list[str]:
    names = [user.name or ""]
    names += list(
        AuthorAlias.objects.filter(user=user, status=AuthorAlias.MATCHED).values_list("sample_name", flat=True)
    )
    return [n for n in names if n.strip()]


def author_check(text: str, variants: list[str]) -> dict:
    block = content_check._words(text[:AUTHOR_BLOCK_CHARS])
    whole = content_check._words(text)
    best_share = 0.0
    for v in variants:
        full, _ = name_parts(v)
        full = tuple(t for t in full if len(t) >= 3)
        if not full:
            continue
        if all(f" {t} " in block for t in full):
            return _check("author", OK, "You are on the author list", f"Found “{v}” near the top of the paper.")
        share = sum(1 for t in full if f" {t} " in whole) / len(full)
        best_share = max(best_share, share)
    if best_share > 0:
        detail = "Only part of your name was found. Check the author list shows you as the office knows you."
    else:
        detail = "Your name was not found on this PDF. Claims are sent back when the claimant is not an author."
    return _check("author", WARN, "Your name was not found in the author list", detail)


def _first_doi(text: str) -> str:
    squashed = re.sub(r"\s+", "", text)
    m = _DOI.search(text) or _DOI.search(squashed)
    return normalize_doi(m.group(0).rstrip(".,;)]")) or "" if m else ""


def run_checks(proof: ProofFile, data: bytes) -> tuple[list[dict], str, str]:
    """(checks, doi_found, title_found). Pure apart from reading the database
    for name variants and the person's other files."""
    checks: list[dict] = []
    is_pdf = data[:5] == b"%PDF-"
    scanned = _check("readable", UNKNOWN, "Scanned file, no text to check",
                     "This looks like a scan. The office will read it by eye.")
    if not is_pdf:
        return [scanned], "", ""
    try:
        text, _pages = content_check.extract_text(data)
    except ValueError:
        return [_check("readable", UNKNOWN, "The PDF could not be opened for checking",
                       "The office will open it by eye. Try saving it again from the publisher's site.")], "", ""
    if len(re.sub(r"\s+", "", text)) < content_check.MIN_TEXT_CHARS:
        return [scanned], "", ""
    checks.append(_check("readable", OK, "The text can be read", "The checks below read the PDF's own text."))

    words = content_check._words(text)
    college = content_check._college_name()
    aff = content_check.affiliation_words(college)
    if any(f" {w} " in words for w in aff):
        checks.append(_check("affiliation", OK, "The college's name is on this PDF", f"Found “{college}”."))
    else:
        detail = (
            "The college's name is not on this PDF. Claims without it are sent back. "
            "Check you uploaded the published version."
        )
        if proof.kind == ProofFile.Kind.REFERENCE:
            detail = "The college's name is not on this reference. The policy needs references with an SEC author."
        checks.append(_check("affiliation", BAD, "The college's name was not found", detail))

    doi = _first_doi(text)
    title_found = (guess_title(data) or "")[:500]
    pub = proof.publication

    if proof.kind == ProofFile.Kind.REFERENCE:
        same = ClaimAttachment.objects.filter(
            claim__owner_id=proof.owner_id, kind=AttachmentKind.PUBLISHED_PAPER, content_hash=proof.content_hash
        ).exists() or ProofFile.objects.filter(
            owner_id=proof.owner_id, kind=ProofFile.Kind.ARTICLE, content_hash=proof.content_hash
        ).exclude(id=proof.id).exists()
        if not same and pub and pub.title:
            tokens = title_tokens(pub.title)
            same = bool(tokens) and content_check._share_found(tokens, content_check._words(text[:3000])) >= 0.9
        if same:
            checks.append(_check("not_article", BAD, "This looks like your article, not a reference",
                                 "A reference must be a different paper by an SEC author."))
        else:
            checks.append(_check("not_article", OK, "A different paper from your article", ""))
        return checks, doi, title_found

    if proof.kind == ProofFile.Kind.ARTICLE:
        checks.append(author_check(text, _name_variants(proof.owner)))

    if pub and pub.title:
        tokens = title_tokens(pub.title)
        share = content_check._share_found(tokens, words) if tokens else 0.0
        pct = round(share * 100)
        if share >= content_check.TITLE_SHARE:
            checks.append(_check("title", OK, "The title matches the paper", f"{pct}% of the title's words found."))
        elif share >= 0.5:
            checks.append(_check("title", WARN, "The title only partly matches",
                                 f"{pct}% of the title's words found. Check this is the right paper."))
        else:
            checks.append(_check("title", BAD, "The title does not match the paper",
                                 f"Only {pct}% of “{pub.title[:120]}” was found. This may be a different paper."))
    elif proof.kind == ProofFile.Kind.ARTICLE:
        checks.append(_check("title", UNKNOWN, "No paper linked", "Link a paper to check the title and DOI."))

    want = normalize_doi(pub.doi) if pub and pub.doi else None
    if want:
        squashed = content_check._squashed(text)
        if any(want in s for s in squashed):
            checks.append(_check("doi", OK, "The DOI matches", want))
        elif doi:
            checks.append(_check("doi", BAD, "The DOI is a different one",
                                 f"This PDF shows {doi}, the paper is {want}."))
        else:
            checks.append(_check("doi", WARN, "No DOI found on this PDF", f"Expected {want}."))
    elif proof.kind == ProofFile.Kind.ARTICLE:
        if doi:
            checks.append(_check("doi", OK, "A DOI was found", doi))
        else:
            checks.append(_check("doi", WARN, "No DOI found on this PDF",
                                 "The published version usually prints one. Check this is not a preprint."))
    return checks, doi, title_found


def check(proof: ProofFile, data: bytes | None = None) -> ProofFile:
    if data is None:
        try:
            with default_storage.open(proof.storage_path, "rb") as fh:
                data = fh.read()
        except Exception:  # noqa: BLE001
            data = b""
    if not data:
        checks = [_check("readable", UNKNOWN, "The file could not be fetched", "Try uploading it again.")]
        doi, title = "", ""
    else:
        checks, doi, title = run_checks(proof, data)
    proof.checks_json = json.dumps(checks)
    proof.doi_found = doi[:255]
    proof.title_found = title
    proof.checked_at = timezone.now()
    proof.save(update_fields=["checks_json", "doi_found", "title_found", "checked_at"])
    return proof


def checks_of(proof: ProofFile) -> list[dict]:
    try:
        return json.loads(proof.checks_json or "[]")
    except ValueError:
        return []


def url_of(proof: ProofFile) -> str:
    from django.conf import settings

    return f"{settings.MEDIA_URL}{proof.storage_path}"


def checks_by_url(claim) -> dict[str, list[dict]]:
    """Locker checks for each of the claim's files, keyed on the file URL."""
    hashes = {a.content_hash: a.url for a in claim.attachments.all() if a.content_hash}
    if not hashes:
        return {}
    out: dict[str, list[dict]] = {}
    for p in ProofFile.objects.filter(owner_id=claim.owner_id, content_hash__in=list(hashes)):
        out[hashes[p.content_hash]] = checks_of(p)
    return out
