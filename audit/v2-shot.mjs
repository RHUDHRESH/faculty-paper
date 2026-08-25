import puppeteer from "puppeteer"
const BASE="http://localhost:5174"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:1000,deviceScaleFactor:1.5})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,180)))
p.on("console",m=>{if(m.type()==="error") errs.push("console: "+m.text().slice(0,140))})
await p.goto(BASE,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,1800))
await p.screenshot({path:"audit/v2-signin.png"})
console.log("sign-in rendered:", await p.evaluate(()=>!!document.querySelector("#password")))
for (const [s,v] of [["#email","faculty@college.edu"],["#password","faculty123"]]){
  await p.focus(s); await p.keyboard.type(v,{delay:12})}
await p.click('button[type="submit"]')
await new Promise(r=>setTimeout(r,4000))
await p.screenshot({path:"audit/v2-home.png"})
console.log("after sign-in:", JSON.stringify(await p.evaluate(()=>({
  path:location.pathname,
  h1:(document.querySelector("h1")||{}).innerText||null,
  navItems:[...document.querySelectorAll("aside a")].map(a=>a.innerText.trim()).filter(Boolean).slice(0,12),
}))))
// the palette
await p.keyboard.down("Control"); await p.keyboard.press("KeyK"); await p.keyboard.up("Control")
await new Promise(r=>setTimeout(r,500))
await p.keyboard.type("disc",{delay:40})
await new Promise(r=>setTimeout(r,900))
await p.screenshot({path:"audit/v2-palette.png"})
console.log("palette:", JSON.stringify(await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]')
  return d? {open:true, options:[...d.querySelectorAll('[role=option]')].map(o=>o.innerText.split("\n")[0])} : {open:false}
})))
console.log("errors:", errs.length?errs.slice(0,3):"none")
await b.close()
