"""Every door a faculty account can push on, and what should happen.

Not a smoke test: this asks whether the boundary holds. For each endpoint it
states what a claimant is entitled to do, calls it as a claimant, and reports
anything that answered differently. A 404 where 403 was expected is still a
refusal; a 200 where a refusal was expected is a hole.

Run against the local dev server, or pass a base URL for a deployed one.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import http.cookiejar

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
EMAIL = sys.argv[2] if len(sys.argv) > 2 else "faculty@college.edu"
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "faculty123"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
_csrf: str | None = None


def call(path: str, method: str = "GET", data=None):
    global _csrf
    url = BASE + path
    req = urllib.request.Request(url, method=method)
    req.add_header("Referer", BASE)
    if _csrf:
        req.add_header("X-CSRFToken", _csrf)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    try:
        r = opener.open(req, body, timeout=60)
        raw = r.read().decode(errors="replace")
        try:
            return r.status, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return r.status, {"_raw": raw[:120]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return e.code, {"_raw": raw[:120]}
    except Exception as e:  # a connection problem is not a finding about the app
        return 0, {"_error": str(e)[:120]}


def sign_in() -> dict:
    global _csrf
    _csrf = call("/api/auth/csrf")[1]["csrfToken"]
    status, me = call("/api/auth/login", "POST", {"email": EMAIL, "password": PASSWORD})
    if status != 200:
        raise SystemExit(f"Could not sign in as {EMAIL}: {status} {me}")
    _csrf = call("/api/auth/csrf")[1]["csrfToken"]
    return me


findings: list[str] = []
checks = 0


def expect(label: str, got: int, allowed: set[int], note: str = "") -> None:
    """Record whether a door answered the way the boundary says it should."""
    global checks
    checks += 1
    if got in allowed:
        return
    findings.append(
        f"{label}: answered {got}, expected {sorted(allowed)}"
        + (f" — {note}" if note else "")
    )


def gated_account(me: dict) -> int:
    """An account that has not set its own password yet is locked to two doors.

    Every faculty account starts here, so this is the state most of them are
    actually in, and it deserves checking rather than skipping: nothing but
    "who am I" and "change my password" may answer.
    """
    global checks
    print("This account has not set its own password yet — checking the gate.")
    status, _ = call("/api/auth/me")
    expect("read own profile while gated", status, {200})
    print(f"  {status}  read own profile")
    for label, path in [
        ("list claims", "/api/claims?limit=1"),
        ("dashboard", "/api/dashboard"),
        ("notifications", "/api/notifications"),
        ("upload a file", "/api/claims/upload"),
    ]:
        status, _ = call(path)
        expect(f"{label} while gated", status, {403, 405},
               "nothing but the password change may answer until it is set")
        print(f"  {status}  {label}")
    status, _ = call("/api/claims", "POST", {"paper_title": "x", "journal_title": "y"})
    expect("file a claim while gated", status, {403})
    print(f"  {status}  file a claim")

    print("\n" + "=" * 64)
    print(f"{checks} checks")
    if findings:
        print(f"{len(findings)} PROBLEM(S):")
        for f in findings:
            print(f"  - {f}")
        return 1
    print("The password gate holds: nothing else answers until a password is set.")
    return 0


def main() -> int:
    global checks
    me = sign_in()
    print(f"Signed in as {me.get('name')} ({me.get('role')})")
    if me.get("role") != "FACULTY":
        raise SystemExit("This audit must run as a FACULTY account")
    if me.get("must_change_password"):
        return gated_account(me)
    my_id = me["id"]

    # ---- what a claimant is entitled to ---------------------------------
    print("\n-- their own things --")
    for label, path in [
        ("read own profile", "/api/auth/me"),
        ("list own claims", "/api/claims?limit=5"),
        ("dashboard", "/api/dashboard"),
        ("notifications", "/api/notifications"),
        ("unread count", "/api/notifications/unread-count"),
        ("departments for the form", "/api/meta/departments"),
    ]:
        status, _ = call(path)
        expect(label, status, {200})
        print(f"  {status}  {label}")

    # ---- somebody else's things -----------------------------------------
    print("\n-- other people's things --")
    status, others = call("/api/claims?limit=200")
    mine = others.get("results") if isinstance(others, dict) else others
    if not isinstance(mine, list):
        mine = []
    foreign = [
        c for c in mine if isinstance(c, dict) and c.get("owner_id") not in (None, my_id)
    ]
    checks += 1
    if foreign:
        findings.append(
            f"claim list leaked {len(foreign)} tickets belonging to other people"
        )
    print(f"  {len(foreign)} foreign tickets in their own list (0 expected)")

    for label, path, method, payload in [
        ("another person's report", f"/api/faculty/{my_id}/report", "GET", None),
        ("the college pack", "/api/reports/pack?fmt=json", "GET", None),
        ("the ledger", "/api/reports", "GET", None),
        ("the query screen", "/api/reports/search?limit=1", "GET", None),
        ("every user", "/api/admin/users?limit=1", "GET", None),
        ("the budget", "/api/budgets", "GET", None),
        ("duplicate findings", "/api/admin/duplicate-findings", "GET", None),
        ("the audit log", "/api/admin/audit?limit=1", "GET", None),
        ("the faults screen", "/api/admin/faults", "GET", None),
        ("the clearing queue", "/api/admin/clearing-queue?limit=1", "GET", None),
        ("payouts", "/api/admin/payouts?limit=1", "GET", None),
        ("the principal's queue", "/api/principal/queue", "GET", None),
    ]:
        status, _ = call(path, method, payload)
        expect(label, status, {403, 404}, "a claimant must not read this")
        print(f"  {status}  {label}")

    # The lookup box is open to everybody, and scoped rather than blocked: a
    # claimant may look up their own ticket number. What matters is that it
    # returns nothing of anybody else's, so that is what is checked.
    status, hit = call("/api/lookup/ticket?q=Sinthia")
    expect("lookup reachable", status, {200})
    checks += 1
    leaked = [
        t for t in (hit.get("tickets") or []) if t.get("owner_name") not in (None, me.get("name"))
    ]
    if leaked or (hit.get("faculty") or []):
        findings.append(
            f"lookup leaked {len(leaked)} foreign tickets and "
            f"{len(hit.get('faculty') or [])} people to a claimant"
        )
    print(f"  {status}  lookup, scoped: "
          f"{len(leaked)} foreign tickets, {len(hit.get('faculty') or [])} people (0 and 0 expected)")

    # ---- money and approval ---------------------------------------------
    print("\n-- money --")
    status, own = call("/api/claims?limit=1")
    rows = own.get("results") if isinstance(own, dict) else own
    rows = [r for r in (rows or []) if isinstance(r, dict)]
    target = rows[0]["id"] if rows else "00000000000000000000000000000000"
    for label, path, payload in [
        ("clear a ticket", f"/api/claims/{target}/clear", {"expected_amount": 1}),
        ("approve as principal", f"/api/claims/{target}/principal-approve", {}),
        ("mark one paid", f"/api/claims/{target}/mark-paid", {"expected_amount": 1}),
        ("bulk clear", "/api/admin/bulk-clear", {"claim_ids": [target]}),
        ("bulk pay", "/api/admin/bulk-mark-paid", {"items": [{"claim_id": target}]}),
        ("void a payment", f"/api/claims/{target}/void-payment", {"note": "x" * 20}),
        ("second-approve", f"/api/claims/{target}/second-approve", {}),
        ("override a status", f"/api/admin/claims/{target}/override-status",
         {"to_status": "CLEARED", "note": "x" * 20}),
        ("set verified values", f"/api/admin/claims/{target}/set-verified",
         {"snip": 30, "note": "x" * 20}),

        ("set a budget", "/api/budgets", {"financial_year": "2026-27", "amount": 1}),
        ("impersonate somebody", f"/api/admin/impersonate/{my_id}", {}),
        ("reset a password", "/api/admin/reset-password",
         {"email": "admin@college.edu", "password": "hunter2hunter2"}),
    ]:
        status, _ = call(path, "POST", payload)
        expect(label, status, {403, 404}, "a claimant must not be able to do this")
        print(f"  {status}  {label}")

    # The formula is edited with PUT, and a partial body answers 422 because
    # the schema is validated before the permission check -- which tells you
    # nothing about whether the door is locked. So it is pushed with a
    # complete, valid body, which is the request that would actually rewrite
    # every payout in the college.
    status, _ = call(
        "/api/admin/formula",
        "PUT",
        {
            "snip_multiplier": 999999,
            "qf_q1": 1, "qf_q2": 1, "qf_q3": 1, "qf_q4": 1,
            "author_point_json": '{"1": 1}',
        },
    )
    expect("edit the payout formula", status, {403, 404},
           "the multiplier decides every payout in the college")
    print(f"  {status}  edit the payout formula (PUT, valid body)")
    status, cfg = call("/api/admin/formula")
    expect("read the payout formula", status, {403, 404})
    print(f"  {status}  read the payout formula")

    # ---- identity --------------------------------------------------------
    print("\n-- identity --")
    status, body = call("/api/auth/profile", "PATCH", {"name": "Not My Name"})
    expect("edit own profile", status, {403})
    print(f"  {status}  edit own profile")
    status, _ = call("/api/auth/profile/correction", "POST",
                     {"field": "designation", "proposed": "Professor"})
    expect("request a correction", status, {200})
    print(f"  {status}  request a correction")
    status, _ = call("/api/auth/profile/correction", "POST",
                     {"field": "role", "proposed": "SUPER_ADMIN"})
    expect("request a role change", status, {400}, "role is not a correctable detail")
    print(f"  {status}  request a role change (must be refused)")
    status, after = call("/api/auth/me")
    checks += 1
    if after.get("name") != me.get("name") or after.get("role") != "FACULTY":
        findings.append("identity changed after the attempts above")
    print(f"  name and role unchanged: {after.get('name') == me.get('name')}")

    # ---- their own tickets ----------------------------------------------
    print("\n-- their own tickets --")
    if rows:
        cid = rows[0]["id"]
        status, _ = call(f"/api/claims/{cid}")
        expect("open own ticket", status, {200})
        print(f"  {status}  open own ticket")
        status, _ = call(f"/api/claims/{cid}/notes")
        expect("read the private notes on it", status, {403},
               "notes are between the principal and the research cell")
        print(f"  {status}  read the private notes on it")

    print("\n" + "=" * 64)
    print(f"{checks} checks")
    if findings:
        print(f"{len(findings)} PROBLEM(S):")
        for f in findings:
            print(f"  - {f}")
        return 1
    print("No holes: every door answered the way the boundary says it should.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
