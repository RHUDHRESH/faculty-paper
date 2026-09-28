"""What a well-formed identifier looks like, checked where people type them.

Two layers, deliberately different in strength:

* `normalise_*` run on every save (core.apps connects `normalise_on_save` to
  pre_save). They only ever tidy: trim, lowercase an email, strip a DOI's
  resolver prefix, reduce a Scopus id to its digits. They never refuse, so an
  import or a job writing legacy data cannot start failing because of them.
* `check_user_fields` / `check_claim` refuse, with a message a person can act
  on. They are called by the API endpoints where a person types the value
  (account create/edit, filing and editing a claim), not by imports.
"""
from __future__ import annotations

import math
import re
from typing import Any, Iterable, Optional

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.utils import timezone

from core.services.normalize import normalize_doi, normalize_issn

DOI_SHAPE = re.compile(r"^10\.\d+(\.\d+)*/\S+$")
ISSN_SHAPE = re.compile(r"^\d{4}-\d{3}[\dX]$")
EID_SHAPE = re.compile(r"^2-s2\.0-\d+$")
LOCAL_ID_SHAPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/_.\-]{0,63}$")
SCOPUS_ID_SHAPE = re.compile(r"^\d{5,15}$")
ORCID_SHAPE = re.compile(r"^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$")

ID_FIELDS = ("staff_id", "biometric_id", "employee_id")


class FieldProblem(ValueError):
    def __init__(self, field: str, message: str):
        super().__init__(message)
        self.field = field
        self.message = message


# ------------------------------------------------------------ normalise --


def _trim(v: Any) -> Any:
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def normalise_scopus_id(v: Optional[str]) -> Optional[str]:
    if not v:
        return v
    text = v.strip()
    if re.fullmatch(r"\d+\.0+", text):
        text = text.split(".")[0]
    m = re.search(r"authorId=(\d+)", text)
    if m:
        text = m.group(1)
    return text or None


def normalise_issn_field(v: Optional[str]) -> Optional[str]:
    """An ISSN tidied only when the tidy form is a well-formed ISSN; lists left alone."""
    if not v or not v.strip():
        return None if v is not None else v
    if re.search(r"[,;/]", v):
        return v.strip()
    clean = normalize_issn(v)
    return clean if clean and ISSN_SHAPE.match(clean) else v.strip()


def normalise_user(u) -> None:
    if u.email:
        u.email = u.email.strip().lower()
    for f in ID_FIELDS:
        setattr(u, f, _trim(getattr(u, f)))
    u.scopus_author_id = normalise_scopus_id(_trim(u.scopus_author_id))
    if u.orcid_id:
        u.orcid_id = u.orcid_id.strip().upper() or None


def normalise_claim(c) -> None:
    if c.doi is not None:
        c.doi = normalize_doi(c.doi)
    c.eid = _trim(c.eid)
    c.issn = normalise_issn_field(c.issn)
    for f in ("staff_id", "biometric_id"):
        setattr(c, f, _trim(getattr(c, f)))
    c.scopus_author_id = normalise_scopus_id(_trim(c.scopus_author_id))


def normalise_publication(p) -> None:
    if p.doi is not None:
        p.doi = normalize_doi(p.doi)
    p.eid = _trim(p.eid)
    p.title = (p.title or "").strip()


def normalise_on_save(sender, instance, raw=False, **kwargs) -> None:
    """pre_save hook. `raw` (loaddata) is left exactly as exported."""
    if raw:
        return
    name = sender.__name__
    if name == "User":
        normalise_user(instance)
    elif name == "Claim":
        normalise_claim(instance)
    elif name == "Publication":
        normalise_publication(instance)
    elif name == "PaidLedger":
        instance.staff_id = _trim(instance.staff_id)
        instance.biometric_id = _trim(instance.biometric_id)


# --------------------------------------------------------------- refuse --


def check_email(v: Optional[str]) -> None:
    try:
        validate_email(v or "")
    except ValidationError:
        raise FieldProblem("email", f"'{v}' is not an email address.")


