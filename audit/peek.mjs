import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b = await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx = await b.createBrowserContext(); const p = await ctx.newPage()
await p.setViewport({width:1440,height:1200})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [sel,v] of [["#email","faculty@college.edu"],["#password","faculty123"]]) {
  await p.focus(sel); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(sel,v)
}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}), p.click('button[type="submit"]')])
await p.goto(`${BASE}/faculty/new`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,2000))
for (const box of await p.$$('[role="checkbox"]')) { await box.click(); await new Promise(r=>setTimeout(r,120)) }
const st = await p.evaluateHandle(()=>[...document.querySelectorAll("button")].find(b=>/start the claim/i.test(b.innerText)))
console.log("start disabled:", await p.evaluate(()=> {const b=[...document.querySelectorAll("button")].find(b=>/start the claim/i.test(b.innerText)); return b? b.disabled : "missing"}))
if (st.asElement()) { await st.asElement().click(); await new Promise(r=>setTimeout(r,1500)) }
for (let i=0;i<3;i++){
  const c = await p.evaluateHandle(()=>[...document.querySelectorAll("button")].find(b=>/^continue/i.test(b.innerText.trim())))
  if (!c.asElement()) break
  await c.asElement().click(); await new Promise(r=>setTimeout(r,900))
  console.log("step", i, "|", await p.evaluate(()=>[...document.querySelectorAll("input,textarea")].map(e=>e.id).filter(Boolean).join(", ")))
  console.log("   errors:", await p.evaluate(()=>[...document.querySelectorAll('[role=alert],.text-destructive')].map(e=>e.innerText.trim()).filter(Boolean).slice(0,6).join(" | ")))
}
console.log(JSON.stringify(await p.evaluate(()=>({
  buttons:[...document.querySelectorAll("button")].map(b=>b.innerText.trim().replace(/\s+/g," ")).filter(Boolean).slice(0,20),
  heading:document.querySelector("h1,h2")?.innerText,
  text:document.body.innerText.slice(0,400),
})),null,1))
await b.close()
