import { screen, within } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { TeamDetailPage } from "@/pages/team-detail"
import { fileClaimPath, type TeamDetail } from "@/pages/teams-types"
import { fakeApi, failing, renderWithProviders, FACULTY } from "@/test/harness"

const OFFICE: Me = { id: "u-office", email: "o@example.edu", name: "Office", role: "RESEARCH_CELL", department: null }

function detail(over: Partial<TeamDetail> = {}): TeamDetail {
  return {
    id: "t1",
    code: "ZZ26CS0001",
    academic_year: "2025-26",
    department: "CSE",
    mentor: { id: FACULTY.id, name: "Dr Asha Menon", staff_id: "T001", initials: "AM", photo_url: null },
    students: [
      { reg_no: "900000000001", name: "Asha Test", programme: null, year_of_study: null },
      { reg_no: "900000000002", name: "Bala Test", programme: null, year_of_study: null },
    ],
    student_count: 2,
    project_title: "Alpha routing",
    publications_count: 1,
    publications: [
      {
        article_title: "Routing for tiny networks",
        source_title: "A Synthetic Conference",
        doi: "10.9999/alpha.1",
        scopus_link: "https://www.scopus.com/record/display.uri?eid=2-s2.0-000",
        article_link: null,
        publication_date: "2026-03-01",
      },
    ],
    claim: null,
    claims: [],
    mine: true,
    can_file: true,
    cannot_file_because: null,
    ...over,
  }
}

function mount(me: Me, team: TeamDetail | Error) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/teams/": () => {
        if (team instanceof Error) throw team
        return team
      },
    })
  )
  renderWithProviders(
    <Routes>
      <Route path="/teams/:code" element={<TeamDetailPage />} />
      <Route path="/teams" element={<p>The list</p>} />
    </Routes>,
    { route: "/teams/ZZ26CS0001" }
  )
}

