/**
 * Every sidebar destination must be a route, and every route should be
 * reachable.
 *
 * The old app shipped a "Duplicates" item in the finance sidebar that pointed
 * at a path no route matched, so it fell through to the catch-all and bounced
 * the reader to the home page. Nobody noticed for months, because the person
 * who added the nav item and the person who added the routes were the same
 * person on different days.
 *
 * Both halves are declared in source here, so a machine can check them against
 * each other rather than trusting that.
 */
import { readFileSync } from "node:fs"

const nav = readFileSync("src/app/nav.ts", "utf8")
const main = readFileSync("src/main.tsx", "utf8")

// `to: "/x"` in the nav list.
const navPaths = [...nav.matchAll(/^\s*to:\s*"([^"]+)"/gm)].map((m) => m[1])

// `<Route path="/x"` in the router, plus the index route.
const routePaths = [...main.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1])
if (/<Route\s+index\b/.test(main)) routePaths.push("/")

/** Does a declared route pattern match this concrete path? */
const matches = (path, pattern) => {
  if (pattern === "*") return false // the catch-all is not a destination
  const re = new RegExp(
    "^" + pattern.replace(/:[^/]+/g, "[^/]+").replace(/\//g, "\\/") + "$"
  )
  return re.test(path)
}

const dead = navPaths.filter((p) => !routePaths.some((r) => matches(p, r)))

// A route nothing links to is not necessarily wrong — a detail page is reached
// from a list, not the sidebar — so this is reported, never failed on.
const params = routePaths.filter((r) => r.includes(":") || r === "*")
const orphans = routePaths.filter(
  (r) => !params.includes(r) && r !== "/" && !navPaths.includes(r)
)

if (dead.length) {
  console.error(`${dead.length} sidebar item(s) point at nothing:\n`)
  for (const p of dead) console.error(`  ${p}`)
  console.error("\nEither add a <Route> in main.tsx or take the item out of nav.ts.")
  console.error("A nav item with no route falls through to the catch-all and")
  console.error("silently bounces the reader home.")
  process.exit(1)
}

// The other direction (docs/ux/22, "Ctrl-K finds every view by name"): every
// routed view with a fixed address must be declared in nav.ts, sidebar or
// find-only, or the palette cannot find it and the tab has no title. Views
// with a parameter are records reached from a list, and are named in
// `app/crumbs.tsx` instead.
const anywhere = new Set([...nav.matchAll(/\bto:\s*"([^"]+)"/g)].map((m) => m[1]))
// Not for people to look for: a dev-only gallery, and the first-run setup that
// is a redirect once the college exists.
const NOT_FOUND_BY_NAME = new Set(["/gallery", "/setup"])
const unfindable = routePaths.filter(
  (r) => !r.includes(":") && r !== "*" && !anywhere.has(r) && !NOT_FOUND_BY_NAME.has(r)
)
if (unfindable.length) {
  console.error(`${unfindable.length} routed view(s) cannot be found by name in Ctrl K:\n`)
  for (const p of unfindable) console.error(`  ${p}`)
  console.error("\nAdd each to PAGES in src/app/nav.ts (findOnly: true keeps it out of the sidebar)")
  console.error("with a label, a purpose and keywords for the job it does.")
  process.exit(1)
}

console.log(`routes: ${navPaths.length} sidebar destinations, all routed; every fixed route findable by name`)
if (orphans.length) {
  console.log(`  (${orphans.length} routed but not in the sidebar: ${orphans.join(", ")})`)
}
