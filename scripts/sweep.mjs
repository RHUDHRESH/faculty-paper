// Sweep every sidebar destination for every role: full-page screenshot at
// desktop and phone width, console errors, failed API calls, sideways scroll,
// and every button/link visible on the page. Read-only: it navigates, it does
// not press anything that mutates.
//
//   cd frontend2 && node ../scripts/sweep.mjs            (servers must be up)
//
// Sessions come from `manage.py e2e_session` (DEBUG only, no passwords).
import { chromium } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const BASE = "http://localhost:5174"
const OUT = path.resolve("../sweep-out")
const PY = path.resolve("../.venv/Scripts/python.exe")
const ROLES = (process.env.ROLES || "FACULTY,RESEARCH_CELL,PRINCIPAL,DIRECTOR,FINANCE,HOD,SUPER_ADMIN").split(",")

function session(role) {
  const out = execFileSync(PY, ["manage.py", "e2e_session", "--role", role, "--json"], {
    cwd: path.resolve("../backend"),
    env: { ...process.env, DJANGO_USE_SQLITE: "true", DJANGO_DEBUG: "true" },
  }).toString()
  return JSON.parse(out.slice(out.indexOf("{")))
}

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch()
const report = {}

for (const role of ROLES) {
  const s = session(role)
  const key = s.session_key || s.sessionid || s.key
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addCookies([{ name: "sessionid", value: key, domain: "localhost", path: "/" }])
  const page = await ctx.newPage()
  const errors = []
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)))
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 200)))
  page.on("response", (r) => {
    if (r.url().includes("/api/") && r.status() >= 400) errors.push(`${r.status()} ${r.url().replace(BASE, "")}`)
  })

  await page.goto(BASE + "/", { waitUntil: "networkidle" })
  const routes = await page.$$eval("nav a[href^='/']", (as) => [...new Set(as.map((a) => a.getAttribute("href")))])
  report[role] = { routes: {} }
  for (const route of ["/", ...routes.filter((r) => r !== "/"), "/me"]) {
    errors.length = 0
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(BASE + route, { waitUntil: "networkidle" }).catch(() => {})
    await page.waitForTimeout(600)
    const slug = `${role}${route.replace(/[^a-z0-9]+/gi, "_")}`
    await page.screenshot({ path: `${OUT}/${slug}.png`, fullPage: true })
    const facts = await page.evaluate(() => ({
      h1: document.querySelector("h1")?.textContent?.trim(),
      buttons: [...document.querySelectorAll("main button, main a[href]")]
        .filter((b) => b.offsetParent)
        .map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 50))
        .filter(Boolean),
      emptyish: /nothing|no .* yet|empty/i.test(document.querySelector("main")?.innerText || ""),
      text: (document.querySelector("main")?.innerText || "").slice(0, 600),
    }))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(300)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    if (overflow > 1) await page.screenshot({ path: `${OUT}/${slug}_mobile.png`, fullPage: false })
    report[role].routes[route] = { ...facts, overflow, errors: [...errors] }
    console.log(role, route, facts.h1 || "(no h1)", errors.length ? `ERR ${errors.length}` : "", overflow > 1 ? `OVERFLOW ${overflow}` : "")
  }
  await ctx.close()
}
await browser.close()
await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 2))
