import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:1000})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))
async function signIn(email,password){
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  if(!p.url().includes("/login")){
    await p.evaluate(async()=>{const t=(await (await fetch("/api/auth/csrf")).json()).csrfToken
      await fetch("/api/auth/logout",{method:"POST",headers:{"X-CSRFToken":t}})})
    await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})}
  for (const [s,v] of [["#email",email],["#password",password]]){
    await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
}
await signIn("admin@college.edu","admin123")
await p.goto(`${BASE}/admin/profile-requests`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,3000))
console.log("admin queue:", JSON.stringify(await p.evaluate(()=>{
  const t=document.body.innerText
  return {
    heading:(document.querySelector("h1")||{}).innerText,
    tabs:[...document.querySelectorAll("button")].map(b=>b.innerText.trim()).filter(x=>/^(Waiting|Applied|Declined|Everything)/.test(x)),
    requests:document.querySelectorAll("ul > li").length,
    showsChange:/→/.test(t),
    identityBadge:/super admin only/i.test(t),
  }
})))
// the decision dialog and its brake
const opened=await p.evaluate(()=>{const b=[...document.querySelectorAll("button")].find(x=>/^Decline$/.test(x.innerText.trim())); if(!b) return false; b.click(); return true})
await new Promise(r=>setTimeout(r,900))
console.log("decline dialog:", JSON.stringify(await p.evaluate((o)=>{
  const d=document.querySelector('[role=dialog]'); if(!d) return {opened:o, open:false}
  const btn=[...d.querySelectorAll("button")].find(x=>/^Decline$/.test(x.innerText.trim()))
  return {open:true, disabledWithoutReason:btn?.disabled, tellsThem:/shown the reason/.test(d.innerText)}
}, opened)))
console.log("errors:",errs.length?errs:"none")
await b.close()
