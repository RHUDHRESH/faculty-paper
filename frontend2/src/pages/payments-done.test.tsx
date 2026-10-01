import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { PaymentsDone } from "@/pages/payments-done"
import { FINANCE, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * The register of what has gone out. Finance reads it and cannot undo; a super
 * admin can, and is told in rupees what the undo does.
 */

const SUPER: Me = { ...FINANCE, id: "u-super", role: "SUPER_ADMIN", name: "Admin" }

const PAID = {
  id: "claim-1",
  ticket_number: "FP-2026-000027",
  paper_title: "A study of low-power SRAM design",
  journal_title: "Sensors",
  owner_name: "Dr Senthil Sundaram",
  owner_department: "IT",
  staff_id: "SEC1105",
  remuneration: 20_000,
  calc_error: null,
  voucher_number: "PV-2026-4",
  payout_month: "2026-08",
  paid_at: "2026-08-06T11:00:00Z",
  ledger_paid: 20_000,
  ledger_rows: 1,
}

const MONTHS = { months: [{ month: "2026-08", label: "Aug 2026", amount: 2_15_655, count: 9 }] }

function load(me: Me, rows: unknown[] = [PAID], extra: Record<string, (path: string) => unknown> = {}) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/admin/payouts": () => ({
        total: rows.length,
        limit: 50,
        offset: 0,
        totals: { count: rows.length, amount: 20_000 },
        results: rows,
      }),
      "/api/payouts/months": () => MONTHS,
      "/api/payouts/financial-year": () => ({ financial_year: "2026-27", allocation: null, paid: 3_036_114, committed: 0, months: [] }),
      ...extra,
    })
  )
}

describe("the paid register", () => {
  it("gives Finance the payments and no Undo, and says why", async () => {
    load(FINANCE)
    renderWithProviders(<PaymentsDone />)
    expect(await screen.findByText("Dr Senthil Sundaram")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull()
    expect(screen.getByText(/Finance cannot undo a payment/)).toBeInTheDocument()
  })

  it("marks a payment whose ledger row differs", async () => {
    load(FINANCE, [{ ...PAID, ledger_paid: 0 }])
    renderWithProviders(<PaymentsDone />)
    expect(await screen.findByText(/Ledger shows ₹0/)).toBeInTheDocument()
  })

  it("shows the research threshold beside the paid amount", async () => {
    load(FINANCE, [{ ...PAID, remuneration: 7_600, ledger_paid: 7_600, threshold_absorbed: 10_000, threshold_full_amount: 17_600 }])
    renderWithProviders(<PaymentsDone />)
    expect(await screen.findByText(/of ₹17,600; ₹10,000 held back by the research threshold/)).toBeInTheDocument()
  })

  it("asks the server to search, so a voucher on another page is found", async () => {
    const user = userEvent.setup()
    load(FINANCE)
    renderWithProviders(<PaymentsDone />)
    await user.type(await screen.findByRole("searchbox"), "PV-2026-4")
    await vi.waitFor(() =>
      expect(vi.mocked(api).mock.calls.some(([p]) => String(p).includes("q=PV-2026-4"))).toBe(true)
    )
  })

  it("tells a failed load from an empty register", async () => {
    load(FINANCE, [], { "/api/admin/payouts": failing(500) })
    renderWithProviders(<PaymentsDone />)
    expect(await screen.findByText("Could not load payment history")).toBeInTheDocument()
    expect(screen.queryByText("Nothing paid yet")).toBeNull()
  })

  it("confirms an undo with the rupees and where the month total goes", async () => {
    const user = userEvent.setup()
    load(SUPER)
    renderWithProviders(<PaymentsDone />)
    await user.click(await screen.findByRole("button", { name: "Undo" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/A balancing row of −₹20,000/)).toBeInTheDocument()
    expect(within(dialog).getByText(/falls from ₹2,15,655 to ₹1,95,655/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Undo ₹20,000" })).toBeDisabled()
  })
})
