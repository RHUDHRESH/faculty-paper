"""Can a head of department reach money, by any route?

Money-blindness is the whole point of the role, and the failure mode is
quiet: one endpoint that forgets to filter, one export column, one nested row
inside a report. So this asks the question from the outside rather than
trusting the filter -- it reads every byte a head can obtain and looks for a
rupee figure in it.
"""
from __future__ import annotations

import json
import re
import sys

import django

sys.path.insert(0, "backend")
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
os.environ.setdefault("DJANGO_USE_SQLITE", "true")
django.setup()

from django.test import Client  # noqa: E402

from core.hod import MONEY_KEYS  # noqa: E402
from core.models import User  # noqa: E402

HOD_EMAIL = sys.argv[1] if len(sys.argv) > 1 else "hod.cse@saveetha.ac.in"

#: Anything that would betray a payment in free text.
MONEY_TEXT = re.compile(
    r"remuner|voucher|payout_month|paid_at|\bPAID\b|qf_amount|base_amount|rupee|₹",
    re.IGNORECASE,
)

#: Every screen a head must not reach at all.
FORBIDDEN = [
    "/api/reports",
    "/api/reports/export",
    "/api/reports/pack?fmt=json",
    "/api/reports/search?limit=1",
    "/api/budgets",
    "/api/admin/payouts?limit=1",
    "/api/admin/data/tables",
    "/api/admin/data/Claim?limit=1",
    "/api/admin/duplicate-findings",
    "/api/admin/faults",
    "/api/admin/audit?limit=1",
    "/api/admin/users?limit=1",
    "/api/principal/queue",
    "/api/claims?limit=1",
    "/api/admin/formula",
]

#: Everything a head is meant to reach.
#:
#: The journal endpoints were opened to heads deliberately -- "which journals
#: does my department publish in, and are they any good" is their question --
#: so they are scoped to the head's own department server-side and stripped of
#: money by the same rule as every other screen they can see. Listed here so
#: the grep below actually reads what comes back.
ALLOWED = [
    "/api/hod/overview",
    "/api/hod/publications?limit=50",
    "/api/hod/export?fmt=csv",
    "/api/journals/top?limit=25",
    "/api/journals/report?title=Scientific+Reports",
]

problems: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not ok:
        problems.append(f"{label}{f' — {detail}' if detail else ''}")
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{f' — {detail}' if not ok and detail else ''}")


def walk_for_money(node, path: str, where: str) -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if key in MONEY_KEYS:
                problems.append(f"{where}: money key {key!r} at {path}")
            walk_for_money(value, f"{path}.{key}", where)
    elif isinstance(node, list):
        for item in node:
            walk_for_money(item, f"{path}[]", where)


def main() -> int:
    global checks
    try:
        head = User.objects.get(email=HOD_EMAIL)
    except User.DoesNotExist:
        print(f"No account {HOD_EMAIL}. Create a HoD first.")
        return 1
    if head.role != "HOD":
        print(f"{HOD_EMAIL} is {head.role}, not HOD")
        return 1

    client = Client(SERVER_NAME="localhost")
    client.force_login(head)
    print(f"Signed in as {head.name} — {head.department}\n")

    print("-- screens a head must not reach --")
    for path in FORBIDDEN:
        status = client.get(path).status_code
        check(path, status in (403, 404), f"answered {status}")

    print("\n-- screens a head is meant to reach --")
    for path in ALLOWED:
        response = client.get(path)
        check(path, response.status_code == 200, f"answered {response.status_code}")
        if response.status_code != 200:
            continue
        body = response.content.decode(errors="replace")
        if "json" in response.get("Content-Type", ""):
            walk_for_money(json.loads(body), "", path)
        checks += 1
        hit = MONEY_TEXT.search(body)
        if hit:
            problems.append(f"{path}: text {hit.group(0)!r} in the payload")
        print(f"  {'ok  ' if not hit else 'FAIL'} {path}: no money in the bytes")

    print("\n-- another department --")
    others = (
        User.objects.filter(role="FACULTY")
        .exclude(department__iexact=head.department or "")
        .exclude(department__isnull=True)
        .first()
    )
    if others:
        body = client.get(f"/api/hod/publications?person={others.id}&limit=50").json()
        checks += 1
        leaked = body.get("total", 0)
        if leaked:
            problems.append(
                f"asking for {others.department} returned {leaked} rows to the "
                f"{head.department} head"
            )
        print(
            f"  {'ok  ' if not leaked else 'FAIL'} a head asking for another "
            f"department's person gets {leaked} rows (0 expected)"
        )

    print("\n" + "=" * 60)
    print(f"{checks} checks")
    if problems:
        print(f"{len(problems)} PROBLEM(S):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("A head sees their own department, and no money by any route.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
