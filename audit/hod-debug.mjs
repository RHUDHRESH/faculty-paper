import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1200})
p.on("pageerror",e=>console.log("PAGEERROR:", e.stack ? e.stack.split("\n").slice(0,6).join("\n") : String(e)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","hod.cse@saveetha.ac.in"],["#password","hodpass123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await new Promise(r=>setTimeout(r,3000))
const d = await p.evaluate(async()=>{
  const r = await fetch("/api/hod/overview", {credentials:"include"})
  const j = await r.json()
  return {status:r.status, keys:Object.keys(j), totals:j.totals, byYear:(j.by_year||[]).slice(0,2), byQuartile:(j.by_quartile||[]).slice(0,2), person:(j.people||[])[0]}
})
console.log(JSON.stringify(d,null,1))
await b.close()
