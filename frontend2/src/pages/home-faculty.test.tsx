import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { FacultyHome, greeting, homeSentence, monthOnly, reasonOf, type HomeRecord } from "@/pages/home-faculty"
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

function record(over: Partial<HomeRecord> = {}): HomeRecord {
  return { papers: 20, citations: 46, h_index: 3, unfiled: null, ...over }
}

function claim(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    ticket_number: "FP-2025-000041",
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

const OUTLOOK = {
  pattern: "monthly",
  last_run: "2026-09",
  next_run: "2026-10",
  next_run_label: "October 2026",
  filing_cutoff_day: null,
  sentence: "The college pays in a monthly run. The last run was September 2026, so the next is expected in October 2026.",
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
      "/api/me/home": () => (claims.length ? record() : record({ papers: 0, citations: null, h_index: null })),
      "/api/me/next-payout": () => OUTLOOK,
      "/api/me/celebrations": () => ({ celebrations: [] }),
      "/api/discover/next": () => ({ people: [], journals: [] }),
      ...extra,
    })
  )
  renderWithProviders(<FacultyHome />)
}

/** A claim the college has approved, so a payment is expected. */
const approved = (over: Partial<Record<string, unknown>> = {}) =>
  claim({ id: "c2", status: "DIRECTOR_APPROVED", remuneration: 23_000, paid_at: null, waiting_days: 12, ...over })

describe("homeSentence", () => {
  const base = { sentBack: 0, drafts: 0, moving: 0, coming: 0, estimate: false, approved: false, nextRun: null, unfiled: null, filedAny: true }
  const now = new Date("2026-09-30T10:00:00Z")

  it("names the fix and the money in one sentence", () => {
    expect(homeSentence({ ...base, sentBack: 1, moving: 1, coming: 23000, approved: true, nextRun: "October 2026", now })).toBe(
      "1 claim needs a fix from you; ₹23,000 is on its way, expected in October."
    )
  })

  it("does not promise a month for a claim nobody has approved", () => {
    expect(homeSentence({ ...base, moving: 1, coming: 2000, nextRun: "October 2026", now })).toBe(
      "Nothing needs you; ₹2,000 is with the college, being checked."
    )
  })

  it("says about when the amount is an estimate", () => {
    expect(homeSentence({ ...base, moving: 2, coming: 5000, estimate: true, approved: true, nextRun: "October 2026", now })).toContain("about ₹5,000")
  })

  it("gives the year when the payment month is next year", () => {
    expect(monthOnly("January 2027", now)).toBe("January 2027")
    expect(monthOnly("October 2026", now)).toBe("October")
  })

  it("is honest when there is nothing to do and nothing to wait for", () => {
    expect(homeSentence({ ...base, now })).toBe("Nothing needs you, and nothing is waiting to be paid.")
    expect(homeSentence({ ...base, unfiled: 4, now })).toContain("4 papers on your record are not filed yet.")
  })

  it("says a threshold-only claim is being checked without inventing an amount", () => {
    expect(homeSentence({ ...base, moving: 1, coming: 0, now })).toBe("Nothing needs you; 1 claim is being checked.")
  })

  it("welcomes a claimant who has filed nothing", () => {
    expect(homeSentence({ ...base, filedAny: false, now })).toBe("You have not filed a claim yet.")
  })
})

