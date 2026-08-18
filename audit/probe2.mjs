import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b = await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx = await b.createBrowserContext(); const p = await ctx.newPage()
await p.setViewport({width:1440,height:1000})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [sel,v] of [["#email","finance@college.edu"],["#password","finance123"]]) {
  await p.focus(sel); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(sel,v)
}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}), p.click('button[type="submit"]')])
for (const path of ["/finance","/finance/payouts","/finance/paid"]) {
  await p.goto(BASE+path,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,1500))
  const o = await p.evaluate(() => ({
    url: location.pathname,
    tables: document.querySelectorAll("table").length,
    headers: [...document.querySelectorAll("th")].map(t=>t.innerText.trim()).slice(0,12),
    rows: document.querySelectorAll("tbody tr").length,
    voucherWord: /voucher/i.test(document.body.innerText),
    voucherInputs: [...document.querySelectorAll("input")].filter(i=>/voucher/i.test((i.placeholder||"")+(i.getAttribute("aria-label")||""))).length,
  }))
  console.log(JSON.stringify(o))
}
await b.close()
