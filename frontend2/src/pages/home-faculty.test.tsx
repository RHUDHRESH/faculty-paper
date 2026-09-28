import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { FacultyHome, greeting, type MySummary } from "@/pages/home-faculty"
import { FACULTY, failing, fakeApi, ledgerOf, renderWithProviders } from "@/test/harness"

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
const EMPTY_RECORD_MARKERS = [/papers on record/i, /nothing waiting on you/i, /file your first paper/i]

function summary(over: Partial<MySummary> = {}): MySummary {
  return {
    papers: 20,
    papers_source: "claims",
    citations: 46,
    h_index: 3,
    dept_rank: { rank: 1, of: 6, dept: "S&H-ENGLISH", delta: 2 },
    strip: [{ month: "2024-03", papers: 2 }],
    unclaimed: null,
    returned: 0,
    drafts: 0,
    on_the_way: 0,
    money: { this_year: 0, on_the_way: 0, to_date: 0 },
    ...over,
  }
}

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
  extra: Record<string, (path: string) => unknown> = {}
) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/claims": () => ({ results: claims, total: claims.length }),
      "/api/me/payments": () => ledgerOf(claims),
      "/api/me/assignments": () => assignments,
      "/api/me/summary": () => summary(claims.length ? {} : { papers: 0, citations: null, h_index: null, dept_rank: null, strip: [] }),
      "/api/me/celebrations": () => ({ celebrations: [] }),
      ...extra,
    })
  )
  renderWithProviders(<FacultyHome />)
}

describe("FacultyHome", () => {
  it("opens on the record: four linked figures and the Record strip", async () => {
    mount([claim()])
    expect(await screen.findByRole("link", { name: "20 papers" })).toHaveAttribute("href", "/papers")
    expect(screen.getByRole("link", { name: "46 citations" })).toHaveAttribute("href", "/research#citations")
    expect(screen.getByRole("link", { name: "3 h-index" })).toHaveAttribute("href", "/research#metrics")
    expect(screen.getByRole("link", { name: /Rank 1 of 6 in S&H-ENGLISH/ })).toHaveAttribute("href", "/leaderboard?dept=mine")
    expect(screen.getByText("↑2 this academic year")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "March 2024, 2 papers" })).toBeInTheDocument()
    // Money is one row, received to date from the ledger.
    expect(screen.getByRole("region", { name: "Your money" })).toHaveTextContent("₹52,377.50")
  })

  it("says the record is empty only when the server said it is empty", async () => {
    mount([])
    expect(await screen.findByText("File your first paper", { selector: "h2" })).toBeInTheDocument()
    expect(await screen.findByText("Nothing needs you.")).toBeInTheDocument()
    expect(screen.getAllByText("₹0").length).toBeGreaterThan(0)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("keeps the page when only the hero fails, and says so in the hero", async () => {
    mount([claim()], [], { "/api/me/summary": failing(500) })
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Could not load your record")
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
    // Figures show a dash while unknown, never 0.
    expect(screen.queryByRole("link", { name: /^0 papers/ })).toBeNull()
    expect(screen.getByRole("region", { name: "Your money" })).toBeInTheDocument()
  })

  it("lists unclaimed papers from the record only when the record knows", async () => {
    mount([claim()], [], { "/api/me/summary": () => summary({ unclaimed: 10 }) })
    expect(await screen.findByText(/10 papers on your record aren't claimed yet/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /review them/i })).toHaveAttribute("href", "/papers?filter=unclaimed")
  })

  it("greets by the time of day in India", () => {
    expect(greeting(new Date("2026-09-24T03:00:00Z"))).toBe("Good morning") // 08:30 IST
    expect(greeting(new Date("2026-09-24T08:00:00Z"))).toBe("Good afternoon") // 13:30 IST
    expect(greeting(new Date("2026-09-24T12:00:00Z"))).toBe("Good evening") // 17:30 IST
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
    await screen.findByRole("region", { name: "Your money" })
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
