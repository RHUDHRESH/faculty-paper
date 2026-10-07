"""Claim pre-check: a second reader for the research cell, never a judge.

What it does. For a filed claim it reads the attached PDFs (server-side, cut to
what matters) beside the record and returns six checklist items, each pass,
warn or fail with the evidence for it: the affiliation line, the author
position against the stored author list, the SEC references found and
numbered, the journal's indexing and quartile for the year, the watch-list and
predatory signals, and a possible duplicate across co-authors.

The rules it keeps (docs/ux/20-ai.md).

- **Deterministic checks are the source of truth.** Every item has a baseline
  worked out without a model: from the college's own tables
  (`journal_watch`, the stored quartile and verification, the author list and
  the publication record) and from the text of the files
  (`content_check`). The model only adds a reading of the free text, and the
  merge (`_merge`) is one-directional: a failed baseline stays failed whatever
  the model says; the model may lower a pass to a warning, never raise
  anything; and it may do even that only with a quotation that is really in
  the file (`_locate` checks it against the extracted text). A model that
  returns something nobody can find in the PDF has made no point at all.
- **The file is data.** PDF text and the claim form's own words are wrapped
  between random markers the file cannot know, with an instruction to treat
  all of it as material to read. Text in a PDF that talks to an AI reader is
  itself reported to the reviewer as a signal (`INJECTION`). The answer is
  parsed into a fixed shape, unknown keys are dropped, and nothing here
  writes to the claim: not its status, not a flag, not a checklist tick.
- **Bounded.** The model sees at most `PROMPT_CHARS` of text; a person gets
  `settings.AI_PRECHECK_DAILY_LIMIT` model calls a day (counted from the audit
  log, so a restart cannot reset it); the same claim with the same files is
  answered from `AIPrecheck` without a call.
- **Honest.** Which model and host answered, and the tokens used (estimated
  from characters; the providers here do not report them), are stored with the
  result and in the audit log.

The model is asked through `ai_harness` (`PRECHECK` for the check, `DRAFT` for
the send-back reason): the harness fences the file text and the form as data
with a random token, checks the answer's shape, removes any claim that the AI
approved or cleared something, and writes the usage row. `_ask` is the one
place this module calls it.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import re
import unicodedata
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from django.conf import settings
from django.core.files.storage import default_storage
from django.utils import timezone

from core.models import (
    AIFeedback,
    AIPrecheck,
    AttachmentKind,
    AuditLog,
    Claim,
    ClaimStatus,
    User,
)
from core.services import ai, ai_harness as harness, content_check, institution, journal_watch
from core.services.author_names import name_score
from core.services.normalize import normalize_doi, normalize_title, title_tokens

logger = logging.getLogger(__name__)

FEATURE = "claim_precheck"
PROMPT_VERSION = "3"

#: The six items, in the order a reviewer reads them.
KEYS = ("affiliation", "author_position", "sec_references", "journal", "watch_list", "duplicate")
LABELS = {
    "affiliation": "College affiliation",
    "author_position": "Author position",
    "sec_references": "SEC references",
    "journal": "Journal and quartile",
    "watch_list": "Watch-list and warning signs",
    "duplicate": "Possible duplicate",
}
STATUSES = ("pass", "warn", "fail")
_RANK = {"pass": 0, "warn": 1, "fail": 2}

#: What the model is shown. Roughly 3,500 tokens of file text: the title page
#: (title, authors, affiliations, abstract), the reference list, and the top of
#: each cited reference. A free hosted tier allows about 12,000 tokens a minute
#: and a reviewer opens several claims in that minute.
PAPER_HEAD_CHARS = 4500
PAPER_REFS_CHARS = 6000
REF_FILE_CHARS = 1000
REF_FILES_SHOWN = 3
PROMPT_CHARS = 16000
QUOTE_CHARS = 240
NOTE_CHARS = 320

AUDIT_RUN = "ai.claim_precheck"
AUDIT_CACHED = "ai.claim_precheck_cached"
AUDIT_DRAFT = "ai.send_back_draft"
AUDIT_FEEDBACK = "ai.feedback"

#: Phrases that address a reader rather than describe a paper. Matching one is
#: not proof of anything, which is why it is a warning with the line quoted and
#: never a failure.
INJECTION = re.compile(
    r"(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier)?\s*"
    r"(instructions?|prompts?|rules?)"
    r"|you\s+are\s+now\b|system\s+prompt|as\s+an\s+ai\b|\bmark\s+(this|every|all)\b.*\b(pass|passed|cleared|approved)\b"
    r"|\b(clear|approve|authori[sz]e)\s+this\s+claim\b|output\s+(only\s+)?json\b|reveal\s+your",
    re.I,
)


class PrecheckError(Exception):
    """A refusal with the HTTP status and sentence the endpoint should give."""

    def __init__(self, status: int, message: str, *, code: str = "error"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


# ---------------------------------------------------------------------------
# Reading the files
# ---------------------------------------------------------------------------


@dataclass
class FileRead:
    attachment: Any
    kind: str
    name: str
    state: str  # ok | no_text | unreadable | not_pdf
    pages: list[tuple[int, str]] = field(default_factory=list)
    note: str = ""

    @property
    def text(self) -> str:
        return "\n".join(t for _, t in self.pages)

    def public(self) -> dict[str, Any]:
        return {"name": self.name, "kind": self.kind, "state": self.state, "pages": len(self.pages)}


def extract_pages(data: bytes) -> list[tuple[int, str]]:
    """(page number, text) for each page read. Raises ValueError for a file that will not open.

    Page-aware where `content_check.extract_text` is not, because an evidence
    quote is worth much more with the page it is on.
    """
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            reader.decrypt("")
        out: list[tuple[int, str]] = []
        total = 0
        for number, page in enumerate(reader.pages[: content_check.MAX_PAGES], start=1):
            text = page.extract_text() or ""
            out.append((number, text))
            total += len(text)
            if total >= content_check.MAX_CHARS:
                break
        return out
    except Exception as exc:  # noqa: BLE001 - a malformed PDF can raise almost anything
        raise ValueError(f"{exc.__class__.__name__}: {exc}"[:200]) from exc


def read_files(claim: Claim) -> list[FileRead]:
    """Every PDF on the claim, read once. A file that cannot be read says why."""
    out: list[FileRead] = []
    for att in claim.attachments.all():
        if att.kind not in (AttachmentKind.PUBLISHED_PAPER, AttachmentKind.SEC_REFERENCE):
            continue
        name = att.filename or "the file"
        storage = content_check.storage_name(att.url)
        if not storage:
            out.append(FileRead(att, att.kind, name, "not_pdf", note="It is not a file this server holds."))
            continue
        try:
            with default_storage.open(storage, "rb") as fh:
                data = fh.read()
        except Exception:  # noqa: BLE001 - each storage backend raises its own kind
            out.append(FileRead(att, att.kind, name, "unreadable", note="The file could not be fetched."))
            continue
        try:
            pages = extract_pages(data)
        except ValueError:
            out.append(FileRead(att, att.kind, name, "unreadable", note="The PDF could not be opened."))
            continue
        chars = len(re.sub(r"\s+", "", "".join(t for _, t in pages)))
        if chars < content_check.MIN_TEXT_CHARS:
            out.append(FileRead(att, att.kind, name, "no_text", pages, "No text layer, probably scanned."))
        else:
            out.append(FileRead(att, att.kind, name, "ok", pages))
    return out


def _norm(text: str) -> str:
    """Words only, lower case, line-break hyphens undone: what two copies of a line share."""
    text = unicodedata.normalize("NFKC", text or "")
    text = re.sub(r"-\s*\n\s*", "", text)
    return " ".join(re.sub(r"[^0-9a-z]+", " ", text.lower()).split())


def _locate(quote: str, files: list[FileRead]) -> dict[str, Any] | None:
    """Where `quote` really is in the files, or None. The only way a quote earns a page."""
    needle = _norm((quote or "").strip(" .…\"'“”"))
    if len(needle) < 12:
        return None
    for f in files:
        for number, text in f.pages:
            if needle in _norm(text):
                return {"file": f.name, "page": number}
    return None


def _clip(text: Any, limit: int) -> str:
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(text or ""))
    s = " ".join(s.split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _affiliation_line(f: FileRead, words: list[str]) -> dict[str, Any] | None:
    """The first line in the file's text that carries the college's name."""
    for number, text in f.pages:
        for line in text.splitlines():
            squashed = content_check._words(line)
            if any(f" {w} " in squashed for w in words):
                return {"quote": _clip(line, QUOTE_CHARS), "page": number, "file": f.name, "by": "check"}
    return None


def _injection_lines(files: list[FileRead]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    for f in files:
        for number, text in f.pages:
            for line in text.splitlines():
                if INJECTION.search(line):
                    found.append({"quote": _clip(line, QUOTE_CHARS), "page": number, "file": f.name, "by": "check"})
                    if len(found) >= 3:
                        return found
    return found


# ---------------------------------------------------------------------------
# What is known without a model
# ---------------------------------------------------------------------------


def _min_references() -> int:
    from core.api.teams import _min_sec_references

    return int(_min_sec_references())


def _owner(claim: Claim) -> str:
    return claim.owner.name if claim.owner_id else "the claimant"


def _item(key: str, status: str, detail: str, evidence: list[dict] | None = None) -> dict[str, Any]:
    return {
        "key": key,
        "label": LABELS[key],
        "status": status,
        "detail": detail,
        "evidence": evidence or [],
        "locked": status == "fail",
        "ai": None,
    }


def _check_affiliation(claim: Claim, files: list[FileRead], college: str) -> dict[str, Any]:
    papers = [f for f in files if f.kind == AttachmentKind.PUBLISHED_PAPER]
    if not papers:
        return _item("affiliation", "warn", "No published paper is attached, so there is no text to search for the college's name.")
    words = content_check.affiliation_words(college)
    readable = [f for f in papers if f.state == "ok"]
    for f in readable:
        hit = _affiliation_line(f, words)
        if hit:
            return _item("affiliation", "pass", f"“{college}” is in the paper's text.", [hit])
    if readable:
        names = ", ".join(f.name for f in readable)
        return _item("affiliation", "fail", f"“{college}” is not in the text of {names}.")
    return _item("affiliation", "warn", "The paper has no readable text, so the affiliation has to be checked by eye.")


def _check_position(claim: Claim) -> dict[str, Any]:
    from core.api.deps import record_authorship
    from core.services.applicant import _authors

    mine, total = claim.author_position, claim.total_authors
    said = f"The claim says author {mine} of {total}"
    who = _owner(claim)
    rec = record_authorship(claim)
    if rec["record_author_position"] is not None:
        if rec["record_author_position"] != mine:
            return _item("author_position", "fail", f"{said}, but the paper's record puts {who} at position {rec['record_author_position']}.")
        if rec["record_total_authors"] and rec["record_total_authors"] != total:
            return _item("author_position", "warn", f"{said}; the paper's record lists {rec['record_total_authors']} authors.")
        return _item("author_position", "pass", f"{said}, which matches the paper's record.")
    names = _authors(claim)
    if names and claim.owner_id:
        scores = [name_score(claim.owner.name, n) for n in names]
        best = max(scores)
        if best >= 0.7:
            at = scores.index(best) + 1
            if at != mine:
                return _item("author_position", "fail", f"{said}, but in the author list saved with the claim {who} is at position {at}.")
            if len(names) != total:
                return _item("author_position", "warn", f"{said}; the saved author list has {len(names)} names.")
            return _item("author_position", "pass", f"{said}, which matches the author list saved with the claim.")
    return _item("author_position", "warn", f"{said}. There is no author list on record to compare it with.")


def _check_references(claim: Claim, files: list[FileRead], college: str, minimum: int) -> dict[str, Any]:
    refs = [a for a in claim.attachments.all() if a.kind == AttachmentKind.SEC_REFERENCE]
    numbers = [(a.ref_number or "").strip() for a in refs]
    numbered = [n for n in numbers if n]
    repeated = sorted({n for n in numbered if numbered.count(n) > 1})
    words = content_check.affiliation_words(college)
    evidence: list[dict] = []
    absent: list[str] = []
    unread = 0
    for f in files:
        if f.kind != AttachmentKind.SEC_REFERENCE:
            continue
        if f.state != "ok":
            unread += 1
            continue
        hit = _affiliation_line(f, words)
        if hit:
            hit["ref_number"] = (f.attachment.ref_number or "").strip() or None
            evidence.append(hit)
        else:
            absent.append(f.name)
    if len(refs) < minimum:
        return _item("sec_references", "fail", f"{len(refs)} of the {minimum} SEC references the policy asks for are attached.", evidence)
    if absent:
        return _item("sec_references", "fail", f"“{college}” is not in the text of {', '.join(absent)}.", evidence)
    if len(numbered) < len(refs):
        return _item("sec_references", "warn", "Some references have no number from the paper's reference list.", evidence)
    if repeated:
        return _item("sec_references", "warn", f"Reference number {', '.join(repeated)} is used more than once.", evidence)
    ordered = ", ".join(sorted(numbered, key=lambda n: (len(n), n)))
    if unread:
        return _item("sec_references", "warn", f"References {ordered} are numbered, but {unread} file(s) could not be read for the college's name.", evidence)
    return _item("sec_references", "pass", f"{len(refs)} references, numbered {ordered}; each shows the college.", evidence)


def _issues(claim: Claim) -> list[str]:
    try:
        snap = json.loads(claim.verification_snapshot_json or "{}")
    except ValueError:
        return []
    issues = snap.get("issues") if isinstance(snap, dict) else None
    return [i for i in issues if isinstance(i, str)] if isinstance(issues, list) else []


def _check_journal(claim: Claim) -> dict[str, Any]:
    journal = claim.journal_title or "The journal"
    year = claim.publication_year
    if claim.verification_ok is False:
        issues = _issues(claim)
        why = " ".join(issues[:2]) if issues else "The automatic checks found a problem with this claim."
        return _item("journal", "fail", _clip(why, NOTE_CHARS * 2))
    indexed = bool(claim.eid or claim.scopus_url or claim.indexing_level or claim.indexing_status == "Indexed")
    quartile = (claim.quartile or "").strip()
    if not quartile:
        return _item("journal", "warn", f"No quartile is on record for {journal}{f' for {year}' if year else ''}.")
    source = {"SCIMAGO": "Scimago", "MANUAL": "confirmed by hand"}.get(claim.quartile_source or "", "")
    data_year = claim.scimago_dataset_year or claim.snip_year
    bits = [f"{journal} is {quartile}"]
    if source:
        bits.append(f"({source}{f', {data_year} figures' if data_year else ''})")
    if claim.snip is not None:
        bits.append(f"with SNIP {claim.snip:g}")
    sentence = " ".join(bits) + "."
    if year and data_year and abs(int(year) - int(data_year)) > 1:
        return _item("journal", "warn", f"{sentence} The paper is from {year}, so check the quartile for that year.")
    if not source:
        return _item("journal", "warn", f"{sentence} Its source is not recorded.")
    if not indexed:
        return _item("journal", "warn", f"{sentence} Indexing is not recorded.")
    return _item("journal", "pass", sentence)


def _check_watch(claim: Claim, files: list[FileRead]) -> dict[str, Any]:
    hit = journal_watch.watch_for(claim.issn, claim.journal_title)
    lines = _injection_lines(files)
    if hit:
        why = f" Reason on the list: {_clip(hit['reason'], NOTE_CHARS)}" if hit.get("reason") else ""
        return _item("watch_list", "fail", f"{claim.journal_title or 'The journal'} is on the research office's watch-list.{why}", lines)
    if lines:
        return _item("watch_list", "warn", "The journal is not on the watch-list, but text in the file speaks to an AI reader instead of describing the paper.", lines)
    return _item("watch_list", "pass", "The journal is not on the research office's watch-list.")


def _similar_claims(claim: Claim) -> list[dict[str, Any]]:
    """Other filed claims for what looks like the same paper, with how they matched."""
    pool = Claim.objects.exclude(pk=claim.pk).exclude(status__in=[ClaimStatus.DRAFT, ClaimStatus.REJECTED])
    out: dict[str, dict[str, Any]] = {}
    doi = normalize_doi(claim.doi)
    if doi:
        for o in pool.filter(doi__iexact=doi).select_related("owner")[:6]:
            out[o.id] = {"claim": o, "how": "same DOI"}
    title = normalize_title(claim.paper_title)
    if title:
        for o in pool.filter(normalized_title=title).select_related("owner")[:6]:
            out.setdefault(o.id, {"claim": o, "how": "same title"})
        mine = title_tokens(claim.paper_title)
        if mine and claim.publication_year:
            near = pool.filter(publication_year=claim.publication_year).exclude(pk__in=list(out)).select_related("owner")
            for o in near[:400]:
                theirs = title_tokens(o.paper_title)
                if theirs and len(mine & theirs) / max(len(mine), len(theirs)) >= 0.85:
                    out[o.id] = {"claim": o, "how": "a very similar title"}
                    if len(out) >= 6:
                        break
    return list(out.values())


def _describe(match: dict[str, Any]) -> str:
    o = match["claim"]
    number = o.ticket_number or "a claim"
    return f"{number} by {o.owner.name} ({match['how']})"


def _check_duplicate(claim: Claim, matches: list[dict[str, Any]]) -> dict[str, Any]:
    if claim.duplicate_warning and not claim.override_duplicate:
        return _item("duplicate", "fail", "The payment history shows this paper may already have been paid.")
    same_person = [m for m in matches if m["claim"].owner_id == claim.owner_id]
    if same_person:
        return _item("duplicate", "fail", f"The same person has already filed this paper: {_describe(same_person[0])}.")
    if matches:
        listed = "; ".join(_describe(m) for m in matches[:3])
        return _item("duplicate", "warn", f"Another claim looks like the same paper: {listed}. Check that the co-authors' shares do not overlap.")
    if claim.duplicate_warning:
        return _item("duplicate", "warn", "The payment history matched this paper, and the match was overridden.")
    return _item("duplicate", "pass", "No other claim for this paper was found.")


def deterministic(claim: Claim, files: list[FileRead], matches: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    college = institution.get("college_name")
    return {
        "affiliation": _check_affiliation(claim, files, college),
        "author_position": _check_position(claim),
        "sec_references": _check_references(claim, files, college, _min_references()),
        "journal": _check_journal(claim),
        "watch_list": _check_watch(claim, files),
        "duplicate": _check_duplicate(claim, matches),
    }


# ---------------------------------------------------------------------------
# The cache key
# ---------------------------------------------------------------------------


def input_hash(claim: Claim) -> str:
    """The claim's facts and its files' identities, as one hash.

    Files are named by their stored content hash, or by their URL, which names
    one upload. Reading nothing here means opening a claim costs no file reads
    when the answer is already stored.
    """
    watch = journal_watch.watch_for(claim.issn, claim.journal_title)
    facts = [
        PROMPT_VERSION, ai.model_name(), institution.get("college_name"), _min_references(),
        claim.owner_id, claim.paper_title, normalize_doi(claim.doi), claim.journal_title, claim.issn,
        claim.publication_year, claim.authors_json, claim.author_position, claim.total_authors,
        claim.quartile, claim.quartile_source, claim.snip, claim.scimago_dataset_year,
        claim.indexing_level, claim.indexing_status, claim.verification_ok,
        claim.duplicate_warning, claim.override_duplicate, claim.sec_refs,
        watch["id"] if watch else None, watch["reason"] if watch else None,
        sorted(
            (a.kind, a.content_hash or a.url, a.ref_number or "", a.ref_title or "")
            for a in claim.attachments.all()
        ),
        sorted(m["claim"].id for m in _similar_claims(claim)),
    ]
    return hashlib.sha256(json.dumps(facts, default=str, sort_keys=True).encode()).hexdigest()


# ---------------------------------------------------------------------------
# Asking the model
# ---------------------------------------------------------------------------

#: What the model is asked to return, checked by the harness (`ai_harness`)
#: before `parse_answer` reduces it further. Everything but the key is
#: optional with an empty default, as `parse_answer` always treated it; a key
#: or status outside the six items and four words is still dropped there.
#: Fields the schema does not name (`claim_status`, `approve`) never get that far.
_Q = harness.Str(300, truncate=True, required=False, default="")
_ITEM = harness.Obj({
    "key": harness.Str(40),
    "status": harness.Str(20, required=False, default="unsure"),
    "quote": _Q,
    "note": harness.Str(400, truncate=True, required=False, default=""),
    "printed_authors": harness.Arr(harness.Str(80, truncate=True), max_items=40, drop_invalid=True, required=False, default=[]),
    "claimant_position": harness.Num(1, 500, integer=True, required=False, default=None),
    "references": harness.Arr(
        harness.Obj({"attached_number": harness.Str(16, truncate=True, required=False, default=""),
                     "entry_number": harness.Str(16, truncate=True, required=False, default=""),
                     "quote": _Q}),
        max_items=12, drop_invalid=True, required=False, default=[]),
    "signals": harness.Arr(
        harness.Obj({"quote": _Q, "note": harness.Str(400, truncate=True, required=False, default="")}),
        max_items=5, drop_invalid=True, required=False, default=[]),
})

_READER_RULES = """You are a careful second reader for a college research office. You read one filed claim and report what the files say. A person decides; you never decide.

