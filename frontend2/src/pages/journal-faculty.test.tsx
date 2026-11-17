import { screen, within } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { standingLines, type FacultyJournal } from "@/pages/journal-faculty"
import { JournalRecord } from "@/pages/journals"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

const PAYLOAD: FacultyJournal = {
  view: "faculty",
  journal: {
    title: "Journal of Synthetic Ceramics",
    issn: "0272-8842",
    eissn: "1873-3956",
    publisher: "Synthetic Press",
    subject_category: "Ceramics",
    indexing: "Scopus",
    engineering_class: "Engineering",
    snip_by_year: [{ year: 2025, snip: 1.4 }, { year: 2024, snip: 1.1 }],
    sjr_by_year: [
      { year: 2025, sjr: 0.96, best_quartile: "Q1", categories: [{ category: "Ceramics and Composites", quartile: "Q1" }, { category: "Chemistry", quartile: "Q3" }] },
      { year: 2024, sjr: 0.81, best_quartile: "Q2", categories: [{ category: "Ceramics and Composites", quartile: "Q2" }] },
    ],
    standing: {
      scopus_discontinued: { state: "not_discontinued", since: null, reason: null },
      ugc_care: { state: "removed", since: "2025-01-01", reason: "Removed in the 2025 review" },
    },
  },
  mine: {
    count: 1,
    claims: [{ id: "c-mine", ticket_number: "FP-2025-000111", paper_title: "My own ceramic paper", publication_year: 2025, status: "PAID", quartile: "Q1", snip: 1.4, remuneration: 41417, remuneration_is_estimate: false }],
  },
}

function mount(payload: unknown) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, "/api/journals/report": () => payload }))
  renderWithProviders(
    <Routes>
      <Route path="/journals/:title" element={<JournalRecord />} />
    </Routes>,
    { route: "/journals/Journal%20of%20Synthetic%20Ceramics" }
  )
}

describe("a journal, for a faculty member", () => {
  it("shows the journal's facts instead of a closed gate", async () => {
    mount(PAYLOAD)
    expect(await screen.findByRole("heading", { name: "Journal of Synthetic Ceramics" })).toBeInTheDocument()
    expect(screen.queryByText(/Not visible to this account/)).toBeNull()
    expect(screen.getByText("Synthetic Press")).toBeInTheDocument()
    expect(screen.getByText(/ISSN 0272-8842/)).toBeInTheDocument()
    expect(screen.getByText(/eISSN 1873-3956/)).toBeInTheDocument()
    expect(screen.getByText("Engineering")).toBeInTheDocument()
    const years = screen.getByRole("table", { name: "SNIP, SJR and best quartile by year" })
    expect(within(years).getByText("1.400")).toBeInTheDocument()
    expect(within(years).getByText("0.810")).toBeInTheDocument()
    const subjects = screen.getByRole("table", { name: "Quartile in each subject category, by year" })
    expect(within(subjects).getByText("Chemistry")).toBeInTheDocument()
    expect(within(subjects).getByText("Not listed")).toBeInTheDocument()
  })

  it("says plainly when the UGC-CARE list has removed it, and when a list was never loaded", async () => {
    mount(PAYLOAD)
    expect(await screen.findByText(/UGC-CARE list has removed this journal \(since 1 Jan 2025\)/)).toBeInTheDocument()
    const unknown = standingLines({
      scopus_discontinued: { state: "unknown", since: null, reason: null },
      ugc_care: { state: "unknown", since: null, reason: null },
    })
    expect(unknown.map((l) => l.text).join(" ")).toMatch(/not loaded .* so this is not checked/)
  })

  it("lists only their own papers there, each linked to their own claim, with their own amount", async () => {
    mount(PAYLOAD)
    const link = await screen.findByRole("link", { name: /My own ceramic paper/ })
    expect(link).toHaveAttribute("href", "/papers/c-mine")
    expect(screen.getByText("₹41,417")).toBeInTheDocument()
    // The college's view is not drawn: no authors, no department split, no totals.
    expect(screen.queryByText("Who publishes here")).toBeNull()
    expect(screen.queryByText("Departments")).toBeNull()
    expect(screen.queryByText(/paid out/)).toBeNull()
  })

  it("points to the journal check when they have no paper there", async () => {
    mount({ ...PAYLOAD, mine: { count: 0, claims: [] } })
    expect(await screen.findByText(/You have no claim in this journal/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Check a journal before you submit" })).toHaveAttribute("href", "/journal-check")
  })
})
