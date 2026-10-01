import type { Role } from "@/app/auth"
import { api } from "@/lib/api"
import { queryClient } from "@/lib/query"

/**
 * What each home screen asks the server, named once.
 *
 * The homes read these, and `prefetchHome` asks for them the moment the
 * session says who this is -- at the same time as the home's own code is
 * fetched, instead of after it has arrived and run. On a phone that is the
 * difference between one round trip of waiting and two.
 *
 * A key and its path live together here so the page and the prefetch cannot
 * drift apart: a prefetch under a slightly different key is a second request,
 * not a head start.
 */
export type HomeQuery = { key: readonly unknown[]; path: string }

export const HOME_DATA = {
  ownClaims: { key: ["my-claims"], path: "/api/claims?mine=1&limit=200" },
  myPayments: { key: ["my-payments"], path: "/api/me/payments" },
  /** The faculty Home's record in one light call: papers, citations, h-index, unfiled papers. */
  myHome: { key: ["me", "home"], path: "/api/me/home" },
  /** The fuller record summary; Profile reads it for the same paper count. Not prefetched. */
  mySummary: { key: ["me", "summary"], path: "/api/me/summary" },
  /** When the next payment run is expected (My claims reads the same key). */
  nextPayout: { key: ["next-payout"], path: "/api/me/next-payout" },
  myAssignments: { key: ["my-assignments"], path: "/api/me/assignments" },
  stageCounts: { key: ["claims", "counts", "home"], path: "/api/claims/counts" },
  /** Oldest first, never the viewer's own (server excludes them). */
  clearingQueue: { key: ["admin", "clearing-queue", "home"], path: "/api/admin/clearing-queue" },
  faults: { key: ["admin", "faults"], path: "/api/admin/faults" },
  /** The super admin's list of what needs attention (Home and Admin). */
  attention: { key: ["admin", "attention"], path: "/api/admin/attention" },
  readiness: { key: ["admin", "readiness"], path: "/api/admin/readiness" },
  /** Not drawn on Home: asking for one row builds the directory's shared totals, so Faculty opens warm. */
  directoryWarm: { key: ["directory", "warm"], path: "/api/directory/faculty?limit=1" },
  pendingRequests: {
    key: ["admin", "profile-requests", "home"],
    path: "/api/admin/profile-requests?status=PENDING&limit=1",
  },
  openDuplicates: {
    key: ["duplicates", "home"],
    path: "/api/admin/duplicate-findings?kind=SAME_PERSON&status=OPEN&limit=1",
  },
  /** With the ten most recent tickets, for the office home's list. */
  dashboard: { key: ["dashboard"], path: "/api/dashboard" },
  /** The same totals without the list, for the homes that print no list. */
  collegeTotals: { key: ["dashboard", "totals"], path: "/api/dashboard?recent=0" },
  principalQueue: { key: ["principal", "queue", "home"], path: "/api/principal/queue?limit=8" },
  directorQueue: { key: ["director-queue", "home"], path: "/api/director/queue?limit=200" },
  areas: { key: ["reports", "areas"], path: "/api/reports/areas?limit=12" },
  budget: { key: ["budgets", ""], path: "/api/budgets" },
  /** A head's three questions in one call; the same key `useBrief()` reads. */
  hodBrief: { key: ["hod", "brief", "current"], path: "/api/hod/brief" },
} as const satisfies Record<string, HomeQuery>

const D = HOME_DATA
const OFFICE = [D.clearingQueue, D.stageCounts, D.faults, D.pendingRequests, D.openDuplicates, D.dashboard]
/** "Your papers", below the desk on the home of everybody who files but faculty. */
const OWN = [D.ownClaims, D.myPayments]

const BY_ROLE: Record<Role, readonly HomeQuery[]> = {
  FACULTY: [D.myHome, D.ownClaims, D.myPayments, D.myAssignments, D.nextPayout],
  HOD: [D.hodBrief, ...OWN],
  PRINCIPAL: [D.principalQueue, D.collegeTotals, ...OWN],
  DIRECTOR: [D.directorQueue, D.areas, D.collegeTotals, D.budget, ...OWN],
  FINANCE: [D.budget, ...OWN],
  RESEARCH_CELL: [...OFFICE, ...OWN],
  RESEARCH_COORDINATOR: [...OFFICE, ...OWN],
  // Files nothing of their own, so has no such section.
  SUPER_ADMIN: [D.clearingQueue, D.stageCounts, D.attention, D.directoryWarm],
}

/**
 * "Is anything stuck?": the stage counts, and the five claims that have
 * waited longest at the desks that are not this reader's own (their own is
 * already the queue above it). One request, shared by the prefetch and the
 * home so a prefetch under a slightly different key is not a second request.
 */
const OWN_DESK_STAGE: Partial<Record<Role, string>> = {
  SUPER_ADMIN: "submitted",
  RESEARCH_CELL: "submitted",
  RESEARCH_COORDINATOR: "submitted",
  PRINCIPAL: "checked",
  DIRECTOR: "approved",
  FINANCE: "authorised",
}

export function homeTrack(role: Role | undefined): HomeQuery {
  const own = role ? OWN_DESK_STAGE[role] : undefined
  return {
    key: ["track", "home", own ?? ""],
    path: `/api/track?moving=1&limit=5${own ? `&exclude=${own}` : ""}`,
  }
}

/** Start the requests `role`'s home will make. Already-fresh data is left alone. */
export function prefetchHome(role: Role) {
  const track = role === "FACULTY" ? [] : [homeTrack(role)]
  for (const q of [...(BY_ROLE[role] ?? []), ...track]) {
    void queryClient.prefetchQuery({ queryKey: q.key, queryFn: () => api(q.path) })
  }
}
