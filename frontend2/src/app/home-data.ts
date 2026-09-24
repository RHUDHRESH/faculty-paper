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
  ownClaims: { key: ["my-claims"], path: "/api/claims?limit=200" },
  myPayments: { key: ["my-payments"], path: "/api/me/payments" },
  myAssignments: { key: ["my-assignments"], path: "/api/me/assignments" },
  stageCounts: { key: ["claims", "counts", "home"], path: "/api/claims/counts" },
  faults: { key: ["admin", "faults"], path: "/api/admin/faults" },
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
  hodOverview: { key: ["hod", "overview"], path: "/api/hod/overview" },
  hodStanding: { key: ["hod", "standing", ""], path: "/api/hod/standing" },
  hodTargets: { key: ["hod", "targets", ""], path: "/api/hod/targets" },
} as const satisfies Record<string, HomeQuery>

const D = HOME_DATA
const OFFICE = [D.stageCounts, D.faults, D.pendingRequests, D.openDuplicates, D.dashboard]

const BY_ROLE: Record<Role, readonly HomeQuery[]> = {
  FACULTY: [D.ownClaims, D.myPayments, D.myAssignments],
  HOD: [D.hodOverview, D.hodStanding, D.hodTargets, D.ownClaims, D.myPayments],
  PRINCIPAL: [D.principalQueue, D.collegeTotals],
  DIRECTOR: [D.directorQueue, D.areas, D.collegeTotals, D.budget],
  FINANCE: [D.budget],
  RESEARCH_CELL: OFFICE,
  RESEARCH_COORDINATOR: OFFICE,
  SUPER_ADMIN: OFFICE,
}

/** Start the requests `role`'s home will make. Already-fresh data is left alone. */
export function prefetchHome(role: Role) {
  for (const q of BY_ROLE[role] ?? []) {
    void queryClient.prefetchQuery({ queryKey: q.key, queryFn: () => api(q.path) })
  }
}
