"""Read what a claim's PDFs actually say, and compare it with the claim.

A published paper is the evidence a claim is paid on, and until now nothing
read it: an approver opened it or did not, and a ticket could be cleared on
the strength of a filename. This extracts the text of every PDF attached to a
claim and looks for the facts the claim asserts:

  title        most of the claim's title words
  doi          the DOI, however the PDF broke it across lines
  journal      most of the journal's title words, or its ISSN
  claimant     the claimant's name
  affiliation  the college (the distinctive part of its configured name)

A cited reference is a different paper by design, so it is looked for its own
title (when the claimant gave one) and for the affiliation, which is the one
thing it is attached to prove.

The result is stored per file (`AttachmentCheck`) and shown beside the file to
the reviewers. When a *published paper* is missing its own title or DOI, or
has no text at all -- a scan -- a CONTENT_MISMATCH flag is raised
automatically. That flag never blocks the claim; it is a question for a
person to answer with the file open.

Heuristics, not verdicts: a two-column layout can scramble a title and a
publisher can print a DOI as an image. That is why the outcome is a flag for
a reviewer and never a refusal.
"""
from __future__ import annotations

import io
import json
import logging
import math
import re
import unicodedata
from dataclasses import dataclass, field

from django.conf import settings
from django.core.files.storage import default_storage
from django.utils import timezone

from core.models import AttachmentCheck, AttachmentKind, Claim, ClaimFlag, ClaimStatus
from core.services import flags as flag_service
from core.services.normalize import normalize_doi, normalize_issn, title_tokens
from core.services.pdfmeta import content_digest

logger = logging.getLogger(__name__)

# pypdf reports every malformed-but-readable publisher PDF at WARNING. Those
# files are read perfectly well, and one line per quirk in every worker log
# would bury the failures that matter.
logging.getLogger("pypdf").setLevel(logging.ERROR)

#: Enough to reach the title page, the abstract and the affiliations of any
#: paper, without spending a worker's minute on a 300-page thesis.
MAX_PAGES = 30
MAX_CHARS = 400_000
#: Below this a "text layer" is a page number and a watermark: a scan.
MIN_TEXT_CHARS = 40

#: How much of a title must be present for it to count as found. Extraction
#: drops the odd word at a line break or in a ligature, so all of them is too
#: strict; most of them is still not something another paper says by chance.
TITLE_SHARE = 0.8
JOURNAL_SHARE = 0.6

#: Words in a college's name that say nothing about which college it is.
_GENERIC_NAME_WORDS = {
    "college", "engineering", "university", "institute", "institution",
    "technology", "technological", "school", "science", "sciences", "of",
    "and", "the", "for", "arts", "deemed", "be", "to",
}
_HONORIFICS = {"dr", "mr", "mrs", "ms", "miss", "prof", "professor", "er"}

_OWN_PDF = re.compile(r"^/media/claims/([0-9a-f]{32}\.pdf)$")


@dataclass
class Comparison:
    found: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    detail: list[str] = field(default_factory=list)

    @property
    def score(self) -> int | None:
        looked_for = len(self.found) + len(self.missing)
        return round(100 * len(self.found) / looked_for) if looked_for else None


# ---- reading ----------------------------------------------------------------


def extract_text(data: bytes) -> tuple[str, int]:
    """(text, pages read). Raises ValueError when the file cannot be opened."""
    from pypdf import PdfReader
    from pypdf.errors import PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            # Publishers routinely encrypt with an empty user password, which
            # stops copying but not reading.
            reader.decrypt("")
        chunks: list[str] = []
        total = 0
        pages = 0
        for page in reader.pages[:MAX_PAGES]:
            pages += 1
            text = page.extract_text() or ""
            chunks.append(text)
            total += len(text)
            if total >= MAX_CHARS:
                break
        return "\n".join(chunks)[:MAX_CHARS], pages
    except PyPdfError as exc:
        raise ValueError(str(exc) or exc.__class__.__name__) from exc
    except Exception as exc:  # noqa: BLE001
        # A malformed publisher PDF can make pypdf raise almost anything --
        # AttributeError, IndexError, RecursionError -- and one bad file must
        # not stop the rest of the claim being read.
        raise ValueError(f"{exc.__class__.__name__}: {exc}"[:300]) from exc


