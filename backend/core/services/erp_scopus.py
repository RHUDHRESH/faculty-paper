"""Every faculty member's Scopus author id, taken from the ERP workbook.

The ERP workbook (Publication_Processing_ERP_*.xlsx) carries a Scopus ID per
person on `Faculty_Data` (the roster) and per paper row on Process /
Processed / Accounts / Master_List_Accounts. The roster wins; a paper sheet is
used only for a person the roster gives no id, and only when that person's
rows agree on one id (the most frequent one otherwise, reported).

An account is found by Staff-ID, then Bio-ID, then email. An account that
already carries a *different* id is never overwritten: it is reported as a
conflict for a person to settle. Running it twice changes nothing.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import IO, Any

from django.db import transaction

from core.models import User
from core.services.fyp_roster import staff_key
from core.services.scopus import author_profile_url
from core.services.scopus_profiles import normalize_scopus_id

PAPER_SHEETS = ("Process", "Processed", "Accounts", "Master_List_Accounts")


def _k(value: Any) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _text_id(value: Any) -> str:
    """Staff/Bio id cells: 17506.0 -> "17506"."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return str(value).strip()


def _rows(ws) -> tuple[dict[str, int], list[tuple]]:
    it = ws.iter_rows(values_only=True)
    for _ in range(10):
        header = next(it, None)
        if header is None:
            return {}, []
        cols = {_k(v): i for i, v in enumerate(header) if _k(v)}
        if "scopusid" in cols:
            return cols, list(it)
    return {}, []


def _col(cols: dict[str, int], *names: str) -> int | None:
    for n in names:
        if n in cols:
            return cols[n]
    return None


def read_erp_scopus(source: str | IO[bytes]) -> list[dict[str, str]]:
    """One entry per person: staff_id, bio_id, email, name, scopus_id, source."""
    import openpyxl

    wb = openpyxl.load_workbook(source, read_only=True, data_only=True)
    people: dict[str, dict[str, str]] = {}
    names = {ws.title: ws for ws in wb.worksheets}
    if "Faculty_Data" in names:
        cols, rows = _rows(names["Faculty_Data"])
        c_staff, c_bio = _col(cols, "staffid", "facultyid"), _col(cols, "bioid", "biometricid")
        c_sid, c_mail, c_name = cols["scopusid"], _col(cols, "emailid", "email"), _col(cols, "nameofthestaff", "facultyname")
        for r in rows:
            get = lambda c: r[c] if c is not None and c < len(r) else None  # noqa: E731
            staff, bio = _text_id(get(c_staff)), _text_id(get(c_bio))
            if not (staff or bio):
                continue
            key = staff_key(staff) or f"bio:{bio}"
            people[key] = {
                "staff_id": staff, "bio_id": bio, "email": str(get(c_mail) or "").strip().lower(),
                "name": str(get(c_name) or "").strip(), "scopus_id": normalize_scopus_id(get(c_sid)) or "",
                "source": "Faculty_Data",
            }
    seen: dict[str, Counter] = defaultdict(Counter)
    extra: dict[str, dict[str, str]] = {}
    for title in PAPER_SHEETS:
        if title not in names:
            continue
        cols, rows = _rows(names[title])
        c_staff, c_bio, c_sid = _col(cols, "facultyid", "staffid"), _col(cols, "biometricid", "bioid"), cols["scopusid"]
        c_name = _col(cols, "facultyname")
        for r in rows:
            get = lambda c: r[c] if c is not None and c < len(r) else None  # noqa: E731
            staff, bio, sid = _text_id(get(c_staff)), _text_id(get(c_bio)), normalize_scopus_id(get(c_sid))
            if not sid or not (staff or bio):
                continue
            key = staff_key(staff) or f"bio:{bio}"
            seen[key][sid] += 1
            extra.setdefault(key, {"staff_id": staff, "bio_id": bio, "email": "",
                                   "name": str(get(c_name) or "").strip()})
    for key, counts in seen.items():
        person = people.get(key)
        if person and person["scopus_id"]:
            continue
        sid = counts.most_common(1)[0][0]
        src = "paper sheets" + (" (disagree)" if len(counts) > 1 else "")
        if person:
            person.update(scopus_id=sid, source=src)
        else:
            people[key] = {**extra[key], "scopus_id": sid, "source": src}
    return [p for p in people.values() if p["scopus_id"]]


def link_scopus_ids(entries: list[dict[str, str]], *, dry_run: bool = False) -> dict[str, Any]:
    """Set User.scopus_author_id / _url. Counts: set, same, conflicts, unmatched."""
    by_staff: dict[str, User] = {}
    by_bio: dict[str, User] = {}
    by_mail: dict[str, User] = {}
    for u in User.objects.all():
        if u.staff_id:
            by_staff.setdefault(staff_key(u.staff_id), u)
        if u.biometric_id:
            by_bio.setdefault(_text_id(u.biometric_id), u)
        by_mail.setdefault((u.email or "").strip().lower(), u)
    out: dict[str, Any] = {"entries": len(entries), "set": 0, "same": 0, "conflicts": [], "unmatched": []}
    with transaction.atomic():
        for e in entries:
            u = (
                (e["staff_id"] and by_staff.get(staff_key(e["staff_id"])))
                or (e["bio_id"] and by_bio.get(e["bio_id"]))
                or (e["email"] and by_mail.get(e["email"]))
            )
            if not u:
                out["unmatched"].append({k: e[k] for k in ("staff_id", "bio_id", "name", "scopus_id")})
                continue
            have = normalize_scopus_id(u.scopus_author_id) or normalize_scopus_id(u.scopus_author_url)
            if have == e["scopus_id"]:
                changed = []
                if u.scopus_author_id != have:
                    u.scopus_author_id = have
                    changed.append("scopus_author_id")
                if not (u.scopus_author_url or "").strip():
                    u.scopus_author_url = author_profile_url(have)
                    changed.append("scopus_author_url")
                if changed and not dry_run:
                    u.save(update_fields=changed)
                out["same"] += 1
            elif have:
                out["conflicts"].append({"user": u.name, "staff_id": u.staff_id, "account": have,
                                         "erp": e["scopus_id"], "source": e["source"]})
            else:
                u.scopus_author_id = e["scopus_id"]
                if not (u.scopus_author_url or "").strip():
                    u.scopus_author_url = author_profile_url(e["scopus_id"])
                if not dry_run:
                    u.save(update_fields=["scopus_author_id", "scopus_author_url"])
                out["set"] += 1
        if dry_run:
            transaction.set_rollback(True)
    return out
