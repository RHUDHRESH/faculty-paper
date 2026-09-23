import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { HodHome } from "@/pages/home-staff"
import { HOD, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * A head of department is also a faculty member who files their own papers
 * (2026-09-23). Their home keeps the department view and gains their own
 * papers beside it -- with their own amounts, because those are theirs, and
 * the claimant's journey, because they are the claimant on them.
 */

function claim(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    owner_id: HOD.id,
    ticket_number: "FP-2025-000901",
    paper_title: "Thin films under strain",
    journal_title: "Journal of Physics",
    status: "PAID",
    faculty_stage: "Paid",
    remuneration: 42_137,
    remuneration_is_estimate: false,
    calc_error: null,
    waiting_days: null,
    days_waiting: null,
    publication_year: 2025,
    updated_at: "2025-06-01T00:00:00Z",
    paid_at: "2025-07-01T00:00:00Z",
    ...over,
  }
}

const OVERVIEW = {
  department: "Physics",
  totals: {
    publications: 12,
    faculty_in_department: 9,
    faculty_who_published: 5,
    q1: 3,
    first_author: 7,
    under_review: 2,
  },
  people: [],
}

function mount(claims: ReturnType<typeof claim>[], extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => HOD,
      "/api/hod/overview": () => OVERVIEW,
      "/api/hod/standing": () => null,
      "/api/hod/targets": () => ({ year: 2026, department_targets: [] }),
      "/api/claims": () => ({ results: claims, total: claims.length }),
      ...extra,
    })
  )
  renderWithProviders(<HodHome />)
}

describe("HodHome", () => {
  it("keeps the department view", async () => {
    mount([])
    expect(await screen.findByText(/Physics — what the department has published/)).toBeInTheDocument()
  })

  it("shows the head's own papers with their own amounts", async () => {
    mount([claim()])
    const mine = await screen.findByRole("region", { name: "Your papers" })
    // Received to date, and the row itself.
    expect(await within(mine).findAllByText("₹42,137")).not.toHaveLength(0)
    expect(within(mine).getByText("Thin films under strain")).toBeInTheDocument()
    expect(within(mine).getByRole("link", { name: /File a paper/ })).toHaveAttribute(
      "href",
      "/papers/new"
    )
  })

  it("draws the claimant's journey for a paper still moving, and never names a desk", async () => {
    mount([
      claim({
        id: "c2",
        status: "CLEARED",
        faculty_stage: "Under review",
        days_waiting: 12,
        remuneration: 18_000,
        paid_at: null,
      }),
    ])
    const mine = await screen.findByRole("region", { name: "Your papers" })
    expect(await within(mine).findAllByText("Under review")).not.toHaveLength(0)
    expect(within(mine).getByText(/waiting 12 days/i)).toBeInTheDocument()
    for (const desk of [/principal/i, /director/i, /finance/i, /research cell/i]) {
      expect(within(mine).queryByText(desk)).toBeNull()
    }
  })

  it("invites a head with nothing filed to file, without a ₹0 record", async () => {
    mount([])
    const mine = await screen.findByRole("region", { name: "Your papers" })
    expect(await within(mine).findByText(/nothing filed yet/i)).toBeInTheDocument()
    expect(within(mine).queryByText("₹0")).toBeNull()
  })

  it("shows a failure for their own papers, not an empty record", async () => {
    mount([], { "/api/claims": failing(500) })
    const mine = await screen.findByRole("region", { name: "Your papers" })
    expect(await within(mine).findByText(/could not load your papers/i)).toBeInTheDocument()
    expect(within(mine).queryByText("₹0")).toBeNull()
  })
})
