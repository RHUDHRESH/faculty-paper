import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api, ApiError } from "@/lib/api"
import type { Me } from "@/app/auth"
import { Leaderboard, type HonoursBoard } from "@/pages/leaderboard"
import { FACULTY, HOD, renderWithProviders } from "@/test/harness"

const COORDINATOR: Me = { id: "u-coord", email: "coord@example.edu", name: "Dr Uma Rao", role: "RESEARCH_COORDINATOR", department: null }
const ADMIN: Me = { id: "u-admin", email: "admin@example.edu", name: "Site Admin", role: "SUPER_ADMIN", department: null }

const CATALOGUE = [
  { key: "snip", name: "Cumulative SNIP", meaning: "The SNIP of each paper's journal, added up.", default: 25 },
  { key: "papers", name: "Papers", meaning: "How many Scopus-linked papers you have in the period.", default: 15 },
  { key: "q1q2", name: "Q1 and Q2 papers", meaning: "How many of your papers are in a Q1 or Q2 journal.", default: 20 },
  { key: "citations", name: "Citations", meaning: "Scopus citations of your papers, added up.", default: 40 },
]
const DEFAULTS = { snip: 25, papers: 15, q1q2: 20, citations: 40 }

const entry = (over = {}) => ({
  version: 0, weights: { ...DEFAULTS }, reason: "The college's starting weights.",
  saved_by: null, saved_at: null, applies_from: null, ...over,
})

function state(over = {}) {
  return {
    current: entry(), catalogue: CATALOGUE, defaults: DEFAULTS, history: [],
    normalisation: "Each factor is turned into a percentile among the people on the board.",
    source: "Counted from Scopus-linked papers only", can_edit: true, ...over,
  }
}

function person(id: string, name: string) {
  return { id, name, initials: name.slice(0, 2).toUpperCase(), photo_url: null, department: "ECE", designation: null }
}

function row(id: string, name: string, rank: number | null, value: number, over = {}) {
  return {
    rank, joint: false, person: person(id, name), value, papers: 3, score: 5, q1: 1, first: 1, cited: 3, h_index: 1,
    breakdown: { q1: 1 }, spark: [0, 1, 2, 1, 3], move: null, new: false, ...over,
  }
}

const SPAN = { key: "last12", label: "Last 12 months", from: "2025-11-17", to: "2026-11-17" }

function board(over: Partial<HonoursBoard> = {}): HonoursBoard {
  const rows = [
    row("u-ravi", "Dr Ravi Kumar", 1, 88.5, { contributions: [{ factor: "snip", points: 25 }, { factor: "papers", points: 15 }, { factor: "q1q2", points: 20 }, { factor: "citations", points: 28.5 }] }),
    row(FACULTY.id, FACULTY.name, 2, 61.2, { contributions: [{ factor: "snip", points: 20.2 }, { factor: "papers", points: 7.5 }, { factor: "q1q2", points: 13.5 }, { factor: "citations", points: 20 }] }),
  ]
  return {
    measure: "score", label: "Overall score", unit: "points", period: { ...SPAN, compared_with: null }, periods: [SPAN],
    scope: null, departments_list: ["ECE"], filters: { topic: null, journal: null }, podium: rows, rows, ranked: 2, population: 2,
    distribution: [{ bucket: "0", lo: null, hi: 0, count: 0 }, { bucket: "61–89", lo: 61, hi: 89, count: 2 }],
    departments: [], college_trend: [], top_topics: [], top_journals: [], topic_options: [], journal_options: [],
    totals: { papers: 6, people: 2, people_with_papers: 2 }, spark_years: [2022, 2023, 2024, 2025, 2026],
    method: {
      weights: { Q1: 4, Q2: 3, Q3: 2, Q4: 1, other: 1 }, source: "Counted from Scopus-linked papers only",
      scopus_synced_at: "2026-11-12T08:30:00+05:30",
      scoring: {
        weights: CATALOGUE.map((f) => ({ key: f.key, name: f.name, meaning: f.meaning, weight: DEFAULTS[f.key as keyof typeof DEFAULTS] })),
        normalisation: "Each factor is turned into a percentile among the people on the board.",
      },
      papers_in_record: 6, newcomer_months: 24, updated: "",
    },
    me: { id: FACULTY.id, rank: 2, joint: false, of: 2, population: 2, dept_rank: 2, dept_of: 2, department: "ECE", percentile: 100, move: null, value: 61.2, alltime_rank: null },
    ...over,
  }
}

