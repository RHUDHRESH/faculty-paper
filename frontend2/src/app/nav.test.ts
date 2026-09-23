import { describe, expect, it } from "vitest"

import { can } from "@/app/auth"
import { navFor } from "@/app/nav"

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

  it("marks a head as somebody who files their own papers, and still money-blind to others", () => {
    expect(can("HOD").fileOwnPapers).toBe(true)
    expect(can("FACULTY").fileOwnPapers).toBe(true)
    expect(can("PRINCIPAL").fileOwnPapers).toBe(false)
    expect(can("HOD").seeMoney).toBe(false)
  })
})
