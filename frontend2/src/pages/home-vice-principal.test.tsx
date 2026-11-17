import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { VicePrincipalHome } from "@/pages/home-vice-principal"
import { fakeApi, renderWithProviders } from "@/test/harness"

const VP: Me = { id: "u-vp", email: "vp@example.edu", name: "Dr Vimala Rao", role: "VICE_PRINCIPAL", department: "Physics" }

const row = (rank: number, name: string, value: number) => ({
  rank, user_id: `id-${rank}`, staff_id: `S${rank}`, name, department: "Physics", photo: null, photo_url: null, initials: "AQ", value,
})

const BRIEF = {
  year: 2026,
  partial: false,
  totals: { papers: 120, papers_prev: 100, change: 20, per_teacher: 1.2, per_teacher_prev: 1 },
  push: [{ department: "Chemistry", reasons: ["Fewer papers than last year"], head: null }],
  pack: [],
}

function mount() {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => VP,
      "/api/reports/brief": () => BRIEF,
      "/api/dashboard/top5": () => ({
        period: "all", label: "All time", department: null, generated_at: "2026-11-17T09:00:00Z",
        snip: [row(1, "Asha Quiet", 12.5)],
        remuneration: [row(1, "Ravi Steady", 1234567)],
        count: [row(1, "Asha Quiet", 31)],
      }),
      "/api/track": () => ({
        scope: "college", department: null, sees_money: true, sees_flags: false, total: 4, total_claims: 9, departments: [], months: [], results: [],
        stages: [{ key: "checked", label: "Checked", caption: "", count: 3, oldest_days: 2, average_days: 1, ageing: { week: 0, fortnight: 0, month: 0, older: 1 } }],
      }),
      "/api/claims": () => ({ results: [], total: 0 }),
      "/api/me/payments": () => ({ total: 0, this_year: 0, since: "2026-06-01", count: 0, latest_month: null, rows: [] }),
    })
  )
  renderWithProviders(<VicePrincipalHome />)
}

describe("the Vice principal's Home", () => {
  it("shows the Top 5 board with the incentive paid, and the year's figure", async () => {
    mount()
    const pay = await screen.findByTestId("top5-remuneration")
    expect(within(pay).getByRole("heading", { name: "Incentive paid" })).toBeInTheDocument()
    expect(within(pay).getByText("₹12,34,567")).toBeInTheDocument()
    expect((await screen.findAllByText(/in 2026 against 2025/)).length).toBeGreaterThan(0)
  })

  it("has nothing to approve, send back or pay, and never asks the Principal's queue", async () => {
    mount()
    await screen.findByTestId("top5-remuneration")
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /approvals/i })).toBeNull()
    expect(screen.queryByText(/waiting for you/i)).toBeNull()
    const asked = vi.mocked(api).mock.calls.map((c) => String(c[0]))
    expect(asked.some((p) => p.startsWith("/api/principal/queue"))).toBe(false)
  })

  it("points at the departments to call about and at Track", async () => {
    mount()
    expect(await screen.findByRole("link", { name: "Chemistry" })).toBeInTheDocument()
    expect(screen.getAllByRole("link", { name: /Open Track|claims on their way/ }).length).toBeGreaterThan(0)
  })
})
