// Screenshots of the three desk queues at 1440 and 390 px.
// Usage: node e2e/shots-review-queues.mjs <sessions.jsonl> <outDir> [base]
// Each line of sessions.jsonl is what `manage.py e2e_session --json` printed.
import { readFileSync, mkdirSync } from "node:fs"
import { chromium } from "@playwright/test"

const [file, out, base = "http://localhost:5142"] = process.argv.slice(2)
const sessions = Object.fromEntries(
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((s) => [s.role, s.session_key])
)
mkdirSync(out, { recursive: true })

const desks = [
  { role: "RESEARCH_CELL", path: "/clearing", name: "clearing" },
  { role: "PRINCIPAL", path: "/approvals", name: "approvals" },
  { role: "DIRECTOR", path: "/authorisations", name: "authorisations" },
]

const browser = await chromium.launch()
for (const width of [1440, 390]) {
  for (const d of desks) {
    const ctx = await browser.newContext({ viewport: { width, height: width > 600 ? 1000 : 1500 } })
    await ctx.addCookies([{ name: "sessionid", value: sessions[d.role], url: base }])
    const page = await ctx.newPage()
    const shot = async (name, opts = {}) => {
      await page.waitForLoadState("networkidle")
      await page.waitForTimeout(1200)
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      console.log(name, width, "horizontal overflow", over)
      await page.screenshot({ path: `${out}/${name}-${width}.png`, ...opts })
    }
    await page.goto(base + d.path)
    // A first-visit welcome dialog can sit over the page and hide it from the accessibility tree.
    const gotIt = page.getByRole("button", { name: "Got it" })
    await gotIt.waitFor({ timeout: 6000 }).then(() => gotIt.click()).catch(() => {})
    await page.getByRole("heading", { level: 1, name: /Clearing queue|Approvals|Authorisations/ }).waitFor()
    await shot(d.name)

    // Select the first two rows: the bar and the reason there is no bulk send-back.
    const boxes = page.getByRole("checkbox", { name: /^Select (?!all)/ })
    const n = await boxes.count()
    let visible = []
    for (let i = 0; i < n; i++) if (await boxes.nth(i).isVisible()) visible.push(boxes.nth(i))
    if (visible.length >= 2) {
      await visible[0].click()
      await visible[1].click()
      await shot(`${d.name}-selected`)
    }

    // The summary before a batch goes.
    const review = page.getByRole("button", { name: /^Review the \d+ ready|^Review and authorise/ }).first()
    if (await review.isVisible().catch(() => false)) {
      await review.click()
      await page.waitForTimeout(600)
      await shot(`${d.name}-summary`)
    }
    await ctx.close()
  }
}
await browser.close()
