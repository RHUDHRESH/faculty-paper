"""The college's Faculty_List.xlsx, brought into the app (check first, then import).

The workbook has an "Academic" and a "Research" sheet, one row per person.
Sheets and columns are found by their header text, so blank rows, blank
columns and a moved column do not matter.

What it does, per person:

* the FacultyMaster row (keyed by Staff-ID) is created or brought up to date,
  and the whole sheet row is kept in its `raw_json`;
* a person who already has an account (found by Staff-ID, else email) gets the
  current designation and a phone number when the list has one, and a Scopus
  id, email or Staff-ID only where the account has none. A different Scopus id
  or email is never overwritten: it is listed as a conflict for a person to
  settle. Role, password and active are never touched;
* a person with no account and a valid email gets a faculty account with a
  random one-time password (the Issue-passwords generator), returned once in
  `credentials` by a real run; a check never makes or returns one;
* a person with no account and no usable email is listed as needing one.

Nobody is deactivated or deleted. Running it twice changes nothing the second
time. A check (dry run) rolls back everything it did, except that each conflict
is noted for the Data conflicts screen (`import_conflicts`) by both steps.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from typing import IO, Any

from django.contrib.auth.hashers import make_password
from django.db import transaction

from core.models import FacultyMaster, Role, User
from core.management.commands.sync_faculty_users import pick_email
from core.services.fyp_roster import staff_key
from core.services.import_conflicts import note_conflicts
from core.services.issue_passwords import HASHER, new_password
from core.services.scopus import author_profile_url
from core.services.scopus_profiles import normalize_scopus_id

SHEETS = ("Academic", "Research")
#: Header text (letters and digits only, lower case) -> the name used here.
COLUMNS = {
    "sno": "sno",
    "department": "department",
    "bioid": "bio_id",
    "staffid": "staff_id",
    "scopusid": "scopus_id",
    "doj": "doj",
    "nameofthestaff": "name",
    "designation": "designation",
    "phonenumber": "phone",
    "certificate": "certificate",
    "phdpursuing": "phd_pursuing",
    "emailid": "email",
    "title": "title",
    "currentdesignation": "current_designation",
}
_ADDRESS = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_DOJ = re.compile(r"(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})")
_RND = re.compile(r"\s*[-–—]\s*R\s*&\s*D\s*$", re.IGNORECASE)


def _k(value: Any) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _text(value: Any) -> str:
    """A cell as clean text; whole-number floats lose their ".0"."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, (dt.datetime, dt.date)):
        return value.date().isoformat() if isinstance(value, dt.datetime) else value.isoformat()
    text = re.sub(r"[ \t]+", " ", str(value).strip())
    return "" if text.lower() in ("nan", "none", "null", "-", "--") else text


def is_junk_address(address: str) -> bool:
    """A placeholder, not somebody's address: ends in .local, imported.local, @example."""
    a = (address or "").lower()
    return a.endswith(".local") or "imported.local" in a or "@example" in a


def real_addresses(value: Any) -> list[str]:
    """Every real address in text, lower case; none for junk such as "m.phil., ph.d.,"."""
    return [a.lower() for a in _ADDRESS.findall(str(value or "")) if not is_junk_address(a)]


def _email(value: Any) -> str:
    """The address to use out of a cell (the college one if there are two); "" when none."""
    picked = pick_email(_text(value))
    return picked if picked and not is_junk_address(picked) else ""


def parse_doj(value: Any) -> str | None:
    """The first dd.mm.yyyy in a free-text joining-date cell, as an ISO date."""
    if isinstance(value, dt.datetime):
        return value.date().isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    for m in _DOJ.finditer(_text(value)):
        d, mth, y = (int(g) for g in m.groups())
        try:
            return dt.date(y, mth, d).isoformat()
        except ValueError:
            continue
    return None


