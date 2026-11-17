"""Bring your own API keys: each person's, and the super admin's view of them.

GET    /me/keys                       every service: status, masked last four, who is answering, usage, last test
PUT    /me/keys/{provider}            add or replace the person's key (a blank key keeps the saved one)
DELETE /me/keys/{provider}            remove it
POST   /me/keys/{provider}/test       one cheap real call on the saved key (ten a minute)
GET    /admin/keys/overview           super admin: how many people brought keys, and their counts (never a value)
PUT    /admin/keys/policy/{provider}  super admin: college | own_preferred | own_required

A value is never returned once saved. The audit log records that a key was
set, removed or tested, by whom and for which service, never the value.
The rules live in core/services/user_keys.py.
"""

from __future__ import annotations

import json
import time
from typing import Optional

from django.core.cache import cache
from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError
from pydantic import ConfigDict

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Role
from core.services import user_keys

TESTS_PER_MINUTE = 10

__all__ = ["KeyIn", "PolicyIn", "my_keys", "set_my_key", "clear_my_key", "test_my_key",
           "admin_keys_overview", "admin_set_key_policy"]


def _audit(user, action: str, target: str, **detail) -> None:
    # Names and outcomes only. A value is deliberately not an argument here.
    AuditLog.objects.create(
        actor=user, action=action, entity="user_key", entity_id=target[:64],
        detail_json=json.dumps(detail),
    )


def _known(provider: str) -> str:
    if provider not in user_keys.USER_PROVIDERS:
        raise HttpError(404, "No such service")
    return provider


class KeyIn(Schema):
    model_config = ConfigDict(extra="forbid")

    value: Optional[str] = None
    label: Optional[str] = None
    kind: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    mailto: Optional[str] = None
    inst_token: Optional[str] = None


class PolicyIn(Schema):
    model_config = ConfigDict(extra="forbid")

    policy: str


@api.get("/me/keys", auth=session_auth)
def my_keys(request: HttpRequest):
    user = require_user(request)
    return {"providers": user_keys.states_for(user), "policies": list(user_keys.POLICIES)}


@api.put("/me/keys/{provider}", auth=session_auth)
def set_my_key(request: HttpRequest, provider: str, payload: KeyIn):
    user = require_user(request)
    _known(provider)
    data = payload.model_dump(exclude_unset=True)
    had = user_keys.states_for(user)
    try:
        user_keys.save(user, provider, data)
    except user_keys.Invalid as exc:
        raise HttpError(422, str(exc)) from exc
    replaced = any(s["provider"] == provider and s["has_own_key"] for s in had)
    _audit(user, "USER_KEY_SET", provider, provider=provider, replaced=replaced)
    return next(s for s in user_keys.states_for(user) if s["provider"] == provider)


@api.delete("/me/keys/{provider}", auth=session_auth)
def clear_my_key(request: HttpRequest, provider: str):
    user = require_user(request)
    _known(provider)
    removed = user_keys.clear(user, provider)
    if removed:
        _audit(user, "USER_KEY_CLEAR", provider, provider=provider)
    return next(s for s in user_keys.states_for(user) if s["provider"] == provider)


def _allow_test(user) -> None:
    """At most ten tests a minute per person: each one is a real call to a metered service."""
    key = f"user-keys-test:{user.pk}:{int(time.time()) // 60}"
    cache.add(key, 0, 90)
    try:
        seen = cache.incr(key)
    except ValueError:
        cache.set(key, 1, 90)
        seen = 1
    if seen > TESTS_PER_MINUTE:
        raise HttpError(429, "That is ten tests in a minute. Wait a moment and try again.")


@api.post("/me/keys/{provider}/test", auth=session_auth)
def test_my_key(request: HttpRequest, provider: str):
    user = require_user(request)
    _known(provider)
    _allow_test(user)
    try:
        result = user_keys.run_test(user, provider)
    except LookupError as exc:
        raise HttpError(404, str(exc)) from exc
    _audit(user, "USER_KEY_TEST", provider, provider=provider, ok=bool(result["ok"]))
    return {**result, "provider": next(s for s in user_keys.states_for(user) if s["provider"] == provider)}


def _super(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can see or change who brings their own key")
    return user


@api.get("/admin/keys/overview", auth=session_auth)
def admin_keys_overview(request: HttpRequest):
    _super(request)
    return user_keys.overview()


@api.put("/admin/keys/policy/{provider}", auth=session_auth)
def admin_set_key_policy(request: HttpRequest, provider: str, payload: PolicyIn):
    user = _super(request)
    _known(provider)
    previous = user_keys.policy(provider)
    try:
        chosen = user_keys.set_policy(provider, payload.policy, user)
    except user_keys.Invalid as exc:
        raise HttpError(422, str(exc)) from exc
    _audit(user, "USER_KEY_POLICY", provider, provider=provider, policy=chosen, was=previous)
    return user_keys.overview()
