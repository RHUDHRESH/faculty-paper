/**
 * Turns `audit/sweep.mjs` output into the matrix in docs/audit/final-sweep.md.
 *
 *   node audit/sweep-report.mjs <dir> [<dir-to-compare>]
 *
 * Prints, to stdout: a count per check per role (and the total), then one
 * line per distinct finding with the routes it shows on, then the per-role
 * matrix. With a second directory it adds a before/after column to the
 * totals.
 */
import { readdirSync, readFileSync } from "node:fs"

const load = (dir) => {
  const roles = {}
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) roles[f.replace(".json", "")] = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"))
  return roles
}

const CHECKS = [
  ["console", "Console errors", (r) => r.con.length > 0, (r) => r.con],
  ["network", "Failed calls (4xx/5xx)", (r) => r.net.length > 0, (r) => r.net.map((n) => n.replace(/\?.*/, ""))],
  ["slow", "API over 800 ms", (r) => r.slow.length > 0, (r) => r.slow.map((n) => n.replace(/^\d+ms /, ""))],
  ["overflow", "Sideways scroll", (r) => any(r, (s) => s.overflow > 0), (r) => all(r, (s) => (s.culprits ?? []).slice(0, 1))],
  ["bad", "undefined / NaN / null", (r) => any(r, (s) => s.bad.length), (r) => all(r, (s) => s.bad)],
  // A server setting the super admin is told to set (EMAIL_HOST) and a camera's file name are not enums.
  ["raw", "Raw enum or code", (r) => any(r, (s) => realRaw(s).length), (r) => all(r, realRaw)],
  ["caps", "ALL-CAPS label", (r) => any(r, (s) => s.caps.length), (r) => all(r, (s) => s.caps)],
  ["dash", "Dash in prose", (r) => any(r, (s) => s.dashes.length), (r) => all(r, (s) => s.dashes)],
  ["dashcell", "Lone dash in a cell", (r) => any(r, (s) => s.dashCells > 0), () => ["lone dash cell"]],
  ["faces", "Person without a face", (r) => any(r, (s) => s.noFace.length), (r) => all(r, (s) => s.noFace)],
  ["img", "Broken image", (r) => any(r, (s) => s.brokenImg.length), (r) => all(r, (s) => s.brokenImg)],
  ["links", "Link to no page", (r) => any(r, (s) => s.deadLinks.length), (r) => all(r, (s) => s.deadLinks)],
  ["notfound", "Lands on not-found", (r) => any(r, (s) => s.notFound), () => ["not found"]],
  ["lightc", "Contrast, light", (r) => (r.scans["light-d"]?.contrast.n ?? 0) + (r.scans["light-m"]?.contrast.n ?? 0) > 0, (r) => worst(r, ["light-d", "light-m"])],
  ["darkc", "Contrast, dark", (r) => (r.scans["dark-d"]?.contrast.n ?? 0) + (r.scans["dark-m"]?.contrast.n ?? 0) > 0, (r) => worst(r, ["dark-d", "dark-m"])],
  ["forbidden", "Forbidden content", (r) => any(r, (s) => s.forbidden.length) || r.json.length > 0, (r) => [...all(r, (s) => s.forbidden), ...r.json]],
  ["empty", "Empty state beside figures", (r) => any(r, (s) => s.empty.length && s.figures > 0), (r) => all(r, (s) => s.empty)],
  ["alert", "Error state shown", (r) => any(r, (s) => s.alerts.length), (r) => all(r, (s) => s.alerts)],
  ["tiny", "Tap target under 36 px", (r) => any(r, (s) => (s.tiny ?? []).length), (r) => all(r, (s) => (s.tiny ?? []).slice(0, 2))],
]

function realRaw(s) {
  return s.raw.filter((w) => !/^(EMAIL|SCOPUS|DJANGO|SMTP|AI)_[A-Z_]+$/.test(w) && !/^(IMG|DSC|PXL|VID)_\d+/.test(w))
}
function any(r, f) {
  return Object.values(r.scans).some(f)
}
function all(r, f) {
  return [...new Set(Object.values(r.scans).flatMap(f))]
}
function worst(r, names) {
  return names.flatMap((n) => (r.scans[n]?.contrast.worst ?? []).slice(0, 2).map((w) => `${w.r}:1 ${w.c} "${w.t}"`))
}

