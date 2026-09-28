"""duplicate findings.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import api, session_auth
from core.api.common import require_user

import json
from typing import Optional
from django.db.models import Sum
from django.http import HttpRequest
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from ninja.errors import HttpError
from core import visibility
from core.models import AuditLog, DuplicateFinding
from core.services import rbac

# ---------- duplicate findings ----------


class FindingReviewIn(Schema):
    status: str
    note: Optional[str] = None
    recovered_amount: Optional[float] = None


def _refuse_contest_blind(user) -> None:
    """The Director and Finance are not shown payment-history matches at all
    (see core.visibility), and this screen is nothing but those."""
    if visibility.is_contest_blind(user.role):
        raise HttpError(
            403,
            "Payment-history findings are reviewed by the research supervisor's "
            "desk and the Principal.",
        )


@api.get("/admin/duplicate-findings", auth=session_auth)
def list_duplicate_findings(
    request: HttpRequest,
    kind: str = "SAME_PERSON",
    status: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """What the sweep over paid history found, largest sum at issue first."""
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")
    _refuse_contest_blind(user)

    qs = DuplicateFinding.objects.select_related("reviewed_by")
    if kind:
        qs = qs.filter(kind=kind)
    if status:
        # "CONFIRMED,DISMISSED,RECOVERED" is the history: everything decided.
        qs = qs.filter(status__in=[x for x in status.split(",") if x])

    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    total = qs.count()

    page = list(qs[offset : offset + limit])
    rows_of = {f.id: json.loads(f.rows_json or "[]") for f in page}
    _add_faces(page, rows_of)

    everything = DuplicateFinding.objects.filter(kind=kind or "SAME_PERSON")
    return {
        "total": total,
        "limit": limit,
        "offset": offset,
        "results": [
            {
                "id": f.id,
                "kind": f.kind,
                "status": f.status,
                "matched_on": f.matched_on,
                "paper_title": f.paper_title,
                "faculty_name": f.faculty_name,
                "payment_count": f.payment_count,
                "total_amount": f.total_amount,
                "extra_amount": f.extra_amount,
                "rows": rows_of[f.id],
                "faculty_photo_url": getattr(f, "_photo_url", None),
                "note": f.note,
                "recovered_amount": f.recovered_amount,
                "reviewed_by_name": f.reviewed_by.name if f.reviewed_by_id else None,
                "reviewed_at": f.reviewed_at.isoformat() if f.reviewed_at else None,
            }
            for f in page
        ],
        "summary": {
            "open": everything.filter(status=DuplicateFinding.Status.OPEN).count(),
            "confirmed": everything.filter(status=DuplicateFinding.Status.CONFIRMED).count(),
            "dismissed": everything.filter(status=DuplicateFinding.Status.DISMISSED).count(),
            "recovered": everything.filter(status=DuplicateFinding.Status.RECOVERED).count(),
            "at_issue": round(
                everything.filter(
                    status__in=(
                        DuplicateFinding.Status.OPEN,
                        DuplicateFinding.Status.CONFIRMED,
                    )
                ).aggregate(s=Sum("extra_amount"))["s"]
                or 0,
                2,
            ),
            "recovered_amount": round(
                everything.aggregate(s=Sum("recovered_amount"))["s"] or 0, 2
            ),
        },
    }


def _sheet_month(raw_json) -> str | None:
    """"YYYY-MM" from the ERP row's own month column, when it reads as one."""
    import re
    from core.services.record_dates import MONTH_KEYS, erp_row

    row = erp_row(raw_json) or {}
    for k in MONTH_KEYS:
        m = re.match(r"(\d{4})-(\d{2})", str(row.get(k) or ""))
        if m:
            return f"{m.group(1)}-{m.group(2)}"
    return None


def _add_faces(findings, rows_of) -> None:
    """A photo for each payment's person: the claimant's account for a claim,
    and an exact name match for an imported ERP row (which has no account)."""
    from django.conf import settings
    from core.models import User

    ids, names = set(), set()
    for f in findings:
        names.add((f.faculty_name or "").strip().lower())
        for r in rows_of[f.id]:
            if r.get("source") == "claim" and r.get("person_key"):
                ids.add(r["person_key"])
            names.add((r.get("person") or "").strip().lower())
    names.discard("")
    by_id, by_name = {}, {}
    for uid, name, photo in User.objects.filter(id__in=ids).values_list("id", "name", "photo"):
        by_id[uid] = photo
    if names:
        from django.db.models.functions import Lower
        for name, photo in (User.objects.annotate(n=Lower("name")).filter(n__in=names)
                            .exclude(photo="").exclude(photo__isnull=True)
                            .values_list("n", "photo")):
            by_name.setdefault(name, photo)

    def url(p):
        return f"{settings.MEDIA_URL}{p}" if p else None

    # A "Processed"-sheet row carries the import's month, not a real one.
    from core.models import PriorPayment
    from core.services.record_dates import ledger_month_recorded

    prior_ids = {r["id"] for f in findings for r in rows_of[f.id] if r.get("source") == "prior"}
    raw = dict(PriorPayment.objects.filter(id__in=prior_ids).values_list("id", "raw_json"))

    for f in findings:
        for r in rows_of[f.id]:
            r["month_recorded"] = (
                ledger_month_recorded(raw.get(r["id"])) if r.get("source") == "prior" else True
            )
            if r.get("source") == "prior" and r["month_recorded"]:
                # The sweep stored paid_at's month, which the import may have
                # stamped; the sheet's own month column is the record.
                month = _sheet_month(raw.get(r["id"]))
                if month:
                    r["when"] = month
            photo = by_id.get(r.get("person_key")) if r.get("source") == "claim" else None
            r["photo_url"] = url(photo or by_name.get((r.get("person") or "").strip().lower()))
        f._photo_url = url(by_name.get((f.faculty_name or "").strip().lower())) or next(
            (r["photo_url"] for r in rows_of[f.id] if r["photo_url"]), None)


@api.post("/admin/duplicate-findings/{finding_id}", auth=session_auth)
def review_duplicate_finding(request: HttpRequest, finding_id: str, payload: FindingReviewIn):
    """Record what a person decided about one finding.

    A note is required to dismiss: "not a duplicate" with no reason is not a
    review, and the next sweep would raise it again with nothing to go on.
    """
    user = require_user(request)
    _refuse_contest_blind(user)
    if user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "Forbidden")
    valid = {s.value for s in DuplicateFinding.Status}
    if payload.status not in valid:
        raise HttpError(400, f"Status must be one of {sorted(valid)}")
    note = (payload.note or "").strip()
    if payload.status == DuplicateFinding.Status.DISMISSED and len(note) < 5:
        raise HttpError(400, "Say why this is not a duplicate")

    finding = get_object_or_404(DuplicateFinding, pk=finding_id)
    finding.status = payload.status
    finding.note = note or finding.note
    finding.reviewed_by = user
    finding.reviewed_at = timezone.now()
    if payload.recovered_amount is not None:
        finding.recovered_amount = payload.recovered_amount
    finding.save()

    AuditLog.objects.create(
        actor=user, action="DUPLICATE_REVIEW", entity="DuplicateFinding",
        entity_id=finding.id,
        detail_json=json.dumps({
            "status": payload.status,
            "extra_amount": finding.extra_amount,
            "recovered_amount": finding.recovered_amount,
        }),
    )
    return {"ok": True, "status": finding.status}




__all__ = [
    'FindingReviewIn',
    '_refuse_contest_blind',
    'list_duplicate_findings',
    'review_duplicate_finding',
]
