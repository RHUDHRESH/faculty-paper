/**
 * Attach the same reference file twice, and a file already used on another
 * ticket, and check the claimant is told — plus that a title read out of the
 * PDF is offered rather than filled in.
 *
 * Drives the actual wizard: the warnings are computed from the upload
 * response, so a synthetic call to the endpoint would prove nothing about
 * whether the page shows them.
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import puppeteer from "puppeteer"

const BASE = "http://localhost:5173"
const TMP = process.env.TMPDIR || "."

/** A minimal PDF carrying a real /Title in its info dictionary. */
function makePdf(title, body) {
  const stream = zlib.deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${body}) Tj ET`))
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    null, // the stream, written by hand below
    `<< /Title (${title}) /Producer (audit) >>`,
  ]
  let out = Buffer.from("%PDF-1.4\n")
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    if (i === 3) {
      out = Buffer.concat([
        out,
        Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`),
        stream,
        Buffer.from("\nendstream\nendobj\n"),
      ])
    } else {
      out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`)])
    }
  })
  const xref = out.length
  let table = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) table += `${String(off).padStart(10, "0")} 00000 n \n`
  table += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.concat([out, Buffer.from(table)])
}

const A = path.join(TMP, "audit-ref-a.pdf")
const B = path.join(TMP, "audit-ref-b.pdf")
fs.writeFileSync(A, makePdf("Machine Learning for Structural Health Monitoring", "ref a"))
fs.writeFileSync(B, makePdf("A Second Cited Paper", "ref b"))

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const ctx = await browser.createBrowserContext()
const page = await ctx.newPage()
await page.setViewport({ width: 1440, height: 1000 })
const errors = []
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)))
page.on("response", async (r) => {
  if (!r.url().includes("/api/claims/upload")) return
  try {
    const j = await r.json()
    console.log("  upload response:", JSON.stringify({
      status: r.status(),
      hash: (j.content_hash || "").slice(0, 12),
      suggested_title: j.suggested_title,
      duplicate_of: j.duplicate_of
        ? { ticket: j.duplicate_of.ticket_number, mine: j.duplicate_of.same_owner }
        : null,
    }))
  } catch { /* not json */ }
})

await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
for (const [sel, v] of [["#email", "faculty@college.edu"], ["#password", "faculty123"]]) {
  await page.focus(sel)
  await page.keyboard.down("Control")
  await page.keyboard.press("KeyA")
  await page.keyboard.up("Control")
  await page.keyboard.press("Backspace")
  await page.type(sel, v)
}
await Promise.all([
  page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 }),
  page.click('button[type="submit"]'),
])

await page.goto(`${BASE}/faculty/new`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 1500))

// The page opens on an eligibility notice whose acknowledgements gate the form.
for (const box of await page.$$('button[role="checkbox"], [role="checkbox"]')) {
  await box.click()
  await new Promise((r) => setTimeout(r, 120))
}
const start = await page.evaluateHandle(() =>
  [...document.querySelectorAll("button")].find((b) => /start the claim/i.test(b.innerText))
)
if (start.asElement()) {
  await start.asElement().click()
  await new Promise((r) => setTimeout(r, 1000))
}

/** React ignores a plain `.value =`; the native setter plus an input event is
 *  what a real keystroke looks like to it. */
async function fill(id, value) {
  await page.evaluate(
    (id, value) => {
      const el = document.getElementById(id)
      if (!el) return
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
      Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value)
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
    },
    id,
    value
  )
  await new Promise((r) => setTimeout(r, 120))
}

async function next() {
  const b = await page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((x) => /^(next|continue)/i.test(x.innerText.trim()))
  )
  if (!b.asElement()) return false
  await b.asElement().click()
  await new Promise((r) => setTimeout(r, 900))
  return true
}

await next() // Identity is prefilled from the profile

// Publication
await fill("paper_title", "Audit Harness Paper on Duplicate Reference Detection")
await fill("journal_title", "Journal of Audit Testing")
await fill("issn", "1234-5678")
await fill("publication_date", "2026-03-15")
await fill("subject_category", "Engineering")
await fill("yukthi_id", "YKT-AUDIT-001")
// Publication type and indexing are checkbox groups, not inputs.
await page.evaluate(() => {
  // CheckCards renders each option as a button[role=checkbox] carrying its label.
  const pick = (label) => {
    const b = [...document.querySelectorAll('[role="checkbox"]')].find((x) =>
      new RegExp(label, "i").test(x.innerText.trim())
    )
    b?.click()
  }
  pick("Regular Research Article")
  pick("^Scopus")
})
await new Promise((r) => setTimeout(r, 400))
await next()

// Claim: the payout inputs the claimant self-reports.
await page.evaluate(() => {
  // Quartile is a SegmentedControl: radio buttons inside a labelled group.
  const group = [...document.querySelectorAll('[role="radiogroup"], [aria-label]')].find(
    (g) => g.getAttribute("aria-label") === "Journal quartile"
  )
  const q = [...(group || document).querySelectorAll("button, [role=radio]")].find(
    (x) => x.innerText.trim() === "Q1"
  )
  q?.click()
})
await new Promise((r) => setTimeout(r, 300))
for (const id of ["self_reported_snip", "snip", "snip_value"]) await fill(id, "1.2")
await next()
const heading = await page.evaluate(() => document.body.innerText.slice(0, 200))
if (!/Reference 1/.test(await page.evaluate(() => document.body.innerText))) {
  console.log("stuck before evidence:", await page.evaluate(() =>
    [...document.querySelectorAll("[role=alert]")].map((e) => e.innerText.trim()).join(" | ").slice(0, 300)))
}
const step = await page.evaluate(() => document.body.innerText.match(/Reference 1/) ? "evidence" : "not-evidence")
console.log("reached:", step)

async function attach(slot, file) {
  // The evidence step has a general proof dropzone as well as one input per
  // citation; only the citation ones sit inside the reference list.
  const inputs = await page.$$('#sec_citations input[type="file"]')
  console.log(`  citation file inputs: ${inputs.length}`)
  if (!inputs[slot]) return console.log(`no citation file input at slot ${slot}`)
  await inputs[slot].uploadFile(file)
  await new Promise((r) => setTimeout(r, 900))
  const early = await page.evaluate(() => /From the file:/.test(document.body.innerText))
  await new Promise((r) => setTimeout(r, 3000))
  const late = await page.evaluate(() => /From the file:/.test(document.body.innerText))
  console.log(`  suggestion visible: 0.9s=${early} 3.9s=${late}`)
}

// Same file into reference 1 and reference 2.
await attach(0, A)
const afterFirst = await page.evaluate(() => ({
  suggestionOffered: /From the file:/.test(document.body.innerText),
  suggestedText: (document.body.innerText.match(/From the file:\s*\n?(.+?)\s*— use it\?/) || [])[1] || null,
  titleBoxFilled: (document.querySelector("#cite-0-title")?.value || "").length > 0,
}))
console.log("after 1st upload:", JSON.stringify(afterFirst))

await attach(0, A) // the next empty slot is reference 2
const afterSecond = await page.evaluate(() => ({
  sameFileWarning: /same file as/i.test(document.body.innerText),
  reusedWarning: /already uploaded/i.test(document.body.innerText),
  reusedSentence: (document.body.innerText.split(String.fromCharCode(10)).find((l) => /already uploaded/.test(l)) || null),
}))
console.log("after 2nd upload (same bytes):", JSON.stringify(afterSecond))

// Accept the suggested title on reference 1.
const applied = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /Machine Learning for Structural/i.test(b.innerText)
  )
  if (!btn) return null
  btn.click()
  return true
})
await new Promise((r) => setTimeout(r, 400))
const titleNow = await page.evaluate(
  () => document.querySelector("#cite-0-title")?.value || ""
)
console.log("suggestion clicked:", applied, "| title now:", JSON.stringify(titleNow))

await page.evaluate(() => window.scrollTo(0, 0))
await page.screenshot({ path: "audit/shots/duplicate-references.png", fullPage: true })
console.log("shot: audit/shots/duplicate-references.png")

console.log("page errors:", errors.length ? errors : "none")
await browser.close()
