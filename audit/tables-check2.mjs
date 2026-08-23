import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:820})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])

const probe = () => p.evaluate(()=>{
  const tables=[...document.querySelectorAll("table")]
  if(!tables.length) return {tables:0}
  let pinned=0,floating=0,mismatched=0
  for(const t of tables){
    const ths=[...t.querySelectorAll("thead th")]; if(!ths.length) continue
    if(ths.every(th=>getComputedStyle(th).position==="sticky")) pinned++; else floating++
    const cells=t.querySelector("tbody tr")?.children.length
    if(cells!=null&&cells!==ths.length) mismatched++
  }
  return {tables:tables.length,pinned,floating,mismatched,cols:tables[0].querySelectorAll("thead th").length}
})

// --- data explorer: pick a table ---
await p.goto(`${BASE}/admin/data`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
const picked = await p.evaluate(()=>{
  const b=[...document.querySelectorAll("button, a")].find(x=>/Claim\b/.test(x.innerText||""))
  if(b){b.click(); return b.innerText.trim().slice(0,30)} return null})
await new Promise(r=>setTimeout(r,3000))
console.log("data explorer, table picked:",JSON.stringify(picked),JSON.stringify(await probe()))

// --- find: run a search ---
// A ticket number, so the Tickets table actually renders -- a name alone
// matches people and no tickets, and the section is right not to draw.
await p.goto(`${BASE}/admin/find?q=SUB-00089`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,3200))
console.log("find results:",JSON.stringify(await probe()))
// a ticket row should open the dialog
const clicked = await p.evaluate(()=>{const a=document.querySelector('tbody a[href*="ticket="]'); if(!a)return null; const t=a.innerText.trim(); a.click(); return t})
await new Promise(r=>setTimeout(r,2500))
console.log("clicked ticket:",JSON.stringify(clicked),"dialog:",await p.evaluate(()=>!!document.querySelector('[role=dialog]')))
console.log("errors:",errs.length?errs:"none")
await b.close()
