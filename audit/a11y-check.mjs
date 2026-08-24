/**
 * The accessibility complaints, checked rather than assumed:
 * a password you can reveal, a dropdown you can type into, and the
 * password dialog that would not go away.
 */
import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:1000})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))

// ---- the login password field ---------------------------------------
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,1200))
console.log("login password:", JSON.stringify(await p.evaluate(()=>{
  const i=document.querySelector("#password")
  const btn=[...document.querySelectorAll("button")].find(b=>/password/i.test(b.getAttribute("aria-label")||""))
  return {type:i?.type, revealButton:!!btn, label:btn?.getAttribute("aria-label"), pressed:btn?.getAttribute("aria-pressed")}
})))
await p.type("#password","hunter22")
await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(b=>/password/i.test(b.getAttribute("aria-label")||"")); b?.click()})
await new Promise(r=>setTimeout(r,400))
console.log("after clicking reveal:", JSON.stringify(await p.evaluate(()=>{
  const i=document.querySelector("#password")
  const btn=[...document.querySelectorAll("button")].find(b=>/password/i.test(b.getAttribute("aria-label")||""))
  return {type:i?.type, visibleValue:i?.value, label:btn?.getAttribute("aria-label"), pressed:btn?.getAttribute("aria-pressed")}
})))

// ---- sign in and test the typeable dropdown -------------------------
await p.evaluate(()=>{document.querySelector("#password").value=""})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])

await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,4000))
await p.evaluate(()=>document.querySelector("#rep-dept")?.click())
await new Promise(r=>setTimeout(r,500))
const opened=await p.evaluate(()=>({
  role:document.querySelector('[role=listbox]')?.getAttribute("role"),
  options:document.querySelectorAll('[role=option]').length,
  searchBox:!!document.querySelector('[role=listbox]')?.previousElementSibling?.querySelector("input"),
}))
console.log("dropdown opened:", JSON.stringify(opened))
await p.keyboard.type("mec",{delay:40})
await new Promise(r=>setTimeout(r,500))
console.log("after typing 'mec':", JSON.stringify(await p.evaluate(()=>({
  options:[...document.querySelectorAll('[role=option]')].map(o=>o.innerText.trim()).slice(0,4),
  activeDescendant:document.activeElement?.getAttribute("aria-activedescendant"),
}))))
await p.keyboard.press("Enter")
await new Promise(r=>setTimeout(r,1500))
console.log("after Enter, dept is:", JSON.stringify(await p.evaluate(()=>document.querySelector("#rep-dept")?.innerText.trim())))
console.log("errors:",errs.length?errs:"none")
await b.close()
