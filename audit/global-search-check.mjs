import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1000})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
// From a page that has nothing to do with search
await p.goto(`${BASE}/admin/formula`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2000))
await p.keyboard.down("Control"); await p.keyboard.press("KeyK"); await p.keyboard.up("Control")
await new Promise(r=>setTimeout(r,600))
console.log("opened with Ctrl+K:", await p.evaluate(()=>!!document.querySelector('[role=dialog][aria-label=Search]')))
await p.type('[role=dialog] input', "Sinthia")
await new Promise(r=>setTimeout(r,1800))
console.log("results:", JSON.stringify(await p.evaluate(()=>({
  hits: [...document.querySelectorAll('[role=dialog] li button')].map(b=>b.innerText.replace(/\n/g," · ").slice(0,60)),
}))))
await p.keyboard.press("Enter")
await new Promise(r=>setTimeout(r,2500))
console.log("landed:", JSON.stringify(await p.evaluate(()=>({path:location.pathname, heading:document.querySelector("h1")?.innerText}))))
console.log("errors:", errs.length?errs:"none")
await b.close()
