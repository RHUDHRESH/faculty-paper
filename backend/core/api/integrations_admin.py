"""Super-admin: the keys and addresses the app uses to reach other services.

GET  /admin/integrations                    each service: status, masked key, usage, last test
PUT  /admin/integrations/{name}             save a value; empty clears it (the environment answers again)
POST /admin/integrations/{provider}/test    one cheap real call, answered ok/latency/message

A value is never returned once saved: a secret comes back as its last four
characters. The audit log records that a value was set, cleared or tested and
by whom, never the value itself (core/services/integrations.py holds the rules).
"""

from __future__ import annotations

import json
import time

from django.core.cache import cache
from django.http import HttpRequest
from ninja import Schema
from ninja.errors import HttpError
from pydantic import ConfigDict

from core.api.common import api, require_user, session_auth
from core.models import AuditLog, Role
from core.services import integration_checks, integrations

TESTS_PER_MINUTE = 10


def _super(request: HttpRequest):
    user = require_user(request)
    if user.role != Role.SUPER_ADMIN:
        raise HttpError(403, "Only a super admin can see or change integrations")
    return user


def _audit(user, action: str, target: str, **detail) -> None:
    # Names and outcomes only. The value is deliberately not an argument here.
    AuditLog.objects.create(
        actor=user, action=action, entity="integration", entity_id=target[:64],
        detail_json=json.dumps(detail),
    )


@api.get("/admin/integrations", auth=session_auth)
def integrations_list(request: HttpRequest):
    _super(request)
    return {"providers": integrations.all_states()}


class IntegrationIn(Schema):
    model_config = ConfigDict(extra="forbid")

    value: str = ""


@api.put("/admin/integrations/{name}", auth=session_auth)
def integrations_set(request: HttpRequest, name: str, payload: IntegrationIn):
    user = _super(request)
    if name not in integrations.SPECS:
        raise HttpError(404, "No such setting")
    try:
        outcome = integrations.set_value(name, payload.value, user)
    except integrations.Invalid as exc:
        raise HttpError(422, str(exc)) from exc
    _audit(
        user, "INTEGRATION_SET" if outcome == "set" else "INTEGRATION_CLEAR", name,
        name=name, secret=integrations.SPECS[name].secret,
    )
    return integrations.provider_state(integrations.SPECS[name].provider)


def _allow_test(user) -> None:
    """At most ten tests a minute per person: each one is a real call to a metered service."""
    key = f"integrations-test:{user.pk}:{int(time.time()) // 60}"
    cache.add(key, 0, 90)
    try:
        seen = cache.incr(key)
    except ValueError:
        cache.set(key, 1, 90)
        seen = 1
    if seen > TESTS_PER_MINUTE:
        raise HttpError(429, "That is ten tests in a minute. Wait a moment and try again.")


@api.post("/admin/integrations/{provider}/test", auth=session_auth)
def integrations_test(request: HttpRequest, provider: str):
    user = _super(request)
    if provider not in integration_checks.CHECKS:
        raise HttpError(404, "No such service")
    _allow_test(user)
    result = integration_checks.run(provider)
    _audit(user, "INTEGRATION_TEST", provider, provider=provider, ok=result["ok"])
    return {**result, "provider": integrations.provider_state(provider)}


__all__ = ["IntegrationIn", "integrations_list", "integrations_set", "integrations_test"]
