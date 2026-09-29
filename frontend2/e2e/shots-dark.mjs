// Dark-mode sweep: every sidebar route for every role at 1280 and 390 px,
// screenshot + axe colour-contrast.
// Usage: E2E_BASE_URL=http://localhost:5121 SESSIONS=path/to/sessions.json OUT=dir node e2e/shots-dark.mjs
import { chromium } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"

const BASE = process.env.E2E_BASE_URL || "http://localhost:5121"
const OUT = process.env.OUT
const ONLY = process.env.ROLES?.split(",")
const sessions = JSON.parse(fs.readFileSync(process.env.SESSIONS, "utf8").replace(/^﻿/, ""))
fs.mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const report = []
const todo = Object.entries(sessions).filter(([role]) => !ONLY || ONLY.includes(role))
async function worker() {
  for (let job = todo.shift(); job; job = todo.shift()) await one(...job).catch((e) => report.push(`${job[0]} CRASH ${e.message.split("\n")[0]}`))
}
await Promise.all([worker(), worker(), worker(), worker()])
await browser.close()
fs.writeFileSync(path.join(OUT, "contrast.txt"), report.join("\n"))
console.log(`done, ${report.length} contrast failures`)

async function one(role, raw) {
  const key = JSON.parse(raw).session_key
  const state = { cookies: [{ name: "sessionid", value: key, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [{ origin: BASE, localStorage: [{ name: "theme", value: "dark" }] }] }
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ storageState: state, viewport: { width, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" })
    const page = await ctx.newPage()
    await page.goto(BASE + "/")
    await page.waitForLoadState("networkidle")
    const gotIt = page.getByRole("button", { name: "Got it" })
    await gotIt.click({ timeout: 4000 }).catch(() => {})
    const routes = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('nav[aria-label="Main"] a[href]')).map((a) => a.getAttribute("href")))])
    for (const r of routes) try {
      await page.goto(BASE + r).catch(() => page.waitForTimeout(1500))
      await page.waitForLoadState("networkidle")
      await page.waitForTimeout(500)
      const name = `${role}${r.replace(/[^a-z0-9]+/gi, "-")}-${width}`.replace(/-+$/, "")
      await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: width === 1280 })
      await page.addScriptTag({ path: process.env.AXE_JS }) // axe-core/axe.min.js
      const axe = await page.evaluate(() => window.axe.run(document, { runOnly: ["color-contrast"] }))
      for (const v of axe.violations)
        for (const n of v.nodes)
          report.push(`${role} ${r} @${width}: ${n.target.join(" ")} :: ${n.any[0]?.message?.slice(0, 140)}`)
    } catch (e) {
      report.push(`${role} ${r} @${width}: SKIPPED ${e.message.split("\n")[0]}`)
    }
    await ctx.close()
  }
}
