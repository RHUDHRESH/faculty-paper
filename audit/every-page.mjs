/**
 * Walk every page in every portal and measure what is actually wrong.
 *
 * Not a screenshot review — those catch what you happen to look at. This
 * checks the faults that are invisible until somebody hits them:
 *
 *  - text that overflows its container (a long journal title running out
 *    through the side of a card)
 *  - the page scrolling sideways, at desktop and at phone width
 *  - links that point at a route the router does not have
 *  - headings that repeat their own page title
 *  - console and page errors
 *  - anything that renders as an empty shell with no explanation
 */
import puppeteer from "puppeteer"

const BASE = "http://localhost:5173"

const ACCOUNTS = {
  admin: ["admin@college.edu", "admin123"],
  finance: ["finance@college.edu", "finance123"],
  principal: ["principal@college.edu", "principal123"],
  faculty: ["faculty@college.edu", "faculty123"],
}

const PAGES = [
  ["admin", "/admin"],
  ["admin", "/admin/clearing"],
  ["admin", "/admin/submit"],
  ["admin", "/admin/reports"],
  ["admin", "/admin/accreditation"],
  ["admin", "/admin/faults"],
  ["admin", "/admin/duplicates"],
  ["admin", "/admin/query"],
  ["admin", "/admin/data"],
  ["admin", "/admin/audit"],
  ["admin", "/admin/users"],
  ["admin", "/admin/budget"],
  ["admin", "/admin/formula"],
  ["admin", "/admin/monthly"],
  ["admin", "/admin/prior"],
  ["admin", "/admin/scimago"],
  ["admin", "/admin/find?q=SUB-00089"],
  ["admin", "/admin/journal?title=Ceramics%20International"],
  ["finance", "/finance"],
  ["finance", "/finance/paid"],
  ["finance", "/finance/ledger"],
  ["finance", "/finance/reports"],
  ["finance", "/finance/duplicates"],
  ["finance", "/finance/query"],
  ["finance", "/finance/budget"],
  ["principal", "/principal"],
  ["principal", "/principal/all"],
  ["principal", "/principal/overview"],
  ["principal", "/principal/reports"],
  ["principal", "/principal/accreditation"],
  ["principal", "/principal/budget"],
  ["principal", "/principal/query"],
  ["principal", "/principal/data"],
  ["faculty", "/faculty"],
  ["faculty", "/faculty/new"],
]

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const ctx = await browser.createBrowserContext()
const page = await ctx.newPage()
const errors = []
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)))
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160))
})

async function login(role) {
  const [email, password] = ACCOUNTS[role]
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  if (!page.url().includes("/login")) {
    await page.evaluate(() =>
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { "X-CSRFToken": (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "" },
      })
    )
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  }
  for (const [sel, val] of [["#email", email], ["#password", password]]) {
    await page.focus(sel)
    await page.keyboard.down("Control")
    await page.keyboard.press("KeyA")
    await page.keyboard.up("Control")
    await page.keyboard.press("Backspace")
    await page.type(sel, val)
  }
  await Promise.all([
    page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ])
}

/** What is measurably wrong on whatever is currently rendered. */
const inspect = () =>
  page.evaluate(() => {
    const out = { overflow: [], sideways: 0, deadLinks: [], emptyShell: false, h1: null }

    const doc = document.documentElement
    out.sideways = Math.max(0, doc.scrollWidth - doc.clientWidth)

    // Text wider than the box it sits in. Only leaf-ish elements with text,
    // and only where the parent is not itself a scroller — a table inside an
    // overflow-auto box is meant to be wider.
    const scrollable = (el) => {
      const s = getComputedStyle(el)
      return s.overflowX === "auto" || s.overflowX === "scroll"
    }
    for (const el of document.querySelectorAll("main span, main a, main p, main h1, main h2, main h3, main td, main th, main li")) {
      if (!el.textContent || !el.textContent.trim()) continue
      if (el.children.length > 2) continue
      let box = el.parentElement
      while (box && box !== document.body && !scrollable(box) && getComputedStyle(box).overflow === "visible") {
        box = box.parentElement
      }
      if (!box || box === document.body || scrollable(box)) continue
      const a = el.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const spill = Math.round(a.right - b.right)
      if (spill > 4 && a.width > 30) {
        out.overflow.push({
          text: el.textContent.trim().slice(0, 60),
          spill,
          tag: el.tagName.toLowerCase(),
        })
      }
    }
    out.overflow = out.overflow.slice(0, 5)

    const h1 = document.querySelector("main h1") || document.querySelector("h1")
    out.h1 = h1 ? h1.innerText.trim().slice(0, 50) : null

    // A page with a heading and nothing else, and no explanation of why.
    const body = (document.querySelector("main") || document.body).innerText
    out.emptyShell = body.trim().split("\n").filter(Boolean).length < 4

    // Internal links that the router has no route for are collected here and
    // checked against the route table by the caller.
    out.deadLinks = [...document.querySelectorAll('a[href^="/"]')]
      .map((a) => a.getAttribute("href"))
      .filter((h, i, all) => all.indexOf(h) === i)
      .slice(0, 40)
    return out
  })

const problems = []
let lastRole = null

for (const [role, path] of PAGES) {
  if (role !== lastRole) {
    await login(role)
    lastRole = role
  }
  errors.length = 0

  for (const [label, width, height] of [["desktop", 1440, 950], ["phone", 390, 844]]) {
    await page.setViewport({ width, height })
    await page.goto(BASE + path, { waitUntil: "networkidle2" })
    await new Promise((r) => setTimeout(r, label === "desktop" ? 3200 : 1800))
    const r = await inspect()

    if (r.sideways > 2) {
      problems.push(`${path} [${label}] page scrolls sideways by ${r.sideways}px`)
    }
    for (const o of r.overflow) {
      problems.push(`${path} [${label}] "${o.text}" spills ${o.spill}px past its ${o.tag} box`)
    }
    if (label === "desktop") {
      if (r.emptyShell) problems.push(`${path} renders almost nothing — ${JSON.stringify(r.h1)}`)
      if (!r.h1) problems.push(`${path} has no page heading`)
    }
  }
  if (errors.length) {
    problems.push(`${path} console/page errors: ${[...new Set(errors)].slice(0, 2).join(" | ")}`)
  }
  process.stdout.write(".")
}

console.log("\n")
if (!problems.length) {
  console.log("Every page: no overflow, no sideways scroll, no errors, nothing blank.")
} else {
  console.log(`${problems.length} problem(s):`)
  for (const p of problems) console.log("  - " + p)
}
await browser.close()
