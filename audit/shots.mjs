/** Full-page screenshots of every page, as the role that owns it. */
import fs from "node:fs"
import puppeteer from "puppeteer"
import { ACCOUNTS, PAGES } from "./pages.mjs"

const BASE = "http://localhost:5173"
const OUT = "audit/shots"
const WIDTH = Number(process.env.W || 1440)
const THEME = process.env.THEME || "light"
const SUFFIX = process.env.SUFFIX || ""

fs.mkdirSync(OUT, { recursive: true })

async function signIn(page, role) {
  const who = ACCOUNTS[role]
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  await page.waitForSelector("#email", { timeout: 15000 })
  for (const [sel, v] of [["#email", who.email], ["#password", who.password]]) {
    await page.focus(sel)
    await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control")
    await page.keyboard.press("Backspace"); await page.type(sel, v)
  }
  await Promise.all([
    page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ])
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
let role = null, ctx = null, page = null
let i = 0

// The login screen first — nobody is signed in for it.
{
  const c = await browser.createBrowserContext()
  const p = await c.newPage()
  await p.setViewport({ width: WIDTH, height: 900 })
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: THEME }])
  await p.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  await new Promise((r) => setTimeout(r, 600))
  const f = `${OUT}/00-login${SUFFIX}.png`
  await p.screenshot({ path: f, fullPage: true })
  console.log(f)
  await c.close()
}

for (const spec of PAGES) {
  if (spec.role !== role) {
    if (ctx) await ctx.close()
    ctx = await browser.createBrowserContext()
    page = await ctx.newPage()
    await page.setViewport({ width: WIDTH, height: 900 })
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: THEME }])
    await signIn(page, spec.role)
    role = spec.role
  }
  await page.goto(BASE + spec.path, { waitUntil: "networkidle2", timeout: 30000 })
  await new Promise((r) => setTimeout(r, 1000))
  i += 1
  const slug = spec.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "")
  const f = `${OUT}/${String(i).padStart(2, "0")}-${slug}${SUFFIX}.png`
  await page.screenshot({ path: f, fullPage: true })
  console.log(f)
}
if (ctx) await ctx.close()
await browser.close()
