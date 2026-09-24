import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn(() => Promise.resolve({})) }
})

import type { Role } from "@/app/auth"
import { HOME_DATA, prefetchHome } from "@/app/home-data"
import { api } from "@/lib/api"
import { queryClient } from "@/lib/query"

/**
 * Every office role but the super admin files its own papers, and its home
 * draws them in a "Your papers" section below the desk. The head start the
 * prefetch gives a home has to cover that section too, or it is the one part
 * of the page still waiting on a second round trip.
 */
describe("prefetching a home", () => {
  beforeEach(() => {
    queryClient.clear()
    vi.mocked(api).mockClear()
  })

  const asked = (role: Role) => {
    prefetchHome(role)
    return vi.mocked(api).mock.calls.map(([path]) => path)
  }

  it("starts an officer's own papers and payments with the desk's data", () => {
    for (const role of ["RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR", "FINANCE"] as const) {
      queryClient.clear()
      vi.mocked(api).mockClear()
      const paths = asked(role)
      expect(paths, role).toContain(HOME_DATA.ownClaims.path)
      expect(paths, role).toContain(HOME_DATA.myPayments.path)
    }
  })

  it("asks only for the viewer's own papers, never the college's", () => {
    expect(HOME_DATA.ownClaims.path).toContain("mine=1")
  })

  it("starts nothing of the kind for the super admin, who files nothing", () => {
    const paths = asked("SUPER_ADMIN")
    expect(paths).not.toContain(HOME_DATA.ownClaims.path)
    expect(paths).not.toContain(HOME_DATA.myPayments.path)
  })
})
