import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:1000})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,4500))
const before=p.url()
const scrollBefore=await p.evaluate(()=>{window.scrollTo(0,1400); return window.scrollY})
// click a designation bar
const clicked=await p.evaluate(()=>{
  const btns=[...document.querySelectorAll("button")].filter(b=>/Associate Professor|Professor$/.test(b.innerText.trim()))
  if(!btns.length) return null
  const t=btns[0].innerText.trim(); btns[0].click(); return t})
await new Promise(r=>setTimeout(r,3000))
console.log("clicked:",JSON.stringify(clicked))
console.log("sheet:",JSON.stringify(await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]')
  if(!d) return {open:false}
  const t=d.innerText
  return {open:true,
    title:(d.querySelector("h2")||{}).innerText||null,
    subtitle:(t.split(String.fromCharCode(10))[1]||"").slice(0,60),
    rows:d.querySelectorAll("ul > li").length,
    hasQueryEscape:/Open in Query/.test(t),
    hasExcel:/Excel/.test(t)}
})))
console.log("still on the report:", p.url()===before, "| scroll kept:", await p.evaluate(()=>window.scrollY)>1000)
await p.keyboard.press("Escape"); await new Promise(r=>setTimeout(r,900))
console.log("after Escape — sheet closed:", await p.evaluate(()=>!document.querySelector('[role=dialog]')),
            "| still on report:", p.url()===before)
console.log("errors:",errs.length?errs:"none")
await b.close()
