import { describe, expect, it } from "vitest"

import { crumbsFor } from "@/app/crumbs"

const labels = (role: Parameters<typeof crumbsFor>[0], path: string, dynamic?: string) =>
  crumbsFor(role, path, dynamic).map((c) => c.label)

describe("breadcrumbs from the route", () => {
  it("has none on a door or on Home", () => {
    expect(crumbsFor("SUPER_ADMIN", "/")).toEqual([])
    expect(crumbsFor("SUPER_ADMIN", "/admin")).toEqual([])
    expect(crumbsFor("SUPER_ADMIN", "/track")).toEqual([])
    expect(crumbsFor("SUPER_ADMIN", "/faculty")).toEqual([])
  })

  it("puts an admin page under Admin", () => {
    expect(labels("SUPER_ADMIN", "/imports")).toEqual(["Admin", "Imports"])
    expect(labels("SUPER_ADMIN", "/jobs")).toEqual(["Admin", "Jobs"])
    expect(crumbsFor("SUPER_ADMIN", "/imports")[0].to).toBe("/admin")
  })

  it("puts a money page under Money for the officers who have no Admin", () => {
    expect(labels("FINANCE", "/ledger")).toEqual(["Money", "Ledger"])
    expect(labels("PRINCIPAL", "/budget")).toEqual(["Money", "Budget"])
  })

  it("names a record under the page it belongs to, and takes the page's own name for it", () => {
    expect(labels("SUPER_ADMIN", "/faculty/abc")).toEqual(["Faculty", "Faculty record"])
    expect(labels("SUPER_ADMIN", "/faculty/abc", "Dr A Athiraja")).toEqual(["Faculty", "Dr A Athiraja"])
    expect(labels("SUPER_ADMIN", "/batches/9")).toEqual(["Admin", "Monthly runs", "Monthly run"])
    expect(labels("SUPER_ADMIN", "/batches/9", "Scopus run, September")).toEqual(["Admin", "Monthly runs", "Scopus run, September"])
  })

  it("gives a faculty member their claim under My papers, and nothing on a top-level page", () => {
    expect(labels("FACULTY", "/papers/abc")).toEqual(["My papers", "Claim"])
    expect(labels("FACULTY", "/papers/new")).toEqual(["My papers", "File a paper"])
    expect(crumbsFor("FACULTY", "/papers")).toEqual([])
    expect(crumbsFor("FACULTY", "/me")).toEqual([])
    expect(crumbsFor("FACULTY", "/help")).toEqual([])
  })

  it("gives Search no parent: it is a place to start, not a part of Reports", () => {
    const roles = ["FACULTY", "HOD", "PRINCIPAL", "DIRECTOR", "RESEARCH_COORDINATOR", "RESEARCH_CELL", "FINANCE", "SUPER_ADMIN"] as const
    for (const role of roles) expect(crumbsFor(role, "/search"), role).toEqual([])
  })

  it("keeps a personal page out of the section it sits under", () => {
    expect(crumbsFor("SUPER_ADMIN", "/settings/notifications")).toEqual([])
    expect(labels("SUPER_ADMIN", "/settings")).toEqual(["Admin", "Institution"])
  })
})
