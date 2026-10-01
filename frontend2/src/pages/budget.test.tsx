import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Budget } from "@/pages/budget"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const slice = (department: string | null, allocated: number | null, spent: number, committed = 0) => ({
  department, allocated, spent, committed,
  remaining: allocated === null ? null : allocated - spent - committed,
  used_fraction: allocated ? (spent + committed) / allocated : null,
  budget_id: allocated === null ? null : `b-${department ?? "college"}`,
  note: null,
})

describe("the budget", () => {
  it("says 'Not set' rather than zero when nothing is allocated, and never over-claims", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/statements/burn": () => ({ months: [] }),
        "/api/admin/audit": () => ({ total: 0, results: [] }),
        "/api/budgets": () => ({
          financial_year: "2026-27",
          starts: "2026-04-01",
          ends: "2027-03-31",
          years_on_record: ["2026-27"],
          college: slice(null, null, 2302959),
          departments: [slice("ECE", null, 548061)],
        }),
      })
    )
    renderWithProviders(<Budget />, { route: "/budget" })
    expect((await screen.findAllByText("Not set")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("₹23,02,959").length).toBeGreaterThan(0)
    expect(screen.getByText(/It shows only what it has spent and what it owes/)).toBeTruthy()
  })
})
