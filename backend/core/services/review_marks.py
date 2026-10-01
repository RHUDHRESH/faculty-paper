"""Review marks: what each seat is shown, and what a send-back keeps.

A `ReviewMark` is a reviewer's mark on a region or a quoted span of one
document of a claim. The rules this module holds:

* The desks that judge a paper (`rbac.can_review_flags`) read every mark on
  it. The Director and Finance read none: a mark is a doubt about the paper,
  the same class of content as a flag (`core.visibility.FLAG_KEYS`).
* The claimant reads only CLAIMANT-audience marks that went back with a
  send-back, never who wrote them ("The college") and never a staff-only mark.
  A mark the reviewer is still drafting is not yet the claimant's.
* Nobody marks their own claim (`rbac.is_own_claim`); that is enforced by the
  API before anything here runs.

`record_send_back` is called when a paper goes back to its claimant, and
`note_resubmission` when they file it again.
"""
from __future__ import annotations

import json
from typing import Any, Iterable

from django.utils import timezone

from core.models import Claim, ClaimAction, ReviewMark, SendBackRecord, User

#: What the claimant reads in place of a reviewer's name.
THE_COLLEGE = "The college"

CHECKLIST_LABELS = {k: label for k, label in ReviewMark.Checklist.choices}
#: A checklist item is one of these; only the last two go back to the claimant.
CHECKLIST_STATUSES = ("ok", "issue", "needs_info")
FAILED = ("issue", "needs_info")


def default_audience(kind: str) -> str:
    """An issue is for the claimant unless the reviewer says otherwise."""
    return ReviewMark.Audience.CLAIMANT if kind == ReviewMark.Kind.ISSUE else ReviewMark.Audience.STAFF


def state_of(mark: ReviewMark) -> str:
    """open, fixed? (claimant filed again, reviewer to confirm), or resolved."""
    if mark.resolved_at:
        return "resolved"
    if mark.resolved_in_resubmission:
        return "fixed?"
    return "open"


def _rect(mark: ReviewMark) -> dict[str, float] | None:
    if None in (mark.rect_x, mark.rect_y, mark.rect_w, mark.rect_h):
        return None
    return {"x": mark.rect_x, "y": mark.rect_y, "w": mark.rect_w, "h": mark.rect_h}


def _upload_label(mark: ReviewMark) -> str | None:
    up = mark.upload
    if up is None:
        return None
    if up.ref_number:
        return f"SEC reference {up.ref_number}"
    return up.filename or up.get_kind_display()


def _common(mark: ReviewMark) -> dict[str, Any]:
    return {
        "id": mark.id,
        "claim_id": mark.claim_id,
        "upload_id": mark.upload_id,
        "upload_label": _upload_label(mark),
        "page": mark.page,
        "rect": _rect(mark),
        "quote": mark.quote or "",
        "kind": mark.kind,
        "checklist_key": mark.checklist_key or "",
        "body": mark.body or "",
        "created_at": mark.created_at.isoformat() if mark.created_at else None,
        "resolved_at": mark.resolved_at.isoformat() if mark.resolved_at else None,
        "sent_back_at": mark.sent_back_at.isoformat() if mark.sent_back_at else None,
        "resolved_in_resubmission": mark.resolved_in_resubmission,
        "state": state_of(mark),
    }


def for_staff(mark: ReviewMark) -> dict[str, Any]:
    return {
        **_common(mark),
        "audience": mark.audience,
        "author_id": mark.author_id,
        "author_name": mark.author.name if mark.author_id else None,
        "resolved_by_name": mark.resolved_by.name if mark.resolved_by_id else None,
    }


def for_claimant(mark: ReviewMark) -> dict[str, Any]:
    """The claimant's copy: no author, no audience, no resolver."""
    return {
        **_common(mark),
        "audience": ReviewMark.Audience.CLAIMANT,
        "author_id": None,
        "author_name": THE_COLLEGE,
        "resolved_by_name": None,
    }


def claimant_marks(claim: Claim) -> Iterable[ReviewMark]:
    return (
        claim.review_marks.filter(
            audience=ReviewMark.Audience.CLAIMANT, sent_back_at__isnull=False
        )
        .select_related("upload")
        .order_by("upload_id", "page", "rect_y", "created_at")
    )


def staff_marks(claim: Claim) -> Iterable[ReviewMark]:
    return claim.review_marks.select_related("upload", "author", "resolved_by")


def clean_checklist(items: Any) -> list[dict[str, Any]]:
    """The checklist the reviewer sent, reduced to what is safe to keep."""
    out: list[dict[str, Any]] = []
    if not isinstance(items, list):
        return out
    for raw in items[:40]:
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("key") or "other")
        if key not in CHECKLIST_LABELS:
            key = "other"
        status = str(raw.get("status") or "ok")
        if status not in CHECKLIST_STATUSES:
            continue
        out.append({
            "key": key,
            "label": CHECKLIST_LABELS[key],
            "status": status,
            "note": str(raw.get("note") or "").strip()[:500],
        })
    return out


def record_send_back(
    claim: Claim, user: User, action: ClaimAction | None, reason: str, checklist: Any
) -> SendBackRecord:
    """Keep, with the send-back, what the claimant is to fix.

    The claim's open CLAIMANT marks become the claimant's (`sent_back_at`), and
    the failed checklist items are stored beside them, so the fix view lists
    exactly what was sent even if the reviewer edits a mark later.
    """
    now = timezone.now()
    open_marks = list(
        claim.review_marks.filter(
            audience=ReviewMark.Audience.CLAIMANT, resolved_at__isnull=True
        ).select_related("upload")
    )
    for m in open_marks:
        m.sent_back_at = now
        m.resolved_in_resubmission = False
        m.save(update_fields=["sent_back_at", "resolved_in_resubmission", "updated_at"])
    failed = [i for i in clean_checklist(checklist) if i["status"] in FAILED]
    return SendBackRecord.objects.create(
        claim=claim,
        action=action,
        reason=reason or "",
        marks_json=json.dumps([for_claimant(m) for m in open_marks]),
        checklist_json=json.dumps(failed),
        created_by=user,
    )


def note_resubmission(claim: Claim) -> int:
    """The claimant filed again: every mark still open is now "fixed?"."""
    return claim.review_marks.filter(
        audience=ReviewMark.Audience.CLAIMANT,
        sent_back_at__isnull=False,
        resolved_at__isnull=True,
    ).update(resolved_in_resubmission=True)


def send_back_dict(record: SendBackRecord | None) -> dict[str, Any] | None:
    if record is None:
        return None
    return {
        "id": record.id,
        "reason": record.reason,
        "created_at": record.created_at.isoformat(),
        "marks": json.loads(record.marks_json or "[]"),
        "checklist": json.loads(record.checklist_json or "[]"),
    }
