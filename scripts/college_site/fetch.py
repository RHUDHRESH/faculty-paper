"""Polite cached fetcher for the college's public website.

robots.txt is respected, requests are spaced at least a second apart, and
every response is cached on disk so a re-run never re-hits the site.
The cache lives OUTSIDE the repository (the repo is public): pass the output
folder via SCRAPE_DIR, default ``D:/Faculty Paper/data/scraped``.
"""
from __future__ import annotations

import hashlib
import os
import pathlib
import sys
import time
import urllib.request
import urllib.robotparser

UA = "FacultyPaperBot/1.0 (SEC research-incentive app; contact joyalisacerp@gmail.com)"
OUT = pathlib.Path(os.environ.get("SCRAPE_DIR", "D:/Faculty Paper/data/scraped"))
CACHE = OUT / "cache"
CACHE.mkdir(parents=True, exist_ok=True)
_rp = urllib.robotparser.RobotFileParser("https://saveetha.ac.in/robots.txt")
_rp.read()
_last = [0.0]


def get(url: str) -> bytes | None:
    p = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".bin")
    if p.exists():
        return p.read_bytes()
    if "saveetha.ac.in" in url and not _rp.can_fetch(UA, url):
        print("ROBOTS-DENY", url, file=sys.stderr)
        return None
    wait = 1.05 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    _last[0] = time.time()
    try:
        req = urllib.request.Request(url.replace(" ", "%20"), headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except Exception as e:  # noqa: BLE001
        print("ERR", url, e, file=sys.stderr)
        return None
    p.write_bytes(data)
    (CACHE / (p.stem + ".url")).write_text(url)
    return data


if __name__ == "__main__":
    sys.stdout.buffer.write(get(sys.argv[1]) or b"")
