import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Calendar } from "@/pages/calendar"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * Nobody has typed a date into the calendar, so it used to be empty for
 * everyone while the ledger held thirty months of payouts. It now shows the
 * dates the record holds, which nobody can edit here.
 */
const FINANCE: Me = { id: "u-fin", email: "f@x.edu", name: "Finance", role: "FINANCE", department: null }

function mount(me: Me, record: unknown[]) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/calendar": () => ({
        start: "2026-05-01",
        end: "2026-10-31",
        results: [],
        kinds: [{ key: "DEADLINE", label: "Deadline" }],
        record,
        record_kinds: [
          { key: "PAID", label: "Payments made" },
          { key: "PUBLISHED", label: "Published" },
          { key: "FILED", label: "Filed" },
        ],
      }),
    })
  )
  renderWithProviders(<Calendar />, { route: "/calendar" })
}

const month = {
  id: "record-paid-2026-05",
  kind: "PAID",
  kind_label: "Payments made",
  title: "112 papers paid for",
  starts_on: "2026-05-01",
  count: 112,
  amount: 713718,
  claim_id: null,
  titles: [],
  whole_month: true,
}

describe("Calendar — dates from the record", () => {
  it("shows a month's payments with its total, and offers no way to change it", async () => {
    mount(FINANCE, [month])
    expect(await screen.findByText("112 papers paid for")).toBeInTheDocument()
    expect(screen.getByText("₹7,13,718")).toBeInTheDocument()
    expect(screen.getByText(/May 2026 · Payments made · from the record/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull()
    // Finance may open the ledger for that month.
    expect(screen.getByRole("link", { name: "112 papers paid for" })).toHaveAttribute(
      "href",
      "/ledger?month=2026-05"
    )
  })

  it("links a claimant's own paper to its ticket", async () => {
    mount(FACULTY, [
      {
        ...month,
        id: "record-published-c1",
        kind: "PUBLISHED",
        kind_label: "Published",
        title: "Published: My paper",
        starts_on: "2026-06-14",
        count: 1,
        amount: null,
        claim_id: "c1",
        whole_month: false,
      },
    ])
    expect(await screen.findByRole("link", { name: "Published: My paper" })).toHaveAttribute(
      "href",
      "/papers/c1"
    )
    expect(screen.getByText(/14 Jun 2026 · Published · from the record/)).toBeInTheDocument()
  })
})
