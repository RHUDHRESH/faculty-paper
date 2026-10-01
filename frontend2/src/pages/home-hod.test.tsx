import { fireEvent, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { HodHome } from "@/pages/home-hod"
import { HOD, failing, fakeApi, ledgerOf, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * A head of department is also a faculty member who files their own papers
 * (2026-09-23). Their home answers the three questions a head is asked every
 * month, from the college's publication record, and keeps their own papers
 * with their own amounts below.
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

const person = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, designation: "Assistant Professor", photo_url: null, is_you: false,
  this_year: 0, last_year: 2, q1_this_year: 0, led_this_year: 0, total: 5,
  last_year_published: 2025, area: null, has_scopus_id: true, target: null, last_reminded_at: null,
  ...over,
})

const ASHA = person("p1", "Asha Quiet")
const RAVI = person("p2", "Ravi Steady", { last_year: 0, total: 0, has_scopus_id: false })
const QUAL = person("p3", "Uma Quality", { this_year: 3, q1_this_year: 0 })

function brief(over: Record<string, unknown> = {}) {
  return {
    department: "Physics", year: 2026, as_of: "2026-09-28", elapsed: 0.74, months_left: 3,
    totals: {
      publications: 261, q1: 8, quartile_known: 74, first_author: 106, faculty: 73, faculty_published: 59, silent: 14,
      per_teacher: 3.6, last_year_full: 373, last_year_to_date: 240, this_year_to_date: 254,
      missing_doi: 4, missing_issn: 116, missing_issn_or_doi: 15, record_papers: 260, scopus_indexed: 224, without_scopus_id: 9,
    },
    college: { per_teacher: 2.7, papers: 1126, top_quartile_share: 60, rank: 4, of: 20 },
    targets: [{
      metric: "PUBLICATIONS", label: "Publications", target: 300, done: 261, expected_by_now: 224.4,
      verdict: "on_track", due_date: null, to_go: 39, months_left: 3, per_month_needed: 13,
    }],
    by_year: [], people: [ASHA, RAVI, QUAL],
    push: [
      { person: ASHA, reasons: ["No paper in 2026; 2 in 2025"], kind: "slipped", next_step: "Ask what is in progress and remind them to file it.", draft: "A reminder from your head of department: you had 2 papers in 2025 and none for 2026." },
      { person: RAVI, reasons: ["No paper on record, and no Scopus ID on file"], kind: "never", next_step: "Ask for their Scopus ID, then talk about a first paper.", draft: "A reminder from your head of department: please add your Scopus ID." },
      { person: QUAL, reasons: ["No Q1 paper since 2023 or earlier"], kind: "no_q1", next_step: "Pair them with a colleague.", draft: "A reminder from your head of department: aim for Q1." },
    ],
    pairs: [], years: [2026, 2025],
    ...over,
  }
}

const TRACK = {
  scope: "department", department: "Physics", sees_money: false, sees_flags: false, total_claims: 19, total: 19,
  departments: [], months: [], results: [],
  stages: [
    { key: "review", label: "Under review", caption: "", count: 3, oldest_days: 91, average_days: 86, ageing: { week: 0, fortnight: 0, month: 0, older: 3 } },
    { key: "completed", label: "Completed", caption: "", count: 16, oldest_days: null, average_days: null, ageing: null },
  ],
}

function mount(claims: ReturnType<typeof claim>[], extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => HOD,
      "/api/hod/brief": () => brief(),
      "/api/track": () => TRACK,
      "/api/claims": () => ({ results: claims, total: claims.length }),
      "/api/me/payments": () => ledgerOf(claims),
      ...extra,
    })
  )
  renderWithProviders(<HodHome />)
}

