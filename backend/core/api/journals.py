"""journals, and the retired chain kept for old clients.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import (
    _apply_calc,
    _notify_admins,
    _notify_director,
    _notify_principal,
    _verification_issues,
    api,
    logger,
    session_auth,
)
from core.api.schemas import ActionIn, ClaimIn, RecalcIn, _apply_faculty_payload, _bind_identity_from_user, _persist_attachments, _validated_attachments
from core.api.deps import claim_to_dict
from core.api.common import require_user
from core.api.teams import _min_sec_references, _numbered_sec_references
from core.api.claims import _assign_quota_position, _claims_queryset, _refuse_hod_unless_own

import json
import re
import time
from datetime import timedelta
from typing import Any, Optional
from django.db import transaction
from django.db.models import Min, Q, Sum
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core.models import AttachmentKind, AuditLog, Claim, ClaimAction, ClaimReason, ClaimStatus, FormulaConfig, Notification, Role, ScimagoJournal, SnipSource, User
from core.services import achievements, rbac
from core.services.normalize import normalize_issn
from core.services.notify_email import send_optional_email
from core.services.tickets import assign_ticket_number
from core import hod, visibility
from core.services.verify import apply_verify_to_claim, check_already_paid, verify_publication

# ---------- journals ----------


def _issn_variants(issn: str | None) -> list[str]:
    """Every spelling of one ISSN that the stored data actually uses.

    Three conventions ended up in the tables, all of the same number: dashed
    ("0272-8842"), bare ("02728842"), and float-mangled ("2728842.0") from
    9,993 reference rows a spreadsheet had opened. Matching only one of them
    is why a journal with an ISSN on file still fell back to a title search.
    """
    if not issn:
        return []
    cleaned = normalize_issn(issn) or ""
    bare = cleaned.replace("-", "")
    out = {cleaned, bare, issn.strip()}
    if bare.isdigit():
        out.add(f"{int(bare)}.0")  # the leading zero the float dropped
        out.add(str(int(bare)))
    return [v for v in out if v]


def _flatten_title(title: str) -> str:
    """A journal title with everything but its letters and digits removed."""
    return re.sub(r"[^a-z0-9]+", " ", (title or "").lower()).strip()


def _match_on_punctuation(qs, title: str):
    """The same journal, spelled without its punctuation.

    The ERP dropped colons, commas and brackets out of journal titles on the
    way in, so "Journal of Materials Science: Materials in Electronics" is
    stored as "Journal of Materials Science Materials in Electronics" and an
    exact match finds nothing. Sixty of the college's journals are in that
    position and every one of them was reported as unranked.

    Narrowed by the two longest words before anything is compared -- they are
    the most selective and they cannot themselves contain punctuation -- so
    this reads a few hundred rows rather than thirty-two thousand.
    """
    flat = _flatten_title(title)
    if not flat:
        return None
    words = sorted(set(flat.split()), key=len, reverse=True)
    probes = [w for w in words if len(w) > 3][:2]
    if not probes:
        return None
    candidates = qs
    for w in probes:
        candidates = candidates.filter(title__icontains=w)
    for row in candidates.order_by("-year")[:300]:
        if _flatten_title(row.title) == flat:
            return row
    return None


def _journal_reference(title: str, issn: str | None) -> dict[str, Any]:
    """What the reference data knows about this journal, if anything.

    Claims carry a title and usually nothing else, so the ISSN route is tried
    first and the title second. A near-match on a truncated title is worse
    than no match -- it would attach another journal's SJR to this one -- so
    the title lookup demands the whole name, case-insensitively.
    """
    out: dict[str, Any] = {"scimago": None, "snip": None}

    scimago_qs = ScimagoJournal.objects.all()
    row = None
    variants = _issn_variants(issn)
    if variants:
        row = (
            scimago_qs.filter(issn__in=variants).order_by("-year").first()
            or scimago_qs.filter(eissn__in=variants).order_by("-year").first()
        )
    if row is None and title:
        row = scimago_qs.filter(title__iexact=title).order_by("-year").first()
    if row is None and title:
        row = _match_on_punctuation(scimago_qs, title)
    if row is not None:
        try:
            categories = json.loads(row.categories_json or "[]")
        except (ValueError, TypeError):
            categories = []
        # Scimago nests the quartile inside each subject category, so a journal
        # is Q1 in one field and Q3 in another. Both are true; the best one is
        # what the policy pays on, and hiding the rest would misdescribe it.
        labels: list[dict[str, Any]] = []
        for c in categories if isinstance(categories, list) else []:
            if isinstance(c, dict):
                name = c.get("category") or c.get("name") or ""
                q = c.get("quartile") or c.get("Quartile") or ""
                if name:
                    labels.append({"category": str(name), "quartile": str(q or "—")})
        # SCImago's own id for the journal, which addresses its page directly.
        # Stored as "21522.0" because the dump was read as numbers, and a
        # search by title lands on a results page — or on nothing at all, for
        # a conference series whose name runs to fifteen words.
        source_id = (row.source_id or "").strip()
        if source_id.endswith(".0"):
            source_id = source_id[:-2]
        out["scimago"] = {
            "source_id": source_id or None,
            "sjr": row.sjr,
            "year": row.year,
            "issn": row.issn,
            "eissn": row.eissn,
            "verified_live": row.verified_live,
            "categories": labels[:12],
            "best_quartile": min(
                (c["quartile"] for c in labels if c["quartile"].startswith("Q")),
                default=None,
            ),
        }

    snip_row = None
    if variants:
        snip_row = (
            SnipSource.objects.filter(print_issn__in=variants).first()
            or SnipSource.objects.filter(e_issn__in=variants).first()
        )
    if snip_row is None and title:
        snip_row = SnipSource.objects.filter(title__iexact=title).first()
    if snip_row is not None:
        out["snip"] = {"snip": snip_row.snip, "sjr": snip_row.sjr, "year": snip_row.year}

    return out


@api.get("/claims/{claim_id}", auth=session_auth)
def get_claim(request: HttpRequest, claim_id: str):
    user = require_user(request)
    _refuse_hod_unless_own(user, claim_id)
    claim = get_object_or_404(_claims_queryset(user), pk=claim_id)
    actions = [
        {
            "id": a.id,
            "action": a.action,
            "from_status": a.from_status,
            "to_status": a.to_status,
            "note": a.note,
            "actor_id": a.actor_id,
            "actor_name": a.actor.name,
            "created_at": a.created_at.isoformat(),
        }
        for a in claim.actions.select_related("actor").order_by("created_at")
    ]
    data = claim_to_dict(claim)
    data["actions"] = actions
    return data


@api.post("/claims", auth=session_auth)
def create_claim(request: HttpRequest, payload: ClaimIn):
    user = require_user(request)
    owner = user
    admin_proxy = False

    if payload.owner_id:
        if not rbac.can_clear_claims(user.role):
            raise HttpError(403, "Only admin can submit on behalf of faculty")
        owner = get_object_or_404(
            User, pk=payload.owner_id, role__in=rbac.CLAIMANT_ROLES, active=True
        )
        admin_proxy = True
    elif not rbac.can_issue_claims(user.role):
        raise HttpError(403, "Only faculty can create tickets")
    elif rbac.can_clear_claims(user.role) and not payload.owner_id:
        raise HttpError(400, "Select a faculty member to submit on their behalf")

    # Validate before any write, so a rejected attachment set cannot leave a
    # half-created claim behind.
    attachments = _validated_attachments(payload)

    claim = Claim(owner=owner)
    _apply_faculty_payload(claim, payload)
    _bind_identity_from_user(claim, owner, payload)

    paid_check = check_already_paid(
        title=claim.paper_title,
        doi=claim.doi,
        staff_id=claim.staff_id,
        exclude_claim_id=None,
    )
    claim.duplicate_warning = bool(paid_check.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid_check.get("matches") or [])

    _apply_calc(claim, allow_self_reported=True)
    # Persist the claim and its files first: the submission gate reads the stored
    # attachments, so syncing afterwards made an attachments-only payload fail.
    claim.save()
    _persist_attachments(claim, attachments, user)

    if payload.submit:
        _submit_claim(claim, user, contest=bool(payload.contest_forward), contest_note=payload.contest_note)
    else:
        ClaimAction.objects.create(
            claim=claim,
            actor=user,
            from_status=None,
            to_status=claim.status,
            action="ADMIN_CREATE" if admin_proxy else "CREATE_DRAFT",
            note=f"submitted_by={user.email}" if admin_proxy else None,
        )
    return claim_to_dict(claim)


_ANNEXURE_LEVELS = {"AU Annexure", "UGC Care"}


def _check_mandatory_fields(claim: Claim) -> None:
    """Rules the claim form itself imposes, independent of Scopus verification."""
    missing: list[str] = []
    if not (claim.journal_title or "").strip():
        missing.append("Journal name")
    if not (claim.issn or "").strip():
        missing.append("ISSN")
    if not (claim.publication_date or "").strip():
        missing.append("Date of publication")
    if not (claim.indexing_level or "").strip():
        missing.append("Journal indexing level")
    if not (claim.yukthi_id or "").strip():
        missing.append("Yukthi ID")
    if not (claim.scopus_author_url or "").strip():
        missing.append("Author Scopus link")
    # `sec_refs` is not in this list, and must not go back into it. There is no
    # such box on the form any more: the wizard derives the string from the
    # numbers entered against each attached reference, so naming it here sent a
    # first-time claimant to look for a field that does not exist. The
    # reference rule further down says the same thing in terms of the things
    # they can actually act on -- attach the paper, give its number -- so it is
    # left to say it.
    if missing:
        raise HttpError(400, "Complete these before submitting: " + ", ".join(missing))

    # The one field that is mandatory on some claims and meaningless on the
    # rest. Checked here rather than added to `missing` above so the message
    # can say what to do about it: "Team" in a list of missing fields does not
    # tell somebody that the team has to exist before the claim can name it.
    if claim.claim_reason == ClaimReason.STUDENT_PROJECT and claim.team_id is None:
        raise HttpError(
            400,
            "A student project claim has to name the team. Enter the team "
            "code and confirm the students on it before submitting — the "
            "incentive is claimed on their project, and a ticket that names "
            "only you does not show whose work it was.",
        )

    # A journal is often listed in several places at once — Scopus and UGC Care,
    # say — so indexing_level holds a comma-separated set, and any annexure
    # among them needs its reference number.
    selected = [p.strip() for p in (claim.indexing_level or "").split(",") if p.strip()]
    # Two separate registers, so two separate numbers — one shared box could
    # only ever carry one of them.
    for level, value in (
        ("AU Annexure", claim.au_annexure_ref),
        ("UGC Care", claim.ugc_care_ref),
    ):
        if level in selected and not (value or "").strip():
            raise HttpError(
                400, f"{level} requires its reference number (enter NA if none)"
            )

    if not claim.affiliation_ok:
        raise HttpError(400, "The article must be affiliated to Saveetha Engineering College")

    if claim.author_position > claim.total_authors:
        raise HttpError(400, "Author position cannot exceed the total number of authors")

    kinds = set(claim.attachments.values_list("kind", flat=True)) if claim.pk else set()
    has_paper = AttachmentKind.PUBLISHED_PAPER in kinds or bool((claim.proof_url or "").strip())
    has_refs = AttachmentKind.SEC_REFERENCE in kinds or bool((claim.sec_proof_url or "").strip())
    if not has_paper:
        raise HttpError(400, "Upload the full-length published paper (PDF)")

    # The formula is the policy, and the formula counts numbered SEC_REFERENCE
    # attachments. This gate used to count something else — a typed `sec_refs`
    # string, or any single reference URL — so a claim could satisfy every gate,
    # reach Finance, and be worked out as Rs 0 with a note saying it cited none
    # while the form in front of the claimant said three. Refuse it here, where
    # it can still be fixed, rather than pay nothing later.
    #
    # COUNT_ONLY is exempt: it asks for no money, so a threshold whose only job
    # is to decide an amount has nothing to say about it. It keeps the older,
    # looser rule — one reference on file — which is all a publication record
    # needs.
    if claim.claim_reason == ClaimReason.COUNT_ONLY:
        if not has_refs:
            raise HttpError(
                400, "Upload at least one cited reference with SEC affiliation (PDF)"
            )
    else:
        min_sec = _min_sec_references()
        numbered = _numbered_sec_references(claim)
        if numbered < min_sec:
            raise HttpError(
                400,
                f"The incentive is paid on {min_sec} cited references with a "
                "Saveetha Engineering College affiliation, and only the ones "
                f"you evidence count — {numbered} of {min_sec} so far. For each "
                "one, attach the cited paper and enter the number it has in "
                "your reference list. Filed without them this claim would be "
                "worked out as Rs 0; if you have no more to cite, file it as a "
                "publication count instead.",
            )


def _submit_claim(claim: Claim, user: User, *, contest: bool, contest_note: str | None) -> None:
    if not (claim.paper_title or "").strip():
        raise HttpError(400, "Paper title is required")
    _check_mandatory_fields(claim)

    result = verify_publication(
        title=claim.paper_title or "",
        scopus_author_url=claim.scopus_author_url,
        scopus_author_id=claim.scopus_author_id,
        issn=claim.issn,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id if claim.pk else None,
        # The quartile the journal held in the year of publication, and whether
        # it was still a recognised journal then.
        publication_year=claim.publication_year,
        publication_date=claim.publication_date,
    )
    apply_verify_to_claim(claim, result)
    _apply_calc(claim)

    # Faculty-provided ranking is enough — no vendor checklist for the user
    if claim.quartile and not claim.scimago_verified:
        if not (claim.manual_quartile_reason or "").strip():
            claim.manual_quartile_reason = "Faculty-provided journal details"

    # A missing quartile is already one of the contestable verification issues, so
    # it falls through to the "Could not auto-confirm" response below. Raising a
    # separate message here produced wording the client could not recognise, and
    # the user was told to send a note by an error that offered no way to do so.
    issues = _verification_issues(result, claim)
    # _verification_issues already reports the payment-history warning, so
    # adding it here again showed the claimant the same sentence twice.
    if (
        claim.duplicate_warning
        and not claim.override_duplicate
        and not contest
        and not any("Payment history" in i for i in issues)
    ):
        issues.append("Payment history may already include this paper")

    snapshot = {
        "issues": issues,
        "scopus": result.get("scopus"),
        "scimago": result.get("scimago"),
        "paid": result.get("paid"),
        "snip": result.get("snip"),
    }
    claim.verification_snapshot_json = json.dumps(snapshot)
    claim.verification_ok = len(issues) == 0
    claim.contest_forward = bool(contest) and len(issues) > 0

    if issues and not contest:
        raise HttpError(
            400,
            "Could not auto-confirm: "
            + "; ".join(issues)
            + ". Edit details, or send with a short note.",
        )

    if contest and issues:
        if not contest_note or len(contest_note.strip()) < 10:
            raise HttpError(400, "Add a short note (10+ characters) to send anyway")
        claim.contest_note = contest_note.strip()
        if claim.duplicate_warning:
            claim.override_duplicate = True
            claim.override_reason = claim.override_reason or contest_note.strip()
            # Against a name and a time: the person who releases the money has
            # to be somebody else, and cannot be if nobody recorded who this was.
            claim.override_by = user
            claim.override_at = timezone.now()

    # assign_ticket_number retries on collision; next_ticket_number alone races,
    # because the row lock is released before the claim is written. Two people
    # submitting in the same instant got an IntegrityError and a lost claim.
    assign_ticket_number(claim)

    claim.status = ClaimStatus.SUBMITTED
    claim.submitted_at = timezone.now()
    # The paper is now in its author's year, so it takes a slot -- and the
    # amount is worked out again, because the first pass priced it without
    # one. Without this every research-faculty paper is "paper 1" and pays
    # nothing, which is what happened.
    _assign_quota_position(claim)
    _apply_calc(claim)
    claim.save()
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=ClaimStatus.DRAFT,
        to_status=ClaimStatus.SUBMITTED,
        action="CONTEST_FORWARD" if claim.contest_forward else "SUBMIT",
        note=claim.contest_note,
    )
    headline = f"{'Needs review: ' if claim.contest_forward else ''}{claim.paper_title}"
    _notify_admins(claim, f"To clear · {claim.ticket_number}", headline)
    # Read the files now the claim says what it will say. Queued, and never
    # able to undo or refuse the filing: a paper that does not match its
    # files is flagged for the desk, not bounced back to the claimant.
    from core.services.content_check import enqueue_file_check

    enqueue_file_check(claim.id)


@api.patch("/claims/{claim_id}", auth=session_auth)
def patch_claim(request: HttpRequest, claim_id: str, payload: ClaimIn):
    user = require_user(request)
    claim = get_object_or_404(Claim, pk=claim_id, owner=user)
    if claim.status not in (ClaimStatus.DRAFT, ClaimStatus.REJECTED):
        raise HttpError(400, "Only draft/rejected claims can be edited")
    if claim.rejected_outright:
        raise HttpError(
            400,
            "This paper was not accepted, so it cannot be edited or filed again.",
        )
    attachments = _validated_attachments(payload)
    _apply_faculty_payload(claim, payload)
    _bind_identity_from_user(claim, user, payload)
    paid_check = check_already_paid(
        title=claim.paper_title,
        doi=claim.doi,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id,
    )
    claim.duplicate_warning = bool(paid_check.get("warning"))
    claim.duplicate_matches_json = json.dumps(paid_check.get("matches") or [])
    _apply_calc(claim, allow_self_reported=True)
    # Files land before the submission gate reads them.
    claim.save()
    _persist_attachments(claim, attachments, user)
    if payload.submit:
        from_status = claim.status
        claim.status = ClaimStatus.DRAFT
        _submit_claim(
            claim,
            user,
            contest=bool(payload.contest_forward),
            contest_note=payload.contest_note,
        )
        if from_status == ClaimStatus.REJECTED:
            ClaimAction.objects.create(
                claim=claim,
                actor=user,
                from_status=from_status,
                to_status=ClaimStatus.SUBMITTED,
                action="RESUBMIT",
                note=payload.contest_note,
            )
    return claim_to_dict(claim)


def _faculty_status_copy(
    to_status: str,
    note: str | None = None,
    *,
    outright: bool = False,
    from_status: str | None = None,
    ticket_number: str | None = None,
) -> tuple[str, str]:
    """What the claimant is told when their paper reaches `to_status`.

    Written in terms of the claimant's stage (core.visibility.faculty_stage),
    never the desk: it used to say "with the Principal", "the Director has
    authorised", "processed by Finance", which told the claimant exactly
    whose desk their paper was on. The only desk-written text passed through is
    the reason a paper was sent back to them, which is written for them.
    """
    stage = visibility.faculty_stage(
        to_status, rejected_outright=outright, ticket_number=ticket_number
    )
    if stage == "Not accepted":
        return ("Not accepted", note or "Your paper was not accepted.")
    if stage == "Sent back to you":
        return (
            "Sent back to you",
            note or "Your paper needs changes. Edit the details and submit it again.",
        )
    if stage == "Approved for payment":
        return (
            "Approved for payment",
            "Your paper has been approved for payment. You will be told when it is paid.",
        )
    if stage == "Paid":
        return ("Paid", "The incentive for your paper has been paid.")
    if stage == "Withdrawn":
        return (
            "Withdrawn",
            "You withdrew this paper. Edit it and submit it again when it is ready.",
        )
    if stage == "Draft":
        return ("Back to draft", "Your paper is back in draft.")
    if from_status == ClaimStatus.PAID:
        return (
            "Payment reversed",
            "A payment on your paper was reversed. It is under review again, and "
            "you will be told when it moves.",
        )
    return ("Under review", "Your paper is under review.")


def _notify_claimant(claim: Claim, title: str, body: str) -> None:
    """Tell the person who filed the paper, in the app and by mail."""
    full_title = f"{claim.ticket_number or 'Ticket'} · {title}"
    Notification.objects.create(
        user=claim.owner,
        title=full_title,
        body=body,
        href=f"/faculty?claim={claim.id}",
        claim_id=claim.id,
    )
    send_optional_email(claim.owner.email, full_title, body)


def _refuse_if_held(claim: Claim) -> None:
    """A held paper stays where it is until the desk that holds it resumes it."""
    if claim.on_hold:
        raise HttpError(
            409,
            f"{claim.ticket_number or 'This ticket'} is on hold"
            + (f" ({claim.hold_reason})" if claim.hold_reason else "")
            + ". Resume it before moving it on.",
        )


def _lift_hold(claim: Claim) -> None:
    claim.on_hold = False
    claim.hold_reason = None
    claim.held_by = None
    claim.held_at = None


_DESK_NAMES = {
    rbac.SUPERVISOR_DESK: "the research supervisor's desk",
    rbac.PRINCIPAL_DESK: "the Principal's desk",
}


def _require_own_desk(user: User, claim: Claim) -> None:
    """Refuse (403) unless `user` sits at the review desk this paper is at.

    A paper past both desks and not yet paid -- approved, or authorised --
    belongs to no review desk any more. Only a super admin reaches back for
    one of those, as the rescue role; the Director and Finance move it forward
    and nothing else.
    """
    desk = rbac.desk_for_status(claim.status)
    if desk is None:
        if user.role != Role.SUPER_ADMIN:
            raise HttpError(
                403,
                "This paper is past both review desks; only a super admin can "
                "send it back from here.",
            )
        return
    if not rbac.can_act_at_desk(user.role, desk):
        raise HttpError(403, f"This paper is at {_DESK_NAMES[desk]}, which is not yours.")


def _withdraw_approvals(claim: Claim) -> None:
    """Take the desk signatures off a paper that is going back to the claimant.

    The same reasoning as the Director's send-back withdrawing the Principal's
    approval: a name and a date left on a paper that is no longer cleared or
    approved reads, later, as a sign-off that still stands.
    """
    claim.cleared_by = None
    claim.cleared_at = None
    claim.principal_approved_by = None
    claim.principal_approved_at = None
    claim.director_approved_by = None
    claim.director_approved_at = None


def _transition(claim: Claim, user: User, to_status: str, action: str, note: str | None = None):
    from_status = claim.status
    stage_before = visibility.faculty_stage(
        from_status,
        rejected_outright=claim.rejected_outright and from_status == ClaimStatus.REJECTED,
        ticket_number=claim.ticket_number,
    )
    claim.status = to_status
    if to_status == ClaimStatus.PAID:
        claim.paid_at = timezone.now()
    if from_status != to_status and claim.on_hold:
        # The hold was on the paper *at that desk*. Once it has moved -- back,
        # forward, or out to the claimant -- there is nothing left to hold.
        _lift_hold(claim)
    if to_status != ClaimStatus.REJECTED:
        # "Not accepted" describes a rejection; a paper rescued out of one by
        # a status override is not carrying it any more.
        claim.rejected_outright = False
    claim.save()
    ClaimAction.objects.create(
        claim=claim,
        actor=user,
        from_status=from_status,
        to_status=to_status,
        action=action,
        note=note,
    )
    AuditLog.objects.create(
        actor=user,
        action=action,
        entity="Claim",
        entity_id=claim.id,
        detail_json=json.dumps(
            {
                "from": from_status,
                "to": to_status,
                "ticket": claim.ticket_number,
                "note": note,
            }
        ),
    )
    logger.info(
        "claim_transition ticket=%s action=%s from=%s to=%s actor=%s",
        claim.ticket_number,
        action,
        from_status,
        to_status,
        user.email,
    )
    # Told only when what they are shown changes. Every hop between filing and
    # the authorisation is "Under review" to them; a message at each one would
    # let them count the desks.
    stage_after = visibility.faculty_stage(
        to_status, rejected_outright=claim.rejected_outright, ticket_number=claim.ticket_number
    )
    if stage_after != stage_before:
        title, body = _faculty_status_copy(
            to_status, note, outright=claim.rejected_outright,
            from_status=from_status, ticket_number=claim.ticket_number,
        )
        _notify_claimant(claim, title, body)
    # Badges and department milestones, after commit; never blocks this move.
    achievements.on_claim_moved(claim, from_status, to_status)


#: Display-path cache for the second-approval threshold, so serializing a
#: 200-row list does not query the policy 200 times. Money guards always read
#: fresh; put_formula invalidates. It also expires on its own, because only
#: the process that served the edit sees that invalidation — another instance
#: would otherwise show a stale badge indefinitely.
def _guard_self_cleared_override(claim: Claim, actor: User) -> None:
    """The person who set the warning aside cannot also clear the ticket.

    Waving a duplicate away and then clearing it is one person deciding, twice,
    that the college has not already paid for this paper. Two admins is not a
    hardship here: an override is rare, and the alternative is a second
    payment nobody reviewed.
    """
    if not (claim.duplicate_warning and claim.override_duplicate):
        return
    if claim.override_by_id and claim.override_by_id == actor.id:
        raise HttpError(
            400,
            "You set aside the payment-history warning on this ticket, so "
            "somebody else has to clear it.",
        )


def _guard_recomputed_amount(claim: Claim, expected: float | None) -> None:
    """Recompute the money columns from the stored verified values and refuse
    to move money unless the actor confirmed exactly this amount.

    The recomputation mutates the claim; callers run inside the same
    transaction that performs the transition, so a refused action rolls the
    recalculation back too.
    """
    _apply_calc(claim)
    amount = round(claim.remuneration or 0, 2)
    if expected is None or abs(amount - round(float(expected), 2)) > 0.01:
        raise HttpError(
            409,
            f"The recomputed amount is ₹{amount:,.2f}. Review it and confirm again — "
            "money only moves at a confirmed amount.",
        )


def _reverify_or_recalc(claim: Claim, user, *, skip_external: bool) -> None:
    """Refresh verified values from Scopus, or recompute from stored ones.

    Mutates the claim in place and does not save — callers that move money
    do so in the same transaction so a later 409 rolls the refresh back.
    Scopus down raises 502 and leaves the claim untouched.
    """
    if skip_external:
        if user.role != Role.SUPER_ADMIN:
            raise HttpError(403, "Only a super admin may skip external verification")
        previous = claim.remuneration
        _apply_calc(claim)
        AuditLog.objects.create(
            actor=user,
            action="CLAIM_RECALC_SKIP_EXTERNAL",
            entity="Claim",
            entity_id=claim.id,
            detail_json=json.dumps({"previous": previous, "recomputed": claim.remuneration}),
        )
        return
    result = verify_publication(
        title=claim.paper_title or "",
        scopus_author_url=claim.scopus_author_url,
        scopus_author_id=claim.scopus_author_id,
        issn=claim.issn,
        staff_id=claim.staff_id,
        exclude_claim_id=claim.id,
    )
    if not result.get("ok"):
        if claim.manual_verified_at or claim.snip_source or claim.quartile_source:
            # The claim already carries values the server verified (Scopus,
            # the SNIP dump, Scimago, or an admin by hand -- faculty-declared
            # figures live in self_reported_* and never set a source). An
            # outage, or a college with no Scopus key, should not stop the
            # office: recompute from those stored values, audited. A claim
            # with nothing verified still stops here.
            previous = claim.remuneration
            _apply_calc(claim)
            AuditLog.objects.create(
                actor=user,
                action="CLAIM_RECALC_STORED_VALUES",
                entity="Claim",
                entity_id=claim.id,
                detail_json=json.dumps({"previous": previous, "recomputed": claim.remuneration}),
            )
            return
        raise HttpError(
            502,
            "Scopus could not be reached, so the values were not refreshed. "
            "Try again shortly; a super admin can recalculate from stored values.",
        )
    apply_verify_to_claim(claim, result)
    _apply_calc(claim)


@api.post("/claims/{claim_id}/recalculate", auth=session_auth)
def recalculate_claim(request: HttpRequest, claim_id: str, payload: Optional[RecalcIn] = None):
    """Re-verify against Scopus/Scimago and recompute the amount.

    The clearing and pay UIs call this first, show the fresh amount, and then
    confirm with `expected_amount`. clear / mark-paid re-verify again so a
    stale tab or a raw API call cannot pay yesterday's number.
    """
    user = require_user(request)
    if not (rbac.can_clear_claims(user.role) or rbac.can_approve_as_finance(user.role)):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    if claim.status == ClaimStatus.PAID:
        raise HttpError(400, "Claim is already paid — re-verifying would change a settled amount")
    previous = claim.remuneration
    _reverify_or_recalc(claim, user, skip_external=bool(payload and payload.skip_external))
    claim.save()
    changed = round(previous or 0, 2) != round(claim.remuneration or 0, 2)
    return {
        "remuneration": claim.remuneration,
        "previous": previous,
        "changed": changed,
        "base_amount": claim.base_amount,
        "qf_amount": claim.qf_amount,
        "remuneration_category": claim.remuneration_category,
        "remuneration_note": claim.remuneration_note,
        "calc_error": claim.calc_error,
    }


@api.post("/claims/{claim_id}/clear", auth=session_auth)
def clear_claim(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Admin clearing — the one approval between submission and payment.

    Re-verifies against Scopus inside the same transaction, then clears only
    if the approver confirmed exactly the fresh amount. A Scopus outage
    returns 502 and leaves the ticket submitted; a super admin may pass
    skip_external to recompute from stored values instead.
    """
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.SUBMITTED:
            raise HttpError(400, "Only a submitted ticket can be cleared")
        _refuse_if_held(claim)
        _guard_self_cleared_override(claim, user)
        _reverify_or_recalc(claim, user, skip_external=bool(payload.skip_external))
        _guard_recomputed_amount(claim, payload.expected_amount)
        claim.cleared_by = user
        claim.cleared_at = timezone.now()
        _transition(claim, user, ClaimStatus.CLEARED, "CLEAR", payload.note)
        amount = claim.remuneration or 0
    _notify_principal(
        claim,
        f"Cleared — waiting on your approval · {claim.ticket_number}",
        f"₹{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
    )
    return claim_to_dict(claim)


