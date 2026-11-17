"""Personal API tokens, from the signed-in side.

A person lists, creates and revokes their own tokens here (session auth). The
secret is returned once, by the POST that makes it. The super admin can list
every token (never a secret), revoke any, and switch API access on or off per
role. The tokens themselves are used on /api/v1 (`core.api.v1`).
"""
from __future__ import annotations

import json
from typing import Optional

from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError

from core.api.common import api, rate_limit, require_user, session_auth
from core.models import ApiToken, AuditLog, Role, User
from core.services import api_tokens

__all__ = ["my_api_tokens", "create_my_api_token", "revoke_my_api_token",
           "admin_api_tokens", "admin_revoke_api_token", "admin_api_access"]


class TokenIn(Schema):
    name: str
    scopes: list[str]
    expires_in_days: Optional[int] = None


class AccessIn(Schema):
    role: str
    enabled: bool


def _scope_options(role: str) -> list[dict]:
    return [{"scope": s, "label": api_tokens.SCOPE_LABELS[s]} for s in api_tokens.scopes_for_role(role)]


def _audit(actor: User, action: str, token: ApiToken, **extra) -> None:
    AuditLog.objects.create(
        actor=actor, action=action, entity="ApiToken", entity_id=token.id,
        detail_json=json.dumps({"name": token.name, "prefix": token.prefix, "owner": token.user_id, **extra}),
    )


@api.get("/me/api-tokens", auth=session_auth)
def my_api_tokens(request: HttpRequest):
    user = require_user(request)
    tokens = ApiToken.objects.filter(user=user).order_by("-created_at")
    return {
        "enabled": api_tokens.role_enabled(user.role),
        "scope_options": _scope_options(user.role),
        "default_days": api_tokens.DEFAULT_LIFETIME_DAYS,
        "max_days": api_tokens.MAX_LIFETIME_DAYS,
        "rate_limit_per_minute": api_tokens.RATE_LIMIT,
        "tokens": [api_tokens.to_dict(t, owner=True) for t in tokens],
    }


@api.post("/me/api-tokens", auth=session_auth)
def create_my_api_token(request: HttpRequest, payload: TokenIn):
    user = require_user(request)
    if not api_tokens.role_enabled(user.role):
        raise HttpError(403, "API access is switched off for your role.")
    rate_limit(request, "api-token-create", 20, "hour", what="new tokens")
    try:
        token, secret = api_tokens.create(user, payload.name, payload.scopes, payload.expires_in_days)
    except ValueError as exc:
        raise HttpError(400, str(exc)) from None
    _audit(user, "API_TOKEN_CREATED", token, scopes=token.scopes)
    # The only time the secret leaves the server.
    return {"token": api_tokens.to_dict(token, owner=True), "secret": secret}


@api.delete("/me/api-tokens/{token_id}", auth=session_auth)
def revoke_my_api_token(request: HttpRequest, token_id: str):
    user = require_user(request)
    token = ApiToken.objects.filter(pk=token_id, user=user).first()
    if token is None:
        raise HttpError(404, "No such token.")
    api_tokens.revoke(token, user)
    _audit(user, "API_TOKEN_REVOKED", token)
    return {"ok": True, "token": api_tokens.to_dict(token, owner=True)}


def _super_admin(request: HttpRequest) -> User:
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only the super admin can manage everybody's API tokens.")
    return user


@api.get("/admin/api-tokens", auth=session_auth)
def admin_api_tokens(request: HttpRequest):
    _super_admin(request)
    rows = ApiToken.objects.select_related("user").order_by("-created_at")[:2000]
    return {
        "access": api_tokens.access_by_role(),
        "tokens": [
            {
                **api_tokens.to_dict(t, owner=True),
                "owner": {"id": t.user_id, "name": t.user.name, "email": t.user.email,
                          "role": t.user.role, "department": t.user.department},
            }
            for t in rows
        ],
    }


@api.delete("/admin/api-tokens/{token_id}", auth=session_auth)
def admin_revoke_api_token(request: HttpRequest, token_id: str):
    actor = _super_admin(request)
    token = ApiToken.objects.filter(pk=token_id).first()
    if token is None:
        raise HttpError(404, "No such token.")
    api_tokens.revoke(token, actor)
    _audit(actor, "API_TOKEN_REVOKED", token, by_admin=True)
    return {"ok": True}


#: Not under /admin/api-tokens/: that prefix ends in a {token_id} the word
#: "access" would be taken for.
@api.put("/admin/api-access", auth=session_auth)
def admin_api_access(request: HttpRequest, payload: AccessIn):
    actor = _super_admin(request)
    try:
        api_tokens.set_role_enabled(payload.role, payload.enabled, actor)
    except ValueError as exc:
        raise HttpError(400, str(exc)) from None
    AuditLog.objects.create(
        actor=actor, action="API_ACCESS_SWITCHED", entity="Role", entity_id=payload.role,
        detail_json=json.dumps({"enabled": payload.enabled}),
    )
    return {"access": api_tokens.access_by_role()}
