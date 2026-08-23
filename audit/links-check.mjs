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

await p.goto(`${BASE}/admin/journal?title=${encodeURIComponent("Ceramics International")}`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,3000))
console.log("journal page scimago link:", JSON.stringify(await p.evaluate(()=>{
  const a=[...document.querySelectorAll("a")].find(x=>/SCImago/i.test(x.innerText))
  return a?{label:a.innerText.trim(), href:a.getAttribute("href")}:null
})))

// open a ticket and check the paper links
// A claim that carries both a DOI and a Scopus record, which is the
// case the fix is about.
await p.goto(`${BASE}/admin/faculty/x?ticket=000c6db2d1664f0080431e766de81fdf`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,2600))
console.log("ticket paper links:", JSON.stringify(await p.evaluate(()=>
  [...document.querySelectorAll('a[href^="https://doi.org"], a[href*="scopus.com"]')]
    .map(a=>({label:a.innerText.trim(), host:new URL(a.href).host})))))
// and that a bare scopus.com link is no longer the primary affordance anywhere
console.log("bare 'Open in Scopus' still primary:", await p.evaluate(()=>
  [...document.querySelectorAll("a")].filter(a=>/^Open in Scopus$/.test(a.innerText.trim()) && !/doi\.org/.test(a.href)).length))
console.log("errors:",errs.length?errs:"none")
await b.close()
