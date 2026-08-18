import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b = await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
for (const theme of ["light","dark"]) {
  const ctx = await b.createBrowserContext(); const p = await ctx.newPage()
  await p.setViewport({width:1280,height:1000})
  await p.emulateMediaFeatures([{name:"prefers-color-scheme",value:theme}])
  const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,160)))
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  for (const [sel,v] of [["#email","admin@college.edu"],["#password","admin123"]]) {
    await p.focus(sel); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(sel,v)
  }
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}), p.click('button[type="submit"]')])
  await p.goto(`${BASE}/admin/faults`,{waitUntil:"networkidle2",timeout:60000})
  await new Promise(r=>setTimeout(r,2500))
  await p.screenshot({path:`audit/shots/faults-${theme}.png`, fullPage:true})
  console.log(`faults-${theme}`, errs.length?`ERRORS ${errs.join(" | ")}`:"clean")
  await ctx.close()
}
await b.close()
