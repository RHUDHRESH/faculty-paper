import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:390,height:844,isMobile:true,hasTouch:true})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","principal@college.edu"],["#password","principal123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
for (const path of ["/principal","/principal/reports"]) {
  await p.goto(BASE+path,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
  console.log(path, JSON.stringify(await p.evaluate(()=>({
    pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 2,
    overflowBy: document.documentElement.scrollWidth - window.innerWidth,
    tables: document.querySelectorAll("table").length,
    widestTable: Math.max(0, ...[...document.querySelectorAll("table")].map(t=>t.scrollWidth)),
    viewport: window.innerWidth,
  }))))
}
await p.screenshot({path:"audit/shots/mobile-principal.png",fullPage:false})
await b.close()
