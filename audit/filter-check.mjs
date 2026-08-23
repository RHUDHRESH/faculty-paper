import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1000})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","principal@college.edu"],["#password","principal123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/principal`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
const shut = await p.evaluate(()=>({
  visibleDropdowns: [...document.querySelectorAll('[role=combobox]')].filter(e=>e.offsetParent!==null).length,
  filtersButton: [...document.querySelectorAll("button")].some(b=>/^Filters/.test(b.innerText.trim())),
}))
console.log("on arrival:", JSON.stringify(shut))
await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>/^Filters/.test(x.innerText.trim())); b?.click()})
await new Promise(r=>setTimeout(r,500))
console.log("after opening:", JSON.stringify(await p.evaluate(()=>({
  visibleDropdowns: [...document.querySelectorAll('[role=combobox]')].filter(e=>e.offsetParent!==null).length,
}))))
// pick a quartile and confirm the chip + URL
await p.evaluate(()=>{const t=document.querySelector('#pq-quartile'); t?.click()})
await new Promise(r=>setTimeout(r,400))
await p.evaluate(()=>{const o=[...document.querySelectorAll('[role=option]')].find(x=>x.innerText.trim()==="Q1"); o?.click()})
await new Promise(r=>setTimeout(r,1800))
console.log("after choosing Q1:", JSON.stringify(await p.evaluate(()=>({
  url: location.search,
  chips: [...document.querySelectorAll("button")].map(b=>b.innerText.replace(/\n/g," ").trim()).filter(t=>/^(Quartile|Department|Waiting|Search):/.test(t)),
  filtersBadge: ([...document.querySelectorAll("button")].find(b=>/^Filters/.test(b.innerText.trim()))||{}).innerText,
}))))
console.log("errors:", errs.length?errs:"none")
await b.close()
