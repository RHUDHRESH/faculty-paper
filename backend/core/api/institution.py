"""The institution's identity, the admin settings screen, and first-run setup.

Three pieces of the product layer:

- ``GET /institution`` -- the college's name and sign-in note, public, so the
  sign-in screen and the shell can carry the college's own name instead of a
  string some developer hardcoded. This endpoint existing is what makes the
  same build installable at a second college.
- ``GET/PUT /admin/settings`` -- the office edits those strings here rather
  than asking anybody to redeploy.
- ``GET /setup/status`` and ``POST /setup`` -- first-run setup. On an empty
  system (no accounts at all) the setup form creates the college's identity
  and its first super-admin with a real password, so a new install never
  needs ``manage.py seed`` -- which exists for development and would put
  known passwords into a real college's production.

Once one account exists, setup is finished forever: the status endpoint says
so and the POST refuses. There is no path from the internet into an
already-running college's accounts through this door.
"""

from __future__ import annotations

import json
import logging

from django.db import transaction
from django.http import HttpRequest
from ninja import Schema
from pydantic import ConfigDict
from ninja.errors import HttpError

from core.api.common import api, logger, rate_limit_for, session_auth
from core.api.deps import require_user
from core.models import AuditLog, FormulaConfig, User
from core.services import institution, rbac

logger = logging.getLogger("core.api")


class SetupStatusOut(Schema):
    needs_setup: bool


@api.get("/setup/status", auth=None)
def setup_status(request: HttpRequest) -> SetupStatusOut:
    return SetupStatusOut(needs_setup=not User.objects.exists())


class SetupIn(Schema):
    college_name: str
    admin_name: str
    admin_email: str
    admin_password: str


@api.post("/setup", auth=None)
def setup(request: HttpRequest, payload: SetupIn):
    # Keyed by address, and a small window: this endpoint exists for one
    # afternoon in a deployment's life.
    rate_limit_for(None, "setup", 5, "hour", what="setup attempts")

    if User.objects.exists():
        # A system with accounts has an owner. Say so rather than 403, so the
        # sentence names the actual situation.
        raise HttpError(409, "This system already has accounts — setup is finished.")

    college_name = payload.college_name.strip()
    admin_name = payload.admin_name.strip()
    admin_email = payload.admin_email.strip().lower()
    if not (2 <= len(college_name) <= 200):
        raise HttpError(422, "The college name is between 2 and 200 characters.")
    if not admin_name:
        raise HttpError(422, "Give the first administrator a name.")
    if "@" not in admin_email or "." not in admin_email:
        raise HttpError(422, "That does not look like an email address.")
    # The founder's password guards every account in the college, so it is
    # held to a longer minimum than the validators ask of a reset password.
    if len(payload.admin_password) < 12:
        raise HttpError(422, "The administrator password needs at least 12 characters.")

    with transaction.atomic():
        admin = User.objects.create_user(
            email=admin_email,
            password=payload.admin_password,
            name=admin_name,
            role="SUPER_ADMIN",
            department=None,
            active=True,
            must_change_password=False,
        )
        institution.set_values({"college_name": college_name}, admin)
        # A brand-new system needs a payout policy to compute against; the
        # model's defaults are the documented starting rates.
        if not FormulaConfig.objects.filter(active=True).exists():
            FormulaConfig.objects.create(active=True)
        AuditLog.objects.create(
            actor=admin,
            action="Set up the system",
            entity="system",
            detail_json=json.dumps({"college_name": college_name, "admin": admin_email}),
        )
    logger.info("system_setup college=%s admin=%s", college_name, admin_email)
    return {"ok": True, "email": admin_email}


@api.get("/institution", auth=None)
def institution_public(request: HttpRequest):
    return institution.public()


class SettingsOut(Schema):
    college_name: str
    sign_in_note: str
    support_email: str


@api.get("/admin/settings", auth=session_auth)
def get_settings(request: HttpRequest):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    return institution.public()


class SettingsIn(Schema):
    # An unknown key is refused rather than quietly dropped: a client that
    # sends "mascot" is either buggy or probing, and the whitelist only means
    # something if it is the whole surface.
    model_config = ConfigDict(extra="forbid")

    college_name: str | None = None
    sign_in_note: str | None = None
    support_email: str | None = None


@api.put("/admin/settings", auth=session_auth)
def put_settings(request: HttpRequest, payload: SettingsIn):
    user = require_user(request)
    if not rbac.can_admin_portal(user.role):
        raise HttpError(403, "Forbidden")
    changes = {k: v for k, v in payload.dict().items() if v is not None}
    try:
        state = institution.set_values(changes, user)
    except ValueError as exc:
        raise HttpError(422, "; ".join(next(iter(exc.args)))) from exc
    AuditLog.objects.create(
        actor=user,
        action="Updated the institution settings",
        entity="system_setting",
        detail_json=json.dumps(changes),
    )
    return state


__all__ = [
    "SettingsIn",
    "SettingsOut",
    "SetupIn",
    "SetupStatusOut",
    "get_settings",
    "institution_public",
    "put_settings",
    "setup",
    "setup_status",
]
