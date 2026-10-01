/**
 * Probes for things a unit test cannot see because they live in CSS and in
 * the running app. Not part of `npm run audit`.
 *
 *   KEY=<session key> PORT=5150 node audit/probe.mjs
 *
 *   - a .skeleton is invisible for its first 300 ms and visible after
 *   - Ctrl K finds pages by name and by job
 *   - no office badge says 99+
 */
import { chromium } from "@playwright/test"

const key = process.env.KEY
const port = process.env.PORT || "5150"
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addCookies([{ name: "sessionid", value: key, domain: "127.0.0.1", path: "/" }])
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:${port}/admin`, { waitUntil: "networkidle" })
const gotIt = page.getByRole("button", { name: "Got it" })
if (await gotIt.isVisible().catch(() => false)) await gotIt.click()

const opacity = await page.evaluate(async () => {
  const el = document.createElement("div")
  el.className = "skeleton"
  el.style.height = "10px"
  document.body.appendChild(el)
  const at = async (ms) => {
    await new Promise((r) => setTimeout(r, ms))
    return Number(getComputedStyle(el).opacity)
  }
  const early = await at(120)
  const late = await at(400)
  el.remove()
  return { early, late }
})
console.log("skeleton opacity at ~120 ms:", opacity.early, " at ~520 ms:", opacity.late)

const badges = await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && /99\+/.test(e.textContent ?? "")).length)
console.log("elements saying 99+:", badges)

for (const q of ["who changed", "backup", "who can sign in", "wall of fame", "notification settings", "faculty", "paid with no ledger row", "profile corrections"]) {
  await page.keyboard.press("Control+k")
  await page.getByRole("combobox", { name: "Find anything" }).fill(q)
  await page.waitForTimeout(700)
  const rows = await page.getByRole("option").allInnerTexts()
  console.log(`Ctrl K "${q}":`, rows.slice(0, 3).map((r) => r.replace(/\s+/g, " ").slice(0, 50)).join(" | ") || "(nothing)")
  await page.keyboard.press("Escape")
}
await browser.close()
