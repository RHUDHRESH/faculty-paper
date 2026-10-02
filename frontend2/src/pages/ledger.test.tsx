import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
    expect(await screen.findByText("₹26,55,784")).toBeInTheDocument()
    expect(screen.getByText(/from Jan 2024 to Feb 2024, across 2 payments./)).toBeInTheDocument()
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

describe("where the ledger and the paid claims disagree", () => {
  const ADMIN = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN" as const, department: null }
  const base = {
    "/api/auth/me": () => ADMIN,
    "/api/meta/departments": () => [],
    "/api/admin/ledger": () => ({ total: 0, limit: 50, offset: 0, total_amount: 0, results: [] }),
    "/api/admin/ledger/checks": () => ({ no_ledger: 1, mismatch: 0, no_claim: 2963 }),
  }

  it("shows the real counts, never a capped number", async () => {
    vi.mocked(api).mockImplementation(fakeApi(base))
    renderWithProviders(<Ledger />, { route: "/ledger" })
    expect(await screen.findByText("2,963")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /No claim \(2,963\)/ })).toBeInTheDocument()
    expect(screen.queryByText(/99\+/)).toBeNull()
  })

  it("adds the missing ledger row only after saying what it will write", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation((path: string, opts?: { method?: string }) => {
      if (opts?.method === "POST") return Promise.resolve({ ok: true }) as never
      return fakeApi({
        ...base,
        "/api/admin/ledger/problems": () => ({
          kind: "no-ledger",
          total: 1,
          rows: [
            {
              id: "c1", ticket_number: "ERP-PROCESSED-120", title: "A paper",
              owner: { user_id: "u1", name: "Asha Rao" }, month_paid: "2026-09-01",
              claim_amount: 5000, ledger_total: 0, missing: 5000,
            },
          ],
        }),
      })(path)
    })
    renderWithProviders(<Ledger />, { route: "/ledger?problem=no-ledger" })
    await user.click(await screen.findByRole("button", { name: /Add ₹5,000 to the ledger/ }))
    expect(await screen.findByText(/This writes one new row of ₹5,000/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Add the row" }))
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some(([p]) => p === "/api/admin/ledger/claims/c1/add-row")).toBe(true)
    )
  })
})
