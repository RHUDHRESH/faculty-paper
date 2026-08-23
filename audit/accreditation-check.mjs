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

await p.goto(`${BASE}/admin/accreditation`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,4500))
console.log("page:", JSON.stringify(await p.evaluate(()=>({
  heading:(document.querySelector("h1")||{}).innerText||null,
  sections:[...document.querySelectorAll("h2, h3")].map(x=>x.innerText.trim()).filter(Boolean).slice(0,10),
  formats:[...document.querySelectorAll('a[href*="fmt="]')].map(a=>a.innerText.split("\n")[0].trim()),
  tables:document.querySelectorAll("table").length,
  stickyHeads:[...document.querySelectorAll("thead th")].filter(t=>getComputedStyle(t).position==="sticky").length,
}))))
// every format must actually return a file
const results = await p.evaluate(async ()=>{
  const out={}
  for (const fmt of ["xlsx","pdf","docx","csv","json"]) {
    const r = await fetch(`/api/reports/pack?fmt=${fmt}`)
    const buf = await r.arrayBuffer()
    out[fmt] = {status:r.status, bytes:buf.byteLength, type:(r.headers.get("content-type")||"").split(";")[0]}
  }
  return out
})
for (const [f,r] of Object.entries(results)) console.log(`  ${f.padEnd(5)} ${r.status} ${String(r.bytes).padStart(9)} bytes  ${r.type}`)
console.log("errors:",errs.length?errs:"none")
await b.close()
