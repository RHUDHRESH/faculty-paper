import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { FacultyHome } from "@/pages/home-faculty"
import { FACULTY, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * The screen 499 of 525 accounts land on, and the one that shipped the worst
 * bug in this application's history: a dropped request rendered as "0 papers
 * on record · Received ₹0 · Nothing filed yet".
 *
 * `data?.results || []` turns any failure into an empty list, which is why
 * the empty branch and the error branch have to be asserted against each
 * other rather than one at a time — a page can pass "shows the empty state
 * when the list is empty" and still be telling a claimant their record is
 * gone.
 */

/** Both markers from the bug report, in one place, so the empty test and the
 *  error test cannot drift apart. */
const EMPTY_RECORD_MARKERS = [/papers on record/i, /nothing waiting on you/i]

function claim(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    ticket_number: "PUB-2025-0041",
    paper_title: "A finite element study of lattice struts",
    journal_title: "Journal of Materials",
    status: "PAID",
    remuneration: 52_377.5,
    publication_year: 2025,
    updated_at: "2025-06-01T00:00:00Z",
    ...over,
  }
}

function mount(claims: ReturnType<typeof claim>[]) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/claims": () => ({ results: claims, total: claims.length }),
    })
  )
  renderWithProviders(<FacultyHome />)
}

describe("FacultyHome", () => {
  it("shows the record when the request succeeds", async () => {
    mount([claim()])
    expect(await screen.findByText("1 paper on record")).toBeInTheDocument()
    // Once as "Received to date", once on the row itself.
    expect(screen.getAllByText("₹52,377.50")).toHaveLength(2)
  })

  it("says the record is empty only when the server said it is empty", async () => {
    mount([])
    expect(await screen.findByText("0 papers on record")).toBeInTheDocument()
    // Received to date and On the way, both genuinely nil.
    expect(screen.getAllByText("₹0").length).toBeGreaterThan(0)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows the failure, not an empty record, when the request fails", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/claims": failing(500),
      })
    )
    renderWithProviders(<FacultyHome />)

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Could not load your record")
    expect(alert).toHaveTextContent(/nothing has been lost/i)

    // THE REGRESSION. Not one word of the empty record may appear.
    for (const marker of EMPTY_RECORD_MARKERS) {
      expect(screen.queryByText(marker)).toBeNull()
    }
    expect(screen.queryByText("₹0")).toBeNull()
    expect(screen.queryByText(/nothing filed yet/i)).toBeNull()
  })

  it("says who is holding the money and for how long, not just how much", async () => {
    mount([
      claim({
        status: "PRINCIPAL_APPROVED",
        remuneration: 105_000,
        waiting_days: 21,
        ticket_number: "FP-2026-000001",
      }),
    ])
    // The figure is the easy half. "Where is it" is the question, and the
    // answer is a desk and a number of days.
    // Once as the total on its way, once on the paper's own row below.
    expect(await screen.findAllByText("₹1,05,000")).toHaveLength(2)
    // In the panel that answers the question, and again on the row in the
    // record below it.
    expect(screen.getAllByText(/with the director/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/21 days at this desk/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/more than a week/i)).toBeInTheDocument()
  })

  it("does not present a draft with no worked-out amount as ₹0", async () => {
    mount([
      claim({
        status: "DRAFT",
        ticket_number: null,
        remuneration: 0,
        remuneration_is_estimate: true,
        paid_at: null,
      }),
    ])
    expect(await screen.findByText(/not worked out yet/i)).toBeInTheDocument()
    // Received to date is genuinely nil and says so; the draft is not.
    expect(screen.getAllByText("₹0")).toHaveLength(2)
  })

  it("offers a retry rather than leaving the reader to reload the page", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/claims": failing(503),
      })
    )
    renderWithProviders(<FacultyHome />)
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument()
  })
})
