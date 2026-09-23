"""Who heads each department: exactly one person, and never a head of nothing.

The college's rule (2026-09-23). A head of department is a faculty member who
also holds the post, so the post is a property of one account in one
department -- two heads is two people each told the department is theirs, and
a head with no department is a post with nothing to head (every `/hod/*`
screen answers 400 for one).

Enforced where roles are written -- the two account endpoints and the
`assign_heads` command -- rather than by a database constraint. The accounts
already in the database are what the command is for, and a constraint would
refuse to migrate the very data it exists to correct.

"Holds the post" means an *active* HOD account. An account that has been
switched off cannot sign in and heads nothing; switching it back on is a
change of post like any other and is checked the same way.
"""
from __future__ import annotations

import json

from core.models import AuditLog, Role, User


class NoDepartment(Exception):
    """A head needs a department to head."""


class HeadAlreadyAppointed(Exception):
    """The department has a head, and the caller did not ask to replace them."""

    def __init__(self, current: User, department: str):
        self.current = current
        self.department = department
        super().__init__(
            f"{current.name or current.email} is already head of {department}. "
            f"Replace them to make this account head instead — "
            f"{current.name or current.email} then becomes faculty."
        )


def department_of(user: User) -> str:
    return (user.department or "").strip()


def same_department(a: str | None, b: str | None) -> bool:
    """"CSE", "cse" and " CSE " are one department, typed three ways."""
    return (a or "").strip().casefold() == (b or "").strip().casefold()


def heads_of(department: str, *, excluding: User | None = None, lock: bool = False) -> list[User]:
    """Every active head of `department`, matched as the office types it.

    Compared in Python rather than with `iexact`, which would miss a stored
    value carrying a stray space -- and there are a few dozen heads at most.
    """
    qs = User.objects.filter(role=Role.HOD, active=True).order_by("created_at", "email")
    if lock:
        qs = qs.select_for_update()
    return [
        u for u in qs
        if same_department(u.department, department)
        and (excluding is None or u.pk != excluding.pk)
    ]


def appoint(
    user: User,
    *,
    replace: bool,
    actor: User | None,
    via: str,
) -> list[User]:
    """Check -- and, with `replace`, make -- `user` the only head of their department.

    Call inside the transaction that saves `user` as HOD, after its role and
    department are set on the instance but before it is saved. Raises
    `NoDepartment` or `HeadAlreadyAppointed`; with `replace`, demotes every
    other active head of the department to FACULTY instead, each with a
    `HOD_REPLACED` audit entry naming who took the post. Returns those demoted.
    """
    if not user.active:
        # Not holding the post, so not in anybody's way -- and not checked
        # until it is switched back on. Switching a stray head *off* must
        # never be refused for want of a department.
        return []
    department = department_of(user)
    if not department:
        raise NoDepartment(
            "A head of department needs a department. Set it before making "
            "this account head."
        )
    others = heads_of(department, excluding=user, lock=True)
    if not others:
        return []
    if not replace:
        raise HeadAlreadyAppointed(others[0], department)
    for previous in others:
        previous.role = Role.FACULTY
        previous.save(update_fields=["role", "updated_at"])
        AuditLog.objects.create(
            actor=actor,
            action="HOD_REPLACED",
            entity="User",
            entity_id=previous.id,
            detail_json=json.dumps({
                "department": department,
                "from": Role.HOD,
                "to": Role.FACULTY,
                "replaced_by": user.id,
                "replaced_by_email": user.email,
                "via": via,
            }),
        )
    return others
