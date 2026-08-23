"""Normalise department spellings, then give each department a head.

A head's screen is scoped by the department string on their account, matched
against the string on each faculty account. So two spellings of one
department are two departments as far as the system is concerned, and each
head would see half their own staff without anything on screen saying so.
Five of them were split that way, covering eighty-nine people.

The minority spelling is folded into the majority one -- that is a data-entry
correction, and it goes through the audited user editor rather than the
database.
"""
from __future__ import annotations

import collections
import csv
import json
import re
import secrets
import string
import sys
import urllib.error
import urllib.request
import http.cookiejar

BASE = "https://faculty-paper-self.vercel.app"
OUT = "hod-credentials.csv"

#: Below this, a "department" is usually one or two people on a research
#: attachment rather than a teaching department with a head.
MIN_STAFF = 5

jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
_csrf: str | None = None


def call(path, data=None, method=None):
    global _csrf
    req = urllib.request.Request(BASE + path, method=method or ("POST" if data else "GET"))
    req.add_header("Referer", BASE)
    if _csrf:
        req.add_header("X-CSRFToken", _csrf)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    try:
        r = op.open(req, body, timeout=180)
        return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}


def refresh_csrf():
    global _csrf
    _csrf = call("/api/auth/csrf")[1]["csrfToken"]


def fold(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower())


def password() -> str:
    # No O0oIl1: these get read off a screen and typed by hand.
    alphabet = "".join(
        c for c in string.ascii_letters + string.digits if c not in "O0oIl1"
    )
    return "".join(secrets.choice(alphabet) for _ in range(14))


def main() -> int:
    admin = next(
        r
        for r in csv.DictReader(open("staff-credentials.csv", encoding="utf-8-sig"))
        if r["role"] == "SUPER_ADMIN"
    )
    refresh_csrf()
    status, me = call(
        "/api/auth/login", {"email": admin["email"], "password": admin["password"]}
    )
    if status != 200:
        print("Could not sign in as the super admin")
        return 1
    refresh_csrf()

    users = call("/api/admin/data/User?limit=600")[1]["rows"]
    faculty = [u for u in users if u["role"] == "FACULTY" and u["department"]]
    counts = collections.Counter(u["department"] for u in faculty)

    # ---- fold the split spellings ------------------------------------
    groups: dict[str, list[tuple[str, int]]] = collections.defaultdict(list)
    for name, n in counts.items():
        groups[fold(name)].append((name, n))

    moved = 0
    for spellings in groups.values():
        if len(spellings) < 2:
            continue
        keep = max(spellings, key=lambda s: s[1])[0]
        for name, _ in spellings:
            if name == keep:
                continue
            for u in [x for x in faculty if x["department"] == name]:
                refresh_csrf()
                s, _b = call(
                    f"/api/admin/users/{u['id']}", {"department": keep}, method="PATCH"
                )
                if s == 200:
                    moved += 1
                    u["department"] = keep
            print(f"  folded {name!r} into {keep!r}")
    print(f"{moved} accounts moved onto the majority spelling\n")

    counts = collections.Counter(u["department"] for u in faculty)
    wanted = sorted(d for d, n in counts.items() if n >= MIN_STAFF)
    existing = {
        (u["department"] or "").strip(): u for u in users if u["role"] == "HOD"
    }

    rows = []
    for department in wanted:
        if department in existing:
            print(f"  {department}: a head already exists, left alone")
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", department.lower()).strip("-")
        # The college already issues hod.<dept>@saveetha.ac.in to its real
        # heads -- two of those addresses belong to serving faculty -- so the
        # portal login uses its own prefix rather than colliding with a person.
        email = f"dept-head.{slug}@saveetha.ac.in"
        pw = password()
        refresh_csrf()
        status, body = call(
            "/api/admin/users",
            {
                "email": email,
                "name": f"Head of {department}",
                "password": pw,
                "role": "HOD",
                "department": department,
            },
        )
        if status != 200:
            print(f"  {department}: {status} {str(body.get('detail'))[:70]}")
            continue
        rows.append({
            "department": department,
            "staff": counts[department],
            "email": email,
            "password": pw,
        })
        print(f"  {department}: {email}")

    if rows:
        with open(OUT, "w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            writer.writeheader()
            writer.writerows(rows)
        print(f"\n{len(rows)} heads created — credentials in {OUT}")

    skipped = sorted(d for d, n in counts.items() if n < MIN_STAFF)
    if skipped:
        print(
            f"\n{len(skipped)} groupings under {MIN_STAFF} staff got no head "
            "(mostly research attachments rather than teaching departments):"
        )
        print("  " + ", ".join(skipped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