describe("one team", { timeout: 20_000 }, () => {
  it("shows the students with their register numbers", async () => {
    mount(FACULTY, detail())
    expect(await screen.findByRole("heading", { level: 1, name: "Team ZZ26CS0001" })).toBeInTheDocument()
    expect(screen.getByText("Alpha routing")).toBeInTheDocument()
    const students = screen.getByRole("table", { name: "Students on this team" })
    expect(within(students).getByText("900000000001")).toBeInTheDocument()
    expect(within(students).getByText("Bala Test")).toBeInTheDocument()
    expect(screen.getByText("Dr Asha Menon")).toBeInTheDocument()
  })

  it("lists the papers with a DOI link and a Scopus link", async () => {
    mount(FACULTY, detail())
    const papers = await screen.findByRole("table", { name: "Papers of team ZZ26CS0001" })
    expect(within(papers).getByText("Routing for tiny networks")).toBeInTheDocument()
    expect(within(papers).getByText("A Synthetic Conference")).toBeInTheDocument()
    expect(within(papers).getByRole("link", { name: /10\.9999\/alpha\.1/ })).toHaveAttribute("href", "https://doi.org/10.9999/alpha.1")
    expect(within(papers).getByRole("link", { name: /Open in Scopus/ })).toHaveAttribute(
      "href",
      "https://www.scopus.com/record/display.uri?eid=2-s2.0-000"
    )
    expect(within(papers).getByText(/1 Mar 2026/)).toBeInTheDocument()
  })

  it("offers the mentor the one primary action, which opens File a paper with the team chosen", async () => {
    mount(FACULTY, detail())
    const button = await screen.findByRole("link", { name: "File the student-project claim" })
    expect(button).toHaveAttribute("href", fileClaimPath("ZZ26CS0001"))
    expect(button).toHaveAttribute("href", "/papers/new?reason=STUDENT_PROJECT&team=ZZ26CS0001")
    expect(screen.getAllByRole("link", { name: "File the student-project claim" })).toHaveLength(1)
  })

  it("does not offer it once the team is claimed, and says why", async () => {
    mount(
      FACULTY,
      detail({
        can_file: false,
        cannot_file_because: "Team ZZ26CS0001 is already claimed.",
        claim: { id: "c1", ticket_number: "FP-2026-000101", status: "SUBMITTED", stage: "Under review", url: "/papers/c1" },
        claims: [
          {
            id: "c1", ticket_number: "FP-2026-000101", status: "SUBMITTED", stage: "Under review", url: "/papers/c1",
            holds_team: true, owner_name: "Dr Asha Menon", submitted_at: "2026-10-01T10:00:00Z", paper_title: "Routing for tiny networks",
          },
        ],
      })
    )
    await screen.findByRole("heading", { level: 1, name: "Team ZZ26CS0001" })
    expect(screen.queryByRole("link", { name: "File the student-project claim" })).toBeNull()
    expect(screen.getByText("Team ZZ26CS0001 is already claimed.")).toBeInTheDocument()
    const claims = screen.getByRole("table", { name: "Claims on team ZZ26CS0001" })
    expect(within(claims).getByRole("link", { name: /FP-2026-000101/ })).toHaveAttribute("href", "/papers/c1")
    expect(within(claims).getByText("Holds the team")).toBeInTheDocument()
  })

  it("does not offer it to somebody who is not the mentor", async () => {
    mount(OFFICE, detail({ mine: false, can_file: false, cannot_file_because: "Only the team's mentor, Dr Asha Menon, files its claim." }))
    await screen.findByRole("heading", { level: 1, name: "Team ZZ26CS0001" })
    expect(screen.queryByRole("link", { name: "File the student-project claim" })).toBeNull()
    // The reason is for the mentor; the office just reads the page.
    expect(screen.queryByText(/files its claim/)).toBeNull()
  })

  it("says plainly when a team has no students, no papers and no claim", async () => {
    mount(FACULTY, detail({ students: [], student_count: 0, publications: [], publications_count: 0 }))
    expect(await screen.findByText("No students are listed on this team.")).toBeInTheDocument()
    expect(screen.getByText("The roster lists no paper for this team yet.")).toBeInTheDocument()
    expect(screen.getByText(/No claim has been filed on this team/)).toBeInTheDocument()
  })

  it("shows an amount in the claim history only when the server sent one", async () => {
    const row = {
      id: "c1", ticket_number: "FP-2026-000101", status: "PAID", stage: "Paid", url: "/review/c1",
      holds_team: true, owner_name: "Dr Asha Menon", submitted_at: null, paper_title: "A paper",
    }
    mount(OFFICE, detail({ mine: false, can_file: false, claims: [{ ...row, amount: 15000 }] }))
    const claims = await screen.findByRole("table", { name: "Claims on team ZZ26CS0001" })
    expect(within(claims).getByText("₹15,000")).toBeInTheDocument()
  })

  it("shows no money to a head, whose payload has none", async () => {
    const row = {
      id: "c1", ticket_number: "FP-2026-000101", status: "Completed", stage: "Completed", url: "/papers/c1",
      holds_team: true, owner_name: "Dr Asha Menon", submitted_at: null, paper_title: "A paper",
    }
    mount({ ...OFFICE, role: "HOD" }, detail({ mine: false, can_file: false, claims: [row] }))
    await screen.findByRole("table", { name: "Claims on team ZZ26CS0001" })
    expect(screen.queryByText(/₹/)).toBeNull()
    expect(screen.queryByRole("columnheader", { name: "Amount" })).toBeNull()
  })

  it("answers a team the reader may not see as no such team", async () => {
    const { ApiError } = await import("@/lib/api")
    mount(FACULTY, new ApiError(404, "No team with the code 'ZZ26CS0001'."))
    expect(await screen.findByText("No such team")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Back to the teams" })).toHaveAttribute("href", "/teams")
  })

  it("says the server did not answer", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, "/api/teams/": failing(500) }))
    renderWithProviders(
      <Routes>
        <Route path="/teams/:code" element={<TeamDetailPage />} />
      </Routes>,
      { route: "/teams/ZZ26CS0001" }
    )
    expect(await screen.findByText("Could not load this team")).toBeInTheDocument()
  })
})
