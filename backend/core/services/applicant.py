"""What a claimant needs to know before and after filing, in the claimant's words.

Two things live here, both read-only and both safe to show a faculty member:

* `payout_outlook` -- when the next payment run is, from the college's own
  pattern (the months it has actually paid in, and the filing cutoff when the
  payout policy sets one). Nothing about which desk holds a claim.
* `precheck` -- what a reviewer will look for in a claim's files, run before
  it is sent: the affiliation line in the PDF text, the SEC references
  numbered, the author position. **Warnings only.** It never ticks one of the
  three filing conditions, never blocks a filing and never writes anything;
  the claimant still ticks every box themselves. A heuristic on a PDF's text
  is a reason to look again, not a verdict, which is why every finding says
  what to do about it.
"""
from __future__ import annotations

import json
import re
from datetime import date

from django.core.files.storage import default_storage
from django.utils import timezone

from core.models import AttachmentKind, Claim, FormulaConfig, PaidLedger
from core.services import content_check, institution
from core.services.author_names import name_score

MONTHS = (
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
)


def month_name(d: date) -> str:
    return f"{MONTHS[d.month - 1]} {d.year}"


def _first_of(d: date) -> date:
    return d.replace(day=1)


def _add_month(d: date) -> date:
    return date(d.year + (d.month == 12), d.month % 12 + 1, 1)


def _ordinal(n: int) -> str:
    if 10 <= n % 100 <= 20:
        return f"{n}th"
    suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def payout_outlook(today: date | None = None) -> dict:
    """The college's payout rhythm and the month the next run is expected.

    The pattern is read from what was actually paid: the distinct months with
    a payment in the twelve months up to now. Nine or more of twelve is a
    monthly run; fewer than three is no pattern at all, and then the answer
    says so rather than inventing a date.
    """
    today = today or timezone.localdate()
    this_month = _first_of(today)
    year_ago = date(this_month.year - 1, this_month.month, 1)

    paid = PaidLedger.objects.filter(amount__gt=0, payout_month__lte=today)
    months = sorted({
        _first_of(m)
        for m in paid.filter(payout_month__gte=year_ago).values_list("payout_month", flat=True)
    })
    newest = paid.order_by("-payout_month").values_list("payout_month", flat=True).first()
    last_run = _first_of(newest) if newest else None

    cfg = FormulaConfig.objects.filter(active=True).order_by("-version", "-updated_at").first()
    cutoff = cfg.filing_cutoff_day if cfg else None

    if len(months) >= 9:
        pattern = "monthly"
    elif len(months) >= 3:
        pattern = "most_months"
    else:
        pattern = "none"

    next_run = None
    if pattern != "none" and last_run is not None:
        next_run = this_month if last_run < this_month else _add_month(this_month)

    college = institution.get("college_name")
    if pattern == "none" or next_run is None:
        sentence = (
            "There is no regular payment month on record yet. "
            "The research office can tell you when the next run is."
        )
    else:
        head = "The college pays in a monthly run" if pattern == "monthly" else (
            "The college pays in most months"
        )
        if last_run < this_month:
            tail = f" The last run was {month_name(last_run)}, and {month_name(next_run)}'s is still to come."
        else:
            tail = f" The last run was {month_name(last_run)}, so the next is expected in {month_name(next_run)}."
        sentence = f"{head}.{tail}"
    if cutoff:
        sentence += f" Filing for a month's run closes on the {_ordinal(cutoff)}."

    return {
        "pattern": pattern,
        "months_paid_last_year": len(months),
        "last_run": last_run.strftime("%Y-%m") if last_run else None,
        "next_run": next_run.strftime("%Y-%m") if next_run else None,
        "next_run_label": month_name(next_run) if next_run else None,
        "filing_cutoff_day": cutoff,
        "college_name": college,
        "sentence": sentence,
    }


# ---- the pre-submit check ----------------------------------------------------


def _finding(key: str, status: str, title: str, detail: str, **extra) -> dict:
    return {"key": key, "status": status, "title": title, "detail": detail, **extra}


def _read(attachment) -> tuple[str | None, str | None]:
    """(text, why not). The PDF's text, or the plain reason it could not be read."""
    name = content_check.storage_name(attachment.url)
    if not name:
        return None, "It is not a PDF, so its text cannot be searched."
    try:
        with default_storage.open(name, "rb") as fh:
            data = fh.read()
    except Exception:  # noqa: BLE001 - storage backends raise their own kinds
        return None, "The file could not be opened just now."
    try:
        text, _pages = content_check.extract_text(data)
    except ValueError:
        return None, "The PDF could not be opened. It may be damaged or password-protected."
    if len(re.sub(r"\s+", "", text)) < content_check.MIN_TEXT_CHARS:
        return None, "It looks like a scan with no text layer, so it cannot be searched."
    return text, None


def _has_college(text: str, college_name: str) -> bool:
    words = content_check._words(text)
    return any(f" {w} " in words for w in content_check.affiliation_words(college_name))


def _display(attachment) -> str:
    return attachment.filename or "the file"


def _authors(claim: Claim) -> list[str]:
    try:
        value = json.loads(claim.authors_json or "[]")
    except ValueError:
        return []
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for a in value:
        if isinstance(a, str):
            out.append(a)
        elif isinstance(a, dict) and isinstance(a.get("name"), str):
            out.append(a["name"])
    return out


