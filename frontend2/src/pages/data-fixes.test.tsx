import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { DataFixes } from "@/pages/data-fixes"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const ROW = {
  id: "c1",
  ticket_number: "ERP-PROCESSED-9",
  imported: true,
  title: "-",
  journal: "Journal of Things",
  year: 2026,
  status: "PAID",
  owner: { user_id: "u1", name: "Asha Rao" },
  department: "ECE",
  amount: 0,
  quartile: "Q2",
  claimed_quartile: "Q2",
  month_paid: "2026-09-01",
  status_note: "Accounts",
  ledger_total: 0,
  ledger_rows: 1,
  issues: ["paid_no_amount", "untitled"],
  suggestion: { amount: 18500, note: null },
  last_fix: null,
}

const QUEUE = {
  counts: { paid_no_amount: 61, untitled: 1, no_quartile: 21, no_claimant: 2, no_quartile_in_review: 13, claims: 74 },
  total: 1,
  rows: [ROW],
}

describe("the data-fix queue", () => {
  it("counts the real claims and asks only for what each claim is missing", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ADMIN, "/api/admin/data-fixes": () => QUEUE }))
    renderWithProviders(<DataFixes />)
    expect(await screen.findByText("61")).toBeTruthy()
    expect(screen.getByText("Paid with no amount")).toBeTruthy()
    expect(screen.getByLabelText(/Amount paid/)).toBeTruthy()
    expect(screen.getByLabelText(/Paper title/)).toBeTruthy()
    expect(screen.queryByLabelText(/^Quartile/)).toBeNull()
    expect(screen.getByText("No title recorded")).toBeTruthy()
  })

  it("saves through the fix endpoint with the reason, and says the ledger agrees", async () => {
    const post = vi.fn(() => ({
      ok: true,
      changed: { remuneration: 18500 },
      ledger: { claim_amount: 18500, ledger_total: 18500, ledger_rows: 2, matches: true },
      row: null,
    }))
    vi.mocked(api).mockImplementation((path: string, opts?: { method?: string; json?: unknown }) => {
      if (opts?.method === "POST") return Promise.resolve(post()) as never
      return fakeApi({ "/api/auth/me": () => ADMIN, "/api/admin/data-fixes": () => QUEUE })(path)
    })
    renderWithProviders(<DataFixes />)
    await userEvent.click(await screen.findByRole("button", { name: /The policy would pay ₹18,500/ }))
    await userEvent.click(screen.getByRole("button", { name: /Save fix for ERP-PROCESSED-9/ }))
    await waitFor(() => expect(post).toHaveBeenCalled())
    expect(await screen.findByText(/Saved amount ₹18,500. The ledger agrees./)).toBeTruthy()
    const call = vi.mocked(api).mock.calls.find((c) => (c[1] as { method?: string })?.method === "POST")!
    expect(call[0]).toBe("/api/admin/data-fixes/c1")
    expect((call[1] as { json: { amount: number; reason: string } }).json).toMatchObject({
      amount: 18500,
      reason: "Corrected from the accounts records",
    })
  })
})
