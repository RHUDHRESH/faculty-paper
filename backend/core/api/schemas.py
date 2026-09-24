"""request and response schemas.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import _parse_payout_month

import re
from typing import Any, Optional
from django.conf import settings
from ninja import Schema
from ninja.errors import HttpError
from core.models import AttachmentKind, Claim, ClaimAttachment, ClaimReason, Role, Team, User
from core.services.normalize import normalize_title
from core.services.scopus import extract_author_id

# ---------- schemas ----------


class LoginIn(Schema):
    email: str
    password: str


class UserOut(Schema):
    id: str
    email: str
    name: str
    role: str
    department: Optional[str] = None
    employee_id: Optional[str] = None
    staff_id: Optional[str] = None
    biometric_id: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None
    must_change_password: bool = False
    active: bool = True
    portal: Optional[str] = None


class AttachmentIn(Schema):
    kind: str
    url: str
    filename: Optional[str] = None
    size_bytes: int = 0
    # SEC_REFERENCE only: which citation this file proves.
    ref_number: Optional[str] = None
    ref_title: Optional[str] = None
    #: Returned by /claims/upload; carried back so the file stays identifiable.
    content_hash: Optional[str] = None


class ClaimIn(Schema):
    owner_id: Optional[str] = None
    doi: Optional[str] = None
    issn: Optional[str] = None
    journal_title: Optional[str] = None
    paper_title: Optional[str] = None
    publication_year: Optional[int] = None
    publication_date: Optional[str] = None
    publication_type: Optional[str] = None
    indexing_level: Optional[str] = None
    indexing_ref: Optional[str] = None
    au_annexure_ref: Optional[str] = None
    ugc_care_ref: Optional[str] = None
    yukthi_id: Optional[str] = None
    self_reported_quartile: Optional[str] = None
    impact_factor: Optional[str] = None
    proof_url: Optional[str] = None
    sec_refs: Optional[str] = None
    sec_proof_url: Optional[str] = None
    reference_articles: Optional[str] = None
    claim_reason: Optional[str] = None
    #: The team code on a student-project claim. Codes, not ids: the code is
    #: what is printed on the project sheet the claimant is reading from, and
    #: an id is a thing they would have to go and look up.
    team_code: Optional[str] = None
    # Handled by _bind_identity_from_user, not _FACULTY_WRITABLE
    scopus_author_url: Optional[str] = None
    designation: Optional[str] = None
    attachments: Optional[list[AttachmentIn]] = None
    is_student_publication: bool = False
    # Not defaulted true: a confirmation the claimant has to make themselves.
    affiliation_ok: bool = False
    payout_month: Optional[str] = None
    subject_category: Optional[str] = None
    subjects_json: Optional[str] = None
    snip: Optional[float] = None
    self_reported_snip: Optional[float] = None
    snip_year: Optional[int] = None
    quartile: Optional[str] = None
    manual_quartile_reason: Optional[str] = None
    total_authors: int = 1
    author_position: int = 1
    authors_json: Optional[str] = None
    year_mismatch: bool = False
    year_mismatch_override: bool = False
    year_mismatch_reason: Optional[str] = None
    eid: Optional[str] = None
    scopus_url: Optional[str] = None
    cover_date: Optional[str] = None
    aggregation_type: Optional[str] = None
    engineering_class: Optional[str] = None
    contest_forward: bool = False
    contest_note: Optional[str] = None
    submit: bool = False


# Fields faculty may set — verification / money / identity are server-owned.
# The money-determining columns (snip, quartile, engineering_class,
# aggregation_type) and the Scopus identity columns (eid, scopus_url,
# cover_date, subjects) are deliberately absent: they only ever come from
# verification or an admin's audited manual entry. Faculty declarations go to
# the self_reported_* columns instead.
_FACULTY_WRITABLE = {
    "doi",
    "issn",
    "journal_title",
    "paper_title",
    "publication_year",
    "publication_date",
    "publication_type",
    "indexing_level",
    "indexing_ref",
    "au_annexure_ref",
    "ugc_care_ref",
    "yukthi_id",
    "self_reported_quartile",
    "self_reported_snip",
    "impact_factor",
    "proof_url",
    "sec_refs",
    "sec_proof_url",
    "reference_articles",
    "claim_reason",
    "is_student_publication",
    "affiliation_ok",
    # "payout_month" is deliberately absent. It decides which month's ledger
    # and which financial year's budget a payment lands in, and a claimant who
    # set it to 2019-04 produced a real payment that the current year's budget
    # report could not see and the monthly run never listed. The office sets it
    # when the payment is prepared.
    "manual_quartile_reason",
    "total_authors",
    "author_position",
    "authors_json",
    "year_mismatch",
    "year_mismatch_override",
    "year_mismatch_reason",
    # Descriptive only — it names the journal's subject area and feeds no part
    # of the payout. It was accepted by the schema but dropped here, so the
    # form saved a value that could never come back and the detail view showed
    # a permanent "—".
    "subject_category",
}

# Legacy form keys that used to write the verified columns directly. They are
# accepted for wizard compatibility but land in self_reported_*.
_SELF_REPORT_ALIASES = {"snip": "self_reported_snip", "quartile": "self_reported_quartile"}


def _apply_faculty_payload(claim: Claim, payload: ClaimIn) -> None:
    data = payload.dict(exclude={"submit", "contest_forward", "contest_note", "owner_id"}, exclude_unset=True)
    for k, v in data.items():
        k = _SELF_REPORT_ALIASES.get(k, k)
        if k not in _FACULTY_WRITABLE:
            continue
        if k == "payout_month":
            claim.payout_month = _parse_payout_month(v)
        elif k == "total_authors":
            # Not clamped to the eligibility ceiling: a paper really can have
            # more than nine authors, and the calculation says so plainly
            # instead of the form quietly rewriting the author list.
            claim.total_authors = max(1, min(int(v or 1), 200))
        elif k == "author_position":
            claim.author_position = max(1, min(int(v or 1), 200))
        elif k == "self_reported_snip" and v is not None:
            claim.self_reported_snip = float(v)
        elif k == "claim_reason":
            claim.claim_reason = v if v in ClaimReason.values else ClaimReason.INCENTIVE
        elif hasattr(claim, k):
            setattr(claim, k, v)
    # The ERP sheets read one combined indexing_ref column, so keep it derived
    # from the two registers rather than asking for the same numbers twice.
    parts = [
        f"{label} {value.strip()}"
        for label, value in (
            ("AU Annexure", claim.au_annexure_ref or ""),
            ("UGC Care", claim.ugc_care_ref or ""),
        )
        if value.strip()
    ]
    if parts:
        claim.indexing_ref = "; ".join(parts)[:255]

    # Count-only filings carry no money, but they are still the institution's
    # record of the publication. Blanking SNIP to force a zero payout also threw
    # away a real fact about the journal, so the count kept the paper and lost
    # its metrics. `is_student_publication` is what stops the payment -- the
    # engine returns zero on that alone -- so the declared figures can stay.
    # ...and it has to flip back. Setting the flag on the way in but never
    # clearing it meant a claim switched back to an incentive claim stayed
    # marked as a student publication and went on paying nothing, with nothing
    # on screen to explain why.
    claim.is_student_publication = claim.claim_reason == ClaimReason.COUNT_ONLY

    # The team, on the claims that have one. Note this deliberately does not
    # touch `is_student_publication`: that flag makes the engine return zero,
    # and a student-project conference paper is *paid* -- it prices as
    # Category III like any other conference proceeding. Wiring the two
    # together on the strength of both having "student" in the name would pay
    # every one of these nothing.
    if "team_code" in data:
        code = (payload.team_code or "").strip()
        if not code:
            claim.team = None
        else:
            team = Team.objects.filter(code__iexact=code).first()
            if team is None:
                raise HttpError(
                    404,
                    f"No team with the code {code!r}. Create the team first, "
                    "with the students on it.",
                )
            claim.team = team
    # A claim that stops being a student project stops carrying a team, for
    # the same reason `is_student_publication` has to flip back: a stale one
    # would show a roster of students on a paper that is no longer theirs.
    if claim.claim_reason != ClaimReason.STUDENT_PROJECT:
        claim.team = None
    claim.normalized_title = normalize_title(claim.paper_title)[:512]
    # Never trust client override flags. (scimago_verified no longer needs a
    # reset here: quartile itself is not faculty-writable, and wiping the flag
    # on an attachments-only PATCH used to orphan a verified quartile.)
    claim.override_duplicate = False
    claim.override_reason = None


# Evidence caps. A claim can legitimately cite many SEC-affiliated references,
# and the published article sometimes arrives split across files or with
# supplementary material — so these are abuse ceilings, not editorial limits.
ATTACHMENT_LIMITS = {
    AttachmentKind.PUBLISHED_PAPER: 10,
    AttachmentKind.SEC_REFERENCE: 50,
}

#: An attachment URL may only be one this server minted in upload_claim_file:
#: MEDIA_URL + "claims/" + uuid4().hex + a sniffed extension. A startswith check
#: on MEDIA_URL is not enough — "/media/../../../etc/passwd" satisfies it, and
#: the client decides this string, which then ends up in an href and an iframe.
_ATTACHMENT_NAME = re.compile(r"^claims/[0-9a-f]{32}\.[a-z0-9]{2,5}$")


def _is_own_media_url(url: str) -> bool:
    prefix = settings.MEDIA_URL
    if not url.startswith(prefix):
        return False
    return bool(_ATTACHMENT_NAME.match(url[len(prefix):]))


def _validated_attachments(payload: ClaimIn) -> list[dict[str, Any]] | None:
    """Check the attachment set before anything is written.

    Returns None when the client omitted the key entirely, meaning "leave the
    existing set alone". Validation is split from persistence so a cap violation
    cannot surface after the claim has already been ticketed and notified.
    """
    if payload.attachments is None:
        return None
    limits = ATTACHMENT_LIMITS
    kept: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    seen_urls: set[str] = set()
    for a in payload.attachments:
        if a.kind not in AttachmentKind.values:
            continue
        url = (a.url or "").strip()
        if not _is_own_media_url(url):
            continue
        # Uploading many files at once makes a repeated URL easy; the same PDF
        # listed twice would read to an approver as two separate references.
        if url in seen_urls:
            continue
        seen_urls.add(url)
        counts[a.kind] = counts.get(a.kind, 0) + 1
        if counts[a.kind] > limits[a.kind]:
            raise HttpError(400, f"At most {limits[a.kind]} file(s) allowed for {a.kind}")
        is_reference = a.kind == AttachmentKind.SEC_REFERENCE
        kept.append(
            {
                "kind": a.kind,
                "url": url,
                "filename": (a.filename or "")[:255] or None,
                "size_bytes": max(0, int(a.size_bytes or 0)),
                # Only a cited reference carries a citation identity.
                "ref_number": ((a.ref_number or "").strip()[:32] or None) if is_reference else None,
                "ref_title": ((a.ref_title or "").strip() or None) if is_reference else None,
                # Carried from the upload so the same file is recognisable on
                # the next claim, not just within this one.
                "content_hash": (a.content_hash or "").strip()[:64] or None,
            }
        )
    return kept


def _persist_attachments(claim: Claim, kept: list[dict[str, Any]] | None, actor: User) -> None:
    """Replace the claim's attachment set. The claim row must already exist."""
    if kept is None:
        return
    claim.attachments.all().delete()
    if kept:
        ClaimAttachment.objects.bulk_create(
            [ClaimAttachment(claim=claim, uploaded_by=actor, **k) for k in kept]
        )
    # Keep the legacy single-URL columns in step for older screens and exports
    paper = next((k for k in kept if k["kind"] == AttachmentKind.PUBLISHED_PAPER), None)
    refs = [k for k in kept if k["kind"] == AttachmentKind.SEC_REFERENCE]
    claim.proof_url = paper["url"] if paper else None
    claim.sec_proof_url = refs[0]["url"] if refs else None
    # sec_refs and reference_articles are what the ERP sheets and every existing
    # export read. Where the attachments carry citation data they are derived
    # from it, so the two can no longer disagree. Uploads that carry none — the
    # ERP importer, older clients — keep whatever the caller set.
    updates = {"proof_url": claim.proof_url, "sec_proof_url": claim.sec_proof_url}
    numbers = [k["ref_number"] for k in refs if k.get("ref_number")]
    titles = [k["ref_title"] for k in refs if k.get("ref_title")]
    if numbers:
        claim.sec_refs = ", ".join(numbers)
        updates["sec_refs"] = claim.sec_refs
    if titles:
        claim.reference_articles = "\n".join(titles)
        updates["reference_articles"] = claim.reference_articles
    Claim.objects.filter(pk=claim.pk).update(**updates)


