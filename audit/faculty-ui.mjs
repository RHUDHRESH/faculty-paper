/**
 * Every screen and control a faculty account can reach, driven for real.
 *
 * The API audit next door proves the doors are locked. This asks the other
 * question: does each control the claimant can actually see do what it says,
 * and is anything on screen that should not be?
 */
import puppeteer from "puppeteer"

const BASE = "http://localhost:5173"
const problems = []
let checks = 0

function check(label, ok, detail = "") {
  checks += 1
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ""}`)
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail && !ok ? ` — ${detail}` : ""}`)
}

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] })
const ctx = await browser.createBrowserContext()
const page = await ctx.newPage()
await page.setViewport({ width: 1440, height: 1000 })

const consoleErrors = []
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 140)))
let expectingUnauthorised = true // the deliberate wrong-password attempt
let expectingRefusal = false // set around calls that are meant to be refused
page.on("console", (m) => {
  if (m.type() === "error" && expectingUnauthorised && /401/.test(m.text())) return
  if (m.type() === "error" && expectingRefusal && /40\d/.test(m.text())) return
  if (m.type() === "error" && !/favicon|404 \(Not Found\)/.test(m.text())) {
    consoleErrors.push(m.text().slice(0, 140))
  }
})
const failedRequests = []
page.on("response", (r) => {
  if (r.status() >= 500) failedRequests.push(`${r.status()} ${r.url().slice(0, 90)}`)
})

async function typeInto(sel, value) {
  await page.focus(sel)
  await page.keyboard.down("Control")
  await page.keyboard.press("KeyA")
  await page.keyboard.up("Control")
  await page.keyboard.press("Backspace")
  await page.type(sel, value)
}

// ---- sign in ---------------------------------------------------------------
console.log("\n-- signing in --")
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" })
await typeInto("#email", "faculty@college.edu")
await typeInto("#password", "wrong-password-entirely")
await page.click('button[type="submit"]')
await new Promise((r) => setTimeout(r, 1800))
check(
  "a wrong password is refused and says so",
  await page.evaluate(() =>
    location.pathname.startsWith("/login") &&
    /invalid|incorrect|wrong|could not/i.test(document.body.innerText)
  )
)

await typeInto("#email", "faculty@college.edu")
await typeInto("#password", "faculty123")
await Promise.all([
  page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30000 }),
  page.click('button[type="submit"]'),
])
check("the right password signs in", true)
expectingUnauthorised = false // anything 401 from here on is a real problem
// The shell mounts after the redirect resolves; reading the DOM before that
// finds no links and makes the next check pass without testing anything.
await new Promise((r) => setTimeout(r, 2500))

// ---- the navigation they get ----------------------------------------------
console.log("\n-- what the shell offers --")
// Every internal link on the page, not just ones inside a <nav>: the shell
// uses react-router links that do not all live in one landmark, and a
// selector that matches nothing makes the check below pass without testing
// anything.
const nav = await page.evaluate(() =>
  [...document.querySelectorAll('a[href^="/"]')].map((a) => ({
    label: a.innerText.trim(),
    href: a.getAttribute("href"),
  }))
)
console.log("  links:", nav.map((n) => `${n.label || "(icon)"}→${n.href}`).join(", "))
check("the shell actually offers links (the check below is real)", nav.length > 0, `${nav.length} found`)
check(
  "no admin, finance or principal screen is offered",
  !nav.some((n) => /^\/(admin|finance|principal)/.test(n.href || "")),
  nav.filter((n) => /^\/(admin|finance|principal)/.test(n.href || "")).map((n) => n.href).join(", ")
)

// ---- every faculty route ---------------------------------------------------
console.log("\n-- every screen --")
for (const path of ["/faculty", "/faculty/new", "/faculty/profile"]) {
  await page.goto(BASE + path, { waitUntil: "networkidle2" })
  await new Promise((r) => setTimeout(r, 1800))
  const state = await page.evaluate(() => ({
    heading: document.querySelector("h1")?.innerText || "",
    crashed: /something went wrong|unexpected error/i.test(document.body.innerText),
    empty: document.body.innerText.trim().length < 80,
  }))
  check(`${path} renders`, !!state.heading && !state.crashed && !state.empty, state.heading)
}

// ---- typing a foreign URL --------------------------------------------------
console.log("\n-- guessing at other portals --")
for (const path of ["/admin", "/finance", "/principal", "/admin/users", "/admin/budget"]) {
  await page.goto(BASE + path, { waitUntil: "networkidle2" })
  await new Promise((r) => setTimeout(r, 1200))
  const landed = await page.evaluate(() => ({
    path: location.pathname,
    body: document.body.innerText.slice(0, 120),
  }))
  check(
    `${path} does not open`,
    !landed.path.startsWith(path) || /not found|no access|forbidden/i.test(landed.body),
    `landed on ${landed.path}`
  )
}

// ---- their ticket list ------------------------------------------------------
console.log("\n-- their tickets --")
await page.goto(`${BASE}/faculty`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 2000))
const list = await page.evaluate(() => {
  const text = document.body.innerText
  return {
    controls: [...document.querySelectorAll("button, select, [role=combobox]")]
      .map((b) => b.innerText.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .slice(0, 14),
    rows: document.querySelectorAll("tbody tr").length,
    hasOwnNameOnly: !/Dr\. P\. Sinthia|Dr\. Anitha Julian/.test(text),
  }
})
console.log("  controls:", list.controls.join(" | "))
check("no other person's tickets are listed", list.hasOwnNameOnly)

// ---- the profile ------------------------------------------------------------
console.log("\n-- profile --")
await page.goto(`${BASE}/faculty/profile`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 1600))
const profile = await page.evaluate(() => ({
  editable: [...document.querySelectorAll("main input, main textarea, main select")]
    .filter((el) => !el.readOnly && !el.disabled).length,
  hasSave: [...document.querySelectorAll("button")].some((b) => /save profile/i.test(b.innerText)),
  hasRequest: [...document.querySelectorAll("button")].some((b) =>
    /request a correction/i.test(b.innerText)
  ),
}))
check("nothing on the profile is editable", profile.editable === 0, `${profile.editable} inputs`)
check("no Save button that would fail", !profile.hasSave)
check("a correction can be requested instead", profile.hasRequest)

