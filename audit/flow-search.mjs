/** Does typing in a queue search actually reach the server? */
import puppeteer from "puppeteer"
import { ACCOUNTS } from "./pages.mjs"
const BASE = "http://localhost:5173"
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })

async function check(role, path, label) {
  const ctx = await b.createBrowserContext()
  const p = await ctx.newPage()
  await p.setViewport({ width: 1440, height: 900 })
  const calls = []
  p.on("request", (r) => { if (r.url().includes("/api/claims?")) calls.push(r.url().replace(BASE, "")) })
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
  calls.length = 0

  const box = await p.$('input[aria-label^="Search"]')
  if (!box) { console.log(`${label}: NO search box found`); await ctx.close(); return }
  await box.type("photovoltaic")
  await new Promise((r) => setTimeout(r, 1600))
  const withQ = calls.filter((c) => c.includes("q="))
  console.log(`${label}:`)
  console.log(`   requests after typing: ${calls.length}, carrying q=: ${withQ.length}`)
  if (withQ.length) console.log(`   e.g. ${withQ[withQ.length - 1]}`)
  else console.log("   BUG: search never reached the server")
  const offsetReset = withQ.every((c) => /offset=0(&|$)/.test(c))
  console.log(`   offset reset to 0 on search: ${offsetReset ? "yes" : "NO"}`)
  await ctx.close()
}

await check("admin", "/admin/clearing", "Admin clearing queue")
await check("faculty", "/faculty", "Faculty my tickets")
await b.close()
