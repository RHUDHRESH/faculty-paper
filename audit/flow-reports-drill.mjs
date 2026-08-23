import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1100})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,3500))

console.log("sections:", JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll("h2,h3")].map(h=>h.innerText.trim()).filter(Boolean).slice(0,12))))
console.log("clickable rows:", await p.evaluate(()=>document.querySelectorAll('a[href*="/faculty/"], li button').length))

// click a person's name
const target = await p.evaluate(()=>{
  const a=[...document.querySelectorAll('a[href*="/admin/faculty/"]')][0]
  if(!a) return null
  const name=a.innerText.trim().split("\n")[0]
  a.click(); return name
})
await new Promise(r=>setTimeout(r,3000))
console.log("clicked:", JSON.stringify(target))
console.log("landed:", JSON.stringify(await p.evaluate(()=>({
  path: location.pathname,
  heading: document.querySelector("h1")?.innerText,
  person: (document.body.innerText.match(/\n([A-Z][^\n]{3,40})\n[A-Za-z ]*·/)||[])[1],
  stats: [...document.querySelectorAll("p")].map(x=>x.innerText.trim()).filter(t=>/^(₹|\d)/.test(t)).slice(0,4),
  charts: document.querySelectorAll("svg").length,
}))))
await p.screenshot({path:"audit/shots/faculty-record.png",fullPage:false})

// back to reports, click a department
await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,3000))
const dept = await p.evaluate(()=>{
  const btn=[...document.querySelectorAll("li button")].find(b=>/^(ECE|CSE|MECH|EEE)/.test(b.innerText.trim()))
  if(!btn) return null
  const name=btn.innerText.trim().split("\n")[0]
  btn.click(); return name
})
await new Promise(r=>setTimeout(r,2500))
console.log("clicked department:", JSON.stringify(dept))
console.log("filter now:", JSON.stringify(await p.evaluate(()=>{
  const sel=[...document.querySelectorAll('[role=combobox]')].map(s=>s.innerText.trim())
  return {selects:sel, publications:(document.body.innerText.match(/PUBLICATIONS\s*\n\s*([\d,]+)/)||[])[1]}
})))
console.log("errors:", errs.length?errs:"none")
await b.close()
