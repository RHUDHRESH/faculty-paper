import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { PastCases, PastCasesView, type PastCasesData } from "@/ui/past-cases"
import { fakeApi, failing, renderWithProviders } from "@/test/harness"

const earlier = {
  id: "c-old",
  ticket_number: "FP-2025-000004",
  paper_title: "An earlier paper sent back",
  journal_title: "Other Journal",
  publication_year: 2025,
  filed_on: "2025-03-01T00:00:00Z",
  status: "REJECTED",
  outcome: { key: "sent_back", label: "Sent back" },
  remuneration: 9000,
  send_backs: [
    { reason: "The college name is missing from the byline", kind: "faculty" as const, by: "R Cell", when: "2025-03-05T00:00:00Z" },
  ],
}

const data: PastCasesData = {
  claim_id: "c-now",
  own_claim: false,
  can_see_flags: true,
  claimant: { user_id: "u-asha", name: "Asha Faculty", department: "CSE" },
  previous_claims: [earlier],
  previous_total: 1,
  co_author_claims: [
    {
      ...earlier,
      id: "c-co",
      ticket_number: "ERP-PROCESSED-120",
      paper_title: "The same paper, claimed by a co-author",
      outcome: { key: "paid", label: "Paid" },
      send_backs: [],
      owner_id: "u-nila",
      owner_name: "Nila Coauthor",
    },
  ],
  journal: {
    title: "Nature",
    tally: { total: 3, paid: 1, in_progress: 1, sent_back: 1, rejected: 0 },
    recent: [{ ...earlier, id: "c-j", ticket_number: "FP-2026-000011", paper_title: "Another Nature paper", owner_name: "Nila Coauthor", owner_id: "u-nila", send_backs: [] }],
  },
  matches: {
    duplicates: [{ id: "c-co", source: "claim", title: "Same title", amount: 7000, reference: "ERP-PROCESSED-120", who: "Nila Coauthor", when: "2026-01" }],
    ledger: [{ id: "l-1", paper_title: "Same title", faculty_name: "Asha Faculty", month: "2026-02", voucher_number: "V-77", amount: 5000, claim_id: null }],
  },
}

describe("past cases", () => {
  it("groups the claimant's history, the same paper, the journal and payment matches", () => {
    renderWithProviders(<PastCasesView data={data} />)
    expect(screen.getByRole("heading", { name: /Earlier claims by Asha Faculty/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /The same paper, claimed by others/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /Nature at the college/ })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /Payment history matches/ })).toBeInTheDocument()
    expect(screen.getByText(/3 claims at the college: 1 paid, 1 in progress, 1 sent back\./)).toBeInTheDocument()
    expect(screen.getAllByText("Nila Coauthor", { selector: "span" }).length).toBeGreaterThan(0)
  })

  it("shows the outcome, the amount and the send-back reason of an earlier claim", () => {
    renderWithProviders(<PastCasesView data={data} />)
    const heading = screen.getByRole("heading", { name: /Earlier claims by/ })
    const group = heading.parentElement as HTMLElement
    expect(within(group).getByText("Sent back")).toBeInTheDocument()
    expect(within(group).getByText("₹9,000")).toBeInTheDocument()
    expect(within(group).getByText(/The college name is missing from the byline/)).toBeInTheDocument()
  })

  it("links every claim to its own page", () => {
    renderWithProviders(<PastCasesView data={data} />)
    expect(screen.getByRole("link", { name: "An earlier paper sent back" })).toHaveAttribute("href", "/papers/c-old")
    expect(screen.getByRole("link", { name: "The same paper, claimed by a co-author" })).toHaveAttribute("href", "/papers/c-co")
    expect(screen.getByRole("link", { name: "Another Nature paper" })).toHaveAttribute("href", "/papers/c-j")
  })

  it("leaves out payment history when the server did not send it (Director, Finance)", () => {
    const { matches: _matches, ...blind } = data
    renderWithProviders(<PastCasesView data={{ ...blind, can_see_flags: false }} />)
    expect(screen.queryByRole("heading", { name: /Payment history matches/ })).toBeNull()
    expect(screen.getByRole("heading", { name: /Earlier claims by/ })).toBeInTheDocument()
  })

  it("draws no amount where the server sent none", () => {
    const bare = (c: (typeof data.previous_claims)[number]) => ({ ...c, remuneration: undefined })
    const stripped = {
      ...data,
      previous_claims: data.previous_claims.map(bare),
      co_author_claims: data.co_author_claims.map(bare),
      journal: { ...data.journal, recent: data.journal.recent.map(bare) },
      matches: { duplicates: [], ledger: [] },
    }
    renderWithProviders(<PastCasesView data={stripped} />)
    expect(screen.queryByText("₹9,000")).toBeNull()
  })

  it("says a first claim is a first claim", () => {
    renderWithProviders(
      <PastCasesView data={{ ...data, previous_claims: [], previous_total: 0, journal: { title: null, tally: null, recent: [] }, co_author_claims: [], matches: { duplicates: [], ledger: [] } }} />
    )
    expect(screen.getByText(/No earlier claims by Asha Faculty/)).toBeInTheDocument()
  })

  it("does not show a reviewer's own claim's past cases", () => {
    renderWithProviders(<PastCasesView data={{ ...data, own_claim: true }} />)
    expect(screen.getByText(/This is your own claim/)).toBeInTheDocument()
    expect(screen.queryByRole("heading")).toBeNull()
  })
})

describe("<PastCases> by role", () => {
  const context = (claimId: string) => `/api/claims/${claimId}/context`

  it("asks nothing for a faculty member or a head of department", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ [context("c-now")]: () => data }))
    for (const role of ["FACULTY", "HOD", null, undefined]) {
      const { container, unmount } = renderWithProviders(<PastCases claimId="c-now" role={role} />)
      await new Promise((r) => setTimeout(r, 30))
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
    expect(vi.mocked(api).mock.calls.filter(([p]) => String(p).includes("/context"))).toHaveLength(0)
  })

  it("loads and draws the history for a reviewer", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ [context("c-now")]: () => data }))
    renderWithProviders(<PastCases claimId="c-now" role="RESEARCH_CELL" />)
    expect(await screen.findByRole("heading", { name: /Earlier claims by Asha Faculty/ })).toBeInTheDocument()
  })

  it("says so, and leaves the claim alone, when it cannot load", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ [context("c-now")]: failing(500) }))
    renderWithProviders(<PastCases claimId="c-now" role="PRINCIPAL" />)
    expect(await screen.findByText(/Past cases could not be loaded/)).toBeInTheDocument()
  })
})
