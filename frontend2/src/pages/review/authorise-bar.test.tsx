import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"
import { AuthoriseBar } from "@/pages/review/authorise-bar"
import type { WorkspaceClaim } from "@/pages/review/types"

/**
 * The Director's decision bar in the review workspace (docs/ux/28, T3):
 * Authorise where the evidence is, the budget effect beside it, Send back for a
 * super admin standing in only, nothing at all on the reader's own claim, and
 * never a flag, a hold or a reject.
 */

const CLAIM = {
  id: "c1",
  ticket_number: "FP-2026-000012",
  paper_title: "A study of EV battery thermal management",
  owner_name: "Dr Anitha Raman",
  owner_department: "EEE",
  status: "PRINCIPAL_APPROVED",
  remuneration: 44_550,
  calc_error: null,
} as unknown as WorkspaceClaim

const BUDGET = { financial_year: "2026-27", college: { allocated: 4_500_000, spent: 3_186_114, committed: 724_350, remaining: 589_536 } }

function load(extra: Record<string, () => unknown> = {}) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FINANCE,
      "/api/budgets": () => BUDGET,
      ...extra,
    })
  )
}

describe("the Director's decision bar", () => {
  it("offers Authorise with the amount and says what it does to the budget, with no Send back", async () => {
    load()
    renderWithProviders(<AuthoriseBar claim={CLAIM} own={false} isSuperAdmin={false} onDone={() => {}} />)
    expect(screen.getByRole("button", { name: /Authorise ₹44,550/ })).toBeEnabled()
    expect(await screen.findByText("Authorising it leaves ₹5,89,536 in the 2026-27 budget.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Send back/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /flag|hold|reject/i })).toBeNull()
  })

  it("gives a super admin standing in the Send back, with a reason", async () => {
    load()
    renderWithProviders(<AuthoriseBar claim={CLAIM} own={false} isSuperAdmin onDone={() => {}} />)
    await userEvent.click(screen.getByRole("button", { name: /Send back/ }))
    expect(await screen.findByRole("heading", { name: "Send this claim back?" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Send back" })).toBeDisabled()
  })

  it("opens the confirm on the key a, with the button focused so Enter confirms", async () => {
    const authorise = vi.fn(() => ({ remuneration: 44_550 }))
    load({ "/api/claims/c1/director-approve": authorise })
    const done = vi.fn()
    renderWithProviders(<AuthoriseBar claim={CLAIM} own={false} isSuperAdmin={false} onDone={done} />)
    await userEvent.keyboard("a")
    const confirm = await screen.findByRole("button", { name: "Authorise ₹44,550" })
    await waitFor(() => expect(confirm).toHaveFocus())
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(authorise).toHaveBeenCalled())
    await waitFor(() => expect(done).toHaveBeenCalled())
  })

  it("shows no bar on the reader's own claim, only the reason", () => {
    load()
    renderWithProviders(<AuthoriseBar claim={CLAIM} own isSuperAdmin={false} onDone={() => {}} />)
    expect(screen.getByText(/This is your own claim/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Authorise/ })).toBeNull()
  })

  it("says there is nothing to authorise once the claim has moved on", () => {
    load()
    renderWithProviders(
      <AuthoriseBar claim={{ ...CLAIM, status: "DIRECTOR_APPROVED" } as WorkspaceClaim} own={false} isSuperAdmin={false} onDone={() => {}} />
    )
    expect(screen.getByText(/nothing for you to authorise/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Authorise/ })).toBeNull()
  })
})