// The dialog has to actually submit.
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    /request a correction/i.test(x.innerText)
  )
  b?.click()
})
await new Promise((r) => setTimeout(r, 700))
await page.evaluate(() => {
  const input = document.querySelector("#corr-proposed")
  if (!input) return
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
  set.call(input, "Associate Professor")
  input.dispatchEvent(new Event("input", { bubbles: true }))
})
await new Promise((r) => setTimeout(r, 400))
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /send request/i.test(x.innerText))
  b?.click()
})
await new Promise((r) => setTimeout(r, 2000))
check(
  "the correction request goes through",
  await page.evaluate(() => /sent to the research cell/i.test(document.body.innerText))
)

// ---- notifications ----------------------------------------------------------
console.log("\n-- notifications --")
await page.goto(`${BASE}/faculty`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 1500))
const bell = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    /notification/i.test(x.getAttribute("aria-label") || x.innerText)
  )
  if (!b) return null
  b.click()
  return true
})
await new Promise((r) => setTimeout(r, 1200))
check("the notification bell opens", !!bell)

// ---- the wizard -------------------------------------------------------------
console.log("\n-- the new-ticket wizard --")
await page.goto(`${BASE}/faculty/new`, { waitUntil: "networkidle2" })
await new Promise((r) => setTimeout(r, 1800))
const gate = await page.evaluate(() => {
  const start = [...document.querySelectorAll("button")].find((b) =>
    /start the claim/i.test(b.innerText)
  )
  return { present: !!start, disabled: start ? start.disabled : null }
})
check("the eligibility notice gates the form", gate.present && gate.disabled === true,
  `present=${gate.present} disabled=${gate.disabled}`)

for (const box of await page.$$('[role="checkbox"]')) {
  await box.click()
  await new Promise((r) => setTimeout(r, 100))
}
const enabled = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /start the claim/i.test(x.innerText))
  return b ? !b.disabled : false
})
check("acknowledging every point unlocks it", enabled)

await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /start the claim/i.test(x.innerText))
  b?.click()
})
await new Promise((r) => setTimeout(r, 1200))

// Step 1 is prefilled from the profile and must not be editable identity.
const step1 = await page.evaluate(() => ({
  heading: document.body.innerText.slice(0, 400),
  identityEditable: [...document.querySelectorAll("input")].filter(
    (i) => ["staff_id", "biometric_id", "email"].includes(i.id) && !i.readOnly && !i.disabled
  ).length,
}))
check("identity on step 1 is not editable in the form", step1.identityEditable === 0,
  `${step1.identityEditable} editable identity inputs`)

// Continue with nothing filled: the form must refuse and say what is missing.
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /^continue/i.test(x.innerText.trim()))
  b?.click()
})
await new Promise((r) => setTimeout(r, 900))
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /^continue/i.test(x.innerText.trim()))
  b?.click()
})
await new Promise((r) => setTimeout(r, 1200))
const blocked = await page.evaluate(() => ({
  errors: [...document.querySelectorAll("[role=alert]")].map((e) => e.innerText.trim()).filter(Boolean),
  onPublication: /Publication/i.test(document.body.innerText),
}))
check("an empty step refuses to continue and names what is missing",
  blocked.errors.length > 0, blocked.errors.slice(0, 2).join(" | "))

// ---- editing after submission ----------------------------------------------
console.log("\n-- editing a ticket that has already been submitted --")
const submitted = await page.evaluate(async () => {
  const r = await fetch("/api/claims?limit=100", { credentials: "include" })
  const body = await r.json()
  const rows = body.results || body
  const one = rows.find((c) => c.status === "SUBMITTED")
  return one ? { id: one.id, title: one.paper_title } : null
})
if (!submitted) {
  console.log("  (no submitted ticket on this account to try)")
} else {
  expectingRefusal = true // the PATCH below is meant to be refused
  const edited = await page.evaluate(async (id) => {
    const csrf = (await (await fetch("/api/auth/csrf")).json()).csrfToken
    const r = await fetch(`/api/claims/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "X-CSRFToken": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ paper_title: "EDITED AFTER SUBMISSION", snip: 30 }),
    })
    const after = await (await fetch(`/api/claims/${id}`, { credentials: "include" })).json()
    return { status: r.status, title: after.paper_title, snip: after.snip }
  }, submitted.id)
  check(
    "a submitted ticket cannot be edited by its claimant",
    edited.status >= 400 && edited.title !== "EDITED AFTER SUBMISSION",
    `answered ${edited.status}, title is now "${edited.title}"`
  )
}

console.log("\n" + "=".repeat(64))
console.log(`${checks} checks`)
if (consoleErrors.length) {
  console.log(`Console errors: ${[...new Set(consoleErrors)].slice(0, 5).join(" | ")}`)
}
if (failedRequests.length) {
  console.log(`Server errors: ${[...new Set(failedRequests)].slice(0, 5).join(" | ")}`)
}
if (problems.length) {
  console.log(`${problems.length} PROBLEM(S):`)
  for (const p of problems) console.log(`  - ${p}`)
} else {
  console.log("Every control behaved.")
}
await browser.close()
process.exit(problems.length || consoleErrors.length || failedRequests.length ? 1 : 0)
