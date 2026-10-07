import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Coordination } from "@/pages/coordination"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

const COORD: Me = { id: "u-coord", email: "coord@example.edu", name: "Meera Coordinator", role: "RESEARCH_COORDINATOR", department: null }

const OVERVIEW = {
  sla_days: 14,
  desk_open: 3,
  unassigned: 2,
  held: 0,
  reviewers: [{ user_id: "u-cell", name: "Ravi Cell", role_label: "Research office", open: 1, cleared_this_week: 2, decided_this_week: 2, median_days: 3.5 }],
  throughput: [{ week_start: "2026-09-21", received: 4, decided: 2, cleared: 2 }],
  ageing: [
    { bucket: "a week or less", count: 1, breach: false },
    { bucket: "over 30 days", count: 2, breach: true },
  ],
  breaches: { count: 2, oldest_days: 91, rows: [] },
  stages: [{ key: "research", label: "With the research office", count: 3, over_sla: 2, oldest_days: 91, on_hold: 0 }],
}

const ROWS = [
  { id: "c1", ticket_number: "ERP-RAW-3", origin: "Imported from the ERP, Raw data sheet", paper_title: "A paper", owner_id: "u1", owner_name: "Dr Anand K", owner_department: "ECE", waiting_days: 91, on_hold: false, assigned_to: null },
  { id: "c2", ticket_number: "FP-2026-000002", origin: null, paper_title: "Another paper", owner_id: "u2", owner_name: "Dr Bina M", owner_department: "CSE", waiting_days: 3, on_hold: false, assigned_to: null },
]

function mount(route = "/", me: Me = COORD) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({ // eslint-disable-line
      "/api/auth/me": () => me,
      "/api/coordination/overview": () => OVERVIEW,
      "/api/coordination/claims": (p) => ({ total: ROWS.length, results: p.includes("scope=breach") ? [ROWS[0]] : ROWS }),
      "/api/coordination/reviewers": () => [{ user_id: "u-cell", name: "Ravi Cell", role_label: "Research office", desks: ["supervisor"] }],
      "/api/coordination/assign": () => ({ assigned: 2, unassigned: 0, skipped: [], claim_ids: ["c1", "c2"], assignee: { user_id: "u-cell", name: "Ravi Cell" } }),
      "/api/admin/clearing-report": () => ({
        month: "2026-09", received: 9, cleared: 4, sent_back: 1, not_accepted: 0, amount_cleared: 12000, median_days: 3.5, within_week: 4, decided: 5, waiting_now: 3,
        by_person: [{ name: "Ravi Cell", cleared: 4, sent_back: 1, not_accepted: 0 }],
        ageing: [{ bucket: "a week or less", count: 1 }, { bucket: "over 30 days", count: 2 }],
      }),
      "/api/coordination/research": () => ({ fyp: { teams: 0, claimed: 0, academic_years: [], mentors_unmatched: 0, departments: [] }, watch: { count: 1 } }),
      "/api/research-faculty": () => ({ year: "2026-27", count: 0, unset_count: 0, old_rule_count: 0, rows: [] }),
    })
  )
  renderWithProviders(<Coordination />, { route })
}

describe("coordination, desk", () => {
  it("answers first, each figure a link to the list behind it", async () => {
    mount()
    expect(await screen.findByRole("link", { name: "2 Not given to anyone" })).toHaveAttribute("href", "/coordination?scope=unassigned#assign")
    expect(screen.getByRole("link", { name: "2 Waiting over 14 days, oldest 91 days" })).toHaveAttribute("href", "/coordination?scope=breach#assign")
    expect(screen.getByRole("link", { name: "3 Waiting at the research office" })).toHaveAttribute("href", "/clearing")
  })

  it("opens the list a figure pointed at, and names the count on the button", async () => {
    const user = userEvent.setup()
    mount("/?scope=breach")
    await screen.findByText("ERP-RAW-3")
    // Only the claims past the limit for that scope.
    expect(screen.queryByText("FP-2026-000002")).toBeNull()
    expect(screen.getByRole("button", { name: "Assign chosen claims" })).toBeDisabled()
    await user.click(screen.getByLabelText("Choose ERP-RAW-3"))
    expect(screen.getByRole("button", { name: "Take back 1 claim" })).toBeEnabled()
  })

  it("assigns the chosen claims with the same verb in the button and the message", async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByText("ERP-RAW-3")
    await user.click(screen.getByLabelText("Choose all shown"))
    await user.click(screen.getByRole("button", { name: "Give the chosen claims to" }))
    await user.click(await screen.findByRole("option", { name: /Ravi Cell/ }))
    const go = screen.getByRole("button", { name: "Assign 2 claims to Ravi Cell" })
    await user.click(go)
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([p]) => p === "/api/coordination/assign")
      expect(call?.[1]).toMatchObject({ method: "POST", json: { claim_ids: ["c1", "c2"], assignee_id: "u-cell" } })
    })
  })

  it("explains an imported claim number", async () => {
    mount()
    const no = await screen.findByText("ERP-RAW-3")
    expect(no).toHaveAttribute("title", "Imported from the ERP, Raw data sheet")
    expect(screen.getByText(/were brought across from the old ERP workbook/)).toBeInTheDocument()
  })

  it("is closed to Finance", async () => {
    mount("/", FINANCE)
    expect(await screen.findByText("Not open to this account")).toBeInTheDocument()
  })
})

describe("coordination, other tabs", () => {
  it("shows the month as figures, one sentence and two tables", async () => {
    mount("/?tab=report")
    expect(await screen.findByRole("group", { name: "At a glance" })).toBeInTheDocument()
    expect(await screen.findByText(/In September 2026, 9 claims came in and 4 were cleared/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Download CSV/ })).toHaveAttribute("href", "/api/admin/clearing-report?month=" + new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0") + "&format=csv")
    const who = screen.getByRole("table", { name: "Decisions by person" })
    expect(within(who).getByText("Ravi Cell")).toBeInTheDocument()
  })

  it("keeps the journal watch-list on Journals and links to it", async () => {
    mount("/?tab=research")
    expect(await screen.findByRole("link", { name: "Open Journals" })).toHaveAttribute("href", "/journals")
    expect(screen.getByText("1 journal is being watched.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open the research faculty list" })).toHaveAttribute("href", "/research-faculty")
    expect(screen.getByText(/No one is marked as research faculty yet/)).toBeInTheDocument()
  })
})
