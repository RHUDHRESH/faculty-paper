import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn(), apiFile: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Teams } from "@/pages/teams"
import type { TeamRow, TeamsPayload } from "@/pages/teams-types"
import { fakeApi, renderWithProviders, FACULTY, HOD } from "@/test/harness"

const OFFICE: Me = { id: "u-office", email: "o@example.edu", name: "Office", role: "RESEARCH_CELL", department: null }

beforeEach(() => {
  window.localStorage.clear()
})

function team(over: Partial<TeamRow> = {}): TeamRow {
  return {
    id: "t1",
    code: "ZZ26CS0001",
    academic_year: "2025-26",
    department: "CSE",
    mentor: { id: "u-m1", name: "Dr Mentor One", staff_id: "T001", initials: "MO", photo_url: null },
    students: [
      { reg_no: "900000000001", name: "Asha Test" },
      { reg_no: "900000000002", name: "Bala Test" },
    ],
    student_count: 2,
    project_title: "Alpha routing",
    publications_count: 1,
    claim: null,
    mine: false,
    ...over,
  }
}

function payload(rows: TeamRow[], over: Partial<TeamsPayload> = {}): TeamsPayload {
  return {
    results: rows,
    total: rows.length,
    limit: 30,
    offset: 0,
    counts: { teams: rows.length, students: 7, with_publication: 3, claimed: 2 },
    years: ["2025-26", "2024-25"],
    departments: ["CSE", "ECE"],
    scope: "college",
    money: true,
    ...over,
  }
}

function mount(me: Me, data: TeamsPayload, route = "/teams") {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => me, "/api/teams?": () => data }))
  renderWithProviders(
    <Routes>
      <Route path="/teams" element={<Teams />} />
    </Routes>,
    { route }
  )
}

const listCalls = () => vi.mocked(api).mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith("/api/teams?"))

describe("the student teams page", { timeout: 20_000 }, () => {
  it("titles itself, says what it is for in one sentence and shows the four figures", async () => {
    mount(OFFICE, payload([team()]))
    expect(await screen.findByRole("heading", { level: 1, name: "Student teams" })).toBeInTheDocument()
    expect(screen.getByText(/Every final-year project team/)).toBeInTheDocument()
    const glance = screen.getByRole("group", { name: "At a glance" })
    expect(glance).toHaveTextContent("1 Teams")
    expect(glance).toHaveTextContent("7 Students")
    expect(glance).toHaveTextContent("3 Teams with a paper")
    expect(glance).toHaveTextContent("2 Teams claimed")
  })

  it("draws one table: team number, department, mentor, students, project, papers, claim", async () => {
    mount(OFFICE, payload([team()]))
    const table = await screen.findByRole("table", { name: "Student teams" })
    const heads = within(table).getAllByRole("columnheader").map((th) => th.textContent)
    expect(heads).toEqual(["Team number", "Department", "Mentor", "Students", "Project", "Papers", "Claim"])
    const row = within(table).getAllByRole("row")[1]
    expect(within(row).getByRole("link", { name: "ZZ26CS0001" })).toHaveAttribute("href", "/teams/ZZ26CS0001")
    expect(within(row).getByText("Dr Mentor One")).toBeInTheDocument()
    expect(within(row).getByText("Alpha routing")).toBeInTheDocument()
    expect(within(row).getByText("Not claimed")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument()
  })

  it("keeps the student names a press away, with the register numbers", async () => {
    const user = userEvent.setup()
    mount(OFFICE, payload([team()]))
    await screen.findByRole("table", { name: "Student teams" })
    expect(screen.queryByText("Bala Test")).toBeNull()
    await user.click(screen.getByRole("button", { name: /2 students/ }))
    expect(screen.getByText("Bala Test")).toBeInTheDocument()
    expect(screen.getByText(/900000000002/)).toBeInTheDocument()
  })

  it("links a claimed team to its claim and says where it stands", async () => {
    mount(
      OFFICE,
      payload([
        team({
          claim: { id: "c1", ticket_number: "FP-2026-000101", status: "SUBMITTED", stage: "Submitted", url: "/review/c1?queue=filed", amount: 15000 },
        }),
      ])
    )
    const table = await screen.findByRole("table", { name: "Student teams" })
    const link = within(table).getByRole("link", { name: /Open claim FP-2026-000101/ })
    expect(link).toHaveAttribute("href", "/review/c1?queue=filed")
    expect(within(table).getByText("Submitted")).toBeInTheDocument()
  })

  it("sends the search, the year, the department and the status to the server", async () => {
    const user = userEvent.setup()
    mount(OFFICE, payload([team()]), "/teams?year=2025-26&department=CSE&status=claimed&q=900000000001")
    await screen.findByRole("table", { name: "Student teams" })
    const qs = new URLSearchParams(listCalls().at(-1)!.split("?")[1])
    expect(qs.get("academic_year")).toBe("2025-26")
    expect(qs.get("department")).toBe("CSE")
    expect(qs.get("status")).toBe("claimed")
    expect(qs.get("q")).toBe("900000000001")
    const box = screen.getByRole("textbox", { name: "Search teams" })
    expect(box).toHaveValue("900000000001")
    // Typing searches after a pause.
    await user.clear(box)
    await user.type(box, "ZZ26")
    await waitFor(() => expect(new URLSearchParams(listCalls().at(-1)!.split("?")[1]).get("q")).toBe("ZZ26"))
  })

  it("asks for a team number, a register number or a name", async () => {
    mount(OFFICE, payload([team()]))
    expect(await screen.findByPlaceholderText("Team number, register number or name")).toBeInTheDocument()
  })

  it("is My teams for somebody who mentors teams, with no mentor or department column", async () => {
    mount(FACULTY, payload([team({ mine: true })], { scope: "mine", departments: ["CSE"], years: ["2025-26"] }))
    expect(await screen.findByRole("heading", { level: 1, name: "My teams" })).toBeInTheDocument()
    const table = await screen.findByRole("table", { name: "My teams" })
    const heads = within(table).getAllByRole("columnheader").map((th) => th.textContent)
    expect(heads).not.toContain("Mentor")
    expect(heads).not.toContain("Department")
    expect(screen.queryByRole("combobox", { name: "Filter by department" })).toBeNull()
  })

  it("gives a head their department's teams, with no money anywhere", async () => {
    mount(
      HOD,
      payload([team({ claim: { id: "c1", ticket_number: "FP-2026-000101", status: "Completed", stage: "Completed", url: "/papers/c1" } })], {
        scope: "department",
        money: false,
      })
    )
    expect(await screen.findByRole("heading", { level: 1, name: "Student teams" })).toBeInTheDocument()
    expect(screen.getByText(/in your department/)).toBeInTheDocument()
    expect(screen.queryByText(/₹/)).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Filter by department" })).toBeNull()
  })

  it("says so when a search finds nothing, and clears it", async () => {
    const user = userEvent.setup()
    mount(OFFICE, payload([]), "/teams?q=nobody")
    expect(await screen.findByText("No team matches")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Search teams" })).toHaveValue(""))
  })

  it("tells a mentor with no team how to get one", async () => {
    mount(FACULTY, payload([], { scope: "mine", counts: { teams: 0, students: 0, with_publication: 0, claimed: 0 } }))
    expect(await screen.findByText("You mentor no team on the roster")).toBeInTheDocument()
  })

  it("says the server did not answer, and offers another try", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => OFFICE,
        "/api/teams?": () => {
          throw new Error("down")
        },
      })
    )
    renderWithProviders(<Teams />, { route: "/teams" })
    expect(await screen.findByText("Could not load the teams")).toBeInTheDocument()
  })
})
