import puppeteer from "puppeteer"
import fs from "node:fs"
const rows = fs.readFileSync("staff-credentials.csv","utf8").trim().split("\n").slice(1)
const PW = rows.map(r=>r.split(","))
  .find(c=>c[0]==="admin@college.edu")[2]
const BASE="http://localhost:5173"
const b = await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
for (const theme of ["light","dark"]) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage()
  await p.setViewport({width:1280,height:900})
  await p.emulateMediaFeatures([{name:"prefers-color-scheme",value:theme}])
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  for (const [sel,v] of [["#email","admin@college.edu"],["#password",PW]]) {
    await p.focus(sel); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(sel,v)
  }
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}), p.click('button[type="submit"]')])
  await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2",timeout:60000})
  await new Promise(r=>setTimeout(r,3000))
  // hover the trend so the tooltip is in shot
  const svg = await p.$("figure svg")
  if (svg) { const box = await svg.boundingBox(); await p.mouse.move(box.x+box.width*0.62, box.y+box.height*0.5) }
  await new Promise(r=>setTimeout(r,400))
  const figs = await p.$$("figure")
  for (let i=0;i<Math.min(figs.length,3);i++) {
    await figs[i].screenshot({path:`audit/shots/fig${i}-${theme}.png`})
  }
  console.log(theme, "captured", Math.min(figs.length,3), "figures")
  await ctx.close()
}
await b.close()