const PREVIEW = {
  saved: false, scope: null,
  current: [
    { rank: 1, joint: false, person: person("u-ravi", "Dr Ravi Kumar"), score: 88.5, becomes: 2, change: -1 },
    { rank: 2, joint: false, person: person("u-asha", "Dr Asha Menon"), score: 61.2, becomes: 1, change: 1 },
  ],
  proposed: [
    { rank: 1, joint: false, person: person("u-asha", "Dr Asha Menon"), score: 70.4, was: 2, change: 1 },
    { rank: 2, joint: false, person: person("u-ravi", "Dr Ravi Kumar"), score: 66.0, was: 1, change: -1 },
  ],
}

type Call = { path: string; method: string; json?: any }
const calls: Call[] = []
let weightsState = state()

function mount(me: Me, route = "/leaderboard") {
  calls.length = 0
  weightsState = state()
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string, options: { method?: string; json?: any } = {}) => {
    const method = (options.method ?? "GET").toUpperCase()
    calls.push({ path, method, json: options.json })
    if (path === "/api/auth/me") return me
    if (path === "/api/leaderboard/weights/preview") return PREVIEW
    if (path === "/api/leaderboard/weights/reset") {
      weightsState = state({ current: entry({ version: 3, reason: "Reset to the college's starting weights." }) })
      return weightsState
    }
    if (path === "/api/leaderboard/weights") {
      if (method === "PUT") {
        if (options.json.reason === "bad") throw new ApiError(400, "Weights must add up to 100")
        const saved = entry({ version: 1, weights: options.json.weights, reason: options.json.reason, saved_by: { id: me.id, name: me.name }, saved_at: "2026-11-17T10:00:00+05:30" })
        weightsState = state({ current: saved, history: [saved] })
      }
      return weightsState
    }
    if (path.startsWith("/api/leaderboard")) return board()
    throw new ApiError(404, `No handler in this test for ${path}`)
  }) as never)
  renderWithProviders(<Leaderboard />, { route })
}

const weightsButton = () => screen.queryByRole("button", { name: "Weights" })
const openPanel = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Weights" }))
  return await screen.findByRole("heading", { name: "Leaderboard weights" })
}
const numberOf = (name: string) => screen.getByLabelText(name, { selector: "input[type=number]" }) as HTMLInputElement

afterEach(() => cleanup())

describe("Who sees the Weights button", () => {
  it("shows it to the research coordinator and the super admin only", async () => {
    for (const me of [COORDINATOR, ADMIN]) {
      cleanup()
      mount(me)
      expect(await screen.findByRole("button", { name: "Weights" })).toBeInTheDocument()
    }
    for (const me of [FACULTY, HOD]) {
      cleanup()
      mount(me)
      await screen.findByText(/Counted from Scopus-linked papers only/)
      expect(weightsButton()).toBeNull()
    }
  })
})

