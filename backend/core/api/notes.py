"""notes on a ticket, and lookup.

Moved verbatim from the former single-module core/api.py; the
import order in core/api/__init__.py fixes route registration
order and must not be casually reordered.
"""

from __future__ import annotations

from core.api.common import rate_limit, _notify_admins, api, session_auth
from core.api.deps import _user_dict, claim_to_dict
from core.api.common import require_user
from core.api.claims import _claims_queryset, _refuse_hod_money_screens
from core.api.dashboard import _claims_file, _per_paper, reports

import json
from typing import Any, Optional
from django.db.models import Q
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from ninja import Schema
from django.conf import settings
from ninja.errors import HttpError
from core.models import AuditLog, Claim, ClaimNote, ClaimStatus, Role, User
from core.services import rbac
from core.services import exporters
from core.services.reporting_pack import build_pack

# ---------- notes on a ticket, and lookup ----------


class ClaimNoteIn(Schema):
    body: str


def _may_read_notes(role: str) -> bool:
    """Admins read them; the principal reads back what they wrote."""
    return role in rbac.ADMIN_ROLES or role == Role.PRINCIPAL


@api.get("/claims/{claim_id}/notes", auth=session_auth)
def list_claim_notes(request: HttpRequest, claim_id: str):
    """Notes raised on one ticket. Never the claimant, never finance."""
    user = require_user(request)
    if not _may_read_notes(user.role):
        raise HttpError(403, "Forbidden")
    claim = get_object_or_404(Claim, pk=claim_id)
    return {
        "results": [
            {
                "id": n.id,
                "body": n.body,
                "author_name": n.author.name if n.author else None,
                "author_role": n.author.role if n.author else None,
                "created_at": n.created_at.isoformat(),
                "resolved_at": n.resolved_at.isoformat() if n.resolved_at else None,
                "resolved_by_name": n.resolved_by.name if n.resolved_by else None,
            }
            for n in claim.notes.select_related("author", "resolved_by")
        ]
    }


@api.post("/claims/{claim_id}/notes", auth=session_auth)
def add_claim_note(request: HttpRequest, claim_id: str, payload: ClaimNoteIn):
    """The principal raises something about a specific ticket, for the admin.

    Tied to a ticket on purpose: a general message is a mail to somebody's inbox
    and dies there, while a note on the ticket is in front of whoever picks that
    ticket up.
    """
    user = require_user(request)
    if user.role != Role.PRINCIPAL and user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "Forbidden")
    body = (payload.body or "").strip()
    if len(body) < 3:
        raise HttpError(400, "Write the note first")

    claim = get_object_or_404(Claim, pk=claim_id)
    note = ClaimNote.objects.create(
        claim=claim, author=user, body=body[:5000], audience=ClaimNote.Audience.ADMIN
    )
    _notify_admins(
        claim,
        f"{user.name or user.email} raised a note · {claim.ticket_number or 'draft'}",
        body[:300],
    )
    AuditLog.objects.create(
        actor=user, action="CLAIM_NOTE", entity="Claim", entity_id=claim.id,
        detail_json=json.dumps({"note_id": note.id}),
    )
    return {"ok": True, "id": note.id}


@api.post("/claims/notes/{note_id}/resolve", auth=session_auth)
def resolve_claim_note(request: HttpRequest, note_id: str):
    user = require_user(request)
    if user.role not in rbac.ADMIN_ROLES:
        raise HttpError(403, "Only the research cell closes a note")
    note = get_object_or_404(ClaimNote, pk=note_id)
    note.resolved_at = timezone.now()
    note.resolved_by = user
    note.save(update_fields=["resolved_at", "resolved_by"])
    return {"ok": True}