def _bind_identity_from_user(claim: Claim, user: User, payload: ClaimIn | None = None) -> None:
    # Payment identity and department stay server-owned: a wrong biometric ID pays the
    # wrong person, and department decides which HoD approves the ticket.
    claim.staff_id = user.staff_id
    claim.biometric_id = user.biometric_id

    changed: list[str] = []

    # The Scopus author link is per-submission on the form; fall back to the profile.
    link = ((payload.scopus_author_url if payload else None) or "").strip() or user.scopus_author_url
    claim.scopus_author_url = link
    claim.scopus_author_id = extract_author_id(link or "") or user.scopus_author_id
    if link and link != user.scopus_author_url:
        user.scopus_author_url = link
        user.scopus_author_id = claim.scopus_author_id
        changed += ["scopus_author_url", "scopus_author_id"]

    designation = ((payload.designation if payload else None) or "").strip()
    claim.designation = designation or user.designation
    if designation and designation != user.designation:
        user.designation = designation
        changed.append("designation")

    if changed:
        user.save(update_fields=[*changed, "updated_at"])


class ActionIn(Schema):
    note: Optional[str] = None
    voucher_number: Optional[str] = None
    #: The amount the actor saw when they confirmed. Money moves only when the
    #: recomputed amount still matches it.
    expected_amount: Optional[float] = None
    #: Super-admin escape hatch for a Scopus outage. Same ACL as /recalculate.
    skip_external: bool = False


