"""One file saying, per account, whether the password we hold still opens it.

A plain list of passwords would be a lie by now. Django stores a PBKDF2 hash,
so no current password can be read back from the database by anybody -- and
five people have set their own since the accounts were issued, which makes
the issued value wrong for them and right for everyone else.

So this joins three things: the accounts that actually exist in production,
the passwords that were issued, and the must_change_password flag, which is
only cleared when somebody sets their own. The result tells you which rows you
can hand out and which you cannot.

The output stays local and is gitignored, like the files it reads.
"""
from __future__ import annotations

import csv
import http.cookiejar
import json
import sys
import urllib.error
import urllib.request

BASE = "https://faculty-paper-self.vercel.app"
OUT = "account-credentials-status.csv"


def session(email: str, password: str):
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(path, data=None, csrf=None):
        req = urllib.request.Request(BASE + path, method="POST" if data else "GET")
        req.add_header("Referer", BASE)
        if csrf:
            req.add_header("X-CSRFToken", csrf)
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            req.add_header("Content-Type", "application/json")
        r = op.open(req, body, timeout=180)
        return json.loads(r.read().decode() or "{}")

    token = call("/api/auth/csrf")["csrfToken"]
    call("/api/auth/login", {"email": email, "password": password}, csrf=token)
    return call


def _still_opens(email: str, password: str) -> bool:
    """Does this password actually sign in? Asked, not assumed."""
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(path, data=None, csrf=None):
        req = urllib.request.Request(BASE + path, method="POST" if data else "GET")
        req.add_header("Referer", BASE)
        if csrf:
            req.add_header("X-CSRFToken", csrf)
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            req.add_header("Content-Type", "application/json")
        try:
            r = op.open(req, body, timeout=120)
            return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, {}

    token = call("/api/auth/csrf")[1]["csrfToken"]
    return call("/api/auth/login", {"email": email, "password": password}, csrf=token)[0] == 200


def read(path: str) -> dict[str, dict]:
    try:
        with open(path, encoding="utf-8-sig", newline="") as fh:
            return {row["email"].strip().lower(): row for row in csv.DictReader(fh)}
    except FileNotFoundError:
        return {}


def main() -> int:
    staff = read("staff-credentials.csv")
    admin = next(
        (r for r in staff.values() if r.get("role") == "SUPER_ADMIN"), None
    )
    if not admin:
        print("No super-admin row in staff-credentials.csv to read production with")
        return 1

    call = session(admin["email"], admin["password"])
    faculty = read("faculty-credentials.csv")
    issued = {**faculty, **staff}

    accounts: list[dict] = []
    offset = 0
    while True:
        page = call(f"/api/admin/data/User?limit=500&offset={offset}")
        accounts.extend(page["rows"])
        offset += len(page["rows"])
        if offset >= page["total"]:
            break

    rows = []
    for a in sorted(accounts, key=lambda x: (x.get("role") or "", x.get("name") or "")):
        email = (a.get("email") or "").strip().lower()
        record = issued.get(email)
        never_changed = bool(a.get("must_change_password"))
        if record and never_changed:
            state = "Issued password still in force"
            password = record.get("password", "")
        elif record and not never_changed:
            # The flag alone is not proof: it is cleared when somebody sets
            # their own password, but an account created without it never had
            # it set in the first place. There are only a handful of these, so
            # the recorded password is tried rather than guessed about.
            if _still_opens(record["email"], record["password"]):
                state = "Issued password still in force (verified by signing in)"
                password = record.get("password", "")
            else:
                state = "Changed by the user — issued password no longer valid"
                password = ""
        elif never_changed:
            state = "No password on record — must be reset to be usable"
            password = ""
        else:
            state = "Set by the user — nothing on record"
            password = ""
        rows.append({
            "email": a.get("email"),
            "name": a.get("name"),
            "role": a.get("role"),
            "department": a.get("department"),
            "staff_id": a.get("staff_id"),
            "active": "yes" if a.get("active") else "no",
            "password_state": state,
            "password_if_known": password,
        })

    with open(OUT, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    from collections import Counter

    tally = Counter(r["password_state"] for r in rows)
    print(f"{len(rows)} accounts written to {OUT}")
    for state, count in tally.most_common():
        print(f"  {count:>4}  {state}")
    print()
    print(
        "No current password can be read back from the database: they are stored "
        "as PBKDF2 hashes. Rows with a blank password need a reset to become usable."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
