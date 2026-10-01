/**
 * Screenshots of chosen routes, as chosen roles, at chosen widths and colour
 * schemes. Not part of `npm run audit`; a tool for looking, and for the
 * before/after pairs in docs/design/shots/.
 *
 *   SESS=<json file of {name: sessionKey}> PORT=5170 OUT=<dir> TAG=after \
 *   SCHEMES=light,dark WIDTHS=1440,390 node audit/shoot.mjs faculty::/ cell::/clearing anon::/
 *
 * A target is `<name>::<route>`; `name` is a key of the SESS file (from
 * `manage.py e2e_session --role X --json`, or a session written the same way
 * for a real person), or `anon` for signed out. Files are written as
 * `<OUT>/<TAG>_<name>-<route>_<width>_<scheme>.png`.
 *
 * It captures the viewport, not the full page: a full-page capture resizes
 * the window and skips content that animates in. Motion is reduced and the
 * first-run welcome dialog is dismissed, so every shot shows the page itself.
 * It prints the sideways overflow at each width, because a phone page that
 * scrolls sideways is the commonest way this app is wrong.
 */
import { chromium } from "@playwright/test"
import { mkdirSync, readFileSync } from "node:fs"

const sess = JSON.parse(readFileSync(process.env.SESS, "utf8"))
const port = process.env.PORT || "5170"
const out = process.env.OUT || "shots"
const tag = process.env.TAG || "now"
const schemes = (process.env.SCHEMES || "light").split(",")
const widths = (process.env.WIDTHS || "1440,390").split(",").map(Number)
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
for (const scheme of schemes) {
  for (const w of widths) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: w >= 1000 ? 900 : 844 },
      colorScheme: scheme,
      reducedMotion: "reduce",
    })
    const page = await ctx.newPage()
    await page.addInitScript((s) => {
      try {
        localStorage.setItem("theme", s)
      } catch {
        /* storage can be blocked; the colour scheme is also emulated */
      }
    }, scheme)
    page.on("pageerror", (e) => console.log("ERR", String(e).slice(0, 160)))
    let current = null
    for (const target of process.argv.slice(2)) {
      const [who, route] = target.split("::")
      if (who !== current) {
        await ctx.clearCookies()
        if (who !== "anon") {
          await ctx.addCookies([{ name: "sessionid", value: sess[who], domain: "localhost", path: "/" }])
        }
        current = who
      }
      await page.goto(`http://localhost:${port}${route}`, { waitUntil: "networkidle" }).catch(() => {})
      await page.waitForTimeout(3000)
      const gotIt = page.getByRole("button", { name: "Got it" })
      if (await gotIt.isVisible().catch(() => false)) {
        await gotIt.click()
        await page.waitForTimeout(500)
      }
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      const slug = `${who}${route === "/" ? "-home" : route.replace(/[^a-z0-9]+/gi, "-")}`
      const file = `${out}/${tag}_${slug}_${w}_${scheme}.png`
      await page.screenshot({ path: file })
      console.log(file, over > 0 ? `OVERFLOW ${over}px` : "")
    }
    await ctx.close()
  }
}
await browser.close()
