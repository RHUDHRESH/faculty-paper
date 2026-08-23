"""Issue a fresh password to every head of department, and write them all down.

Run after setup_hods.py, or any time the file is lost. These are new accounts
nobody has signed into yet, so a reset costs nothing; once a head sets their
own password this file goes stale for them, which is what
account-credentials-status.csv is for.
"""
from __future__ import annotations

import csv
import http.cookiejar
import json
import secrets
import string
import urllib.error
import urllib.request

BASE = "https://faculty-paper-self.vercel.app"
OUT = "hod-credentials.csv"

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


def password() -> str:
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
    if call("/api/auth/login", {"email": admin["email"], "password": admin["password"]})[0] != 200:
        print("Could not sign in as the super admin")
        return 1
    refresh_csrf()

    users = call("/api/admin/data/User?limit=600")[1]["rows"]
    heads = sorted(
        (u for u in users if u["role"] == "HOD"),
        key=lambda u: (u.get("department") or ""),
    )
    faculty = [u for u in users if u["role"] == "FACULTY" and u["department"]]

    rows = []
    for head in heads:
        pw = password()
        refresh_csrf()
        status, body = call(
            "/api/admin/reset-password", {"email": head["email"], "password": pw}
        )
        if status != 200:
            print(f"  {head['email']}: {status} {str(body.get('detail'))[:60]}")
            continue
        rows.append({
            "department": head["department"],
            "staff_in_department": sum(
                1 for f in faculty if f["department"] == head["department"]
            ),
            "name": head["name"],
            "email": head["email"],
            "password": pw,
        })

    with open(OUT, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    print(f"{len(rows)} heads written to {OUT}\n")
    for r in rows:
        print(f"  {r['department']:18} {r['staff_in_department']:>3} staff  {r['email']}")
    print(
        "\nEach is asked to set their own password on first sign-in, after which "
        "the value here stops working."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
