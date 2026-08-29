"""The institution's own facts, held as data rather than as code.

A fresh install of this product at another college must be able to state its
own name, its own sign-in note and its own contact address without anybody
touching a line of Python. That is all this module holds: the white-label
layer. Secrets stay in the environment, workflow rules stay in the versioned
payout policy, and the three strings here are the ones an office owns.

The default is Saveetha Engineering College, which is where this system was
built and whose data it already carries -- so the first release changes
nothing for them, and the second college changes one field in a setup form.
"""

from __future__ import annotations

import re
from typing import Any

from django.core.exceptions import ValidationError
from django.core.validators import validate_email

from core.models import SystemSetting

#: The default institution. Every key here is surfaced to the setup wizard and
#: the admin settings screen; anything not in this list is refused, because a
#: generic key/value store quietly becomes a second configuration system that
#: nothing documents.
DEFAULTS: dict[str, str] = {
    "college_name": "Saveetha Engineering College",
    "sign_in_note": "",
    "support_email": "",
}

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def get(key: str) -> str:
    """One institution string, from the database or the built-in default."""
    if key not in DEFAULTS:
        raise KeyError(f"unknown institution setting {key!r}")
    try:
        row = SystemSetting.objects.get(pk=key)
    except SystemSetting.DoesNotExist:
        return DEFAULTS[key]
    value = row.value.get("v")
    return value if isinstance(value, str) and value else DEFAULTS[key]


def public() -> dict[str, str]:
    """Everything an unauthenticated page may show (the sign-in screen)."""
    return {key: get(key) for key in ("college_name", "sign_in_note", "support_email")}


def validate(mapping: dict[str, Any]) -> dict[str, str]:
    """Check a proposed change against the whitelist and each key's shape."""
    errors: dict[str, str] = {}
    clean: dict[str, str] = {}
    for key, value in mapping.items():
        if key not in DEFAULTS:
            errors[key] = "This is not a setting the system knows."
            continue
        if value is None:
            value = ""
        if not isinstance(value, str):
            errors[key] = "Expected text."
            continue
        value = value.strip()
        if key == "college_name":
            if not (2 <= len(value) <= 200):
                errors[key] = "The college name is between 2 and 200 characters."
        elif key == "sign_in_note":
            if len(value) > 300:
                errors[key] = "Keep the sign-in note under 300 characters."
        elif key == "support_email" and value:
            if not _EMAIL_RE.match(value):
                errors[key] = "That does not look like an email address."
            else:
                try:
                    validate_email(value)
                except ValidationError:
                    errors[key] = "That does not look like an email address."
        clean[key] = value
    return {"errors": errors, "clean": clean}


def set_values(mapping: dict[str, Any], actor) -> dict[str, str]:
    """Apply a validated change and return the full public state."""
    checked = validate(mapping)
    if checked["errors"]:
        raise ValueError(checked["errors"])
    for key, value in checked["clean"].items():
        SystemSetting.objects.update_or_create(
            pk=key, defaults={"value": {"v": value}, "updated_by": actor}
        )
    return public()
