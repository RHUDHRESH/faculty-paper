import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { Budget } from "@/pages/budget"
import { Ledger } from "@/pages/ledger"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

const DIRECTOR: Me = { ...FINANCE, id: "u-dir", role: "DIRECTOR", name: "Dr Rao" }

describe("the ledger as Finance reads it", () => {
  it("shows what the research threshold held back beside the payment", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/meta/departments": () => ["AIDS"],
        "/api/admin/ledger": () => ({
          total: 1, limit: 50, offset: 0, total_amount: 7600, people: 1, payments: 1,
          results: [{
            id: "l1", claim_id: "c1", payout_month: "2026-09", department: "AIDS", faculty_name: "Dr Revathi", staff_id: "S1",
            biometric_id: null, paper_title: "A study of SRAM", journal_title: "Sensors", amount: 7600, voucher_number: "PV-1",
            held_back: 10000, created_at: "2026-09-02T00:00:00Z",
          }],
        }),
      })
    )
    renderWithProviders(<Ledger />, { route: "/ledger" })
    expect((await screen.findAllByText("₹10,000 held back by the research threshold")).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/duplicate|flag/i)
  })
})

describe("the budget as the Director reads it", () => {
  it("answers first, with no allocation button", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => DIRECTOR,
        "/api/budgets": () => ({
          financial_year: "2026-27", starts: "2026-04-01", ends: "2027-03-31", years_on_record: ["2026-27"],
          college: { department: null, allocated: 2_000_000, spent: 500_000, committed: 300_000, remaining: 1_200_000, used_fraction: 0.4, budget_id: "b1", note: null },
          departments: [],
        }),
        "/api/payouts/financial-year": () => ({ financial_year: "2026-27", allocation: 2_000_000, paid: 500_000, committed: 300_000, months: [] }),
      })
    )
    renderWithProviders(<Budget />, { route: "/budget" })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/₹12,00,000 is left of ₹20,00,000/))
    expect(screen.getByRole("img", { name: /Budget: ₹5,00,000 paid/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Set an allocation/ })).toBeNull()
  })
})
