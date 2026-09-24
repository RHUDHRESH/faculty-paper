"""The three eligibility conditions a claimant confirms before filing.

The college's legal protection: every filed claim carries a record of who
confirmed which condition text, for which article, when, and from where.
Change the wording here (and in frontend2/src/ui/eligibility.tsx, which shows
it) and bump ``CONDITIONS_VERSION``; a filing that ticked an older version is
refused and the form asks again.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Iterable

from django.http import HttpRequest
from django.utils import timezone
from ninja.errors import HttpError

CONDITIONS_VERSION = "2026-09"

CONDITION_IDS = ("indexed", "no-duplicate", "documents")


def condition_texts(min_references: int) -> dict[str, str]:
    return {
        "indexed": "The article is indexed in Scopus and appears on my own Scopus Author Profile",
        "no-duplicate": "No incentive claim has been filed for this article before",
        "documents": (
            "I have the published article PDF and the SEC-affiliated cited reference PDFs ready to upload"
            f" ({min_references} cited references authored by Saveetha Engineering College faculty,"
            " each with its reference number)"
        ),
    }


def _parse_when(raw: Any) -> datetime | None:
    if not raw:
        return None
    try:
        when = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    if timezone.is_naive(when):
        when = timezone.make_aware(when)
    return when


def validate(confirmations: Iterable[Any] | None) -> dict[str, datetime]:
    """Refuse unless all three current conditions were ticked. Returns id -> ticked_at."""
    got: dict[str, datetime] = {}
    for c in confirmations or []:
        data = c.dict() if hasattr(c, "dict") else dict(c)
        if data.get("id") not in CONDITION_IDS or data.get("text_version") != CONDITIONS_VERSION:
            continue
        when = _parse_when(data.get("ticked_at"))
        if when is None:
            continue
        got[data["id"]] = when
    missing = [i for i in CONDITION_IDS if i not in got]
    if missing:
        raise HttpError(
            400,
            "Confirm the three eligibility conditions for this article before filing it "
            f"(missing or out of date: {', '.join(missing)}).",
        )
    return got


def _client_ip(request: HttpRequest) -> str | None:
    fwd = request.META.get("HTTP_X_FORWARDED_FOR")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (request.META.get("REMOTE_ADDR") or "")[:64] or None


def record(request: HttpRequest, claim, user, ticked: dict[str, datetime], min_references: int) -> None:
    """Store the acceptance on the claim and in the audit log."""
    from core.models import AuditLog, ClaimConfirmation

    texts = condition_texts(min_references)
    ip = _client_ip(request)
    agent = (request.META.get("HTTP_USER_AGENT") or "")[:512]
    rows = [
        ClaimConfirmation(
            claim=claim,
            user=user,
            condition_id=cid,
            text_version=CONDITIONS_VERSION,
            text=texts[cid],
            doi=claim.doi,
            paper_title=claim.paper_title,
            ticked_at=ticked[cid],
            ip_address=ip,
            user_agent=agent,
        )
        for cid in CONDITION_IDS
    ]
    ClaimConfirmation.objects.bulk_create(rows)
    AuditLog.objects.create(
        actor=user,
        action="CLAIM_CONDITIONS_ACCEPTED",
        entity="Claim",
        entity_id=claim.id,
        detail_json=json.dumps(
            {
                "text_version": CONDITIONS_VERSION,
                "doi": claim.doi,
                "paper_title": claim.paper_title,
                "owner_id": claim.owner_id,
                "ip": ip,
                "user_agent": agent,
                "conditions": [
                    {"id": r.condition_id, "text": r.text, "ticked_at": r.ticked_at.isoformat()} for r in rows
                ],
            }
        ),
    )


def for_claim(claim) -> list[dict[str, Any]]:
    """The latest accepted set, for claim detail."""
    rows = list(claim.confirmations.order_by("-recorded_at")[: len(CONDITION_IDS)])
    return [
        {
            "id": r.condition_id,
            "text_version": r.text_version,
            "text": r.text,
            "ticked_at": r.ticked_at.isoformat(),
            "recorded_at": r.recorded_at.isoformat() if r.recorded_at else None,
            "user_id": r.user_id,
        }
        for r in rows
    ]
