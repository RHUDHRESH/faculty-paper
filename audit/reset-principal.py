"""Give the Principal's account a password somebody actually holds.

It is the only account on the live system that is active, needed, and
unopenable: the issued password was changed at some point and the new one is
not recorded anywhere, so nobody can sign in as Principal — which is a step in
the payment chain.

Every other gap is left alone on purpose. Fifty-nine faculty accounts have no
password on record and are all inactive, so there is nothing to open. Three
active faculty set their own, which is the system working; resetting those
would lock a real person out to tidy a spreadsheet.
"""
from __future__ import annotations

import csv
import http.cookiejar
import json
import secrets
import urllib.error
import urllib.request

BASE = "https://faculty-paper-self.vercel.app"
TARGET = "principal@college.edu"


def opener():
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
        try:
            r = op.open(req, body, timeout=180)
            return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return e.code, {}

    return call


def main() -> int:
    with open("staff-credentials.csv", encoding="utf-8-sig", newline="") as fh:
        admin = next(r for r in csv.DictReader(fh) if r["role"] == "SUPER_ADMIN")

    call = opener()
    token = call("/api/auth/csrf")[1]["csrfToken"]
    call("/api/auth/login", {"email": admin["email"], "password": admin["password"]}, csrf=token)
    token = call("/api/auth/csrf")[1]["csrfToken"]  # rotated on login

    # Readable but not guessable: this gets typed by a person once, then
    # changed on first sign-in, which the reset flag forces.
    password = "Principal-" + secrets.token_hex(4)

    status, _ = call(
        "/api/admin/reset-password",
        {"email": TARGET, "password": password},
        csrf=token,
    )
    if status != 200:
        print(f"reset failed: HTTP {status}")
        return 1

    # Prove it, rather than assume it.
    fresh = opener()
    t = fresh("/api/auth/csrf")[1]["csrfToken"]
    ok = fresh("/api/auth/login", {"email": TARGET, "password": password}, csrf=t)[0]
    print(f"{TARGET}\n  password: {password}\n  signs in: {'yes' if ok == 200 else f'NO (HTTP {ok})'}")
    print("  the account will ask for a new password on first sign-in")

    # Record it where the other staff logins live, so the next status run
    # joins it up instead of reporting the same gap again.
    rows = []
    with open("staff-credentials.csv", encoding="utf-8-sig", newline="") as fh:
        rows = [r for r in csv.DictReader(fh)]
    fields = list(rows[0].keys())
    found = False
    for r in rows:
        if r["email"].strip().lower() == TARGET:
            r["password"] = password
            found = True
    if not found:
        rows.append({"email": TARGET, "role": "PRINCIPAL", "password": password})
    with open("staff-credentials.csv", "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print("  recorded in staff-credentials.csv (local, git-ignored)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
