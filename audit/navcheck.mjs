import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1000})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","faculty@college.edu"],["#password","faculty123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(()=>({
  path: location.pathname,
  anchors: document.querySelectorAll("a").length,
  internal: [...document.querySelectorAll('a[href^="/"]')].map(a=>a.getAttribute("href")),
  navEls: document.querySelectorAll("nav").length,
  allHrefs: [...document.querySelectorAll("a")].map(a=>a.getAttribute("href")).slice(0,12),
})),null,1))
await b.close()