@api.get("/lookup/ticket", auth=session_auth)
def lookup_ticket(request: HttpRequest, q: str):
    """Find a ticket by its number, or a faculty member by id, name or email.

    One box that takes whatever somebody has to hand — a ticket number off an
    email, a staff id off a spreadsheet, or a name — instead of three screens
    that each want a different key.
    """
    user = require_user(request)
    # Every ticket row carries its remuneration.
    _refuse_hod_money_screens(user)
    term = (q or "").strip()
    if len(term) < 2:
        raise HttpError(400, "Type at least two characters")

    scope = _claims_queryset(user)
    tickets = scope.filter(
        Q(ticket_number__iexact=term) | Q(ticket_number__icontains=term)
    ).select_related("owner")[:20]

    people = []
    if rbac.can_view_reports(user.role) or rbac.can_manage_users(user.role):
        people = User.objects.filter(role=Role.FACULTY).filter(
            Q(staff_id__iexact=term)
            | Q(biometric_id__iexact=term)
            | Q(employee_id__iexact=term)
            | Q(email__icontains=term)
            | Q(name__icontains=term)
        )[:20]

    return {
        "tickets": [
            {
                "id": c.id,
                "ticket_number": c.ticket_number,
                "paper_title": c.paper_title,
                "status": c.status,
                "owner_name": c.owner.name,
                "remuneration": c.remuneration,
            }
            for c in tickets
        ],
        "faculty": [
            {
                "id": u.id,
                "name": u.name,
                "email": u.email,
                "department": u.department,
                "staff_id": u.staff_id,
            }
            for u in people
        ],
    }


def _authorship(claims) -> list[dict[str, Any]]:
    """Where this person sits on the author list.

    First authorship is what promotion panels ask about, and the scheme pays
    on it, so it is worth its own answer rather than being inferred from the
    per-claim author point.
    """
    buckets: dict[str, dict[str, Any]] = {}
    for c in claims:
        pos = c.author_position
        if pos == 1:
            label = "First author"
        elif pos and c.total_authors and pos == c.total_authors:
            label = "Last author"
        elif pos:
            label = f"Author {pos}"
        else:
            label = "Not stated"
        slot = buckets.setdefault(label, {"key": label, "count": 0, "amount": 0.0})
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0
    rows = [
        {"key": b["key"], "count": b["count"], "amount": round(b["amount"], 2)}
        for b in buckets.values()
    ]
    #: First, last, then the middle positions in order, then the unknowns.
    def rank(r: dict[str, Any]) -> tuple[int, int]:
        if r["key"] == "First author":
            return (0, 0)
        if r["key"] == "Last author":
            return (1, 0)
        if r["key"] == "Not stated":
            return (3, 0)
        return (2, int(r["key"].split()[-1]))

    return sorted(rows, key=rank)


@api.get("/faculty/{user_id}/report", auth=session_auth)
def faculty_report(request: HttpRequest, user_id: str):
    """Everything one faculty member has published and been paid.

    The oversight portals could count the college but not a person, so
    "how has Dr X done" meant exporting the ledger and pivoting it by hand.
    """
    user = require_user(request)
    if not (rbac.can_view_reports(user.role) or rbac.can_manage_users(user.role)):
        raise HttpError(403, "Forbidden")
    person = get_object_or_404(User, pk=user_id)
    # Drafts are private working notes, not a record of anything: the person
    # has not filed them. Counting them would inflate "publications" with
    # abandoned attempts, and the export already leaves them out -- the two
    # disagreeing is worse than either answer.
    claims = (
        Claim.objects.filter(owner=person)
        .exclude(status=ClaimStatus.DRAFT)
        .order_by("-updated_at")
    )
    paid = claims.filter(status=ClaimStatus.PAID)

    by_month: dict[str, dict[str, Any]] = {}
    for c in paid.exclude(payout_month__isnull=True):
        key = c.payout_month.strftime("%Y-%m")
        slot = by_month.setdefault(key, {"key": key, "count": 0, "amount": 0.0})
        slot["count"] += 1
        slot["amount"] += c.remuneration or 0

    def group(field: str, blank: str):
        out: dict[str, dict[str, Any]] = {}
        for c in claims:
            # Not every groupable field is text: publication_year is an int,
            # and calling .strip() on it took the whole record down.
            raw = getattr(c, field, None)
            key = (str(raw).strip() or blank) if raw not in (None, "") else blank
            slot = out.setdefault(key, {"key": key, "count": 0, "amount": 0.0})
            slot["count"] += 1
            slot["amount"] += c.remuneration or 0
        return sorted(out.values(), key=lambda r: -r["count"])

    return {
        "faculty": _user_dict(person),
        "totals": {
            "publications": claims.count(),
            "paid_claims": paid.count(),
            "paid_amount": round(
                sum(c.remuneration or 0 for c in paid), 2
            ),
            "in_review": claims.filter(status=ClaimStatus.SUBMITTED).count(),
        },
        "by_month": sorted(by_month.values(), key=lambda r: r["key"]),
        "by_quartile": group("quartile", "No quartile"),
        "by_status": group("status", "—"),
        "by_year": sorted(
            group("publication_year", "Not stated"), key=lambda r: str(r["key"])
        ),
        "by_journal": group("journal_title", "Not recorded")[:12],
        "by_type": group("aggregation_type", "Not stated"),
        "by_position": _authorship(claims),
        "per_paper": _per_paper(paid),
        "claims": [claim_to_dict(c) for c in claims[:200]],
    }


