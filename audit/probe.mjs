/** Drive the real "View as" button, the way an admin does. */
import puppeteer from "puppeteer"
const BASE="http://localhost:5173"
const b = await puppeteer.launch({headless:"new",args:["--no-sandbox"]})
const ctx = await b.createBrowserContext(); const p = await ctx.newPage()
await p.setViewport({width:1280,height:900})
p.on("dialog", async d => { console.log("confirm:", d.message().split("\n")[0]); await d.accept() })
await p.goto(`${BASE}/login`,{waitUntil:"networkidle2"})
for (const [sel,v] of [["#email","admin@college.edu"],["#password","admin123"]]) {
  await p.focus(sel); await p.keyboard.down("Control"); await p.keyboard.press("KeyA")
  await p.keyboard.up("Control"); await p.keyboard.press("Backspace"); await p.type(sel,v)
}
await Promise.all([p.waitForFunction(()=>!location.pathname.startsWith("/login")), p.click('button[type="submit"]')])
await p.goto(`${BASE}/admin/users?`,{waitUntil:"networkidle2"})
await new Promise(r=>setTimeout(r,800))
// search for the demo faculty, then click its View as
await p.type('input[aria-label^="Search"]', "faculty@college.edu")
await new Promise(r=>setTimeout(r,1500))
const clicked = await p.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "View as")
  if (!btn) return false
  btn.click(); return true
})
console.log("clicked View as:", clicked)
await new Promise(r=>setTimeout(r,4000))
console.log("url now:", p.url())
const state = await p.evaluate(() => ({
  banner: document.body.innerText.includes("Viewing as"),
  bannerText: (document.body.innerText.match(/Viewing as[^\n]*/) || [""])[0],
  back: (document.body.innerText.match(/Back to[^\n]*/) || [""])[0],
}))
console.log(JSON.stringify(state, null, 1))
const me = await p.evaluate(async () => await (await fetch("/api/auth/me")).json())
console.log("session is:", me.email, "| read_only:", me.read_only, "| by:", me.impersonated_by?.email)
await p.screenshot({path:"audit/shots/impersonating.png"})
await b.close()
