/** The profile is read-only with a working correction route; finance has no voucher box. */
import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b = await puppeteer.launch({headless:"new",args:["--no-sandbox"]})

async function signIn(p, email, pw) {
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  for (const [sel,v] of [["#email",email],["#password",pw]]) {
    await p.focus(sel); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(sel,v)
  }
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}), p.click('button[type="submit"]')])
}

// faculty profile
let ctx = await b.createBrowserContext(); let p = await ctx.newPage()
await p.setViewport({width:1280,height:900})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
await signIn(p,"faculty@college.edu","faculty123")
await p.goto(`${BASE}/faculty/profile`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,1200))
const prof = await p.evaluate(() => ({
  editableInputs: [...document.querySelectorAll("main input:not([type=hidden])")].length,
  hasSaveButton: [...document.querySelectorAll("button")].some(b=>/save profile/i.test(b.innerText)),
  hasRequest: [...document.querySelectorAll("button")].some(b=>/request a correction/i.test(b.innerText)),
  fixLinks: [...document.querySelectorAll("button")].filter(b=>b.innerText.trim()==="Fix").length,
}))
console.log("faculty profile:", JSON.stringify(prof))
// send a correction through the real dialog path
const sent = await p.evaluate(async () => {
  const csrf = (await (await fetch("/api/auth/csrf")).json()).csrfToken
  const r = await fetch("/api/auth/profile/correction", {method:"POST",
    headers:{"X-CSRFToken":csrf,"Content-Type":"application/json"},
    body: JSON.stringify({field:"designation", proposed:"Professor", note:"promoted"})})
  const saveTry = await fetch("/api/auth/profile", {method:"PATCH",
    headers:{"X-CSRFToken":csrf,"Content-Type":"application/json"},
    body: JSON.stringify({name:"Hacked"})})
  return { correction: r.status, directEdit: saveTry.status, msg:(await saveTry.json()).detail }
})
console.log("correction flow:", JSON.stringify(sent))
await ctx.close()

// finance
ctx = await b.createBrowserContext(); p = await ctx.newPage()
await p.setViewport({width:1280,height:900})
p.on("pageerror",e=>errs.push(String(e).slice(0,140)))
await signIn(p,"finance@college.edu","finance123")
await p.goto(`${BASE}/finance`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,1200))
const fin = await p.evaluate(() => ({
  headers: [...document.querySelectorAll("th")].map(t=>t.innerText.trim()),
  voucherInputs: [...document.querySelectorAll("input")].filter(i=>/voucher/i.test(i.placeholder||i.getAttribute("aria-label")||"")).length,
}))
console.log("finance payment orders:", JSON.stringify(fin))
console.log("page errors:", errs.length ? errs : "none")
await b.close()
