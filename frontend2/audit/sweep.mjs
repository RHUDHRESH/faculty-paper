/**
 * The whole-app sweep: every role, every route it can reach, two widths, two
 * colour schemes. Read-only (it navigates and reads; it presses nothing).
 * Not part of `npm run audit`; it needs a running API and a running Vite.
 *
 *   SESS=<json of {ROLE: sessionKey}> PORT=5168 OUT=<dir> ROLES=FACULTY,HOD node audit/sweep.mjs
 *
 *   ROUTES_FROM=<dir>   replay the routes an earlier run visited (a before/after pair; also works against
 *                       a built app, which has no /src to ask for the page list)
 *   EXTRA=/a,/b         more routes to visit for every role
 *   ONLY=/a,/b          visit just these (debugging)
 *
 * One browser, one page, one route at a time. For each route it loads once at
 * 1440x900 in light, then re-reads the same page at 390x844, and again with
 * `prefers-color-scheme: dark` at both widths (the theme follows the media
 * query live), and writes a record to `OUT/<ROLE>.json`:
 *
 *   console / network   console errors, page errors, 4xx/5xx, failed requests
 *   slow                API calls over 800 ms
 *   overflow            sideways scroll, with the elements that cause it
 *   text                undefined / NaN / null / [object Object], raw enum
 *                       codes, ALL-CAPS labels, " - " in prose, lone-dash cells
 *   faces               a person's link in a row with no photo or initials
 *   links               internal links that match no route
 *   contrast            text under WCAG AA against its own background
 *   forbidden           per role: flags to Director/Finance, money to a head,
 *                       desk names to faculty
 *
 * Detail pages (a claim, a paper, a person, a faculty record, /review/:id) are
 * found by following real links harvested from the lists, not guessed.
 */
import { chromium } from "@playwright/test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

const port = process.env.PORT || "5168"
const BASE = `http://127.0.0.1:${port}`
const OUT = process.env.OUT || "sweep-out"
const SESS = JSON.parse(readFileSync(process.env.SESS, "utf8"))
const ROLES = (process.env.ROLES || Object.keys(SESS).join(",")).split(",")
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null
mkdirSync(OUT, { recursive: true })
mkdirSync(`${OUT}/shots`, { recursive: true })

