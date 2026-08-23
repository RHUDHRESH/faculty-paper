import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const PAGES=[
  ["/admin/users","admin users"],
  ["/admin/audit","audit log"],
  ["/admin/duplicates","duplicates"],
  ["/admin/data","data explorer"],
  ["/admin/find?q=Sinthia","find results"],
  ["/finance","payment orders"],
  ["/finance/paid","processed"],
  ["/principal","principal approvals"],
]
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:820})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
async function login(email,pw){
  // Already signed in? /login bounces straight back out, and the form we are
  // about to type into is not on the page.
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  if (!p.url().includes("/login")) {
    await p.evaluate(()=>fetch("/api/auth/logout",{method:"POST",headers:{"X-CSRFToken":(document.cookie.match(/csrftoken=([^;]+)/)||[])[1]||""}}))
    await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  }
  for (const [s,v] of [["#email",email],["#password",pw]]){
    await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
}
await login("admin@college.edu","admin123")
for (const [path,label] of PAGES){
  if (path.startsWith("/finance")) { await login("finance@college.edu","finance123") }
  if (path.startsWith("/principal")) { await login("principal@college.edu","principal123") }
  await p.goto(BASE+path,{waitUntil:"networkidle2"})
  await new Promise(r=>setTimeout(r,2600))
  const r=await p.evaluate(()=>{
    const tables=[...document.querySelectorAll("table")]
    if(!tables.length) return {tables:0}
    let pinned=0, floating=0, mismatched=0
    for(const t of tables){
      const ths=[...t.querySelectorAll("thead th")]
      if(!ths.length) continue
      if(ths.every(th=>getComputedStyle(th).position==="sticky")) pinned++; else floating++
      const cells=t.querySelector("tbody tr")?.children.length
      if(cells!=null && cells!==ths.length) mismatched++
    }
    return {tables:tables.length, pinned, floating, mismatched}
  })
  console.log(`${label.padEnd(20)} ${JSON.stringify(r)}`)
}
console.log("errors:",errs.length?errs:"none")
await b.close()
