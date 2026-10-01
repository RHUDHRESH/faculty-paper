// Prints every printable page to an A4 PDF, as a dark-mode user would.
// Usage: E2E_BASE_URL=... SESSIONS=sessions.json OUT=dir node e2e/print-pdfs.mjs
import { chromium } from "@playwright/test"
import fs from "node:fs"
import path from "node:path"

const BASE = process.env.E2E_BASE_URL || "http://localhost:5121"
const OUT = process.env.OUT
const sessions = JSON.parse(fs.readFileSync(process.env.SESSIONS, "utf8").replace(/^﻿/, ""))
fs.mkdirSync(OUT, { recursive: true })

const jobs = [
  ["year-brief", "PRINCIPAL", "/reports/brief"],
  ["hod-report", "HOD", "/department"],
  ["report-builder", "RESEARCH_CELL", "/reports/build"],
  ["appraisal-list", "FACULTY", "/papers/appraisal"],
  ["payment-statement", "FACULTY", "/papers/statement"],
  ["monthly-statement", "FINANCE", "/statements"],
  ["payments-register", "FINANCE", "/payments/done"],
  ["quick-guide", "RESEARCH_CELL", "/help"],
  ["leaderboard", "PRINCIPAL", "/leaderboard"],
  ["paper-receipt", "RESEARCH_CELL", null],
]

const browser = await chromium.launch()
for (const [name, role, route] of jobs) {
  const key = JSON.parse(sessions[role]).session_key
  const ctx = await browser.newContext({
    storageState: { cookies: [{ name: "sessionid", value: key, domain: "localhost", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [{ origin: BASE, localStorage: [{ name: "theme", value: "dark" }] }] },
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
  })
  const page = await ctx.newPage()
  let url = route
  if (!url) {
    await page.goto(BASE + "/publications")
    await page.waitForLoadState("networkidle")
    // The list draws after the first idle, so wait for a link rather than hope.
    await page.waitForSelector("a[href^='/papers/']", { timeout: 20000 }).catch(() => {})
    url = await page.evaluate(() => Array.from(document.querySelectorAll("a[href^='/papers/']")).map((a) => a.getAttribute("href")).find((h) => /^\/papers\/[^/?]+$/.test(h) && !/\/(new|appraisal|claims|statement)$/.test(h)))
    if (!url) { console.log("no paper link found"); await ctx.close(); continue }
  }
  await page.goto(BASE + url)
  await page.waitForLoadState("networkidle")
  await page.waitForTimeout(800)
  // What window.print() does first: tell the page it is about to print.
  await page.evaluate(() => dispatchEvent(new Event("beforeprint")))
  await page.emulateMedia({ media: "print" })
  await page.pdf({ path: path.join(OUT, name + ".pdf"), preferCSSPageSize: true, printBackground: true })
  console.log(name, url)
  await ctx.close()
}
await browser.close()
