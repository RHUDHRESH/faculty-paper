import { matchPath } from "react-router-dom"

import type { Role } from "@/app/auth"
import { NAV, REVIEWERS } from "@/app/nav"

/**
 * Who may open which route: the one place a link asks before it is drawn.
 *
 * A link or a button that leads to a page the reader's role cannot open is a
 * dead end: it ends at "Not visible to this account", which reads as a broken
 * app. So every page that links to another asks here first, through
 * `canOpenRoute` (or `<AccessLink>`), and shows plain text where the answer
 * is no.
 *
 * Two sources, so nothing is declared twice:
 *
 * - every route in the nav is answered by the nav's own `roles` (`nav.ts`
 *   declares each page once and says who it is for);
 * - the routes that carry an id or a name (a journal, a person, a claim) are
 *   not nav items, so their rules are listed here, next to the nav.
 *
 * A route that is neither is open: the same "never blocked by a guess" rule
 * `RoleGate` follows. The server still decides what the page may show.
 */

type Dynamic = {
  pattern: string
  /** Absent means every signed-in role. */
  roles?: Role[]
  /** Also open to the account the id names (`/faculty/me`, or their own id). */
  self?: boolean
}

/**
 * Who a nav route is for. A page can have more than one entry, one per
 * audience ("My standing" for faculty, "Standings" for staff), so the roles of
 * every entry for the route are joined. Undefined means open to everybody.
 */
function rolesOf(to: string): Role[] | undefined | null {
  const pages = NAV.filter((p) => p.to === to)
  if (pages.length === 0) return null
  if (pages.some((p) => !p.roles)) return undefined
  return [...new Set(pages.flatMap((p) => p.roles ?? []))]
}

const NAMED = (to: string): Role[] | undefined => rolesOf(to) ?? undefined

/** Everybody the faculty directory answers: `faculty_directory._sees_everyone`
 *  plus a head of department, who sees their own department's people. */
const RECORD_READERS: Role[] = [
  "SUPER_ADMIN",
  "RESEARCH_CELL",
  "RESEARCH_COORDINATOR",
  "PRINCIPAL",
  "VICE_PRINCIPAL",
  "DIRECTOR",
  "FINANCE",
  "HOD",
]

/**
 * Routes that carry an id or a name. First match wins, so the longer pattern
 * of two that overlap comes first.
 */
export const DYNAMIC_ROUTES: Dynamic[] = [
  // A journal is a fact about the world: open to everybody. What the page
  // shows is the server's to decide (a faculty member gets the journal and
  // their own papers in it, never anybody else's).
  { pattern: "/journals/:title" },
  // `/people/:id` is three pages by role (public profile, department view,
  // the college's record), so every role has one.
  { pattern: "/people/:id" },
  { pattern: "/u/:id" },
  // The faculty record: the office, the heads of the college and Finance;
  // a head of department for their own department; anybody for themselves.
  { pattern: "/faculty/:id", roles: RECORD_READERS, self: true },
  // A claim's own page opens for its owner and for the college's readers;
  // for everybody else it is `claimLink`'s call, because it depends on whose
  // claim it is.
  { pattern: "/papers/:id/edit" },
  { pattern: "/papers/:id" },
  // The review workspace is the desks'. Everybody else is sent to the claim's
  // own page, which `claimLink` links to instead.
  { pattern: "/review/:claimId", roles: [...REVIEWERS, "DIRECTOR"] },
  { pattern: "/department/papers/:id", roles: ["HOD"] },
  { pattern: "/reports/departments/:name", roles: NAMED("/reports/departments") },
  { pattern: "/batches/:id", roles: NAMED("/batches") },
  { pattern: "/messages/c/:id" },
  { pattern: "/messages/o/:id" },
  { pattern: "/messages/:id" },
  { pattern: "/discussions/p/:id" },
  { pattern: "/discussions/:id" },
]

/** Where `href` points, without the query string or the fragment. */
export function pathOf(href: string): string {
  const path = href.split(/[?#]/)[0] || "/"
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

/**
 * Whether `role` may open `href`. Pass `selfId` so a faculty member can open
 * their own record (`/faculty/<their id>`). Anything that is not a path in this
 * app (a full URL, a mailto, a download) is not a route and is open.
 */
export function canOpenRoute(role: Role | undefined, href: string, selfId?: string | null): boolean {
  if (!role) return false
  if (!href.startsWith("/") || href.startsWith("//")) return true
  const path = pathOf(href)

  const roles = rolesOf(path)
  if (roles !== null) return !roles || roles.includes(role)

  for (const rule of DYNAMIC_ROUTES) {
    const hit = matchPath({ path: rule.pattern, end: true }, path)
    if (!hit) continue
    if (!rule.roles || rule.roles.includes(role)) return true
    if (rule.self) {
      const id = hit.params.id
      return id === "me" || (!!selfId && id === selfId)
    }
    return false
  }
  return true
}

/**
 * Where a claim link should go for this reader, or null when they cannot open
 * the claim at all. Your own claim is always your claim page; a head of
 * department opens the department's copy; the college's readers open the claim
 * page, or the review workspace when the link is a desk's (`workspace`). A
 * faculty member has no way into somebody else's claim.
 */
export function claimLink(
  role: Role | undefined,
  claim: { id: string; owner_id?: string | null; is_mine?: boolean },
  selfId?: string | null,
  workspace = false
): string | null {
  if (!role) return null
  const mine = claim.is_mine ?? (!!selfId && claim.owner_id === selfId)
  if (mine) return `/papers/${claim.id}`
  if (role === "HOD") return `/department/papers/${claim.id}`
  if (role === "FACULTY") return null
  if (workspace && canOpenRoute(role, `/review/${claim.id}`)) return `/review/${claim.id}`
  return `/papers/${claim.id}`
}
