import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1000})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","principal@college.edu"],["#password","principal123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/principal`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2000))
console.log(JSON.stringify(await p.evaluate(()=>({
  rows: document.querySelectorAll("tbody tr").length,
  text: document.body.innerText.slice(0,600),
  buttons: [...document.querySelectorAll("button")].map(b=>b.innerText.trim().replace(/\s+/g," ")).filter(Boolean).slice(0,14),
})),null,1))
// try clicking the row itself
await p.evaluate(()=>document.querySelector("tbody tr")?.click())
await new Promise(r=>setTimeout(r,1800))
console.log("after row click:", JSON.stringify(await p.evaluate(()=>({
  notes: /Notes on this ticket/.test(document.body.innerText),
  detailOpen: /Ticket|Paper/.test(document.body.innerText) && document.querySelectorAll("[role=dialog]").length,
}))))
await b.close()
