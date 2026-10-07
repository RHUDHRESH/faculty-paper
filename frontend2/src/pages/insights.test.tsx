import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Insights } from "@/pages/insights"
import type { InsightAnswer, InsightSuggestions } from "@/pages/insights"
import { HOD, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const PRINCIPAL: Me = { id: "u-principal", email: "p@x.edu", name: "Dr Vijaya", role: "PRINCIPAL", department: null }

const QUERIES = [
  { key: "top_journals", title: "Where we publish most", params: ["department", "year", "quartile", "limit"], money: false },
  { key: "papers_compare", title: "This year against last", params: ["department", "year", "quartile"], money: false },
  { key: "payouts_by", title: "What we paid out", params: ["department", "financial_year", "by"], money: true },
]

function suggestions(over: Partial<InsightSuggestions> = {}): InsightSuggestions {
  return {
    chips: [
      { label: "Which journals did we publish in most in 2025?", query: "top_journals", params: { year: 2025 } },
      { label: "How much did we pay out per department this financial year?", query: "payouts_by", params: { by: "department" } },
    ],
    departments: ["CSE", "ECE", "Physics"],
    department: null,
    years: [2026, 2025, 2024],
    financial_years: [{ value: 2026, label: "FY 2026-27" }],
    queries: QUERIES,
    ai: true,
    ...over,
  }
}

function journals(over: Partial<InsightAnswer> = {}): InsightAnswer {
  return {
    answer: "ECE published most in IEEE Access in 2025: 12 papers.",
    query: "top_journals",
    title: "Where we publish most",
    params: { department: "ECE", year: 2025, year_to: null, quartile: null, type: null, limit: 10 },
    param_keys: ["department", "year", "year_to", "quartile", "type", "limit"],
    chart: "bar",
    unit: "count",
    series_label: "Papers",
    value_label: "Papers",
    series: [
      { label: "IEEE Access", value: 12 },
      { label: "Data Journal", value: 4 },
    ],
    rows: [
      { kind: "journal", id: "IEEE Access", label: "IEEE Access", value: 12, detail: "" },
      { kind: "journal", id: "Data Journal", label: "Data Journal", value: 4, detail: "" },
    ],
    total_rows: 2,
    counted_how: "Papers are the publication record plus recognised claim papers it does not hold.",
    counted: false,
    refused: false,
    off_topic: false,
    notices: [],
    ...over,
  }
}

function mixed(): InsightAnswer {
  return journals({
    answer: "Dr Meena Iyer has the most first-author papers in CSE: 2.",
    query: "top_people",
    rows: [
      { kind: "person", id: "u1", label: "Dr Meena Iyer", value: 2, detail: "CSE", user_id: "u1", name: "Dr Meena Iyer" },
      { kind: "paper", id: "p1", label: "Graph learning", value: null, detail: "Data Journal · 2025", claim_id: "c9", doi: null, source: "record" },
      { kind: "paper", id: "p2", label: "Compilers", value: null, detail: "", claim_id: null, doi: "10.1/x", source: "record" },
      { kind: "claim", id: "c3", label: "Waiting claim", value: 40, detail: "Submitted", is_mine: false },
      { kind: "topic", id: "edge computing", label: "Edge Computing", value: 3, detail: "up from 1" },
    ],
    total_rows: 40,
  })
}

function sent(path: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p) === path)
}

function mount(me: Me, table: ApiTable) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => me, ...table }))
  renderWithProviders(<Insights />, { route: "/insights" })
  return userEvent.setup()
}

