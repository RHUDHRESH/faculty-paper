import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

function assignment(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "a1",
    department: "Mechanical Engineering",
    kind: "PAIRING",
    kind_label: "Co-author pairing",
    title: "A joint paper on lattice fatigue",
    notes: "Start from the 2024 survey.",
    status: "OPEN",
    status_label: "Open",
    assignee_id: "u-faculty",
    assignee_name: "Dr Asha Menon",
    partner_id: "u-2",
    partner_name: "Dr Ravi Kumar",
    due_date: "2026-12-01",
    set_by: "Dr Meera Pillai",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    my_part: "ASSIGNEE",
    with_name: "Dr Ravi Kumar",
    ...over,
  }
}

function mount(
  claims: ReturnType<typeof claim>[],
  assignments: ReturnType<typeof assignment>[] = [],
  extra: Record<string, () => unknown> = {}
) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/claims": () => ({ results: claims, total: claims.length }),
      "/api/me/assignments": () => assignments,
      ...extra,
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
        "/api/me/assignments": () => [],
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

  it("says how far a paper has come and how long it has waited, never whose desk", async () => {
    mount([
      claim({
        status: "PRINCIPAL_APPROVED",
        remuneration: 105_000,
        waiting_days: 21,
        ticket_number: "FP-2026-000001",
      }),
    ])
    // Once as the total on its way, once on the paper's own card.
    expect(await screen.findAllByText("₹1,05,000")).toHaveLength(2)
    expect(screen.getAllByText("Under review").length).toBeGreaterThan(0)
    expect(screen.getByText(/waiting 21 days/i)).toBeInTheDocument()
    // The college's rule: a claimant is never told which desk holds it.
    for (const desk of [/principal/i, /director/i, /finance/i, /research cell/i]) {
      expect(screen.queryByText(desk)).toBeNull()
    }
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
    // The three money figures are genuinely nil and say so; the draft is not.
    expect(screen.getAllByText("₹0")).toHaveLength(3)
  })

  it("puts a paper that was sent back first, with the reason and a way to fix it", async () => {
    mount([claim({ status: "REJECTED", status_note: "Attach the SEC reference PDFs", paid_at: null })])
    expect(await screen.findByText("Sent back to you")).toBeInTheDocument()
    expect(screen.getByText("Attach the SEC reference PDFs")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /fix and send again/i })).toHaveAttribute(
      "href",
      "/papers/c1/edit"
    )
  })

  it("offers a retry rather than leaving the reader to reload the page", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/claims": failing(503),
        "/api/me/assignments": () => [],
      })
    )
    renderWithProviders(<FacultyHome />)
    expect(await screen.findByRole("button", { name: /try again/i })).toBeInTheDocument()
  })
})

describe("work assigned to a faculty member", () => {
  it("lists it with what kind it is, who it is with and when it is due", async () => {
    mount([claim()], [assignment()])

    const section = await screen.findByRole("region", { name: "Assigned to you" })
    expect(within(section).getByText("A joint paper on lattice fatigue")).toBeInTheDocument()
    expect(within(section).getByText("Co-author pairing")).toBeInTheDocument()
    expect(within(section).getByText(/with Dr Ravi Kumar/)).toBeInTheDocument()
    expect(within(section).getByText(/by 1 Dec 2026/)).toBeInTheDocument()
    // Neither money nor a desk: this is the claimant's own home screen.
    expect(section.textContent).not.toContain("₹")
    for (const desk of [/principal/i, /director/i, /finance/i, /research cell/i]) {
      expect(within(section).queryByText(desk)).toBeNull()
    }
  })

  it("is not drawn when nothing is assigned", async () => {
    mount([claim()], [])
    await screen.findByText("1 paper on record")
    expect(screen.queryByRole("region", { name: "Assigned to you" })).toBeNull()
  })

  it("moves the status from where it is read", async () => {
    const user = userEvent.setup()
    mount([claim()], [assignment()], {
      "/api/hod/assignments/a1": () => assignment({ status: "IN_PROGRESS" }),
    })

    await user.selectOptions(
      await screen.findByLabelText("Status of A joint paper on lattice fatigue"),
      "IN_PROGRESS"
    )

    const patches = () =>
      vi
        .mocked(api)
        .mock.calls.filter(
          ([p, o]) =>
            p === "/api/hod/assignments/a1" && (o as { method?: string })?.method === "PATCH"
        )
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0][1]).toMatchObject({ json: { status: "IN_PROGRESS" } })
  })
})