class RecalcIn(Schema):
    #: Super-admin escape hatch for a Scopus outage: recompute from the stored
    #: verified values without calling out. Audited.
    skip_external: bool = False


class OverrideStatusIn(Schema):
    to_status: str
    note: str


class ManualVerifyIn(Schema):
    snip: Optional[float] = None
    quartile: Optional[str] = None
    engineering_class: Optional[str] = None
    #: Where the values came from — a citation the auditor can follow.
    note: str


class CalcIn(Schema):
    snip: Optional[float] = None
    quartile: Optional[str] = None
    total_authors: int = 1
    author_position: int = 1
    publication_type: Optional[str] = None
    is_student_publication: bool = False
    # Both decide the category and whether the quartile incentive applies, so
    # the preview needs them or it quietly estimates a different category.
    indexing_level: Optional[str] = None
    engineering_class: Optional[str] = None
    sec_reference_count: Optional[int] = None


class ResetPasswordByEmailIn(Schema):
    email: str
    password: str


class ScopusLookupIn(Schema):
    doi: Optional[str] = None
    title: Optional[str] = None
    issn: Optional[str] = None


class CandidateSearchIn(Schema):
    """Free-text "find my article" search — several matches, the user picks one."""

    title: Optional[str] = None
    doi: Optional[str] = None
    author_id: Optional[str] = None
    scopus_author_url: Optional[str] = None
    # Admin filing on behalf: whose already-filed claims to check against.
    owner_id: Optional[str] = None
    limit: int = 10