describe("Ask the data", () => {
  it("asks, and shows the answer, the chart, how it was counted and the list", async () => {
    const user = mount(PRINCIPAL, {
      "/api/insights/suggestions": () => suggestions(),
      "/api/insights/ask": () => journals(),
    })
    await user.type(await screen.findByRole("textbox", { name: "Your question" }), "Which journals did ECE use most in 2025?")
    await user.click(screen.getByRole("button", { name: "Ask" }))

    expect(await screen.findByText("ECE published most in IEEE Access in 2025: 12 papers.")).toBeInTheDocument()
    expect(sent("/api/insights/ask")[0][1]).toMatchObject({ method: "POST", json: { question: "Which journals did ECE use most in 2025?" } })
    // The chart, with its numbers table.
    expect(screen.getByRole("heading", { name: "Where we publish most" })).toBeInTheDocument()
    expect(screen.getByText("Show the numbers")).toBeInTheDocument()
    // How it was counted.
    expect(screen.getByText(/publication record plus recognised claim papers/)).toBeInTheDocument()
    // The list behind it: journals open the journal search.
    const list = screen.getByRole("list", { name: "What this counts" })
    expect(within(list).getByRole("link", { name: "IEEE Access" })).toHaveAttribute("href", "/search?scope=journals&q=IEEE%20Access")
    // The download carries the query and its settings.
    const csv = screen.getByRole("link", { name: /Download CSV/ })
    expect(csv.getAttribute("href")).toMatch(/^\/api\/insights\/run\.csv\?query=top_journals&/)
    expect(csv.getAttribute("href")).toContain("department=ECE")
    expect(csv.getAttribute("href")).toContain("year=2025")
  })

  it("links each kind of row to where it lives", async () => {
    const user = mount(PRINCIPAL, {
      "/api/insights/suggestions": () => suggestions(),
      "/api/insights/ask": () => mixed(),
    })
    await user.type(await screen.findByRole("textbox", { name: "Your question" }), "Who leads in CSE?{Enter}")
    const list = await screen.findByRole("list", { name: "What this counts" })
    expect(within(list).getByRole("link", { name: "Dr Meena Iyer" })).toHaveAttribute("href", "/u/u1")
    expect(within(list).getByRole("link", { name: "Graph learning" })).toHaveAttribute("href", "/papers/c9")
    expect(within(list).getByRole("link", { name: /Compilers/ })).toHaveAttribute("href", "https://doi.org/10.1/x")
    expect(within(list).getByRole("link", { name: "Waiting claim" })).toHaveAttribute("href", "/review/c3")
    expect(within(list).getByRole("link", { name: "Edge Computing" })).toHaveAttribute("href", "/search?q=Edge%20Computing")
    expect(screen.getByText(/Showing 5 of 40/)).toBeInTheDocument()
  })

  it("runs a suggestion without typing, and refines it by its settings", async () => {
    const user = mount(PRINCIPAL, {
      "/api/insights/suggestions": () => suggestions(),
      "/api/insights/run": () => journals({ counted: true }),
    })
    await user.click(await screen.findByRole("button", { name: "Which journals did we publish in most in 2025?" }))
    expect(await screen.findByText("ECE published most in IEEE Access in 2025: 12 papers.")).toBeInTheDocument()
    expect(sent("/api/insights/run")[0][1]).toMatchObject({ method: "POST", json: { query: "top_journals", params: { year: 2025 } } })
    expect(screen.queryByRole("textbox", { name: "Your question" })).toHaveValue("")

    await user.selectOptions(screen.getByRole("combobox", { name: "Year" }), "2024")
    await waitFor(() => expect(sent("/api/insights/run")).toHaveLength(2))
    expect(sent("/api/insights/run")[1][1]).toMatchObject({ json: { query: "top_journals", params: { year: 2024, department: "ECE" } } })
  })

  it("shows a head no money question, even one the server sent by mistake", async () => {
    const user = mount(HOD, {
      "/api/insights/suggestions": () =>
        suggestions({
          department: "Physics",
          departments: ["Physics"],
          chips: [
            { label: "Which journals did Physics publish in most in 2025?", query: "top_journals", params: { year: 2025 } },
            { label: "How much did we pay out per department this financial year?", query: "payouts_by", params: {} },
          ],
        }),
      "/api/insights/run": () => journals({ answer: "Physics published most in Physics Letters in 2025: 3 papers.", params: { department: "Physics", year: 2025 } }),
    })
    const chips = await screen.findByRole("group", { name: "Try asking" })
    expect(within(chips).getByRole("button", { name: /Physics publish in most/ })).toBeInTheDocument()
    expect(within(chips).queryByRole("button", { name: /pay out/ })).not.toBeInTheDocument()
    await user.click(within(chips).getByRole("button", { name: /Physics publish in most/ }))
    expect(await screen.findByText(/Physics Letters/)).toBeInTheDocument()
    // A head's department is theirs, not a setting to change.
    expect(screen.queryByRole("combobox", { name: "Department" })).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/₹/)
  })

  it("says a refusal and the AI being off quietly, in place", async () => {
    const user = mount(HOD, {
      "/api/insights/suggestions": () => suggestions({ department: "Physics", departments: ["Physics"], chips: [], ai: false }),
      "/api/insights/ask": () =>
        journals({
          answer: "Amounts are not shown to a head of department, so this cannot be answered here.",
          query: "payouts_by", refused: true, counted: true, chart: "", series: [], rows: [], total_rows: 0,
          counted_how: "", notices: ["AI is off right now, so your question was matched by its words."],
        }),
    })
    await user.type(await screen.findByRole("textbox", { name: "Your question" }), "How much did we pay?{Enter}")
    expect(await screen.findByText(/Amounts are not shown to a head of department/)).toBeInTheDocument()
    expect(screen.getByText(/AI is off right now/)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Download CSV/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("shows a limit inline and keeps the page usable", async () => {
    const user = mount(PRINCIPAL, {
      "/api/insights/suggestions": () => suggestions(),
      "/api/insights/ask": failing(429, "You have asked 120 questions this hour. Try again later."),
      "/api/insights/run": () => journals(),
    })
    await user.type(await screen.findByRole("textbox", { name: "Your question" }), "Anything?{Enter}")
    expect(await screen.findByRole("alert")).toHaveTextContent("You have asked 120 questions this hour.")
    await user.click(screen.getByRole("button", { name: "Which journals did we publish in most in 2025?" }))
    expect(await screen.findByText("ECE published most in IEEE Access in 2025: 12 papers.")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