def _words(text: str) -> str:
    """Lower-case words separated by single spaces, ligatures and hyphenated
    line breaks undone."""
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"-\s*\n\s*", "", text)
    text = re.sub(r"[^0-9a-z]+", " ", text.lower())
    return f" {text.strip()} "


def _squashed(text: str) -> list[str]:
    """The text with all whitespace removed, with and without hyphenated line
    breaks joined -- a DOI can legitimately end a line on a hyphen."""
    text = unicodedata.normalize("NFKC", text).lower()
    return [re.sub(r"\s+", "", text), re.sub(r"\s+", "", re.sub(r"-\s*\n", "", text))]


def _share_found(expected: set[str], words: str) -> float:
    if not expected:
        return 0.0
    return sum(1 for w in expected if f" {w} " in words) / len(expected)


def affiliation_words(college_name: str) -> list[str]:
    """The part of the college's name that identifies it ("saveetha")."""
    tokens = [t for t in _words(college_name).split() if t not in _GENERIC_NAME_WORDS]
    return tokens or [_words(college_name).strip()]


def _name_tokens(name: str) -> set[str]:
    return {t for t in _words(name).split() if len(t) >= 3 and t not in _HONORIFICS}


# ---- comparing --------------------------------------------------------------


def compare_published_paper(
    text: str,
    *,
    title: str | None,
    doi: str | None,
    journal: str | None,
    issn: str | None,
    claimant: str | None,
    college_name: str,
) -> Comparison:
    """What of the claim this paper's text bears out. Pure: no database."""
    words = _words(text)
    squashed = _squashed(text)
    out = Comparison()

    expected = title_tokens(title)
    if expected:
        share = _share_found(expected, words)
        (out.found if share >= TITLE_SHARE else out.missing).append("title")
        out.detail.append(f"{round(share * 100)}% of the title's words")

    bare = normalize_doi(doi)
    if bare:
        needle = re.sub(r"\s+", "", bare)
        (out.found if any(needle in s for s in squashed) else out.missing).append("doi")

    journal_words = title_tokens(journal)
    issn_clean = normalize_issn(issn) if issn else None
    if journal_words or issn_clean:
        by_name = bool(journal_words) and _share_found(journal_words, words) >= JOURNAL_SHARE
        by_issn = False
        if issn_clean and len(issn_clean) == 9:
            head, tail = issn_clean.lower().split("-")
            by_issn = re.search(rf"{head}\s*[-‐-―]?\s*{tail}", text.lower()) is not None
        (out.found if by_name or by_issn else out.missing).append("journal")

    names = _name_tokens(claimant or "")
    if names:
        needed = math.ceil(len(names) / 2)
        present = sum(1 for n in names if f" {n} " in words)
        (out.found if present >= needed else out.missing).append("claimant")

    college = affiliation_words(college_name)
    (out.found if any(f" {w} " in words for w in college) else out.missing).append("affiliation")
    return out


def compare_reference(text: str, *, ref_title: str | None, college_name: str) -> Comparison:
    """A cited reference: its own title, and the affiliation it is there to prove."""
    words = _words(text)
    out = Comparison()
    expected = title_tokens(ref_title)
    if expected:
        share = _share_found(expected, words)
        (out.found if share >= TITLE_SHARE else out.missing).append("reference_title")
    college = affiliation_words(college_name)
    (out.found if any(f" {w} " in words for w in college) else out.missing).append("affiliation")
    return out


# ---- checking a claim --------------------------------------------------------


def storage_name(url: str) -> str | None:
    """The storage key for one of our own uploaded PDFs, or None."""
    m = _OWN_PDF.match((url or "").strip())
    return f"claims/{m.group(1)}" if m else None


def _college_name() -> str:
    from core.services import institution

    return institution.get("college_name")


