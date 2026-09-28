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
    expect(await screen.findByText("A student team's conference paper")).toBeInTheDocument()
    expect(screen.getAllByText("Final-year project scheme")).toHaveLength(1)
  })
})
