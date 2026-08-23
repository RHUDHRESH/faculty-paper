import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
for (const [email,pw,portal] of [["admin@college.edu","admin123","/admin"],["principal@college.edu","principal123","/principal"],["finance@college.edu","finance123","/finance"]]) {
  const ctx=await b.createBrowserContext(); const p=await ctx.newPage()
  await p.setViewport({width:1440,height:1000})
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  for (const [s,v] of [["#email",email],["#password",pw]]){
    await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
  await p.goto(BASE+portal,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,2200))
  const nav = await p.evaluate(()=>{
    const el=document.querySelector('nav[aria-label="Main"]')
    if(!el) return null
    const out=[]
    for (const child of el.children) {
      if (child.tagName==="P") out.push("── "+child.innerText.trim())
      else out.push("   "+child.innerText.trim())
    }
    return {items:[...el.querySelectorAll("a")].length, lines:out}
  })
  console.log(`\n${portal}: ${nav.items} links`)
  console.log(nav.lines.join("\n"))
  await ctx.close()
}
await b.close()
