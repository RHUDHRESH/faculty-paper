// Screenshots of the super admin's pages at 1280 and 390 px.
// Usage: E2E_BASE_URL=http://localhost:5174 node e2e/shots-super-admin.mjs
import { chromium } from "@playwright/test"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, "../../docs/jtbd/shots/super-admin")
const BASE = process.env.E2E_BASE_URL || "http://localhost:5174"
const SESSION = process.env.SA_SESSION
const STATE = { cookies: [{ name: "sessionid", value: SESSION, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [] }

const pages = [
  ["home", "/"],
  ["audit", "/audit"],
  ["audit-filtered", "/audit?person=admin"],
  ["policy", "/policy"],
  ["data-health", "/data/health"],
  ["imports", "/imports"],
  ["people", "/people"],
  ["faults", "/faults"],
]

const browser = await chromium.launch()
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ storageState: STATE, viewport: { width, height: 900 } })
  const page = await ctx.newPage()
  for (const [name, url] of pages) {
    await page.goto(BASE + url)
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(600)
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    if (over > 0) console.log(`OVERFLOW ${name}@${width}: ${over}px`)
    await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: width === 1280 })
  }
  if (width === 1280) {
    // The policy publish confirmation with its before/after preview.
    await page.goto(BASE + "/policy")
    await page.waitForLoadState("networkidle")
    await page.getByRole("button", { name: /Publish a new version/ }).click()
    const dialog = page.getByRole("dialog")
    const q1 = dialog.getByRole("spinbutton", { name: "Q1" })
    await q1.fill("60000")
    await dialog.getByRole("button", { name: /^Publish.$/ }).click()
    await page.getByRole("dialog", { name: /Make v/ }).waitFor()
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(OUT, `policy-preview-${width}.png`) })
  }
  await ctx.close()
}
await browser.close()
console.log("done")