// ---- the app's own route table, for the broken-link check ---------------
const main = readFileSync("src/main.tsx", "utf8")
const nav = readFileSync("src/app/nav.ts", "utf8")
const patterns = [
  ...[...main.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]),
  ...[...main.matchAll(/\["(\/[^"]+)",\s*[A-Z]\w+\]/g)].map((m) => m[1]),
  ...[...nav.matchAll(/^\s*"(\/[a-z/]+)":\s*"/gm)].map((m) => m[1]),
].filter((p) => p !== "*").concat("/")
const patternSrc = patterns.map((p) => "^" + p.replace(/:[^/]+/g, "[^/]+") + "/?$")

const DETAIL = [
  [/^\/papers\/[0-9a-z]{16,}$/, "paper", 2],
  [/^\/review\/[0-9a-z]{16,}/, "review", 2],
  [/^\/people\/[0-9a-z]{16,}$/, "person", 1],
  [/^\/faculty\/[0-9a-z]{16,}$/, "faculty", 1],
  [/^\/u\/[0-9a-z]{16,}$/, "profile", 1],
  [/^\/journals\/[^/]+$/, "journal", 1],
  [/^\/batches\/[0-9a-z]{8,}$/, "batch", 1],
  [/^\/department\/papers\/[0-9a-z]{16,}$/, "hod-paper", 1],
  [/^\/reports\/departments\/[^/]+$/, "department", 1],
  [/^\/discussions\/p\/[0-9a-z]{8,}$/, "post", 1],
  [/^\/messages\/c\/[0-9a-z]{8,}$/, "chat", 1],
  [/^\/messages\/o\/[0-9a-z]{8,}$/, "office-thread", 1],
]

const ACRONYMS = new Set(
  "NAAC NIRF SNIP DOI ERP CSV PDF ORCID URL API ID IDS AI ISSN SJR UGC NEFT IFSC FP QS SEC HOD CSE ECE EEE IT AIDS AIML CSBS MBA MCA RTGS UPI GST TDS ARC ISBN SCI SCIE UGC-CARE UGC CARE NBA ABDC WOS DST SERB ICMR AICTE FYP JSON XLSX XML HTML CSS OK".split(" ")
)

// ---- what one scan of the page reads --------------------------------------
async function scan(page, ctx) {
  return page.evaluate(
    ({ patternSrc, ACR, role }) => {
      const out = {}
      const vis = (el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return false
        const s = getComputedStyle(el)
        return s.visibility !== "hidden" && s.display !== "none"
      }
      const body = document.body.innerText || ""

      // text
      out.bad = [...new Set([...body.matchAll(/\b(undefined|NaN|null)\b|\[object Object\]/g)].map((m) => m[0]))]
      out.raw = [
        ...new Set([
          ...[...body.matchAll(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g)].map((m) => m[0]),
          ...[...body.matchAll(/(?<![\w./@-])[a-z]{2,}(?:_[a-z0-9]+){1,}(?![\w./@-])/g)].map((m) => m[0]),
        ]),
      ].slice(0, 12)
      out.dashes = [...body.matchAll(/.{0,28} — .{0,28}/g)].map((m) => m[0].trim()).slice(0, 6)
      out.docTitle = /undefined|null|NaN/.test(document.title) ? document.title : null

      // ALL CAPS, literal and by CSS. Data (department codes, journal names in caps) is reported too: the page decides.
      const caps = new Set()
      const leaves = [...document.querySelectorAll("body *")].filter(
        (e) => e.childElementCount === 0 && (e.textContent || "").trim().length > 0 && vis(e)
      )
      for (const e of leaves) {
        if (e.closest("script,style,svg,code,pre,kbd,[data-sweep-ignore]")) continue
        const t = (e.textContent || "").trim()
        const letters = t.replace(/[^A-Za-z]/g, "")
        const upperCss = getComputedStyle(e).textTransform === "uppercase"
        if (letters.length >= 4 && t === t.toUpperCase() && /^[A-Z0-9 &/.,:'()+-]+$/.test(t) && !ACR.includes(t)) {
          // A single code (a department "S&H-ENGLISH", a staff id "TSSH208") is data, not a label.
          const code = !/\s/.test(t) || /\d/.test(t)
          if (!code && !t.split(/[ /&,-]+/).every((w) => ACR.includes(w) || /^\d/.test(w))) caps.add(t.slice(0, 40))
        } else if (upperCss && letters.length >= 3) caps.add("css:" + t.slice(0, 40))
      }
      out.caps = [...caps].slice(0, 10)

      // lone-dash cells
      out.dashCells = [...document.querySelectorAll("td,dd")].filter((c) => /^[—–-]$/.test((c.textContent || "").trim()) && vis(c)).length

      // empty / error states
      out.empty = [...document.querySelectorAll("div.text-center.bg-sunken")]
        .filter(vis)
        .map((d) => (d.querySelector("p")?.textContent || "").trim().slice(0, 70))
      out.alerts = [...document.querySelectorAll("[role=alert]")].filter(vis).map((a) => (a.textContent || "").trim().slice(0, 100))
      out.skeletons = [...document.querySelectorAll(".skeleton")].filter(vis).length
      out.h1 = (document.querySelector("h1")?.textContent || "").trim().slice(0, 60)
      out.notFound = /No page at this address|Not open to this account/.test(body)
      out.figures = [...document.querySelectorAll("main a, main [class*=stat], main [class*=figure]")]
        .map((e) => (e.textContent || "").trim())
        .filter((t) => /^\d[\d,]*$/.test(t) && t !== "0").length

      // overflow
      const over = document.documentElement.scrollWidth - document.documentElement.clientWidth
      out.overflow = over > 1 ? over : 0
      if (over > 1) {
        const w = window.innerWidth
        const culprits = []
        for (const e of document.querySelectorAll("body *")) {
          if (!vis(e)) continue
          const r = e.getBoundingClientRect()
          if (r.right <= w + 1 && r.left >= -1) continue
          let skip = false
          for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
            const s = getComputedStyle(p)
            if (/(auto|scroll|hidden|clip)/.test(s.overflowX) && p.getBoundingClientRect().right <= w + 1) {
              skip = true
              break
            }
          }
          if (skip) continue
          culprits.push(`${e.tagName.toLowerCase()}.${String(e.className || "").split(/\s+/).slice(0, 3).join(".")} "${(e.textContent || "").trim().slice(0, 30)}" right=${Math.round(r.right)}`)
          if (culprits.length >= 3) break
        }
        out.culprits = culprits
      }

      // tap targets (phones)
      if (window.innerWidth < 500) {
        out.tiny = [...document.querySelectorAll("button,[role=button],input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea,summary,nav a,[role=tab]")]
          .filter((e) => vis(e) && !e.disabled)
          .filter((e) => {
            const r = e.getBoundingClientRect()
            // A glyph control may draw small and press big: its invisible ::after frame counts.
            const a = getComputedStyle(e, "::after")
            const pw = a.position === "absolute" ? parseFloat(a.width) : 0
            const ph = a.position === "absolute" ? parseFloat(a.height) : 0
            const w = Math.max(r.width, pw || 0)
            const h = Math.max(r.height, ph || 0)
            return Math.min(w, h) < 36
          })
          .slice(0, 40)
          .map((e) => `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") || e.textContent || e.getAttribute("placeholder") || "").trim().slice(0, 24)}" ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`)
      }

      // faces: a person link in a row/card with no photo or initials
      const personHref = /^\/(u|people|faculty)\/[0-9a-z]{16,}/
      const missing = []
      let faces = 0
      const seen = new Set()
      for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || ""
        if (!personHref.test(href) || !vis(a)) continue
        if (a.closest("nav[aria-label*=readcrumb],[aria-label*=readcrumb]")) continue
        const row = a.closest("tr,li,article,[role=row],[role=listitem],[data-row]") || a.parentElement?.parentElement?.parentElement
        if (!row || seen.has(row)) continue
        seen.add(row)
        const hasFace = row.querySelector("img[src*=media],img[src*=avatar],span.rounded-full[aria-hidden]") || a.querySelector("img,span.rounded-full")
        if (hasFace) faces++
        else if (a.closest("p,h1,h2,h3,[class*=prose]") || (row.textContent || "").length > 400 || /profile|view|see |open|message|connect|follow|read|more|all /i.test(a.textContent || "")) continue
        else missing.push((a.textContent || "").trim().slice(0, 30) || href)
      }
      out.faces = faces
      out.noFace = [...new Set(missing)].slice(0, 6)
      out.brokenImg = [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && vis(i)).map((i) => i.getAttribute("src")?.slice(0, 80)).slice(0, 4)

      // links
      const res = patternSrc.map((s) => new RegExp(s))
      const hrefs = [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")))]
      out.hrefs = hrefs.filter((h) => h && h.startsWith("/") && !h.startsWith("/api/") && !h.startsWith("/media/"))
      out.deadLinks = out.hrefs
        .filter((h) => !res.some((r) => r.test(h.split("#")[0].split("?")[0])))
        .slice(0, 6)
      out.hashLinks = hrefs.filter((h) => h === "#" || h === "").length

      // contrast
      const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
      cv.canvas.width = cv.canvas.height = 1
      const rgbaOf = (c) => {
        // draw over transparent: alpha survives in the buffer
        cv.clearRect(0, 0, 1, 1)
        cv.globalCompositeOperation = "copy"
        cv.fillStyle = c
        cv.fillRect(0, 0, 1, 1)
        cv.globalCompositeOperation = "source-over"
        const d = cv.getImageData(0, 0, 1, 1).data
        const a = d[3] / 255
        // getImageData already un-premultiplies: do not divide by alpha again.
        return a === 0 ? [0, 0, 0, 0] : [d[0], d[1], d[2], a]
      }
      const over2 = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat([1])
      const lum = (c) => {
        const l = c.slice(0, 3).map((v) => {
          v /= 255
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
        })
        return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
      }
      const bgOf = (el) => {
        const layers = []
        for (let p = el; p; p = p.parentElement) {
          const s = getComputedStyle(p)
          if (s.backgroundImage !== "none") return null
          const c = rgbaOf(s.backgroundColor)
          if (c[3] > 0) {
            layers.push(c)
            if (c[3] >= 0.99) break
          }
        }
        let base = rgbaOf(getComputedStyle(document.documentElement).backgroundColor)
        if (base[3] < 0.99) base = [255, 255, 255, 1]
        let acc = base
        for (const l of layers.reverse()) acc = over2(l, acc)
        return acc
      }
      const bad = []
      let checked = 0
      for (const e of leaves.slice(0, 1400)) {
        if (e.closest("[disabled],[aria-disabled=true],[aria-hidden=true],svg,.sr-only")) continue
        const s = getComputedStyle(e)
        let op = 1
        for (let p = e; p; p = p.parentElement) op *= Number(getComputedStyle(p).opacity)
        if (op < 0.99) continue
        const bg = bgOf(e)
        if (!bg) continue
        const fg0 = rgbaOf(s.color)
        if (fg0[3] === 0) continue
        const fg = over2(fg0, bg)
        const l1 = lum(fg)
        const l2 = lum(bg)
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        const size = parseFloat(s.fontSize)
        const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700)
        checked++
        if (ratio < (large ? 3 : 4.5)) bad.push({ r: Math.round(ratio * 100) / 100, t: (e.textContent || "").trim().slice(0, 36), c: `${e.tagName.toLowerCase()}.${String(e.className || "").split(/\s+/).slice(0, 2).join(".")}` })
      }
      bad.sort((a, b) => a.r - b.r)
      out.contrast = { checked, n: bad.length, worst: bad.slice(0, 4) }
      out.theme = document.documentElement.dataset.theme

      // forbidden, by role
      const f = []
      const text = body
      if (role === "DIRECTOR" || role === "FINANCE") {
        for (const m of text.matchAll(/.{0,30}\b(flags?|flagged|contested|doubts?)\b.{0,30}/gi)) f.push("flag: " + m[0].trim())
      }
      if (role === "HOD") {
        const n = [...text.matchAll(/₹\s?[\d,]+/g)].length
        if (n) f.push(`money: ${n} rupee figure(s) on a head's page`)
      }
      if (role === "FACULTY") {
        for (const m of text.matchAll(/.{0,30}\b(research cell|research coordinator|the principal|principal's|director|finance (desk|office|officer)|clearing queue|desk)\b.{0,30}/gi)) f.push("desk: " + m[0].trim())
      }
      out.forbidden = f.slice(0, 6)
      return out
    },
    { patternSrc, ACR: [...ACRONYMS], role: ctx.role }
  )
}

const merge = (a, b) => [...new Set([...(a || []), ...(b || [])])]

async function settle(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: 9000 }).catch(() => {})
  for (let i = 0; i < 10; i++) {
    const n = await page.evaluate(() => [...document.querySelectorAll(".skeleton")].filter((e) => e.getBoundingClientRect().height > 0).length).catch(() => 0)
    if (!n) break
    await page.waitForTimeout(300)
  }
  await page.waitForTimeout(350)
}

const browser = await chromium.launch()
for (const role of ROLES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", baseURL: BASE })
  await ctx.addCookies([{ name: "sessionid", value: SESS[role], url: BASE }])
  const page = await ctx.newPage()

  // per-route collectors
  let con = [], net = [], slow = [], json = []
  const t0 = new Map()
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (/Failed to load resource/.test(t)) return // the network list has it, with the URL
    con.push(t.slice(0, 180))
  })
  page.on("pageerror", (e) => con.push("pageerror: " + String(e).slice(0, 180)))
  page.on("request", (r) => t0.set(r, Date.now()))
  page.on("requestfailed", (r) => {
    if (!/net::ERR_ABORTED/.test(r.failure()?.errorText || "")) net.push(`FAILED ${r.url().replace(BASE, "").slice(0, 100)} ${r.failure()?.errorText}`)
  })
  page.on("response", (r) => {
    const u = r.url().replace(BASE, "")
    if (r.status() >= 400) net.push(`${r.status()} ${u.slice(0, 110)}`)
  })
  page.on("requestfinished", (r) => {
    const u = r.url()
    if (!u.includes("/api/")) return
    const ms = Date.now() - (t0.get(r) || Date.now())
    if (ms > 800) slow.push(`${ms}ms ${u.replace(BASE, "").slice(0, 100)}`)
  })
  if (["DIRECTOR", "FINANCE", "HOD", "FACULTY"].includes(role)) {
    page.on("response", async (r) => {
      if (!r.url().includes("/api/") || r.status() >= 400) return
      if (!(r.headers()["content-type"] || "").includes("json")) return
      try {
        const body = await r.text()
        const keys = new Set()
        const re = /"([a-z_]+)"\s*:/g
        let m
        while ((m = re.exec(body))) keys.add(m[1])
        const rx =
          role === "HOD"
            ? /^(amount|remuneration|incentive|incentive_amount|paid_amount|total_paid|budget|spent|ledger|rupees)$/
            : role === "FACULTY"
              ? /^(assignee|assigned_to|holder|cleared_by|checked_by|approved_by|authorised_by|paid_by|desk|flags|flag_count|contested)$/
              : /flag|contested|doubt/
        const hit = [...keys].filter((k) => rx.test(k))
        if (hit.length) json.push(`${r.url().replace(BASE, "").split("?")[0].slice(0, 70)} has ${hit.join(",")}`)
      } catch {}
    })
  }

  const results = {}
  const visited = new Set()
  const harvested = new Map() // kind -> [href]
  const linkQueue = new Set()

  async function visit(route, kind) {
    if (visited.has(route)) return
    visited.add(route)
    con = []; net = []; slow = []; json = []
    await page.emulateMedia({ colorScheme: "light" })
    await page.setViewportSize({ width: 1440, height: 900 })
    const started = Date.now()
    await page.goto(route, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => con.push("goto: " + String(e).slice(0, 100)))
    await settle(page)
    const rec = { route, kind, landed: new URL(page.url()).pathname + new URL(page.url()).search, loadMs: Date.now() - started }
    const landedKey = new URL(page.url()).pathname + new URL(page.url()).search
    if (landedKey !== route && (visited.has(landedKey) || landedKey === "/")) {
      // An old path that redirects to a page already swept: record where it went, not the page again.
      results[route] = { route, kind: "redirect", landed: landedKey, loadMs: rec.loadMs, scans: {}, con: merge(con), net: merge(net), slow: merge(slow), json: [] }
      console.log(role.padEnd(20), route.slice(0, 44).padEnd(45), "-> " + landedKey)
      return
    }
    const ctxArg = { role }
    const states = kind === "link" ? [["light-d", "light", 1440, 900]] : [["light-d", "light", 1440, 900], ["light-m", "light", 390, 844], ["dark-m", "dark", 390, 844], ["dark-d", "dark", 1440, 900]]
    rec.scans = {}
    for (const [name, scheme, w, h] of states) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: w, height: h })
      await page.waitForTimeout(name === "light-d" ? 0 : 450)
      rec.scans[name] = await scan(page, ctxArg)
      if (name === "light-d") {
        for (const h of rec.scans[name].hrefs) {
          for (const [rx, k, n] of DETAIL) {
            if (rx.test(h.split("#")[0])) {
              const list = harvested.get(k) ?? []
              if (list.length < n && !list.includes(h)) list.push(h)
              harvested.set(k, list)
            }
          }
          if (h.includes("?") && !DETAIL.some(([rx]) => rx.test(h.split("?")[0]))) linkQueue.add(h)
        }
        if (kind !== "link") {
          const file = `${OUT}/shots/${role}_${route.replace(/[^a-z0-9]+/gi, "_").slice(0, 70)}_light-d.jpg`
          await page.screenshot({ path: file, type: "jpeg", quality: 55 }).catch(() => {})
        }
      }
      delete rec.scans[name].hrefs
    }
    rec.con = merge(con); rec.net = merge(net); rec.slow = merge(slow); rec.json = merge(json)
    const dark = rec.scans["dark-d"]
    const lightM = rec.scans["light-m"]
    if ((dark?.contrast?.n ?? 0) > 0 && kind !== "link") await page.screenshot({ path: `${OUT}/shots/${role}_${route.replace(/[^a-z0-9]+/gi, "_").slice(0, 70)}_dark-d.jpg`, type: "jpeg", quality: 55 }).catch(() => {})
    if ((lightM?.overflow ?? 0) > 0) {
      await page.emulateMedia({ colorScheme: "light" })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${OUT}/shots/${role}_${route.replace(/[^a-z0-9]+/gi, "_").slice(0, 70)}_over-m.jpg`, type: "jpeg", quality: 55 }).catch(() => {})
    }
    results[route] = rec
    const l = rec.scans["light-d"]
    console.log(
      role.padEnd(20), route.slice(0, 44).padEnd(45), (l.h1 || "(no h1)").slice(0, 28).padEnd(29),
      rec.con.length ? `C${rec.con.length}` : "", rec.net.length ? `N${rec.net.length}` : "", rec.slow.length ? `S${rec.slow.length}` : "",
      l.notFound ? "NOTFOUND" : "", Object.values(rec.scans).some((s) => s.overflow) ? "OVER" : ""
    )
  }

  if (process.env.ROUTES_FROM) {
    // Replay the exact routes an earlier run visited, so before and after compare like with like
    // (and so this works against a built app, which has no /src to ask for the page list).
    const prev = JSON.parse(readFileSync(`${process.env.ROUTES_FROM}/${role}.json`, "utf8"))
    for (const [route, r] of Object.entries(prev)) if (!ONLY || ONLY.includes(route)) await visit(route, r.kind === "redirect" ? "page" : r.kind)
  } else {
    // 1. every page this role may open, plus the old paths that redirect
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await settle(page)
    const mod = await page.evaluate(async (role) => {
      const m = await import("/src/app/nav.ts")
      return { pages: m.pagesFor(role).map((p) => p.to), redirects: Object.keys(m.REDIRECTS) }
    }, role)
    const statics = [...new Set(["/", ...mod.pages, "/me", "/papers/new", ...mod.redirects])].filter((p) => p !== "/gallery")
    for (const r of statics) if (!ONLY || ONLY.includes(r)) await visit(r, "page")

    // 2. detail pages, by following links harvested above
    for (const [k, list] of harvested) for (const h of list) if (!ONLY) await visit(h, "detail:" + k)

    // 3. links with a query (figures that open a list), a sample
    let n = 0
    for (const h of linkQueue) {
      if (n++ >= 25 || ONLY) break
      await visit(h, "link")
    }
  }
  for (const x of (process.env.EXTRA || "").split(",").filter(Boolean)) await visit(x, "detail:extra")

  writeFileSync(`${OUT}/${role}.json`, JSON.stringify(results, null, 1))
  await ctx.close()
}
await browser.close()
