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
await p.evaluate(()=>{[...document.querySelectorAll('tbody [role="checkbox"]')].slice(0,3).forEach(b=>b.click())})
await new Promise(r=>setTimeout(r,800))
console.log(JSON.stringify(await p.evaluate(()=>({
  commit:(document.body.innerText.match(/TOTAL TO COMMIT\s*\n\s*([^\n]+)/i)||[])[1]||null,
  longest:(document.body.innerText.match(/LONGEST WAIT\s*\n\s*([^\n]+)/i)||[])[1]||null,
  selectedBtn:[...document.querySelectorAll("button")].map(b=>b.innerText.trim()).find(t=>/^Approve \d/.test(t))||null,
  selectedLine:(document.body.innerText.match(/SELECTED\s*\n\s*([^\n]+)\s*\n\s*([^\n]+)/i)||[]).slice(1).join(" | "),
  waits:[...document.querySelectorAll("tbody tr")].slice(0,5).map(tr=>(tr.innerText.match(/today|\d+ days?|over a week|\d+ weeks|over a month/)||[])[0]),
}))))
await p.screenshot({path:"audit/shots/principal-approvals.png",fullPage:false})
await b.close()
