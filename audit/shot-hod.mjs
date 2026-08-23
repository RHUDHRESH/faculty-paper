import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1200})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","hod.cse@saveetha.ac.in"],["#password","hodpass123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await new Promise(r=>setTimeout(r,3000))
console.log("landed on:", await p.evaluate(()=>location.pathname))
console.log(JSON.stringify(await p.evaluate(()=>({
  heading: document.querySelector("h1")?.innerText,
  nav: [...document.querySelectorAll('a[href^="/"]')].map(a=>a.getAttribute("href")),
  stats: [...document.querySelectorAll("p")].map(x=>x.innerText.trim()).filter(t=>/^\d+( of \d+)?$/.test(t)).slice(0,6),
  charts: document.querySelectorAll("svg").length,
  moneyOnScreen: /₹|remuner|voucher|amount paid/i.test(document.body.innerText),
  downloads: [...document.querySelectorAll("a")].filter(a=>/export/.test(a.href)).map(a=>a.innerText.trim()),
})),null,1))
await p.screenshot({path:"audit/shots/hod-overview.png",fullPage:false})
await p.goto(`${BASE}/hod/publications`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
console.log("publications:", JSON.stringify(await p.evaluate(()=>({
  rows: document.querySelectorAll("tbody tr").length,
  headers: [...document.querySelectorAll("thead th")].map(t=>t.innerText.trim()),
  money: /₹|remuner|voucher/i.test(document.body.innerText),
}))))
await p.screenshot({path:"audit/shots/hod-publications.png",fullPage:false})
console.log("errors:", errs.length?errs:"none")
await b.close()
