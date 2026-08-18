/** Screenshot the reports page against production data, both themes. */
import csv from "node:fs"
import puppeteer from "puppeteer"

const BASE = "http://localhost:5173"
const rows = csv.readFileSync("staff-credentials.csv", "utf8").trim().split("\n").slice(1)
const admin = rows.map((r) => r.split(",")).find((c) => c[0] === "admin@college.edu")
const PW = admin[2]

const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
for (const theme of ["light", "dark"]) {
  const ctx = await b.createBrowserContext()
  const p = await ctx.newPage()
  await p.setViewport({ width: 1440, height: 1000 })
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
  const errs = []
  p.on("pageerror", (e) => errs.push(String(e).slice(0, 200)))
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  for (const [sel, v] of [["#email", "admin@college.edu"], ["#password", PW]]) {
    await p.focus(sel)
    await p.keyboard.down("Control"); await p.keyboard.press("KeyA"); await p.keyboard.up("Control")
    await p.keyboard.press("Backspace"); await p.type(sel, v)
  }
  await Promise.all([
    p.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 }),
    p.click('button[type="submit"]'),
  ])
  await p.goto(`${BASE}/admin/reports`, { waitUntil: "networkidle2", timeout: 60000 })
  await new Promise((r) => setTimeout(r, 3500))
  await p.screenshot({ path: `audit/shots/reports-${theme}.png`, fullPage: true })
  console.log(`reports-${theme}.png`, errs.length ? `ERRORS: ${errs.join(" | ")}` : "clean")
  await ctx.close()
}
await b.close()
