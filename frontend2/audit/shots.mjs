/**
 * Screenshots of chosen routes at desktop and phone widths, signed in with an
 * `e2e_session` key. Not part of `npm run audit`; a tool for looking.
 *
 *   KEY=<session key> PORT=5150 OUT=<dir> TAG=before node audit/shots.mjs / /admin /track
 *
 * Also prints the horizontal overflow at each width, because a phone page that
 * scrolls sideways is the commonest way this app is wrong.
 */
import { chromium } from "@playwright/test"
import { mkdirSync } from "node:fs"

const key = process.env.KEY
const port = process.env.PORT || "5150"
const out = process.env.OUT || "shots"
const tag = process.env.TAG || "now"
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
for (const [w, h, n] of [
  [1440, 900, "d"],
  [390, 844, "m"],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } })
  await ctx.addCookies([{ name: "sessionid", value: key, domain: "127.0.0.1", path: "/" }])
  const page = await ctx.newPage()
  page.on("pageerror", (e) => console.log("ERR", String(e).slice(0, 160)))
  for (const r of process.argv.slice(2)) {
    await page.goto(`http://127.0.0.1:${port}${r}`, { waitUntil: "networkidle" }).catch(() => {})
    await page.waitForTimeout(1800)
    // The first-sign-in welcome covers the page until it is closed once.
    const gotIt = page.getByRole("button", { name: "Got it" })
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click()
      await page.waitForTimeout(600)
    }
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    const file = `${out}/${tag}_${n}${r.replace(/[^a-z0-9]+/gi, "_")}.png`
    await page.screenshot({ path: file, fullPage: process.env.FULL === "1" })
    console.log(file, over > 0 ? `OVERFLOW ${over}px` : "")
  }
  await ctx.close()
}
await browser.close()