class ScimagoLookupIn(Schema):
    issn: Optional[str] = None
    title: Optional[str] = None
    year: Optional[int] = None
    subject: Optional[str] = None


class PriorCheckIn(Schema):
    doi: Optional[str] = None
    title: Optional[str] = None
    issn: Optional[str] = None
    staff_id: Optional[str] = None
    exclude_claim_id: Optional[str] = None


class VerifyIn(Schema):
    title: str
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None
    issn: Optional[str] = None
    staff_id: Optional[str] = None
    exclude_claim_id: Optional[str] = None


class UserCreateIn(Schema):
    email: str
    name: str
    #: Optional. Left out, the account is created with no usable password and
    #: has to be given one before it can be signed into with a password at
    #: all -- which is the sane default for creating somebody else's account:
    #: a password chosen for you and typed into a form has been seen by the
    #: person who typed it, and is usually still in their sent items.
    #:
    #: The account is not stranded by this. Whoever created it sets one with
    #: "Set a password" and hands it over, or the person signs in with the
    #: Google account the college gave them, which never consults this field.
    password: Optional[str] = None
    role: str = Role.FACULTY
    department: Optional[str] = None
    employee_id: Optional[str] = None
    staff_id: Optional[str] = None
    biometric_id: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None
    must_change_password: bool = True
    #: Creating a head for a department that already has one: demote the one
    #: in post to faculty in the same write. Without it the request is refused
    #: (409) and names them.
    replace_hod: bool = False