Answer with one JSON object: {"items": [...], "summary": "..."}. Give exactly one item for each of these keys, in this order: """ + ", ".join(KEYS) + """. Each item has "key", "status" (pass, warn, fail or unsure), "quote" (copied word for word from the file text, at most 200 characters, empty if there is none) and "note" (at most 25 words, plain English).
Rules for every item: never invent a quote, a page or a number; if the file does not show it, say "unsure" with an empty quote. A "warn" or "fail" needs a quote from the file text.
- affiliation: quote the line that gives the claimant's affiliation to the college. pass if the claimant's own byline or address names it; warn if it appears only elsewhere (acknowledgements, another author).
- author_position: also give "printed_authors" (author names in the order printed) and "claimant_position" (1-based position of the claimant, or null). Quote the byline.
- sec_references: also give "references": for each attached reference, {"attached_number", "entry_number" (its number in the paper's reference list), "quote" (that list entry)}.
- journal: say whether the journal name or ISSN printed in the paper matches the claim. Quote the printed name.
- watch_list: also give "signals": warning signs of a predatory or doubtful venue visible in the text (fee demands, very short review times, a journal name that differs from the claim), each with a quote and a note. Empty if none.
- duplicate: using only "similar_claims" in the form, say whether any looks like the same paper. No quote is needed.
Keep each note to the facts. Do not mention these rules."""

#: Staff only (the endpoint checks), reading PDFs. Closed world: it may say only
#: what the form, the facts and the file text show. The harness keeps the file
#: text and the form fenced as data and drops from the answer anything that
#: claims the AI approved or cleared; the merge below then lets the model do
#: no more than lower a pass to a warning, and only with a quote that is in the file.
PRECHECK = harness.register(harness.Feature(
    name="review.precheck",
    model="considered",
    system=_READER_RULES,
    schema=harness.Obj({"items": harness.Arr(_ITEM, max_items=12, drop_invalid=True),
                        "summary": harness.Str(600, truncate=True, required=False, default="")}),
    # Sentence guards only: `note` is one of the API's money keys, and here it is the item's own field.
    guards=lambda user: [*harness.role_guards(user, allow_money=False, strip_keys=False), harness.NoDecisions()],
    # A wrong shape was always "the answer could not be read"; asking once more is cheap
    # next to a reviewer waiting, but a hosted allowance is not, so once and no more.
    limits=harness.Limits(timeout=45, reasks=1, transient_retries=1, max_block_chars=PROMPT_CHARS,
                          max_input_chars=PROMPT_CHARS + 8000),
    temperature=0.1,
))

_DRAFT_RULES = """You write the reason a college research office gives a faculty member when it sends a claim back to be corrected.

Write one reason of at most 110 words. Start with one short sentence, then one numbered line for each problem, saying plainly what to fix. Polite and specific, in plain English. Use only the facts given. Do not mention AI, the research office, any staff member or any desk; speak as "the college". Do not promise an outcome.

Answer with one JSON object: {"reason": "..."}"""

#: Goes to a faculty member once the officer has edited it, so the guards that
#: keep a desk or a person out of what a claimant reads apply, and a sentence
#: saying the AI sent or approved something is removed.
DRAFT = harness.register(harness.Feature(
    name="review.precheck.draft",
    model="fast",
    system=_DRAFT_RULES,
    schema=harness.Obj({"reason": harness.Str(1500, truncate=True)}),
    guards=lambda user: [harness.NoDeskNames(), harness.NoDecisions(), harness.NoMoneyText()],
    limits=harness.Limits(timeout=45, reasks=0, transient_retries=1),
    temperature=0.3,
))


def _blocks(claim: Claim, files: list[FileRead], matches: list[dict]) -> list[harness.DataBlock]:
    """The claim form and the file text, as fenced data. Both are somebody's words."""
    refs = [
        {"attached_number": (a.ref_number or "").strip(), "title": _clip(a.ref_title, 200)}
        for a in claim.attachments.all()
        if a.kind == AttachmentKind.SEC_REFERENCE
    ]
    record = {
        "claimant": _owner(claim),
        "paper_title": _clip(claim.paper_title, 300),
        "journal": _clip(claim.journal_title, 200),
        "issn": claim.issn,
        "doi": claim.doi,
        "year": claim.publication_year,
        "author_position_claimed": claim.author_position,
        "total_authors_claimed": claim.total_authors,
        "attached_references": refs,
        "similar_claims": [_describe(m) for m in matches[:5]],
    }
    return [
        harness.DataBlock("claim form, as the claimant typed it", json.dumps(record, ensure_ascii=False, indent=1)),
        harness.DataBlock("file text", _file_section(files)),
    ]


def _known(base: dict[str, dict]) -> harness.DataBlock:
    """What the college's own tables already say. Data too: the details quote the claim's fields."""
    known = {k: {"status": v["status"], "detail": v["detail"]} for k, v in base.items()}
    return harness.DataBlock(
        "facts from the college's own records, already worked out and not to be contradicted",
        json.dumps(known, ensure_ascii=False),
    )


def _file_section(files: list[FileRead]) -> str:
    """The files, cut to the title page and reference list, with page markers."""
    parts: list[str] = []
    for f in files:
        if f.kind != AttachmentKind.PUBLISHED_PAPER:
            continue
        if f.state != "ok":
            parts.append(f'[file "{f.name}": {f.note or "no text"}]')
            continue
        marked = "\n".join(f"[page {n}]\n{t.strip()}" for n, t in f.pages)
        head = marked[:PAPER_HEAD_CHARS]
        tail = ""
        heading = list(re.finditer(r"^\s*(references|bibliography|literature cited)\s*$", marked, re.I | re.M))
        start = heading[-1].start() if heading else max(len(marked) - PAPER_REFS_CHARS, len(head))
        if start >= len(head):
            tail = marked[start : start + PAPER_REFS_CHARS]
        cut = " [text between the first pages and the reference list is not shown]" if tail else ""
        parts.append(f'[file "{f.name}" (published paper)]\n{head}{cut}\n{tail}'.rstrip())
    shown = 0
    for f in files:
        if f.kind != AttachmentKind.SEC_REFERENCE or shown >= REF_FILES_SHOWN or f.state != "ok":
            continue
        shown += 1
        marked = "\n".join(f"[page {n}]\n{t.strip()}" for n, t in f.pages)
        parts.append(f'[file "{f.name}" (cited reference {(f.attachment.ref_number or "unnumbered")})]\n{marked[:REF_FILE_CHARS]}')
    return "\n\n".join(parts)


#: Codes that mean "an answer came back and was not usable", which this page has
#: always called unparsable; the harness distinguishes a wrong shape (`invalid`).
_UNREADABLE = ("unparsable", "empty", "invalid")


def _ask(claim: Claim, files: list[FileRead], base: dict, matches: list[dict], user: User) -> tuple[Any, int]:
    """The one call to a model for a check, through the harness. Raises `ai.AIError`.

    Returns the validated answer and the characters sent (for the audit's
    estimate). A failure of any kind is raised as the `AIError` this module's
    callers already handle.
    """
    blocks = [_known(base), *_blocks(claim, files, matches)]
    result = PRECHECK.run(
        user=user, data_blocks=blocks,
        system_extra=f"College: {institution.get('college_name')}.",
    )
    return result.unwrap(), sum(len(str(b.text)) for b in blocks)


def parse_answer(raw: Any, files: list[FileRead]) -> dict[str, dict[str, Any]]:
    """The model's answer, reduced to the shape we asked for and nothing else.

    Anything else it said -- extra keys, a key we did not ask for, a status
    outside the four -- is dropped here, so no later code sees it. Quotes are
    kept only when `_locate` finds them in the files.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        raise ValueError("no items")
    out: dict[str, dict[str, Any]] = {}
    for row in raw["items"]:
        if not isinstance(row, dict) or row.get("key") not in KEYS or row["key"] in out:
            continue
        status = str(row.get("status") or "").lower()
        note: dict[str, Any] = {
            "status": status if status in (*STATUSES, "unsure") else "unsure",
            "note": _clip(row.get("note"), NOTE_CHARS),
            "quote": None,
            "page": None,
            "file": None,
        }
        quote = _clip(row.get("quote"), QUOTE_CHARS)
        if quote:
            where = _locate(quote, files)
            if where:
                note.update(quote=quote, page=where["page"], file=where["file"])
            else:
                note["quote_unverified"] = True
        if row["key"] == "author_position":
            names = row.get("printed_authors")
            note["printed_authors"] = [_clip(n, 80) for n in names[:40]] if isinstance(names, list) else []
            pos = row.get("claimant_position")
            note["claimant_position"] = pos if isinstance(pos, int) and not isinstance(pos, bool) and 1 <= pos <= 500 else None
        if row["key"] == "sec_references":
            refs = []
            for r in (row.get("references") or [])[:12] if isinstance(row.get("references"), list) else []:
                if isinstance(r, dict):
                    entry = {
                        "attached_number": _clip(r.get("attached_number"), 16),
                        "entry_number": _clip(r.get("entry_number"), 16),
                        "quote": None,
                    }
                    q = _clip(r.get("quote"), QUOTE_CHARS)
                    where = _locate(q, files) if q else None
                    if where:
                        entry.update(quote=q, page=where["page"], file=where["file"])
                    refs.append(entry)
            note["references"] = refs
        if row["key"] == "watch_list":
            sigs = []
            for s in (row.get("signals") or [])[:5] if isinstance(row.get("signals"), list) else []:
                if isinstance(s, dict):
                    q = _clip(s.get("quote"), QUOTE_CHARS)
                    where = _locate(q, files) if q else None
                    if where:
                        sigs.append({"quote": q, "note": _clip(s.get("note"), NOTE_CHARS), "page": where["page"], "file": where["file"]})
            note["signals"] = sigs
        out[row["key"]] = note
    if not out:
        raise ValueError("no usable items")
    return out


def _raise(item: dict[str, Any], to: str, why: str) -> None:
    """Lower a pass to a warning. The only change a model reading can make to a status."""
    if item["status"] == "pass" and to in ("warn", "fail"):
        item["status"] = "warn"
        item["detail"] = f"{item['detail']} {why}".strip()


def _norm_number(value: Any) -> str:
    return re.sub(r"[^0-9a-z]", "", str(value or "").lower())


def _add_evidence(item: dict[str, Any], evidence: dict[str, Any]) -> None:
    """Add a quotation unless the same line on the same page is already shown."""
    seen = {(_norm(e["quote"]), e.get("page")) for e in item["evidence"]}
    if (_norm(evidence["quote"]), evidence.get("page")) not in seen:
        item["evidence"].append(evidence)


def merge(base: dict[str, dict[str, Any]], notes: dict[str, dict[str, Any]] | None, claim: Claim) -> list[dict[str, Any]]:
    """Baselines plus what the model read. One-way: see the module docstring."""
    items: list[dict[str, Any]] = []
    for key in KEYS:
        item = json.loads(json.dumps(base[key]))
        note = (notes or {}).get(key)
        if note is not None:
            ai_view: dict[str, Any] = {"status": note["status"], "note": note["note"], "raised": False}
            if note.get("quote"):
                _add_evidence(item, {"quote": note["quote"], "page": note["page"], "file": note["file"], "by": "ai"})
            elif note.get("quote_unverified"):
                ai_view["quote_unverified"] = True
            supported = bool(note.get("quote"))
            before = item["status"]

            if key == "author_position":
                pos = note.get("claimant_position")
                mine = claim.author_position
                if pos and mine and pos != mine and supported:
                    _raise(item, "warn", f"The AI reads the printed author list as putting {_owner(claim)} at position {pos}.")
            elif key == "sec_references":
                attached = {_norm_number(a.ref_number): a for a in claim.attachments.all()
                            if a.kind == AttachmentKind.SEC_REFERENCE and (a.ref_number or "").strip()}
                for r in note.get("references", []):
                    if r.get("quote"):
                        _add_evidence(item, {"quote": r["quote"], "page": r["page"], "file": r["file"], "by": "ai", "ref_number": r["attached_number"] or None})
                        if _norm_number(r["attached_number"]) in attached and _norm_number(r["entry_number"]) != _norm_number(r["attached_number"]):
                            _raise(item, "warn", f"The AI found reference {r['attached_number']} listed as number {r['entry_number']} in the paper.")
            elif key == "watch_list":
                for s in note.get("signals", []):
                    _add_evidence(item, {"quote": s["quote"], "page": s["page"], "file": s["file"], "by": "ai", "note": s["note"]})
                if note.get("signals"):
                    _raise(item, "warn", "The AI found wording in the paper that is worth a look.")
            elif note["status"] in ("warn", "fail") and supported and key in ("affiliation", "journal"):
                _raise(item, "warn", note["note"] or "The AI read the paper differently.")
            ai_view["raised"] = before == "pass" and item["status"] != "pass"
            item["ai"] = ai_view
        items.append(item)
    return items


# ---------------------------------------------------------------------------
# Running it
# ---------------------------------------------------------------------------


def _unavailable(health: dict[str, Any]) -> PrecheckError:
    """"Off" is a college that has not set AI up; anything else is a service that is not answering."""
    if health.get("code") in ("not_configured", "misconfigured"):
        return PrecheckError(503, "AI is off for this college.", code="off")
    return PrecheckError(503, "AI is not answering right now. Try again in a few minutes.", code=str(health.get("code") or "down"))


def _tokens(chars: int) -> int:
    return max(1, round(chars / 4))


def used_today(user: User) -> int:
    since = timezone.now() - timedelta(hours=24)
    return AuditLog.objects.filter(
        actor=user, action__in=[AUDIT_RUN, AUDIT_DRAFT], created_at__gte=since
    ).count()


def daily_limit() -> int:
    return int(getattr(settings, "AI_PRECHECK_DAILY_LIMIT", 40))


def _audit(user: User, claim: Claim, action: str, **detail: Any) -> None:
    AuditLog.objects.create(
        actor=user, action=action, entity="Claim", entity_id=claim.id,
        detail_json=json.dumps({"feature": FEATURE, **detail}),
    )


def status(claim: Claim, user: User) -> dict[str, Any]:
    """What a reviewer opening the claim is told. Reads the cache; asks no model."""
    health = ai.health()
    out: dict[str, Any] = {
        "available": bool(health.get("ready")),
        "code": health.get("code"),
        "model": health.get("model") or "",
        "host": health.get("host") or "",
        "hosted": bool(health.get("hosted")),
        "usage": {"used": used_today(user), "limit": daily_limit()},
        "current": None,
        "changed": False,
    }
    if not out["available"]:
        return out
    row = AIPrecheck.objects.filter(claim=claim, input_hash=input_hash(claim)).first()
    if row:
        out["current"] = _present(row)
    else:
        out["changed"] = AIPrecheck.objects.filter(claim=claim).exists()
    return out


def _present(row: AIPrecheck) -> dict[str, Any]:
    try:
        result = json.loads(row.result_json)
    except ValueError:
        result = {}
    return {"id": row.id, "created_at": row.created_at.isoformat(), **result}


def run(claim: Claim, user: User, *, force: bool = False) -> dict[str, Any]:
    """The checklist for this claim as it stands, from the cache or one model call."""
    health = ai.health()
    if not health.get("ready"):
        raise _unavailable(health)
    key = input_hash(claim)
    cached = AIPrecheck.objects.filter(claim=claim, input_hash=key).first()
    if cached and not force:
        _audit(user, claim, AUDIT_CACHED, cached=True, precheck_id=cached.id, model=cached.model, host=cached.host)
        return _present(cached)
    if used_today(user) >= daily_limit():
        raise PrecheckError(
            429,
            f"You have used today's {daily_limit()} AI checks. Results already made still open.",
            code="limit",
        )

    files = read_files(claim)
    matches = _similar_claims(claim)
    base = deterministic(claim, files, matches)
    model = health.get("model") or ai.model_name()
    host = health.get("host") or ""
    sent_chars = 0

    notes: dict[str, dict[str, Any]] | None = None
    summary = None
    problem: str | None = None
    code = None
    out_chars = 0
    try:
        raw, sent_chars = _ask(claim, files, base, matches, user)
        out_chars = len(json.dumps(raw, default=str))
        notes = parse_answer(raw, files)
        summary = _clip(raw.get("summary"), 400) or None
    except ai.AIError as exc:
        code = "unparsable" if exc.code in _UNREADABLE else exc.code
        problem = (
            "The AI's answer could not be read, so only the record checks are shown."
            if exc.code in _UNREADABLE
            else str(exc)
        )
    except ValueError:
        code = "unparsable"
        problem = "The AI's answer could not be read, so only the record checks are shown."

    tokens_in, tokens_out = _tokens(sent_chars), _tokens(out_chars) if out_chars else 0
    _audit(
        user, claim, AUDIT_RUN, cached=False, ok=problem is None, error_code=code, model=model, host=host,
        tokens_in=tokens_in, tokens_out=tokens_out, tokens_estimated=True,
    )
    result = {
        "items": merge(base, notes, claim),
        "summary": summary,
        "ai_ok": problem is None,
        "ai_error": problem,
        "files": [f.public() for f in files],
        "model": model,
        "host": host,
        "hosted": bool(health.get("hosted")),
        "tokens": {"in": tokens_in, "out": tokens_out, "estimated": True},
    }
    if problem is not None:
        # Not stored: the record checks are honest and free to repeat, and a
        # stored failure would stop the next "Check again" being a real try.
        return {"id": None, "created_at": timezone.now().isoformat(), **result}
    row, _ = AIPrecheck.objects.update_or_create(
        claim=claim, input_hash=key,
        defaults={
            "result_json": json.dumps(result), "model": model, "host": host,
            "hosted": result["hosted"], "tokens_in": tokens_in, "tokens_out": tokens_out,
            "created_by": user, "created_at": timezone.now(),
        },
    )
    return _present(row)


# ---------------------------------------------------------------------------
# The send-back reason
# ---------------------------------------------------------------------------


def _template_reason(claim: Claim, items: list[dict[str, Any]]) -> str:
    lines = [f"{i}. {it['detail']}" for i, it in enumerate(items, start=1)]
    return "Please check and correct the following before this claim is filed again:\n" + "\n".join(lines)


def draft_reason(claim: Claim, user: User) -> dict[str, Any]:
    """A polite reason from the failed items, to edit. Never sent anywhere by itself."""
    health = ai.health()
    if not health.get("ready"):
        raise _unavailable(health)
    row = AIPrecheck.objects.filter(claim=claim, input_hash=input_hash(claim)).first()
    if row is None:
        raise PrecheckError(409, "Check the claim with AI first, then draft the reason.", code="no_check")
    items = _present(row)["items"]
    chosen = [i for i in items if i["status"] == "fail"] or [i for i in items if i["status"] == "warn"]
    if not chosen:
        raise PrecheckError(400, "Nothing failed, so there is nothing to send back.", code="nothing")
    if used_today(user) >= daily_limit():
        raise PrecheckError(429, f"You have used today's {daily_limit()} AI checks.", code="limit")

    facts = [
        {"item": i["label"], "problem": i["detail"], "quote": next((e["quote"] for e in i["evidence"] if e.get("quote")), None)}
        for i in chosen
    ]
    tone = (
        "These are points to confirm rather than errors, so word them as questions or requests."
        if chosen[0]["status"] == "warn" else ""
    )
    blocks = [
        harness.DataBlock("the claimant's name", _owner(claim), 120),
        harness.DataBlock("the problems found, some quoted from an uploaded file", json.dumps(facts, ensure_ascii=False, indent=1)),
    ]
    prompt_chars = sum(len(str(b.text)) for b in blocks)
    source, reason, code = "ai", "", None
    chars = 0
    try:
        raw = DRAFT.run(user=user, data_blocks=blocks, system_extra=f"Address the reason to the claimant named in the data. {tone}".strip()).unwrap()
        reason = _clip_block(raw.get("reason") if isinstance(raw, dict) else "", 1200)
        chars = len(reason)
        if len(reason) < 20:
            raise ValueError("too short")
    except (ai.AIError, ValueError) as exc:
        code = "unparsable" if getattr(exc, "code", "unparsable") in _UNREADABLE else getattr(exc, "code", "unparsable")
        source, reason = "template", _template_reason(claim, chosen)
    _audit(
        user, claim, AUDIT_DRAFT, cached=False, ok=source == "ai", error_code=code,
        model=health.get("fast_model") or ai.model_name(fast=True), host=health.get("host") or "",
        tokens_in=_tokens(prompt_chars), tokens_out=_tokens(chars) if chars else 0, tokens_estimated=True,
    )
    return {
        "reason": reason,
        "source": source,
        "keys": [i["key"] for i in chosen],
        "model": health.get("fast_model") or ai.model_name(fast=True),
        "host": health.get("host") or "",
        "hosted": bool(health.get("hosted")),
    }


def _clip_block(text: Any, limit: int) -> str:
    """Like `_clip` but keeps the line breaks of a numbered list."""
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(text or "")).strip()
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def feedback(claim: Claim, user: User, *, target_id: str, rating: int, comment: str = "", feature: str = FEATURE) -> None:
    if feature not in (FEATURE, "send_back_draft"):
        raise PrecheckError(400, "Unknown AI feature.", code="feature")
    if rating not in (-1, 1):
        raise PrecheckError(400, "Rating is 1 for helpful or -1 for not helpful.", code="rating")
    if not AIPrecheck.objects.filter(pk=target_id, claim=claim).exists():
        raise PrecheckError(404, "That AI answer is not on this claim.", code="missing")
    AIFeedback.objects.update_or_create(
        user=user, feature=feature, target_id=target_id[:64],
        defaults={"claim": claim, "rating": rating, "comment": _clip(comment, 500)},
    )
    _audit(user, claim, AUDIT_FEEDBACK, feedback_on=feature, target_id=target_id[:64], rating=rating)


__all__ = ["PrecheckError", "draft_reason", "feedback", "run", "status"]
