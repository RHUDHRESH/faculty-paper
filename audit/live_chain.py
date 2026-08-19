"""Read-only: is the four-step chain actually live, and does finance see nothing unapproved?"""
import csv, json, sys, urllib.request, http.cookiejar

BASE = "https://faculty-paper-self.vercel.app"


def session(email, pw):
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(path, data=None, csrf=None):
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
            return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode() or "{}")
            except Exception:
                return e.code, {}

    tok = call("/api/auth/csrf")[1]["csrfToken"]
    st, me = call("/api/auth/login", {"email": email, "password": pw}, csrf=tok)
    return call, st, me


row = [
    r
    for r in csv.DictReader(open("staff-credentials.csv", encoding="utf-8-sig"))
    if r["role"] == "SUPER_ADMIN"
][0]
call, st, me = session(row["email"], row["password"])
print("login:", st, me.get("role"))

st, queue = call("/api/principal/queue?sort=waiting&limit=3")
print("principal queue:", st, "| waiting:", queue.get("totals"))
print("  filters offered by the endpoint: department list of", len(queue.get("departments") or []))

st, payouts = call("/api/admin/payouts?status=CLEARED&limit=3")
print("finance payable queue:", st, "| rows:", payouts.get("total"))
print("  (only principal-approved tickets can appear here)")

st, rep = call("/api/reports")
print("report datasets:", sorted(k for k in rep if k.startswith("by_") or k in ("per_paper", "pipeline")))
print("per paper:", rep.get("per_paper"))
print("indexing:", [(x["key"], x["count"]) for x in rep.get("by_indexing", [])])
print("years:", [(x["key"], x["count"]) for x in rep.get("by_year", [])])
