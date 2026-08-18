import puppeteer from "puppeteer"
import fs from "node:fs"
const PW = fs.readFileSync("staff-credentials.csv","utf8").trim().split("\n").slice(1)
  .map(r=>r.split(",")).find(c=>c[0]==="admin@college.edu")[2]
const BASE="http://localhost:5173"
const b = await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx = await b.createBrowserContext(); const p = await ctx.newPage()
await p.setViewport({width:1280,height:900})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [sel,v] of [["#email","admin@college.edu"],["#password",PW]]) {
  await p.focus(sel); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(sel,v)
}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login")), p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2",timeout:60000})
await new Promise(r=>setTimeout(r,3000))
const titles = await p.$$eval("figure figcaption", els => els.map(e => e.innerText.split("\n")[0]))
console.log("figures:", JSON.stringify(titles))
const idx = titles.findIndex(t => /pipeline/i.test(t))
if (idx >= 0) {
  const figs = await p.$$("figure")
  await figs[idx].screenshot({path:"audit/shots/fig-pipeline.png"})
  console.log("pipeline captured at index", idx)
} else console.log("PIPELINE MISSING")
await b.close()
