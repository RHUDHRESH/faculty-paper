/**
 * The whole chain, driven through the real screens:
 * research cell clears -> finance cannot pay -> principal approves ->
 * finance can pay.
 */
import puppeteer from "puppeteer"

const BASE = "http://localhost:5173"

async function signIn(browser, email, pw) {
  const ctx = await browser.createBrowserContext()
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

// ---- finance sees nothing it cannot pay ----------------------------------
const fin = await signIn(browser, "finance@college.edu", "finance123")
fin.on("pageerror", (e) => errors.push("finance: " + String(e).slice(0, 140)))
await fin.goto(`${BASE}/finance`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 2000))
const before = await fin.evaluate(() => ({
  rows: document.querySelectorAll("tbody tr").length,
  empty: /Nothing|No payment|nothing/i.test(document.body.innerText),
}))
console.log("finance queue, before any approval:", JSON.stringify(before))

// ---- the principal's approval screen -------------------------------------
const p = await signIn(browser, "principal@college.edu", "principal123")
p.on("pageerror", (e) => errors.push("principal: " + String(e).slice(0, 140)))
await p.goto(`${BASE}/principal`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 2200))

const queue = await p.evaluate(() => ({
  heading: document.querySelector("h1")?.innerText,
  rows: document.querySelectorAll("tbody tr").length,
  waitingOnYou: /Waiting on you/i.test(document.body.innerText),
  filters: ["#pq-search", "#pq-dept", "#pq-quartile", "#pq-wait", "#pq-sort"].filter(
    (s) => !!document.querySelector(s)
  ),
  totalLine: (document.body.innerText.match(/Total to commit\s*\n?\s*([^\n]+)/) || [])[1] || null,
  longest: (document.body.innerText.match(/Longest wait\s*\n?\s*([^\n]+)/) || [])[1] || null,
}))
console.log("principal approvals:", JSON.stringify(queue))

// Select two rows and read the running total in the corner.
await p.evaluate(() => {
  const boxes = [...document.querySelectorAll('tbody [role="checkbox"]')]
  boxes.slice(0, 2).forEach((b) => b.click())
})
await new Promise((r) => setTimeout(r, 700))
const selection = await p.evaluate(() => {
  const panel = [...document.querySelectorAll("div")].find((d) =>
    /Selected/.test(d.innerText) && /Approve \d/.test(d.innerText)
  )
  if (!panel) return null
  const t = panel.innerText.replace(/\n+/g, " · ")
  return t.slice(0, 200)
})
console.log("selection panel:", JSON.stringify(selection))

// Approve them.
const approved = await p.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /^Approve \d/.test(x.innerText.trim()))
  if (!b) return "no approve button"
  b.click()
  return b.innerText.trim()
})
console.log("clicked:", JSON.stringify(approved))
await new Promise((r) => setTimeout(r, 3000))
const afterApprove = await p.evaluate(() => {
  const text = document.body.innerText
  return {
    approved: (text.match(/\d+ approved[^\n]*/) || [])[0] || null,
    // A batch where every row is refused looks like a pass unless the reasons
    // are read: the earlier version of this script printed nothing and moved on.
    refused: text
      .split("\n")
      .filter((l) => /amount changed|somebody else|status is/.test(l))
      .slice(0, 3),
    rowsLeft: document.querySelectorAll("tbody tr").length,
  }
})
console.log("after approving:", JSON.stringify(afterApprove))
if (!afterApprove.approved) {
  console.log("  NOTHING WAS APPROVED — the reasons above must explain why")
}

// ---- finance can now pay exactly those --------------------------------
await fin.goto(`${BASE}/finance`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 2200))
const after = await fin.evaluate(() => ({
  rows: document.querySelectorAll("tbody tr").length,
  tickets: [...document.querySelectorAll("tbody tr")]
    .map((tr) => (tr.innerText.match(/(SUB|FP|ERP)-[\d]+/) || [])[0])
    .filter(Boolean),
}))
console.log("finance queue, after approval:", JSON.stringify(after))

console.log("page errors:", errors.length ? errors : "none")
await browser.close()
