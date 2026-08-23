/**
 * Every figure on the reports page opens its own rows, in place.
 *
 * This check used to count `<a href="/query?...">` links, because that is what
 * a figure used to be. Figures now open a panel over the report instead, so
 * the old assertions found "no link" on four dimensions and still exited
 * clean — a check that had stopped testing anything while continuing to pass.
 *
 * It now drives the real thing: click the figure, confirm the panel opens with
 * the right heading and a non-zero count, confirm the report is still there
 * underneath, and close it.
 */
import puppeteer from "puppeteer"

const BASE = "http://localhost:5173"

/** label to click → what the panel should say it is. */
const FIGURES = [
  ["Associate Professor", "Designation"],
  ["Journal", "Kind of publication"],
  ["Scopus", "Indexed in"],
  ["Q1", "Quartile"],
]

const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const p = await (await b.createBrowserContext()).newPage()
await p.setViewport({ width: 1440, height: 1000 })
const errs = []
p.on("pageerror", (e) => errs.push(String(e).slice(0, 150)))

await p.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
for (const [s, v] of [["#email", "admin@college.edu"], ["#password", "admin123"]]) {
  await p.focus(s)
  await p.keyboard.down("Control")
  await p.keyboard.press("KeyA")
  await p.keyboard.up("Control")
  await p.keyboard.press("Backspace")
  await p.type(s, v)
}
await Promise.all([
  p.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 }),
  p.click('button[type="submit"]'),
])

await p.goto(`${BASE}/admin/reports`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 4500))

console.log(
  "the same number printed twice:",
  await p.evaluate(() => (document.body.innerText.match(/\b(\d+)\s+\1\s+(claim|paper|publication)/g) || []).slice(0, 3))
)

const openable = await p.evaluate(
  () => document.querySelectorAll("main button, main a[href*='/journal?'], main a[href*='/faculty/']").length
)
console.log("clickable figures on the page:", openable)

let failures = 0
for (const [label, dimension] of FIGURES) {
  const clicked = await p.evaluate((l) => {
    const b = [...document.querySelectorAll("main button")].find(
      (x) => x.innerText.trim().split("\n")[0] === l
    )
    if (!b) return false
    b.click()
    return true
  }, label)
  if (!clicked) {
    console.log(`${label.padEnd(22)} NOT FOUND on the page`)
    failures++
    continue
  }
  await new Promise((r) => setTimeout(r, 2600))
  const r = await p.evaluate(() => {
    const d = document.querySelector("[role=dialog]")
    if (!d) return { open: false }
    const t = d.innerText
    return {
      open: true,
      title: (d.querySelector("h2") || {}).innerText || null,
      // The description element itself, not "whatever the second line is" —
      // the heading is followed by a blank line, so index 1 was always empty.
      subtitle: (d.querySelector('[data-slot="sheet-description"]') || {}).innerText || "",
      rows: d.querySelectorAll("ul > li").length,
      escapes: /Open in Query/.test(t),
    }
  })
  const count = (r.subtitle || "").match(/([\d,]+) publication/)
  const ok =
    r.open &&
    r.title === label &&
    (r.subtitle || "").includes(dimension) &&
    r.rows > 0 &&
    r.escapes
  if (!ok) failures++
  console.log(
    `${label.padEnd(22)} ${ok ? "opens" : "FAILED"} · ${r.title} · ${dimension} · ` +
      `${count ? count[1] : "?"} rows behind it · ${r.rows} shown`
  )
  await p.keyboard.press("Escape")
  await new Promise((r) => setTimeout(r, 700))
  const stillHere = await p.evaluate(
    () => !document.querySelector("[role=dialog]") && /Reports/.test(document.body.innerText)
  )
  if (!stillHere) {
    console.log(`  ${label}: closing did not return to the report`)
    failures++
  }
}

console.log(failures ? `${failures} FAILURE(S)` : "Every figure opens its rows and gives the page back.")
console.log("errors:", errs.length ? errs : "none")
await b.close()