const now = load(process.argv[2])
const then = process.argv[3] ? load(process.argv[3]) : null

function tally(data) {
  const t = {}
  for (const [role, routes] of Object.entries(data))
    for (const r of Object.values(routes))
      for (const [k, , test] of CHECKS) if (test(r)) (t[k] ??= {})[role] = (t[k][role] ?? 0) + 1
  return t
}
const roles = Object.keys(now)
const total = (t, k) => Object.values(t[k] ?? {}).reduce((a, b) => a + b, 0)
const routesCount = (d) => Object.values(d).reduce((a, r) => a + Object.keys(r).length, 0)
const tn = tally(now)
const tt = then ? tally(then) : null

const out = []
out.push(`Routes visited: ${routesCount(now)} across ${roles.length} roles${then ? ` (before: ${routesCount(then)})` : ""}.\n`)
out.push(`| Check (routes affected) | ${roles.map((r) => r.replace("RESEARCH_", "R_")).join(" | ")} | Total |${then ? " Before |" : ""}`)
out.push(`|---|${roles.map(() => "--:").join("|")}|--:|${then ? "--:|" : ""}`)
for (const [k, label] of CHECKS) {
  out.push(`| ${label} | ${roles.map((r) => tn[k]?.[r] ?? 0).join(" | ")} | ${total(tn, k)} |${tt ? ` ${total(tt, k)} |` : ""}`)
}
out.push("")

out.push("### Distinct findings\n")
for (const [k, label, test, detail] of CHECKS) {
  const byText = new Map()
  for (const [role, routes] of Object.entries(now))
    for (const r of Object.values(routes)) {
      if (!test(r)) continue
      const ds = detail(r)
      for (const d of ds.length ? ds : ["(see route)"]) {
        const e = byText.get(d) ?? { n: 0, routes: new Set() }
        e.n++
        e.routes.add(`${role === "SUPER_ADMIN" ? "SA" : role.slice(0, 4)}:${r.route}`)
        byText.set(d, e)
      }
    }
  if (!byText.size) continue
  out.push(`**${label}** (${byText.size} distinct)\n`)
  for (const [d, e] of [...byText].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) {
    out.push(`- \`${String(d).replace(/`/g, "'").slice(0, 120)}\` on ${e.n} route(s): ${[...e.routes].slice(0, 4).join(", ")}${e.routes.size > 4 ? ", ..." : ""}`)
  }
  out.push("")
}

const SHORT = {
  console: "console", network: "calls", slow: "slow", overflow: "overflow", bad: "undefined", raw: "codes", caps: "caps", dash: "dash",
  dashcell: "dash-cell", faces: "faces", img: "image", links: "links", notfound: "404", lightc: "contrast-light", darkc: "contrast-dark",
  forbidden: "forbidden", empty: "empty", alert: "error-state", tiny: "tap",
}
const failing = (r) => (r ? CHECKS.filter(([, , test]) => test(r)).map(([k]) => SHORT[k]).join(", ") || "ok" : "not visited")

if (process.env.MATRIX === "compare" && then) {
  out.push("### Matrix: every route, before and after\n")
  for (const [role, routes] of Object.entries(now)) {
    out.push(`#### ${role}\n`)
    out.push("| Route | Before | After |")
    out.push("|---|---|---|")
    const seen = new Set()
    for (const r of Object.values(routes)) {
      seen.add(r.route)
      out.push(`| \`${r.route.length > 70 ? r.route.slice(0, 67) + "..." : r.route}\` | ${failing(then[role]?.[r.route])} | ${failing(r)} |`)
    }
    out.push("")
  }
} else if (process.env.MATRIX) {
  out.push("### Matrix\n")
  for (const [role, routes] of Object.entries(now)) {
    out.push(`#### ${role}\n`)
    out.push(`| Route | ${CHECKS.map(([k]) => k).join(" | ")} |`)
    out.push(`|---|${CHECKS.map(() => ":-:").join("|")}|`)
    for (const r of Object.values(routes)) out.push(`| ${r.route.slice(0, 48)} | ${CHECKS.map(([, , test]) => (test(r) ? "x" : "")).join(" | ")} |`)
    out.push("")
  }
}
console.log(out.join("\n"))