describe("FacultyHome", () => {
  it("answers first, then shows the money as linked figures", async () => {
    mount([claim(), approved()])
    expect(await screen.findByTestId("home-answer")).toHaveTextContent(
      /Nothing needs you; ₹23,000 is on its way, expected in October\./
    )
    const money = screen.getByRole("region", { name: "Your money" })
    expect(within(money).getByRole("link", { name: /₹52,377.50/ })).toHaveAttribute("href", "/papers/statement")
    expect(within(money).getByRole("link", { name: /₹23,000/ })).toHaveAttribute("href", "/papers/claims")
    // The payment-run sentence is behind "when the next payment is".
    expect(within(money).getByRole("button", { name: /when the next payment is/ })).toBeInTheDocument()
  })

  it("shows one paper count from the record, with citations and h-index", async () => {
    mount([claim()])
    expect(await screen.findByRole("button", { name: "20 papers" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "46 citations" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "3 h-index" })).toBeInTheDocument()
    // The old page also drew a department rank and a search box; neither is Home's job.
    expect(screen.queryByRole("search")).toBeNull()
  })

  it("asks the server for the record once, in one light request", async () => {
    mount([claim()])
    await screen.findByRole("button", { name: "20 papers" })
    const paths = vi.mocked(api).mock.calls.map(([p]) => String(p))
    expect(paths.filter((p) => p === "/api/me/home")).toHaveLength(1)
    expect(paths).not.toContain("/api/me/summary")
    expect(paths.some((p) => p.startsWith("/api/me/publications"))).toBe(false)
  })

  it("says the record is empty only when the server said it is empty", async () => {
    mount([])
    expect(await screen.findByText("File your first paper", { selector: "h2" })).toBeInTheDocument()
    expect(await screen.findByTestId("home-answer")).toHaveTextContent("You have not filed a claim yet.")
    expect(screen.getAllByText("₹0").length).toBeGreaterThan(0)
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("keeps the page when only the record fails, and says so where the record would be", async () => {
    mount([claim()], [], { "/api/me/home": failing(500) })
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Could not load your record")
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
    // Figures are never a 0 that means "unknown".
    expect(screen.queryByRole("link", { name: /^0 papers/ })).toBeNull()
    expect(screen.getByRole("region", { name: "Your money" })).toBeInTheDocument()
  })

  it("lists unfiled papers from the record, each one click from its claim", async () => {
    mount([claim()], [], {
      "/api/me/home": () =>
        record({
          unfiled: {
            count: 10,
            items: [{ id: "p1", title: "An unfiled lattice paper", venue: "Materials Letters", year: 2026 }],
          },
        }),
    })
    expect(await screen.findByText("An unfiled lattice paper")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "File it" })).toHaveAttribute("href", "/papers/new?publication=p1")
    expect(screen.getByRole("link", { name: /all 10 unfiled papers/i })).toHaveAttribute("href", "/papers?filter=unclaimed")
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

  it("says how far a claim has come and how long it has waited, never whose desk", async () => {
    mount([approved({ status: "PRINCIPAL_APPROVED", remuneration: 105_000, submitted_at: null, waiting_days: 21 })])
    const section = await screen.findByRole("region", { name: "Claims on the way" })
    expect(within(section).getByText(/Being checked · Filed 21 days ago/)).toBeInTheDocument()
    expect(within(section).getByText(/Filed 21 days ago/)).toBeInTheDocument()
    expect(within(section).getByText("₹1,05,000")).toBeInTheDocument()
    expect(within(section).getByText(/Taking longer than usual/)).toBeInTheDocument()
    // The college's rule: a claimant is never told which desk holds it.
    for (const desk of [/principal/i, /director/i, /finance/i, /research office/i]) {
      expect(screen.queryByText(desk)).toBeNull()
    }
    expect(within(section).getByRole("link", { name: /A finite element study/ })).toHaveAttribute("href", "/papers/c2")
  })

  it("does not show a legacy ERP number as a claim number", async () => {
    mount([approved({ ticket_number: "ERP-RAW-3" })])
    const section = await screen.findByRole("region", { name: "Claims on the way" })
    expect(section.textContent).not.toContain("ERP-RAW")
  })

  it("does not present a draft with no worked-out amount as ₹0", async () => {
    mount([claim({ status: "DRAFT", ticket_number: null, remuneration: 0, remuneration_is_estimate: true, paid_at: null })])
    expect(await screen.findByText(/last edited/i)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Finish and file" })).toHaveAttribute("href", "/papers/c1/edit")
    expect(screen.getByTestId("home-answer")).toHaveTextContent("1 draft is not filed")
  })

  it("puts a claim that was sent back first, with the reason and a way to fix it", async () => {
    mount([claim({ status: "REJECTED", status_note: "Attach the SEC reference PDFs", paid_at: null })])
    expect(await screen.findByText("Sent back to you")).toBeInTheDocument()
    expect(screen.getByText("Attach the SEC reference PDFs")).toBeInTheDocument()
    // The fix view lives on the claim page.
    expect(screen.getByRole("link", { name: /fix this claim/i })).toHaveAttribute("href", "/papers/c1#fix")
    expect(screen.getByTestId("home-answer")).toHaveTextContent("1 claim needs a fix from you")
  })

  it("adds nothing under Needs you when nothing is needed", async () => {
    mount([claim()])
    await screen.findByRole("button", { name: "20 papers" })
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull()
    expect(screen.getByTestId("home-answer")).toHaveTextContent("Nothing needs you")
  })

  it("draws the research threshold in the money section for research faculty", async () => {
    const research = {
      research: true,
      threshold: 300000,
      used: 14958,
      on_the_way: 0,
      left: 285042,
      year: "2026-27",
      message: "You are research faculty. Your threshold this year is ₹3,00,000.",
    }
    mount([claim()], [], { "/api/me/payments": () => ({ ...ledgerOf([claim()]), research }) })
    const box = await screen.findByTestId("research-threshold")
    expect(within(screen.getByRole("region", { name: "Your money" })).getByTestId("research-threshold")).toBe(box)
    expect(box).toHaveTextContent("Your threshold this year is ₹3,00,000")
  })

  it("draws no threshold for regular faculty", async () => {
    mount([claim()])
    await screen.findByRole("region", { name: "Your money" })
    expect(screen.queryByTestId("research-threshold")).toBeNull()
  })

  it("offers one colleague to write with, with a face and a link", async () => {
    mount([claim()], [], {
      "/api/discover/next": () => ({
        people: [
          {
            id: "u9",
            name: "Dr. Uma Rani V",
            initials: "UV",
            photo_url: null,
            department: "CSE",
            designation: "Associate Professor",
            papers: 29,
            reasons: ["Works in Computer Science, as you do."],
          },
        ],
        journals: [],
      }),
    })
    const link = await screen.findByRole("link", { name: "Dr. Uma Rani V" })
    expect(link).toHaveAttribute("href", "/u/u9")
    expect(screen.getByText("UV")).toBeInTheDocument()
    expect(screen.getByText(/Works in Computer Science/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Who to work with" })).toHaveAttribute("href", "/collaborate")
  })

  it("draws no suggestion, and no error, when there is nothing to suggest", async () => {
    mount([claim()], [], { "/api/discover/next": failing(500) })
    await screen.findByRole("button", { name: "20 papers" })
    expect(screen.queryByText("Something to try next")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("says a celebration in one quiet line, not a card", async () => {
    mount([claim()], [], {
      "/api/me/celebrations": () => ({
        celebrations: [
          { id: "1", kind: "BADGE", title: "New badge: First author", body: "A long body", created_at: "2026-09-01T00:00:00Z", badge: null },
          { id: "2", kind: "BADGE", title: "New badge: Six semesters", body: "Another", created_at: "2026-09-01T00:00:00Z", badge: null },
        ],
      }),
    })
    const line = await screen.findByRole("region", { name: "Something to celebrate" })
    expect(line).toHaveTextContent("New badge: First author and 1 more")
    expect(line.textContent).not.toContain("A long body")
    expect(within(line).getByRole("link", { name: "See your badges" })).toHaveAttribute("href", "/me#badges")
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

describe("what the reason is", () => {
  it("never shows a trace of an import as the college's reason", () => {
    expect(reasonOf("Imported from Raw_Data")).toBeNull()
    expect(reasonOf("ERP-RAW note")).toBeNull()
    expect(reasonOf("")).toBeNull()
    expect(reasonOf("Attach the SEC reference PDFs")).toBe("Attach the SEC reference PDFs")
  })

  it("sends a claim with only an import note to the fix page without inventing a reason", async () => {
    mount([claim({ status: "REJECTED", status_note: "Imported from Raw_Data", paid_at: null })])
    expect(await screen.findByText(/Open it to see what the college asked for/)).toBeInTheDocument()
    expect(screen.queryByText(/Raw_Data/)).toBeNull()
  })
})

describe("the record and the end of the journey", () => {
  it("draws the papers as a dot field by quartile, with real counts", async () => {
    mount([claim()], [], {
      "/api/me/home": () => record({ papers: 20, quartiles: { Q1: 3, Q2: 4, Q3: 2, Q4: 1, none: 10 } }),
    })
    const field = await screen.findByRole("img", {
      name: /20 papers: 3 in Q1 journals, 7 in Q2 to Q4 journals, 10 with no quartile/,
    })
    expect(field).toBeInTheDocument()
  })

  it("stamps money that reached the person this month or last, from the ledger", async () => {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
    const paid = claim({ id: "c9" })
    mount([paid], [], {
      "/api/me/payments": () => ({
        ...ledgerOf([paid]),
        rows: [
          {
            id: 1,
            claim_id: "c9",
            payout_month: ym,
            paper_title: "A finite element study of lattice struts",
            journal_title: null,
            amount: 9000,
            voucher_number: null,
          },
        ],
      }),
    })
    const box = await screen.findByTestId("just-paid")
    expect(box).toHaveTextContent("₹9,000")
    expect(box).toHaveTextContent(/reached you in/)
    expect(within(box).getByRole("img", { name: /^Paid/ })).toBeInTheDocument()
  })

  it("says nothing about a payment that is more than a month old", async () => {
    mount([claim()], [], {
      "/api/me/payments": () => ({
        ...ledgerOf([claim()]),
        rows: [
          { id: 1, claim_id: "c1", payout_month: "2020-01", paper_title: "Old", journal_title: null, amount: 9000, voucher_number: null },
        ],
      }),
    })
    await screen.findByRole("region", { name: "Your money" })
    expect(screen.queryByTestId("just-paid")).toBeNull()
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
    for (const desk of [/principal/i, /director/i, /finance/i, /research office/i]) {
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
