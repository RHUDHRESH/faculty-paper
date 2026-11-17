import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { MyTeams } from "@/pages/home-teams"
import type { TeamRow, TeamsPayload } from "@/pages/teams-types"
import { FACULTY, failing, fakeApi, renderWithProviders } from "@/test/harness"

function team(code: string, over: Partial<TeamRow> = {}): TeamRow {
  return {
    id: `t-${code}`,
    code,
    academic_year: "2025-26",
    department: "CSE",
    mentor: { id: FACULTY.id, name: FACULTY.name, staff_id: "T001" },
    students: [{ reg_no: "900000000001", name: "Asha Test" }],
    student_count: 1,
    project_title: `Project ${code}`,
    publications_count: 2,
    claim: null,
    mine: true,
    ...over,
  }
}

function mount(rows: TeamRow[] | "fail", total = rows === "fail" ? 0 : rows.length) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/teams?":
        rows === "fail"
          ? failing(500)
          : () =>
              ({
                results: rows,
                total,
                limit: 5,
                offset: 0,
                counts: { teams: total, students: 0, with_publication: 0, claimed: 0 },
                years: [],
                departments: [],
                scope: "mine",
                money: true,
              }) satisfies TeamsPayload,
    })
  )
  return renderWithProviders(<MyTeams />)
}

describe("My teams on a faculty member's Home", { timeout: 20_000 }, () => {
  it("lists the teams they mentor with the students, the papers and where the claim stands", async () => {
    mount([
      team("ZZ26CS0001", {
        claim: { id: "c1", ticket_number: "FP-2026-000101", status: "SUBMITTED", stage: "Under review", url: "/papers/c1" },
      }),
      team("ZZ26CS0002"),
    ])
    const section = (await screen.findByRole("heading", { name: "My teams" })).closest("section")!
    expect(within(section).getByRole("link", { name: "ZZ26CS0001" })).toHaveAttribute("href", "/teams/ZZ26CS0001")
    expect(within(section).getByText(/Project ZZ26CS0001 · 1 student · 2 papers/)).toBeInTheDocument()
    expect(within(section).getByRole("link", { name: /FP-2026-000101/ })).toHaveAttribute("href", "/papers/c1")
    expect(within(section).getByText("Under review")).toBeInTheDocument()
    expect(within(section).getByRole("link", { name: "Not claimed" })).toHaveAttribute("href", "/teams/ZZ26CS0002")
  })

  it("says how many more there are", async () => {
    mount([team("ZZ26CS0001")], 9)
    expect(await screen.findByRole("link", { name: "See all 9 teams" })).toHaveAttribute("href", "/teams")
  })

  it("draws nothing for somebody who mentors no team", async () => {
    const { container } = mount([])
    await vi.waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it("draws nothing, and no error box, when the request fails", async () => {
    const { container } = mount("fail")
    await vi.waitFor(() => expect(vi.mocked(api)).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
