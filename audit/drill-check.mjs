import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1100})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,3500))
console.log("data gap shown instead of a useless pie:", await p.evaluate(()=>/is not recorded on/.test(document.body.innerText)))
console.log("gap text:", await p.evaluate(()=>{
  const m=document.body.innerText.match(/[^\n]*is not recorded on[^\n]*\n?[^\n]*/); return m? m[0].replace(/\n/g," ").slice(0,120):null
}))
console.log("total clickable rows:", await p.evaluate(()=>document.querySelectorAll('a[href*="/faculty/"], a[href*="/query?"], li button').length))
// click a quartile row
const q = await p.evaluate(()=>{
  const a=[...document.querySelectorAll('a[href*="/query?quartile="]')][0]
  if(!a) return null
  const name=a.innerText.trim().split("\n")[0]; a.click(); return name
})
await new Promise(r=>setTimeout(r,3000))
console.log("clicked quartile:", JSON.stringify(q))
console.log("landed:", JSON.stringify(await p.evaluate(()=>({
  path:location.pathname+location.search,
  // This screen renders cards, not a table: counting tbody rows measured
  // nothing and reported an empty result that was never empty.
  resultCount:(document.body.innerText.match(/([\d,]+)\s+(result|match|ticket|publication)/i)||[])[0]||null,
  cards:document.querySelectorAll("main li, main article").length,
  quartileControl:[...document.querySelectorAll('[role=combobox]')].map(x=>x.innerText.trim()).filter(t=>/^Q[1-4]$/.test(t)),
}))))
console.log("errors:", errs.length?errs:"none")
await b.close()
