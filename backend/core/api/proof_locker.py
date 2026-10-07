"""The proof locker: a person's evidence files, with automatic checks."""
from __future__ import annotations

from typing import Any, Optional

from django.db import transaction
from django.http import HttpRequest
from ninja import File, Form, Schema
from ninja.errors import HttpError
from ninja.files import UploadedFile

from core.api.common import api, require_user, session_auth
from core.models import AttachmentKind, Claim, ClaimAttachment, ClaimStatus, ProofFile, Publication
from core.services import proof_locker, rbac


def proof_to_dict(p: ProofFile) -> dict[str, Any]:
    checks = proof_locker.checks_of(p)
    return {
        "id": p.id,
        "kind": p.kind,
        "filename": p.filename,
        "url": proof_locker.url_of(p),
        "size": p.size,
        "content_hash": p.content_hash,
        "publication_id": p.publication_id,
        "publication_title": p.publication.title if p.publication_id else None,
        "doi_found": p.doi_found or None,
        "title_found": p.title_found or None,
        "checks": checks,
        "worst": _worst(checks),
        "checked_at": p.checked_at.isoformat() if p.checked_at else None,
        "created_at": p.created_at.isoformat(),
        "used_on": list(
            ClaimAttachment.objects.filter(claim__owner_id=p.owner_id, content_hash=p.content_hash)
            .values_list("claim_id", flat=True).distinct()
        ),
    }


def _worst(checks: list[dict]) -> str:
    order = ["bad", "warn", "unknown", "ok"]
    statuses = {c.get("status") for c in checks}
    return next((s for s in order if s in statuses), "unknown")


def _own(request: HttpRequest, proof_id: str) -> ProofFile:
    user = require_user(request)
    proof = ProofFile.objects.select_related("publication").filter(id=proof_id, owner=user).first()
    if proof is None:
        raise HttpError(404, "Not found")
    return proof


@api.get("/me/proofs", auth=session_auth)
def list_proofs(request: HttpRequest):
    user = require_user(request)
    rows = ProofFile.objects.filter(owner=user).select_related("publication")
    return {"items": [proof_to_dict(p) for p in rows]}


@api.post("/me/proofs", auth=session_auth)
def add_proof(
    request: HttpRequest,
    file: UploadedFile = File(...),
    kind: str = Form("ARTICLE"),
    publication_id: Optional[str] = Form(None),
):
    user = require_user(request)
    if not rbac.can_issue_claims(user.role):
        raise HttpError(403, "Forbidden")
    try:
        proof, created = proof_locker.add(user, file, kind.upper(), publication_id or None)
    except proof_locker.ProofError as exc:
        raise HttpError(400, str(exc)) from exc
    return {**proof_to_dict(proof), "already_in_locker": not created}


@api.post("/me/proofs/{proof_id}/recheck", auth=session_auth)
def recheck_proof(request: HttpRequest, proof_id: str):
    proof = _own(request, proof_id)
    return proof_to_dict(proof_locker.check(proof))


class ProofPatch(Schema):
    kind: Optional[str] = None
    publication_id: Optional[str] = None
    clear_publication: bool = False


@api.patch("/me/proofs/{proof_id}", auth=session_auth)
def update_proof(request: HttpRequest, proof_id: str, payload: ProofPatch):
    proof = _own(request, proof_id)
    if payload.kind is not None:
        if payload.kind.upper() not in ProofFile.Kind.values:
            raise HttpError(400, "Unknown kind")
        proof.kind = payload.kind.upper()
    if payload.clear_publication:
        proof.publication = None
    elif payload.publication_id:
        pub = Publication.objects.filter(id=payload.publication_id).first()
        if pub is None:
            raise HttpError(400, "That paper was not found")
        proof.publication = pub
    proof.save(update_fields=["kind", "publication"])
    return proof_to_dict(proof_locker.check(proof))


@api.delete("/me/proofs/{proof_id}", auth=session_auth)
def delete_proof(request: HttpRequest, proof_id: str):
    proof = _own(request, proof_id)
    filed = (
        ClaimAttachment.objects.filter(claim__owner_id=proof.owner_id, content_hash=proof.content_hash)
        .exclude(claim__status=ClaimStatus.DRAFT)
        .select_related("claim")
        .first()
    )
    if filed:
        raise HttpError(
            409,
            f"This file is on claim {filed.claim.ticket_number or filed.claim_id}, which has been filed. "
            "It stays so the office can read it.",
        )
    # The stored bytes stay: a draft may still point at them.
    proof.delete()
    return {"ok": True}


class AttachProofIn(Schema):
    proof_id: str
    role: str = "article"
    ref_number: Optional[str] = None
    ref_title: Optional[str] = None


@api.post("/claims/{claim_id}/attach-proof", auth=session_auth)
def attach_proof(request: HttpRequest, claim_id: str, payload: AttachProofIn):
    user = require_user(request)
    claim = Claim.objects.filter(id=claim_id, owner=user).first()
    if claim is None:
        raise HttpError(404, "Not found")
    if claim.status != ClaimStatus.DRAFT:
        raise HttpError(409, "Files can only be added while the claim is a draft")
    proof = _own(request, payload.proof_id)
    role = payload.role.lower()
    if role not in ("article", "reference"):
        raise HttpError(400, "Role must be article or reference")
    kind = AttachmentKind.PUBLISHED_PAPER if role == "article" else AttachmentKind.SEC_REFERENCE
    url = proof_locker.url_of(proof)
    with transaction.atomic():
        if kind == AttachmentKind.PUBLISHED_PAPER:
            claim.attachments.filter(kind=kind).exclude(url=url).delete()
        row, _ = ClaimAttachment.objects.get_or_create(
            claim=claim, url=url, kind=kind,
            defaults={
                "filename": proof.filename,
                "size_bytes": proof.size,
                "content_hash": proof.content_hash,
                "ref_number": (payload.ref_number or "").strip()[:32] or None if role == "reference" else None,
                "ref_title": (payload.ref_title or "").strip() or None if role == "reference" else None,
                "uploaded_by": user,
            },
        )
        if kind == AttachmentKind.PUBLISHED_PAPER:
            claim.proof_url = url
            claim.save(update_fields=["proof_url"])
        elif not claim.sec_proof_url:
            claim.sec_proof_url = url
            claim.save(update_fields=["sec_proof_url"])
    return {
        "attachment_id": row.id,
        "url": row.url,
        "kind": row.kind,
        "filename": row.filename,
        "size_bytes": row.size_bytes,
        "content_hash": row.content_hash,
        "checks": proof_locker.checks_of(proof),
    }


__all__ = ["list_proofs", "add_proof", "recheck_proof", "update_proof", "delete_proof", "attach_proof",
           "proof_to_dict"]