def _check_one(claim: Claim, attachment, name: str) -> dict:
    """The fields of an AttachmentCheck for one file."""
    base = {"kind": attachment.kind, "filename": attachment.filename}
    try:
        with default_storage.open(name, "rb") as fh:
            data = fh.read()
    except Exception as exc:  # noqa: BLE001
        # Broad on purpose: the four storage backends (disk, database, GCS,
        # S3) each report a missing object with their own exception, and one
        # file that cannot be fetched must not stop the rest being read.
        logger.warning("file_check_unreadable claim=%s name=%s error=%r", claim.id, name, exc)
        return {**base, "outcome": AttachmentCheck.Outcome.UNREADABLE,
                "detail": f"The file could not be fetched from storage ({exc.__class__.__name__})."}

    base["content_hash"] = content_digest(data)
    try:
        text, pages = extract_text(data)
    except ValueError as exc:
        return {**base, "outcome": AttachmentCheck.Outcome.UNREADABLE,
                "detail": f"The PDF could not be opened: {str(exc)[:200]}"}

    chars = len(re.sub(r"\s+", "", text))
    base["text_chars"] = chars
    if chars < MIN_TEXT_CHARS:
        return {**base, "outcome": AttachmentCheck.Outcome.NO_TEXT,
                "detail": f"{pages} page{'s' if pages != 1 else ''} with no text layer — probably scanned."}

    college = _college_name()
    if attachment.kind == AttachmentKind.PUBLISHED_PAPER:
        result = compare_published_paper(
            text,
            title=claim.paper_title,
            doi=claim.doi,
            journal=claim.journal_title,
            issn=claim.issn,
            claimant=claim.owner.name if claim.owner_id else None,
            college_name=college,
        )
        failed = {"title", "doi"} & set(result.missing)
    else:
        result = compare_reference(text, ref_title=attachment.ref_title, college_name=college)
        failed = set(result.missing)
    return {
        **base,
        "outcome": AttachmentCheck.Outcome.MISMATCH if failed else AttachmentCheck.Outcome.MATCHED,
        "found_json": json.dumps(result.found),
        "missing_json": json.dumps(result.missing),
        "score": result.score,
        "detail": "; ".join(result.detail) or None,
    }


_LABELS = {"title": "title", "doi": "DOI", "journal": "journal", "claimant": "claimant's name",
           "affiliation": "college affiliation", "reference_title": "reference's title"}


def _sentence_list(items: list[str]) -> str:
    items = [_LABELS.get(i, i) for i in items]
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} and {items[-1]}"


def _flag_note(check: AttachmentCheck) -> str:
    name = f"“{check.filename}”" if check.filename else "attached"
    if check.outcome == AttachmentCheck.Outcome.NO_TEXT:
        return (
            f"The published paper {name} has no text to read — it is probably a scanned "
            "copy, so its title and DOI could not be checked. Open it and compare it "
            "with the claim by eye."
        )
    missing = [m for m in json.loads(check.missing_json) if m in ("title", "doi")]
    found = json.loads(check.found_json)
    return (
        f"The published paper {name} does not contain the claim's {_sentence_list(missing)}."
        + (f" It does contain the {_sentence_list(found)}." if found else "")
        + " Check that the right file was attached."
    )


def _needs_flag(check: AttachmentCheck) -> bool:
    return check.kind == AttachmentKind.PUBLISHED_PAPER and check.outcome in (
        AttachmentCheck.Outcome.MISMATCH,
        AttachmentCheck.Outcome.NO_TEXT,
    )


def claim_fingerprint(claim: Claim, attachment, college_name: str) -> str:
    """The claim's facts a check of this file compares against, as one hash.

    Stored with the result and carried in the flag's key, so a result is
    reused only while the claim still says what it said when the file was
    read, and a flag is about one version of the claim: a claimant who
    changes the title and files again with the same PDF is asked again,
    even though somebody resolved the question about the old title.
    """
    if attachment.kind == AttachmentKind.PUBLISHED_PAPER:
        facts = [
            claim.paper_title, normalize_doi(claim.doi), claim.journal_title, claim.issn,
            claim.owner.name if claim.owner_id else None,
        ]
    else:
        facts = [attachment.ref_title]
    raw = "␟".join(str(f or "") for f in [attachment.kind, *facts, college_name])
    return content_digest(raw.encode("utf-8"))[:16]


def _auto_key(url: str, fingerprint: str) -> str:
    return f"file:{url}#{fingerprint}"[:255]


