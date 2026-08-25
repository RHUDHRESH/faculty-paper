import puppeteer from "puppeteer"
const BASE="http://localhost:5174"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1280,height:1400,deviceScaleFactor:1.5})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,160)))
p.on("console",m=>{if(m.type()==="error"&&!/404|401/.test(m.text())) errs.push("console: "+m.text().slice(0,140))})
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,1200))
for (const [s,v] of [["#email","faculty@college.edu"],["#password","faculty123"]]){
  await p.focus(s); await p.keyboard.type(v,{delay:10})}
await p.click('button[type="submit"]'); await new Promise(r=>setTimeout(r,3000))
await p.goto(`${BASE}/gallery`,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2500))
await p.screenshot({path:"audit/g-top.png"})
await p.evaluate(()=>window.scrollTo(0,1250)); await new Promise(r=>setTimeout(r,600))
await p.screenshot({path:"audit/g-mid.png"})
await p.evaluate(()=>window.scrollTo(0,2500)); await new Promise(r=>setTimeout(r,600))
await p.screenshot({path:"audit/g-low.png"})
console.log("sections:", await p.evaluate(()=>[...document.querySelectorAll("h2")].map(h=>h.innerText)))
console.log("sideways scroll:", await p.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth))
console.log("errors:", errs.length?errs.slice(0,3):"none")
await b.close()
