import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:900})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,160)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/clearing`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,3000))
console.log("waiting labels on rows:", await p.evaluate(()=>
  [...document.querySelectorAll("span")].filter(s=>/^(waiting \d+ days?|arrived today)$/.test(s.innerText.trim())).length))
// select every ticket, then scroll to the bottom and see if the button survives
await p.evaluate(()=>{const cb=document.querySelector('button[role=checkbox]'); if(cb) cb.click()})
await new Promise(r=>setTimeout(r,900))
const before=await p.evaluate(()=>{
  const bar=[...document.querySelectorAll("div")].find(d=>/selected/.test(d.innerText||"")&&d.className.includes("sticky"))
  return {selectedText:(document.body.innerText.match(/\d+ selected/)||[])[0]||null,
          total:(document.body.innerText.match(/₹[\d,]+\s*selected/)||[])[0]||null,
          sticky:!!bar}
})
console.log("after select all:", JSON.stringify(before))
await p.evaluate(()=>window.scrollTo(0,document.body.scrollHeight))
await new Promise(r=>setTimeout(r,900))
console.log("after scrolling to the bottom:", JSON.stringify(await p.evaluate(()=>{
  const btn=[...document.querySelectorAll("button")].find(b=>/Clear \d+ → Principal/.test(b.innerText))
  if(!btn) return {buttonVisible:false}
  const r=btn.getBoundingClientRect()
  return {buttonVisible:r.top>=0&&r.bottom<=innerHeight, top:Math.round(r.top), label:btn.innerText.trim()}
})))
console.log("errors:",errs.length?errs:"none")
await b.close()