describe("HodHome", () => {
  it("opens with the one sentence a head can say to the Principal", async () => {
    mount([])
    const answer = await screen.findByTestId("report-answer")
    expect(answer).toHaveTextContent("Physics has 261 papers in 2026 so far")
    expect(answer).toHaveTextContent("target of 300")
    expect(answer).toHaveTextContent("39 to go in 3 months, about 13 a month")
  })

  it("puts four figures under it, each a link to the list behind it", async () => {
    mount([])
    const glance = await screen.findByRole("group", { name: "At a glance" })
    const links = within(glance).getAllByRole("link")
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/publications?year=2026",
      "/department?tab=faculty",
      "/department#push",
      "/department?tab=records",
    ])
    expect(glance).toHaveTextContent("59 of 73")
    expect(glance).toHaveTextContent("15")
  })

  it("lists who to talk to first, with a reason and a next step, and no quality reasons yet", async () => {
    mount([])
    const push = await screen.findByRole("region", { name: "Who needs a push" })
    expect(within(push).getByText("Asha Quiet")).toBeInTheDocument()
    expect(within(push).getByText("No paper in 2026; 2 in 2025")).toBeInTheDocument()
    expect(within(push).getByText(/Ask what is in progress/)).toBeInTheDocument()
    expect(within(push).getByText(/no Scopus ID on file/)).toBeInTheDocument()
    expect(within(push).queryByText("Uma Quality")).toBeNull()
    expect(within(push).getByRole("button", { name: "Remind Asha Quiet" })).toBeInTheDocument()
  })

  it("opens an editable draft before any reminder is sent", async () => {
    mount([])
    fireEvent.click(await screen.findByRole("button", { name: "Remind Asha Quiet" }))
    const box = await screen.findByRole("textbox", { name: "Message" })
    expect((box as HTMLTextAreaElement).value).toContain("you had 2 papers in 2025")
    expect(screen.getByRole("button", { name: "Send reminder" })).toBeEnabled()
  })

  it("offers the monthly note as a download", async () => {
    mount([])
    const note = await screen.findByRole("link", { name: /Download the note for the Principal/ })
    expect(note).toHaveAttribute("href", "/api/hod/report?fmt=pdf&year=2026")
  })

  it("says where the department's claims are without naming a desk or an amount", async () => {
    mount([])
    const line = await screen.findByText(/3 claims are being checked by the college/)
    expect(line).toHaveTextContent("the longest for 91 days")
    expect(line).toHaveTextContent("16 are complete")
    expect(line.textContent).not.toMatch(/₹|principal|director|finance|research cell/i)
  })

  it("does not show all-years or claim-based rank figures", async () => {
    mount([])
    await screen.findByTestId("report-answer")
    expect(screen.queryByText(/Against the college/)).toBeNull()
    expect(screen.queryByText("Who has published")).toBeNull()
  })

  it("shows a refusal for an account with no department, with no retry that cannot help", async () => {
    mount([], { "/api/hod/brief": failing(400, "This account has no department set") })
    expect(await screen.findByText(/Could not load the department's year/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })

  it("shows a dropped request as an error with a retry, not as zeros", async () => {
    mount([], { "/api/hod/brief": failing(500) })
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument()
    expect(screen.queryByTestId("report-answer")).toBeNull()
  })
})

describe("HodHome, the head's own papers", () => {
  it("shows the head's own papers with their own amounts", async () => {
    mount([claim()])
    const mine = await screen.findByRole("region", { name: "Your own papers" })
    expect(await within(mine).findAllByText("₹42,137")).not.toHaveLength(0)
    expect(within(mine).getByText("Thin films under strain")).toBeInTheDocument()
    expect(within(mine).getByRole("link", { name: /File a paper/ })).toHaveAttribute("href", "/papers/new")
  })

  it("draws the claimant's journey for a paper still moving, and never names a desk", async () => {
    mount([
      claim({ id: "c2", status: "CLEARED", faculty_stage: "Under review", days_waiting: 12, remuneration: 18_000, paid_at: null }),
    ])
    const mine = await screen.findByRole("region", { name: "Your own papers" })
    expect(await within(mine).findAllByText("Being checked")).not.toHaveLength(0)
    expect(within(mine).getByText(/waiting 12 days/i)).toBeInTheDocument()
    for (const desk of [/principal/i, /director/i, /finance/i, /research cell/i]) {
      expect(within(mine).queryByText(desk)).toBeNull()
    }
  })

  it("invites a head with nothing filed to file, without a ₹0 record", async () => {
    mount([])
    const mine = await screen.findByRole("region", { name: "Your own papers" })
    expect(await within(mine).findByText(/nothing filed yet/i)).toBeInTheDocument()
    expect(within(mine).queryByText("₹0")).toBeNull()
  })

  it("shows a failure for their own papers, not an empty record", async () => {
    mount([], { "/api/claims": failing(500) })
    const mine = await screen.findByRole("region", { name: "Your own papers" })
    expect(await within(mine).findByText(/could not load your papers/i)).toBeInTheDocument()
    expect(within(mine).queryByText("₹0")).toBeNull()
  })
})
