"""Read-only: which roles exist on the live system."""
import json, urllib.request, http.cookiejar, sys, collections
BASE = "https://faculty-paper-self.vercel.app"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path, data=None, csrf=None):
    req = urllib.request.Request(BASE + path)
    req.add_header("Referer", BASE)
    if csrf: req.add_header("X-CSRFToken", csrf)
    b = None
    if data is not None:
        b = json.dumps(data).encode(); req.add_header("Content-Type", "application/json")
    try:
        r = op.open(req, b, timeout=60); return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")
tok = call("/api/auth/csrf")[1]["csrfToken"]
st, me = call("/api/auth/login", {"email": sys.argv[1], "password": sys.argv[2]}, csrf=tok)
print("login:", st, me.get("role"))
c = collections.Counter()
off = 0
while True:
    st, page = call(f"/api/admin/users?limit=200&offset={off}")
    rows = page.get("results") if isinstance(page, dict) else page
    if not rows: break
    for r in rows: c[r.get("role")] += 1
    off += len(rows)
    if isinstance(page, dict) and off >= page.get("total", off): break
print("accounts by role:", dict(c), "| total", sum(c.values()))
