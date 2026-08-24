import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const TEMP="forced-check@college.edu"
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:1000})
const errs=[]; p.on("pageerror",e=>errs.push(String(e).slice(0,150)))

// Make its own subject, so this is re-runnable rather than a one-off that
// passed once and then failed for the rest of time.
async function signIn(email,password){
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  for (const [s,v] of [["#email",email],["#password",password]]){
    await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
}
await signIn("admin@college.edu","admin123")
const made = await p.evaluate(async (email)=>{
  const csrf=async()=>(await (await fetch("/api/auth/csrf")).json()).csrfToken
  const t=await csrf()
  const post=(path,body)=>fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-CSRFToken":t},body:JSON.stringify(body)})
  await post("/api/admin/users",{email,name:"Forced Check",role:"FACULTY",department:"CSE",password:"temp1234"})
  // Whether it existed already or was just made, put it back to a known state.
  const r=await post("/api/admin/reset-password",{email,password:"temp1234"})
  return r.status
}, TEMP)
console.log("subject account ready:", made===200)
await p.evaluate(async ()=>{
  const t=(await (await fetch("/api/auth/csrf")).json()).csrfToken
  await fetch("/api/auth/logout",{method:"POST",headers:{"X-CSRFToken":t}})
})
await signIn(TEMP,"temp1234")
await new Promise(r=>setTimeout(r,2500))
console.log("forced dialog appears:", JSON.stringify(await p.evaluate(()=>{
  const d=document.querySelector('[role=dialog]')
  return d? {open:true, title:(d.querySelector("h2")||{}).innerText, hasCancel:/Cancel/.test(d.innerText)} : {open:false}
})))
// fill it in and submit
await p.evaluate(()=>{const i=document.querySelector("#current"); i?.focus()})
await p.keyboard.type("temp1234",{delay:20})
await p.evaluate(()=>{const i=document.querySelector("#next"); i?.focus()})
await p.keyboard.type("BrandNew-9931",{delay:20})
await p.evaluate(()=>{const d=document.querySelector('[role=dialog]'); const b=[...d.querySelectorAll("button")].find(x=>/Update password/.test(x.innerText)); b?.click()})
await new Promise(r=>setTimeout(r,4000))
console.log("after updating:", JSON.stringify(await p.evaluate(()=>({
  dialogStillThere: !!document.querySelector('[role=dialog]'),
  toast: (document.body.innerText.split(String.fromCharCode(10)).find(l=>/Password updated/.test(l))||null),
  path: location.pathname,
}))))
await new Promise(r=>setTimeout(r,3000))
console.log("three seconds later, dialog back?:", await p.evaluate(()=>!!document.querySelector('[role=dialog]')))
console.log("errors:",errs.length?errs:"none")
await b.close()
