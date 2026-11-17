import { describe, expect, it } from "vitest"

import { canOpenRoute, claimLink, pathOf } from "@/app/access"
import { can, type Role } from "@/app/auth"
import { guidesFor } from "@/app/guides"
import { HUBS, hubSections, navFor, NAV, pagesFor, type HubKey } from "@/app/nav"

const ROLES: Role[] = [
  "FACULTY",
  "HOD",
  "PRINCIPAL",
  "VICE_PRINCIPAL",
  "DIRECTOR",
  "RESEARCH_COORDINATOR",
  "RESEARCH_CELL",
  "FINANCE",
  "SUPER_ADMIN",
]

describe("the route permission map", () => {
  it("answers a nav page from the nav's own roles, so the two cannot drift", () => {
    for (const role of ROLES) {
      for (const page of NAV) {
        // A page with one entry per audience is open to a role any of its entries is for.
        const entries = NAV.filter((p) => p.to === page.to)
        const expected = entries.some((p) => !p.roles || p.roles.includes(role))
        expect(canOpenRoute(role, page.to), `${role} ${page.to}`).toBe(expected)
      }
    }
  })

  it("opens every journal to every role: faculty get the journal and their own papers", () => {
    for (const role of ROLES) {
      expect(canOpenRoute(role, "/journals/Nature"), role).toBe(true)
      expect(canOpenRoute(role, "/journals/Journal%20of%20Tests?x=1"), role).toBe(true)
      expect(can(role).openJournal, role).toBe(true)
    }
  })

  it("keeps the journal list to the people who may read the college's figures", () => {
    expect(canOpenRoute("FACULTY", "/journals")).toBe(false)
    expect(canOpenRoute("VICE_PRINCIPAL", "/journals")).toBe(true)
    expect(canOpenRoute("HOD", "/journals")).toBe(true)
  })

  it("opens a person's page to every role, since each has its own version of it", () => {
    for (const role of ROLES) expect(canOpenRoute(role, "/people/abc"), role).toBe(true)
    // ...but not the accounts screens that share the prefix.
    expect(canOpenRoute("FACULTY", "/people")).toBe(false)
    expect(canOpenRoute("FACULTY", "/people/passwords")).toBe(false)
    expect(canOpenRoute("PRINCIPAL", "/people/passwords")).toBe(false)
  })

  it("opens a faculty record to the college's readers and a head, and to a faculty member for themselves only", () => {
    for (const role of ["SUPER_ADMIN", "RESEARCH_CELL", "PRINCIPAL", "VICE_PRINCIPAL", "DIRECTOR", "FINANCE", "HOD"] as Role[]) {
      expect(canOpenRoute(role, "/faculty/u1"), role).toBe(true)
    }
    expect(canOpenRoute("FACULTY", "/faculty/u1", "u2")).toBe(false)
    expect(canOpenRoute("FACULTY", "/faculty/u1", "u1")).toBe(true)
    expect(canOpenRoute("FACULTY", "/faculty/me")).toBe(true)
  })

  it("keeps the money pages to the roles that hold them", () => {
    expect(canOpenRoute("RESEARCH_CELL", "/ledger")).toBe(false)
    expect(canOpenRoute("PRINCIPAL", "/ledger")).toBe(false)
    expect(canOpenRoute("FINANCE", "/ledger?month=2026-09")).toBe(true)
    expect(canOpenRoute("FACULTY", "/payments")).toBe(false)
    expect(canOpenRoute("VICE_PRINCIPAL", "/statements")).toBe(true)
  })

  it("keeps the review workspace to the desks and the department's paper to a head", () => {
    expect(canOpenRoute("RESEARCH_CELL", "/review/c1?queue=clearing")).toBe(true)
    expect(canOpenRoute("VICE_PRINCIPAL", "/review/c1")).toBe(false)
    expect(canOpenRoute("FACULTY", "/review/c1")).toBe(false)
    expect(canOpenRoute("HOD", "/department/papers/c1")).toBe(true)
    expect(canOpenRoute("FACULTY", "/department/papers/c1")).toBe(false)
  })

  it("treats anything that is not a path in this app as open, and a missing role as closed", () => {
    expect(canOpenRoute("FACULTY", "https://doi.org/10.1/x")).toBe(true)
    expect(canOpenRoute("FACULTY", "mailto:a@b.c")).toBe(true)
    expect(canOpenRoute(undefined, "/")).toBe(false)
    expect(pathOf("/journals/a?x=1#y")).toBe("/journals/a")
  })
})

describe("a link to a claim", () => {
  const other = { id: "c1", owner_id: "u2" }
  it("is your own claim page when it is yours, for everybody", () => {
    for (const role of ROLES) expect(claimLink(role, other, "u2"), role).toBe("/papers/c1")
  })
  it("is nothing for faculty, who cannot open a colleague's claim", () => {
    expect(claimLink("FACULTY", other, "u1")).toBeNull()
  })
  it("is the department's copy for a head", () => {
    expect(claimLink("HOD", other, "u1")).toBe("/department/papers/c1")
  })
  it("is the claim page for the college's readers, and the workspace for a desk that asks for it", () => {
    expect(claimLink("VICE_PRINCIPAL", other, "u1")).toBe("/papers/c1")
    expect(claimLink("PRINCIPAL", other, "u1", true)).toBe("/review/c1")
    expect(claimLink("VICE_PRINCIPAL", other, "u1", true)).toBe("/papers/c1")
  })
})

describe("every link the app builds from its own lists is one the role may open", () => {
  it("is true of the sidebar, the palette pages, the hubs and the guides, for each role", () => {
    for (const role of ROLES) {
      const links = [
        ...navFor(role).map((i) => i.to),
        ...pagesFor(role).map((i) => i.to),
        ...(Object.keys(HUBS) as HubKey[]).flatMap((h) => hubSections(h, role).flatMap((s) => s.items.map((i) => i.to))),
        ...guidesFor(role).map((g) => g.to),
      ]
      for (const to of links) {
        // A guide's call to action is to a page the role was handed the guide for.
        expect(canOpenRoute(role, to), `${role} -> ${to}`).toBe(true)
      }
    }
  })
})
