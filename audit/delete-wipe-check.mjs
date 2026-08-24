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

await p.goto(`${BASE}/admin/data`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,3000))
// pick a table
await p.evaluate(()=>{const b=[...document.querySelectorAll("button, a")].find(x=>/Claim actions/i.test(x.innerText||"")); b?.click()})
await new Promise(r=>setTimeout(r,3000))
console.log("wipe panel present:", await p.evaluate(()=>/Empty this system/.test(document.body.innerText)))
// open a row, then the delete dialog
await p.evaluate(()=>{const b=document.querySelector('button[aria-label="Open this row"]'); b?.click()})
await new Promise(r=>setTimeout(r,1000))
console.log("row dialog has delete:", await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]'); return d? /Delete this row/.test(d.innerText):false}))
await p.evaluate(()=>{const d=document.querySelector('[role=dialog]'); const b=[...d.querySelectorAll("button")].find(x=>/Delete this row/.test(x.innerText)); b?.click()})
await new Promise(r=>setTimeout(r,1000))
console.log("confirm dialog:", JSON.stringify(await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]'); if(!d) return {open:false}
  const btn=[...d.querySelectorAll("button")].find(x=>/Delete permanently/.test(x.innerText))
  return {open:true, disabledWithoutReason:btn?.disabled, warnsAboutPaid:/refused by the server/.test(d.innerText)}
})))
await p.keyboard.press("Escape"); await new Promise(r=>setTimeout(r,600))
// the wipe dialog and its brakes
await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>/Empty this system/.test(x.innerText)); b?.click()})
await new Promise(r=>setTimeout(r,3000))
console.log("wipe dialog:", JSON.stringify(await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]'); if(!d) return {open:false}
  const t=d.innerText
  const btn=[...d.querySelectorAll("button")].find(x=>/Empty the system/.test(x.innerText))
  return {open:true, disabled:btn?.disabled,
    rowCount:(t.match(/([\d,]+) rows will be destroyed/)||[])[0]||null,
    paymentConsent:/settled payments/.test(t),
    phrase:/DELETE EVERYTHING/.test(t),
    survives:/What survives/.test(t)}
})))
console.log("errors:",errs.length?errs:"none")
await b.close()
