import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { navFor } from "@/app/nav"
import { Leaderboard, rankText, standing, toCsv, type HonoursBoard } from "@/pages/leaderboard"
import { FACULTY, HOD, failing, fakeApi, renderWithProviders } from "@/test/harness"

function row(id: string, name: string, rank: number | null, value: number, over: Record<string, unknown> = {}) {
  return {
    rank, joint: false,
    person: { id, name, initials: "XX", photo_url: null, department: "ECE", designation: null },
    value, papers: value, score: value * 2, q1: 1, first: 1, cited: 3, h_index: 1,
    breakdown: { Q1: 1 }, spark: [0, 1, 2, 1, value], move: null, new: false,
    ...over,
  }
}

const SPAN = { key: "academic", label: "This academic year (2026–27)", from: "2026-06-01", to: "2027-05-31" }

function board(over: Partial<HonoursBoard> = {}): HonoursBoard {
  const rows = [
    row("u-ravi", "Dr Ravi Kumar", 1, 9, { move: 2 }),
    row("u-lila", "Dr Lila Rao", 2, 7),
    row("u-joe", "Dr Joe Paul", 3, 4),
    row(FACULTY.id, FACULTY.name, 4, 3, { move: -1 }),
    row("u-mina", "Dr Mina Das", null, 0),
  ]
  return {
    measure: "papers", label: "Most papers", unit: "papers",
    period: { ...SPAN, compared_with: null }, periods: [SPAN], scope: null,
    departments_list: ["CSE", "ECE"], filters: { topic: null, journal: null },
    podium: rows.slice(0, 3), rows, ranked: 4, population: 5,
    distribution: [{ bucket: "0", lo: null, hi: 0, count: 1 }, { bucket: "1–9", lo: 1, hi: 9, count: 4 }],
    departments: [{
      department: "ECE", faculty: 5, value: 23, per_faculty: 4.6, papers: 23, papers_per_faculty: 4.6,
      score_per_faculty: 9.2, rank: 1, rank_per_faculty: 1, trend: [{ year: 2026, papers: 23 }],
    }],
    college_trend: [{ year: 2025, papers: 10 }, { year: 2026, papers: 23 }],
    top_topics: [], top_journals: [], topic_options: ["AI"], journal_options: ["IEEE Access"],
    totals: { papers: 23, people: 5, people_with_papers: 4 }, spark_years: [2022, 2023, 2024, 2025, 2026],
    method: { weights: { Q1: 4, Q2: 3, Q3: 2, Q4: 1, other: 1 }, source: "publication record", papers_in_record: 40, newcomer_months: 24, updated: "" },
    me: { id: FACULTY.id, rank: 4, joint: false, of: 4, population: 5, dept_rank: 4, dept_of: 4, department: "ECE", percentile: 100, move: -1, value: 3, alltime_rank: null },
    ...over,
  }
}

function mount(data: HonoursBoard | ReturnType<typeof failing> = board(), route = "/leaderboard") {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/leaderboard": typeof data === "function" ? data : () => data,
      "/api/wall": () => ({ month: "2026-09", months: [], cards: [], departments: [] }),
    })
  )
  renderWithProviders(<Leaderboard />, { route })
}

const asked = () => vi.mocked(api).mock.calls.map((c) => String(c[0])).filter((p) => p.includes("/leaderboard"))

