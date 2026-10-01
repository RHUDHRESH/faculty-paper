// Screenshots of the research cell's desk for docs/jtbd/shots/research-cell.
// Usage: node e2e/shots-research-cell.mjs <session_key> [base]
import { chromium } from "@playwright/test"

const [key, base = "http://localhost:5193"] = process.argv.slice(2)
const out = "../docs/jtbd/shots/research-cell"
const browser = await chromium.launch()
for (const width of [1280, 390]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  await ctx.addCookies([{ name: "sessionid", value: key, url: base }])
  const page = await ctx.newPage()
  const shot = async (name) => {
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(2000)
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    console.log(name, width, "overflow", sw)
    await page.screenshot({ path: `${out}/${name}-${width}.png`, fullPage: true })
  }
  await page.goto(`${base}/clearing`)
  await shot("clearing")
  await page.locator("text=Blockchain Voting on Low-Cost IoT Nodes >> visible=true").first().click()
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/ticket-watched-${width}.png` })
  await page.keyboard.press("Escape")
  await page.goto(`${base}/journals`)
  await shot("journals-watch")
  await ctx.close()
}
await browser.close()
