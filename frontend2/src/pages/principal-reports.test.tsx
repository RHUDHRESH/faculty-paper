import { fireEvent, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { YearBrief } from "@/pages/brief"
import { DepartmentPage } from "@/pages/departments"
import { PrincipalReportsHub } from "@/pages/principal-reports-hub"
import { ReportPapers } from "@/pages/report-papers"
import { fakeApi, renderWithProviders } from "@/test/harness"
import { Route, Routes } from "react-router-dom"

/**
 * The Principal's report pages (docs/jtbd/principal.md). What must hold:
 * every figure is a link to the list it counts, the base of a percentage is
 * said beside it, and what is not ready for the council is named.
 */

const PRINCIPAL: Me = { id: "u-p", email: "p@example.edu", name: "Dr Rao", role: "PRINCIPAL", department: null }

const dept = (over: Record<string, unknown>) => ({
  department: "CSE",
  teachers: 10,
  papers: 40,
  papers_prev: 30,
  change: 33.3,
  per_teacher: 4,
  five_year: 100,
  five_year_per_teacher: 10,
  paid: 100000,
  budget: null,
  cost_per_paper: 2500,
  ...over,
})

const BRIEF = {
  year: 2025,
  partial: false,
  financial_year: "2025-26",
  years_available: [2026, 2025, 2024],
  headline: "In 2025 the college published 1,586 papers, up 13.8% on 2024.",
  totals: {
    papers: 1586,
    papers_prev: 1394,
    change: 13.8,
    teachers: 410,
    per_teacher: 3.87,
    per_teacher_prev: 3.4,
    top_quartile_share: 57,
    top_quartile_share_prev: 49,
    quartile_known: 449,
    paid: 12865956,
    paid_prev: 10178432,
    budget: null,
    budget_used: null,
    cost_per_paper: 8112,
  },
  trend: [2021, 2022, 2023, 2024, 2025].map((year) => ({
    year, papers: 100 * (year - 2020), per_teacher: 1, top_quartile_share: 50, quartile_known: 10,
    financial_year: `${year}-${String(year + 1).slice(2)}`, paid: 100000, budget: null,
  })),
  departments: [dept({}), dept({ department: "TRAINING", teachers: 10, papers: 2, papers_prev: 0, change: null, per_teacher: 0.2 })],
  push: [{ ...dept({ department: "TRAINING", papers: 2, papers_prev: 0, change: null, per_teacher: 0.2 }), reasons: ["0.2 per teacher, under half the college's 3.87"] }],
  rising: [dept({ department: "MBA", change: 75.3 })],
  pack: [
    { key: "budget", label: "A budget is set for FY 2025-26", ok: false, detail: "No budget is set.", to: "/budget" },
    { key: "partial", label: "2025 is a full year", ok: true, detail: "2025 is complete.", to: null },
  ],
  naac_331: { from: 2021, to: 2025, papers: 4988, teachers: 410, per_teacher: 12.17, band: 4 },
  unassigned_papers: 208,
  notes: ["Teachers: today's roll."],
}

function mount(ui: React.ReactElement, route: string, extra: Record<string, () => unknown> = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) =>
    fakeApi({
      "/api/auth/me": () => PRINCIPAL,
      "/api/reports/brief": () => BRIEF,
      "/api/meta/departments": () => ["CSE", "TRAINING"],
      ...extra,
    })(path, ...(rest as [])))
  renderWithProviders(ui, { route })
}