class UserUpdateIn(Schema):
    role: Optional[str] = None
    department: Optional[str] = None
    active: Optional[bool] = None
    name: Optional[str] = None
    staff_id: Optional[str] = None
    biometric_id: Optional[str] = None
    designation: Optional[str] = None
    scopus_author_url: Optional[str] = None
    scopus_author_id: Optional[str] = None
    #: Whether this post is expected to produce research, and how much before
    #: any incentive is due. Absent from this schema until now, which made the
    #: whole quota rule unreachable: it was implemented, tested, and settable
    #: only from a Django shell.
    faculty_type: Optional[str] = None
    research_quota: Optional[int] = None
    research_quota_note: Optional[str] = None
    #: Not a field of the account: the office's explicit "yes, replace the
    #: head in post" when this edit makes a second head of a department.
    replace_hod: Optional[bool] = None


class ResetPasswordIn(Schema):
    password: str


class ChangePasswordIn(Schema):
    current_password: str
    new_password: str


class BatchProcessIn(Schema):
    claim_ids: list[str]


class FormulaIn(Schema):
    snip_multiplier: float
    qf_q1: float
    qf_q2: float
    qf_q3: float
    qf_q4: float
    qf_no_snip: float = 0
    qf_snip_only: float = 0
    #: Retired — the policy's QFA table is Q1-Q4 only. The editor no longer
    #: sends it, and a 4,000 default here would have written the retired
    #: incentive straight back into every new policy version.
    qf_others: float = 0
    author_point_json: str
    notes: Optional[str] = None
    name: Optional[str] = "Policy"
    snip_cap: float = 30
    publication_type_multipliers_json: Optional[str] = None
    student_remuneration_zero: bool = True
    qf_only_for_no_snip: bool = True
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    high_value_threshold: float = 0
    # Category II-IV rates and the two eligibility limits. They were absent
    # from both the GET payload and the create() below, so every "save as new
    # version" quietly reset them to the model defaults — including the author
    # ceiling and the SEC-reference minimum, which decide whether a claim pays
    # anything at all.
    fixed_journal_no_snip: float = 5000
    fixed_other_no_snip: float = 4000
    fixed_web_of_science: float = 5000
    max_authors: int = 9
    min_sec_references: int = 2
    #: Day of the month filing closes for that month's run, 1-28, or null for
    #: none. Left out of a request, the previous version's value is kept.
    filing_cutoff_day: Optional[int] = None


class MonthlyCreateIn(Schema):
    name: str
    rows: list[dict[str, Any]]




__all__ = [
    'ATTACHMENT_LIMITS',
    'ActionIn',
    'AttachmentIn',
    'BatchProcessIn',
    'CalcIn',
    'CandidateSearchIn',
    'ChangePasswordIn',
    'ClaimIn',
    'FormulaIn',
    'LoginIn',
    'ManualVerifyIn',
    'MonthlyCreateIn',
    'OverrideStatusIn',
    'PriorCheckIn',
    'RecalcIn',
    'ResetPasswordByEmailIn',
    'ResetPasswordIn',
    'ScimagoLookupIn',
    'ScopusLookupIn',
    'UserCreateIn',
    'UserOut',
    'UserUpdateIn',
    'VerifyIn',
    '_ATTACHMENT_NAME',
    '_FACULTY_WRITABLE',
    '_SELF_REPORT_ALIASES',
    '_apply_faculty_payload',
    '_bind_identity_from_user',
    '_is_own_media_url',
    '_persist_attachments',
    '_validated_attachments',
]
