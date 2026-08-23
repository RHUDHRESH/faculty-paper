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

await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,4000))
console.log("duplicated numbers like '797 797':", await p.evaluate(()=>
  (document.body.innerText.match(/\b(\d+)\s+\1\s+(claim|paper|publication)/g)||[]).slice(0,3)))
const links = await p.evaluate(()=>{
  const seen={}
  for(const a of document.querySelectorAll('a[href*="/query?"]')){
    const k=(a.getAttribute("href").split("?")[1]||"").split("=")[0]
    seen[k]=(seen[k]||0)+1
  }
  return seen
})
console.log("query drill-downs by filter:", JSON.stringify(links))
// follow one of each new kind and confirm the rows land
for (const key of ["designation","publication_type","month","indexing","status","year","engineering_class","category"]){
  const href = await p.evaluate((k)=>{
    const a=[...document.querySelectorAll('a[href*="/query?"]')].find(x=>x.getAttribute("href").includes(k+"="))
    return a?a.getAttribute("href"):null
  }, key)
  if(!href){ console.log(`${key.padEnd(18)} no link`); continue }
  await p.goto(BASE+href,{waitUntil:"networkidle2"})
  await new Promise(r=>setTimeout(r,2600))
  const r=await p.evaluate(()=>({
    n:(document.body.innerText.match(/([\d,]+)\s+publications?/)||[])[1]||null,
    chips:[...document.querySelectorAll('button[aria-label^="Remove the"]')].map(x=>x.innerText.replace(/\n/g," ").trim()),
  }))
  console.log(`${key.padEnd(18)} ${href.split("?")[1].slice(0,38).padEnd(40)} -> ${r.n} publications  chips=${JSON.stringify(r.chips)}`)
  await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,3000))
}
console.log("errors:",errs.length?errs:"none")
await b.close()