describe("the year brief", () => {
  it("makes every figure a link to the papers it counts, and states the base of the quartile share", async () => {
    mount(<YearBrief />, "/reports/brief")
    const sheet = await screen.findByRole("article")
    const papers = within(sheet).getByRole("link", { name: "1,586" })
    expect(papers).toHaveAttribute("href", "/reports/papers?year=2025")
    const quartile = within(sheet).getByRole("link", { name: "57%" })
    expect(quartile).toHaveAttribute("href", "/reports/papers?year=2025&quartile=top")
    // The base is said in the row, not left for the council to ask.
    expect(within(sheet).getByText(/of the 449 papers with a quartile recorded/)).toBeInTheDocument()
  })

  it("sets the finding as the biggest sentence and draws a running year hollow, never as a fall", async () => {
    mount(<YearBrief />, "/reports/brief", {
      "/api/reports/brief": () => ({
        ...BRIEF,
        finding: "In 2025 the college published 1,586 papers, up 13.8% on 2024.",
        context: "3.87 papers per teacher across 410 teachers.",
        detail: "It paid ₹1,28,65,956.",
        running: { year: 2026, papers: 1126, per_teacher: 2.74, financial_year: "2026-27", paid: 2302959, as_of: "2026-10-01" },
      }),
    })
    expect(await screen.findByRole("status")).toHaveTextContent("1,586 papers, up 13.8% on 2024")
    const chart = screen.getAllByRole("img", { name: /Papers published/ })[0]
    expect(chart).toHaveAccessibleName(/2026 1,126 to date/)
    expect(screen.getByText(/2026 is to date: 1,126 papers/)).toBeInTheDocument()
  })

  it("names what is not ready for the council and the department to call about", async () => {
    mount(<YearBrief />, "/reports/brief")
    // What is left to settle is one step away, with its count on the door.
    fireEvent.click(await screen.findByRole("button", { name: /things to settle before it goes/ }))
    expect(await screen.findByText("A budget is set for FY 2025-26")).toBeInTheDocument()
    expect(screen.getByText("To settle")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open the budget" })).toHaveAttribute("href", "/budget")
    const push = screen.getAllByRole("link", { name: "TRAINING" })[0]
    expect(push).toHaveAttribute("href", "/reports/departments/TRAINING?year=2025")
  })

  it("offers the council pack for the year on screen", async () => {
    mount(<YearBrief />, "/reports/brief")
    await screen.findByText(/13.8% on 2024/)
    const pdf = screen.getByRole("link", { name: /Download the council pack/ })
    expect(pdf).toHaveAttribute("href", "/api/reports/brief/export?fmt=pdf&year=2025")
  })
})

describe("the reports hub", () => {
  it("asks her questions and answers each in a sentence", async () => {
    mount(<PrincipalReportsHub />, "/reports/all", { "/api/reports/papers": () => ({ total: 8466 }) })
    expect(await screen.findByText("Are we better than last year, and where?")).toBeInTheDocument()
    expect(await screen.findByText(/1 to settle first: no budget set/)).toBeInTheDocument()
    expect(screen.getByText(/8,466 papers on record/)).toBeInTheDocument()
  })
})

describe("the list behind a figure", () => {
  it("asks the server for exactly the filter in the address", async () => {
    mount(<ReportPapers />, "/reports/papers?year=2025&department=CSE&quartile=top", {
      "/api/reports/papers": () => ({
        total: 1,
        by_quartile: {},
        results: [
          {
            id: "p1", source: "record", title: "A paper on struts", journal: "Acta", year: 2025, quartile: "Q1",
            doi: null, departments: ["CSE"], authors: [{ user_id: "u1", name: "A Kumar", department: "CSE" }],
            claim_id: null, claim_no: null,
          },
        ],
      }),
    })
    expect(await screen.findByText("1 papers")).toBeInTheDocument()
    const call = vi.mocked(api).mock.calls.map((c) => String(c[0])).find((p) => p.startsWith("/api/reports/papers"))
    expect(call).toContain("year=2025")
    expect(call).toContain("department=CSE")
    expect(call).toContain("quartile=top")
    expect((await screen.findAllByText("A paper on struts")).length).toBeGreaterThan(0)
  })
})

describe("the Principal's home", () => {
  it("leads with what waits for her, then the year and the departments to call", async () => {
    const { PrincipalHome } = await import("@/pages/home-principal")
    mount(<PrincipalHome />, "/", {
      "/api/principal/queue": () => ({
        total: 2,
        results: [
          { id: "c1", ticket_number: "FP-2026-000001", paper_title: "Grain boundaries", journal_title: "Acta", owner_name: "A Kumar", owner_id: "u1", owner_department: "CSE", status: "CLEARED", remuneration: 20000, updated_at: null, waiting_days: 45 },
        ],
        totals: { count: 2, amount: 52000, longest_wait_days: 45 },
      }),
      "/api/track": () => ({ stages: [], results: [], total: 0, total_claims: 0, departments: [], months: [], scope: "college", department: null, sees_money: true, sees_flags: true }),
      "/api/claims": () => ({ results: [], total: 0 }),
      "/api/claims/counts": () => ({ counts: {} }),
      "/api/me/payments": () => ({ results: [], total: 0 }),
    })
    // The answer is one sentence, the biggest thing on the page.
    expect(await screen.findByText(/2 claims, ₹52,000, are waiting for you/)).toBeInTheDocument()
    expect(screen.getByText(/The longest has waited/)).toBeInTheDocument()
    // The common action is on the page, and a ready claim approves in place.
    expect(screen.getByRole("button", { name: /Approve the 1 ready/ })).toBeInTheDocument()
    // (one button for a phone, one for a desk; the stylesheet shows the right one)
    expect(screen.getAllByRole("button", { name: /Approve: Grain boundaries/ }).length).toBeGreaterThan(0)
    // The year is in the margin with no click: the finding, the departments to call.
    expect(await screen.findByText("+13.8%")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Training" })).toHaveAttribute("href", "/reports/departments/TRAINING?year=2025")
  })
})

describe("one department", () => {
  it("says who has not published in five years, in words", async () => {
    mount(
      <Routes>
        <Route path="/reports/departments/:name" element={<DepartmentPage />} />
      </Routes>,
      "/reports/departments/CSE",
      {
        "/api/reports/department": () => ({
          department: "CSE", year: 2025, financial_year: "2025-26", partial: false,
          row: dept({}), rank: 3, of: 20,
          college: { per_teacher: 3.87, papers: 1586, top_quartile_share: 57 },
          trend: [2021, 2022, 2023, 2024, 2025].map((y) => ({ year: y, papers: 10, per_teacher: 1 })),
          people: [
            { user_id: "u1", name: "A Kumar", designation: "Professor", head: false, papers: 4, papers_prev: 3, five_year: 12 },
            { user_id: "u2", name: "B Selvi", designation: "Assistant Professor", head: false, papers: 0, papers_prev: 0, five_year: 0 },
          ],
          silent: 1, journals: [{ journal: "Acta", papers: 4 }], quartiles: { Q1: 2, none: 5 }, years_available: [2025],
        }),
      }
    )
    expect(await screen.findByText(/1 of 10 teachers has no paper on record in five years/)).toBeInTheDocument()
    expect(screen.getByText("No paper in five years")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "A Kumar" })).toHaveAttribute("href", "/faculty/u1")
  })
})
