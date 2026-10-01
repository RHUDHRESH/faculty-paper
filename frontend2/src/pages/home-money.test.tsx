import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { DirectorHome } from "@/pages/home-director"
import { FinanceHome } from "@/pages/home-finance"
import { FINANCE, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * The two officers' Homes: the answer first, in whole-queue figures, with the
 * research threshold beside the amount it reduces and no flag anywhere.
 */

const DIRECTOR: Me = { ...FINANCE, id: "u-dir", role: "DIRECTOR", name: "Dr Rao" }

const CLAIM = {
  id: "c1",
  ticket_number: "FP-2026-000016",
  paper_title: "A study of low-power SRAM design",
  journal_title: "Sensors",
  owner_name: "Dr Revathi",
  owner_department: "AIDS",
  remuneration: 7_600,
  threshold_absorbed: 10_000,
  threshold_full_amount: 17_600,
  waiting_days: 33,
  needs_second_approval: false,
  calc_error: null,
}

const BUDGET = { financial_year: "2026-27", college: { allocated: 2_000_000, spent: 500_000, committed: 300_000, remaining: 1_200_000 } }

const COMMON = {
  "/api/budgets": () => BUDGET,
  "/api/payouts/months": () => ({ months: [] }),
  "/api/claims?mine=1": () => ({ results: [], total: 0 }),
  "/api/me/payments": () => ({ payments: [], total: 0 }),
}

describe("Finance home", () => {
  it("states the whole queue and puts the threshold beside the amount", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        ...COMMON,
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => ({
          total: 40,
          limit: 200,
          offset: 0,
          totals: {
            count: 40, amount: 400_000, ready_count: 38, ready_amount: 390_000, held_count: 2, held_amount: 10_000,
            no_amount_count: 0, held_back: 10_000, held_back_count: 1, zero_count: 0,
          },
          results: [CLAIM],
        }),
      })
    )
    renderWithProviders(<FinanceHome />)
    // 38 is the queue, not the one row in hand
    expect(await screen.findByText("38 Ready to pay", { selector: ".sr-only" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Pay 38 claims/ })).toBeInTheDocument()
    expect(screen.getAllByText(/of ₹17,600; ₹10,000 held back by the research threshold/).length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/flag|duplicate|watch/i)
  })

  it("says a failed queue failed, not that nothing is waiting", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ ...COMMON, "/api/auth/me": () => FINANCE, "/api/admin/payouts": failing(500) })
    )
    renderWithProviders(<FinanceHome />)
    expect(await screen.findByText("Could not load the payable queue.")).toBeInTheDocument()
    expect(screen.queryByText(/Nothing is ready to pay/)).toBeNull()
  })
})

describe("Director home", () => {
  it("leads with what is waiting, what it releases and what the budget keeps", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        ...COMMON,
        "/api/auth/me": () => DIRECTOR,
        "/api/director/queue": () => ({
          total: 1,
          results: [{ ...CLAIM, status: "PRINCIPAL_APPROVED" }],
          totals: { count: 1, amount: 7_600, longest_wait_days: 33, held_back: 10_000, held_back_count: 1 },
        }),
      })
    )
    renderWithProviders(<DirectorHome />)
    const means = await screen.findByTestId("authorising-means")
    expect(means).toHaveTextContent("Authorising all of it releases ₹7,600 to Finance")
    expect(means).toHaveTextContent("₹12,00,000 left")
    expect(means).toHaveTextContent("taken ₹10,000 off 1 claim")
    expect(screen.getByRole("button", { name: /Authorise all 1 · ₹7,600/ })).toBeInTheDocument()
    expect(screen.getAllByText(/held back by the research threshold/).length).toBeGreaterThan(0)
  })

  it("says nothing is waiting in words when the queue is empty", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        ...COMMON,
        "/api/auth/me": () => DIRECTOR,
        "/api/director/queue": () => ({ total: 0, results: [], totals: { count: 0, amount: 0, longest_wait_days: null } }),
      })
    )
    renderWithProviders(<DirectorHome />)
    expect(await screen.findByText(/Nothing is waiting for your signature/)).toBeInTheDocument()
  })
})