@api.get("/faculty/{user_id}/report/export", auth=session_auth)
def faculty_report_export(request: HttpRequest, user_id: str, fmt: str = "xlsx"):
    """One faculty member's publications as a file.

    The same sheet the office files for the college, filtered to one person --
    which is what an appraisal or a promotion panel actually asks for.
    """
    user = require_user(request)
    if not (rbac.can_view_reports(user.role) or rbac.can_manage_users(user.role)):
        raise HttpError(403, "Forbidden")
    person = get_object_or_404(User, pk=user_id)
    rows = (
        Claim.objects.filter(owner=person)
        .exclude(status=ClaimStatus.DRAFT)
        .select_related("owner")
        .order_by("-publication_year", "-updated_at")[:5000]
    )
    tag = (person.staff_id or person.email.split("@")[0] or "faculty").replace(" ", "-")
    return _claims_file(rows, f"publications-{tag}", fmt)


@api.get("/reports/pack", auth=session_auth)
def reports_pack(request: HttpRequest, year: Optional[int] = None, fmt: str = "xlsx"):
    """The NAAC / NIRF submission tables, as one workbook.

    Assembled by hand from exports every year, out of data the system already
    holds. The Notes sheet says what each figure counts and what could not be
    produced, because a number in an accreditation submission has to be
    defensible a year later.
    """
    user = require_user(request)
    if not rbac.can_view_reports(user.role):
        raise HttpError(403, "Forbidden")

    rate_limit(request, "export", settings.EXPORT_HOURLY_LIMIT, "hour", what="exports")
    pack = build_pack(year=year, scope=_claims_queryset(user))
    # "preview" is the on-screen view: the same tables, capped, so the page
    # can show what it is about to hand over. A pack that could only be
    # downloaded had to be opened in Excel before anyone could tell whether
    # it was the right year.
    if fmt == "preview":
        return {
            "year": year,
            "tables": [
                {
                    "name": name,
                    "columns": list(sheet["columns"]),
                    "rows": [[_json_safe(v) for v in r] for r in sheet["rows"][:25]],
                    "row_count": len(sheet["rows"]),
                }
                for name, sheet in pack.items()
            ],
        }

    if fmt not in exporters.FORMATS:
        raise HttpError(400, f"Format must be one of: {', '.join(exporters.FORMATS)}.")

    stem = f"accreditation-pack-{year or 'all-years'}"
    body = exporters.render(
        pack,
        fmt,
        title="Accreditation pack",
        subtitle=(
            f"Saveetha Engineering College · "
            f"{'publication year ' + str(year) if year else 'all years on record'}"
        ),
    )
    res = HttpResponse(body, content_type=exporters.CONTENT_TYPES[fmt])
    res["Content-Disposition"] = f'attachment; filename="{exporters.filename(stem, fmt)}"'
    AuditLog.objects.create(
        actor=user, action="REPORT_PACK", entity="Report", entity_id=stem,
        detail_json=json.dumps(
            {"year": year, "fmt": fmt, "rows": len(pack["NAAC 3.4.3"]["rows"])}
        ),
    )
    return res


def _json_safe(value):
    """Dates and Decimals do not survive a JSON response as themselves."""
    from datetime import date as _date, datetime as _datetime
    from decimal import Decimal

    if isinstance(value, (_datetime, _date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value




__all__ = [
    'ClaimNoteIn',
    '_authorship',
    '_json_safe',
    '_may_read_notes',
    'add_claim_note',
    'faculty_report',
    'faculty_report_export',
    'list_claim_notes',
    'lookup_ticket',
    'reports_pack',
    'resolve_claim_note',
]
