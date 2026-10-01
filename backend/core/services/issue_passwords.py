"""Issue fresh one-time passwords to a chosen group of accounts.

One function behind both doors: `POST /api/admin/passwords/issue` (a super
admin, in the browser) and `manage.py reset_faculty_passwords` (a shell). The
accounts were created by an import that generated passwords and threw them
away, so nobody but the super admin can sign in; this hands the one copy back.

The rules live here so the two cannot drift apart:

- The account issuing them, holding records (`@saveetha.invalid`) and, unless
  named one by one, other super admins are never touched.
- Accounts that have left are left alone unless asked for.
- Every issued password is flagged `must_change_password`, so it lasts until
  the person signs in once. A locked account is unlocked with it.
- The passwords exist only in the returned rows. They are not stored, not
  logged and not written to the audit row.
"""
from __future__ import annotations

import io
import secrets
import string
from collections import Counter
from typing import Iterable

from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.db.models import QuerySet

from core.models import Role, User
from core.services.cell_safe import csv_writer

#: Ambiguous characters are left out: these get read off a paper and typed.
ALPHABET = "".join(c for c in (string.ascii_letters + string.digits) if c not in "O0oIl1")
FIELDS = ["email", "name", "role", "department", "staff_id", "password"]
HEADERS = ["Email", "Name", "Role", "Department", "Staff ID", "Password"]

WHO = ("no_password_yet", "all", "role", "department", "ids")
HOLDING_SUFFIX = "@saveetha.invalid"
HASHER = "pbkdf2_sha256_issued"


class ScopeError(ValueError):
    """The scope asked for is not one that can be run."""


def new_password() -> str:
    """12 to 14 characters, from the system's secure generator."""
    length = 12 + secrets.randbelow(3)
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def scope_queryset(
    who: str,
    *,
    role: str | None = None,
    department: str | None = None,
    ids: Iterable[str] | None = None,
    include_inactive: bool = False,
    actor: User | None = None,
) -> QuerySet[User]:
    """The accounts a scope names, after every exclusion."""
    if who not in WHO:
        raise ScopeError(f"Choose who to issue passwords to: {', '.join(WHO)}.")
    qs = User.objects.all().exclude(email__iendswith=HOLDING_SUFFIX)
    if not include_inactive:
        qs = qs.filter(active=True)
    if actor is not None:
        qs = qs.exclude(pk=actor.pk)

    if who == "ids":
        listed = [str(i) for i in (ids or []) if i]
        if not listed:
            raise ScopeError("Name at least one account.")
        return qs.filter(pk__in=listed).order_by("email")

    # Every other scope leaves the other super admins out: a bulk reset of a
    # role or a department must not lock out the people who run the system.
    qs = qs.exclude(role=Role.SUPER_ADMIN)
    if who == "no_password_yet":
        qs = qs.filter(last_login__isnull=True)
    elif who == "role":
        if role not in Role.values:
            raise ScopeError("Choose a role.")
        qs = qs.filter(role=role)
    elif who == "department":
        if not (department or "").strip():
            raise ScopeError("Choose a department.")
        qs = qs.filter(department__iexact=(department or "").strip())
    return qs.order_by("email")


def preview(qs: QuerySet[User]) -> dict:
    """What a real run would touch, without touching it."""
    rows = list(qs.values_list("role", "department"))
    by_role = Counter(r for r, _ in rows)
    by_department = Counter((d or "").strip() or "No department" for _, d in rows)
    return {
        "count": len(rows),
        "by_role": [
            {"role": k, "count": v} for k, v in sorted(by_role.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "by_department": [
            {"department": k, "count": v}
            for k, v in sorted(by_department.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
    }


def issue(qs: QuerySet[User], *, limit: int = 0) -> list[dict]:
    """Give each account a new password and return the one copy of each."""
    from core.api.auth import clear_login_lockout

    users = list(qs[:limit] if limit else qs)
    rows: list[dict] = []
    with transaction.atomic():
        for user in users:
            pw = new_password()
            user.password = make_password(pw, hasher=HASHER)
            user.must_change_password = True
            rows.append(
                {
                    "email": user.email,
                    "name": user.name or "",
                    "role": user.role,
                    "department": user.department or "",
                    "staff_id": user.staff_id or "",
                    "password": pw,
                }
            )
        User.objects.bulk_update(users, ["password", "must_change_password"], batch_size=200)
    # After the commit: a rolled-back run must not have unlocked anybody.
    for user in users:
        clear_login_lockout(user.email)
    return rows


def to_csv(rows: list[dict]) -> str:
    """The sign-in list, for Excel: a byte-order mark first, no cell a formula."""
    buf = io.StringIO()
    w = csv_writer(buf, lineterminator="\n")
    w.writerow(HEADERS)
    for r in rows:
        w.writerow([r[f] for f in FIELDS])
    return "﻿" + buf.getvalue()
