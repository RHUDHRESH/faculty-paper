import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1100})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
for (const [path,shot] of [["/admin/duplicates","duplicates"],["/admin/budget","budget"]]) {
  await p.goto(BASE+path,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2600))
  console.log(path, JSON.stringify(await p.evaluate(()=>({
    heading: document.querySelector("h1")?.innerText,
    stats: [...document.querySelectorAll("p")].map(x=>x.innerText.trim()).filter(t=>/^₹|^\d+$/.test(t)).slice(0,6),
    cards: document.querySelectorAll("li, [class*=rounded]").length>0,
    text: document.body.innerText.replace(/\s+/g," ").slice(180,420),
  }))))
  await p.screenshot({path:`audit/shots/${shot}.png`, fullPage:false})
}
console.log("errors:", errs.length?errs:"none")
await b.close()
