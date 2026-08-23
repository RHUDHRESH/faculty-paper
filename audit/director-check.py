"""Who carries "Director" on the live system, and in what sense.

Asked before anything is changed, because "remove Director from everything"
is a different instruction depending on the answer: a demo designation left
on a seeded account is noise to delete, and a real member of staff whose job
title is Physical Director is not.
"""
from __future__ import annotations

import csv
import http.cookiejar
import json
import urllib.request

BASE = "https://faculty-paper-self.vercel.app"


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
    return call, token


def main() -> int:
    with open("staff-credentials.csv", encoding="utf-8-sig", newline="") as fh:
        admin = next(r for r in csv.DictReader(fh) if r["role"] == "SUPER_ADMIN")
    call, _ = session(admin["email"], admin["password"])

    accounts = []
    offset = 0
    while True:
        page = call(f"/api/admin/data/User?limit=500&offset={offset}")
        accounts.extend(page["rows"])
        offset += len(page["rows"])
        if offset >= page["total"]:
            break

    hits = [
        a
        for a in accounts
        if "director" in ((a.get("designation") or "") + " " + (a.get("name") or "")).lower()
    ]
    print(f"{len(accounts)} live accounts; {len(hits)} mention Director\n")
    for a in hits:
        print(f"  {a.get('email'):<40} {a.get('role'):<12} {a.get('designation')!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
