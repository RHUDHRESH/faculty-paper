import { describe, expect, it } from "vitest"

import { can } from "@/app/auth"
import { navBadges, navFor, reviewsFlags } from "@/app/nav"

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

  it("still offers them to faculty, and to nobody in the office chain", () => {
    expect(paths("FACULTY")).toEqual(expect.arrayContaining(["/papers", "/papers/new"]))
    for (const role of ["PRINCIPAL", "DIRECTOR", "FINANCE"] as const) {
      expect(paths(role)).not.toContain("/papers/new")
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
    expect(can("PRINCIPAL").fileOwnPapers).toBe(false)
    expect(can("HOD").seeMoney).toBe(false)
  })
})

/**
 * The sidebar says how much is waiting at the reader's own desk, so the queue
 * is one glance away from any page -- and says nothing about anybody else's.
 */
describe("nav badges", () => {
  const counts = { draft: 2, filed: 13, checked: 3, approved: 4, authorised: 5, paid: 81, sent_back: 1 }

  it("counts each desk's own queue", () => {
    expect(navBadges("RESEARCH_CELL", counts)).toEqual({ "/clearing": 13 })
    expect(navBadges("SUPER_ADMIN", counts)).toEqual({ "/clearing": 13 })
    expect(navBadges("PRINCIPAL", counts)).toEqual({ "/approvals": 3 })
    expect(navBadges("DIRECTOR", counts)).toEqual({ "/authorisations": 4 })
    expect(navBadges("FINANCE", counts)).toEqual({ "/payments": 5 })
  })

  it("tells a claimant only what has come back to them", () => {
    expect(navBadges("FACULTY", counts)).toEqual({ "/papers": 1 })
    expect(navBadges("HOD", counts)).toEqual({ "/papers": 1 })
  })

  it("draws nothing for an empty queue or before the counts arrive", () => {
    expect(navBadges("PRINCIPAL", { ...counts, checked: 0 })).toEqual({})
    expect(navBadges("PRINCIPAL", undefined)).toEqual({})
  })
})