describe("The weights panel", () => {
  it("has one row per factor, with its meaning, a number and a labelled slider, and a total of 100", async () => {
    mount(COORDINATOR)
    await openPanel()
    for (const f of CATALOGUE) {
      expect(await screen.findByText(f.meaning)).toBeInTheDocument()
      expect(numberOf(f.name).value).toBe(String(f.default))
      const slider = screen.getByRole("slider", { name: new RegExp(`^${f.name}`) })
      expect(slider).toHaveAttribute("min", "0")
      expect(slider).toHaveAttribute("max", "100")
    }
    expect(screen.getByText(/Total/).textContent).toMatch(/100 of 100/)
    expect(screen.queryByText("Weights must add up to 100")).toBeNull()
  })

  it("will not save or preview unless the total is 100, and says why", async () => {
    mount(COORDINATOR)
    await openPanel()
    fireEvent.change(await screen.findByRole("textbox", { name: /Why are you changing the weights/ }), { target: { value: "More weight on SNIP" } })
    fireEvent.change(numberOf("Cumulative SNIP"), { target: { value: "35" } })
    expect(screen.getByText("Weights must add up to 100")).toBeInTheDocument()
    expect(screen.getByText(/Total/).textContent).toMatch(/110 of 100/)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled()
    // The slider moves the same number.
    fireEvent.change(screen.getByRole("slider", { name: /^Citations/ }), { target: { value: "30" } })
    expect(numberOf("Citations").value).toBe("30")
    expect(screen.queryByText("Weights must add up to 100")).toBeNull()
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled()
  })

  it("needs a note before it saves", async () => {
    mount(COORDINATOR)
    await openPanel()
    fireEvent.change(await screen.findByLabelText("Cumulative SNIP", { selector: "input[type=number]" }), { target: { value: "35" } })
    fireEvent.change(numberOf("Citations"), { target: { value: "30" } })
    expect(screen.getByText(/Total/).textContent).toMatch(/100 of 100/)
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    const note = screen.getByRole("textbox", { name: /Why are you changing the weights/ })
    expect(note).toBeRequired()
    fireEvent.change(note, { target: { value: "   " } })
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.change(note, { target: { value: "SNIP matters more this year" } })
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
  })

  it("saves the weights and the note, then shows them in the history", async () => {
    mount(COORDINATOR)
    await openPanel()
    fireEvent.change(await screen.findByRole("textbox", { name: /Why are you changing the weights/ }), { target: { value: "SNIP matters more this year" } })
    fireEvent.change(numberOf("Cumulative SNIP"), { target: { value: "35" } })
    fireEvent.change(numberOf("Citations"), { target: { value: "30" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true))
    const put = calls.find((c) => c.method === "PUT")!
    expect(put.path).toBe("/api/leaderboard/weights")
    expect(put.json).toEqual({ weights: { snip: 35, papers: 15, q1q2: 20, citations: 30 }, reason: "SNIP matters more this year" })
    const history = await screen.findByRole("region", { name: "History" })
    expect(await within(history).findByText("SNIP matters more this year")).toBeInTheDocument()
    expect(within(history).getByText("Dr Uma Rao")).toBeInTheDocument()
    expect(within(history).getByText(/Cumulative SNIP 35, Papers 15, Q1 and Q2 papers 20, Citations 30/)).toBeInTheDocument()
    // The note box is empty again for the next change.
    expect(screen.getByRole("textbox", { name: /Why are you changing the weights/ })).toHaveValue("")
  })

  it("shows what the server refuses in words", async () => {
    mount(COORDINATOR)
    await openPanel()
    fireEvent.change(await screen.findByRole("textbox", { name: /Why are you changing the weights/ }), { target: { value: "bad" } })
    fireEvent.change(numberOf("Cumulative SNIP"), { target: { value: "35" } })
    fireEvent.change(numberOf("Citations"), { target: { value: "30" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Weights must add up to 100")
  })

  it("previews the top 20 before and after with arrows, and saves nothing", async () => {
    mount(COORDINATOR)
    await openPanel()
    fireEvent.change(await screen.findByLabelText("Cumulative SNIP", { selector: "input[type=number]" }), { target: { value: "35" } })
    fireEvent.change(numberOf("Citations"), { target: { value: "30" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    const preview = await screen.findByRole("region", { name: "Preview" })
    const before = within(preview).getByRole("list", { name: "With the saved weights" })
    const after = within(preview).getByRole("list", { name: "With these weights" })
    expect(within(before).getAllByRole("listitem")).toHaveLength(2)
    expect(within(after).getAllByRole("listitem")[0]).toHaveTextContent("Dr Asha Menon")
    expect(within(after).getAllByRole("listitem")[0]).toHaveTextContent("places up")
    expect(within(after).getAllByRole("listitem")[1]).toHaveTextContent("places down")
    const post = calls.find((c) => c.path.endsWith("/preview"))!
    expect(post.method).toBe("POST")
    expect(post.json.weights).toEqual({ snip: 35, papers: 15, q1q2: 20, citations: 30 })
    expect(calls.some((c) => c.method === "PUT")).toBe(false)
  })

  it("lists the history: who, when, why and the weights", async () => {
    mount(COORDINATOR)
    weightsState = state({
      current: entry({ version: 2 }),
      history: [
        entry({ version: 2, reason: "Back to papers", saved_by: { id: "u-admin", name: "Site Admin" }, saved_at: "2026-11-10T09:00:00+05:30", weights: { snip: 0, papers: 100, q1q2: 0, citations: 0 } }),
        entry({ version: 1, reason: "First try", saved_by: { id: "u-coord", name: "Dr Uma Rao" }, saved_at: "2026-10-01T09:00:00+05:30" }),
      ],
    })
    await openPanel()
    const history = await screen.findByRole("region", { name: "History" })
    const items = within(history).getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("Site Admin")
    expect(items[0]).toHaveTextContent("Back to papers")
    expect(items[0]).toHaveTextContent("Papers 100")
    expect(items[1]).toHaveTextContent("Dr Uma Rao")
    expect(items[1]).toHaveTextContent("First try")
  })

  it("resets to the default after asking", async () => {
    mount(COORDINATOR)
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true)
    await openPanel()
    fireEvent.click(await screen.findByRole("button", { name: "Reset to default" }))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/reset") && c.method === "POST")).toBe(true))
    expect(confirm).toHaveBeenCalled()
    confirm.mockRestore()
  })

  it("does not reset when the coordinator says no", async () => {
    mount(COORDINATOR)
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false)
    await openPanel()
    fireEvent.click(await screen.findByRole("button", { name: "Reset to default" }))
    expect(calls.some((c) => c.path.endsWith("/reset"))).toBe(false)
    confirm.mockRestore()
  })
})

describe("How the leaderboard is scored (read only)", () => {
  it("shows everyone the weights in force and, for their own row, the points from each factor", async () => {
    mount(FACULTY)
    fireEvent.click(await screen.findByRole("button", { name: "How the leaderboard is scored" }))
    const list = await screen.findByRole("list", { name: "Weights in force" })
    const items = within(list).getAllByRole("listitem")
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent("Cumulative SNIP")
    expect(items[0]).toHaveTextContent("25%")
    expect(items[0]).toHaveTextContent("Your points: 20.2 of 25")
    expect(items[3]).toHaveTextContent("Your points: 20.0 of 40")
    expect(screen.getByText(/Your score:/)).toHaveTextContent("61.2")
    // Read only: nothing to type into and no way to change a weight.
    expect(screen.queryByRole("slider")).toBeNull()
    expect(weightsButton()).toBeNull()
    expect(calls.some((c) => c.path === "/api/leaderboard/weights")).toBe(false)
  })

  it("is read-only for a head of department too", async () => {
    mount(HOD)
    fireEvent.click(await screen.findByRole("button", { name: "How the leaderboard is scored" }))
    expect(await screen.findByRole("list", { name: "Weights in force" })).toBeInTheDocument()
    expect(weightsButton()).toBeNull()
  })

  it("points to the Overall board when another board is open", async () => {
    mount(FACULTY, "/leaderboard?category=papers")
    vi.mocked(api).mockImplementation((async (path: string) =>
      path === "/api/auth/me" ? FACULTY : path.startsWith("/api/leaderboard") ? board({ measure: "papers", rows: board().rows.map((r) => ({ ...r, contributions: undefined })) }) : {}) as never)
    cleanup()
    renderWithProviders(<Leaderboard />, { route: "/leaderboard?category=papers" })
    fireEvent.click(await screen.findByRole("button", { name: "How the leaderboard is scored" }))
    expect(await screen.findByText("Open the Overall board to see your points from each factor.")).toBeInTheDocument()
  })
})
