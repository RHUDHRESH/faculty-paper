import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { OfficeHome } from "@/pages/home-staff"
import { fakeApi, renderWithProviders } from "@/test/harness"

const CELL: Me = { id: "u-cell", email: "cell@example.edu", name: "Priya Cell", role: "RESEARCH_CELL", department: null }
const COORD: Me = { id: "u-coord", email: "coord@example.edu", name: "Ravi Coordinator", role: "RESEARCH_COORDINATOR", department: null }

function row(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    ticket_number: "FP-2026-000010",
    origin: null,
    paper_title: "Grain boundaries in thin copper films",
    journal_title: "Acta Materialia",
    owner_id: "u-x",
    owner_name: "Dr Anand K",
    owner_department: "MECH",
    waiting_days: 20,
    on_hold: false,
    watched_reason: null,
    assigned_to: null,
    ...over,
  }
}

const TODAY = {
  sla_days: 14,
  desk_open: 3,
  mine_count: 1,
  unassigned: 2,
  past_sla: 2,
  held: 0,
  target: { due: 2, past: 2, due_soon: 0, decided_by_me: 1, decided_by_desk: 4 },
  mine: [row({ id: "m1", paper_title: "Mine first", assigned_to: { user_id: "u-cell", name: "Priya Cell" } })],
  rest: [row({ id: "r1", paper_title: "Older one", ticket_number: "ERP-RAW-3", origin: "Imported from the ERP, Raw data sheet", waiting_days: 91, watched_reason: "Clone" })],
  came_back: [
    { ...row({ id: "b1", paper_title: "Fixed one" }), kind: "fixed", since_days: 0, note: "Attach page one.", by_name: null },
    { ...row({ id: "b2", paper_title: "Returned one" }), kind: "returned", since_days: 2, note: "Quartile is Q3.", by_name: "Dr Lakshmi Rao" },
  ],
  came_back_count: 2,
  watched_waiting: 1,
  flags: { open: 5, open_on_paid: 3 },
  month: { month: "2026-09", received: 9, cleared: 4, sent_back: 1, not_accepted: 0, median_days: 3.5, within_week: 4, decided: 5 },
}

function mount(me: Me, today: unknown = TODAY) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) =>
    fakeApi({
      "/api/auth/me": () => me,
      "/api/cell/today": () => today,
      "/api/coordination/overview": () => ({ reviewers: [{ user_id: "u-cell", name: "Priya Cell", role_label: "Research office", open: 1, cleared_this_week: 2 }] }),
      "/api/track": () => ({ stages: [], results: [] }),
      "/api/admin/faults": () => ({ total: 0 }),
      "/api/admin/profile-requests": () => ({ pending: 0 }),
      "/api/admin/duplicate-findings": () => ({ summary: { open: 0 } }),
      "/api/admin/clearing-queue": () => [],
      "/api/claims": () => ({ results: [], total: 0 }),
      "/api/me/payments": () => ({ payments: [], total: 0 }),
    })(path, ...(rest as []))
  )
  renderWithProviders(<OfficeHome />)
}

describe("the first desk's home", () => {
  it("answers first: what is given to me, what is late, what came back", async () => {
    mount(CELL)
    await waitFor(() => expect(screen.getAllByRole("status").map((e) => e.textContent).join(" ")).toMatch(/2 claims are.past 14 days/))
    const given = screen.getByRole("link", { name: /1 is given to you/ })
    expect(given).toHaveAttribute("href", "/clearing?assigned=me")
    expect(screen.getAllByRole("link", { name: "Open the queue (3)" }).length).toBeGreaterThan(0)
    // The coordinator's own figure is not on the cell's home.
    expect(screen.queryByText(/not given to anyone/)).toBeNull()
  })

  it("puts my claims before the oldest and opens the review page", async () => {
    mount(CELL)
    const mine = await screen.findByRole("link", { name: /Review: Mine first/ })
    expect(mine).toHaveAttribute("href", "/review/m1?queue=clearing")
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)
    expect(headings.indexOf("Given to you")).toBeLessThan(headings.indexOf("Oldest waiting, not given to you"))
  })

  it("says what today's target is and how much is done", async () => {
    mount(CELL)
    const status = (await screen.findByText(/Today.s target/)).closest("p")!
    expect(status).toHaveTextContent("decide 2 claims that are past 14 days or reach it today")
    expect(status).toHaveTextContent("You have decided 1 today, the desk 4. Target met.")
  })

  it("separates what came back, saying who and why", async () => {
    mount(CELL)
    const fixed = await screen.findByText("Fixed by the claimant")
    const region = fixed.closest("section")!
    expect(within(region).getByText("Fixed by the claimant")).toBeInTheDocument()
    expect(within(region).getByText("Returned by Dr Lakshmi Rao")).toBeInTheDocument()
    expect(within(region).getByText(/Quartile is Q3/)).toBeInTheDocument()
  })

  it("explains an imported claim number and marks a watched journal", async () => {
    mount(CELL)
    const no = await screen.findByText("ERP-RAW-3")
    expect(no).toHaveAttribute("title", "Imported from the ERP, Raw data sheet")
    expect(screen.getByText(/were brought across from the old ERP workbook/)).toBeInTheDocument()
    expect(screen.getByText("Watched journal")).toBeInTheDocument()
  })

  it("gives the coordinator the un-given count and who holds what", async () => {
    mount(COORD)
    expect(await screen.findByRole("link", { name: /2 are not given to anyone/ })).toHaveAttribute("href", "/coordination")
    expect(await screen.findByText("Who holds what")).toBeInTheDocument()
  })

  it("greets a placeholder office seat by the time of day and hides its own papers", async () => {
    mount({ ...COORD, email: "coord@saveetha.local", name: "Research Coordinator (local)", placeholder: true })
    expect(await screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening)$/ })).toBeInTheDocument()
    await screen.findByText("Who holds what")
    expect(screen.queryByText(/Hello/)).toBeNull()
    expect(screen.queryByRole("region", { name: "Your own papers" })).toBeNull()
  })

  it("greets a real coordinator by name and keeps their own papers", async () => {
    mount(COORD)
    expect(await screen.findByRole("heading", { level: 1, name: "Hello, Ravi" })).toBeInTheDocument()
    expect(await screen.findByRole("region", { name: "Your own papers" })).toBeInTheDocument()
  })

  it("says so when nothing is waiting", async () => {
    mount(CELL, { ...TODAY, desk_open: 0, mine_count: 0, past_sla: 0, mine: [], rest: [], came_back: [], came_back_count: 0 })
    expect(await screen.findByText(/Nothing is waiting. The desk is clear./)).toBeInTheDocument()
    expect(screen.getByText(/Nothing has come back/)).toBeInTheDocument()
  })
})
