"""Print 'scimago snip' counts from production, for watch loops."""
import requests

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

s = requests.Session()
c = s.get(f"{FE}/api/auth/csrf", timeout=60).json()["csrfToken"]
s.post(
    f"{FE}/api/auth/login",
    json={"email": "admin@college.edu", "password": ADMIN_PW},
    headers={"X-CSRFToken": c, "Origin": FE, "Referer": f"{FE}/login"},
    timeout=60,
)
d = s.get(f"{FE}/api/admin/erp-stats", timeout=60).json()
print(f"{d['scimago']} {d['snip']}")
