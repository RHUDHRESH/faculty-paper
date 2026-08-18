"""Read-only: does the live principal portal answer the four new questions?"""
import json, sys, urllib.request, http.cookiejar

BASE = "https://faculty-paper-self.vercel.app"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def call(path, data=None, csrf=None, raw=False):
    req = urllib.request.Request(BASE + path)
    req.add_header("Referer", BASE)
    if csrf:
        req.add_header("X-CSRFToken", csrf)
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    try:
        r = op.open(req, body, timeout=120)
        payload = r.read()
        return r.status, (payload if raw else json.loads(payload.decode() or "{}")), dict(r.headers)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}"), {}
        except Exception:
            return e.code, {}, {}


tok = call("/api/auth/csrf")[1]["csrfToken"]
st, me, _ = call("/api/auth/login", {"email": sys.argv[1], "password": sys.argv[2]}, csrf=tok)
print("login:", st, me.get("role"))

st, rep, _ = call("/api/reports")
months = rep.get("payout_months") or []
print("payout months on record:", len(months), "| newest:", months[:3])
print("college totals:", {k: rep["totals"][k] for k in list(rep["totals"])[:4]})

if months:
    st, one, _ = call(f"/api/reports?month={months[0]}")
    print(f"month {months[0]}:", {
        "paid_amount": one["totals"].get("paid_amount"),
        "paid_claims": one["totals"].get("paid_claims") or one["totals"].get("paid"),
    })

st, bad, _ = call("/api/reports?month=march")
print("malformed month:", st, str(bad.get("detail", ""))[:40])

# A real person, found by name.
st, hit, _ = call("/api/lookup/ticket?q=Sinthia")
people = hit.get("faculty") or []
print("lookup by name:", st, "->", len(people), "faculty,", len(hit.get("tickets") or []), "tickets")

if people:
    pid = people[0]["id"]
    st, rec, _ = call(f"/api/faculty/{pid}/report")
    print("record:", people[0]["name"], "|", rec["totals"])
    print("  months:", len(rec["by_month"]), "| quartiles:",
          [(b["key"], b["count"]) for b in rec["by_quartile"][:4]])
    st, blob, headers = call(f"/api/faculty/{pid}/report/export?fmt=xlsx", raw=True)
    print("  workbook:", st, headers.get("Content-Type", "")[:46],
          "| zip:", blob[:2] == b"PK", "|", len(blob), "bytes")
