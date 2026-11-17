import { act } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { canOpenRoute } from "@/app/access"
import type { Me, Role } from "@/app/auth"
import { api } from "@/lib/api"
import { AdminHome } from "@/pages/home-admin"
import { DirectorHome } from "@/pages/home-director"
import { FacultyHome } from "@/pages/home-faculty"
import { FinanceHome } from "@/pages/home-finance"
import { HodHome } from "@/pages/home-hod"
import { PrincipalHome } from "@/pages/home-principal"
import { OfficeHome } from "@/pages/home-staff"
import { VicePrincipalHome } from "@/pages/home-vice-principal"
import { AdminHub, MoneyHub, ReportsHub } from "@/pages/hub"
import { JournalRecord } from "@/pages/journals"
import { Route, Routes } from "react-router-dom"
import { fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The rule behind every button and link: a page is never offered to a role
 * that cannot open it. For each role, the main pages are rendered with
 * something to link to (a colleague's claim, a colleague, a journal), and
 * every link they draw must point at a route that role may open
 * (`app/access.ts`, the route permission map).
 */

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

const meFor = (role: Role): Me => ({
  id: `u-${role.toLowerCase()}`,
  email: `${role.toLowerCase()}@example.edu`,
  name: `Test ${role}`,
  role,
  department: role === "HOD" || role === "FACULTY" ? "Physics" : null,
})

const HOMES: Record<Role, () => React.ReactElement> = {
  FACULTY: () => <FacultyHome />,
  HOD: () => <HodHome />,
  PRINCIPAL: () => <PrincipalHome />,
  VICE_PRINCIPAL: () => <VicePrincipalHome />,
  DIRECTOR: () => <DirectorHome />,
  RESEARCH_COORDINATOR: () => <OfficeHome />,
  RESEARCH_CELL: () => <OfficeHome />,
  FINANCE: () => <FinanceHome />,
  SUPER_ADMIN: () => <AdminHome />,
}

const STAFF_JOURNAL = (role: Role) => ({
  journal: { title: "Journal of Tests", issn: "1234-5678", indexing: "Scopus", engineering_class: null, subject_category: null, snip_on_record: null, snip_year_on_record: null, scimago: null, snip: null },
  totals: { publications: 2, authors: 2, departments: 1, paid_claims: 1, ...(role === "HOD" ? {} : { paid_amount: 5000 }), first_year: 2025, last_year: 2026 },
  by_year: [],
  by_quartile: [],
  by_status: [],
  by_department: [],
  authors: [{ key: "A Colleague", id: "u-colleague", department: "Physics", count: 1, ...(role === "HOD" ? {} : { amount: 5000 }) }],
  claims: [
    { id: "c-other", ticket_number: "FP-1", paper_title: "A colleague's paper", owner_id: "u-colleague", owner_name: "A Colleague", publication_year: 2025, ...(role === "HOD" ? { progress: "Under review" } : { status: "PAID", remuneration: 5000 }) },
  ],
})

const FACULTY_JOURNAL = {
  view: "faculty",
  journal: {
    title: "Journal of Tests", issn: "1234-5678", eissn: null, publisher: "Test Press", subject_category: null, indexing: "Scopus", engineering_class: null,
    snip_by_year: [{ year: 2025, snip: 1.2 }],
    sjr_by_year: [{ year: 2025, sjr: 0.9, best_quartile: "Q1", categories: [{ category: "Physics", quartile: "Q1" }] }],
    standing: { scopus_discontinued: { state: "unknown", since: null, reason: null }, ugc_care: { state: "unknown", since: null, reason: null } },
  },
  mine: { count: 1, claims: [{ id: "c-mine", ticket_number: "FP-2", paper_title: "My own paper", publication_year: 2025, status: "SUBMITTED", quartile: "Q1", snip: 1.2, remuneration: null, remuneration_is_estimate: false }] },
}

async function linksOn(role: Role, ui: React.ReactElement, table: ApiTable, route = "/"): Promise<string[]> {
  const me = meFor(role)
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => me, ...table }))
  const { container } = renderWithProviders(ui, { route })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120))
  })
  return [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "")
}

function expectOpenable(role: Role, hrefs: string[], where: string) {
  const bad = hrefs.filter((h) => h.startsWith("/") && !canOpenRoute(role, h, meFor(role).id))
  expect(bad, `${role} on ${where} is offered a page it cannot open`).toEqual([])
}

describe("no dead-end links, for any role", () => {
  for (const role of ROLES) {
    describe(role, () => {
      it("draws only openable links on its Home", async () => {
        const hrefs = await linksOn(role, HOMES[role](), {})
        expectOpenable(role, hrefs, "Home")
      })

      it("draws only openable links on the Admin, Money and Reports hubs", async () => {
        for (const [name, ui] of [
          ["Admin", <AdminHub key="a" />],
          ["Money", <MoneyHub key="m" />],
          ["Reports", <ReportsHub key="r" />],
        ] as const) {
          expectOpenable(role, await linksOn(role, ui, {}), name)
        }
      })

      it("draws only openable links on a journal, whichever record the server answers with", async () => {
        const body = role === "FACULTY" ? FACULTY_JOURNAL : STAFF_JOURNAL(role)
        const hrefs = await linksOn(
          role,
          <Routes>
            <Route path="/journals/:title" element={<JournalRecord />} />
          </Routes>,
          { "/api/journals/report": () => body, "/api/admin/journal-watch": () => [] },
          "/journals/Journal%20of%20Tests"
        )
        expect(hrefs.length, "the journal page drew something to link to").toBeGreaterThan(0)
        expectOpenable(role, hrefs, "a journal")
      })
    })
  }

  it("links a head to the department's copy of a colleague's paper, never the claim page", async () => {
    const hrefs = await linksOn(
      "HOD",
      <Routes>
        <Route path="/journals/:title" element={<JournalRecord />} />
      </Routes>,
      { "/api/journals/report": () => STAFF_JOURNAL("HOD"), "/api/admin/journal-watch": () => [] },
      "/journals/Journal%20of%20Tests"
    )
    expect(hrefs).toContain("/department/papers/c-other")
    expect(hrefs).not.toContain("/papers/c-other")
  })

  it("shows a faculty member their own paper in a journal, linked, and nobody else's", async () => {
    const hrefs = await linksOn(
      "FACULTY",
      <Routes>
        <Route path="/journals/:title" element={<JournalRecord />} />
      </Routes>,
      { "/api/journals/report": () => FACULTY_JOURNAL },
      "/journals/Journal%20of%20Tests"
    )
    expect(hrefs).toContain("/papers/c-mine")
    expect(hrefs.some((h) => h.startsWith("/people/"))).toBe(false)
  })
})
