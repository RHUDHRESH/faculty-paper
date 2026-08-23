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
console.log("journal page:", JSON.stringify(await p.evaluate(()=>{
  const t=document.body.innerText
  const grab=(re)=>{const m=t.match(re); return m?m[0]:null}
  return {
    heading:(document.querySelector("h1")||{}).innerText||null,
    sjr:grab(/SJR\n[\d.]+/),
    snip:grab(/SNIP\n[\d.]+/),
    subjects:(t.match(/Quartile by subject area/)||[])[0]||null,
    q1badge:/Q1 at its best subject/.test(t),
    authorRows:document.querySelectorAll("table tbody tr").length,
    stickyHeaders:[...document.querySelectorAll("th")].filter(th=>getComputedStyle(th).position==="sticky").length,
  }
})))
// click an author through to their record
const who=await p.evaluate(()=>{const a=document.querySelector('a[href*="/faculty/"]'); if(!a)return null; const n=a.innerText.trim(); a.click(); return n})
await new Promise(r=>setTimeout(r,3000))
console.log("clicked author:",JSON.stringify(who),"->",await p.evaluate(()=>location.pathname))
console.log("faculty page journals clickable:", await p.evaluate(()=>document.querySelectorAll('a[href*="/journal?title="]').length))
console.log("errors:",errs.length?errs:"none")
await b.close()
