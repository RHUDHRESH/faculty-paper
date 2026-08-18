/**
 * The same pages at phone width and in dark mode.
 *
 * Horizontal overflow and unreadable contrast only show up in one of the four
 * combinations, so each page is loaded in all of them.
 */
import puppeteer from "puppeteer"
import { ACCOUNTS, PAGES } from "./pages.mjs"

const BASE = process.env.BASE || "http://localhost:5173"
const VIEWPORTS = [
  { name: "mobile",  width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
]
const THEMES = ["light", "dark"]

async function signIn(page, role) {
  const who = ACCOUNTS[role]
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  await page.waitForSelector("#email", { timeout: 15000 })
  for (const [sel, value] of [["#email", who.email], ["#password", who.password]]) {
    await page.focus(sel)
    await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control")
    await page.keyboard.press("Backspace")
    await page.type(sel, value)
  }
  await Promise.all([
    page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ])
}

/** Relative luminance, for the WCAG contrast ratio. */
const CONTRAST_FN = `
function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function parse(c) {
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number)
  if (p.length < 3 || Number.isNaN(p[0])) return null
  return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }
}
function ratio(fg, bg) {
  const a = lum(fg) + 0.05, b = lum(bg) + 0.05
  return a > b ? a / b : b / a
}
`

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const problems = []

for (const theme of THEMES) {
  for (const vp of VIEWPORTS) {
    let currentRole = null, context = null, page = null
    for (const spec of PAGES) {
      if (spec.role !== currentRole) {
        if (context) await context.close()
        context = await browser.createBrowserContext()
        page = await context.newPage()
        await page.setViewport({ width: vp.width, height: vp.height })
        await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }])
        await signIn(page, spec.role)
        currentRole = spec.role
      }
      await page.setViewport({ width: vp.width, height: vp.height })
      await page.goto(BASE + spec.path, { waitUntil: "networkidle2", timeout: 30000 })
      await new Promise((r) => setTimeout(r, 700))

      const found = await page.evaluate((CONTRAST_FN) => {
        eval(CONTRAST_FN)
        const out = { overflow: null, lowContrast: [], offscreen: [] }
        const de = document.documentElement
        if (de.scrollWidth > de.clientWidth + 1) {
          const culprits = [...document.querySelectorAll("main *")]
            .filter((e) => {
              const r = e.getBoundingClientRect()
              return r.width > 0 && r.right > de.clientWidth + 1
            })
            .slice(0, 4)
            .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(" ").slice(0, 3).join(".")}`)
          out.overflow = { page: de.scrollWidth, viewport: de.clientWidth, culprits }
        }

        // Text that cannot be read against what is actually behind it.
        const bgOf = (el) => {
          let n = el
          while (n && n !== document.documentElement) {
            const c = parse(getComputedStyle(n).backgroundColor)
            if (c && c.a > 0.5) return c.rgb
            n = n.parentElement
          }
          return parse(getComputedStyle(document.body).backgroundColor)?.rgb || [255, 255, 255]
        }
        const seen = new Set()
        for (const el of document.querySelectorAll("main p, main span, main td, main th, main a, main label, main li, main h1, main h2, main h3")) {
          const text = (el.textContent || "").trim()
          if (!text || text.length < 3) continue
          if (el.querySelector("*")) continue
          const st = getComputedStyle(el)
          if (st.visibility === "hidden" || st.display === "none" || +st.opacity < 0.4) continue
          const fg = parse(st.color)
          if (!fg) continue
          const r = ratio(fg.rgb, bgOf(el))
          const size = parseFloat(st.fontSize)
          const bold = +st.fontWeight >= 700
          const large = size >= 24 || (size >= 18.66 && bold)
          const need = large ? 3 : 4.5
          if (r < need) {
            const key = st.color + "|" + text.slice(0, 20)
            if (seen.has(key)) continue
            seen.add(key)
            out.lowContrast.push({ text: text.slice(0, 45), ratio: +r.toFixed(2), need, color: st.color, size })
          }
        }
        return out
      }, CONTRAST_FN)

      if (found.overflow || found.lowContrast.length) {
        problems.push({ theme, vp: vp.name, page: spec.name, path: spec.path, ...found })
      }
    }
    if (context) await context.close()
  }
}

await browser.close()

if (!problems.length) {
  console.log("no overflow or contrast problems in any theme/viewport")
} else {
  for (const p of problems) {
    console.log(`\n### ${p.page} — ${p.theme} / ${p.vp}`)
    if (p.overflow) console.log(`   - overflow ${p.overflow.page}px > ${p.overflow.viewport}px  (${p.overflow.culprits.join(", ")})`)
    for (const c of p.lowContrast.slice(0, 5)) {
      console.log(`   - contrast ${c.ratio}:1 (needs ${c.need}) ${c.color} ${c.size}px — "${c.text}"`)
    }
  }
  console.log(`\n${problems.length} page/mode combination(s) with problems`)
}