def position_finding(claim: Claim) -> dict:
    from core.api.deps import record_authorship

    mine = claim.author_position
    total = claim.total_authors
    said = f"You entered author {mine} of {total}."
    rec = record_authorship(claim)
    if rec["record_author_position"] is not None:
        if rec["record_author_position"] != mine:
            return _finding(
                "author_position", "warn", "Your author position may not match",
                f"{said} The paper's record puts you at position {rec['record_author_position']}"
                + (f" of {rec['record_total_authors']}" if rec["record_total_authors"] else "")
                + ". Open the published paper, count your name in the author list, and correct the "
                "position if the record is right.",
            )
        if rec["record_total_authors"] and rec["record_total_authors"] != total:
            return _finding(
                "author_position", "warn", "The number of authors may not match",
                f"{said} The paper's record lists {rec['record_total_authors']} authors. "
                "Count the authors on the first page and correct the total if needed.",
            )
        return _finding("author_position", "ok", "Your author position matches the record", said)

    names = _authors(claim)
    if names and claim.owner_id:
        scores = [name_score(claim.owner.name, n) for n in names]
        best = max(scores)
        if best >= 0.7:
            at = scores.index(best) + 1
            if at != mine:
                return _finding(
                    "author_position", "warn", "Your author position may not match",
                    f"{said} In the author list saved with this claim, your name is at position {at}. "
                    "Check the published paper and correct whichever is wrong.",
                )
            if len(names) != total:
                return _finding(
                    "author_position", "warn", "The number of authors may not match",
                    f"{said} The author list saved with this claim has {len(names)} names. "
                    "Count the authors on the first page and correct the total if needed.",
                )
            return _finding(
                "author_position", "ok", "Your author position matches the author list", said
            )
    return _finding(
        "author_position", "unknown", "Check your author position yourself",
        f"{said} There is no author list on record to compare it with. "
        "The reviewer counts your name in the published paper's author list.",
    )


def precheck(claim: Claim, min_references: int) -> dict:
    """What the reviewer will look for, judged now. Warnings only; writes nothing."""
    college = institution.get("college_name")
    attachments = list(claim.attachments.all())
    papers = [a for a in attachments if a.kind == AttachmentKind.PUBLISHED_PAPER]
    refs = [a for a in attachments if a.kind == AttachmentKind.SEC_REFERENCE]
    findings: list[dict] = []

    # 1. The affiliation line, in the text of the published paper.
    if not papers:
        findings.append(_finding(
            "affiliation", "warn", "The published paper is not attached yet",
            f"The reviewer searches the paper for “{college}”. Attach the full-text PDF first.",
        ))
    else:
        problems: list[str] = []
        unreadable: list[str] = []
        good = 0
        for a in papers:
            text, why = _read(a)
            if text is None:
                unreadable.append(f"{_display(a)}: {why}")
            elif _has_college(text, college):
                good += 1
            else:
                problems.append(_display(a))
        if problems:
            findings.append(_finding(
                "affiliation", "warn", f"“{college}” was not found in the paper's text",
                f"Not found in {', '.join(problems)}. The reviewer looks for the affiliation line under "
                "the authors' names. If your paper prints it differently (for example an abbreviation), "
                "add a note when you send it; if this is the wrong file, replace it.",
            ))
        elif unreadable:
            findings.append(_finding(
                "affiliation", "unknown", "The paper's text could not be searched",
                "; ".join(unreadable) + f" The reviewer will search it for “{college}” by eye, "
                "so a text PDF from the publisher is quicker for everyone.",
            ))
        else:
            findings.append(_finding(
                "affiliation", "ok", f"“{college}” appears in the paper",
                "The affiliation line is present in the PDF's text.",
            ))

    # 2. The SEC references, numbered.
    numbered = [a for a in refs if (a.ref_number or "").strip()]
    unnumbered = [a for a in refs if not (a.ref_number or "").strip()]
    numbers = [(a.ref_number or "").strip() for a in numbered]
    repeated = sorted({n for n in numbers if numbers.count(n) > 1})
    if len(refs) < min_references:
        findings.append(_finding(
            "sec_refs", "warn",
            f"{len(refs)} of {min_references} SEC references attached",
            f"The policy needs {min_references} cited references by {college} faculty, each with its "
            "number from your reference list. With fewer, the claim is recorded and paid nothing.",
        ))
    elif unnumbered:
        findings.append(_finding(
            "sec_refs", "warn", "Some references have no number",
            f"Add the number from your reference list to {', '.join(_display(a) for a in unnumbered)}. "
            "The reviewer matches each file to its number.",
        ))
    elif repeated:
        findings.append(_finding(
            "sec_refs", "warn", "Two references share a number",
            f"Number {', '.join(repeated)} is used more than once. Each reference has its own number "
            "in your reference list.",
        ))
    else:
        findings.append(_finding(
            "sec_refs", "ok", f"{len(refs)} SEC references, all numbered",
            f"References {', '.join(sorted(numbers, key=lambda n: (len(n), n)))}.",
        ))

    # 2b. The affiliation on the references themselves (they are there to prove it).
    if refs:
        missing: list[str] = []
        unread = 0
        for a in refs:
            text, _why = _read(a)
            if text is None:
                unread += 1
            elif not _has_college(text, college):
                missing.append(_display(a))
        if missing:
            findings.append(_finding(
                "reference_affiliation", "warn", "A reference may not show the college",
                f"“{college}” was not found in {', '.join(missing)}. Each reference is there to show a "
                "faculty member of the college among its authors. Check you attached the right page.",
            ))
        elif unread == 0:
            findings.append(_finding(
                "reference_affiliation", "ok", "Every reference shows the college",
                "The affiliation is present in each reference's text.",
            ))

    # 3. The author position.
    findings.append(position_finding(claim))

    warnings = sum(1 for f in findings if f["status"] == "warn")
    return {
        "warnings": warnings,
        "findings": findings,
        "note": (
            "This is a read of your files, not a decision. It never confirms the three conditions "
            "for you, and it does not stop you sending the claim."
        ),
    }
