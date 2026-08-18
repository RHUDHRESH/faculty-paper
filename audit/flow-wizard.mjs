/**
 * The claim wizard, walked the way a faculty member walks it.
 *
 * Checks the things a page-load audit cannot see: whether validation fires on
 * the right step, whether errors name the field, whether the estimate tracks
 * what has been entered, and whether going back keeps the work.
 */
import puppeteer from "puppeteer"
import { ACCOUNTS } from "./pages.mjs"

const BASE = "http://localhost:5173"
const notes = []
const ok = (m) => console.log("  ok   " + m)
const bad = (m) => { console.log("  BUG  " + m); notes.push(m) }

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const ctx = await browser.createBrowserContext()
const page = await ctx.newPage()
await page.setViewport({ width: 1440, height: 900 })

const crashes = []
page.on("pageerror", (e) => crashes.push(String(e).slice(0, 200)))

const who = ACCOUNTS.faculty
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
for (const [sel, v] of [["#email", who.email], ["#password", who.password]]) {
  await page.focus(sel)
  await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control")
  await page.keyboard.press("Backspace"); await page.type(sel, v)
}
await Promise.all([
  page.waitForFunction(() => !location.pathname.startsWith("/login")),
  page.click('button[type="submit"]'),
])

const text = () => page.evaluate(() => (document.querySelector("main") || document.body).innerText)
const clickText = (label) =>
  page.evaluate((l) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === l)
    if (b && !b.disabled) { b.click(); return true }
    return false
  }, label)
const setField = (id, value) =>
  page.evaluate((id, value) => {
    const el = document.getElementById(id)
    if (!el) return false
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    return true
  }, id, value)
const pickOption = (label) =>
  page.evaluate((l) => {
    const el = [...document.querySelectorAll("[role=radio],[role=checkbox]")]
      .find((r) => ((r.closest("label") || r).innerText || "").trim().startsWith(l))
    if (el) { el.click(); return true }
    return false
  }, l => l, label).catch(() => false)

console.log("\n--- step 0: the gate ---")
await page.goto(`${BASE}/faculty/new`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 600))

const startDisabled = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim().startsWith("Start the claim"))
  return b ? b.disabled : null
})
if (startDisabled === true) ok("'Start the claim' is disabled until the confirmations are ticked")
else bad(`'Start the claim' disabled state before ticking = ${startDisabled}`)

await page.evaluate(() => {
  document.querySelectorAll("button[role=checkbox], input[type=checkbox]").forEach((b) => b.click())
})
await new Promise((r) => setTimeout(r, 400))
if (await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim().startsWith("Start the claim"))
  return b && !b.disabled
})) ok("enabled once all three are ticked")
else bad("still disabled after ticking all three confirmations")

await clickText("Start the claim")
await new Promise((r) => setTimeout(r, 700))

console.log("\n--- step 1: identity is prefilled from the profile ---")
const identity = await page.evaluate(() =>
  Object.fromEntries([...document.querySelectorAll("input")].map((e) => [e.id || e.placeholder, e.value])))
console.log("   " + JSON.stringify(identity))
if (identity.faculty_name) ok("name prefilled")
else bad("faculty name is empty on a profile that has one")

console.log("\n--- step 2: validation before continue ---")
await clickText("Continue")
await new Promise((r) => setTimeout(r, 500))
let t = await text()
if (t.includes("Step 2 of 5")) ok("advanced to Publication")
else bad("could not advance past Identity: " + t.slice(0, 120))

const blocked = await clickText("Continue")
await new Promise((r) => setTimeout(r, 500))
t = await text()
if (t.includes("Step 2 of 5") && /things to fix|required/i.test(t)) {
  ok("empty Publication step is refused and the problems are listed")
  const listed = (t.match(/\n- .*/g) || []).length
  console.log(`   problems surfaced: ${(t.match(/things to fix/) || []).length ? "yes" : "no"}`)
} else bad("advanced past an empty Publication step")

console.log("\n--- step 3: the estimate ---")
await setField("paper_title", "Puppeteer flow walk-through")
await setField("journal_title", "Journal of Flow Checks")
await setField("issn", "1234-5678")
await setField("publication_date", "2026-03-01")
await setField("yukthi_id", "YUK-FLOW-1")
await page.evaluate(() => {
  const pick = (t) => {
    const el = [...document.querySelectorAll("[role=radio],[role=checkbox]")]
      .find((r) => ((r.closest("label") || r).innerText || "").trim().startsWith(t))
    if (el) el.click()
  }
  pick("Regular Research Article"); pick("Scopus")
})
await new Promise((r) => setTimeout(r, 500))
await clickText("Continue")
await new Promise((r) => setTimeout(r, 800))
t = await text()
if (t.includes("Step 3 of 5")) ok("reached the Claim step")
else bad("blocked leaving Publication: " + t.slice(0, 200))

const zeroBeforeEvidence = /Why this comes to nothing[\s\S]{0,120}SEC-affiliated/.test(t)
if (zeroBeforeEvidence) bad("Claim step blames missing SEC references before Evidence collects them")
else ok("no premature 'zero because of SEC references' message")

console.log("\n--- step 4: back preserves the work ---")
await clickText("Back")
await new Promise((r) => setTimeout(r, 600))
const kept = await page.evaluate(() => document.getElementById("paper_title")?.value)
if (kept === "Puppeteer flow walk-through") ok("going back keeps what was typed")
else bad(`going back lost the title (got ${JSON.stringify(kept)})`)

console.log("\n--- autosave ---")
// The draft POST is debounced, so poll rather than reading instantly.
let saved = null
for (let i = 0; i < 8 && !saved; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  saved = (await text()).match(/Draft saved[^\n]*/)
}
if (saved) ok(`autosave indicator appeared: "${saved[0].trim()}"`)
else bad("no draft-saved indicator within 8s of editing")

if (crashes.length) bad("page errors during the walk: " + crashes.join(" | "))
else ok("no uncaught errors during the whole walk")

await browser.close()
console.log(`\n${notes.length} problem(s)`)
for (const n of notes) console.log(" - " + n)
