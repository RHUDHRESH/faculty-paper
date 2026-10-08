import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Research, paceLine, type MyResearch } from "@/pages/research"
import { FACULTY, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const ME: MyResearch = {
  headline: "You write about Language assessment and NLP.",
  metrics: { papers: 20, citations: 46, h_index: 3, i10_index: 1, q1: 2, first_author: 6, first_year: 2019, cited_papers: 9 },
  papers_by_year: [
    { year: 2024, count: 5 },
    { year: 2025, count: 9 },
    { year: 2026, count: 3 },
  ],
  citations_by_year: [
    { year: 2024, count: 10 },
    { year: 2025, count: 30 },
    { year: 2026, count: 6 },
  ],
  strip: [{ month: "2025-03", papers: 2 }],
  timeline: [
    { year: 2019, kind: "first_paper", text: "First paper: Something", ref: "p0" },
    { year: 2025, kind: "most_cited", text: "Most-cited paper (12 citations): Transformative", ref: "p1" },
  ],
  top_papers: [
    { id: "p1", title: "Transformative Approach", year: 2025, venue: "J Eng Ed", citations: 12, quartile: "Q2", doi: null, position: 2, authors: 6 },
  ],
  topics: [{ id: "language assessment", label: "Language assessment", papers: 8, recent: 5 }],
  venues: [{ id: "ieee", name: "IEEE Access", quartile: "Q1", papers: 3, colleagues: 4 }],
  mix: { "Journal article": 12, Conference: 8 },
  coauthors: {
    inside_count: 4,
    outside_count: 2,
    inside: [{ key: "u:t", user_id: "t", name: "Dr T. Jaya", department: "ECE", papers_together: 3, last_year_together: 2025, institutions: [] }],
    outside: [],
  },
  this_year: { year: 2026, papers: 3, same_date_last_year: 5, last_year_total: 9, target: 8, under_review: 1, drafts: 0 },
  ideas: [
    { kind: "topic", id: "speech", title: "Speech assessment", reason: "14 papers here in the last 12 months.", source: "counted", to: "/search?scope=topics&q=Speech" },
  ],
}

const COLLEGE = {
  totals: { papers: 1240, people: 300, departments: 23, this_year: 200, last_year: 310, citations: 9000 },
  papers_by_year: [
    { year: 2025, count: 310 },
    { year: 2026, count: 200 },
  ],
  topics: [
    { id: "la", label: "Language assessment", papers: 40, now: 10, before: 5, growth: 5, mine: true },
    { id: "ps", label: "Power systems", papers: 80, now: 20, before: 25, growth: -5, mine: false },
  ],
  rising: [{ id: "la", label: "Language assessment", now: 10, before: 5 }],
  departments: [{ name: "ECE", papers: 90 }],
  dept_topic: [{ dept: "ECE", topic: "ps", papers: 12 }],
  near_me: [{ id: "u2", name: "Dr S. Kanaga", department: "ECE", designation: "AP", papers: 3, reason: "3 papers on Language assessment" }],
  my_topics: ["la"],
}

function mount(route: string, extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/me/research": () => ME,
      "/api/college/research": () => COLLEGE,
      "/api/institution": () => ({ college_name: "Saveetha" }),
      ...extra,
    })
  )
  renderWithProviders(<Research />, { route })
}