def read_faculty_list(source: str | IO[bytes]) -> list[dict[str, Any]]:
    """One entry per person (a person on both sheets is merged).

    Keys: staff_id, name, email, phone, designation, current_designation,
    department, bio_id, scopus_id, doj_raw, doj, research (on the Research
    sheet), sheets, row (every column as text, by header).
    """
    import openpyxl

    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    try:
        by_name = {_k(ws.title): ws for ws in wb.worksheets}
        people: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        found_sheet = False
        for sheet in SHEETS:
            ws = by_name.get(_k(sheet))
            if ws is None:
                continue
            found_sheet = True
            rows = list(ws.iter_rows(values_only=True))
            header_at, cols = None, {}
            for i, row in enumerate(rows[:20]):
                cand = {COLUMNS[_k(v)]: j for j, v in enumerate(row) if _k(v) in COLUMNS}
                if "staff_id" in cand and "name" in cand:
                    header_at, cols = i, cand
                    break
            if header_at is None:
                raise ValueError(f'The "{sheet}" sheet has no row with "Staff-ID" and "Name of the Staff".')
            headers = {name: _text(rows[header_at][j]) or name for name, j in cols.items()}
            for raw in rows[header_at + 1:]:
                def get(name: str):
                    j = cols.get(name)
                    return raw[j] if j is not None and j < len(raw) else None

                staff, name = _text(get("staff_id")), _text(get("name"))
                if not staff and not name:
                    continue
                entry = {
                    "staff_id": staff,
                    "name": name,
                    "email": _email(get("email")),
                    "phone": _text(get("phone")),
                    "designation": _text(get("designation")),
                    "current_designation": _text(get("current_designation")),
                    "department": _text(get("department")),
                    "bio_id": _text(get("bio_id")),
                    "scopus_id": normalize_scopus_id(get("scopus_id")) or "",
                    "doj_raw": _text(get("doj")),
                    "doj": parse_doj(get("doj")),
                    "research": sheet == "Research",
                    "sheets": [sheet],
                    "row": {headers[n]: _text(get(n)) for n in cols},
                }
                key = staff_key(staff) or f"row:{sheet}:{len(order)}"
                if key in people:
                    first = people[key]
                    for field, value in entry.items():
                        if field in ("research", "sheets", "row"):
                            continue
                        if not first.get(field) and value:
                            first[field] = value
                    first["research"] = first["research"] or entry["research"]
                    first["sheets"] = [*first["sheets"], sheet]
                    first["row"] = {**entry["row"], **{k: v for k, v in first["row"].items() if v}}
                else:
                    people[key] = entry
                    order.append(key)
        if not found_sheet:
            raise ValueError('The workbook has no "Academic" or "Research" sheet.')
        return [people[k] for k in order]
    finally:
        wb.close()


