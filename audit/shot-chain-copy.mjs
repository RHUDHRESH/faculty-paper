import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1500,height:1000})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/clearing`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>/^(SUB|FP)-\d/.test(x.innerText.trim())); b?.click()})
await new Promise(r=>setTimeout(r,2000))
console.log(JSON.stringify(await p.evaluate(()=>({
  buttons:[...document.querySelectorAll("button")].map(b=>b.innerText.trim().replace(/\s+/g," ")).filter(t=>/Clear|Finance|Principal|Send/.test(t)).slice(0,6),
  mentionsFinance: /sent to Finance|→ Finance|to Finance\./.test(document.body.innerText),
  mentionsPrincipal: /Principal/.test(document.body.innerText),
})),null,1))
await p.screenshot({path:"audit/shots/admin-clear-copy.png",fullPage:false})
await b.close()