class BulkClearIn(Schema):
    claim_ids: list[str]
    note: Optional[str] = None


# Under /admin, not /claims: "/claims/bulk-clear" is swallowed by the
# "/claims/{claim_id}" route registered above it and answers 405.
@api.post("/admin/bulk-clear", auth=session_auth)
def bulk_clear(request: HttpRequest, payload: BulkClearIn):
    """Clear a batch of submitted tickets.

    The queue is routinely dozens of straightforward tickets; opening each one
    to press the same button is the bulk of the clearing effort. Each ticket is
    still transitioned individually so one bad row cannot take the batch down,
    and every one gets its own action and audit entry.

    Bulk does not re-hit Scopus (200 rows would time out). It recomputes from
    stored verified values and skips any row whose amount drifted.
    """
    user = require_user(request)
    if not rbac.can_clear_claims(user.role):
        raise HttpError(403, "Forbidden")
    ids = list(dict.fromkeys(payload.claim_ids or []))[:200]
    if not ids:
        raise HttpError(400, "Select at least one ticket")

    cleared: list[str] = []
    skipped: list[dict[str, str]] = []
    for claim_id in ids:
        try:
            with transaction.atomic():
                claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
                if claim is None:
                    skipped.append({"id": claim_id, "reason": "Not found"})
                    continue
                if claim.status != ClaimStatus.SUBMITTED:
                    skipped.append(
                        {"id": claim_id, "reason": f"Status is {claim.status}, not SUBMITTED"}
                    )
                    continue
                if claim.on_hold:
                    skipped.append(
                        {
                            "id": claim_id,
                            "reason": f"{claim.ticket_number or claim_id}: on hold — resume it first",
                        }
                    )
                    continue
                # A dismissed duplicate is exactly the row that must not go
                # through in a batch of two hundred without being looked at.
                if (
                    claim.duplicate_warning
                    and claim.override_duplicate
                    and claim.override_by_id == user.id
                ):
                    skipped.append(
                        {
                            "id": claim_id,
                            "reason": (
                                f"{claim.ticket_number or claim_id}: you set aside the "
                                "payment-history warning on this one, so somebody else "
                                "has to clear it"
                            ),
                        }
                    )
                    continue
                # Same guard as a single clear, with the stored amount standing
                # in for the confirmation: a row whose recomputed amount drifted
                # from what the screen showed is skipped, never silently cleared
                # at a different figure.
                shown = claim.remuneration
                _apply_calc(claim)
                if round(shown or 0, 2) != round(claim.remuneration or 0, 2):
                    skipped.append(
                        {
                            "id": claim_id,
                            "reason": (
                                f"{claim.ticket_number or claim_id}: amount changed on recalculation "
                                f"(₹{(shown or 0):,.0f} → ₹{(claim.remuneration or 0):,.0f}) — open it to review"
                            ),
                        }
                    )
                    # Roll this row back so the recalculated figures are not
                    # half-committed outside a clear.
                    transaction.set_rollback(True)
                    continue
                claim.cleared_by = user
                claim.cleared_at = timezone.now()
                _transition(claim, user, ClaimStatus.CLEARED, "CLEAR", payload.note)
                amount = claim.remuneration or 0
            _notify_principal(
                claim,
                f"Cleared — waiting on your approval · {claim.ticket_number}",
                f"₹{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
            )
            cleared.append(claim_id)
        except Exception as e:  # one bad ticket must not sink the batch
            logger.exception("bulk_clear_failed id=%s", claim_id)
            skipped.append({"id": claim_id, "reason": str(e)[:120]})
    return {"cleared": len(cleared), "skipped": skipped}


