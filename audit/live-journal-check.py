"""Do the journals that were "Not matched" now match, on production?"""
import csv, http.cookiejar, json, urllib.parse, urllib.request
BASE = "https://faculty-paper-self.vercel.app"
TITLES = [
    "Journal of Materials Science Materials in Electronics",
    "Sustainable Computing Informatics and Systems",
    "Smart Innovation Systems and Technologies",
    "Journal of Optics India",
    "Ceramics International",
    "Lecture Notes in Networks and Systems",
]
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def call(path, data=None, csrf=None):
    req = urllib.request.Request(BASE + path, method="POST" if data is not None else "GET")
    req.add_header("Referer", BASE)
    if csrf: req.add_header("X-CSRFToken", csrf)
    body = json.dumps(data).encode() if data is not None else None
    if body: req.add_header("Content-Type", "application/json")
    r = op.open(req, body, timeout=180)
    return json.loads(r.read().decode() or "{}")
with open("staff-credentials.csv", encoding="utf-8-sig", newline="") as fh:
    admin = next(r for r in csv.DictReader(fh) if r["role"] == "SUPER_ADMIN")
t = call("/api/auth/csrf")["csrfToken"]
call("/api/auth/login", {"email": admin["email"], "password": admin["password"]}, csrf=t)
for title in TITLES:
    d = call("/api/journals/report?title=" + urllib.parse.quote(title))
    sc = d["journal"]["scimago"]
    print(f"  {title[:46]:48} {'SJR ' + str(sc['sjr']) + '  ' + str(sc['best_quartile']) if sc else 'not matched'}")
