import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const TICKETS={CLEARED:"224a977a649c4616ae54e1cf72641e11",PRINCIPAL_APPROVED:"0e07c0e57e1f46f0aea60b8fcc85efb3",SUBMITTED:"01b9f9589d9442afafd37e61c0cc29d6"}
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1100})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])

for (const [stage,id] of Object.entries(TICKETS)){
  await p.goto(`${BASE}/admin/clearing?claim=${id}`,{waitUntil:"networkidle2"})
  await new Promise(r=>setTimeout(r,2500))
  const r=await p.evaluate(()=>{
    const t=document.body.innerText
    const bars=[...document.querySelectorAll('[role=progressbar]')].map(el=>{
      const fill=el.firstElementChild
      return {now:el.getAttribute("aria-valuenow"),max:el.getAttribute("aria-valuemax"),width:fill?fill.style.width:null}
    })
    return {
      steps:[...document.querySelectorAll('ol[aria-label="Approval progress"] li span')].map(x=>x.innerText.trim()).filter(Boolean),
      // True is correct only from PRINCIPAL_APPROVED on. Before that the
      // Principal holds the ticket and Finance has never been shown it.
      saysFinanceHasIt:/Finance has your ticket/.test(t),
      sentence:(t.match(/(Submitted — waiting[^\n]*|Checked by the research cell[^\n]*|Approved by the Principal[^\n]*)/)||[])[0]||null,
      bars,
    }
  })
  console.log(stage, JSON.stringify(r))
}
console.log("errors:",errs.length?errs:"none")
await b.close()
