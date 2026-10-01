import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { MoneyHub } from "@/pages/hub"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

const DIRECTOR: Me = { ...FINANCE, id: "u-dir", role: "DIRECTOR", name: "Dr Rao" }

function load(me: Me) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/payouts/financial-year": () => ({ financial_year: "2026-27", allocation: 2_000_000, paid: 500_000, committed: 300_000, months: [] }),
      "/api/payouts/months": () => ({ months: [{ month: "2026-08", label: "Aug 2026", amount: 215_655, count: 6 }] }),
      "/api/budgets": () => ({ financial_year: "2026-27", college: { allocated: 2_000_000, spent: 500_000, committed: 300_000, remaining: 1_200_000 } }),
      "/api/admin/payouts": () => ({ total: 1, limit: 200, offset: 0, totals: { count: 1, amount: 100, ready_count: 1, ready_amount: 100, held_count: 0, held_amount: 0, no_amount_count: 0, held_back: 0, held_back_count: 0, zero_count: 0 }, results: [] }),
      "/api/director/queue": () => ({ total: 3, results: [], totals: { count: 3, amount: 90_000, longest_wait_days: 4 } }),
    })
  )
}

describe("Money, for the Director and Finance", () => {
  it("answers where the year stands and puts a live line under each page (Finance)", async () => {
    load(FINANCE)
    renderWithProviders(<MoneyHub />)
    expect(await screen.findByText("₹5,00,000", { selector: ".figure" })).toBeInTheDocument()
    const budget = await screen.findByRole("link", { name: /Budget/ })
    expect(await within(budget).findByText("₹12,00,000 left of ₹20,00,000 for 2026-27")).toBeInTheDocument()
    expect(within(screen.getByRole("link", { name: /Payments/ })).getByText("1 ready to pay, ₹100")).toBeInTheDocument()
    expect(within(screen.getByRole("link", { name: /Monthly statements/ })).getByText(/Newest: Aug 2026/)).toBeInTheDocument()
  })

  it("gives the Director their own desk line, and no Payments row", async () => {
    load(DIRECTOR)
    renderWithProviders(<MoneyHub />)
    const row = await screen.findByRole("link", { name: /Authorisations/ })
    expect(await within(row).findByText("3 waiting, ₹90,000")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /^Payments/ })).toBeNull()
  })
})
