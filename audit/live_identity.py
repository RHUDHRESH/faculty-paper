"""Does the live site actually refuse the research cell an identity change?"""
import json, urllib.request, http.cookiejar, sys

BASE = "https://faculty-paper-self.vercel.app"

def session():
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(op, path, data=None, method=None, csrf=None):
    req = urllib.request.Request(BASE + path, method=method or ("POST" if data else "GET"))
    req.add_header("Referer", BASE)
    if csrf: req.add_header("X-CSRFToken", csrf)
    body = None
    if data is not None:
        body = json.dumps(data).encode(); req.add_header("Content-Type", "application/json")
    try:
        r = op.open(req, body, timeout=60)
        return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode() or "{}")
        except Exception: return e.code, {}

def login(email, pw):
    op = session()
    tok = call(op, "/api/auth/csrf")[1]["csrfToken"]
    st, me = call(op, "/api/auth/login", {"email": email, "password": pw}, csrf=tok)
    return op, st, me

# Pick a live faculty to aim at, read through the admin listing.
op, st, me = login(sys.argv[1], sys.argv[2])
print(f"{me.get('role')} login: {st}")
tok = call(op, "/api/auth/csrf")[1]["csrfToken"]
st, page = call(op, "/api/admin/users?role=FACULTY&limit=1")
target = (page.get("results") or page)[0]
print("target:", target["email"], "| biometric:", target.get("biometric_id"), "| dept:", target.get("department"))

st, body = call(op, f"/api/admin/users/{target['id']}",
                {"biometric_id": "BIO-SHOULD-NOT-STICK"}, method="PATCH", csrf=tok)
print("identity change:", st, str(body.get("detail",""))[:100])

st, body = call(op, f"/api/admin/users/{target['id']}",
                {"department": target.get("department")}, method="PATCH", csrf=tok)
print("department change:", st)

st, after = call(op, f"/api/admin/users/{target['id']}")
print("biometric unchanged:", after.get("biometric_id") == target.get("biometric_id"),
      "|", after.get("biometric_id"))
