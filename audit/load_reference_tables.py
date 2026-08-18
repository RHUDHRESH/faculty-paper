"""Load the Scimago and SNIP reference tables into production.

Quartile and SNIP drive the whole payout, and production held 16 Scimago rows
and 3 SNIP rows -- so verification could confirm nothing and every claim needed
both entered by hand.

This goes through the app's own upload endpoint with the skip flags set so only
the two reference tables are touched. Claims, payments and accounts are not
read or written.
"""
import json
import sys
import time
import urllib.request

import requests

FE = "https://faculty-paper-rhudhreshs-projects.vercel.app"
XLSX = r"data\Publication_Processing_ERP_V3.0.xlsx"

s = requests.Session()
csrf = s.get(f"{FE}/api/auth/csrf", timeout=60).json()["csrfToken"]
r = s.post(
    f"{FE}/api/auth/login",
    json={"email": "admin@college.edu", "password": "SecAdmin@2026"},
    headers={"X-CSRFToken": csrf, "Origin": FE, "Referer": f"{FE}/login"},
    timeout=60,
)
r.raise_for_status()
csrf = s.get(f"{FE}/api/auth/csrf", timeout=60).json()["csrfToken"]

before = s.get(f"{FE}/api/admin/erp-stats", timeout=60).json()
print(f"before:  scimago={before['scimago']}  snip={before['snip']}  "
      f"claims={before['claims']}  users={before['users']}")

print("\nuploading the workbook (reference tables only) …")
with open(XLSX, "rb") as fh:
    r = s.post(
        f"{FE}/api/admin/erp-import",
        files={"file": ("Publication_Processing_ERP_V3.0.xlsx", fh,
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        data={
            # The two we want.
            "skip_sjr": "false",
            "skip_snip": "false",
            # Everything that would touch claims, payments or accounts.
            "skip_faculty": "true",
            "skip_accounts": "true",
            "skip_claims": "true",
            "claims_only": "false",
            "sync_users": "false",
            "year": "2025",
        },
        headers={"X-CSRFToken": csrf, "Origin": FE, "Referer": f"{FE}/admin/scimago"},
        timeout=600,
    )
print(f"  {r.status_code}  {r.text[:300]}")
r.raise_for_status()
job = r.json().get("job_id") or r.json().get("id")

if job:
    print(f"\npolling job {job}")
    for i in range(240):
        time.sleep(15)
        try:
            st = s.get(f"{FE}/api/admin/jobs/{job}", timeout=60).json()
        except Exception as exc:
            print(f"  poll error: {exc}")
            continue
        stats = s.get(f"{FE}/api/admin/erp-stats", timeout=60).json()
        print(f"  [{i*15:>5}s] status={st.get('status')}  "
              f"scimago={stats['scimago']}  snip={stats['snip']}")
        if st.get("status") in ("SUCCESS", "FAILED", "STOPPED"):
            print(f"\n  result: {json.dumps(st)[:400]}")
            break

after = s.get(f"{FE}/api/admin/erp-stats", timeout=60).json()
print(f"\nafter:   scimago={after['scimago']}  snip={after['snip']}  "
      f"claims={after['claims']}  users={after['users']}")
for k in ("claims", "users", "claims_paid", "paid_ledger"):
    if before[k] != after[k]:
        print(f"  !! {k} changed: {before[k]} -> {after[k]}")
