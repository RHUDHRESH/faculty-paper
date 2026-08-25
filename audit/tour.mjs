import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const ACC={admin:["admin@college.edu","admin123"],finance:["finance@college.edu","finance123"],
           principal:["principal@college.edu","principal123"],faculty:["faculty@college.edu","faculty123"]}
const SHOTS=(process.argv[2]||"admin:/admin:overview").split(",").map(s=>s.split(":"))
const b=await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const p=await (await b.createBrowserContext()).newPage()
await p.setViewport({width:1440,height:1150,deviceScaleFactor:1.4})
async function login(role){
  const [e,pw]=ACC[role]
  await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
  if(!p.url().includes("/login")){
    await p.evaluate(async()=>{const t=(await (await fetch("/api/auth/csrf")).json()).csrfToken
      await fetch("/api/auth/logout",{method:"POST",headers:{"X-CSRFToken":t}})})
    await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})}
  for (const [s,v] of [["#email",e],["#password",pw]]){
    await p.focus(s); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
    await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(s,v)}
  await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login"),{timeout:30000}),p.click('button[type="submit"]')])
}
let last=null
for (const [role,path,name] of SHOTS){
  if(role!==last){ await login(role); last=role }
  await p.goto(BASE+path,{waitUntil:"networkidle2"}); await new Promise(r=>setTimeout(r,3400))
  await p.screenshot({path:`audit/t-${name}.png`})
  console.log(name)
}
await b.close()
