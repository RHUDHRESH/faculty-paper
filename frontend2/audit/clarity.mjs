/**
 * The clarity rules of docs/ux/22 that a machine can check.
 *
 * Each rule counts how many times a file breaks it and compares that with
 * `audit/clarity-baseline.json`. A file may break a rule no more often than
 * the baseline says, so the audit passes today and fails the moment a new
 * violation appears. When a page is fixed its baseline shrinks:
 *
 *     node audit/clarity.mjs --update      rewrites the baseline to today's counts
 *
 * The baseline is a debt list, not a licence. Every entry is a page that still
 * breaks a rule, and `docs/audit/base-findings.md` says which.
 *
 * Rules:
 *   count-cap      a count capped as "99+". Office pages need the real number.
 *   internal-word  "Running" shown to a person; it is a job state, not a word
 *                  a reader knows (say "In progress" or what it is doing).
 *   dash-run       "- - -" as a stand-in for a missing value.
 *   table-no-head  a <table> with no <thead>, or a <th> with nothing in it.
 *   empty-header   a Table column whose header is "" or null.
 *   dash-cell      a table cell that prints a lone dash for a missing value;
 *                  say "Not recorded" (or use the kit's Table, which does).
 *   retired-desk   "research cell" in UI copy. That desk is now called
 *                  "the research office"; the role enum may stay.
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const BASELINE = "audit/clarity-baseline.json"

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) && !/\.test\./.test(p) ? [p] : []
  })

/** Source without comments, so a rule does not fire on the sentence that
 *  explains it. Keeps line breaks so nothing shifts. */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1")

const RULES = {
  "count-cap": (s) => count(s, /\b99\+/g),
  "internal-word": (s) => count(s, /(["'`>])Running\b/g),
  "dash-run": (s) => count(s, /- - -/g),
  "table-no-head": (s) => {
    const tables = count(s, /<table\b/g)
    const heads = count(s, /<thead\b/g)
    const emptyTh = count(s, /<th\b[^>]*>\s*<\/th>/g) + count(s, /<th\b[^>]*\/>/g)
    return Math.max(0, tables - heads) + emptyTh
  },
  "retired-desk": (s) => count(s, /research cell/gi),
  "empty-header": (s) => count(s, /\bheader:\s*(""|''|null|<>\s*<\/>)/g),
  "dash-cell": (s) => count(s, /<td\b[^>]*>[^<]*\|\|\s*"(—|-)"/g) + count(s, /<td\b[^>]*>\s*(—|-)\s*<\/td>/g),
}

function count(s, re) {
  return [...s.matchAll(re)].length
}

const found = {}
for (const file of walk("src")) {
  const src = code(readFileSync(file, "utf8"))
  for (const [rule, fn] of Object.entries(RULES)) {
    const n = fn(src)
    if (n > 0) (found[rule] ??= {})[file.replaceAll("\\", "/")] = n
  }
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify(found, null, 2) + "\n")
  const total = Object.values(found).reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0)
  console.log(`clarity: baseline rewritten, ${total} known violation(s)`)
  process.exit(0)
}

const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {}
const worse = []
const better = []
for (const rule of new Set([...Object.keys(found), ...Object.keys(base)])) {
  const files = new Set([...Object.keys(found[rule] ?? {}), ...Object.keys(base[rule] ?? {})])
  for (const f of files) {
    const now = found[rule]?.[f] ?? 0
    const allowed = base[rule]?.[f] ?? 0
    if (now > allowed) worse.push(`  ${rule}  ${f}  ${allowed} allowed, ${now} found`)
    else if (now < allowed) better.push(`  ${rule}  ${f}  ${allowed} -> ${now}`)
  }
}

if (worse.length) {
  console.error(`clarity: ${worse.length} new violation(s) of docs/ux/22:\n`)
  worse.forEach((w) => console.error(w))
  console.error("\nFix the page (see the rule list at the top of audit/clarity.mjs).")
  process.exit(1)
}

const debt = Object.values(found).reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0)
console.log(`clarity: no new violations (${debt} known, in the baseline)`)
if (better.length) {
  console.log("  fixed since the baseline was written; run `node audit/clarity.mjs --update` to lock it in:")
  better.forEach((b) => console.log(b))
}
