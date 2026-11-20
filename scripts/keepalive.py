"""Keep the API warm and report failed probes honestly, without extra requests.

Run from the repository root: python scripts/keepalive.py
SITE_URL selects the existing frontend proxy; the cadence and runtime match
the original workflow. An HTML wake-up page is not a healthy API response.
"""

import json
import os
import subprocess
import time
from datetime import datetime, timezone


def probe(url):
    """Return (healthy, diagnostic), never logging response bodies or secrets."""
    try:
        result = subprocess.run(
            [
                "curl", "--fail", "--silent", "--show-error",
                "--max-time", "90", "--max-filesize", "65536",
                "--write-out", "\n%{http_code}", url,
            ],
            capture_output=True, text=True, errors="replace", timeout=95,
        )
    except subprocess.TimeoutExpired:
        return False, "request timed out"
    except OSError:
        return False, "could not run curl"
    if result.returncode:
        return False, f"curl failed (exit {result.returncode})"
    body, _, status = result.stdout.rpartition("\n")
    if status != "200":
        return False, f"unexpected HTTP status {status}"
    try:
        data = json.loads(body)
    except (ValueError, TypeError):
        return False, "response is not health JSON (possibly a wake-up page)"
    if not isinstance(data, dict) or not (
        data.get("ok") is True
        and data.get("db") is True
        and data.get("service") == "faculty-paper-api"
    ):
        return False, "API did not report a healthy database"
    return True, "healthy"


def monitor(url, *, duration=350 * 60, interval=240, check=probe,
            clock=time.monotonic, sleep=time.sleep):
    """Finish the keep-warm window even after a failure; retain a failing exit."""
    end = clock() + duration
    total = failures = 0
    while clock() < end:
        healthy, detail = check(url)
        total += 1
        failures += not healthy
        stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
        print(f"{stamp} api {detail}", flush=True)
        remaining = end - clock()
        if remaining > 0:
            sleep(min(interval, remaining))
    print(f"Health probes: {total - failures}/{total} passed", flush=True)
    if failures or not total:
        print(f"::error::{failures} of {total} API health probes failed.", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    site = os.environ.get("SITE_URL") or "https://saveetha-publications.onrender.com"
    raise SystemExit(monitor(f"{site.rstrip('/')}/api/health"))
