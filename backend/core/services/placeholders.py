"""Accounts and department words that stand for nobody.

The old ERP workbooks wrote "Not Found" where they could not match a claim to
a person, and the import (`import_erp_excel`) made an inactive account to
own those claims, named "Not Found" with the department "Not Found". It is
data, not a person: it must never be offered as somebody to congratulate, as
a department to filter by, or as a row on a directory. The claims it owns are
real and stay on the data-fix list as "Claimant not identified".

One place decides what counts, so the wall, the department lists, the budget,
the flags and the directories cannot each guess differently.
"""
from __future__ import annotations

import re
from functools import lru_cache, reduce
from operator import or_
from typing import Optional

from django.db.models import Q

#: What a workbook writes when it has no value.
NOT_A_VALUE = ("Not Found", "Unknown", "N/A", "NA", "None", "Nil", "Not recorded", "Not available", "-")

#: The shown word for a claim whose owner is the placeholder.
UNIDENTIFIED = "Claimant not identified"

_KEYS = {re.sub(r"[^a-z0-9]+", "", v.casefold()) for v in NOT_A_VALUE} - {""}
_KEYS |= {"departmentnotrecorded"}


@lru_cache(maxsize=8192)
def _key(value: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]+", "", (value or "").casefold())


def is_placeholder_name(name: Optional[str]) -> bool:
    """A person's name that is really "no name"."""
    text = (name or "").strip()
    return bool(text) and (_key(text) in _KEYS or not _key(text))


def is_not_a_department(value: Optional[str]) -> bool:
    """A department word that is really "no department" (blank counts)."""
    return not (value or "").strip() or _key(value) in _KEYS or not _key(value)


def clean_department(value: Optional[str]) -> str:
    """The department as written, or "" when it is not one."""
    return "" if is_not_a_department(value) else (value or "").strip()


def clean_name(name: Optional[str]) -> str:
    """A person's name, or "" when it is the placeholder."""
    return "" if is_placeholder_name(name) else (name or "").strip()


def placeholder_q(prefix: str = "") -> Q:
    """Rows whose account (at `prefix`, e.g. "owner__") is the placeholder."""
    return reduce(or_, (Q(**{f"{prefix}name__iexact": v}) for v in NOT_A_VALUE))


def real_people(queryset, prefix: str = ""):
    """`queryset` without the placeholder accounts."""
    return queryset.exclude(placeholder_q(prefix))
