import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { CollegeResearch, Programme } from "@/pages/programme"
import { fakeApi, FACULTY, renderWithProviders } from "@/test/harness"

/**
 * The owner's rule: "Joyal's research and other people's research should
 * show only their work." The college-wide picture lives on its own page.
 */

const MINE = {
  papers: [
    {
      id: "c1",
      title: "Asha's own paper",
      journal_title: "Wear",
      publication_year: 2025,
      quartile: "Q1",
      doi: null,
      author_position: 1,
      total_authors: 2,
      coauthors: [],
    },
  ],
  counts: { papers: 1, q1: 1, first_author: 1, areas: 1 },
  areas: [{ key: "Tribology", count: 1 }],
  coauthors: [],
  interests: [],
  search_terms: ["Tribology"],
  totals: { my_papers: 1, my_areas: 1 },
  classified: 1,
}

function calls() {
  return vi.mocked(api).mock.calls.map(([p]) => String(p))
}

describe("Programme", () => {
  it("shows only the person's own work, and never asks for the college's", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/programme/me": () => MINE,
      })
    )
    renderWithProviders(<Programme />, { route: "/programme" })

    expect(await screen.findByText("Asha's own paper")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Asha's research" })).toBeInTheDocument()
    expect(screen.queryByText(/What this college is working on/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Who to work with/)).not.toBeInTheDocument()
    expect(calls().some((p) => p.startsWith("/api/trends/me"))).toBe(false)
    expect(calls().some((p) => p.startsWith("/api/programme/around"))).toBe(false)
    expect(screen.getByRole("link", { name: /The college's research/ })).toHaveAttribute("href", "/research")
  })
})

describe("CollegeResearch", () => {
  it("is where the college picture and the people nearby went", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/trends/me": () => ({
          college: {
            window: { latest_year: 2025, recent_from: 2023, recent_to: 2025, prior_from: 2020, prior_to: 2022 },
            totals: {
              papers: 0, papers_prior: 0, classified: 0, unclassified: 0, areas: 0, departments: 0,
              people: 0, truncated: false, comparable: false, not_comparable_why: null,
            },
            areas: [], rising: [], fading: [], departments: [], journals: [], years: [],
          },
          people: { people: [], grounded_on: { areas: [], interests: [], since: 2023 }, why_empty: null },
          ai: { available: false, code: null, detail: null, model: "", provider: null },
        }),
        "/api/programme/around": () => ({ areas: [], colleagues: [], live: [] }),
      })
    )
    renderWithProviders(<CollegeResearch />, { route: "/research" })
    expect(await screen.findByRole("heading", { name: "What this college is working on" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Who to work with" })).toBeInTheDocument()
  })
})
