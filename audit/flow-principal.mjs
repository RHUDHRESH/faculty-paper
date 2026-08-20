/**
 * The principal's route through the portal: find a person by name, read their
 * record, download it, and raise a note on one of their tickets — then check
 * the research cell sees that note and the claimant does not.
 */
import puppeteer from "puppeteer"

const BASE = "http://localhost:5173"

async function signIn(ctx, email, pw) {
  const page = await ctx.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
  for (const [sel, v] of [["#email", email], ["#password", pw]]) {
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
  return page
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const errors = []

// ---- the principal --------------------------------------------------------
const pctx = await browser.createBrowserContext()
const p = await signIn(pctx, "principal@college.edu", "principal123")
p.on("pageerror", (e) => errors.push("principal: " + String(e).slice(0, 140)))
// The detail is an in-page panel, so the claim id has to come off the wire.
let openClaimId = null
p.on("request", (r) => {
  const m = r.url().match(/\/api\/claims\/([0-9a-f-]{16,})\/notes/)
  if (m) openClaimId = m[1]
})

await p.goto(`${BASE}/principal/find`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 900))
console.log("find page:", JSON.stringify(await p.evaluate(() => ({
  box: !!document.querySelector("#lookup-q"),
  prompt: /Type at least two characters/.test(document.body.innerText),
}))))

// Search for a person by name.
await p.type("#lookup-q", "Demo")
await p.click('button[type="submit"]')
await new Promise((r) => setTimeout(r, 1600))
const found = await p.evaluate(() => ({
  facultyRows: [...document.querySelectorAll("button")].filter((b) => /Open record/.test(b.innerText)).length,
  text: (document.body.innerText.match(/Faculty\n[\s\S]{0,120}/) || [""])[0].replace(/\n/g, " · "),
}))
console.log("search by name:", JSON.stringify(found))

// Open the record.
await p.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Open record/.test(x.innerText))
  b?.click()
})
await new Promise((r) => setTimeout(r, 2000))
const record = await p.evaluate(() => ({
  url: location.search,
  stats: [...document.querySelectorAll("dt, .text-xs")].map((e) => e.innerText.trim()).filter((t) =>
    /Publications|Paid claims|In review|^Paid$/.test(t)
  ),
  charts: document.querySelectorAll("svg").length,
  showNumbers: [...document.querySelectorAll("button")].filter((b) => /Show numbers/i.test(b.innerText)).length,
  excel: [...document.querySelectorAll("a")].some((a) => /report\/export\?fmt=xlsx/.test(a.href)),
  csv: [...document.querySelectorAll("a")].some((a) => /report\/export\?fmt=csv/.test(a.href)),
  ticketRows: document.querySelectorAll("tbody tr").length,
}))
console.log("faculty record:", JSON.stringify(record))

// The Excel download must actually be a workbook, not an HTML error page.
const xlsx = await p.evaluate(async () => {
  const a = [...document.querySelectorAll("a")].find((x) => /fmt=xlsx/.test(x.href))
  if (!a) return null
  const r = await fetch(a.href, { credentials: "include" })
  const buf = new Uint8Array(await r.arrayBuffer())
  return {
    status: r.status,
    type: r.headers.get("content-type"),
    // A .xlsx is a zip: "PK".
    zip: buf[0] === 0x50 && buf[1] === 0x4b,
    bytes: buf.length,
  }
})
console.log("excel download:", JSON.stringify(xlsx))
await p.screenshot({ path: "audit/shots/principal-faculty-record.png", fullPage: true })

// ---- a note on a ticket ---------------------------------------------------
// /principal is the approvals queue now; every ticket lives under /principal/all.
await p.goto(`${BASE}/principal/all`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 1800))
// The queue renders one button per ticket, not a table.
await p.evaluate(() => {
  const row = [...document.querySelectorAll("button")].find((b) => /^(SUB|FP)-\d/.test(b.innerText.trim()))
  row?.click()
})
await new Promise((r) => setTimeout(r, 1600))
const notesPanel = await p.evaluate(() => ({
  panel: /Notes on this ticket/.test(document.body.innerText),
  audience: /Principal and research cell only/.test(document.body.innerText),
  box: !!document.querySelector('[aria-label="New note on this ticket"]'),
}))
console.log("notes panel (principal):", JSON.stringify(notesPanel))

const marker = "Audit note: please confirm the SNIP on this one"
const raised = await p.evaluate(async (marker) => {
  const ta = document.querySelector('[aria-label="New note on this ticket"]')
  if (!ta) return "no box"
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set
  set.call(ta, marker)
  ta.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}, marker)
await new Promise((r) => setTimeout(r, 400))
await p.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Raise a note/.test(x.innerText))
  b?.click()
})
await new Promise((r) => setTimeout(r, 1800))
const afterRaise = await p.evaluate((marker) => ({
  visible: document.body.innerText.includes(marker),
  openBadge: /\d+ open/.test(document.body.innerText),
  // The principal must not be able to close their own note.
  canResolve: [...document.querySelectorAll("button")].some((b) => /Mark handled/.test(b.innerText)),
}), marker)
console.log("note raised:", raised, JSON.stringify(afterRaise))

console.log("ticket under discussion:", openClaimId)

// ---- the research cell sees it -------------------------------------------
const actx = await browser.createBrowserContext()
const a = await signIn(actx, "admin@college.edu", "admin123")
a.on("pageerror", (e) => errors.push("admin: " + String(e).slice(0, 140)))
await a.goto(`${BASE}/admin/clearing?claim=${openClaimId}`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 2200))
console.log("admin sees the note:", JSON.stringify(await a.evaluate((marker) => ({
  url: location.pathname + location.search,
  detailOpen: /Notes on this ticket/.test(document.body.innerText),
  visible: document.body.innerText.includes(marker),
  canResolve: [...document.querySelectorAll("button")].some((b) => /Mark handled/.test(b.innerText)),
}), marker)))

// ---- the claimant must not ------------------------------------------------
const fctx = await browser.createBrowserContext()
const f = await signIn(fctx, "faculty@college.edu", "faculty123")
const denied = await f.evaluate(async () => {
  const r = await fetch("/api/claims/00000000-0000-0000-0000-000000000000/notes", {
    credentials: "include",
  })
  return r.status
})
console.log("faculty reading notes:", denied, "(403 = refused, 404 = would have been allowed)")

await a.screenshot({ path: "audit/shots/admin-ticket-note.png", fullPage: true })
console.log("page errors:", errors.length ? errors : "none")
await browser.close()
