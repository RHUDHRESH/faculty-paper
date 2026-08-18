"""Check the profile lock and voucher removal on the live site, not on dev."""
import json, urllib.request, http.cookiejar, sys

BASE = "https://faculty-paper-self.vercel.app"
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def call(path, data=None, method=None, csrf=None):
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

tok = call("/api/auth/csrf")[1]["csrfToken"]
email, pw = sys.argv[1], sys.argv[2]
st, me = call("/api/auth/login", {"email": email, "password": pw}, csrf=tok)
print("login:", st, me.get("role"), me.get("name"))
tok = call("/api/auth/csrf")[1]["csrfToken"]

st, body = call("/api/auth/profile", {"name": "SHOULD NOT STICK"}, method="PATCH", csrf=tok)
print("direct profile edit:", st, str(body.get("detail",""))[:70])

st, body = call("/api/auth/profile/correction",
                {"field": "designation", "proposed": "Professor", "note": "live check"}, csrf=tok)
print("correction request:", st, body.get("label"), "->", body.get("proposed"))

st, me2 = call("/api/auth/me")
print("name unchanged:", me2.get("name") == me.get("name"), "|", me2.get("name"))