# Retired chain. Kept so an old client gets an explanation rather than a 404.
_RETIRED_STEP = (
    "That approval step no longer exists. A submitted ticket is cleared by the "
    "admin, then paid by Finance."
)


@api.post("/claims/{claim_id}/hod-approve", auth=session_auth)
def hod_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """The HoD role was removed from the system entirely."""
    require_user(request)
    raise HttpError(400, _RETIRED_STEP)


def _may_approve_as_principal(role: str) -> bool:
    """The principal, and a super admin who has to stand in for one."""
    return role == Role.PRINCIPAL or role == Role.SUPER_ADMIN


@api.post("/claims/{claim_id}/principal-approve", auth=session_auth)
def principal_approve(request: HttpRequest, claim_id: str, payload: ActionIn):
    """Approve the spend on a cleared ticket, which is what lets finance pay it.

    The research cell checks that a claim is true; this step is somebody
    accountable agreeing to spend the money on it. They were previously the
    same decision, taken by the research cell alone.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")

    with transaction.atomic():
        claim = get_object_or_404(Claim.objects.select_for_update(), pk=claim_id)
        if claim.status != ClaimStatus.CLEARED:
            raise HttpError(
                400,
                "Only a ticket the research cell has cleared can be approved"
                f" — this one is {claim.status}",
            )
        _refuse_if_held(claim)
        # The amount on the screen is the amount being approved. Recomputing
        # here means an approval cannot be given for one figure and paid at
        # another.
        _apply_calc(claim)
        _guard_recomputed_amount(claim, payload.expected_amount)

        claim.principal_approved_by = user
        claim.principal_approved_at = timezone.now()
        # The principal is, by definition, a different pair of eyes from the
        # desk that cleared it, so their approval also satisfies the
        # second-signature rule where one is outstanding.
        if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
            claim.second_approved_by = user
            claim.second_approved_at = timezone.now()
        _transition(claim, user, ClaimStatus.PRINCIPAL_APPROVED, "PRINCIPAL_APPROVE", payload.note)
        amount = claim.remuneration or 0

    # Goes to the Director, not to Finance. Finance cannot see it until it is
    # authorised, and telling them it was "approved for payment" at this point
    # was the exact confusion the extra step exists to remove.
    _notify_director(
        claim,
        f"Awaiting your authorisation · {claim.ticket_number}",
        f"₹{amount:,.0f} for {claim.owner.name}: {claim.paper_title}",
    )
    return claim_to_dict(claim)


@api.get("/principal/queue", auth=session_auth)
def principal_queue(
    request: HttpRequest,
    q: Optional[str] = None,
    department: Optional[str] = None,
    quartile: Optional[str] = None,
    min_amount: Optional[float] = None,
    max_amount: Optional[float] = None,
    waiting_over: Optional[int] = None,
    sort: str = "waiting",
    limit: int = 50,
    offset: int = 0,
):
    """Everything cleared and waiting on the principal, sliced.

    The totals are returned for the whole filtered set, not the page: a
    decision about a month's spend cannot be taken from the fifty rows that
    happen to be on screen.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")

    qs = (
        Claim.objects.filter(status=ClaimStatus.CLEARED)
        .select_related("owner", "cleared_by", "override_by", "held_by")
        .prefetch_related("attachments")
    )
    if q:
        term = q.strip()
        qs = qs.filter(
            Q(paper_title__icontains=term)
            | Q(ticket_number__icontains=term)
            | Q(owner__name__icontains=term)
            | Q(journal_title__icontains=term)
        )
    if department:
        qs = qs.filter(owner__department__iexact=department)
    if quartile:
        qs = qs.filter(quartile__iexact=quartile)
    if min_amount is not None:
        qs = qs.filter(remuneration__gte=min_amount)
    if max_amount is not None:
        qs = qs.filter(remuneration__lte=max_amount)
    if waiting_over:
        qs = qs.filter(cleared_at__lte=timezone.now() - timedelta(days=int(waiting_over)))

    sorts = {
        "waiting": "cleared_at",          # longest wait first
        "recent": "-cleared_at",
        "amount": "-remuneration",
        "amount_asc": "remuneration",
        "department": "owner__department",
        "title": "paper_title",
    }
    qs = qs.order_by(sorts.get(sort, "cleared_at"))

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()
    agg = qs.aggregate(amount=Sum("remuneration"), oldest=Min("cleared_at"))
    oldest = agg["oldest"]

    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [claim_to_dict(c) for c in qs[offset : offset + limit]],
        # Over everything the filter matched, not the page.
        "totals": {
            "count": total,
            "amount": round(agg["amount"] or 0, 2),
            "longest_wait_days": (timezone.now() - oldest).days if oldest else None,
        },
        "departments": sorted(
            d
            for d in Claim.objects.filter(status=ClaimStatus.CLEARED)
            .values_list("owner__department", flat=True)
            .distinct()
            if d
        ),
    }