#: Said when the check closes a flag it raised itself, so the history reads
#: as the check changing its mind rather than a person waving it through.
_NO_LONGER_ATTACHED = "Closed by the file check: that file is no longer attached to the claim."
_NO_LONGER_APPLIES = (
    "Closed by the file check: the claim's files were read again and this no longer applies."
)


def _close_stale_file_flags(claim: Claim, checks: list[AttachmentCheck], still: set[str]) -> None:
    """Close the check's own open flags that the latest reading no longer bears out.

    A flag is kept open when its file could not be read this time -- a
    storage fault says nothing about whether the paper matches -- and every
    flag a person raised is left alone.
    """
    by_url = {c.url: c for c in checks}
    for flag in claim.flags.filter(
        source=ClaimFlag.Source.AUTO, resolved_at__isnull=True, auto_key__startswith="file:"
    ):
        if flag.auto_key in still:
            continue
        url = flag.auto_key[len("file:"):].rsplit("#", 1)[0]
        check = by_url.get(url)
        if check is None:
            flag_service.resolve_flag(flag, actor=None, note=_NO_LONGER_ATTACHED)
        elif check.outcome != AttachmentCheck.Outcome.UNREADABLE:
            flag_service.resolve_flag(flag, actor=None, note=_NO_LONGER_APPLIES)


def check_claim_files(
    claim_id: str, *, force: bool = False, notify: bool = True
) -> tuple[list[AttachmentCheck], int]:
    """Read every PDF on the claim and store what it says. Returns (checks, flags raised).

    A file already read is not read again while the claim still says what it
    said then (its URL names one upload, so the bytes cannot have changed),
    unless `force` -- at filing, and when a reviewer asks.

    Flags are raised only on a filed claim. A draft is private until it is
    filed (nobody else can see it), and filing forces a fresh read. The
    check also closes its own flags that no longer apply: the claim or the
    file was corrected, or the file was taken off the claim.
    """
    claim = Claim.objects.select_related("owner").filter(pk=claim_id).first()
    if claim is None:
        return [], 0

    attached = [(a, storage_name(a.url)) for a in claim.attachments.all()]
    attached = [(a, name) for a, name in attached if name]
    existing = {c.url: c for c in claim.file_checks.all()}
    # A file taken off the claim takes its result with it.
    claim.file_checks.exclude(url__in=[a.url for a, _ in attached]).delete()

    college = _college_name()
    filed = claim.status != ClaimStatus.DRAFT
    checks: list[AttachmentCheck] = []
    still: set[str] = set()
    raised = 0
    for attachment, name in attached:
        fingerprint = claim_fingerprint(claim, attachment, college)
        check = existing.get(attachment.url)
        if check is None or force or check.claim_fingerprint != fingerprint:
            fields = _check_one(claim, attachment, name)
            defaults = {
                "found_json": "[]", "missing_json": "[]", "score": None, "detail": None,
                "text_chars": 0, "content_hash": None, **fields,
                "claim_fingerprint": fingerprint, "checked_at": timezone.now(),
            }
            check, _ = AttachmentCheck.objects.update_or_create(
                claim=claim, url=attachment.url, defaults=defaults
            )
        checks.append(check)
        if filed and _needs_flag(check):
            key = _auto_key(check.url, fingerprint)
            still.add(key)
            _, created = flag_service.raise_flag(
                claim,
                kind=ClaimFlag.Kind.CONTENT_MISMATCH,
                note=_flag_note(check),
                source=ClaimFlag.Source.AUTO,
                auto_key=key,
                notify=notify,
            )
            raised += int(created)
    if filed:
        _close_stale_file_flags(claim, checks, still)
    return checks, raised


def enqueue_file_check(claim_id: str, *, force: bool = True) -> str | None:
    """Read the claim's files off the request thread. Never raises.

    On the job queue in production; inline when FILE_CHECKS_SYNC is set,
    which is how the tests run it. A failure here must never undo or refuse
    the filing that asked for it, so it is logged and swallowed.
    """
    try:
        if getattr(settings, "FILE_CHECKS_SYNC", False):
            check_claim_files(claim_id, force=force)
            return None
        from django_q.tasks import async_task

        return async_task("core.tasks.run_claim_file_check", claim_id, force)
    except Exception:  # the filing stands whatever happens here
        logger.exception("file_check_enqueue_failed claim=%s", claim_id)
        return None
