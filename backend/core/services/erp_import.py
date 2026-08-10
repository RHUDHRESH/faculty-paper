"""Helpers for ERP Excel → Claim import (status mapping + dedupe)."""
from __future__ import annotations

import re

from core.models import Claim, ClaimStatus
from core.services.normalize import normalize_doi, normalize_title


def map_excel_status(raw: str | None, *, force_paid: bool = False) -> ClaimStatus:
    """Map free-text Excel Status (and Accounts presence) to ClaimStatus."""
    if force_paid:
        return ClaimStatus.PAID
    if not raw:
        return ClaimStatus.SUBMITTED
    s = str(raw).strip().lower()
    s = re.sub(r"\s+", " ", s)

    if any(k in s for k in ("reject", "denied", "not eligible", "ineligible")):
        return ClaimStatus.REJECTED
    if any(k in s for k in ("paid", "payment done", "disbursed", "settled", "accounts")):
        return ClaimStatus.PAID
    if "finance" in s and ("approv" in s or "ok" in s):
        return ClaimStatus.FINANCE_APPROVED
    if "principal" in s and ("approv" in s or "ok" in s):
        return ClaimStatus.PRINCIPAL_APPROVED
    if ("hod" in s or "head" in s) and ("approv" in s or "ok" in s):
        return ClaimStatus.HOD_APPROVED
    if "approv" in s:
        return ClaimStatus.HOD_APPROVED
    if any(k in s for k in ("draft", "pending edit", "incomplete")):
        return ClaimStatus.DRAFT
    return ClaimStatus.SUBMITTED


def claim_match_key(doi: str | None, staff_id: str | None, title: str | None) -> tuple[str, str]:
    """Return (kind, value) used for idempotent lookup."""
    nd = normalize_doi(doi) if doi else None
    if nd:
        return ("doi", nd)
    nt = normalize_title(title)
    sid = (staff_id or "").strip()
    return ("title_staff", f"{sid}::{nt}")


def find_existing_claim(
    *,
    doi: str | None = None,
    staff_id: str | None = None,
    title: str | None = None,
) -> Claim | None:
    """Find a Claim by DOI first, else staff_id + normalized title."""
    nd = normalize_doi(doi) if doi else None
    if nd:
        hit = Claim.objects.filter(doi__iexact=nd).order_by("created_at").first()
        if hit:
            return hit
    nt = normalize_title(title)
    if not nt:
        return None
    qs = Claim.objects.all()
    if staff_id:
        qs = qs.filter(staff_id=staff_id)
    for c in qs.iterator(chunk_size=200):
        if normalize_title(c.paper_title) == nt:
            return c
    return None


def stable_ticket(sheet: str, sno) -> str:
    """Stable ticket like ERP-PROCESSED-42 (max 32 chars)."""
    tag = re.sub(r"[^A-Za-z0-9]", "", str(sheet).upper())[:10] or "ERP"
    num = str(sno).strip() if sno is not None else "0"
    num = re.sub(r"[^0-9A-Za-z]", "", num)[:12] or "0"
    return f"ERP-{tag}-{num}"[:32]
