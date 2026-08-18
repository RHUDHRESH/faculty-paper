/**
 * Page-by-page UI audit.
 *
 * Loads every page as the role that owns it and reports what a careful reviewer
 * would notice: crashes, failed calls, text the user should never see, controls
 * with no accessible name, and layout that breaks the viewport.
 */
import puppeteer from "puppeteer"
import { ACCOUNTS, PAGES } from "./pages.mjs"

const BASE = process.env.BASE || "http://localhost:5173"
const ONLY = process.argv[2] || null      // substring filter on page name/path

/** Text no user should ever be shown. */
const LEAKED_TEXT = [
  "undefined", "NaN", "[object Object]", "null,", "Infinity",
  "â€", "â‚", "Â·", "ï»¿",
]

async function signIn(page, role) {
  const who = ACCOUNTS[role]
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  await page.waitForSelector("#email", { timeout: 15000 })
  // The dev build pre-fills a demo account, so clear before typing.
  for (const [sel, value] of [["#email", who.email], ["#password", who.password]]) {
    await page.focus(sel)
    await page.keyboard.down("Control")
    await page.keyboard.press("KeyA")
    await page.keyboard.up("Control")
    await page.keyboard.press("Backspace")
    await page.type(sel, value)
  }
  await Promise.all([
    page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ])
}

async function inspect(page) {
  return page.evaluate((LEAKED_TEXT) => {
    const out = { leaked: [], noName: [], unlabelled: [], dupIds: [], overflow: null,
                  noAlt: [], h1: null, emptyLinks: [] }

    const main = document.querySelector("main") || document.body
    const text = main.innerText || ""
    for (const bad of LEAKED_TEXT) {
      if (text.includes(bad)) {
        const i = text.indexOf(bad)
        out.leaked.push({ token: bad, context: text.slice(Math.max(0, i - 60), i + 60).replace(/\s+/g, " ") })
      }
    }

    const name = (el) =>
      (el.getAttribute("aria-label") || el.getAttribute("title") ||
       el.innerText || el.value || "").trim()

    for (const el of main.querySelectorAll("button")) {
      if (el.offsetParent === null) continue
      if (!name(el)) out.noName.push(el.outerHTML.slice(0, 120))
    }
    for (const el of main.querySelectorAll("a[href]")) {
      if (el.offsetParent === null) continue
      if (!name(el)) out.emptyLinks.push(el.getAttribute("href"))
    }

    for (const el of main.querySelectorAll("input, select, textarea")) {
      if (el.type === "hidden") continue
      // Radix renders an aria-hidden native <select> behind its own listbox.
      if (el.closest("[aria-hidden='true']") || el.getAttribute("aria-hidden") === "true") continue
      const hasLabel =
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
        el.closest("label") ||
        el.getAttribute("aria-label") ||
        el.getAttribute("aria-labelledby")
      if (!hasLabel) {
        out.unlabelled.push(
          `<${el.tagName.toLowerCase()} type=${el.type || "-"} id=${el.id || "-"} ` +
          `placeholder=${JSON.stringify(el.placeholder || "")}>`
        )
      }
    }

    const seen = new Map()
    for (const el of document.querySelectorAll("[id]")) {
      seen.set(el.id, (seen.get(el.id) || 0) + 1)
    }
    for (const [id, n] of seen) if (n > 1) out.dupIds.push(`${id} x${n}`)

    for (const img of main.querySelectorAll("img")) {
      if (!img.hasAttribute("alt")) out.noAlt.push(img.src.slice(0, 100))
    }

    const de = document.documentElement
    if (de.scrollWidth > de.clientWidth + 1) {
      const wide = [...main.querySelectorAll("*")]
        .filter((e) => e.getBoundingClientRect().right > de.clientWidth + 1)
        .slice(0, 3)
        .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}`)
      out.overflow = { page: de.scrollWidth, viewport: de.clientWidth, culprits: wide }
    }

    const h1s = [...document.querySelectorAll("h1")].map((h) => h.innerText.trim())
    out.h1 = h1s
    return out
  }, LEAKED_TEXT)
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const report = []

let currentRole = null
let context = null
let page = null

for (const spec of PAGES) {
  if (ONLY && !(spec.name + spec.path).toLowerCase().includes(ONLY.toLowerCase())) continue

  if (spec.role !== currentRole) {
    // A fresh context per role: cookies are browser-wide, so reusing one meant
    // /login redirected to the already-signed-in portal.
    if (context) await context.close()
    context = await browser.createBrowserContext()
    page = await context.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    await signIn(page, spec.role)
    currentRole = spec.role
  }

  const consoleErrors = []
  const pageErrors = []
  const badRequests = []
  const onConsole = (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)) }
  const onPageError = (e) => pageErrors.push(String(e).slice(0, 300))
  const onResponse = (r) => {
    const s = r.status()
    if (s >= 400) badRequests.push(`${s} ${r.request().method()} ${r.url().replace(BASE, "")}`)
  }
  page.on("console", onConsole)
  page.on("pageerror", onPageError)
  page.on("response", onResponse)

  await page.goto(BASE + spec.path, { waitUntil: "networkidle2", timeout: 30000 })
  await new Promise((r) => setTimeout(r, 900))

  const title = await page.title()
  const url = new URL(page.url()).pathname
  const findings = await inspect(page)

  page.off("console", onConsole)
  page.off("pageerror", onPageError)
  page.off("response", onResponse)

  report.push({ ...spec, url, title, consoleErrors, pageErrors, badRequests, ...findings })
}

await browser.close()

// ---- print ----
let issues = 0
for (const r of report) {
  const lines = []
  if (r.url !== r.path) lines.push(`REDIRECTED to ${r.url}`)
  if (r.pageErrors.length) lines.push(`CRASH: ${r.pageErrors.join(" | ")}`)
  if (r.badRequests.length) lines.push(`requests: ${[...new Set(r.badRequests)].join(", ")}`)
  if (r.consoleErrors.length) lines.push(`console: ${[...new Set(r.consoleErrors)].slice(0, 3).join(" | ")}`)
  for (const l of r.leaked) lines.push(`leaked "${l.token}": …${l.context}…`)
  if (r.overflow) lines.push(`overflow: page ${r.overflow.page}px > viewport ${r.overflow.viewport}px (${r.overflow.culprits.join(", ")})`)
  if (r.noName.length) lines.push(`${r.noName.length} button(s) with no accessible name: ${r.noName[0]}`)
  if (r.emptyLinks.length) lines.push(`link(s) with no text: ${r.emptyLinks.join(", ")}`)
  for (const u of r.unlabelled) lines.push(`unlabelled field: ${u}`)
  if (r.dupIds.length) lines.push(`duplicate ids: ${r.dupIds.join(", ")}`)
  if (r.noAlt.length) lines.push(`${r.noAlt.length} img without alt`)
  if (r.h1.length !== 1) lines.push(`h1 count = ${r.h1.length} ${JSON.stringify(r.h1)}`)
  if (!r.title || r.title === "Publication Tickets") lines.push(`page title is generic: ${JSON.stringify(r.title)}`)

  if (lines.length) {
    issues += lines.length
    console.log(`\n### ${r.name}  (${r.path})`)
    for (const l of lines) console.log("   - " + l)
  } else {
    console.log(`\n### ${r.name}  (${r.path})\n   clean`)
  }
}
console.log(`\n\n${issues} issue line(s) across ${report.length} page(s)`)
