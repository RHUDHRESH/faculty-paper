import http.cookiejar, json, urllib.request
BASE='https://faculty-paper-api.onrender.com'
FE='https://faculty-paper.vercel.app'
cj=http.cookiejar.CookieJar()
op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
# csrf
r=op.open(BASE+'/api/auth/csrf')
csrf=json.load(r)['csrfToken']
print('csrf_len', len(csrf))
for c in cj:
    print('COOKIE', c.name, 'secure=', c.secure, 'rest=', dict(c._rest), 'domain=', c.domain)
req=urllib.request.Request(BASE+'/api/auth/login', data=json.dumps({'email':'faculty@college.edu','password':'faculty123'}).encode(),
  headers={'Content-Type':'application/json','X-CSRFToken':csrf,'Referer':FE+'/','Origin':FE}, method='POST')
resp=op.open(req)
print('login', resp.status)
print('set-cookie headers:')
# urllib may not expose all; print jar again
for c in cj:
    print('COOKIE', c.name, 'secure=', c.secure, 'samesite=', c.get_nonstandard_attr('SameSite') or c._rest.get('SameSite'), 'domain=', c.domain, 'path=', c.path)
print('body', resp.read()[:120])
