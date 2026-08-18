/** What does a list say when a search matches nothing? */
import puppeteer from "puppeteer"
import { ACCOUNTS } from "./pages.mjs"
const BASE = "http://localhost:5173"
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })

async function check(role, path, label) {
  const ctx = await b.createBrowserContext()
  const p = await ctx.newPage()
  await p.setViewport({ width: 1440, height: 900 })
  const who = ACCOUNTS[role]
  await p.goto(BASE + "/login", { waitUntil: "networkidle2" })
  for (const [s, v] of [["#email", who.email], ["#password", who.password]]) {
    await p.focus(s)
    await p.keyboard.down("Control"); await p.keyboard.press("KeyA"); await p.keyboard.up("Control")
    await p.keyboard.press("Backspace"); await p.type(s, v)
  }
  await Promise.all([p.waitForFunction(() => !location.pathname.startsWith("/login")), p.click('button[type="submit"]')])
  await p.goto(BASE + path, { waitUntil: "networkidle2" })
  await new Promise((r) => setTimeout(r, 800))
  const box = await p.$('input[aria-label^="Search"]')
  await box.type("zzzzz-no-such-thing")
  await new Promise((r) => setTimeout(r, 1800))
  const t = await p.evaluate(() => (document.querySelector("main") || document.body).innerText)
  const empty = t.match(/(No matching tickets|No matches|No tickets yet|Nothing in this status|All clear)[\s\S]{0,140}/)
  console.log(`\n${label}\n   ${empty ? empty[0].split("\n").filter(Boolean).slice(0, 3).join(" / ") : "(no empty state shown)"}`)
  await ctx.close()
}

await check("faculty", "/faculty", "Faculty · my tickets — search with no match")
await check("admin", "/admin/clearing", "Admin · clearing queue — search with no match")
await b.close()
