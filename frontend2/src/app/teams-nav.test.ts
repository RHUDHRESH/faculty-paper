import { describe, expect, it } from "vitest"

import { activeDoor, hubSections, NAV, navFor, pagesFor } from "@/app/nav"

/**
 * Student teams are found by the people who may see them (the office, the
 * Principal, the Director and a head of department), and "My teams" by the
 * people who may see only their own. Mirrors `student_teams.visible_teams`.
 */
describe("student teams in the navigation", () => {
  const SEES_TEAMS = ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR", "HOD"] as const

  it("is Student teams, one look-up away on the Reports door, for everybody who sees the college's or a department's", () => {
    for (const role of SEES_TEAMS) {
      const page = pagesFor(role).find((p) => p.to === "/teams")
      expect(page?.label, role).toBe("Student teams")
      expect(page?.findOnly, role).toBeFalsy()
      expect(page?.purpose, role).toBeTruthy()
      expect(page?.purpose, role).not.toMatch(/ — /)
      expect(hubSections("reports", role).flatMap((s) => s.items.map((i) => i.to)), role).toContain("/teams")
      expect(activeDoor(role, "/teams/ZZ26CS0001"), role).toBe("/reports/all")
    }
  })

  it("is My teams, found by name and from Home, for faculty and the other claimants", () => {
    for (const role of ["FACULTY", "FINANCE"] as const) {
      const page = pagesFor(role).find((p) => p.to === "/teams")
      expect(page?.label, role).toBe("My teams")
      expect(page?.findOnly, role).toBe(true)
      expect(navFor(role).map((i) => i.to), role).not.toContain("/teams")
    }
  })

  it("is found by the words a person uses for it", () => {
    for (const role of ["RESEARCH_CELL", "FACULTY"] as const) {
      const page = pagesFor(role).find((p) => p.to === "/teams")!
      const words = [page.label, ...(page.keywords ?? [])].join(" ").toLowerCase()
      for (const word of ["final year project", "register number", "team number", "mentor"]) expect(words).toContain(word)
    }
  })

  it("has one entry for each reader, so the palette never lists it twice", () => {
    for (const role of [...SEES_TEAMS, "FACULTY", "FINANCE"] as const) {
      expect(pagesFor(role).filter((p) => p.to === "/teams"), role).toHaveLength(1)
    }
    expect(NAV.filter((p) => p.to === "/teams")).toHaveLength(2)
  })
})
