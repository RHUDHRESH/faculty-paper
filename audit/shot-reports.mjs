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
await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,3500))
const o = await p.evaluate(()=>({
  charts: document.querySelectorAll("svg").length,
  showNumbers: [...document.querySelectorAll("button")].filter(b=>/Show numbers/i.test(b.innerText)).length,
  sections: [...document.querySelectorAll("h2,h3")].map(h=>h.innerText.trim()).filter(Boolean),
  monthPicker: !!document.querySelector("#rep-month"),
  hiddenTails: (document.body.innerText.match(/more not shown/g)||[]).length,
}))
console.log(JSON.stringify(o,null,1))
await p.screenshot({path:"audit/shots/reports-full.png",fullPage:true})
console.log("errors:", errs.length?errs:"none")
await b.close()
