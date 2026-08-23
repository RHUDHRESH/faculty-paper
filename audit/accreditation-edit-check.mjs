import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1500,height:1000})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])

await p.goto(`${BASE}/admin/accreditation`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,5000))
console.log("readiness:", JSON.stringify(await p.evaluate(()=>{
  const t=document.body.innerText
  return {
    complete:(t.match(/([\d,]+)\s+of\s+([\d,]+)\s+rows are complete/)||[])[0]||null,
    comeBack:(t.match(/([\d,]+) would come back/)||[])[0]||null,
    gapChips:[...document.querySelectorAll("button")].map(x=>x.innerText.trim()).filter(x=>/·\s*[\d,]+$/.test(x)),
  }
})))
// filter to the rows with no ISSN
const filtered = await p.evaluate(()=>{
  const b=[...document.querySelectorAll("button")].find(x=>/^No ISSN ·/.test(x.innerText.trim()))
  if(!b) return null; b.click(); return b.innerText.trim()})
await new Promise(r=>setTimeout(r,2600))
console.log("filtered by:", JSON.stringify(filtered), "->", await p.evaluate(()=>{
  const m=document.body.innerText.match(/([\d,]+) rows? matching that filter/); return m?m[0]:null}))
// open the correction dialog on the first row
await p.evaluate(()=>{const b=document.querySelector('button[aria-label^="Correct "]'); if(b) b.click()})
await new Promise(r=>setTimeout(r,1200))
console.log("dialog:", JSON.stringify(await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]'); if(!d) return {open:false}
  const save=[...d.querySelectorAll("button")].find(x=>/Save correction/.test(x.innerText))
  return {open:true, fields:[...d.querySelectorAll('[role=combobox]')].map(x=>x.innerText.trim()),
          saveDisabledWithoutReason: save ? save.disabled : null}
})))

// Actually save one, and check the row changes.
const target = await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]')
  const tick=d.querySelector(".font-mono")
  return tick?tick.innerText.trim():null
})
await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]')
  const combo=d.querySelector('[role=combobox]'); if(combo) combo.click()
})
await new Promise(r=>setTimeout(r,600))
await p.evaluate(()=>{
  const opt=[...document.querySelectorAll('[role=option]')].find(o=>/^ISSN$/.test(o.innerText.trim()))
  if(opt) opt.click()
})
await new Promise(r=>setTimeout(r,600))
await p.evaluate(()=>{const i=document.querySelector("#pack-value"); if(i){i.focus(); i.select&&i.select()}})
await p.keyboard.type("0975-3060",{delay:20})
await p.evaluate(()=>{const i=document.querySelector("#pack-reason"); if(i) i.focus()})
await p.keyboard.type("ISSN read off the printed copy",{delay:20})
await new Promise(r=>setTimeout(r,400))
await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]')
  const save=[...d.querySelectorAll("button")].find(x=>/Save correction/.test(x.innerText))
  if(save) save.click()
})
await new Promise(r=>setTimeout(r,3200))
console.log("saved ticket:", JSON.stringify(target))
console.log("after save:", JSON.stringify(await p.evaluate((t)=>({
  dialogClosed: !document.querySelector('[role=dialog]'),
  toast: (document.body.innerText.split(String.fromCharCode(10)).find(l=>/Corrected/.test(l))||null),
  rowStillListed: document.body.innerText.includes(t||"@@@"),
}), target)))
console.log("errors:",errs.length?errs:"none")
await b.close()