def _clean_department(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


class _Departments:
    """The department spellings the college already uses, matched without case."""

    def __init__(self) -> None:
        self.known: dict[str, str] = {}
        counts: dict[str, int] = {}
        for d in User.objects.exclude(department__isnull=True).exclude(department="").values_list("department", flat=True):
            counts[d] = counts.get(d, 0) + 1
        # The most used spelling wins when two differ only in case.
        for d, _n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
            self.known.setdefault(_clean_department(d).casefold(), d)

    def resolve(self, given: str) -> str:
        given = _clean_department(given)
        if not given:
            return ""
        # The college's own code for any spelling the list uses ("Maths" is
        # S&H-MATHS, "TRG" is TRAINING); see core/services/data_fill.py.
        from core.services.data_fill import canonical_department

        code = canonical_department(given)
        if code:
            return code
        stripped = _clean_department(_RND.sub("", given))
        for candidate in (given, stripped):
            hit = self.known.get(candidate.casefold())
            if hit:
                return hit
        self.known[given.casefold()] = given
        return given


def _same(a: Any, b: Any) -> bool:
    return (a or "") == (b or "")


def import_faculty_list(people: list[dict[str, Any]], *, dry_run: bool = True, filename: str = "") -> dict[str, Any]:
    """Apply (or, with dry_run, only count) the list. See the module docstring."""
    out: dict[str, Any] = {
        "dry_run": dry_run,
        "sheets": {s: {"people": 0} for s in SHEETS},
        "counts": {"created": 0, "updated": 0, "unchanged": 0, "conflicts": 0, "needs_email": 0,
                   "master_created": 0, "master_updated": 0},
        "created": [],
        #: One-time logins for the accounts created by a real run, never by a check.
        #: Only in this return value: not stored, logged or audited.
        "credentials": [],
        "updated_fields": {"designation": 0, "phone": 0, "scopus_author_id": 0, "email": 0, "staff_id": 0},
        "conflicts": [],
        "needs_email": [],
        "skipped": [],
        "not_in_list": 0,
    }
    for p in people:
        for s in p["sheets"]:
            out["sheets"][s]["people"] += 1

    with transaction.atomic():
        users = list(User.objects.all())
        by_staff = {staff_key(u.staff_id): u for u in users if staff_key(u.staff_id)}
        by_mail = {(u.email or "").strip().lower(): u for u in users if (u.email or "").strip()}
        masters = {m.staff_id: m for m in FacultyMaster.objects.exclude(staff_id__isnull=True)}
        master_by_key = {staff_key(k): m for k, m in masters.items()}
        departments = _Departments()
        listed_staff: set[str] = set()
        listed_mail: set[str] = set()

        for p in people:
            staff = p["staff_id"]
            if not staff:
                out["skipped"].append({"name": p["name"], "reason": "no Staff-ID"})
                if p["email"]:
                    listed_mail.add(p["email"])
                continue
            listed_staff.add(staff_key(staff))
            if p["email"]:
                listed_mail.add(p["email"])
            designation = (p["current_designation"] or p["designation"])[:128]
            department = departments.resolve(p["department"])
            phone = p["phone"][:32]
            scopus = p["scopus_id"]
            changed_any = False

            # (a) the master row
            raw = json.dumps(
                {**p["row"], "doj_raw": p["doj_raw"], "doj_date": p["doj"], "sheets": p["sheets"]},
                sort_keys=True, ensure_ascii=False,
            )[:50000]
            fields = {
                "department": department or None,
                "biometric_id": p["bio_id"][:64] or None,
                "scopus_author_id": scopus or None,
                "name": p["name"][:255],
                "designation": designation or None,
                "email": p["email"] or None,
                "phone": phone or None,
                "raw_json": raw,
            }
            master = master_by_key.get(staff_key(staff))
            if master is None:
                master = FacultyMaster(staff_id=staff[:64], **fields)
                master.save()
                master_by_key[staff_key(staff)] = master
                out["counts"]["master_created"] += 1
                changed_any = True
            elif any(not _same(getattr(master, k), v) for k, v in fields.items()):
                for k, v in fields.items():
                    setattr(master, k, v)
                master.save()
                out["counts"]["master_updated"] += 1
                changed_any = True

            # (b) an existing account
            user = by_staff.get(staff_key(staff)) or (by_mail.get(p["email"]) if p["email"] else None)
            if user is not None:
                dirty: list[str] = []
                if designation and not _same(user.designation, designation):
                    user.designation = designation
                    dirty.append("designation")
                    out["updated_fields"]["designation"] += 1
                if phone and not _same(user.phone, phone):
                    user.phone = phone
                    dirty.append("phone")
                    out["updated_fields"]["phone"] += 1
                if scopus:
                    have = normalize_scopus_id(user.scopus_author_id) or normalize_scopus_id(user.scopus_author_url)
                    if not have:
                        user.scopus_author_id = scopus
                        dirty.append("scopus_author_id")
                        out["updated_fields"]["scopus_author_id"] += 1
                        if not (user.scopus_author_url or "").strip():
                            user.scopus_author_url = author_profile_url(scopus)
                            dirty.append("scopus_author_url")
                    elif have != scopus:
                        out["conflicts"].append({"staff_id": staff, "name": p["name"], "field": "scopus_author_id",
                                                 "current": have, "incoming": scopus})
                if p["email"]:
                    cur = (user.email or "").strip().lower()
                    held = real_addresses(cur)
                    if not held:
                        # Nothing usable on the account (junk text or a placeholder): the list's address replaces it.
                        if p["email"] not in by_mail:
                            by_mail.pop(cur, None)
                            user.email = p["email"]
                            by_mail[p["email"]] = user
                            dirty.append("email")
                            out["updated_fields"]["email"] += 1
                        else:
                            out["conflicts"].append({"staff_id": staff, "name": p["name"], "field": "email",
                                                     "current": cur, "incoming": p["email"]})
                    elif p["email"] not in held:
                        out["conflicts"].append({"staff_id": staff, "name": p["name"], "field": "email",
                                                 "current": cur, "incoming": p["email"]})
                if not (user.staff_id or "").strip():
                    user.staff_id = staff[:64]
                    dirty.append("staff_id")
                    out["updated_fields"]["staff_id"] += 1
                    by_staff[staff_key(staff)] = user
                elif staff_key(user.staff_id) != staff_key(staff):
                    out["conflicts"].append({"staff_id": staff, "name": p["name"], "field": "staff_id",
                                             "current": user.staff_id, "incoming": staff})
                if dirty:
                    user.save(update_fields=dirty)
                    changed_any = True
                out["counts"]["updated" if changed_any else "unchanged"] += 1
                continue

            # (d) nobody to sign in: master row only
            if not p["email"]:
                out["needs_email"].append({"staff_id": staff, "name": p["name"]})
                continue

            # (c) a new faculty account
            faculty_type = "RESEARCH" if p["research"] else "REGULAR"
            new = User(
                email=p["email"], name=p["name"][:255] or p["email"], role=Role.FACULTY, active=True,
                department=department or None, staff_id=staff[:64], biometric_id=p["bio_id"][:64] or None,
                designation=designation or None, phone=phone or None, faculty_type=faculty_type,
                scopus_author_id=scopus or None,
                scopus_author_url=author_profile_url(scopus) if scopus else None,
                must_change_password=False,
            )
            if dry_run:
                new.set_unusable_password()  # a check never makes a password
            else:
                password = new_password()
                new.password = make_password(password, hasher=HASHER)
                out["credentials"].append({"staff_id": staff, "name": p["name"], "email": p["email"],
                                           "password": password})
            new.save()
            by_staff[staff_key(staff)] = new
            by_mail[p["email"]] = new
            out["counts"]["created"] += 1
            out["created"].append({"staff_id": staff, "name": p["name"], "email": p["email"],
                                   "faculty_type": faculty_type, "department": department})

        out["counts"]["conflicts"] = len(out["conflicts"])
        out["counts"]["needs_email"] = len(out["needs_email"])
        out["not_in_list"] = sum(
            1 for u in User.objects.filter(active=True).only("staff_id", "email")
            if staff_key(u.staff_id) not in listed_staff and (u.email or "").strip().lower() not in listed_mail
        )
        if dry_run:
            transaction.set_rollback(True)
    # Both steps note each conflict for the Data conflicts screen, once, by key.
    note_conflicts("faculty", out["conflicts"], filename)
    return out
