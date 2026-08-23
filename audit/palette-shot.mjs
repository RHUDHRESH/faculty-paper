import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1280,height:900,deviceScaleFactor:2})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [s,v] of [["#email","admin@college.edu"],["#password","admin123"]]){
  await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/reports`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,2000))
await p.keyboard.down("Control"); await p.keyboard.press("KeyK"); await p.keyboard.up("Control")
await new Promise(r=>setTimeout(r,400))
await p.keyboard.type("materials",{delay:40})
await new Promise(r=>setTimeout(r,2500))
await p.screenshot({path:"audit/palette.png"})
console.log("groups:", await p.evaluate(()=>[...document.querySelectorAll('[role=dialog] p')].map(x=>x.innerText.trim()).filter(t=>/^(PEOPLE|TICKETS|JOURNALS)$/i.test(t))))
console.log("count line:", await p.evaluate(()=>{const m=document.body.innerText.match(/\d+ results?/); return m?m[0]:null}))
await b.close()
