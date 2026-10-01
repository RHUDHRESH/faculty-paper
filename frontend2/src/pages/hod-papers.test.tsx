import { screen, within } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { HodPaper } from "@/pages/hod-paper"
import { HodPapers } from "@/pages/hod-papers"
import { HOD, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The papers behind a head's figures, and one paper opened. Counted from the
 * college record, so the total is the number on Home; a row opens the paper and
 * never the claim behind it; nothing carries money.
 */

const PEOPLE = [
  { id: "u1", name: "Asha Physicist", designation: null, photo_url: null, is_you: false },
  { id: "u2", name: "Ravi Physicist", designation: null, photo_url: null, is_you: false },
]

const LIST = {
  total: 261,
  department: "Physics",
  years: [2026, 2025],
  by_quartile: { Q1: 8, Q2: 33, Q3: 20, Q4: 13, none: 187 },
  results: [
    {
      id: "pub1", source: "record", title: "Thin films under strain", journal: "Journal of Physics", year: 2026,
      quartile: "Q1", doi: "10.1/abc", issn: "1111-2222", indexed: true, citations: 3,
      authors: [{ user_id: "u1", name: "Asha Physicist", department: "Physics" }],
    },
    {
      id: "pub2", source: "record", title: "A paper with no DOI", journal: "", year: 2026,
      quartile: null, doi: null, issn: null, indexed: false, citations: null, authors: [],
    },
  ],
}

function mount(route: string, extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => HOD,
      "/api/hod/brief": () => ({ department: "Physics", year: 2026, people: PEOPLE }),
      "/api/hod/department/papers": () => LIST,
      ...extra,
    })
  )
  return renderWithProviders(
    <Routes>
      <Route path="/publications" element={<HodPapers />} />
      <Route path="/department/papers/:id" element={<HodPaper />} />
    </Routes>,
    { route }
  )
}

describe("Department papers", () => {
  it("says how many papers, from the record, and offers them as a download with the same filter", async () => {
    mount("/publications?year=2026&quartile=Q1")
    expect(await screen.findByText("261 papers")).toBeInTheDocument()
    expect(screen.getByText(/the same papers the Principal counts for Physics/)).toBeInTheDocument()
    const dl = screen.getByRole("link", { name: /Download these 261 papers/ })
    expect(dl.getAttribute("href")).toBe("/api/hod/department/papers/export?year=2026&quartile=Q1")
  })

  it("puts four figures under the title that each filter the list", async () => {
    mount("/publications?year=2026")
    await screen.findByText("261 papers")
    const glance = await screen.findByRole("group", { name: "At a glance" })
    const hrefs = within(glance).getAllByRole("link").map((l) => l.getAttribute("href"))
    expect(hrefs).toEqual([
      "/publications?year=2026&quartile=Q1",
      "/publications?year=2026&quartile=Q2",
      "/publications?year=2026&quartile=low",
      "/publications?year=2026&quartile=none",
    ])
    expect(glance).toHaveTextContent("187")
  })

  it("has a heading on every column, opens the paper (not a claim), and says what is missing in words", async () => {
    mount("/publications")
    const table = await screen.findByRole("table")
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent?.trim())
    expect(heads).toEqual(["Paper", "Authors", "Journal", "Year", "Quartile", "DOI"])
    const first = within(table).getByRole("link", { name: "Thin films under strain" })
    expect(first).toHaveAttribute("href", "/department/papers/pub1")
    expect(within(table).getByRole("link", { name: "Asha Physicist" })).toHaveAttribute("href", "/faculty/u1")
    expect(within(table).getByText("No DOI")).toBeInTheDocument()
    expect(within(table).getAllByText("Not recorded").length).toBeGreaterThan(0)
  })

  it("shows the missing-DOI filter as a chip that can be removed", async () => {
    mount("/publications?missing=doi")
    expect(await screen.findByRole("button", { name: /Remove the filter: Papers missing a DOI/ })).toBeInTheDocument()
  })

  it("shows an error with a retry, never an empty list", async () => {
    mount("/publications", { "/api/hod/department/papers": failing(500) })
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument()
    expect(screen.queryByText("No paper matches")).toBeNull()
  })

  it("says what to do when a filter matches nothing", async () => {
    mount("/publications?q=zzz", {
      "/api/hod/department/papers": () => ({ ...LIST, total: 0, results: [], by_quartile: {} }),
    })
    expect(await screen.findByText("No paper matches")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Clear filters" }).length).toBeGreaterThan(0)
  })

  it("shows no rupee figure", async () => {
    mount("/publications")
    await screen.findByRole("table")
    expect(document.body.textContent).not.toContain("₹")
  })
})

const PAPER = {
  source: "record", id: "pub1", ticket_number: null, paper_title: "Thin films under strain",
  journal_title: "Journal of Physics", issn: null, doi: "10.1/abc", publication_year: 2026,
  publication_date: "2026-02-01", quartile: "Q1", snip: null, indexing_level: "Scopus",
  publication_type: "conference-paper", author_position: 1, total_authors: 3, owner_id: "u1",
  owner_name: "Asha Physicist", owner_department: "Physics", scopus_url: null, progress: null,
  citations: 4, scopus_citations: 5, oa_url: null, topics: ["Thin films"],
  authors: [
    { name: "Dr Outside", position: 1, user_id: null, is_college: false, in_department: false },
    { name: "Asha Physicist", position: 2, user_id: "u1", is_college: true, in_department: true },
  ],
}

describe("One paper", () => {
  it("shows the record's facts in words, the department's authors first, and no claim status", async () => {
    mount("/department/papers/pub1", { "/api/hod/papers/pub1": () => PAPER })
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Thin films under strain")
    expect(screen.getByText("Conference paper")).toBeInTheDocument()
    expect(screen.getByText("None: not a journal article")).toBeInTheDocument()
    expect(screen.getByText("1 February 2026")).toBeInTheDocument()
    expect(screen.queryByText(/Where its claim stands/)).toBeNull()
    const authors = screen.getByRole("region", { name: /Authors/ })
    const items = within(authors).getAllByRole("listitem").map((li) => li.textContent)
    expect(items[0]).toContain("Asha Physicist")
    expect(items[0]).toContain("Your department")
    expect(items[1]).toContain("Outside the college")
    expect(screen.getByRole("link", { name: "Read the paper" })).toHaveAttribute("href", "https://doi.org/10.1/abc")
  })

  it("says where a colleague's claim stands in words, never which desk", async () => {
    mount("/department/papers/c1", {
      "/api/hod/papers/c1": () => ({ ...PAPER, source: undefined, ticket_number: "FP-2026-000001", progress: "Under review", publication_type: "Article", issn: "1234-5678" }),
    })
    expect(await screen.findByText("Under review")).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/principal|director|finance|research cell|₹/i)
  })

  it("explains a paper that is not from the department, with no retry that cannot help", async () => {
    mount("/department/papers/x", { "/api/hod/papers/x": failing(404, "No paper") })
    expect(await screen.findByText("Not a paper from your department")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })
})
