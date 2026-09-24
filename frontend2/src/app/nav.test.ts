import { describe, expect, it } from "vitest"

import { can } from "@/app/auth"
import { navFor, reviewsFlags } from "@/app/nav"

/**
 * A head of department is a faculty member who also heads the department
 * (the college's decision of 2026-09-23): they keep filing their own papers.
 * The sidebar has to offer them the same two doors a faculty member has,
 * and `can()` has to agree with `rbac.CLAIMANT_ROLES` on the server.
 */
describe("a head of department files papers", () => {
  const paths = (role: Parameters<typeof navFor>[0]) => navFor(role).map((i) => i.to)

  it("offers a head My papers and File a paper, beside their department", () => {
    expect(paths("HOD")).toEqual(expect.arrayContaining(["/papers", "/papers/new", "/department"]))
  })

  it("still offers them to faculty, unlabelled, as the daily work", () => {
    expect(paths("FACULTY")).toEqual(expect.arrayContaining(["/papers", "/papers/new"]))
    for (const role of ["FACULTY", "HOD"] as const) {
      for (const item of navFor(role).filter((i) => i.to.startsWith("/papers"))) {
        expect(item.group, `${role} ${item.to}`).toBeUndefined()
      }
    }
  })

  it("offers Flags and Past claims to the desks that judge a paper, and to nobody else", () => {
    for (const role of ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL"] as const) {
      expect(paths(role)).toEqual(expect.arrayContaining(["/flags", "/archive"]))
      expect(reviewsFlags(role)).toBe(true)
    }
    // `rbac.can_review_flags`: the Director and Finance are not shown the
    // doubts about what they authorise and pay; a claimant is not shown the
    // doubts about their own paper.
    for (const role of ["DIRECTOR", "FINANCE", "FACULTY", "HOD"] as const) {
      expect(paths(role)).not.toContain("/flags")
      expect(paths(role)).not.toContain("/archive")
      expect(reviewsFlags(role)).toBe(false)
    }
  })

  it("marks a head as somebody who files their own papers, and still money-blind to others", () => {
    expect(can("HOD").fileOwnPapers).toBe(true)
    expect(can("FACULTY").fileOwnPapers).toBe(true)
    expect(can("HOD").seeMoney).toBe(false)
  })
})

/**
 * Everybody with an office role but the super admin is an academic too
 * (`rbac.CLAIMANT_ROLES`): they "must be able to do both — do their own
 * research as well as track others'". The sidebar keeps their office items
 * as they were and adds a "My research" group with the two doors a claimant
 * has.
 */
describe("an officer files their own papers too", () => {
  const OFFICERS = ["RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR", "FINANCE"] as const
  const OFFICE_DOOR: Record<(typeof OFFICERS)[number], string> = {
    RESEARCH_CELL: "/clearing",
    RESEARCH_COORDINATOR: "/clearing",
    PRINCIPAL: "/approvals",
    DIRECTOR: "/authorisations",
    FINANCE: "/payments",
  }

  it("offers every officer My papers and File a paper under My research, beside their desk", () => {
    for (const role of OFFICERS) {
      const items = navFor(role)
      const mine = items.filter((i) => i.to === "/papers" || i.to === "/papers/new")
      expect(mine.map((i) => i.label), role).toEqual(["My papers", "File a paper"])
      for (const item of mine) expect(item.group, `${role} ${item.to}`).toBe("My research")
      // The office screens are exactly where they were.
      expect(items.map((i) => i.to), role).toContain(OFFICE_DOOR[role])
      expect(items.find((i) => i.to === OFFICE_DOOR[role])?.group, role).toBeUndefined()
    }
  })

  it("draws My research as one run of items, so the sidebar heads it once", () => {
    for (const role of OFFICERS) {
      const groups = navFor(role).map((i) => i.group)
      const first = groups.indexOf("My research")
      const last = groups.lastIndexOf("My research")
      expect(first, role).toBeGreaterThanOrEqual(0)
      expect(groups.slice(first, last + 1).every((g) => g === "My research"), role).toBe(true)
    }
  })

  it("marks every officer as filing their own papers, and not the super admin", () => {
    for (const role of OFFICERS) expect(can(role).fileOwnPapers, role).toBe(true)
    expect(can("SUPER_ADMIN").fileOwnPapers).toBe(false)
    expect(can(undefined).fileOwnPapers).toBe(false)
    expect(navFor("SUPER_ADMIN").map((i) => i.to)).not.toContain("/papers/new")
    expect(navFor("SUPER_ADMIN").map((i) => i.to)).not.toContain("/papers")
  })
})
