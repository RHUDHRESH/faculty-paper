"""What is live right now, front and back, and where the two disagree."""
import http.cookiejar
import json
import re
import urllib.error
import urllib.request

FE = "https://faculty-paper-rhudhreshs-projects.vercel.app"

import csv as _csv
from pathlib import Path as _Path


def _admin_password() -> str:
    """Read the admin password from the local credential file, never hard-coded."""
    f = _Path(__file__).resolve().parent.parent / "staff-credentials.csv"
    if f.exists():
        for row in _csv.DictReader(f.open(encoding="utf-8")):
            if row["email"] == "admin@college.edu":
                return row["password"]
    raise SystemExit("staff-credentials.csv not found - cannot sign in")


ADMIN_PW = _admin_password()

cj = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))


def get(path):
    return json.load(op.open(FE + path))


print("=" * 68)
print("API")
print("=" * 68)
h = get("/api/health")
print(f"  revision      {h.get('git')}")
print(f"  database      {'reachable' if h.get('db') else 'UNREACHABLE'}")
print(f"  worker        {'alive' if h['worker']['alive'] else 'DOWN'}"
      f"  queued={h['worker']['queued']}")
print(f"  media         {h.get('media_backend')}")
print(f"  persistent    {h.get('media_persistent')}")

csrf = get("/api/auth/csrf")["csrfToken"]
op.open(urllib.request.Request(
    FE + "/api/auth/login",
    data=json.dumps({"email": "admin@college.edu", "password": ADMIN_PW}).encode(),
    headers={"Content-Type": "application/json", "X-CSRFToken": csrf,
             "Origin": FE, "Referer": FE + "/login"}))

print()
print("=" * 68)
print("What production currently reports")
print("=" * 68)
d = get("/api/dashboard")
by = d["by_status"]
print(f"  paid claims      {by['PAID']}")
print(f"  total paid       {d['total_paid']:,.2f}")
print(f"  awaiting review  {by['SUBMITTED']}")
print(f"  users            {get('/api/admin/users?limit=1')['total']}")

print()
print("  vs the workbook, which says:")
print(f"    paid claims      3137")
print(f"    total paid       27,596,006.98")
print(f"    awaiting review  89")
print(f"    faculty          440")

print()
print("=" * 68)
print("Frontend / backend pairing")
print("=" * 68)
html = urllib.request.urlopen(FE + "/login").read().decode("utf-8", "replace")
src = re.findall(r'src="(/assets/[^"]+\.js)"', html)[0]
js = urllib.request.urlopen(FE + src).read().decode("utf-8", "replace")
print(f"  SPA bundle    {src}")
print(f"  mojibake      {'PRESENT' if chr(0xe2) in js else 'none'}")

sends_q = "&q=" in js
all_rows = get("/api/claims?limit=5&q=zzzz-no-such-thing")
honours_q = all_rows.get("total", 0) == 0
print(f"  SPA sends q=  {'yes' if sends_q else 'no'}")
print(f"  API honours q {'yes' if honours_q else 'NO — search returns everything'}")
if sends_q and not honours_q:
    print("  => search is live but unfiltered until the API deploys")

for path, label in [
    ("/api/admin/formula", "policy"),
]:
    f = get(path)
    print()
    print("=" * 68)
    print(f"Live {label}: {f.get('name')} v{f.get('version')}")
    print("=" * 68)
    for k in ("snip_multiplier", "qf_q1", "qf_q2", "qf_q3", "qf_q4", "qf_others",
              "max_authors", "min_sec_references"):
        print(f"  {k:<22} {f.get(k)}")
    wrong = []
    if f.get("qf_q4") != 7000:
        wrong.append(f"Q4 is {f.get('qf_q4')}, the policy says 7000")
    if f.get("qf_others"):
        wrong.append(f"an unauthorised Others incentive of {f.get('qf_others')} is still live")
    for w in wrong:
        print(f"  !! {w}")