class PrincipalBulkIn(Schema):
    claim_ids: list[str]
    note: Optional[str] = None


@api.post("/principal/bulk-approve", auth=session_auth)
def principal_bulk_approve(request: HttpRequest, payload: PrincipalBulkIn):
    """Approve a batch, one row at a time, skipping what does not qualify.

    A batch that fails as a unit is a batch nobody dares run: one stale row out
    of two hundred and the principal is back to clicking through them
    individually.
    """
    user = require_user(request)
    if not _may_approve_as_principal(user.role):
        raise HttpError(403, "Forbidden")
    ids = list(dict.fromkeys(payload.claim_ids or []))[:500]
    if not ids:
        raise HttpError(400, "Nothing selected")

    approved = 0
    total = 0.0
    skipped: list[dict[str, str]] = []
    for claim_id in ids:
        with transaction.atomic():
            claim = Claim.objects.select_for_update().filter(pk=claim_id).first()
            if claim is None:
                skipped.append({"id": claim_id, "reason": "Not found"})
                continue
            if claim.status != ClaimStatus.CLEARED:
                skipped.append({
                    "id": claim_id,
                    "reason": f"{claim.ticket_number or claim_id}: status is {claim.status}",
                })
                continue
            if claim.on_hold:
                skipped.append({
                    "id": claim_id,
                    "reason": f"{claim.ticket_number or claim_id}: on hold — resume it first",
                })
                continue
            shown = claim.remuneration
            _apply_calc(claim)
            if round(shown or 0, 2) != round(claim.remuneration or 0, 2):
                skipped.append({
                    "id": claim_id,
                    "reason": (
                        f"{claim.ticket_number or claim_id}: amount changed on "
                        f"recalculation (₹{(shown or 0):,.0f} → ₹{(claim.remuneration or 0):,.0f})"
                        " — open it to review"
                    ),
                })
                transaction.set_rollback(True)
                continue
            claim.principal_approved_by = user
            claim.principal_approved_at = timezone.now()
            if not claim.second_approved_by_id and claim.cleared_by_id != user.id:
                claim.second_approved_by = user
                claim.second_approved_at = timezone.now()
            _transition(
                claim, user, ClaimStatus.PRINCIPAL_APPROVED, "PRINCIPAL_APPROVE", payload.note
            )
            approved += 1
            total += claim.remuneration or 0
        _notify_director(
            claim,
            f"Awaiting your authorisation · {claim.ticket_number}",
            f"₹{(claim.remuneration or 0):,.0f} for {claim.owner.name}: {claim.paper_title}",
        )
    return {"approved": approved, "total": round(total, 2), "skipped": skipped}




__all__ = [
    'BulkClearIn',
    'PrincipalBulkIn',
    '_ANNEXURE_LEVELS',
    '_DESK_NAMES',
    '_RETIRED_STEP',
    '_check_mandatory_fields',
    '_faculty_status_copy',
    '_flatten_title',
    '_guard_recomputed_amount',
    '_guard_self_cleared_override',
    '_issn_variants',
    '_journal_reference',
    '_lift_hold',
    '_match_on_punctuation',
    '_may_approve_as_principal',
    '_notify_claimant',
    '_refuse_if_held',
    '_require_own_desk',
    '_reverify_or_recalc',
    '_submit_claim',
    '_transition',
    '_withdraw_approvals',
    'bulk_clear',
    'clear_claim',
    'create_claim',
    'get_claim',
    'hod_approve',
    'patch_claim',
    'principal_approve',
    'principal_bulk_approve',
    'principal_queue',
    'recalculate_claim',
]
