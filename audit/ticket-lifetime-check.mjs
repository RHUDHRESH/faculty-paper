import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:1100})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,160)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])

await p.goto(`${BASE}/admin/journal?title=${encodeURIComponent("Ceramics International")}`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,3000))
// click the first ticket number in the publications table
const t = await p.evaluate(()=>{
  const a=[...document.querySelectorAll('a[href*="ticket="]')][0]
  if(!a) return null
  const n=a.innerText.trim(); a.click(); return n
})
await new Promise(r=>setTimeout(r,2500))
console.log("clicked ticket:",JSON.stringify(t))
console.log("dialog:", JSON.stringify(await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]')
  if(!d) return {open:false}
  const t=d.innerText
  return {
    open:true,
    title:(d.querySelector("h2")||{}).innerText||null,
    hasTimeline:!!d.querySelector('ol[aria-label="Approval progress"]'),
    steps:[...d.querySelectorAll('ol[aria-label="Approval progress"] li span')].map(x=>x.innerText.trim()).filter(Boolean),
    historyEntries:d.querySelectorAll("ol li").length - 4,
    historyText:(d.innerText.split("HISTORY")[1]||"").trim().split(String.fromCharCode(10)).slice(0,6),
    journalLink:!!d.querySelector('a[href*="/journal?title="]'),
  }
})))
console.log("errors:",errs.length?errs:"none")
await b.close()
