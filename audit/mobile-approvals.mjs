import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:390,height:900,isMobile:true,hasTouch:true})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","principal@college.edu"],["#password","principal123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/principal`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
console.log(JSON.stringify(await p.evaluate(()=>({
  cards: document.querySelectorAll("ul.space-y-3 > li").length,
  tableVisible: [...document.querySelectorAll("table")].some(t=>t.offsetParent!==null),
  approveButtonsReachable: [...document.querySelectorAll("button")].filter(x=>x.innerText.trim()==="Approve").length,
  sideways: document.documentElement.scrollWidth > window.innerWidth+2,
}))))
await p.screenshot({path:"audit/shots/mobile-approvals.png",fullPage:false})
await b.close()
