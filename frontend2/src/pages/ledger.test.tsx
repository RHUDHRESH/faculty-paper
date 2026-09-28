import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Ledger } from "@/pages/ledger"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

/** The ledger holds both schemes' money; a final-year project payment says so. */

const row = (id: string, paper: string, scheme: "FYP" | "FACULTY") => ({
  id,
  claim_id: `c-${id}`,
  payout_month: "2026-09",
  department: "Chemical",
  faculty_name: "Kumar A",
  staff_id: "TSCH001",
  biometric_id: null,
  paper_title: paper,
  journal_title: "Proceedings of a Conference",
  amount: scheme === "FYP" ? 15000 : 4000,
  voucher_number: null,
  scheme,
  created_at: "2026-09-23T08:00:00Z",
})

describe("the ledger, across two schemes", () => {
  it("marks a final-year project payment and leaves the faculty scheme's alone", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/meta/departments": () => ["Chemical"],
        "/api/admin/ledger": () => ({
          total: 2,
          limit: 50,
          offset: 0,
          total_amount: 19000,
          results: [
            row("1", "A student team's conference paper", "FYP"),
            row("2", "A faculty conference paper", "FACULTY"),
          ],
        }),
      })
    )
    renderWithProviders(<Ledger />, { route: "/ledger" })
    expect((await screen.findAllByText("A student team's conference paper")).length).toBeGreaterThan(0)
    expect(screen.getAllByText("Final-year project scheme").length).toBeGreaterThan(0)
  })
})

describe("the ledger screen", () => {
  it("answers how much, when and to whom, and marks a duplicate with a way to review it", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/meta/departments": () => ["Chemical"],
        "/api/admin/ledger": () => ({
          total: 2,
          limit: 50,
          offset: 0,
          total_amount: 2655783.5,
          people: 1,
          duplicates_open: 47,
          by_month: [
            { month: "2024-01", amount: 1000, count: 1 },
            { month: "2024-02", amount: 2000, count: 1 },
          ],
          by_department: [
            { department: "Chemical", amount: 2000, count: 1 },
            { department: null, amount: 1000, count: 1 },
          ],
          results: [
            { ...row("1", "A paid twice paper", "FACULTY"), markers: ["DUPLICATE"], photo_url: null },
            { ...row("2", "A voided paper", "FACULTY"), amount: -4000, markers: ["REVERSAL"] },
          ],
        }),
      })
    )
    renderWithProviders(<Ledger />, { route: "/ledger" })
    expect(await screen.findByText("₹26,55,783.50")).toBeInTheDocument()
    expect(screen.getByText(/from Jan 2024 to Feb 2024, across 2 payments to 1 person/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /47 possible duplicates to review/ })).toHaveAttribute(
      "href",
      "/duplicates"
    )
    expect(screen.getAllByText("On the duplicates list").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Reversal").length).toBeGreaterThan(0)
    expect(screen.getByRole("button", { name: /Feb 2024/ })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Export everything/ })).toHaveAttribute(
      "href",
      "/api/admin/ledger/export?"
    )
  })
})