def check_local_id(field: str, v: Optional[str]) -> None:
    if v and not LOCAL_ID_SHAPE.match(v):
        label = field.replace("_", " ")
        raise FieldProblem(field, f"A {label} is letters and digits (with - / _ . allowed), up to 64 characters; '{v}' is not.")


def check_scopus_id(v: Optional[str]) -> None:
    if v and not SCOPUS_ID_SHAPE.match(v):
        raise FieldProblem("scopus_author_id", f"A Scopus author id is 5 to 15 digits, like 57193456789; '{v}' is not.")


def check_orcid(v: Optional[str]) -> None:
    if not v:
        return
    if not ORCID_SHAPE.match(v):
        raise FieldProblem("orcid_id", "An ORCID iD is sixteen characters, like 0000-0002-1825-0097.")
    digits = v.replace("-", "")
    total = 0
    for ch in digits[:-1]:
        total = (total + int(ch)) * 2
    check = (12 - total % 11) % 11
    if digits[-1] != ("X" if check == 10 else str(check)):
        raise FieldProblem("orcid_id", "That ORCID iD does not add up; check it against orcid.org.")


def check_doi(v: Optional[str]) -> None:
    if v and not DOI_SHAPE.match(v):
        raise FieldProblem("doi", f"'{v}' is not a DOI. A DOI starts with 10., then a slash, like 10.1016/j.jclepro.2024.01.001.")


def check_issn(v: Optional[str]) -> None:
    if not v:
        return
    for part in re.split(r"[,;/]\s*|\s+", v.strip()):
        if part and not ISSN_SHAPE.match(normalize_issn(part) or ""):
            raise FieldProblem("issn", f"'{part}' is not an ISSN. An ISSN is eight characters, like 0272-8842.")


def check_eid(v: Optional[str]) -> None:
    if v and not EID_SHAPE.match(v):
        raise FieldProblem("eid", f"'{v}' is not a Scopus EID. It looks like 2-s2.0-85123456789.")


def check_year(field: str, v: Optional[int]) -> None:
    if v is None:
        return
    latest = timezone.localdate().year + 1
    if not 1950 <= int(v) <= latest:
        raise FieldProblem(field, f"The year must be between 1950 and {latest}; {v} is not.")


def check_amount(field: str, v: Optional[float]) -> None:
    if v is None:
        return
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        raise FieldProblem(field, "An amount must be a number.")
    if v < 0:
        raise FieldProblem(field, "An amount cannot be negative.")


def check_user_fields(data: dict[str, Any]) -> None:
    """For an account create or edit: the fields present in `data`, already normalised."""
    if "email" in data:
        check_email(data["email"])
    for f in ID_FIELDS:
        if f in data:
            check_local_id(f, _trim(data[f]))
    if "scopus_author_id" in data:
        check_scopus_id(normalise_scopus_id(_trim(data["scopus_author_id"])))
    if "orcid_id" in data:
        check_orcid((data["orcid_id"] or "").strip().upper() or None)


def check_claim(c) -> None:
    """For a claim a person filed or edited, after the payload is applied."""
    normalise_claim(c)
    check_doi(c.doi)
    check_issn(c.issn)
    check_eid(c.eid)
    check_year("publication_year", c.publication_year)
    check_amount("self_reported_snip", c.self_reported_snip)
    if c.total_authors is not None and c.total_authors < 1:
        raise FieldProblem("total_authors", "A paper has at least one author.")
    if c.author_position is not None and c.author_position < 1:
        raise FieldProblem("author_position", "Author positions start at 1.")
    if c.total_authors and c.author_position and c.author_position > c.total_authors:
        raise FieldProblem(
            "author_position",
            f"Author position {c.author_position} is past the {c.total_authors} authors the paper has.",
        )


def as_http(fn, *args) -> None:
    """Run a check and turn its problem into the API's 400."""
    from ninja.errors import HttpError

    try:
        fn(*args)
    except FieldProblem as p:
        raise HttpError(400, p.message)


__all__: Iterable[str] = [
    "FieldProblem", "normalise_on_save", "check_user_fields", "check_claim", "as_http",
]
