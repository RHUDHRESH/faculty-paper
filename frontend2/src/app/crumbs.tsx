import { createContext, useContext, useEffect, useMemo, useState } from "react"

import type { Role } from "@/app/auth"
import { activeDoor, DOOR_LABELS, pagesFor } from "@/app/nav"
import type { Crumb } from "@/ui/breadcrumbs"

/**
 * Breadcrumbs from the route (docs/ux/22, "Navigation"): "Admin / Imports",
 * "Faculty / Dr A Athiraja". The shell draws them above every page that sits
 * inside a section, so a page does not need to know where it lives.
 *
 * Nothing is declared per page. The trail is worked out from three facts
 * that already exist:
 *
 *   1. the office door the path sits under (`activeDoor`: Imports lights
 *      Admin, Ledger lights Money for a Finance officer, Admin for the admin),
 *   2. the page it belongs to, for a record or sub-page (`DETAILS` below), and
 *   3. the page's own name (`NAV`, or a name for a detail route).
 *
 * A path that is a door itself, or the home page, has no trail: there is
 * nowhere above it to go back to.
 */

/** Routes that are a record or a sub-page, not a sidebar destination.
 *  `parent` is the page they belong to, when the URL nesting is a real
 *  hierarchy (one run of Monthly runs, one paper of My papers); it is not
 *  guessed from the URL, because /reports/brief is not "under" /reports.
 *  `own` marks a personal page that must not borrow the section it happens
 *  to live under (Notification settings are not "Admin"). A page that knows
 *  the record's name supplies it with `useCrumbLabel`, which replaces the
 *  last crumb. */
type Detail = { pattern: string; label: string; parent?: string; own?: boolean }
const DETAILS: Detail[] = [
  { pattern: "/faculty/:id", label: "Faculty record", parent: "/faculty" },
  { pattern: "/reports/departments/:name", label: "Department", parent: "/reports/departments" },
  { pattern: "/reports/departments", label: "Departments" },
  { pattern: "/reports/papers", label: "Papers" },
  { pattern: "/people/matches", label: "Author matches" },
  { pattern: "/people/passwords", label: "Issue passwords", parent: "/people" },
  { pattern: "/people/:id", label: "Person", parent: "/people" },
  { pattern: "/batches/:id", label: "Monthly run", parent: "/batches" },
  { pattern: "/journals/:id", label: "Journal", parent: "/journals" },
  { pattern: "/papers/claims", label: "Your claims", parent: "/papers", own: true },
  { pattern: "/papers/appraisal", label: "List for appraisal", parent: "/papers", own: true },
  { pattern: "/papers/statement", label: "Payment statement", parent: "/papers", own: true },
  { pattern: "/papers/locker", label: "Proof locker", parent: "/papers", own: true },
  { pattern: "/papers/new", label: "File a paper", parent: "/papers", own: true },
  { pattern: "/papers/:id/edit", label: "Edit paper", parent: "/papers", own: true },
  { pattern: "/papers/:id", label: "Claim", parent: "/papers", own: true },
  { pattern: "/payments/done", label: "Paid", parent: "/payments" },
  { pattern: "/department/papers/:id", label: "Paper", parent: "/department" },
  { pattern: "/review/:id", label: "Review", parent: "/clearing" },
  { pattern: "/discussions/p/:id", label: "Post", parent: "/discussions", own: true },
  { pattern: "/discussions/:id", label: "Thread", parent: "/discussions", own: true },
  { pattern: "/messages/office", label: "Research office", parent: "/messages", own: true },
  { pattern: "/messages/c/:id", label: "Conversation", parent: "/messages", own: true },
  { pattern: "/messages/o/:id", label: "Conversation", parent: "/messages", own: true },
  { pattern: "/messages/:id", label: "Conversation", parent: "/messages", own: true },
  // A place to start from, reached from the top bar by everybody. The "Reports"
  // door lists it among the lookups, but a reader who searched is not "in"
  // Reports, and the crumb sent them to a page they did not ask for.
  { pattern: "/search", label: "Search", own: true },
  { pattern: "/u/me/stats", label: "Your stats", own: true },
  { pattern: "/u/:id", label: "Profile", own: true },
  { pattern: "/settings/notifications", label: "Notification settings", own: true },
]

const matches = (pattern: string, pathname: string) =>
  new RegExp("^" + pattern.replace(/:[a-z]+/g, "[^/]+") + "$").test(pathname)

const detailOf = (pathname: string) => DETAILS.find((d) => matches(d.pattern, pathname))

/**
 * The trail for a path, or an empty list when the path has nowhere above it.
 * `dynamic` is the name of the record on screen, if the page supplied one.
 */
export function crumbsFor(role: Role | undefined, pathname: string, dynamic?: string): Crumb[] {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
  if (!role || path === "/") return []

  const pages = pagesFor(role)
  const detail = detailOf(path)
  const nameOf = (p: string) => pages.find((i) => i.to === p)?.label ?? detailOf(p)?.label

  const door = detail?.own ? undefined : activeDoor(role, path)
  // The path is the door's own page: nothing above it.
  if (door && door === path) return []

  const trail: Crumb[] = []
  if (door) trail.push({ label: DOOR_LABELS[door] ?? nameOf(door) ?? "Back", to: door })
  if (detail?.parent && detail.parent !== door) {
    const label = nameOf(detail.parent)
    if (label) trail.push({ label, to: detail.parent })
  }

  // A path that is in no section and below no page (Help, Your profile) needs
  // no trail: a single crumb would only repeat the title.
  if (trail.length === 0) return []
  return [...trail, { label: dynamic ?? nameOf(path) ?? "Details" }]
}

/* ------------------------------------------------------------------------ */
/* The name of the record on screen                                          */
/* ------------------------------------------------------------------------ */

type Setter = (label: string | undefined) => void
const LabelContext = createContext<{ label: string | undefined; set: Setter }>({
  label: undefined,
  set: () => {},
})

/** Holds the record name a page has supplied, for the shell to read. */
export function CrumbLabelProvider({ children }: { children: React.ReactNode }) {
  const [label, set] = useState<string | undefined>()
  const value = useMemo(() => ({ label, set }), [label])
  return <LabelContext.Provider value={value}>{children}</LabelContext.Provider>
}

/** The name of the record a detail page is showing, once known. */
export function useCrumbLabelValue(): string | undefined {
  return useContext(LabelContext).label
}

/**
 * A detail page calls this with the record's name ("Dr A Athiraja", "ERP
 * workbook, 28 Sep") and the last crumb reads that instead of "Faculty
 * record". Pass `undefined` while it is loading; the generic name shows
 * meanwhile. Cleared when the page goes away.
 */
export function useCrumbLabel(label: string | null | undefined): void {
  const { set } = useContext(LabelContext)
  useEffect(() => {
    set(label || undefined)
    return () => set(undefined)
  }, [label, set])
}