describe("Leaderboard", () => {
  it("is in the sidebar for every role", () => {
    for (const role of ["FACULTY", "HOD", "PRINCIPAL", "DIRECTOR", "FINANCE", "SUPER_ADMIN", "RESEARCH_CELL"] as const) {
      expect(navFor(role).map((i) => i.to)).toContain("/leaderboard")
    }
  })

  it("opens on the last 12 months", async () => {
    mount()
    await screen.findByRole("list", { name: "Top 10" })
    expect(asked()[0]).toContain("period=last12")
    expect(screen.getByLabelText("Period")).toHaveValue("last12")
  })

  it("leads with the reader: place, department place, neighbours and the next step", async () => {
    mount()
    const card = await screen.findByRole("complementary", { name: "Your place" })
    await waitFor(() => expect(card).toHaveTextContent("#4of 4 in the college"))
    expect(card).toHaveTextContent("Top 100% · #4 in ECE")
    expect(within(card).getByText("Dr Joe Paul")).toBeInTheDocument()
    expect(within(card).getByText("Dr Lila Rao")).toBeInTheDocument()
    expect(within(card).queryByText("Dr Ravi Kumar")).toBeNull()
    expect(card).toHaveTextContent("Dr Joe Paul is next, 4 papers to your 3. Two more papers would put you past them.")
    expect(within(card).getByRole("link", { name: "Check a journal first" })).toHaveAttribute("href", "/journal-check")
  })

  it("says plainly when the reader leads their department", async () => {
    mount(board({ me: { ...board().me!, dept_rank: 1 } }))
    const card = await screen.findByRole("complementary", { name: "Your place" })
    await waitFor(() => expect(card).toHaveTextContent("You lead ECE."))
  })

  it("never shows a bare zero to someone with nothing counted", async () => {
    mount(board({ me: { ...board().me!, rank: null, value: 0, percentile: null, alltime_rank: 12 } }))
    const card = await screen.findByRole("complementary", { name: "Your place" })
    await waitFor(() => expect(card).toHaveTextContent("No papers counted for you in this academic year (2026–27) yet."))
    expect(card).toHaveTextContent("Your all-time place is #12.")
    expect(within(card).getByRole("link", { name: "All time" })).toHaveAttribute("href", "/leaderboard?period=all")
    expect(within(card).queryByText("0")).toBeNull()
    expect(within(card).queryByRole("link", { name: "File a paper" })).toBeNull()
  })

  it("offers to file a paper when the reader has never been ranked", async () => {
    mount(board({ me: { ...board().me!, rank: null, value: 0, percentile: null, alltime_rank: null } }))
    expect(await screen.findByRole("link", { name: "File a paper" })).toHaveAttribute("href", "/papers/new")
  })

  it("lists the top 10 with a paper mix bar, hides the unranked and keeps them a click away", async () => {
    mount()
    const list = await screen.findByRole("list", { name: "Top 10" })
    expect(within(list).getAllByRole("img", { name: /Paper mix: 1 Q1/ })).toHaveLength(4)
    expect(within(list).queryByText("Dr Mina Das")).toBeNull()
    expect(screen.getByText("1 person has nothing counted in this period.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: /Show everyone/ }))
    fireEvent.click(screen.getByLabelText("Include people with nothing counted"))
    const row = screen.getAllByText("Dr Mina Das")[0].closest("tr")!
    expect(within(row).getByTitle("Nothing counted for them in this period yet.")).toBeInTheDocument()
  })

  it("describes the chosen board in one sentence", async () => {
    mount(board({ measure: "score" }), "/leaderboard?category=score")
    expect(await screen.findByText("Points for each paper: Q1 4, Q2 3, Q3 2, Q4 and others 1.")).toBeInTheDocument()
  })

  it("keeps old links to the trend and spread views working, as Departments", async () => {
    for (const v of ["trend", "chart"]) {
      cleanup()
      mount(board(), `/leaderboard?view=${v}`)
      expect(await screen.findByRole("button", { name: "Departments", current: "page" })).toBeInTheDocument()
      expect(await screen.findByText("Over the years")).toBeInTheDocument()
      expect(screen.getByText("How it is spread")).toBeInTheDocument()
    }
  })

  it("shows the rising people, and hides the strip when nobody is rising", async () => {
    mount()
    expect(await screen.findByRole("region", { name: "Rising" })).toHaveTextContent("Most improved")
    cleanup()
    mount((path: string) => (/category=(rising|newcomer)/.test(path) ? board({ rows: [] }) : board()))
    await screen.findByRole("list", { name: "Top 10" })
    await waitFor(() => expect(asked().filter((p) => p.includes("category=newcomer")).length).toBeGreaterThan(0))
    expect(screen.queryByRole("region", { name: "Rising" })).toBeNull()
  })

  it("never calls a running year a fall in the plain-text standing", () => {
    const then = { key: "last_academic", label: "2025–26", from: "2025-06-01", to: "2026-05-31" }
    const running = board({ period: { ...SPAN, to: "2999-05-31", compared_with: then }, me: { ...board().me!, rank: 4, move: -21 } })
    expect(standing(running)).not.toMatch(/down|up \d/)
    expect(rankText(null, true)).toBe("Not ranked yet")
    expect(rankText(4, true)).toBe("=4")
  })

  it("says the list is filtered, not that the reader is uncounted, outside their department", () => {
    expect(standing(board({ me: null, scope: "AIDS" }))).toBe("Showing AIDS. You are not in this list.")
  })

  it("asks for the chosen category and period", async () => {
    mount()
    await screen.findByRole("list", { name: "Top 10" })
    fireEvent.click(screen.getByRole("button", { name: "Q1 papers" }))
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "academic" } })
    await waitFor(() => expect(asked().some((p) => p.includes("category=q1") && p.includes("period=academic"))).toBe(true))
  })

  it("shows departments per faculty member", async () => {
    mount(board(), "/leaderboard?view=departments")
    expect(await screen.findByText(/per faculty member/i, { selector: "h2,h3,figcaption,p,span,div" })).toBeInTheDocument()
  })

  it("exports CSV without money", () => {
    const csv = toCsv(board())
    expect(csv.split("\n")[0]).toContain("Rank,Name,Department")
    expect(csv).not.toMatch(/₹|amount/i)
  })

  it("links Download CSV to the server export with the current filters", async () => {
    mount(board(), "/leaderboard?category=q1&department=ECE")
    const href = (await screen.findByRole("link", { name: /Download CSV/ })).getAttribute("href") ?? ""
    expect(href).toContain("fmt=csv")
    expect(href).toContain("category=q1")
    expect(href).toContain("department=ECE")
  })

  it("never prints a rupee figure", async () => {
    mount()
    await screen.findByRole("list", { name: "Top 10" })
    expect(document.body.textContent).not.toMatch(/₹/)
  })

  it("shows a failure as a failure", async () => {
    mount(failing())
    expect(await screen.findByText("Could not load the leaderboard.")).toBeInTheDocument()
  })
})

describe("Leaderboard for a head of department", () => {
  it("opens on their own department, and the whole college is a choice", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => HOD, "/api/leaderboard": () => board() }))
    renderWithProviders(<Leaderboard />)
    await screen.findByRole("list", { name: "Top 10" })
    expect(asked().some((p) => p.includes("department=Physics") && p.includes("period=last12"))).toBe(true)
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "" } })
    await waitFor(() => expect(asked().at(-1)).not.toContain("department="))
  })
})
