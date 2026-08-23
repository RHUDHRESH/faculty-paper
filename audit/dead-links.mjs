/**
 * Collect every internal link the app renders, and check the router has a
 * route for it. A link to a path with no route renders the not-found screen,
 * which reads as the app being broken rather than the link being wrong.
 */
import puppeteer from "puppeteer"
import { readFileSync } from "fs"

const BASE="http://localhost:5173"
// The route table, read from the source rather than restated here.
const app = readFileSync("frontend/src/App.tsx","utf8")
const routes = new Set()
let parent = ""
for (const line of app.split("\n")) {
  const p = line.match(/path="(\/[a-z-]*)"/)
  if (p && /RequireAuth|Shell/.test(app.slice(app.indexOf(line), app.indexOf(line)+400))) parent = p[1]
  const m = line.match(/<Route path="([^"]+)"/)
  if (m) {
    const seg = m[1]
    if (seg.startsWith("/")) { routes.add(seg); parent = seg }
    else routes.add(`${parent}/${seg}`.replace("//","/"))
  }
  if (/<Route index/.test(line)) routes.add(parent)
}
const PAGES=[["admin",["/admin","/admin/reports","/admin/accreditation","/admin/clearing","/admin/duplicates","/admin/faults","/admin/query","/admin/users","/admin/budget","/admin/data","/admin/journal?title=Ceramics%20International","/admin/find?q=SUB-00089"]],
             ["finance",["/finance","/finance/paid","/finance/reports","/finance/ledger","/finance/budget"]],
             ["principal",["/principal","/principal/overview","/principal/reports","/principal/all","/principal/budget"]],
             ["faculty",["/faculty"]]]
const ACC={admin:["admin@college.edu","admin123"],finance:["finance@college.edu","finance123"],
           principal:["principal@college.edu","principal123"],faculty:["faculty@college.edu","faculty123"]}
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:950})
async function login(role){
  const [e,pw]=ACC[role]
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  if(!p.url().includes("/login")){
    await p.evaluate(()=>fetch("/api/auth/logout",{method:"POST",headers:{"X-CSRFToken":(document.cookie.match(/csrftoken=([^;]+)/)||[])[1]||""}}))
    await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})}
  for (const [s,v] of [["#email",e],["#password",pw]]){
    await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
}
const found=new Map()
for (const [role,paths] of PAGES){
  await login(role)
  for (const path of paths){
    await p.goto(BASE+path,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2800))
    const hrefs=await p.evaluate(()=>[...document.querySelectorAll('a[href^="/"]')].map(a=>a.getAttribute("href")))
    // /api and /media are served by Django, not the router; they are not
    // routes and were only ever noise in this check.
    for (const h of hrefs)
      if(!found.has(h) && !/^\/(api|media)\//.test(h)) found.set(h, path)
  }
  process.stdout.write(".")
}
const dead=[]
for (const [href, seenOn] of found){
  const base=href.split("?")[0].replace(/\/$/,"") || "/"
  // A record route carries an id: /admin/faculty/<id> matches /admin/faculty/:facultyId
  const generic=base.replace(/\/[0-9a-f]{16,}$/,"/:id")
  const ok=[...routes].some(r=>{
    const rr=r.replace(/:[A-Za-z]+/,":id")
    return rr===base||rr===generic
  })
  if(!ok) dead.push(`${href}   (linked from ${seenOn})`)
}
console.log(`\n${found.size} distinct internal links across ${PAGES.flatMap(x=>x[1]).length} pages`)
if(!dead.length) console.log("Every one resolves to a real route.")
else { console.log(`${dead.length} dead:`); dead.forEach(d=>console.log("  - "+d)) }
await b.close()
