import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1500,height:1100})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/data`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
console.log("picker:", JSON.stringify(await p.evaluate(()=>({
  heading: document.querySelector("h1")?.innerText,
  tables: [...document.querySelectorAll("button")].filter(b=>/rows|columns/.test(b.innerText)).length,
  groups: [...document.querySelectorAll("h2,h3")].map(h=>h.innerText.trim()).filter(Boolean).slice(0,6),
}))))
await p.screenshot({path:"audit/shots/data-picker.png",fullPage:false})
// open Claims
await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>/^Claims/.test(x.innerText)); b?.click()})
await new Promise(r=>setTimeout(r,3000))
console.log("claims table:", JSON.stringify(await p.evaluate(()=>({
  cols: document.querySelectorAll("thead th").length,
  rows: document.querySelectorAll("tbody tr").length,
  firstHeaders: [...document.querySelectorAll("thead th")].map(t=>t.innerText.trim()).slice(1,8),
  meta: (document.body.innerText.match(/[\d,]+ rows · \d+ columns[^\n]*/)||[])[0],
  exports: [...document.querySelectorAll("a")].filter(a=>/export\?/.test(a.href)).map(a=>a.innerText.trim()),
}))))
await p.screenshot({path:"audit/shots/data-claims.png",fullPage:false})
console.log("errors:", errs.length?errs:"none")
await b.close()
