// How fast the built app reaches a reader: first paint, largest paint, the
// JavaScript it had to download, and when its last API answer landed.
//
//   cd frontend2 && npm run build && node ../scripts/perf.mjs
//
// The build is served the way Render serves it -- brotli, /assets immutable,
// every other path falling back to index.html -- and /api and /media are
// proxied to a running Django (PERF_API, default http://127.0.0.1:8000). The
// browser is throttled to Lighthouse's mobile profile (150 ms round trip,
// 1.6 Mbps down, 4x slower CPU) so a waterfall costs what it costs on a phone
// on a college network, and every run starts with an empty cache.
//
// Sessions come from `manage.py e2e_session`, as scripts/sweep.mjs does. Those
// accounts own nothing, so to measure a home with papers on it pass a real
// session key on a scratch copy of the data: PERF_SESSION_FACULTY=<key>, and
// PERF_PAPER=<claim id> for the paper page.
import { execFileSync } from "node:child_process"
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import http from "node:http"
import { createRequire } from "node:module"
import path from "node:path"
import zlib from "node:zlib"

// Resolved from frontend2/, where it is installed: an ESM import would look
// beside this file, in scripts/, and find nothing.
const { chromium } = createRequire(path.resolve("package.json"))("@playwright/test")

const DIST = path.resolve(process.env.PERF_DIST || "dist")
const API = new URL(process.env.PERF_API || "http://127.0.0.1:8000")
const PORT = Number(process.env.PERF_PORT || 5741)
const RUNS = Number(process.env.PERF_RUNS || 3)
const OUT = process.env.PERF_OUT || ""
const PY = process.env.PERF_PYTHON || path.resolve("../.venv/Scripts/python.exe")

// ---- a static host shaped like Render's -----------------------------------

const TYPES = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
}
const packed = new Map()
function brotli(file) {
  if (!packed.has(file)) packed.set(file, zlib.brotliCompressSync(readFileSync(file)))
  return packed.get(file)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x")
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
    const upstream = http.request(
      { host: API.hostname, port: API.port, path: req.url, method: req.method, headers: { ...req.headers, host: API.host } },
      (up) => {
        res.writeHead(up.statusCode, up.headers)
        up.pipe(res)
      }
    )
    upstream.on("error", () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
    return
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname))
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(DIST, "index.html")
  }
  const ext = path.extname(file)
  const headers = {
    "Content-Type": TYPES[ext] || "application/octet-stream",
    "Cache-Control": url.pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0",
  }
  const compressible = [".js", ".css", ".html", ".svg", ".json"].includes(ext)
  if (compressible && /\bbr\b/.test(req.headers["accept-encoding"] || "")) {
    const body = brotli(file)
    res.writeHead(200, { ...headers, "Content-Encoding": "br", "Content-Length": body.length })
    res.end(body)
    return
  }
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
})
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok))
const BASE = `http://127.0.0.1:${PORT}`

// ---- sessions ---------------------------------------------------------------

function session(role) {
  const given = process.env[`PERF_SESSION_${role}`]
  if (given) return given
  const out = execFileSync(PY, ["manage.py", "e2e_session", "--role", role, "--json"], {
    cwd: path.resolve("../backend"),
    env: { ...process.env, DJANGO_USE_SQLITE: "true", DJANGO_DEBUG: "true" },
  }).toString()
  return JSON.parse(out.slice(out.indexOf("{"))).session_key
}

// ---- one measured visit -------------------------------------------------------

const OBSERVE = () => {
  window.__perf = { fcp: null, lcp: null }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === "first-contentful-paint") window.__perf.fcp = e.startTime
  }).observe({ type: "paint", buffered: true })
  new PerformanceObserver((list) => {
    const all = list.getEntries()
    window.__perf.lcp = all[all.length - 1].startTime
  }).observe({ type: "largest-contentful-paint", buffered: true })
}

async function visit(browser, { route, role }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  if (role) {
    await ctx.addCookies([{ name: "sessionid", value: session(role), domain: "127.0.0.1", path: "/" }])
  }
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send("Network.enable")
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  })
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  const bytes = { js: 0, css: 0, api: 0, other: 0 }
  const scripts = new Set()
  const sizes = {}
  const kinds = {}
  cdp.on("Network.loadingFinished", (e) => (sizes[e.requestId] = e.encodedDataLength))
  cdp.on("Network.responseReceived", (e) => {
    const u = e.response.url
    kinds[e.requestId] = u.includes("/api/") ? "api" : u.endsWith(".js") ? "js" : u.endsWith(".css") ? "css" : "other"
    if (u.endsWith(".js")) scripts.add(u.split("/").pop())
  })
  await page.addInitScript(OBSERVE)
  const t0 = Date.now()
  await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 120_000 })
  // "No network for 500 ms" is not "the page is here": with the session
  // answered early, a throttled CPU can sit executing JavaScript for longer
  // than that before the page asks for its data. Wait for the page's own
  // heading, then for its requests to settle.
  await page.waitForSelector("main h1, h1", { timeout: 60_000 }).catch(() => {})
  await page.waitForLoadState("networkidle")
  const idle = Date.now() - t0
  await page.waitForTimeout(500)
  const perf = await page.evaluate(() => {
    const api = performance.getEntriesByType("resource").filter((r) => r.name.includes("/api/"))
    return {
      ...window.__perf,
      apiCount: api.length,
      lastApi: api.length ? Math.max(...api.map((r) => r.responseEnd)) : null,
      firstApi: api.length ? Math.min(...api.map((r) => r.startTime)) : null,
      h1: document.querySelector("h1")?.textContent?.trim() ?? null,
    }
  })
  for (const [id, n] of Object.entries(sizes)) bytes[kinds[id] || "other"] += n
  await ctx.close()
  return { ...perf, idle, bytes, scripts: [...scripts].sort() }
}

function median(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}

const SCENARIOS = [
  { name: "sign-in", route: "/" },
  { name: "faculty home", route: "/", role: "FACULTY" },
  ...(process.env.PERF_PAPER ? [{ name: "paper page", route: `/papers/${process.env.PERF_PAPER}`, role: "FACULTY" }] : []),
  { name: "office home", route: "/", role: "RESEARCH_CELL" },
  { name: "director home", route: "/", role: "DIRECTOR" },
]

const browser = await chromium.launch()
const report = {}
for (const s of SCENARIOS) {
  const runs = []
  for (let i = 0; i < RUNS; i++) runs.push(await visit(browser, s))
  const kb = (k) => Math.round(median(runs.map((r) => r.bytes[k])) / 102.4) / 10
  report[s.name] = {
    fcp_ms: Math.round(median(runs.map((r) => r.fcp))),
    lcp_ms: Math.round(median(runs.map((r) => r.lcp))),
    last_api_ms: Math.round(median(runs.map((r) => r.lastApi))),
    first_api_ms: Math.round(median(runs.map((r) => r.firstApi))),
    network_idle_ms: median(runs.map((r) => r.idle)),
    api_requests: median(runs.map((r) => r.apiCount)),
    js_kb: kb("js"),
    css_kb: kb("css"),
    api_kb: kb("api"),
    js_files: runs[0].scripts.length,
    h1: runs[0].h1,
  }
  console.log(s.name.padEnd(14), JSON.stringify(report[s.name]))
}
await browser.close()
server.close()
if (OUT) await writeFile(OUT, JSON.stringify(report, null, 2))
