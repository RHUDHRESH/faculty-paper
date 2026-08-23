"""Take the demo "Director" title off the seeded admin account.

Three accounts on the live system mention Director. Two of them are real
members of staff whose job title genuinely is Physical Director, which is an
ordinary designation at an Indian engineering college and belongs to them.
Only the seeded super-admin carries a bare "Director" -- an artefact of the
demo fixture, on an account that is not a person.

So this removes one, names the two it is deliberately leaving, and refuses to
touch anything else.
"""
from __future__ import annotations

import csv
import http.cookiejar
import json
import urllib.request

BASE = "https://faculty-paper-self.vercel.app"
#: The demo account. Real staff are never matched by this.
TARGET = "admin@college.edu"


def session(email: str, password: str):
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(path, data=None, csrf=None, method=None):
        req = urllib.request.Request(
            BASE + path, method=method or ("POST" if data is not None else "GET")
        )
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
    # Django rotates the CSRF token on login, so the one used to sign in is
    # already stale for the next write — which comes back as a bare 403 that
    # looks like a permissions problem rather than a token one.
    return call, call("/api/auth/csrf")["csrfToken"]


def main() -> int:
    with open("staff-credentials.csv", encoding="utf-8-sig", newline="") as fh:
        admin = next(r for r in csv.DictReader(fh) if r["role"] == "SUPER_ADMIN")
    call, token = session(admin["email"], admin["password"])

    accounts = []
    offset = 0
    while True:
        page = call(f"/api/admin/data/User?limit=500&offset={offset}")
        accounts.extend(page["rows"])
        offset += len(page["rows"])
        if offset >= page["total"]:
            break

    changed = kept = 0
    for a in accounts:
        designation = (a.get("designation") or "").strip()
        if "director" not in designation.lower():
            continue
        if (a.get("email") or "").strip().lower() != TARGET:
            print(f"  kept   {a['email']:<40} {designation!r} — a real job title")
            kept += 1
            continue
        call(
            f"/api/admin/users/{a['id']}",
            {"designation": ""},
            csrf=token,
            method="PATCH",
        )
        print(f"  cleared {a['email']:<39} {designation!r} -> ''")
        changed += 1

    print(f"\n{changed} cleared, {kept} left alone.")

    # Read it back rather than trusting the write.
    after = []
    offset = 0
    while True:
        page = call(f"/api/admin/data/User?limit=500&offset={offset}")
        after.extend(page["rows"])
        offset += len(page["rows"])
        if offset >= page["total"]:
            break
    still = [
        a for a in after if (a.get("designation") or "").strip().lower() == "director"
    ]
    print(f"accounts still titled exactly 'Director': {len(still)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
