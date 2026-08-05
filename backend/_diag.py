import http.cookiejar, json, urllib.request, urllib.error, sys
BASE="https://faculty-paper-api.onrender.com"
FE="https://faculty-paper.vercel.app"
fails=0

def check(name, cond, detail=""):
    global fails
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not cond: fails += 1

# basic
for url,name in [(FE,"Vercel"), (BASE+"/api/health","Health"), (BASE+"/api/auth/csrf","CSRF")]:
    try:
        r=urllib.request.urlopen(url, timeout=60)
        body=r.read()[:200]
        check(name, r.status==200, f"status={r.status} body={body[:80]!r}")
    except Exception as e:
        check(name, False, str(e))

# CORS
try:
    req=urllib.request.Request(BASE+"/api/health", headers={"Origin":FE})
    r=urllib.request.urlopen(req, timeout=30)
    allow=r.headers.get("Access-Control-Allow-Origin","")
    check("CORS", FE in allow, allow)
except Exception as e:
    check("CORS", False, str(e))

class C:
    def __init__(self):
        self.cj=http.cookiejar.CookieJar()
        self.op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
    def csrf(self):
        return json.load(self.op.open(BASE+"/api/auth/csrf"))["csrfToken"]
    def post(self, path, body):
        req=urllib.request.Request(BASE+path, data=json.dumps(body).encode(),
            headers={"Content-Type":"application/json","X-CSRFToken":self.csrf(),"Referer":BASE+"/","Origin":FE}, method="POST")
        try:
            resp=self.op.open(req); return resp.status, json.load(resp)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()[:500]
    def get(self, path):
        req=urllib.request.Request(BASE+path, headers={"Referer":BASE+"/","Origin":FE})
        try:
            resp=self.op.open(req); return resp.status, json.load(resp)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()[:500]

accounts=[
 ("faculty","faculty@college.edu","faculty123","FACULTY"),
 ("hod","hod@college.edu","hod123","HOD"),
 ("principal","principal@college.edu","principal123","PRINCIPAL"),
 ("finance","finance@college.edu","finance123","FINANCE"),
 ("admin","admin@college.edu","admin123","SUPER_ADMIN"),
]
for label,email,pw,role in accounts:
    c=C()
    st, me = c.post("/api/auth/login", {"email":email,"password":pw})
    ok = st==200 and isinstance(me,dict) and me.get("role")==role
    check(f"login {label}", ok, f"status={st} got={me.get('role') if isinstance(me,dict) else me}")

# faculty calc + me + claims
c=C()
c.post("/api/auth/login", {"email":"faculty@college.edu","password":"faculty123"})
st, me = c.get("/api/auth/me")
check("auth/me", st==200 and isinstance(me,dict), str(me)[:120] if not isinstance(me,dict) else me.get("email"))
st, calc = c.post("/api/calculate", {"snip":1.2,"quartile":"Q1","total_authors":2,"author_position":1,"publication_type":"Journal"})
check("calculate", st==200 and isinstance(calc,dict) and calc.get("remuneration") is not None, str(calc)[:200])
st, claims = c.get("/api/claims")
check("list claims", st==200 and isinstance(claims,list), f"status={st} n={len(claims) if isinstance(claims,list) else claims}")

# admin formula
a=C()
a.post("/api/auth/login", {"email":"admin@college.edu","password":"admin123"})
st, formula = a.get("/api/admin/formula")
check("admin formula", st==200 and isinstance(formula,dict) and "snip_multiplier" in formula, str(formula)[:200] if not isinstance(formula,dict) else f"v={formula.get('version')} cap={formula.get('snip_cap')}")

# hod queue
h=C()
h.post("/api/auth/login", {"email":"hod@college.edu","password":"hod123"})
st, q = h.get("/api/claims?status=SUBMITTED")
check("hod queue", st==200 and isinstance(q,list), f"status={st} n={len(q) if isinstance(q,list) else q}")

print("FAILS", fails)
sys.exit(1 if fails else 0)