describe("My research — Me", () => {
  it("answers past, present and future from the record", async () => {
    mount("/research")
    expect(await screen.findByText("You write about Language assessment and NLP.")).toBeInTheDocument()
    expect(screen.getByText("46")).toBeInTheDocument()
    expect(screen.getByText("Your record")).toBeInTheDocument()
    expect(screen.getByText("What you work on now")).toBeInTheDocument()
    expect(screen.getByText("Ideas for what's next")).toBeInTheDocument()
    expect(screen.getByText(/Most-cited paper \(12 citations\)/)).toBeInTheDocument()
    expect(screen.getByText("Dr T. Jaya")).toBeInTheDocument()
    const idea = screen.getByRole("heading", { name: "Speech assessment" }).closest("article")!
    expect(within(idea).getByText("Counted")).toBeInTheDocument()
    expect(within(idea).getByText("14 papers here in the last 12 months.")).toBeInTheDocument()
    expect(screen.getByText("3 papers so far in 2026. You're 2 behind last year's pace.")).toBeInTheDocument()
  })

  it("opens with four figures that open the papers behind them, and the pace sits under Present", async () => {
    mount("/research")
    const glance = await screen.findByRole("group", { name: "At a glance" })
    // Every number is a button now: it opens the list behind it in place.
    expect(within(glance).getByRole("button", { name: /papers on your record/ })).toBeInTheDocument()
    expect(within(glance).getByRole("button", { name: /citations, h-index 3/ })).toBeInTheDocument()
    expect(within(glance).getByRole("button", { name: /papers so far in 2026/ })).toBeInTheDocument()
    expect(within(glance).getByRole("button", { name: /as first author/ })).toBeInTheDocument()
    // The firsts, the most-cited papers, the journal and the co-author open too.
    expect(screen.getByRole("button", { name: /Most-cited paper \(12 citations\)/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Transformative Approach" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "J Eng Ed" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Dr T. Jaya" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "h-index 3" })).toBeInTheDocument()
    // The pace line is part of Present, not a footnote to Future.
    const present = screen.getByRole("region", { name: /What you work on now/ })
    expect(within(present).getByText(/so far in 2026/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/model/i)
  })

  it("says the record will build itself instead of showing zeros", async () => {
    mount("/research", {
      "/api/me/research": () => ({ ...ME, headline: null, metrics: { ...ME.metrics, papers: 0, citations: null, h_index: null }, ideas: [] }),
    })
    expect(await screen.findByText("Your record will build itself")).toBeInTheDocument()
    expect(screen.getByText("Citations arrive with your Scopus record")).toBeInTheDocument()
  })
})

describe("My research — The college", () => {
  it("shows the topic map with my topics marked, departments and people near me", async () => {
    mount("/research?tab=college")
    expect(await screen.findByText(/papers across 23 departments/)).toBeInTheDocument()
    expect(screen.getAllByText("Language assessment").length).toBeGreaterThan(0)
    expect(screen.getByLabelText("ECE, Power systems: 12 papers")).toBeInTheDocument()
    expect(screen.getByText("Dr S. Kanaga")).toBeInTheDocument()
  })

  it("keeps a failure to the college picture", async () => {
    mount("/research?tab=college", { "/api/college/research": failing(500) })
    expect(await screen.findByText("Could not load the college picture")).toBeInTheDocument()
    expect(screen.getByText("Your own record is unaffected.")).toBeInTheDocument()
  })
})

describe("This year", () => {
  it("speaks pace without any input", () => {
    const t = ME.this_year
    expect(paceLine({ ...t, papers: 0, same_date_last_year: 4 })).toBe("No papers yet in 2026. Last year you had 4 by now.")
    expect(paceLine({ ...t, papers: 6, same_date_last_year: 4 })).toBe("6 papers so far in 2026. You're 2 ahead of last year's pace.")
    expect(paceLine({ ...t, papers: 1, same_date_last_year: 1 })).toBe("1 paper so far in 2026. Same pace as last year.")
  })
})

describe("My research — your compass", () => {
  it("shows the headline and where you are on your compass, linking to it", async () => {
    mount("/research", {
      "/api/compass/summary": () => ({ headline: "You make small grids steadier.", path_name: "Q1 specialist", progress: { done: 2, total: 5 }, next_action: null }),
    })
    const card = await screen.findByRole("region", { name: "Your compass" })
    expect(within(card).queryByText("You make small grids steadier.")).toBeNull()
    expect(within(card).getByText("Your path: Q1 specialist · 2 of 5 done")).toBeInTheDocument()
    expect(within(card).getByRole("link", { name: "Open your compass" })).toHaveAttribute("href", "/compass")
  })

  it("invites you to start when there is no compass yet", async () => {
    mount("/research", {
      "/api/compass/summary": () => ({ headline: null, path_name: null, progress: null, next_action: null }),
    })
    expect(await screen.findByText("See who you are as a researcher and where you could go")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Start your compass" })).toHaveAttribute("href", "/compass")
  })
})
