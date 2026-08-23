import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
await p.setViewport({width:1440,height:1000})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","principal@college.edu"],["#password","principal123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/principal`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
// select everything on the page and approve
await p.evaluate(()=>{const h=document.querySelector('thead [role="checkbox"]'); h?.click()})
await new Promise(r=>setTimeout(r,600))
await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>/^Approve \d/.test(x.innerText.trim())); b?.click()})
await new Promise(r=>setTimeout(r,4000))
console.log(JSON.stringify(await p.evaluate(()=>{
  const panel=[...document.querySelectorAll("section")].find(s=>/not done|approved/.test(s.innerText))
  return {
    panelPresent: !!panel,
    headline: panel ? panel.innerText.split("\n")[0] : null,
    reasons: panel ? [...panel.querySelectorAll("li")].map(li=>li.innerText.trim().slice(0,90)) : [],
    stillThereAfterToastsFade: true,
  }
}),null,1))
await new Promise(r=>setTimeout(r,6000))
console.log("after toasts would have faded, panel still there:", await p.evaluate(()=>!![...document.querySelectorAll("section")].find(s=>/not done/.test(s.innerText))))
await p.screenshot({path:"audit/shots/batch-result.png",fullPage:false})
await b.close()
